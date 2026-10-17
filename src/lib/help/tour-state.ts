import { readMark, writeMark } from "./local-store.ts";
import { tourStorageKey } from "./tour-plan.ts";

/**
 * Whether this device has seen a tour (ADR-060, PLAN20 P20-15).
 *
 * A per-device convenience in `localStorage`, never needed for correctness.
 * [local-store.ts](./local-store.ts) wraps every read and write, so a missing
 * or throwing storage falls back to memory. The worst case is being offered a
 * tour again, never an error.
 *
 * Nothing here is sent anywhere or read by the server (PLAN20 Hard boundary #2).
 */

/** What a device has done with a tour. */
type TourMark = "seen" | "dismissed";

/** The part of a tour this module reads. */
export interface TourIdentity {
  readonly id: string;
  readonly version: number;
}

/**
 * Whether this version of the tour was taken or its offer dismissed here.
 *
 * @param tour - The tour's id and version.
 * @returns `true` when the first-visit chip should stay away. Never throws.
 */
export function hasSeen(tour: TourIdentity): boolean {
  return readMark(tourStorageKey(tour.id, tour.version)) !== null;
}

/**
 * Record that the tour was started on this device.
 *
 * @param tour - The tour's id and version.
 */
export function markSeen(tour: TourIdentity): void {
  const mark: TourMark = "seen";
  writeMark(tourStorageKey(tour.id, tour.version), mark);
}

/**
 * Record that the first-visit offer was dismissed on this device.
 *
 * @param tour - The tour's id and version.
 */
export function markDismissed(tour: TourIdentity): void {
  const mark: TourMark = "dismissed";
  writeMark(tourStorageKey(tour.id, tour.version), mark);
}
