import { tourStorageKey } from "./tour-plan.ts";

/**
 * Whether this device has seen a tour (ADR-060, PLAN20 P20-15).
 *
 * A per-device convenience in `localStorage`, never needed for correctness.
 * Every read and write is wrapped in `try/catch`: in a private window, with
 * blocked site data, or during server rendering, storage is missing or throws,
 * and the module falls back to an in-memory record for the rest of the page's
 * life. The worst case is being offered a tour again, never an error.
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

/** Marks kept when storage fails, so the chip does not come straight back. */
const memory = new Map<string, TourMark>();

/** `localStorage`, or `null` where it is missing or access to it throws. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, mark: TourMark): void {
  memory.set(key, mark);
  try {
    storage()?.setItem(key, mark);
  } catch {
    // Quota, private mode, blocked storage: the in-memory mark stands in.
  }
}

/**
 * Whether this version of the tour was taken or its offer dismissed here.
 *
 * @param tour - The tour's id and version.
 * @returns `true` when the first-visit chip should stay away. Never throws.
 */
export function hasSeen(tour: TourIdentity): boolean {
  return read(tourStorageKey(tour.id, tour.version)) !== null;
}

/**
 * Record that the tour was started on this device.
 *
 * @param tour - The tour's id and version.
 */
export function markSeen(tour: TourIdentity): void {
  write(tourStorageKey(tour.id, tour.version), "seen");
}

/**
 * Record that the first-visit offer was dismissed on this device.
 *
 * @param tour - The tour's id and version.
 */
export function markDismissed(tour: TourIdentity): void {
  write(tourStorageKey(tour.id, tour.version), "dismissed");
}
