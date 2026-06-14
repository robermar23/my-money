// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { isRateLimitError, withRateLimitRetry } from "./retry.ts";

describe("isRateLimitError", () => {
  it("matches Yahoo's 'Too Many Requests' body and a bare 429", () => {
    expect(isRateLimitError(new Error('"Too Many Requests" is not valid JSON'))).toBe(true);
    expect(isRateLimitError(new Error("Request failed with status code 429"))).toBe(true);
  });
  it("does not match unrelated errors", () => {
    expect(isRateLimitError(new Error("did not match schema"))).toBe(false);
    expect(isRateLimitError(new Error("ENOTFOUND"))).toBe(false);
  });
});

describe("withRateLimitRetry", () => {
  const noSleep = vi.fn(async () => {});

  it("retries a 429 then succeeds", async () => {
    let calls = 0;
    const result = await withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("Too Many Requests");
        return "ok";
      },
      { sleepFn: noSleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws immediately on a non-429 error (no retry)", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls += 1;
          throw new Error("schema mismatch");
        },
        { sleepFn: noSleep },
      ),
    ).rejects.toThrow("schema mismatch");
    expect(calls).toBe(1);
  });

  it("gives up after the configured attempts and rethrows the 429", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls += 1;
          throw new Error("429 Too Many Requests");
        },
        { attempts: 3, sleepFn: noSleep },
      ),
    ).rejects.toThrow("Too Many Requests");
    expect(calls).toBe(3);
  });
});
