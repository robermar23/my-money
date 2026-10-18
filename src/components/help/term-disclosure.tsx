"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * The client half of `<Term>` (PLAN20 P20-12): a disclosure, not a tooltip.
 *
 * A button with a dotted underline toggles a small definition below the word.
 * It opens on click, tap, Enter or Space, so it works by touch and by keyboard;
 * a hover-only tooltip fails both. `Esc` closes it and returns focus to the
 * word, and so does a click anywhere outside it.
 */

interface Props {
  readonly children: React.ReactNode;
  readonly term: string;
  readonly means: string;
  readonly tellsYou: string;
  /** Which edge the definition lines up with: `end` for right-aligned labels. */
  readonly align: "start" | "end";
}

export function TermDisclosure({
  children,
  term,
  means,
  tellsYou,
  align,
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        setOpen(false);
        buttonRef.current?.focus();
      },
      { signal },
    );
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (e.target instanceof Node && wrapRef.current?.contains(e.target)) return;
        setOpen(false);
      },
      { signal },
    );
    return () => controller.abort();
  }, [open]);

  return (
    <span ref={wrapRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
        className="cursor-help underline decoration-zinc-400 decoration-dotted underline-offset-2 hover:decoration-zinc-700 dark:hover:decoration-zinc-200"
      >
        {children}
      </button>
      <span
        id={panelId}
        hidden={!open}
        className={`absolute top-full z-30 mt-1 block w-64 max-w-[80vw] rounded-md border border-zinc-200 bg-white p-3 text-left font-normal text-xs text-zinc-600 normal-case leading-relaxed tracking-normal shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 ${
          align === "end" ? "right-0" : "left-0"
        }`}
      >
        <span className="block font-medium text-zinc-900 dark:text-zinc-50">{term}</span>
        <span className="mt-1 block">{means}</span>
        <span className="mt-1 block">{tellsYou}</span>
      </span>
    </span>
  );
}
