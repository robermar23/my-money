import "server-only";

import { db } from "@/db/client.ts";
import { categories, categoryGroups } from "@/db/schema/index.ts";
import {
  type BudgetSuggestion,
  type SuggestionBasis,
  suggestBudgets,
} from "@/lib/advice/budget-suggest.ts";
import { BUDGET_MATERIAL_MONTHLY } from "@/lib/advice/constants.ts";
import { isMonthComplete } from "@/lib/advice/rules/shared.ts";
import { spendByMonth } from "@/lib/analytics/spending.ts";
import { Money } from "@/lib/money/money.ts";
import { asc, eq, isNull } from "drizzle-orm";
import { listBudgets, setBudget } from "./queries.ts";

/**
 * Budget suggestions: preview, then confirm (Phase 15, PLAN15 P15-27).
 *
 * ── Preview → confirm is not a UI nicety here ──────────────────────────────
 * This is the importer posture from CLAUDE.md §Importers applied to a different
 * kind of bulk write. A "suggest budgets" button that silently wrote twenty
 * `category_budgets` rows would be indistinguishable, from the user's side, from
 * the app having invented their budget for them — and the next month's
 * over-budget warnings would be measured against targets they never chose. So
 * {@link previewBudgetSuggestions} computes and returns; nothing is written
 * until {@link applyBudgetSuggestions} is called with an explicit list.
 *
 * The apply step deliberately takes `(categoryId, amount)` pairs rather than
 * "apply the preview": the user may have unticked half of them or edited an
 * amount, and re-deriving the list server-side would quietly discard those
 * edits. It writes through the shipped {@link setBudget} upsert and nowhere
 * else — no second write path to `category_budgets` exists or should.
 *
 * ── What the preview declines to offer ─────────────────────────────────────
 *   - **Zero targets.** {@link suggestBudgets} honestly reports a median of
 *     `"0.00"` for a category the household spends in twice a year; a $0 monthly
 *     budget is not a thing to offer a user.
 *   - **Immaterial categories.** Below {@link BUDGET_MATERIAL_MONTHLY} a target
 *     is administrative overhead, and a preview of thirty rows does not get read.
 *   - **Targets identical to the stored one.** Listed as `unchanged` so the user
 *     can see the category was considered, but never selected by default.
 *
 * Money discipline (CLAUDE.md §Money): every amount is a `numeric` string,
 * compared and summed through {@link Money}. Nothing here is fetched or logged.
 */

/** How many trailing months the suggestion is computed over. */
const WINDOW_MONTHS = 12;

/** What applying a suggestion would do to the stored budget. */
export type SuggestionChange = "create" | "update" | "unchanged";

/** One category's suggested target, alongside what is stored today. */
export interface BudgetSuggestionPreview {
  readonly categoryId: string;
  readonly name: string;
  readonly groupName: string | null;
  /** The stored monthly target, or `null` when no budget row exists. */
  readonly current: string | null;
  readonly suggested: string;
  readonly change: SuggestionChange;
  /** Lowest and highest month observed, so the user can sanity-check the target. */
  readonly observedRange: { readonly min: string; readonly max: string };
  readonly basisMonths: number;
  readonly monthsWithSpend: number;
  readonly confidence: BudgetSuggestion["confidence"];
  /** Whether this row should start ticked. `unchanged` rows do not. */
  readonly recommended: boolean;
}

export interface BudgetSuggestionsResult {
  readonly rows: readonly BudgetSuggestionPreview[];
  readonly basis: SuggestionBasis;
  /**
   * Complete months actually behind the targets.
   *
   * Not the window length: the leading run of months from before the history
   * began is dropped, and the in-progress month is excluded. `0` when there was
   * nothing to compute from.
   */
  readonly monthsConsidered: number;
  /** Sum of the suggested targets across the rows that would change. */
  readonly suggestedTotal: string;
  readonly window: { readonly from: string; readonly to: string };
}

export interface PreviewOptions {
  /** Order statistic. Default `'median'` (ADR-034 §3). */
  readonly basis?: SuggestionBasis;
  /** Reference date, `YYYY-MM-DD`. Injected for tests. */
  readonly today?: string;
}

