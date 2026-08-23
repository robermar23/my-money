"use client";

import { useEffect, useId, useRef } from "react";

/**
 * One disclosure in the top bar (NAV-05, PLAN_NAV §4.4).
 *
 * Implements the ARIA APG **Disclosure Navigation Menu** pattern — a plain
 * `<button aria-expanded aria-controls>` revealing a list of links — and
 * deliberately **not** `role="menubar"`/`menuitem`. These are navigation links,
 * not application menu commands: `menubar` semantics would oblige roving
 * `tabindex`, typeahead, and arrow wraparound, and would make screen readers
 * announce the site nav as an application menu. Getting this wrong is the most
 * common defect in a grouped nav (ADR-035 rule 6).
 *
 * Open state is **owned by the parent** so only one group can be open at a
 * time; this component owns only the closing behaviours, which are the fiddly
 * part: `Esc` (returning focus to the trigger), an outside pointer press, and
 * focus leaving the disclosure by `Tab` or `Shift+Tab`.
 *
 * The panel content is a `children` slot rather than a fixed item list, so the
 * same 40 lines serve both the group menus and the ⋯ account menu (whose panel
 * holds a sign-out form, not links). That reuse is why ADR-035 could decline
 * Radix / Headless UI without a second thought.
 */
interface Props {
  /** Visible trigger text. Use `srLabel` when this is a glyph like "⋯". */
  readonly label: React.ReactNode;
  /** Accessible name, when `label` is not readable text on its own. */
  readonly srLabel?: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** True when the current route lives in this group — draws a persistent underline. */
  readonly active?: boolean;
  /** Which edge the panel hangs from. Right-align anything near the bar's end. */
  readonly align?: "left" | "right";
  /** Panel body — a `<ul>` of `<Link>`s, or a form. */
  readonly children: React.ReactNode;
}

export function NavGroupMenu({
  label,
  srLabel,
  open,
  onOpenChange,
  active = false,
  align = "left",
  children,
}: Props): React.JSX.Element {
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Outside press closes. `pointerdown` (not `click`) so the panel is gone
  // before the underlying control receives its own event.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && wrapperRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, onOpenChange]);

  /** `Esc` closes and returns focus to the trigger — the APG contract. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!open || event.key !== "Escape") return;
    event.stopPropagation();
    onOpenChange(false);
    triggerRef.current?.focus();
  };

  /**
   * Focus leaving the disclosure closes it. This is what implements "Tab past
   * the last link closes" *and* "Shift+Tab off the trigger closes" without
   * intercepting either keystroke — focus lands wherever the browser sends it.
   */
  const onBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
    if (!open) return;
    const next = event.relatedTarget;
    if (next instanceof Node && wrapperRef.current?.contains(next)) return;
    onOpenChange(false);
  };

  return (
    // The wrapper is a passive observer: it watches for keyboard/focus escape
    // from its own interactive children (the trigger and the panel's links).
    // It is never focusable or clickable itself, so it needs no role.
    <div ref={wrapperRef} className="relative" onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={srLabel}
        onClick={() => onOpenChange(!open)}
        className={`flex items-center gap-1 py-1 ${
          active
            ? "font-medium text-zinc-900 underline underline-offset-8 dark:text-zinc-50"
            : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
        }`}
      >
        {label}
        <svg
          viewBox="0 0 24 24"
          className={`h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none ${
            open ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          role="img"
          aria-hidden="true"
        >
          <title>Toggle</title>
          <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          id={panelId}
          className={`absolute top-full z-30 mt-2 w-64 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
