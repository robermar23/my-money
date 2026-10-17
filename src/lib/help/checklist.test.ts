// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type ChecklistFacts,
  REVIEW_QUEUE_TARGET,
  gettingStarted,
  isComplete,
} from "./checklist.ts";
import { TOUR_HASH } from "./events.ts";
import { helpFor } from "./registry.ts";

/*
 * PLAN20 P20-30 — the getting-started checklist is derived from facts, ticks
 * itself when the thing is done, and only links where it can lead somewhere.
 */

const EMPTY: ChecklistFacts = {
  hasAccount: false,
  importAccountId: null,
  hasTransaction: false,
  waitingCount: 0,
  hasOwnRule: false,
  backupsConfigured: false,
};

const SET_UP: ChecklistFacts = {
  hasAccount: true,
  importAccountId: "acct-1",
  hasTransaction: true,
  waitingCount: 0,
  hasOwnRule: true,
  backupsConfigured: true,
};

function item(facts: ChecklistFacts, id: string) {
  const found = gettingStarted(facts).find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

describe("gettingStarted", () => {
  it("lists the five items in order, none done on an empty book", () => {
    const items = gettingStarted(EMPTY);
    expect(items.map((i) => i.id)).toEqual([
      "account",
      "transactions",
      "review",
      "rule",
      "backups",
    ]);
    expect(items.some((i) => i.done)).toBe(false);
    expect(isComplete(items)).toBe(false);
  });

  it("is complete when the book is set up", () => {
    expect(isComplete(gettingStarted(SET_UP))).toBe(true);
  });

  it("does not count an empty review queue as worked down", () => {
    expect(item({ ...EMPTY, hasAccount: true }, "review").done).toBe(false);
  });

  it("ticks the review queue only below the target", () => {
    expect(item({ ...SET_UP, waitingCount: REVIEW_QUEUE_TARGET - 1 }, "review").done).toBe(true);
    expect(item({ ...SET_UP, waitingCount: REVIEW_QUEUE_TARGET }, "review").done).toBe(false);
  });

  it("leaves backups to do when nothing can say whether they run", () => {
    expect(item({ ...SET_UP, backupsConfigured: null }, "backups").done).toBe(false);
  });

  it("links an import only once there is an account to import into", () => {
    expect(item(EMPTY, "transactions").href).toBeNull();
    expect(item(EMPTY, "transactions").tourHref).toBeNull();
    expect(item(SET_UP, "transactions").href).toBe("/accounts/acct-1/import");
    expect(item(SET_UP, "review").href).toBe("/analysis/review");
    expect(item(EMPTY, "review").href).toBeNull();
  });

  it("only offers a tour on a page that has one", () => {
    for (const facts of [EMPTY, SET_UP]) {
      for (const i of gettingStarted(facts)) {
        if (i.tourHref === null) continue;
        expect(i.tourHref.endsWith(TOUR_HASH)).toBe(true);
        expect(i.href).not.toBeNull();
        const page = i.tourHref.slice(0, -TOUR_HASH.length);
        expect(helpFor(page)?.tour, page).toBeDefined();
      }
    }
  });

  it("never states a dollar figure", () => {
    for (const i of gettingStarted(SET_UP)) {
      expect(`${i.title} ${i.detail}`).not.toMatch(/\$\s?\d/);
    }
  });
});
