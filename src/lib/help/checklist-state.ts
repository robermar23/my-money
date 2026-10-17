import { readMark, writeMark } from "./local-store.ts";

/**
 * Whether this device is finished with the getting-started checklist
 * (PLAN20 P20-30, ADR-060).
 *
 * Dismissing it, or seeing it with every item done, puts it away for good on
 * this device: it never comes back to nag, even if an item later slips. The
 * mark is the only thing stored; the items themselves are always derived.
 */

/** The checklist's one `localStorage` key. */
export const CHECKLIST_KEY = "my-money:help:checklist";

/** Why the checklist went away. */
type ChecklistMark = "dismissed" | "done";

/**
 * Whether the checklist was dismissed or finished on this device.
 *
 * @returns `true` when it should not show. Never throws.
 */
export function isChecklistClosed(): boolean {
  return readMark(CHECKLIST_KEY) !== null;
}

/**
 * Put the checklist away for good on this device.
 *
 * @param why - Dismissed by hand, or seen with every item done.
 */
export function closeChecklist(why: ChecklistMark): void {
  writeMark(CHECKLIST_KEY, why);
}
