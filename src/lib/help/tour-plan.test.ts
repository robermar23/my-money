// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MIN_TOUR_STEPS, runnableSteps, tourStorageKey } from "./tour-plan.ts";

/* PLAN20 P20-13 — a missing anchor skips its step; too few steps means no tour. */

const STEPS = [
  { anchor: "chart", title: "Chart" },
  { anchor: "table", title: "Table" },
  { anchor: "strip", title: "Strip" },
  { anchor: "filters", title: "Filters" },
] as const;

const present =
  (...anchors: string[]) =>
  (anchor: string): boolean =>
    anchors.includes(anchor);

describe("runnableSteps", () => {
  it("keeps every step when every anchor is on the page", () => {
    expect(runnableSteps(STEPS, () => true)).toEqual(STEPS);
  });

  it("skips a step whose anchor is missing, keeping the rest in order", () => {
    const steps = runnableSteps(STEPS, present("filters", "chart", "table"));
    expect(steps.map((s) => s.title)).toEqual(["Chart", "Table", "Filters"]);
  });

  it(`offers no tour when fewer than ${MIN_TOUR_STEPS} steps survive`, () => {
    expect(runnableSteps(STEPS, present("chart"))).toEqual([]);
    expect(runnableSteps(STEPS, present())).toEqual([]);
    expect(runnableSteps(STEPS, present("chart", "strip"))).toHaveLength(2);
  });
});

describe("tourStorageKey", () => {
  it("puts the version in the key, so a new version is offered again", () => {
    expect(tourStorageKey("cashflow", 1)).toBe("my-money:help:tour:cashflow:v1");
    expect(tourStorageKey("cashflow", 2)).not.toBe(tourStorageKey("cashflow", 1));
  });
});
