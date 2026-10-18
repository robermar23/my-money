// @vitest-environment jsdom
import { addAnchor, fakeLayout, fixtureTour } from "@/__test-support__/tour-layout.ts";
import { startTour } from "@/lib/help/events.ts";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * PLAN20 P20-14 — the tour runs the steps the page can show, steps with the
 * buttons and the keys, keeps focus in its card, and gives focus back.
 */

const nav = vi.hoisted(() => ({ pathname: "/plan/cashflow" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { TourRunner } = await import("./tour.tsx");

let container: HTMLDivElement;
let root: Root;
let restoreLayout: () => void;
let starter: HTMLButtonElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  nav.pathname = "/plan/cashflow";
  localStorage.clear();
  restoreLayout = fakeLayout();
  addAnchor("chart");
  addAnchor("strip", true);
  addAnchor("table");
  addAnchor("filters");
  starter = document.createElement("button");
  starter.textContent = "Take the tour";
  document.body.append(starter);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<TourRunner />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  restoreLayout();
});

const TOUR = fixtureTour("cashflow", ["chart", "strip", "table", "filters"]);

function card(): HTMLDialogElement | null {
  return document.querySelector("dialog");
}

function button(name: string): HTMLButtonElement {
  const found = [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === name);
  if (!found) throw new Error(`no ${name} button`);
  return found;
}

async function start(): Promise<void> {
  starter.focus();
  await act(async () => startTour(TOUR));
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
    );
  });
}

describe("TourRunner", () => {
  it("shows nothing until a tour is started", () => {
    expect(card()).toBeNull();
  });

  it("skips the hidden anchor and focuses the first step's card", async () => {
    await start();

    expect(card()?.textContent).toContain("1 of 3");
    expect(card()?.querySelector("h2")?.textContent).toBe("About chart");
    expect(document.activeElement).toBe(card());
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Step 1 of 3: About chart. What chart shows.",
    );
  });

  it("records the tour as seen on this device", async () => {
    await start();
    expect(localStorage.getItem("my-money:help:tour:cashflow:v1")).toBe("seen");
  });

  it("steps with Next and Back, and ends on Done", async () => {
    await start();
    expect(button("Back").disabled).toBe(true);

    await act(async () => button("Next").click());
    expect(card()?.querySelector("h2")?.textContent).toBe("About table");
    await act(async () => button("Back").click());
    expect(card()?.querySelector("h2")?.textContent).toBe("About chart");

    await act(async () => button("Next").click());
    await act(async () => button("Next").click());
    expect(card()?.textContent).toContain("3 of 3");
    await act(async () => button("Done").click());
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(starter);
  });

  it("steps with the arrow keys and ends on Esc, returning focus", async () => {
    await start();

    await press("ArrowRight");
    expect(card()?.textContent).toContain("2 of 3");
    await press("ArrowLeft");
    expect(card()?.textContent).toContain("1 of 3");
    await press("Escape");

    expect(card()).toBeNull();
    expect(document.activeElement).toBe(starter);
  });

  it("ends from Skip tour", async () => {
    await start();
    await act(async () => button("Skip tour").click());
    expect(card()).toBeNull();
  });

  it("keeps Tab inside the card", async () => {
    await start();
    await act(async () => button("Next").click());
    button("Next").focus();

    await press("Tab");
    expect(document.activeElement).toBe(button("Skip tour"));
    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(button("Next"));
  });

  it("does not start when fewer than two steps can run", async () => {
    await act(async () => startTour(fixtureTour("thin", ["chart", "strip", "missing"])));
    expect(card()).toBeNull();
    expect(localStorage.getItem("my-money:help:tour:thin:v1")).toBeNull();
  });

  it("ends when the page changes", async () => {
    await start();
    nav.pathname = "/plan/sinking";
    await act(async () => root.render(<TourRunner />));
    expect(card()).toBeNull();
  });
});
