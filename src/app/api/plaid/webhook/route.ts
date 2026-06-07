import { db } from "@/db/client.ts";
import { plaidItems, webhookLog } from "@/db/schema/index.ts";
import { bucketKeyFromHeaders, plaidWebhookLimiter } from "@/lib/plaid/rate-limit.ts";
import { sha256Hex, verifyWebhook } from "@/lib/plaid/webhook-verify.ts";
import { syncInvestmentsItemQueue, syncPlaidItemQueue } from "@/lib/queue/queues.ts";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

/**
 * P4-15 / P4-16 — Plaid webhook receiver.
 *
 * Pipeline (in order):
 *   1. Rate-limit (in-memory token bucket per source IP, capacity 100/min).
 *   2. Read the RAW body — the signature is over the bytes.
 *   3. Verify the JWT signature + body hash + freshness (verifyWebhook).
 *   4. Compute an idempotency hash; INSERT ON CONFLICT DO NOTHING.
 *   5. Look up plaid_items by Plaid's text item_id. Missing → 200 + log.
 *   6. Enqueue a sync-plaid-item job; stamp last_webhook_at.
 *   7. Return 200 quickly (target < 5s; hard timeout 8s).
 *
 * Per CLAUDE.md §Plaid Safety Rules: this handler MUST NOT log the
 * Plaid-Verification header or any access_token, and MUST verify signatures
 * before any DB write. Validation failures return 401 with an empty body —
 * we don't echo which check failed.
 */

/** Hard timeout per P4-16. Returns 503 if the pipeline exceeds it. */
const HANDLER_TIMEOUT_MS = 8_000;

/** Plaid bodies are tiny; cap at 1 MB to defend against body-bomb (P4-36). */
const MAX_BODY_BYTES = 1_000_000;

/* Tell Next.js this route runs on Node, not Edge. The db/queue/jose path
 * needs the Node runtime. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  return withTimeout(handle(req), HANDLER_TIMEOUT_MS);
}

async function handle(req: NextRequest): Promise<Response> {
  // 1. Rate-limit before any allocation. Cheap and self-defending.
  const bucketKey = bucketKeyFromHeaders(req.headers);
  if (!plaidWebhookLimiter.consume(bucketKey)) {
    return new Response(null, { status: 429 });
  }

  // 2. Read raw body for signature verification. The signature is computed
  //    over the bytes Plaid sent; if we JSON.parse first, the round-trip
  //    canonicalization could change byte ordering and the hash would diverge.
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const n = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(n) || n > MAX_BODY_BYTES) {
      return new Response(null, { status: 413 });
    }
  }
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return new Response(null, { status: 400 });
  }
  if (rawBody.length === 0 || rawBody.length > MAX_BODY_BYTES) {
    return new Response(null, { status: 400 });
  }

  // 3. Signature + freshness + body hash. Returns null on any failure;
  //    we respond 401 with no body detail (no oracle for attackers).
  const verified = await verifyWebhook(req.headers, rawBody);
  if (!verified) {
    return new Response(null, { status: 401 });
  }

  // 4. Pull dispatch fields out of the verified body.
  const webhookType = stringField(verified.body, "webhook_type");
  const webhookCode = stringField(verified.body, "webhook_code");
  const plaidTextItemId = stringField(verified.body, "item_id");
  if (!webhookType || !webhookCode) {
    return new Response(null, { status: 400 });
  }

  // 5. Idempotency: hash (type | code | item_id | rawBody). The unique
  //    constraint on webhook_log.idempotency_hash is the source of truth;
  //    on conflict we silently treat it as a dupe and return 200.
  const idempotencyHash = sha256Hex(
    `${webhookType}|${webhookCode}|${plaidTextItemId ?? ""}|${rawBody}`,
  );

  let webhookLogId: string | undefined;
  try {
    const inserted = await db
      .insert(webhookLog)
      .values({
        idempotencyHash,
        webhookType,
        webhookCode,
        plaidItemId: plaidTextItemId,
        body: verified.body,
        status: "queued",
      })
      .onConflictDoNothing({ target: webhookLog.idempotencyHash })
      .returning({ id: webhookLog.id });
    webhookLogId = inserted[0]?.id;
  } catch {
    return new Response(null, { status: 500 });
  }

  if (!webhookLogId) {
    // ON CONFLICT DO NOTHING → row already existed → duplicate delivery.
    return new Response(JSON.stringify({ ok: true, duplicate: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // 6. Look up our internal Item by Plaid's text id. Missing rows are
  //    treated as "Item we no longer track" — we 200 so Plaid stops
  //    retrying, but skip the enqueue + last_webhook_at stamp.
  if (!plaidTextItemId) {
    // ITEM_ERROR webhooks etc. without an item_id — already logged, done.
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const [item] = await db
    .select({
      id: plaidItems.id,
      status: plaidItems.status,
      productsConsented: plaidItems.productsConsented,
    })
    .from(plaidItems)
    .where(eq(plaidItems.plaidItemId, plaidTextItemId))
    .limit(1);

  if (!item) {
    return new Response(JSON.stringify({ ok: true, unknownItem: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // 7a. P4-24 — ITEM webhooks set our local status synchronously. We don't
  //     need to wait for the next /transactions/sync attempt to learn the
  //     Item is broken; classify and persist here.
  let didItemStatusUpdate = false;
  if (webhookType === "ITEM") {
    const errCode = nestedString(verified.body, ["error", "error_code"]);
    const newStatus = mapItemWebhookToStatus(webhookCode, errCode);
    if (newStatus) {
      await db
        .update(plaidItems)
        .set({
          status: newStatus,
          errorCode: errCode ?? webhookCode,
          errorMessage:
            nestedString(verified.body, ["error", "error_message"]) ??
            `Plaid ITEM webhook: ${webhookCode}`,
          updatedAt: new Date(),
        })
        .where(eq(plaidItems.id, item.id));
      didItemStatusUpdate = true;
    }
  }

  // 7b. Enqueue heavy work + stamp last_webhook_at.
  //     P5-15 — route to the right sync worker by webhook type + the Item's
  //     consented products: TRANSACTIONS → transactions sync; HOLDINGS /
  //     INVESTMENTS_TRANSACTIONS → investments sync; ITEM → the sync matching
  //     the Item's product (so an investments-only Item never hits
  //     /transactions/sync, which would error without the product).
  //     Skip entirely when the Item is login_required/revoked (the worker would
  //     only re-fail; reauth re-enqueues on success) or the type is unroutable.
  const target = syncTargetFor(webhookType, item.productsConsented);
  const statusOk = !["login_required", "revoked"].includes(
    didItemStatusUpdate ? await currentItemStatus(item.id) : item.status,
  );
  const shouldEnqueueSync = target !== null && statusOk;

  const stampPromise = db
    .update(plaidItems)
    .set({ lastWebhookAt: new Date() })
    .where(eq(plaidItems.id, item.id));

  if (shouldEnqueueSync && target) {
    const queue = target === "investments" ? syncInvestmentsItemQueue : syncPlaidItemQueue;
    const jobName = target === "investments" ? "sync-investments-item" : "sync-plaid-item";
    await Promise.all([
      queue.add(
        jobName,
        { plaidItemPk: item.id, trigger: "webhook", webhookLogId, webhookCode },
        { jobId: `${jobName}-webhook-${webhookLogId}` },
      ),
      stampPromise,
    ]);
  } else {
    await stampPromise;
    // Mark the webhook_log as processed since we won't run a worker job for it.
    await db
      .update(webhookLog)
      .set({ status: "processed", processedAt: new Date() })
      .where(eq(webhookLog.id, webhookLogId));
  }

  return new Response(
    JSON.stringify({ ok: true, statusUpdated: didItemStatusUpdate || undefined }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

/**
 * P5-15 — route a webhook to the sync worker that matches its type + the Item's
 * consented products. Returns null for webhook types we don't drive a sync from.
 */
