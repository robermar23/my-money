// @vitest-environment node
import { db } from "@/db/client.ts";
import { plaidItems, webhookLog } from "@/db/schema/index.ts";
import { createPlaidItem } from "@/lib/plaid/tokens.ts";
import { eq, sql } from "drizzle-orm";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * Module mocks
 *
 *   - plaidClient.webhookVerificationKeyGet → returns our test JWK
 *   - syncPlaidItemQueue.add → in-memory spy; we do NOT touch real Redis
 *     here (the queue's BullMQ.add() requires a worker bind; mocking keeps
 *     the test fast and side-effect-free).
 * --------------------------------------------------------------------------- */

const mockKeyGet = vi.fn();
vi.mock("@/lib/plaid/client.ts", () => ({
  plaidClient: { webhookVerificationKeyGet: mockKeyGet },
  plaidEnvironment: () => "sandbox",
}));

interface AddJobArgs {
  name: string;
  data: { plaidItemPk?: string; trigger?: string; webhookLogId?: string; webhookCode?: string };
  opts: { jobId?: string };
}
const mockQueueAdd = vi.fn<
  (name: string, data: AddJobArgs["data"], opts: AddJobArgs["opts"]) => Promise<{ id: string }>
>(async () => ({ id: "test-job-id" }));
vi.mock("@/lib/queue/queues.ts", () => ({
  QUEUE_NAMES: { SYNC_PLAID_ITEM: "sync-plaid-item" },
  syncPlaidItemQueue: { add: mockQueueAdd },
}));

// Import AFTER mocks register.
const { POST } = await import("./route.ts");
const { _resetKeyCacheForTests, sha256Hex } = await import("@/lib/plaid/webhook-verify.ts");
const { plaidWebhookLimiter } = await import("@/lib/plaid/rate-limit.ts");

/* ---------------------------------------------------------------------------
 * Fixtures
 * --------------------------------------------------------------------------- */

interface KeyMaterial {
  kid: string;
  jwk: Record<string, unknown>;
  privateKey: CryptoKey;
}

async function makeKey(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(publicKey);
  return {
    kid,
    jwk: {
      ...publicJwk,
      alg: "ES256",
      kid,
      use: "sig",
      created_at: Math.floor(Date.now() / 1_000),
      expired_at: null,
    },
    privateKey,
  };
}

async function signJWT(opts: {
  km: KeyMaterial;
  rawBody: string;
  iatOverride?: number;
  bodyHashOverride?: string;
}): Promise<string> {
  const iat = opts.iatOverride ?? Math.floor(Date.now() / 1_000);
  const hash = opts.bodyHashOverride ?? sha256Hex(opts.rawBody);
  return new SignJWT({ request_body_sha256: hash, iat })
    .setProtectedHeader({ alg: "ES256", kid: opts.km.kid, typ: "JWT" })
    .sign(opts.km.privateKey);
}

