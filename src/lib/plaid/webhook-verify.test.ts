// @vitest-environment node
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * Mock the Plaid client BEFORE importing the verifier so the imported
 * `plaidClient` resolves to our stub. The webhookVerificationKeyGet method
 * is the one Plaid calls when a kid isn't in cache.
 * --------------------------------------------------------------------------- */

const mockKeyGet = vi.fn();
vi.mock("@/lib/plaid/client.ts", () => ({
  plaidClient: { webhookVerificationKeyGet: mockKeyGet },
  plaidEnvironment: () => "sandbox",
  plaidWebhookUrl: () => undefined,
}));

const { verifyWebhook, sha256Hex, _resetKeyCacheForTests } = await import("./webhook-verify.ts");

/* ---------------------------------------------------------------------------
 * Test fixtures
 * --------------------------------------------------------------------------- */

interface KeyMaterial {
  kid: string;
  jwk: Record<string, unknown>; // Plaid's JWKPublicKey-shaped public key
  privateKey: CryptoKey;
}

async function makeKeyMaterial(kid: string): Promise<KeyMaterial> {
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

async function signWebhookJWT(opts: {
  privateKey: CryptoKey;
  kid: string;
  rawBody: string;
  iatOverride?: number;
  bodyHashOverride?: string;
}): Promise<string> {
  const iat = opts.iatOverride ?? Math.floor(Date.now() / 1_000);
  const body_sha256 = opts.bodyHashOverride ?? sha256Hex(opts.rawBody);
  return new SignJWT({ request_body_sha256: body_sha256, iat })
    .setProtectedHeader({ alg: "ES256", kid: opts.kid, typ: "JWT" })
    .sign(opts.privateKey);
}

function makeHeaders(jwt: string | null): Headers {
  const h = new Headers();
  if (jwt !== null) h.set("Plaid-Verification", jwt);
  return h;
}

const SAMPLE_BODY = JSON.stringify({
  webhook_type: "TRANSACTIONS",
  webhook_code: "SYNC_UPDATES_AVAILABLE",
  item_id: "sandbox-item-1",
  initial_update_complete: true,
  historical_update_complete: false,
});

beforeEach(() => {
  _resetKeyCacheForTests();
  mockKeyGet.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ---------------------------------------------------------------------------
 * Tests
 * --------------------------------------------------------------------------- */

describe("verifyWebhook — happy path", () => {
  it("valid signature + body returns the parsed body", async () => {
    const km = await makeKeyMaterial("kid-happy");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "req-1" } });

    const jwt = await signWebhookJWT({
      privateKey: km.privateKey,
      kid: km.kid,
      rawBody: SAMPLE_BODY,
    });

    const result = await verifyWebhook(makeHeaders(jwt), SAMPLE_BODY);
    expect(result).not.toBeNull();
    expect(result?.body.webhook_type).toBe("TRANSACTIONS");
    expect(result?.body.webhook_code).toBe("SYNC_UPDATES_AVAILABLE");
    expect(result?.body.item_id).toBe("sandbox-item-1");
    expect(mockKeyGet).toHaveBeenCalledTimes(1);
    expect(mockKeyGet).toHaveBeenCalledWith({ key_id: "kid-happy" });
  });

  it("subsequent calls with the same kid hit the cache (no second fetch)", async () => {
    const km = await makeKeyMaterial("kid-cache");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "req-1" } });

    for (let i = 0; i < 3; i++) {
      const jwt = await signWebhookJWT({
        privateKey: km.privateKey,
        kid: km.kid,
        rawBody: SAMPLE_BODY,
      });
      const result = await verifyWebhook(makeHeaders(jwt), SAMPLE_BODY);
      expect(result).not.toBeNull();
    }
    expect(mockKeyGet).toHaveBeenCalledTimes(1);
  });
});

