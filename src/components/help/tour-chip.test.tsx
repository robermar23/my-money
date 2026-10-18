// @vitest-environment jsdom
import { addAnchor, fakeLayout, fixtureTour } from "@/__test-support__/tour-layout.ts";
import { START_TOUR_EVENT, type StartTourDetail, startTour } from "@/lib/help/events.ts";
import type { HelpEntry } from "@/lib/help/types.ts";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * PLAN20 P20-16 / ADR-060 §4 — the first-visit chip offers a tour this device
 * has not seen, never starts one itself, and stays away once answered.
 */

const nav = vi.hoisted(() => ({ pathname: "/plan/cashflow" }));
const loaded = vi.hoisted(() => ({ entry: null as HelpEntry | null }));

vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
vi.mock("@/lib/help/load.ts", () => ({ loadHelpEntry: vi.fn(async () => loaded.entry) }));

const { TourChip } = await import("./tour-chip.tsx");

const TOUR = fixtureTour("cashflow", ["chart", "table"]);
const ENTRY: HelpEntry = {
  route: "/plan/cashflow",
  title: "Cash flow",
  summary: "Will my cash cover the bills ahead?",
  sections: [{ heading: "How to read it", blocks: [{ kind: "paragraph", text: "Text." }] }],
  tour: TOUR,
};

let container: HTMLDivElement;
let root: Root;
let restoreLayout: () => void;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  nav.pathname = "/plan/cashflow";
  loaded.entry = ENTRY;
  localStorage.clear();
  restoreLayout = fakeLayout();
  addAnchor("chart");
  addAnchor("table");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  restoreLayout();
});

/** Render the chip and let the lazy load and the paint wait settle. */
async function renderChip(): Promise<void> {
  await act(async () => root.render(<TourChip />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

function chipButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("New here?"),
  );
}

describe("TourChip", () => {
  it("offers an unseen tour without starting it", async () => {
    const started = vi.fn();
    window.addEventListener(START_TOUR_EVENT, started);
    await renderChip();
    window.removeEventListener(START_TOUR_EVENT, started);

    expect(chipButton()?.textContent).toBe("New here? Take a 30-second tour");
    expect(started).not.toHaveBeenCalled();
  });

  it("starts the tour on a click, and goes away", async () => {
    await renderChip();
    const started: StartTourDetail[] = [];
    const onStart = (e: Event): void => {
      started.push((e as CustomEvent<StartTourDetail>).detail);
    };
    window.addEventListener(START_TOUR_EVENT, onStart);
    await act(async () => chipButton()?.click());
    window.removeEventListener(START_TOUR_EVENT, onStart);

    expect(started).toEqual([{ tour: TOUR }]);
    expect(chipButton()).toBeUndefined();
  });

  it("stays away on this device once dismissed", async () => {
    await renderChip();
    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss the tour offer"]',
    );
    await act(async () => dismiss?.click());
    expect(chipButton()).toBeUndefined();
    expect(localStorage.getItem("my-money:help:tour:cashflow:v1")).toBe("dismissed");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderChip();
    expect(chipButton()).toBeUndefined();
  });

  it("is answered by a tour started from the panel", async () => {
    await renderChip();
    await act(async () => startTour(TOUR));
    expect(chipButton()).toBeUndefined();
  });

  it("is not offered when the page cannot show two steps", async () => {
    for (const el of document.querySelectorAll('[data-tour="table"]')) el.remove();
    await renderChip();
    expect(chipButton()).toBeUndefined();
  });

  it("is not offered on a page without a tour", async () => {
    loaded.entry = { ...ENTRY, tour: undefined };
    await renderChip();
    expect(chipButton()).toBeUndefined();
  });

  // PLAN20 P20-30: the checklist's "Take the tour" links arrive with #tour.
  describe("arriving with #tour", () => {
    afterEach(() => window.history.replaceState(null, "", "/"));

    it("starts the tour, even one already seen, and drops the fragment", async () => {
      localStorage.setItem("my-money:help:tour:cashflow:v1", "seen");
      window.history.replaceState(null, "", "/plan/cashflow?x=1#tour");
      const started: StartTourDetail[] = [];
      const onStart = (e: Event): void => {
        started.push((e as CustomEvent<StartTourDetail>).detail);
      };
      window.addEventListener(START_TOUR_EVENT, onStart);
      await renderChip();
      window.removeEventListener(START_TOUR_EVENT, onStart);

      expect(started).toEqual([{ tour: TOUR }]);
      expect(window.location.hash).toBe("");
      expect(window.location.search).toBe("?x=1");
      expect(chipButton()).toBeUndefined();
    });

    it("waits for anchors that stream in after the page paints", async () => {
      for (const el of document.querySelectorAll("[data-tour]")) el.remove();
      window.history.replaceState(null, "", "/plan/cashflow#tour");
      const started = vi.fn();
      window.addEventListener(START_TOUR_EVENT, started);
      await renderChip();
      expect(started).not.toHaveBeenCalled();
      addAnchor("chart");
      addAnchor("table");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
      window.removeEventListener(START_TOUR_EVENT, started);
      expect(started).toHaveBeenCalledTimes(1);
    });
  });
});
