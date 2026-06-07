// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * Mock next/headers so we can drive the source IP the throttle keys on.
 * --------------------------------------------------------------------------- */

let currentIp = "1.2.3.4";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "cf-connecting-ip": currentIp })),
}));

const { allowLoginAttempt, _resetLoginThrottle } = await import("./login-throttle.ts");

beforeEach(() => {
  _resetLoginThrottle();
  currentIp = "1.2.3.4";
});
afterEach(() => vi.clearAllMocks());

describe("allowLoginAttempt", () => {
  it("allows up to 10 attempts per IP per minute, then throttles", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await allowLoginAttempt()).toBe(true);
    }
    // 11th attempt within the window is rejected.
    expect(await allowLoginAttempt()).toBe(false);
  });

  it("buckets per source IP — one IP's exhaustion does not block another", async () => {
    for (let i = 0; i < 10; i++) {
      await allowLoginAttempt();
    }
    expect(await allowLoginAttempt()).toBe(false);

    currentIp = "9.9.9.9";
    expect(await allowLoginAttempt()).toBe(true);
  });

  it("reset clears the throttle", async () => {
    for (let i = 0; i < 10; i++) {
      await allowLoginAttempt();
    }
    expect(await allowLoginAttempt()).toBe(false);

    _resetLoginThrottle();
    expect(await allowLoginAttempt()).toBe(true);
  });
});