function buildRequest(opts: {
  rawBody: string;
  jwt: string | null;
  forwardedFor?: string;
}): NextRequest {
  const headers = new Headers();
  if (opts.jwt !== null) headers.set("Plaid-Verification", opts.jwt);
  headers.set("content-type", "application/json");
  if (opts.forwardedFor) headers.set("x-forwarded-for", opts.forwardedFor);
  const req = new Request("https://app.example.com/api/plaid/webhook", {
    method: "POST",
    headers,
    body: opts.rawBody,
  });
  return req as NextRequest;
}

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE webhook_log, plaid_sync_runs, plaid_items, accounts, transactions, account_snapshots CASCADE`,
  );
  _resetKeyCacheForTests();
  plaidWebhookLimiter._reset();
  mockKeyGet.mockReset();
  mockQueueAdd.mockClear();
}

beforeEach(reset);

afterEach(() => {
  vi.clearAllMocks();
});

/* ---------------------------------------------------------------------------
 * Tests
 * --------------------------------------------------------------------------- */

describe("POST /api/plaid/webhook — happy path", () => {
  it("verifies, dedupes by INSERT, enqueues, stamps last_webhook_at, returns 200", async () => {
    // Seed a plaid_items row matching the webhook's item_id.
    const plaidItemPk = await createPlaidItem({
      plaidItemId: "item-route-1",
      institutionId: "ins_109508",
      institutionName: "Test Bank",
      accessToken: "access-sandbox-route-1",
      productsConsented: ["transactions"],
    });

    const km = await makeKey("kid-route-1");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "rid" } });

    const rawBody = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-route-1",
      initial_update_complete: true,
    });
    const jwt = await signJWT({ km, rawBody });

    const res = await POST(buildRequest({ rawBody, jwt, forwardedFor: "1.1.1.1" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // webhook_log row landed with status='queued'.
    const logs = await db.select().from(webhookLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.webhookType).toBe("TRANSACTIONS");
    expect(logs[0]?.webhookCode).toBe("SYNC_UPDATES_AVAILABLE");
    expect(logs[0]?.plaidItemId).toBe("item-route-1");
    expect(logs[0]?.status).toBe("queued");

    // Queue received the job, with our internal UUID.
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const call = mockQueueAdd.mock.calls[0];
    expect(call?.[0]).toBe("sync-plaid-item");
    expect(call?.[1]?.plaidItemPk).toBe(plaidItemPk);
    expect(call?.[1]?.trigger).toBe("webhook");
    expect(call?.[1]?.webhookLogId).toBe(logs[0]?.id);
    expect(call?.[2]?.jobId).toContain(logs[0]?.id ?? "");

    // last_webhook_at updated.
    const [item] = await db
      .select({ lastWebhookAt: plaidItems.lastWebhookAt })
      .from(plaidItems)
      .where(eq(plaidItems.id, plaidItemPk));
    expect(item?.lastWebhookAt).toBeInstanceOf(Date);
  });
});

describe("POST /api/plaid/webhook — rejection paths", () => {
  it("returns 401 with no body on tampered signature", async () => {
    const km = await makeKey("kid-tamper");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "rid" } });

    const rawBody = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-tamper",
    });
    const jwt = await signJWT({ km, rawBody });
    const tampered = rawBody.replace("item-tamper", "item-EVIL");

    const res = await POST(buildRequest({ rawBody: tampered, jwt, forwardedFor: "2.2.2.2" }));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toBe("");
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(await db.select().from(webhookLog)).toHaveLength(0);
  });

  it("returns 401 when Plaid-Verification header is missing", async () => {
    const rawBody = JSON.stringify({ webhook_type: "X", webhook_code: "Y", item_id: "z" });
    const res = await POST(buildRequest({ rawBody, jwt: null, forwardedFor: "3.3.3.3" }));
    expect(res.status).toBe(401);
    expect(mockKeyGet).not.toHaveBeenCalled();
  });

  it("returns 200 + duplicate flag on second receipt with same hash", async () => {
    await createPlaidItem({
      plaidItemId: "item-dupe",
      institutionId: "ins_x",
      institutionName: "X",
      accessToken: "tok-dupe",
      productsConsented: ["transactions"],
    });

    const km = await makeKey("kid-dupe");
    // Both calls — same kid, cache hits on the second.
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "rid" } });

    const rawBody = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-dupe",
    });
    const jwt = await signJWT({ km, rawBody });

    const first = await POST(buildRequest({ rawBody, jwt, forwardedFor: "4.4.4.4" }));
    expect(first.status).toBe(200);
    const second = await POST(buildRequest({ rawBody, jwt, forwardedFor: "4.4.4.4" }));
    expect(second.status).toBe(200);
    const body2 = (await second.json()) as { ok: boolean; duplicate?: boolean };
    expect(body2.duplicate).toBe(true);

    // Only one row in webhook_log.
    expect(await db.select().from(webhookLog)).toHaveLength(1);
    // Only one job enqueued.
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it("returns 200 + unknownItem when Plaid item_id is not in our DB (don't NACK)", async () => {
    // No plaid_items row seeded.
    const km = await makeKey("kid-unknown");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "rid" } });
    const rawBody = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-NOT-IN-DB",
    });
    const jwt = await signJWT({ km, rawBody });

    const res = await POST(buildRequest({ rawBody, jwt, forwardedFor: "5.5.5.5" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; unknownItem?: boolean };
    expect(body.unknownItem).toBe(true);
    expect(mockQueueAdd).not.toHaveBeenCalled();

    // Still logged for audit.
    expect(await db.select().from(webhookLog)).toHaveLength(1);
  });
});

describe("POST /api/plaid/webhook — P4-24 ITEM webhook status mapping", () => {
  it("ITEM/ERROR with ITEM_LOGIN_REQUIRED flips status to 'login_required' and SKIPS the sync enqueue", async () => {
    const pk = await createPlaidItem({
      plaidItemId: "item-login-required",
      institutionId: "ins_login",
      institutionName: "Login Bank",
      accessToken: "tok-login",
      productsConsented: ["transactions"],
    });
    const km = await makeKey("kid-item-err");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "rid" } });

    const rawBody = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: "item-login-required",
      error: {
        error_code: "ITEM_LOGIN_REQUIRED",
        error_message: "Please reauthenticate at the bank",
      },
    });
    const jwt = await signJWT({ km, rawBody });

    const res = await POST(buildRequest({ rawBody, jwt, forwardedFor: "30.0.0.1" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; statusUpdated?: boolean };
    expect(body.statusUpdated).toBe(true);

    // Item status reflects the synchronous update.
    const [after] = await db
      .select({ status: plaidItems.status, errorCode: plaidItems.errorCode })
      .from(plaidItems)
      .where(eq(plaidItems.id, pk));
    expect(after?.status).toBe("login_required");
    expect(after?.errorCode).toBe("ITEM_LOGIN_REQUIRED");

    // No sync job enqueued — running it would only re-fail.
    expect(mockQueueAdd).not.toHaveBeenCalled();

    // webhook_log marked processed (audit-clean).
    const [logRow] = await db.select().from(webhookLog);
    expect(logRow?.status).toBe("processed");
  });

  it("ITEM/USER_PERMISSION_REVOKED flips status to 'revoked'", async () => {
    await createPlaidItem({
      plaidItemId: "item-revoked",
      institutionId: "ins_rev",
      institutionName: "Rev Bank",
      accessToken: "tok-rev",
      productsConsented: ["transactions"],
    });
    const km = await makeKey("kid-rev");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "rid" } });

    const rawBody = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "USER_PERMISSION_REVOKED",
      item_id: "item-revoked",
    });
    const jwt = await signJWT({ km, rawBody });

    const res = await POST(buildRequest({ rawBody, jwt, forwardedFor: "31.0.0.1" }));
    expect(res.status).toBe(200);

    const [after] = await db
      .select({ status: plaidItems.status })
      .from(plaidItems)
      .where(eq(plaidItems.plaidItemId, "item-revoked"));
    expect(after?.status).toBe("revoked");
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("ITEM/LOGIN_REPAIRED returns status='active' (reauth confirmed) and DOES enqueue a sync to confirm recovery", async () => {
    // Pre-existing item already in login_required state.
    const pk = await createPlaidItem({
      plaidItemId: "item-repaired",
      institutionId: "ins_rep",
      institutionName: "Rep Bank",
      accessToken: "tok-rep",
      productsConsented: ["transactions"],
    });
    await db
      .update(plaidItems)
      .set({ status: "login_required", errorCode: "ITEM_LOGIN_REQUIRED" })
      .where(eq(plaidItems.id, pk));

    const km = await makeKey("kid-rep");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "rid" } });
    const rawBody = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "LOGIN_REPAIRED",
      item_id: "item-repaired",
    });
    const jwt = await signJWT({ km, rawBody });

    const res = await POST(buildRequest({ rawBody, jwt, forwardedFor: "32.0.0.1" }));
    expect(res.status).toBe(200);

    const [after] = await db
      .select({ status: plaidItems.status })
      .from(plaidItems)
      .where(eq(plaidItems.id, pk));
    expect(after?.status).toBe("active");
    // After repair, sync IS enqueued to catch up.
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/plaid/webhook — P4-16 hardening", () => {
  it("returns 429 after 100 reqs/min from the same IP", async () => {
    // No need to mock the Plaid client — rate limit fires BEFORE verification.
    const rawBody = "{}";
    const sourceIp = "9.9.9.9";

    let lastStatus = 0;
    for (let i = 0; i < 100; i++) {
      const res = await POST(buildRequest({ rawBody, jwt: "x", forwardedFor: sourceIp }));
      lastStatus = res.status;
      // Pre-cap requests pass rate-limit; they fail signature verification → 401.
      expect(res.status).toBe(401);
    }
    expect(lastStatus).toBe(401);

    // 101st request from the same IP must be rate-limited.
    const flooded = await POST(buildRequest({ rawBody, jwt: "x", forwardedFor: sourceIp }));
    expect(flooded.status).toBe(429);
  });

  it("rate-limits per IP — a different IP is unaffected by the first IP's flood", async () => {
    const rawBody = "{}";
    for (let i = 0; i < 100; i++) {
      await POST(buildRequest({ rawBody, jwt: "x", forwardedFor: "10.0.0.1" }));
    }
    // First IP is now exhausted.
    const exhausted = await POST(buildRequest({ rawBody, jwt: "x", forwardedFor: "10.0.0.1" }));
    expect(exhausted.status).toBe(429);
    // Second IP still has its full bucket.
    const fresh = await POST(buildRequest({ rawBody, jwt: "x", forwardedFor: "10.0.0.2" }));
    expect(fresh.status).toBe(401); // not 429
  });

  it("rejects payloads larger than the 1 MB cap with 413", async () => {
    const big = "x".repeat(1_000_001);
    const res = await POST(buildRequest({ rawBody: big, jwt: "x", forwardedFor: "11.0.0.1" }));
    // content-length isn't auto-set on Request from a string, but the body-length
    // check inside the handler catches it.
    expect([400, 413]).toContain(res.status);
  });
});
