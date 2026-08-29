import { normalizePayee } from "@/lib/importers/normalize.ts";

/**
 * payeeKey: the normalization that decides "same series" (P16-08, ADR-036 §4).
 *
 * Recurring detection groups transactions by `(accountId, payeeKey)`, so this
 * function is the thing that decides whether twelve mortgage payments are one
 * obligation or twelve unrelated charges. It is also, eventually, the value
 * stored in `scheduled_obligations.detection_key` — the column whose partial
 * UNIQUE index guarantees a confirmed series is never re-proposed.
 *
 * ── ONE notion of "the same merchant" ──────────────────────────────────────
 * This is `normalizePayee` — the SAME function the categorization rule engine
 * uses via [rule-from-payee.ts](../categorization/rule-from-payee.ts) — with the
 * result lowercased. It is deliberately not a second normalizer.
 *
 * `toLowerCase` on an already-uppercased string is a bijection, so the
 * equivalence classes here are IDENTICAL to `normalizePayee`'s, not merely
 * similar: two descriptions group together for detection if and only if they
 * group together for categorization. There is a test asserting exactly that
 * over every pair of real payee strings, and it is the test to keep if this
 * file is ever refactored. A "same merchant" answer that differs between the
 * two subsystems is how a user ends up with a category rule that fires on
 * charges their obligation never matches.
 *
 * The lowercase is cosmetic and load-bearing in only one place: this value is
 * persisted, compared, and shown in candidate review, and a screaming-caps key
 * reads as a bug in the UI.
 *
 * What `normalizePayee` already handles, and why nothing is added on top:
 *   - dates (`SENT ON 06/09`), store numbers, account and reference ids — every
 *     standalone digit run is dropped;
 *   - punctuation and processor separators (`CASH APP*JAMIE`) become word breaks;
 *   - whitespace runs collapse; case is folded.
 *
 * ── What this deliberately does NOT do ─────────────────────────────────────
 * No processor-prefix stripping (`PAYPAL *`, `SQ *`, `TST*`). It is tempting —
 * it would pull the underlying merchant out — but it would fork the "same
 * merchant" notion this file exists to keep singular, and it is not obviously
 * right even on its own terms: a subscription billed through PayPal and the
 * same merchant billed directly are different payment rails that can start and
 * stop independently.
 *
 * No alphanumeric-token stripping either (`AMAZON MKTPL*RT4XY9`), which would
 * catch per-charge reference codes but would also eat `3M`, `7ELEVEN`, and
 * `P2P`.
 *
 * Both omissions cost the same thing: a candidate that is not proposed, which
 * the user fixes by adding the obligation by hand (P16-25). The opposite error
 * — merging two distinct series — puts a wrong cadence and a wrong amount on a
 * CONFIRMED obligation, where it silently moves the projected balance a family
 * makes a spending decision on. The asymmetry is the whole argument.
 *
 * Pure and I/O-free. The strings passed in name real vendors and, in the P2P
 * cases, real people; like every other figure in this app they stay on the box
 * and are never logged (CLAUDE.md §Privacy).
 *
 * @param name - The raw transaction description, as stored in `transactions.name`.
 * @returns A stable lowercase grouping key. Falls back to the trimmed input when
 *   normalization would empty it (an all-digits description), so unrelated rows
 *   never collapse into one bogus series under an empty key.
 */
export function payeeKey(name: string): string {
  return normalizePayee(name).toLowerCase();
}
