// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * PLAN20 P20-30 — the checklist's one stored mark: put away for good once
 * closed, and a storage failure never throws out of the module.
 */

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

function throwingStorage(): Storage {
  const fail = (): never => {
    throw new DOMException("denied", "SecurityError");
  };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

/** A fresh module, so the in-memory fallback does not leak between tests. */
async function load(): Promise<typeof import("./checklist-state.ts")> {
  vi.resetModules();
  return import("./checklist-state.ts");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("checklist state", () => {
  it("is open until closed, and closed under a my-money:help key", async () => {
    const storage = workingStorage();
    vi.stubGlobal("localStorage", storage);
    const state = await load();
    expect(state.isChecklistClosed()).toBe(false);
    state.closeChecklist("done");
    expect(state.isChecklistClosed()).toBe(true);
    expect(storage.getItem("my-money:help:checklist")).toBe("done");
  });

  it("survives a reload once dismissed", async () => {
    const storage = workingStorage();
    vi.stubGlobal("localStorage", storage);
    (await load()).closeChecklist("dismissed");
    expect((await load()).isChecklistClosed()).toBe(true);
  });

  it("never throws when storage does, and remembers for the page's life", async () => {
    vi.stubGlobal("localStorage", throwingStorage());
    const state = await load();
    expect(state.isChecklistClosed()).toBe(false);
    expect(() => state.closeChecklist("dismissed")).not.toThrow();
    expect(state.isChecklistClosed()).toBe(true);
  });
});
