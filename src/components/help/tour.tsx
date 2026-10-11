"use client";

import { START_TOUR_EVENT, type StartTourDetail, isTypingTarget } from "@/lib/help/events.ts";
import { type Box, type Placement, placeCard } from "@/lib/help/tour-place.ts";
import { runnableSteps } from "@/lib/help/tour-plan.ts";
import { markSeen } from "@/lib/help/tour-state.ts";
import type { TourDefinition, TourStep } from "@/lib/help/types.ts";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { findAnchor, isAnchorVisible, isSmallUp, prefersReducedMotion } from "./tour-dom.ts";

/**
 * The tour engine (PLAN20 P20-14, ADR-059 §4: hand-rolled, no library).
 *
 * Mounted once from the server `AppNav`, beside the help panel, and started by
 * {@link START_TOUR_EVENT} from the panel's "Take the tour" or the first-visit
 * chip. It never starts on its own (ADR-060 §4).
 *
 * Each step dims the page with an SVG mask that cuts a hole around the anchor,
 * scrolls the anchor into view, and shows a card beside it: placed by
 * {@link placeCard} from `sm:` up, docked to the bottom of the screen below
 * that. The card takes focus on every step, keeps `Tab` inside itself, and
 * hands focus back to whatever started the tour. `Esc` ends the tour; the arrow
 * keys step through it. A navigation ends it too, since its anchors are gone.
 */

/** The running tour; `null` when none is. */
interface Run {
  readonly steps: readonly TourStep[];
  readonly index: number;
}

/** Space between the anchor and the edge of the spotlight's hole. */
const SPOTLIGHT_PAD = 6;

/** The anchor's box now, or `null` when it has left the page. */
function measure(step: TourStep): Box | null {
  const rect = findAnchor(step.anchor)?.getBoundingClientRect();
  return rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null;
}

/** The buttons `Tab` cycles through inside the card. */
function focusables(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>("button:not([disabled])")];
}

export function TourRunner(): React.JSX.Element | null {
  const pathname = usePathname();
  const [run, setRun] = useState<Run | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const end = useCallback((): void => {
    setRun(null);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    // The first-visit chip is gone by now; the `?` button is the next best place.
    const fallback = document.querySelector<HTMLElement>("[data-help-button]");
    const into = target?.isConnected ? target : fallback;
    if (into && into.getClientRects().length > 0) into.focus();
  }, []);

  // Start on the window event, with the steps this page can show right now.
  useEffect(() => {
    const onStart = (e: Event): void => {
      const tour: TourDefinition | undefined = (e as CustomEvent<StartTourDetail>).detail?.tour;
      if (!tour) return;
      const steps = runnableSteps(tour.steps, isAnchorVisible);
      if (steps.length === 0) return;
      markSeen(tour);
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement ? active : null;
      setRun({ steps, index: 0 });
    };
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart);
  }, []);

  // Leaving the page ends the tour: its anchors went with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger.
  useEffect(() => {
    setRun(null);
  }, [pathname]);

  if (run === null) return null;
  return createPortal(
    <TourStepView run={run} onStep={(index) => setRun({ ...run, index })} onEnd={end} />,
    document.body,
  );
}

interface StepViewProps {
  readonly run: Run;
  readonly onStep: (index: number) => void;
  readonly onEnd: () => void;
}

