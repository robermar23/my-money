"use client";

import { START_TOUR_EVENT, TOUR_HASH, startTour } from "@/lib/help/events.ts";
import { loadHelpEntry } from "@/lib/help/load.ts";
import { resolveHelpRoute } from "@/lib/help/resolve.ts";
import { runnableSteps } from "@/lib/help/tour-plan.ts";
import { hasSeen, markDismissed } from "@/lib/help/tour-state.ts";
import type { TourDefinition } from "@/lib/help/types.ts";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { isAnchorVisible } from "./tour-dom.ts";

/**
 * The first-visit offer (ADR-060 §4, PLAN20 P20-16).
 *
 * On a page whose tour this device has not seen, a small chip under the right
 * end of the header, beneath the `?` button, says "New here? Take a 30-second
 * tour". It **offers**; it never starts anything. Taking the tour or dismissing
 * the chip records the tour as seen on this device (P20-15), and it does not
 * come back until the tour's `version` is bumped.
 *
 * The page's help entry is loaded lazily, as the panel does, after the page has
 * painted, so the chip can check the tour's anchors against the real page.
 *
 * **A link can ask for the tour** (PLAN20 P20-30): arriving with `#tour` in the
 * URL, as the getting-started checklist's "Take the tour" links do, starts the
 * page's tour instead of offering it, whether or not it was seen before. The
 * click on that link is the click a tour waits for. The fragment is removed so
 * a reload does not start it again.
 */

/** How long a `#tour` arrival waits for a streamed page to show its anchors. */
const ASKED_TOUR_WAIT_MS = 3_000;
const ASKED_TOUR_POLL_MS = 100;

/** Resolve after the browser has laid out the page that just rendered. */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** The tour to offer on this page, or `null`. */
async function offerFor(pathname: string): Promise<TourDefinition | null> {
  const route = resolveHelpRoute(pathname);
  if (route === null) return null;
  const tour = (await loadHelpEntry(route))?.tour;
  if (!tour || hasSeen(tour)) return null;
  await afterPaint();
  return runnableSteps(tour.steps, isAnchorVisible).length > 0 ? tour : null;
}

/** Whether the page was opened with `#tour`; removes the fragment if so. */
function takeTourRequest(): boolean {
  if (window.location.hash !== TOUR_HASH) return false;
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}`);
  return true;
}

/**
 * Start this page's tour once its anchors are on the page, giving a streamed
 * page a few seconds to arrive. Gives up quietly if they never do.
 */
async function startAskedTour(pathname: string, isCurrent: () => boolean): Promise<void> {
  const route = resolveHelpRoute(pathname);
  const tour = route === null ? undefined : (await loadHelpEntry(route))?.tour;
  if (!tour) return;
  for (let waited = 0; waited <= ASKED_TOUR_WAIT_MS; waited += ASKED_TOUR_POLL_MS) {
    await afterPaint();
    if (!isCurrent()) return;
    if (runnableSteps(tour.steps, isAnchorVisible).length > 0) {
      startTour(tour);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ASKED_TOUR_POLL_MS));
  }
}

export function TourChip(): React.JSX.Element | null {
  const pathname = usePathname();
  const [tour, setTour] = useState<TourDefinition | null>(null);

  useEffect(() => {
    let current = true;
    setTour(null);
    if (takeTourRequest()) {
      void startAskedTour(pathname, () => current);
      return () => {
        current = false;
      };
    }
    void offerFor(pathname).then((offer) => {
      if (current) setTour(offer);
    });
    return () => {
      current = false;
    };
  }, [pathname]);

  // A tour started from the panel answers the offer too.
  useEffect(() => {
    const onStart = (): void => setTour(null);
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart);
  }, []);

  if (tour === null) return null;
  return (
    <div className="absolute top-full right-6 z-10 mt-2 flex items-center rounded-full border border-zinc-300 bg-white text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      <button
        type="button"
        onClick={() => startTour(tour)}
        className="py-1 pr-1 pl-3 text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-zinc-50"
      >
        New here? Take a 30-second tour
      </button>
      <button
        type="button"
        aria-label="Dismiss the tour offer"
        onClick={() => {
          markDismissed(tour);
          setTour(null);
        }}
        className="px-2 py-1 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
