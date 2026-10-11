// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CARD_GAP, VIEWPORT_MARGIN, placeCard } from "./tour-place.ts";

/* PLAN20 P20-14 — the card takes the side asked for, flips when it has no room, and stays on screen. */

const VIEWPORT = { width: 1200, height: 800 };
const CARD = { width: 300, height: 150 };

describe("placeCard", () => {
  it("sits on the preferred side, centred on the anchor", () => {
    const anchor = { top: 300, left: 500, width: 200, height: 40 };
    expect(placeCard(anchor, CARD, VIEWPORT, "bottom")).toEqual({
      side: "bottom",
      top: 340 + CARD_GAP,
      left: 450,
    });
    expect(placeCard(anchor, CARD, VIEWPORT, "right")).toEqual({
      side: "right",
      top: 245,
      left: 700 + CARD_GAP,
    });
  });

  it("defaults to below the anchor", () => {
    const anchor = { top: 300, left: 500, width: 200, height: 40 };
    expect(placeCard(anchor, CARD, VIEWPORT).side).toBe("bottom");
  });

  it("flips to the opposite side at a viewport edge", () => {
    const nearBottom = { top: 700, left: 500, width: 200, height: 40 };
    expect(placeCard(nearBottom, CARD, VIEWPORT, "bottom").side).toBe("top");

    const nearTop = { top: 20, left: 500, width: 200, height: 40 };
    expect(placeCard(nearTop, CARD, VIEWPORT, "top").side).toBe("bottom");

    const nearRight = { top: 300, left: 1000, width: 150, height: 40 };
    expect(placeCard(nearRight, CARD, VIEWPORT, "right").side).toBe("left");
  });

  it("tries the other axis when neither the side nor its opposite fits", () => {
    // A tall anchor fills the height: no room above or below, room to the right.
    const tall = { top: 10, left: 100, width: 200, height: 780 };
    expect(placeCard(tall, CARD, VIEWPORT, "top").side).toBe("right");
  });

  it("slides along its side to stay inside the viewport", () => {
    const atLeftEdge = { top: 300, left: 0, width: 40, height: 40 };
    expect(placeCard(atLeftEdge, CARD, VIEWPORT, "bottom").left).toBe(VIEWPORT_MARGIN);

    const atRightEdge = { top: 300, left: 1180, width: 20, height: 40 };
    const placed = placeCard(atRightEdge, CARD, VIEWPORT, "bottom");
    expect(placed.left + CARD.width).toBe(VIEWPORT.width - VIEWPORT_MARGIN);
  });

  it("falls back to below, clamped, when no side has room", () => {
    const fullScreen = { top: 0, left: 0, width: 1200, height: 800 };
    const placed = placeCard(fullScreen, CARD, VIEWPORT, "left");
    expect(placed.side).toBe("bottom");
    expect(placed.top).toBe(VIEWPORT.height - CARD.height - VIEWPORT_MARGIN);
  });
});
