import type { AccountSubtype } from "@/db/schema/accounts.ts";
import { Money } from "@/lib/money/money.ts";
import { coverageMultiple, shareOf } from "./statistics.ts";

/**
 * Cash tiering — "how much on hand vs. how much in medium-term savings like
 * CD's" (Phase 15, PLAN15 P15-10, ADR-033 §1).
 *
 * This is the question Round 9 asked that the app was **structurally** unable to
 * answer before Batch 1: every cash account is `type='depository'`, so checking,
 * savings, money-market and a CD were indistinguishable. `accounts.subtype` is
 * the column that makes the question answerable at all, and this module is the
 * mapping from that column to the three tiers a household benchmark talks about.
 *
 * ── The mapping (ADR-033 §1) ───────────────────────────────────────────────
 *   `checking`, `cash_management` → **operating** — the money that pays this
 *       month's bills. Sized in weeks, not months.
 *   `savings`, `money_market`     → **reserve** — the emergency fund. Liquid,
 *       same-day, no penalty. This is what the 3–6 month target is measured
 *       against (P15-15).
 *   `cd`                          → **medium_term** — committed, penalty to
 *       break, maturity-dated. Where the excess above the reserve belongs, and
 *       what the ladder rule (P15-20) structures.
 *   `NULL`                        → **unclassified** — NEVER guessed as
 *       checking. An un-triaged account reports as unclassified so the engine
 *       degrades honestly (ADR-032 consequence 1) instead of confidently
 *       telling the user their emergency fund is fine because a CD got counted
 *       as a savings account.
 *
 * ── Deviations from the plan's sketched signature, and why ─────────────────
 * PLAN15 sketches `classifyCashTiers(accounts, latestBalances, essentialMonthly,
 * profile)`. Two changes:
 *   - **Balances travel with their account** rather than as a parallel array.
 *     Two positionally-aligned lists of money is a footgun; one misordering
 *     silently attributes a CD balance to a checking account and every tier is
 *     wrong with no error anywhere.
 *   - **`profile` is not a parameter**, because nothing in *classification*
 *     reads it. `reserve_months_override` sizes the emergency-fund TARGET, which
 *     is the emergency-fund rule's job (P15-15); tiering only says where the
 *     money currently sits. An unused parameter would imply this function has an
 *     opinion about the target, and it deliberately does not.
 *
 * Pure and I/O-free (ADR-032 §1) — the caller supplies the accounts.
 * Money discipline (CLAUDE.md §Money): every total goes through {@link Money};
 * the two `number`s returned are ratios, not money.
 */

const CURRENCY = "USD";

/** The three tiers a household cash benchmark talks about, plus the unknown. */
export type CashTier = "operating" | "reserve" | "medium_term" | "unclassified";

/** A cash account with its current balance, as the loader assembles it. */
export interface CashAccountInput {
  readonly accountId: string;
  readonly name: string;
  readonly institution: string;
  /** `NULL` = un-triaged. Never defaulted (ADR-033 §1). */
  readonly subtype: AccountSubtype | null;
  /** Latest `account_snapshots` balance, as a money string. */
  readonly balance: string;
  /** Annual percentage yield as a PERCENTAGE ("4.5000" = 4.5%). `null` = unknown. */
  readonly apy: string | null;
  /** CD maturity; only meaningful when `subtype='cd'`. */
  readonly maturityDate: string | null;
  /** Date of the balance snapshot, so the UI can show a stale balance as stale. */
  readonly balanceAsOf: string | null;
}

/** One tier's rollup. */
export interface CashTierRollup {
  readonly tier: CashTier;
  readonly total: string;
  readonly accounts: readonly CashAccountInput[];
  /**
   * How many months of essential expenses this tier covers, as a string
   * ("3.20"). `null` when the essential baseline is unknown or zero — "we cannot
   * say" must not render as "0 months of runway" (reads as an emergency) or as
   * infinity (reads as solved).
   */
  readonly monthsCovered: string | null;
}

export interface CashTiers {
  readonly operating: CashTierRollup;
  readonly reserve: CashTierRollup;
  readonly mediumTerm: CashTierRollup;
  readonly unclassified: CashTierRollup;
  /** Every tier summed. */
  readonly total: string;
  /**
   * `operating + reserve` — the money genuinely available same-day. Excludes
   * CDs (breaking one costs a penalty) and excludes unclassified (we do not know
   * what it is, and counting it would overstate liquidity).
   */
  readonly liquid: string;
  /** Months of essential expenses covered by {@link liquid}. */
  readonly liquidMonthsCovered: string | null;
  /** `unclassified / total` in [0, 1]. A high share means every tier is suspect. */
  readonly unclassifiedShare: number;
  /** The essential monthly figure the coverage multiples were measured against. */
  readonly essentialMonthly: string | null;
}

/**
 * Map a cash-account subtype to its tier.
 *
 * @param subtype - The account's subtype, or `null` when un-triaged.
 * @returns The tier, or `'unclassified'` for `null` — never a guess.
 */
export function tierForSubtype(subtype: AccountSubtype | null): CashTier {
  switch (subtype) {
    case "checking":
    case "cash_management":
      return "operating";
    case "savings":
    case "money_market":
      return "reserve";
    case "cd":
      return "medium_term";
    default:
      return "unclassified";
  }
}

/**
 * Classify cash accounts into operating / reserve / medium-term tiers (P15-10).
 *
 * @param input.accounts - The household's cash accounts with current balances.
 *   The caller (P15-12) filters to `type='depository'`; a credit card is not
 *   cash and an investment account is not a cash tier.
 * @param input.essentialMonthly - The essential monthly baseline from
 *   {@link ../advice/essential-expenses.ts essentialMonthlyBaseline}, or `null`
 *   when unknown. Drives every `monthsCovered` figure and nothing else.
 * @returns Per-tier totals, member accounts, coverage in months, and the
 *   unclassified share.
 */
export function classifyCashTiers(input: {
  readonly accounts: readonly CashAccountInput[];
  readonly essentialMonthly: string | null;
}): CashTiers {
  const buckets: Record<CashTier, CashAccountInput[]> = {
    operating: [],
    reserve: [],
    medium_term: [],
    unclassified: [],
  };

  for (const account of input.accounts) {
    buckets[tierForSubtype(account.subtype)].push(account);
  }

  const rollup = (tier: CashTier): CashTierRollup => {
    const accounts = buckets[tier];
    const total = Money.sum(
      accounts.map((a) => Money.fromString(a.balance, CURRENCY)),
      CURRENCY,
    ).toString();
    return {
      tier,
      total,
      accounts,
      monthsCovered: coverageMultiple(total, input.essentialMonthly),
    };
  };

  const operating = rollup("operating");
  const reserve = rollup("reserve");
  const mediumTerm = rollup("medium_term");
  const unclassified = rollup("unclassified");

  const total = Money.sum(
    [operating, reserve, mediumTerm, unclassified].map((r) => Money.fromString(r.total, CURRENCY)),
    CURRENCY,
  ).toString();
  const liquid = Money.fromString(operating.total, CURRENCY)
    .add(Money.fromString(reserve.total, CURRENCY))
    .toString();

  return {
    operating,
    reserve,
    mediumTerm,
    unclassified,
    total,
    liquid,
    liquidMonthsCovered: coverageMultiple(liquid, input.essentialMonthly),
    unclassifiedShare: shareOf(unclassified.total, total),
    essentialMonthly: input.essentialMonthly,
  };
}