function TourStepView({ run, onStep, onEnd }: StepViewProps): React.JSX.Element {
  const { steps, index } = run;
  const step = steps[index] as TourStep;
  const last = index === steps.length - 1;
  const titleId = useId();
  const maskId = `tour-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const cardRef = useRef<HTMLDialogElement>(null);
  const [box, setBox] = useState<Box | null>(() => measure(step));
  const [docked, setDocked] = useState<boolean>(() => !isSmallUp());
  const [placement, setPlacement] = useState<Placement | null>(null);

  const back = useCallback(() => index > 0 && onStep(index - 1), [index, onStep]);
  const next = useCallback(
    () => (index < steps.length - 1 ? onStep(index + 1) : onEnd()),
    [index, steps.length, onStep, onEnd],
  );

  // Bring the anchor into view and the card into focus, once per step.
  useEffect(() => {
    findAnchor(step.anchor)?.scrollIntoView?.({
      block: "center",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    setBox(measure(step));
    cardRef.current?.focus({ preventScroll: true });
  }, [step]);

  // Follow the anchor through scrolling and resizing, at most once a frame.
  useEffect(() => {
    const controller = new AbortController();
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setBox(measure(step));
        setDocked(!isSmallUp());
      });
    };
    const opts = { passive: true, signal: controller.signal } as const;
    window.addEventListener("resize", schedule, opts);
    // Capture, so scrolling inside a panel or table moves the spotlight too.
    window.addEventListener("scroll", schedule, { ...opts, capture: true });
    return () => {
      controller.abort();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [step]);

  // Esc and the arrow keys, wherever focus is.
  useEffect(() => {
    const controller = new AbortController();
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return;
      const action =
        e.key === "Escape"
          ? onEnd
          : e.key === "ArrowRight"
            ? next
            : e.key === "ArrowLeft"
              ? back
              : null;
      if (action === null) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown, { signal: controller.signal });
    return () => controller.abort();
  }, [onEnd, next, back]);

  // Place the card once its size is known; below `sm:` it docks instead.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (docked || card === null) return;
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const anchor = box ?? {
      top: viewport.height / 2,
      left: viewport.width / 2,
      width: 0,
      height: 0,
    };
    setPlacement(placeCard(anchor, size, viewport, step.placement));
  }, [box, docked, step]);

  /** Keep `Tab` inside the card while the page behind it is dimmed. */
  const onCardKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>): void => {
    if (e.key !== "Tab" || cardRef.current === null) return;
    const items = focusables(cardRef.current);
    const first = items[0];
    const lastItem = items[items.length - 1];
    if (!first || !lastItem) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === cardRef.current)) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && active === lastItem) {
      e.preventDefault();
      first.focus();
    }
  };

  const hole = box && {
    x: box.left - SPOTLIGHT_PAD,
    y: box.top - SPOTLIGHT_PAD,
    width: box.width + SPOTLIGHT_PAD * 2,
    height: box.height + SPOTLIGHT_PAD * 2,
  };
  const position: React.CSSProperties = docked
    ? {}
    : placement
      ? { top: placement.top, left: placement.left }
      : { top: 0, left: 0, visibility: "hidden" };

  return (
    <>
      {/* The dimmed page, with a hole over the anchor. It swallows clicks. */}
      <svg aria-hidden="true" className="fixed inset-0 z-50 h-full w-full">
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {hole && <rect {...hole} rx={8} fill="black" />}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgb(0 0 0 / 0.5)" mask={`url(#${maskId})`} />
      </svg>
      {hole && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 rounded-lg ring-2 ring-white"
          style={{ top: hole.y, left: hole.x, width: hole.width, height: hole.height }}
        />
      )}

      {/* Non-modal `open`: the overlay above already blocks the page, and
          `showModal()` would lift the card into the top layer over the spotlight. */}
      <dialog
        ref={cardRef}
        open
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onCardKeyDown}
        style={position}
        className={`fixed z-50 m-0 border-zinc-200 bg-white p-4 text-zinc-900 shadow-2xl outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50 ${
          docked
            ? "inset-x-0 top-auto bottom-0 w-full max-w-none rounded-t-xl border-t"
            : "right-auto bottom-auto w-80 rounded-lg border"
        }`}
      >
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {index + 1} of {steps.length}
        </p>
        <h2 id={titleId} className="mt-1 font-semibold">
          {step.title}
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{step.body}</p>
        <div className="mt-4 flex items-center justify-between gap-2 text-sm">
          <button
            type="button"
            onClick={onEnd}
            className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
          >
            Skip tour
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={back}
              disabled={index === 0}
              className="rounded-md border border-zinc-300 px-3 py-1 disabled:opacity-40 dark:border-zinc-700"
            >
              Back
            </button>
            <button
              type="button"
              onClick={next}
              className="rounded-md bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-50 dark:text-zinc-900"
            >
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </dialog>

      {/* Each step's words, for screen readers, as the step changes. */}
      <div aria-live="polite" className="sr-only">
        {`Step ${index + 1} of ${steps.length}: ${step.title}. ${step.body}`}
      </div>
    </>
  );
}