/** First day of the month `monthsBack` whole months before `today`. */
function windowStart(today: string, monthsBack: number): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return new Date(Date.UTC(year, month - 1 - monthsBack, 1)).toISOString().slice(0, 10);
}

/**
 * Compute what applying every suggestion would change, writing nothing (P15-27).
 *
 * @param options - Basis statistic and reference date.
 * @returns The per-category preview, ordered by suggested target, largest first.
 */
export async function previewBudgetSuggestions(
  options: PreviewOptions = {},
): Promise<BudgetSuggestionsResult> {
  const basis = options.basis ?? "median";
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const window = { from: windowStart(today, WINDOW_MONTHS - 1), to: today };

  const [history, budgets, categoryRows] = await Promise.all([
    spendByMonth(window),
    listBudgets(),
    db
      .select({
        id: categories.id,
        name: categories.name,
        kind: categories.kind,
        groupName: categoryGroups.name,
      })
      .from(categories)
      .leftJoin(categoryGroups, eq(categories.groupId, categoryGroups.id))
      .where(isNull(categories.archivedAt))
      .orderBy(asc(categories.name)),
  ]);

  // Complete months only — the in-progress month is a fraction of a month, and
  // a target set from it would be low by however far into the month it is.
  const months = history.filter((month) => isMonthComplete(month.month, today));
  const suggestions = suggestBudgets(months, { basis, months: WINDOW_MONTHS });

  const currentByCategory = new Map(budgets.map((b) => [b.categoryId, b.amount]));
  const categoryById = new Map(categoryRows.map((c) => [c.id, c]));
  const material = Money.fromString(BUDGET_MATERIAL_MONTHLY, "USD");

  const rows: BudgetSuggestionPreview[] = [];
  for (const suggestion of suggestions) {
    const category = categoryById.get(suggestion.categoryId);
    // Income, transfer and archived categories are not budgeted (ADR-018).
    if (category === undefined || category.kind !== "expense") continue;

    const suggested = Money.fromString(suggestion.suggested, "USD");
    // A $0 target is a true median and a useless budget; below the materiality
    // line a target is administrative overhead.
    if (suggested.sub(material).isNegative()) continue;

    const current = currentByCategory.get(suggestion.categoryId) ?? null;
    const change: SuggestionChange =
      current === null
        ? "create"
        : suggested.sub(Money.fromString(current, "USD")).isZero()
          ? "unchanged"
          : "update";

    rows.push({
      categoryId: suggestion.categoryId,
      name: category.name,
      groupName: category.groupName,
      current,
      suggested: suggested.toString(),
      change,
      observedRange: suggestion.observedRange,
      basisMonths: suggestion.basisMonths,
      monthsWithSpend: suggestion.monthsWithSpend,
      confidence: suggestion.confidence,
      recommended: change !== "unchanged",
    });
  }

  return {
    rows,
    basis,
    // Every suggestion shares one window, so any of them reports the basis.
    monthsConsidered: suggestions[0]?.basisMonths ?? 0,
    suggestedTotal: Money.sum(
      rows.filter((r) => r.recommended).map((r) => Money.fromString(r.suggested, "USD")),
      "USD",
    ).toString(),
    window,
  };
}

/**
 * Write the targets the user confirmed (P15-27).
 *
 * Writes through {@link setBudget} one category at a time — the same upsert the
 * inline budget input uses, so there is exactly one code path that can create a
 * `category_budgets` row. Not wrapped in a transaction on purpose: each upsert is
 * independently idempotent, and a partial apply leaves the user with the budgets
 * that did land rather than with nothing.
 *
 * @param targets - The `(categoryId, amount)` pairs the user confirmed, already
 *   Zod-validated by the caller.
 * @returns How many budgets were written.
 */
export async function applyBudgetSuggestions(
  targets: readonly { readonly categoryId: string; readonly amount: string }[],
): Promise<number> {
  for (const target of targets) {
    await setBudget(target.categoryId, target.amount);
  }
  return targets.length;
}
