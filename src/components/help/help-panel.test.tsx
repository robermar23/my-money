// @vitest-environment jsdom
import type { GlossaryEntry } from "@/lib/help/glossary.ts";
import type { HelpEntry } from "@/lib/help/types.ts";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PLAN20 P20-08 — the panel renders what the registry gives it, says so calmly
 * when there is nothing, ignores `?` typed into a field, and hands focus back.
 *
 * The native `<dialog>` is stubbed: jsdom does not implement `showModal()`,
 * and its focus trapping and `Esc` handling are the browser's job, not ours
 * (CLAUDE.md §Testing Philosophy).
 */

const nav = vi.hoisted(() => ({ pathname: "/plan/cashflow" }));
const loaded = vi.hoisted(() => ({ entry: null as HelpEntry | null }));

const LOW_POINT: GlossaryEntry = {
  term: "Lowest projected balance",
  means: "The tightest day ahead.",
  tellsYou: "Move money in before then.",
};

vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
vi.mock("@/lib/help/load.ts", () => ({
  loadHelpEntry: vi.fn(async () => loaded.entry),
  loadGlossaryTerms: vi.fn(async (ids: readonly string[]) => (ids.length > 0 ? [LOW_POINT] : [])),
}));

const { loadHelpEntry } = await import("@/lib/help/load.ts");
const { HelpButton } = await import("./help-button.tsx");
const { HelpPanel } = await import("./help-panel.tsx");

const ENTRY: HelpEntry = {
  route: "/plan/cashflow",
  title: "Cash flow",
  summary: "Will my cash cover the bills ahead?",
  sections: [
    {
      heading: "How to read it",
      blocks: [
        { kind: "paragraph", text: ["The line is your ", { strong: "projected balance" }, "."] },
        { kind: "steps", items: ["Pick an account.", "Read the low point."] },
        { kind: "definition", term: "Low-water date", text: "The day the balance is lowest." },
        { kind: "callout", tone: "warning", text: "A stale account skews the line." },
      ],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

beforeEach(async () => {
  vi.clearAllMocks();
  nav.pathname = "/plan/cashflow";
  loaded.entry = ENTRY;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <>
        <HelpButton variant="icon" />
        <input aria-label="Payee" />
        <HelpPanel />
      </>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function q<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

function helpButton(): HTMLButtonElement {
  const button = q<HTMLButtonElement>('button[aria-label="Help for this page"]');
  if (!button) throw new Error("no help button");
  return button;
}

function isOpen(): boolean {
  return q("dialog")?.hasAttribute("open") ?? false;
}

async function pressQuestionMark(target: EventTarget): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
  });
}

describe("HelpPanel", () => {
  it("renders every block type as text, under the entry's title", async () => {
    await act(async () => helpButton().click());

    const dialog = q("dialog");
    expect(isOpen()).toBe(true);
    const title = dialog?.querySelector("h2");
    expect(title?.textContent).toBe("Cash flow");
    expect(dialog?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(dialog?.querySelector("h3")?.textContent).toBe("How to read it");
    expect(dialog?.querySelector("strong")?.textContent).toBe("projected balance");
    expect(dialog?.querySelectorAll("ol li")).toHaveLength(2);
    expect(dialog?.querySelector("dt")?.textContent).toBe("Low-water date");
    expect(dialog?.querySelector('[role="note"]')?.textContent).toContain("A stale account");
    expect(loadHelpEntry).toHaveBeenCalledWith("/plan/cashflow");
  });

  it("adds the page's glossary terms and links to related pages", async () => {
    loaded.entry = {
      ...ENTRY,
      terms: ["lowest-projected-balance"],
      relatedRoutes: ["/settings/household"],
    };
    await act(async () => helpButton().click());

    const dialog = q("dialog");
    const headings = [...(dialog?.querySelectorAll("h3") ?? [])].map((h) => h.textContent);
    expect(headings).toEqual(["How to read it", "Words on this page", "See also"]);
    expect([...(dialog?.querySelectorAll("dt") ?? [])].map((d) => d.textContent)).toContain(
      "Lowest projected balance",
    );
    const link = dialog?.querySelector<HTMLAnchorElement>('a[href="/settings/household"]');
    expect(link?.textContent).toBe("Settings → Household");
  });

  it("says calmly that there is no help when the registry has none", async () => {
    loaded.entry = null;
    await act(async () => helpButton().click());

    expect(q("dialog")?.textContent).toContain("No help for this page yet.");
    expect(q('[role="alert"]')).toBeNull();
  });

  it("does not look anything up for a page with no help route", async () => {
    nav.pathname = "/login";
    await act(async () => root.render(<HelpPanel />));
    await pressQuestionMark(document.body);

    expect(q("dialog")?.textContent).toContain("No help for this page yet.");
    expect(loadHelpEntry).not.toHaveBeenCalled();
  });

  it("opens on ? outside a field, and not on ? typed into one", async () => {
    const input = q<HTMLInputElement>("input");
    if (!input) throw new Error("no input");
    await pressQuestionMark(input);
    expect(isOpen()).toBe(false);

    await pressQuestionMark(document.body);
    expect(isOpen()).toBe(true);
  });

  it("returns focus to the button that opened it", async () => {
    const button = helpButton();
    button.focus();
    await act(async () => button.click());
    expect(isOpen()).toBe(true);

    const close = q<HTMLButtonElement>('button[aria-label="Close help"]');
    await act(async () => close?.click());

    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button);
  });
});
