/**
 * Where a tour's step card sits beside its anchor (PLAN20 P20-14).
 *
 * Pure geometry in viewport coordinates, so the flipping rules are tested
 * without a browser. The card takes the side the step asks for; when that side
 * has no room it flips to the opposite one, then tries the remaining two, and
 * as a last resort sits below the anchor. It is then slid along that side so it
 * never leaves the viewport.
 */

/** A side of the anchor. */
export type Side = "top" | "bottom" | "left" | "right";

/** A rectangle in viewport pixels, as `getBoundingClientRect()` gives it. */
export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** A width and height in pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Where the card goes. */
export interface Placement {
  readonly top: number;
  readonly left: number;
  readonly side: Side;
}

/** Space between the anchor and the card. */
export const CARD_GAP = 12;
/** The least space kept between the card and the viewport edge. */
export const VIEWPORT_MARGIN = 8;

const OPPOSITE: Readonly<Record<Side, Side>> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/** The order sides are tried in, starting from the preferred one. */
function sidesToTry(preferred: Side): readonly Side[] {
  const first = [preferred, OPPOSITE[preferred]];
  const rest = (["bottom", "top", "right", "left"] as const).filter((s) => !first.includes(s));
  return [...first, ...rest];
}

/** Whether the card fits on `side` without crossing the viewport margin. */
function fits(side: Side, anchor: Box, card: Size, viewport: Size): boolean {
  const need = (side === "top" || side === "bottom" ? card.height : card.width) + CARD_GAP;
  switch (side) {
    case "top":
      return anchor.top - need >= VIEWPORT_MARGIN;
    case "bottom":
      return anchor.top + anchor.height + need <= viewport.height - VIEWPORT_MARGIN;
    case "left":
      return anchor.left - need >= VIEWPORT_MARGIN;
    case "right":
      return anchor.left + anchor.width + need <= viewport.width - VIEWPORT_MARGIN;
  }
}

/** Keep `value` within `[min, max]`; when the range is empty, `min` wins. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Place the step card beside its anchor.
 *
 * @param anchor - The anchor's box.
 * @param card - The card's measured size.
 * @param viewport - The viewport's size.
 * @param preferred - The side the step asks for. Defaults to `bottom`.
 * @returns The card's top-left corner and the side it ended up on.
 */
export function placeCard(
  anchor: Box,
  card: Size,
  viewport: Size,
  preferred: Side = "bottom",
): Placement {
  const side = sidesToTry(preferred).find((s) => fits(s, anchor, card, viewport)) ?? "bottom";
  const maxTop = viewport.height - card.height - VIEWPORT_MARGIN;
  const maxLeft = viewport.width - card.width - VIEWPORT_MARGIN;

  if (side === "top" || side === "bottom") {
    const top =
      side === "top" ? anchor.top - CARD_GAP - card.height : anchor.top + anchor.height + CARD_GAP;
    const centred = anchor.left + anchor.width / 2 - card.width / 2;
    return {
      side,
      top: clamp(top, VIEWPORT_MARGIN, maxTop),
      left: clamp(centred, VIEWPORT_MARGIN, maxLeft),
    };
  }
  const left =
    side === "left" ? anchor.left - CARD_GAP - card.width : anchor.left + anchor.width + CARD_GAP;
  const centred = anchor.top + anchor.height / 2 - card.height / 2;
  return {
    side,
    top: clamp(centred, VIEWPORT_MARGIN, maxTop),
    left: clamp(left, VIEWPORT_MARGIN, maxLeft),
  };
}
