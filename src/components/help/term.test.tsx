// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Term } from "./term.tsx";

/**
 * PLAN20 P20-12 — `<Term>` is a disclosure: it opens by click or keyboard,
 * never by hover alone, and `Esc` closes it and hands focus back to the word.
 */

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <p>
        <Term id="safe-to-spend">Safe to spend</Term>
      </p>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function word(): HTMLButtonElement {
  const button = container.querySelector("button");
  if (!button) throw new Error("no term button");
  return button;
}

function definition(): HTMLElement {
  const id = word().getAttribute("aria-controls");
  const panel = id ? document.getElementById(id) : null;
  if (!panel) throw new Error("no definition panel");
  return panel;
}

describe("Term", () => {
  it("starts closed and opens on click with the glossary's words", async () => {
    expect(word().getAttribute("aria-expanded")).toBe("false");
    expect(definition().hidden).toBe(true);

    await act(async () => word().click());

    expect(word().getAttribute("aria-expanded")).toBe("true");
    expect(definition().hidden).toBe(false);
    expect(definition().textContent).toContain("It is an allowance, not a balance.");
  });

  it("closes on Esc and returns focus to the word", async () => {
    await act(async () => word().click());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(definition().hidden).toBe(true);
    expect(document.activeElement).toBe(word());
  });

  it("closes on a click outside it", async () => {
    await act(async () => word().click());
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(definition().hidden).toBe(true);
  });
});
