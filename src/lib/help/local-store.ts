/**
 * Per-device marks in `localStorage` for help (ADR-060).
 *
 * A convenience, never needed for correctness. Every read and write is wrapped
 * in `try/catch`: in a private window, with blocked site data, or during server
 * rendering, storage is missing or throws, and the module falls back to an
 * in-memory record for the rest of the page's life. The worst case is being
 * offered something again, never an error.
 *
 * Every key starts `my-money:help:`. Nothing here is sent anywhere or read by
 * the server (PLAN20 Hard boundary #2).
 */

/** Marks kept when storage fails, so an answered offer does not come straight back. */
const memory = new Map<string, string>();

/** `localStorage`, or `null` where it is missing or access to it throws. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a mark.
 *
 * @param key - A `my-money:help:` key.
 * @returns The stored mark, or `null` when there is none. Never throws.
 */
export function readMark(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

/**
 * Write a mark, keeping an in-memory copy in case storage refuses it.
 *
 * @param key - A `my-money:help:` key.
 * @param mark - What to record.
 */
export function writeMark(key: string, mark: string): void {
  memory.set(key, mark);
  try {
    storage()?.setItem(key, mark);
  } catch {
    // Quota, private mode, blocked storage: the in-memory mark stands in.
  }
}
