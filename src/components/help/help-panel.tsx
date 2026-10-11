"use client";

import {
  OPEN_HELP_EVENT,
  type OpenHelpDetail,
  isTypingTarget,
  startTour,
} from "@/lib/help/events.ts";
import type { GlossaryEntry } from "@/lib/help/glossary.ts";
import { loadGlossaryTerms, loadHelpEntry } from "@/lib/help/load.ts";
import { resolveHelpRoute } from "@/lib/help/resolve.ts";
import type { HelpRoute } from "@/lib/help/routes.ts";
import { runnableSteps } from "@/lib/help/tour-plan.ts";
import type { HelpEntry, TourDefinition } from "@/lib/help/types.ts";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { HelpContent } from "./help-content.tsx";
import { isAnchorVisible } from "./tour-dom.ts";

/**
 * The help panel (PLAN20 P20-05, ADR-058).
 *
 * Mounted once from the server `AppNav`, beside the ⌘K palette, so every
 * authenticated page has it without a single `page.tsx` changing. It opens on
 * the `?` key, the `?` buttons, and the palette's Help results, all through
 * {@link OPEN_HELP_EVENT}.
 *
 * It is a native `<dialog>` opened with `showModal()`, so the browser traps
 * focus, makes the page behind it inert, and closes it on `Esc`. Focus goes
 * back to whatever opened it. A right-side drawer from `sm:` up, a bottom sheet
 * below.
 *
 * `usePathname()` picks the entry, so the panel follows client-side navigation,
 * and the entry is loaded lazily by {@link loadHelpEntry}: the bundle carries
 * one nav group's help, not all 33 pages'.
 *
 * When the page has a tour that can run on it as it is (P20-13), the panel
 * offers "Take the tour", which closes the panel and starts it (P20-16).
 */

/** What the panel body shows. */
type Content =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly entry: HelpEntry;
      readonly terms: readonly GlossaryEntry[];
      /** The page's tour, when at least two of its steps can run right now. */
      readonly tour: TourDefinition | null;
    }
  | { readonly kind: "none" };

export function HelpPanel(): React.JSX.Element {
  const pathname = usePathname();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  // A pattern the palette asked for; otherwise the current page's.
  const [override, setOverride] = useState<HelpRoute | null>(null);
  const [content, setContent] = useState<Content>({ kind: "loading" });

  const route = override ?? resolveHelpRoute(pathname);

  const show = useCallback((requested: HelpRoute | null): void => {
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement ? active : null;
    setOverride(requested);
    setOpen(true);
  }, []);

  // Open on the `?` key (outside text fields) and on the window event.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      e.preventDefault();
      show(null);
    };
    const onOpen = (e: Event): void => {
      show((e as CustomEvent<OpenHelpDetail>).detail?.route ?? null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_HELP_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_HELP_EVENT, onOpen);
    };
  }, [show]);

  // A navigation drops the palette's request: the panel explains where you are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger.
  useEffect(() => {
    setOverride(null);
  }, [pathname]);

  // Drive the native dialog from state.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Load the entry while open; a stale load never overwrites a newer one.
  useEffect(() => {
    if (!open) return;
    if (route === null) {
      setContent({ kind: "none" });
      return;
    }
    let current = true;
    setContent({ kind: "loading" });
    void (async () => {
      const entry = await loadHelpEntry(route);
      const terms = entry ? await loadGlossaryTerms(entry.terms ?? []) : [];
      if (!current) return;
      setContent(
        entry ? { kind: "ready", entry, terms, tour: offeredTour(entry) } : { kind: "none" },
      );
    })();
    return () => {
      current = false;
    };
  }, [open, route]);

  /** The dialog closed (Esc, the close button, or the backdrop). */
  const onClose = (): void => {
    setOpen(false);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) target.focus();
  };

  /**
   * Close the panel and start the tour. Focus goes back to whatever opened the
   * panel first, so the tour returns it there when it ends; the dialog's own
   * `close` event arrives later and must not take focus from the tour card.
   */
  const takeTour = (tour: TourDefinition): void => {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    dialogRef.current?.close();
    if (target?.isConnected) target.focus();
    startTour(tour);
  };

  const title = content.kind === "ready" ? content.entry.title : "Help";

  return (
    // A click on the backdrop lands on the <dialog> itself; the body is a
    // child, so clicks inside it never close the panel. Esc is native. A
    // "See also" link navigates away, so following one closes the panel too.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the dialog handles Esc natively.
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        const target = e.target;
        const onLink = target instanceof Element && target.closest("a") !== null;
        if (target === e.currentTarget || onLink) dialogRef.current?.close();
      }}
      className="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85vh] w-full max-w-none rounded-t-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/40 sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:max-h-none sm:w-96 sm:rounded-none sm:border-y-0 sm:border-r-0 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50"
    >
      {open && (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-3 border-zinc-200 border-b px-5 py-4 dark:border-zinc-800">
            <h2 id={titleId} className="font-semibold text-lg tracking-tight">
              {title}
            </h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Close help"
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 ring-1 ring-zinc-200 ring-inset hover:text-zinc-700 dark:ring-zinc-700 dark:hover:text-zinc-200"
            >
              Esc
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4" aria-busy={content.kind === "loading"}>
            {content.kind === "ready" && content.tour && (
              <TakeTour tour={content.tour} onTake={takeTour} />
            )}
            {content.kind === "ready" && (
              <HelpContent entry={content.entry} terms={content.terms} />
            )}
            {content.kind === "loading" && <p className="text-sm text-zinc-400">Loading…</p>}
            {content.kind === "none" && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No help for this page yet.</p>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

/** The entry's tour, if enough of its anchors are on the page to be worth taking. */
function offeredTour(entry: HelpEntry): TourDefinition | null {
  const tour = entry.tour;
  return tour && runnableSteps(tour.steps, isAnchorVisible).length > 0 ? tour : null;
}

interface TakeTourProps {
  readonly tour: TourDefinition;
  readonly onTake: (tour: TourDefinition) => void;
}

function TakeTour({ tour, onTake }: TakeTourProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onTake(tour)}
      className="mb-4 w-full rounded-md bg-zinc-900 px-3 py-2 font-medium text-sm text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
    >
      Take the tour
    </button>
  );
}
