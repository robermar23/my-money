/**
 * Finding a tour's anchors on the page (PLAN20 P20-14).
 *
 * The only place that knows a step's anchor is a `data-tour` attribute. The
 * attribute name is kept in a constant, never written out with a value here, so
 * the anchor guard's scan of the source (P20-17) sees only real page anchors.
 */

/** The attribute a page puts on an element a tour can highlight. */
export const TOUR_ATTRIBUTE = "data-tour";

/**
 * The element carrying an anchor, if the page has one.
 *
 * @param anchor - A `data-tour` value.
 * @returns The first matching element, or `null`.
 */
export function findAnchor(anchor: string): HTMLElement | null {
  // Anchors are kebab-case literals (the anchor guard checks), so no escaping.
  return document.querySelector<HTMLElement>(`[${TOUR_ATTRIBUTE}="${anchor}"]`);
}

/**
 * Whether an anchor is on the page and takes up space.
 *
 * An element under `display: none` (a strip hidden below `sm:`, the `hidden`
 * attribute) or inside a closed `<details>` has no layout box, so its step is
 * skipped rather than spotlighting nothing.
 *
 * @param anchor - A `data-tour` value.
 * @returns `true` when the element exists and has a non-empty box.
 */
export function isAnchorVisible(anchor: string): boolean {
  const el = findAnchor(anchor);
  if (el === null || el.getClientRects().length === 0) return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 || box.height > 0;
}

/**
 * Whether the reader asked the system for less motion.
 *
 * @returns `true` under `prefers-reduced-motion: reduce`; `false` where the
 *   query is unsupported.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Whether the viewport is at least Tailwind's `sm:` width (640px).
 *
 * @returns `true` from `sm:` up; below it the step card docks to the bottom.
 */
export function isSmallUp(): boolean {
  return window.matchMedia?.("(min-width: 640px)").matches ?? true;
}