describe("verifyWebhook — rejection paths", () => {
  it("returns null when the Plaid-Verification header is missing", async () => {
    const result = await verifyWebhook(makeHeaders(null), SAMPLE_BODY);
    expect(result).toBeNull();
    expect(mockKeyGet).not.toHaveBeenCalled();
  });

  it("returns null on a tampered body (signature checks out, but hash differs)", async () => {
    const km = await makeKeyMaterial("kid-tamper");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "req-1" } });

    const jwt = await signWebhookJWT({
      privateKey: km.privateKey,
      kid: km.kid,
      rawBody: SAMPLE_BODY,
    });
    // Hand the verifier a different rawBody than what was signed.
    const tampered = SAMPLE_BODY.replace("sandbox-item-1", "sandbox-item-EVIL");
    const result = await verifyWebhook(makeHeaders(jwt), tampered);
    expect(result).toBeNull();
  });

  it("returns null when the JWT iat is older than the freshness window", async () => {
    const km = await makeKeyMaterial("kid-expired");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "req-1" } });

    const tenMinAgo = Math.floor(Date.now() / 1_000) - 10 * 60;
    const jwt = await signWebhookJWT({
      privateKey: km.privateKey,
      kid: km.kid,
      rawBody: SAMPLE_BODY,
      iatOverride: tenMinAgo,
    });
    const result = await verifyWebhook(makeHeaders(jwt), SAMPLE_BODY);
    expect(result).toBeNull();
  });

  it("returns null when the JWT iat is far in the future", async () => {
    const km = await makeKeyMaterial("kid-future");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "req-1" } });

    const futureSec = Math.floor(Date.now() / 1_000) + 60;
    const jwt = await signWebhookJWT({
      privateKey: km.privateKey,
      kid: km.kid,
      rawBody: SAMPLE_BODY,
      iatOverride: futureSec,
    });
    const result = await verifyWebhook(makeHeaders(jwt), SAMPLE_BODY);
    expect(result).toBeNull();
  });

  it("returns null when the kid is unknown to Plaid", async () => {
    mockKeyGet.mockRejectedValueOnce(new Error("404 Not Found"));

    // Generate a real signed JWT but with a kid Plaid won't recognize.
    const km = await makeKeyMaterial("kid-rogue");
    const jwt = await signWebhookJWT({
      privateKey: km.privateKey,
      kid: km.kid,
      rawBody: SAMPLE_BODY,
    });
    const result = await verifyWebhook(makeHeaders(jwt), SAMPLE_BODY);
    expect(result).toBeNull();
    expect(mockKeyGet).toHaveBeenCalledTimes(1);
  });

  it("returns null when the JWT was signed by a different key than Plaid claims", async () => {
    // Plaid serves key A for the kid; the attacker signs with key B but uses kid A.
    const real = await makeKeyMaterial("kid-substituted");
    const attacker = await makeKeyMaterial("kid-substituted");
    mockKeyGet.mockResolvedValueOnce({ data: { key: real.jwk, request_id: "req-1" } });

    const jwt = await signWebhookJWT({
      privateKey: attacker.privateKey,
      kid: real.kid,
      rawBody: SAMPLE_BODY,
    });
    const result = await verifyWebhook(makeHeaders(jwt), SAMPLE_BODY);
    expect(result).toBeNull();
  });

  it("returns null when alg is not ES256 (HS256 substitution attack)", async () => {
    // Construct a JWT signed with HS256 (not ES256). The verifier must reject
    // it at the algorithm check, never falling back to the JWK's `alg`.
    const km = await makeKeyMaterial("kid-hs256");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "req-1" } });

    const hsSecret = new TextEncoder().encode("attacker-secret");
    const jwt = await new SignJWT({
      request_body_sha256: sha256Hex(SAMPLE_BODY),
      iat: Math.floor(Date.now() / 1_000),
    })
      .setProtectedHeader({ alg: "HS256", kid: km.kid })
      .sign(hsSecret);

    const result = await verifyWebhook(makeHeaders(jwt), SAMPLE_BODY);
    expect(result).toBeNull();
  });

  it("returns null on malformed body JSON (signature OK but body is not an object)", async () => {
    const km = await makeKeyMaterial("kid-malformed");
    mockKeyGet.mockResolvedValueOnce({ data: { key: km.jwk, request_id: "req-1" } });

    const notObject = '["a","b"]'; // valid JSON, but an array, not an object
    const jwt = await signWebhookJWT({
      privateKey: km.privateKey,
      kid: km.kid,
      rawBody: notObject,
    });
    const result = await verifyWebhook(makeHeaders(jwt), notObject);
    expect(result).toBeNull();
  });
});
