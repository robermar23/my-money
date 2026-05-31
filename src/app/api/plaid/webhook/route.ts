import { db } from "@/db/client.ts";
import { plaidItems, webhookLog } from "@/db/schema/index.ts";
import { bucketKeyFromHeaders, plaidWebhookLimiter } from "@/lib/plaid/rate-limit.ts";
import { sha256Hex, verifyWebhook } from "@/lib/plaid/webhook-verify.ts";
import { syncPlaidItemQueue } from "@/lib/queue/queues.ts";
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
    .select({ id: plaidItems.id })
    .from(plaidItems)
    .where(eq(plaidItems.plaidItemId, plaidTextItemId))
    .limit(1);

  if (!item) {
    return new Response(JSON.stringify({ ok: true, unknownItem: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // 7. Enqueue heavy work + stamp last_webhook_at.
  await Promise.all([
    syncPlaidItemQueue.add(
      "sync-plaid-item",
      { plaidItemPk: item.id, trigger: "webhook", webhookLogId, webhookCode },
      // jobId pins idempotency at the queue layer (in case the request is
      // somehow retried after the DB INSERT but before the enqueue).
      { jobId: `sync-plaid-item-webhook-${webhookLogId}` },
    ),
    db.update(plaidItems).set({ lastWebhookAt: new Date() }).where(eq(plaidItems.id, item.id)),
  ]);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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
