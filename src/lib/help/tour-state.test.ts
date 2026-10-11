// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * PLAN20 P20-15 — tour state is a convenience: storage that works remembers,
 * storage that throws never throws out of the module.
 */

/** An in-memory `Storage`, so each test starts empty. */
function workingStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

/** A `Storage` whose every method throws, as in a locked-down private window. */
function throwingStorage(): Storage {
  const fail = (): never => {
    throw new DOMException("denied", "SecurityError");
  };
  return {
    length: 0,
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

const TOUR = { id: "cashflow", version: 1 };

/** A fresh module, so the in-memory fallback does not leak between tests. */
async function load(): Promise<typeof import("./tour-state.ts")> {
  vi.resetModules();
  return import("./tour-state.ts");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tour state", () => {
  it("remembers a taken or dismissed tour in localStorage", async () => {
    const store = workingStorage();
    vi.stubGlobal("localStorage", store);
    const state = await load();

    expect(state.hasSeen(TOUR)).toBe(false);
    state.markSeen(TOUR);
    expect(state.hasSeen(TOUR)).toBe(true);
    expect(store.getItem("my-money:help:tour:cashflow:v1")).toBe("seen");

    state.markDismissed({ id: "sinking", version: 3 });
    expect(store.getItem("my-money:help:tour:sinking:v3")).toBe("dismissed");
  });

  it("offers a new version of a seen tour again", async () => {
    vi.stubGlobal("localStorage", workingStorage());
    const state = await load();

    state.markSeen(TOUR);
    expect(state.hasSeen({ ...TOUR, version: 2 })).toBe(false);
  });

  it("never throws when storage throws, and remembers for the page's life", async () => {
    vi.stubGlobal("localStorage", throwingStorage());
    const state = await load();

    expect(() => state.hasSeen(TOUR)).not.toThrow();
    expect(state.hasSeen(TOUR)).toBe(false);
    expect(() => state.markDismissed(TOUR)).not.toThrow();
    expect(state.hasSeen(TOUR)).toBe(true);
  });

  it("works with no storage at all", async () => {
    vi.stubGlobal("localStorage", undefined);
    const state = await load();

    expect(state.hasSeen(TOUR)).toBe(false);
    state.markSeen(TOUR);
    expect(state.hasSeen(TOUR)).toBe(true);
  });

  it("survives a getter that throws on access", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    try {
      const state = await load();
      expect(() => state.markSeen(TOUR)).not.toThrow();
      expect(state.hasSeen(TOUR)).toBe(true);
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
