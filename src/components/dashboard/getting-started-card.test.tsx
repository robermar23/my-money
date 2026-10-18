// @vitest-environment jsdom
import { type ChecklistFacts, gettingStarted } from "@/lib/help/checklist.ts";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GettingStartedCard } from "./getting-started-card.tsx";

/*
 * PLAN20 P20-30 — the dashboard's checklist card: dismissible, and gone for
 * good on this device once dismissed or once every item is done.
 */

const KEY = "my-money:help:checklist";

const PARTLY: ChecklistFacts = {
  hasAccount: true,
  importAccountId: "acct-1",
  hasTransaction: false,
  waitingCount: 0,
  hasOwnRule: false,
  backupsConfigured: null,
};

const EMPTY: ChecklistFacts = {
  hasAccount: false,
  importAccountId: null,
  hasTransaction: false,
  waitingCount: 0,
  hasOwnRule: false,
  backupsConfigured: false,
};

const DONE: ChecklistFacts = {
  ...PARTLY,
  hasTransaction: true,
  hasOwnRule: true,
  backupsConfigured: true,
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

async function render(facts: ChecklistFacts): Promise<void> {
  await act(async () => root.render(<GettingStartedCard items={gettingStarted(facts)} />));
}

describe("GettingStartedCard", () => {
  it("shows what is left, linking each item and its tour", async () => {
    await render(PARTLY);
    expect(container.querySelector("h2")?.textContent).toBe("Getting started");
    expect(container.textContent).toContain("1 of 5 done");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/accounts/acct-1/import");
    expect(hrefs).toContain("/accounts/acct-1/import#tour");
    // The done item no longer links.
    expect(hrefs).not.toContain("/accounts/new");
  });

  it("stays away once dismissed", async () => {
    await render(PARTLY);
    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss getting started"]',
    );
    await act(async () => dismiss?.click());
    expect(container.innerHTML).toBe("");
    expect(localStorage.getItem(KEY)).toBe("dismissed");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(PARTLY);
    expect(container.innerHTML).toBe("");
  });

  it("goes for good once everything is done, even if an item slips later", async () => {
    await render(DONE);
    expect(container.innerHTML).toBe("");
    expect(localStorage.getItem(KEY)).toBe("done");

    await render(PARTLY);
    expect(container.innerHTML).toBe("");
  });
});

describe("FirstRunDashboard", () => {
  it("shows the checklist under the first step, without a dismiss button", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FirstRunDashboard } = await import("./first-run.tsx");
    const html = renderToStaticMarkup(<FirstRunDashboard checklist={gettingStarted(EMPTY)} />);
    expect(html).toContain("Getting started");
    expect(html).toContain('href="/accounts/new"');
    expect(html).toContain('href="/accounts#tour"');
    expect(html).not.toContain("Dismiss getting started");
  });
});
