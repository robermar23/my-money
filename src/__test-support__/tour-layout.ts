import type { TourAnchor, TourDefinition, TourStep } from "@/lib/help/types.ts";

/*
 * Test-only support for the tour engine (PLAN20 P20-14/16). jsdom does no
 * layout, so every element has an empty box and every anchor would count as
 * hidden. `fakeLayout()` gives each element a fixed box unless it, or an
 * ancestor, carries the `hidden` attribute, which is how the tests stand in for
 * an anchor that is off the page at this width.
 */

/** The box every laid-out element reports. */
export const FAKE_BOX = { top: 100, left: 100, width: 200, height: 40 } as const;

/**
 * Give elements a layout box until the returned function is called.
 *
 * @returns A function that restores jsdom's own methods.
 */
export function fakeLayout(): () => void {
  const proto = Element.prototype;
  const rects = proto.getClientRects;
  const box = proto.getBoundingClientRect;
  const scroll = proto.scrollIntoView;
  const laidOut = (el: Element): boolean => el.closest("[hidden]") === null;

  proto.getClientRects = function getClientRects(this: Element) {
    return (laidOut(this) ? [FAKE_BOX] : []) as unknown as DOMRectList;
  };
  proto.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    const b = laidOut(this) ? FAKE_BOX : { top: 0, left: 0, width: 0, height: 0 };
    return {
      ...b,
      x: b.left,
      y: b.top,
      right: b.left + b.width,
      bottom: b.top + b.height,
    } as DOMRect;
  };
  proto.scrollIntoView = function scrollIntoView() {};

  return () => {
    proto.getClientRects = rects;
    proto.getBoundingClientRect = box;
    proto.scrollIntoView = scroll;
  };
}

/**
 * Put an element carrying an anchor on the page.
 *
 * @param anchor - The `data-tour` value.
 * @param hidden - Whether it is off the page at this width.
 * @returns The element, already in `document.body`.
 */
export function addAnchor(anchor: string, hidden = false): HTMLElement {
  const el = document.createElement("section");
  el.setAttribute("data-tour", anchor);
  el.textContent = anchor;
  if (hidden) el.setAttribute("hidden", "");
  document.body.append(el);
  return el;
}

/**
 * A tour over fixture anchors. They are not real page anchors, so they are
 * not in `TOUR_ANCHORS` and the fixtures cast.
 *
 * @param id - The tour's id.
 * @param anchors - One step per anchor, in order.
 * @returns The tour, version 1.
 */
export function fixtureTour(id: string, anchors: readonly string[]): TourDefinition {
  const steps: TourStep[] = anchors.map((anchor) => ({
    anchor: anchor as TourAnchor,
    title: `About ${anchor}`,
    body: `What ${anchor} shows.`,
  }));
  return { id, version: 1, steps };
}