function syncTargetFor(
  webhookType: string,
  productsConsented: readonly string[],
): "transactions" | "investments" | null {
  if (webhookType === "TRANSACTIONS") return "transactions";
  if (webhookType === "HOLDINGS" || webhookType === "INVESTMENTS_TRANSACTIONS") {
    return "investments";
  }
  if (webhookType === "ITEM") {
    return productsConsented.includes("investments") ? "investments" : "transactions";
  }
  return null;
}

function nestedString(body: Record<string, unknown>, path: readonly string[]): string | null {
  let cur: unknown = body;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" && cur.length > 0 ? cur : null;
}

/**
 * Map an ITEM-typed webhook to a `plaid_items.status` value.
 *
 * The matrix per Plaid docs + CLAUDE.md §Plaid Safety Rules:
 *   - ITEM / ERROR with error_code ITEM_LOGIN_REQUIRED → login_required
 *   - ITEM / ERROR with PENDING_EXPIRATION/PENDING_DISCONNECT → pending_disconnect
 *   - ITEM / ERROR with USER_PERMISSION_REVOKED/USER_ACCOUNT_REVOKED → revoked
 *   - ITEM / PENDING_DISCONNECT or ITEM / PENDING_EXPIRATION (Plaid sometimes
 *     emits these as their own webhook_code) → pending_disconnect
 *   - ITEM / USER_PERMISSION_REVOKED → revoked
 *   - ITEM / LOGIN_REPAIRED (Plaid's "you reconnected, we're good") → active
 *   - anything else → null (no status change; let the next sync decide)
 */
function mapItemWebhookToStatus(
  webhookCode: string,
  errorCode: string | null,
): "active" | "login_required" | "pending_disconnect" | "revoked" | null {
  if (webhookCode === "LOGIN_REPAIRED") return "active";
  if (webhookCode === "PENDING_DISCONNECT" || webhookCode === "PENDING_EXPIRATION") {
    return "pending_disconnect";
  }
  if (webhookCode === "USER_PERMISSION_REVOKED" || webhookCode === "USER_ACCOUNT_REVOKED") {
    return "revoked";
  }
  if (webhookCode === "ERROR") {
    switch (errorCode) {
      case "ITEM_LOGIN_REQUIRED":
      case "INVALID_CREDENTIALS":
        return "login_required";
      case "PENDING_DISCONNECT":
      case "PENDING_EXPIRATION":
        return "pending_disconnect";
      case "USER_PERMISSION_REVOKED":
      case "USER_ACCOUNT_REVOKED":
        return "revoked";
      default:
        return null;
    }
  }
  return null;
}

async function currentItemStatus(id: string): Promise<string> {
  const [row] = await db
    .select({ status: plaidItems.status })
    .from(plaidItems)
    .where(eq(plaidItems.id, id))
    .limit(1);
  return row?.status ?? "active";
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function withTimeout<T extends Response>(p: Promise<T>, ms: number): Promise<Response> {
  return new Promise<Response>((resolve) => {
    const timer = setTimeout(() => {
      // Don't reject — Plaid would retry. Return 503 so the WAF treats it as transient.
      resolve(new Response(null, { status: 503 }));
    }, ms);
    p.then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      () => {
        clearTimeout(timer);
        resolve(new Response(null, { status: 500 }));
      },
    );
  });
}
