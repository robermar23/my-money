/**
 * Which of a tour's steps can run on the page as it is (PLAN20 P20-13).
 *
 * Pure: the caller supplies a predicate that says whether an anchor is on the
 * page and visible, so this module never touches the DOM and a Vitest file can
 * exercise it without one.
 *
 * A step whose anchor is missing (an empty book, a collapsed section, a strip
 * hidden below `sm:`) is **skipped, not broken**: the tour runs the steps the
 * page can show. When fewer than {@link MIN_TOUR_STEPS} survive, the tour is not
 * offered at all; one highlighted element is not a walkthrough.
 */

/** The fewest runnable steps for a tour to be offered. */
export const MIN_TOUR_STEPS = 2;

/** The part of a tour step this module reads. */
export interface AnchoredStep {
  readonly anchor: string;
}

/**
 * The steps that can run, in the tour's own order.
 *
 * @param steps - The tour's steps, as written.
 * @param isPresent - Whether an anchor is on the page and visible right now.
 * @returns The runnable steps, or an empty list when fewer than
 *   {@link MIN_TOUR_STEPS} survive.
 */
export function runnableSteps<S extends AnchoredStep>(
  steps: readonly S[],
  isPresent: (anchor: string) => boolean,
): readonly S[] {
  const kept = steps.filter((step) => isPresent(step.anchor));
  return kept.length >= MIN_TOUR_STEPS ? kept : [];
}

/**
 * The `localStorage` key for one version of a tour (ADR-060 §1).
 *
 * The version is part of the key, so bumping it offers the tour again on a
 * device that saw the old one.
 *
 * @param id - The tour's id.
 * @param version - The tour's version.
 * @returns For example `my-money:help:tour:cashflow:v2`.
 */
export function tourStorageKey(id: string, version: number): string {
  return `my-money:help:tour:${id}:v${version}`;
}
