import type { InputUsed } from "@/lib/advice/types.ts";
import { Money } from "@/lib/money/money.ts";
import { assetRevaluation } from "./asset-revaluation.ts";
import { classifyFlows } from "./boundary.ts";
import { type AmortizingLiability, debtPrincipalPaid } from "./debt-principal.ts";
import {
  type DiagnosticAccount,
  type DiagnosticInvestmentTxn,
  type HoldingQuantity,
  residualDiagnostics,
} from "./diagnostics.ts";
import { type AttributionEndpoints, withinWindow } from "./endpoints.ts";
import type { FlowTxn } from "./flow-types.ts";
import { investmentReturn } from "./investment-return.ts";
import { type PairingOptions, pairTransfers } from "./pairing.ts";
import { payrollDirectContributions } from "./retirement.ts";
import { savedFromFlows } from "./saved.ts";
import { attributionStatus } from "./status.ts";
import type { AttributionResult, AttributionRung, AttributionRungId } from "./types.ts";

/**
 * The decomposition assembler (P17-11, ADR-041) — the phase's centrepiece.
 *
 * Pure and I/O-free. One loader (P17-19) does every read; this function turns
 * those rows into the six-rung answer:
 *
 *     closing − opening
 *       = saved + retirement + debtPrincipal + investmentReturn
 *       + assetRevaluation + unexplained
 *
 * ── `unexplained` is computed last, and never by adjusting a rung ──────────
 * ADR-041 §6. Each of the five explained rungs is an *independent* estimate
 * from its own source — transactions, an amortization schedule, holdings
 * valuations — and none of them is derived from the endpoints they are trying
 * to explain. `unexplained` is `delta − Σ(the five)` and takes whatever sign
 * and size falls out.
 *
 * That is the whole design, and it is the reason the residual means anything.
 * The tempting alternative — deriving `saved` from `Δcash + Δcredit +
 * contributions + principal` — reconciles to exactly zero by construction, and
 * a decomposition that can never disagree with itself can never tell the
 * household that its categorization is wrong. The residual is the trust signal;
 * a rung "corrected" to shrink it would be the one change that destroys the
 * feature while making every screenshot look better.
 *
 * ── Rung order is a narrative, not a sort ──────────────────────────────────
 * {@link ATTRIBUTION_RUNG_IDS} order, always, with all six rungs always
 * present: what you did (saved, contributed, paid down) → what happened to you
 * (markets, valuations) → what the app could not see. A rung is never dropped
 * for being zero, because "we checked and it was nothing" and "we did not look"
 * are different statements and the household deserves to tell them apart.
 *
 * ── The status qualifies the arithmetic; it does not replace it ────────────
 * `no_snapshots` and `insufficient_history` are returned alongside a fully
 * computed result rather than instead of one. Zeroing the numbers here would
 * make this function's output depend on the ladder as well as on its inputs,
 * and would put a *second* untested code path behind the same return type. The
 * suppression belongs at the presentation boundary (P17-22), which is where the
 * decision "do not show a fabricated gain" can be made once and seen.
 *
 * ── Money discipline (CLAUDE.md §Money) ────────────────────────────────────
 * Every figure is a `numeric` string combined only through {@link Money}. There
 * is no `Number()` in this file and no arithmetic operator applied to money.
 * The identity reconciles to the cent by construction, and
 * [decompose.invariant.test.ts](./decompose.invariant.test.ts) pins that as an
 * exact string comparison rather than a tolerance.
 */

const CURRENCY = "USD";

/** Rung labels as rendered. One place, so the chart and the table cannot drift. */
const RUNG_LABELS: Readonly<Record<AttributionRungId, string>> = {
  saved: "Saved from income",
  retirement: "Retirement contributions",
  debt_principal: "Loan principal paid",
  investment_return: "Investment return",
  asset_revaluation: "Property & asset revaluation",
  // Not "unexplained" as a user-facing word: the household did not fail at
  // anything. This names a limit of the app's visibility, and the diagnostics
  // beside it say what to do about it (ADR-039 §4).
  unexplained: "Not yet explained",
};

/**
 * Everything the six rungs and the diagnostics need, and nothing else.
 *
 * ── Why this is not a superset of `DiagnosticsInput` ───────────────────────
 * Batch 4 recorded a coupling expectation that this shape would simply extend
 * {@link DiagnosticsInput}. It does not, for two reasons that are structural
 * rather than stylistic, and the constructed hand-off below is type-checked in
 * full so nothing is lost by it:
 *
 *   1. `DiagnosticsInput.saved` is a {@link SavedResult} — a *computed* figure.
 *      Requiring it here would push `savedFromFlows` out into the loader, which
 *      is exactly the "loader is smart, rules are pure" split (ADR-032 §1)
 *      inverted.
 *   2. `DiagnosticsInput.endpoints` is the per-account *map*, while every rung
 *      needs the whole {@link AttributionEndpoints} anchor for `opening`,
 *      `closing` and `delta`. Carrying both would be two fields that can
 *      disagree; carrying the anchor and projecting the map cannot.
 *
 * `from` and `to` are likewise taken from the anchor rather than passed
 * separately, for the same reason: a window that could disagree with its own
 * endpoints is a window that eventually will.
 */
export interface DecomposeInput {
  /** The ADR-039 §1 anchor, from `endpointsFor` over two `computeNetWorth` calls. */
  readonly endpoints: AttributionEndpoints;
  /** Every account seen at either endpoint, with the facts the diagnostics read. */
  readonly accounts: readonly DiagnosticAccount[];
  /**
   * Posted transactions, with `categories.kind` joined by the loader.
   *
   * Rows outside the window are ignored here rather than assumed absent — the
   * pairer needs to see a window's worth of legs together, and a caller that
   * over-reads by a few days must not be able to move `saved`.
   */
  readonly txns: readonly FlowTxn[];
  /** Loans with recorded terms. A loan without one contributes no rung at all. */
  readonly liabilities: readonly AmortizingLiability[];
  /** Investment transactions; feeds the retirement rung, the market rung, and diagnostics. */
  readonly investmentTxns: readonly DiagnosticInvestmentTxn[];
  /** Per-position opening vs. current share counts, for the ADR-039 §2 drift check. */
  readonly holdings: readonly HoldingQuantity[];
  /** The book's earliest snapshot date, or `null`. Drives the degradation ladder. */
  readonly firstSnapshotDate: string | null;
  /** Transfer-pairing tolerances. Defaults to `DEFAULT_PAIRING` (ADR-040 §2). */
  readonly pairing?: PairingOptions;
  /** Currency to compute in. Single-currency app; USD. */
  readonly currency?: string;
}

/**
 * Decompose a window's net-worth change into its six rungs.
 *
 * @param input - The anchor plus the rows every rung reads. Nothing is mutated.
 * @returns The full answer: the anchored endpoints, six rungs in narrative
 *   order each carrying its own audit trail, the named residual contributors,
 *   and the honesty status. An empty book returns every rung at `"0.00"` —
 *   a real state, not an error.
 * @throws If the window runs backwards, via the shared `assertWindow` guard
 *   each rung applies.
 */
export function decomposeNetWorth(input: DecomposeInput): AttributionResult {
  const currency = input.currency ?? CURRENCY;
  const { from, to } = input.endpoints;

  // ── The flow path (ADR-040) ───────────────────────────────────────────────
  const inWindow = input.txns.filter((t) => withinWindow(t.postedAt, from, to));
  const pairing = pairTransfers(inWindow, input.pairing);
  const pairedIds = new Set(pairing.pairs.flatMap((p) => [p.fromId, p.toId]));
  const classified = classifyFlows(inWindow, pairedIds);
  const saved = savedFromFlows(classified, currency);

  // ── The four remaining explained rungs ────────────────────────────────────
  const retirement = payrollDirectContributions(
    // `ContributionTxn.tradeDate` and the performance layer's `FlowTxn.date`
    // are the same column under two names; the projection is here rather than
    // in the loader so both consumers keep reading one array.
    input.investmentTxns.map((t) => ({
      accountId: t.accountId,
      tradeDate: t.date,
      amount: t.amount,
      source: t.source,
    })),
    from,
    to,
    currency,
  );
  const principal = debtPrincipalPaid(input.liabilities, from, to, currency);
  const market = investmentReturn(
    input.endpoints.byAccount,
    input.investmentTxns,
    from,
    to,
    currency,
  );
  const revaluation = assetRevaluation(input.endpoints.byAccount, currency);

  const diagnostics = residualDiagnostics(
    {
      from,
      to,
      accounts: input.accounts,
      endpoints: input.endpoints.byAccount,
      saved,
      unpairedTransferCount: pairing.unpairedIds.length,
      classified,
      investmentTxns: input.investmentTxns,
      holdings: input.holdings,
      pairing: input.pairing,
    },
    currency,
  );

  const status = attributionStatus({ from, to, firstSnapshotDate: input.firstSnapshotDate });

  // The five explained rungs are built ONCE and the identity is closed against
  // the very array that gets emitted. Summing a parallel list of the same five
  // figures would work today and would be one careless edit away from a page
  // whose rungs and whose residual disagree — reconciling perfectly against a
  // total nobody can see.
  const explained: AttributionRung[] = [
    rung("saved", saved.saved, savedInputs(saved)),
    rung("retirement", retirement.contributions, [
      count(
        "Payroll-direct contributions",
        retirement.count,
        "investment_transactions recorded by the contribution job with source='income' (ADR-041 §3)",
      ),
      count(
        "Accounts receiving them",
        retirement.byAccount.length,
        "Retirement accounts with at least one contribution in the window",
      ),
    ]),
    rung("debt_principal", principal.principalPaid, [
      count(
        "Loans with recorded terms",
        principal.byLiability.length,
        "Amortization is exact and needs no transaction — a loan without terms contributes nothing at all",
      ),
      money(
        "Balance owed at the start",
        sumOf(
          principal.byLiability.map((l) => l.openingBalance),
          currency,
        ),
        `Amortization schedule as of ${from}`,
      ),
      money(
        "Balance owed at the end",
        sumOf(
          principal.byLiability.map((l) => l.closingBalance),
          currency,
        ),
        `Amortization schedule as of ${to}`,
      ),
    ]),
    rung("investment_return", market.marketGrowth, [
      count(
        "Market accounts",
        market.byAccount.length,
        "Investment and crypto-IRA accounts valued at both endpoints",
      ),
      money(
        "Money paid in, net of withdrawals",
        market.netFlows,
        "External flows are subtracted before growth is measured (ADR-021); dividends and interest stay inside the return",
      ),
    ]),
    rung("asset_revaluation", revaluation.revaluation, [
      count(
        "Revalued accounts",
        revaluation.byAccount.length,
        "Property and personal-asset accounts, whose balance changes only by revaluation",
      ),
      count(
        "Only present at one endpoint",
        revaluation.asymmetric.length,
        "An asset added or removed mid-window moves this rung by its whole value",
      ),
    ]),
  ];

  // ── The identity, closed last (ADR-041 §6) ────────────────────────────────
  const explainedTotal = Money.sum(
    explained.map((r) => Money.fromString(r.amount, currency)),
    currency,
  );
  const unexplained = Money.fromString(input.endpoints.delta, currency).sub(explainedTotal);

  const rungs: AttributionRung[] = [
    ...explained,
    rung("unexplained", unexplained.toString(), [
      money("Net worth change", input.endpoints.delta, `computeNetWorth at ${from} and ${to}`),
      money(
        "Explained by the five rungs above",
        explainedTotal.toString(),
        "Sum of the rungs above, each measured independently of the endpoints",
      ),
      count(
        "Named causes below",
        diagnostics.length,
        diagnostics.length === 0
          ? "Nothing in the book looks thin"
          : "Each one links to where it can be fixed",
        diagnostics.length > 0,
      ),
    ]),
  ];

  const inputsUsed: InputUsed[] = [
    money("Net worth at the start", input.endpoints.opening, `computeNetWorth as of ${from}`),
    money("Net worth at the end", input.endpoints.closing, `computeNetWorth as of ${to}`),
    count(
      "Accounts counted",
      input.endpoints.byAccount.size,
      "Every account valued at either endpoint",
    ),
    count("Transactions read", inWindow.length, `Posted between ${from} and ${to}`),
  ];
  if (status.missing !== null) inputsUsed.push(status.missing);

  return {
    from,
    to,
    opening: input.endpoints.opening,
    closing: input.endpoints.closing,
    delta: input.endpoints.delta,
    rungs,
    diagnostics,
    status: status.status,
    inputsUsed,
  };
}

// ── Audit-trail helpers (ADR-039 §5) ────────────────────────────────────────

function rung(
  id: AttributionRungId,
  amount: string,
  inputsUsed: readonly InputUsed[],
): AttributionRung {
  return { id, label: RUNG_LABELS[id], amount, inputsUsed };
}

function money(label: string, value: string, source: string): InputUsed {
  return { label, value, kind: "money", source };
}

function count(label: string, value: number, source: string, missing = false): InputUsed {
  return missing
    ? { label, value: String(value), kind: "count", source, missing: true }
    : { label, value: String(value), kind: "count", source };
}

function sumOf(values: readonly string[], currency: string): string {
  return Money.sum(
    values.map((v) => Money.fromString(v, currency)),
    currency,
  ).toString();
}

/**
 * `saved`'s audit trail, which carries the two exclusions as first-class rows.
 *
 * A household reading a `saved` figure it does not recognize almost always has
 * one of these two as the reason, so they are stated beside the number with a
 * fix link rather than left for the diagnostics list to mention further down.
 */
function savedInputs(saved: ReturnType<typeof savedFromFlows>): InputUsed[] {
  const rows: InputUsed[] = [
    money("Income received", saved.inflow, "Transactions categorized as income"),
    money(
      "Money spent",
      saved.outflow,
      "Transactions categorized as an expense, including the FULL amount of a loan payment (ADR-041 §2)",
    ),
  ];

  const uncategorized = saved.uncategorizedCount > 0;
  rows.push({
    label: "Uncategorized transactions",
    value: String(saved.uncategorizedCount),
    kind: "count",
    source: uncategorized
      ? `${saved.uncategorizedVolume} of activity with no category, counted in no rung`
      : "Every transaction in the window has a category",
    ...(uncategorized ? { missing: true, href: "/analysis/review" } : {}),
  });

  const unpaired = !Money.fromString(saved.unpairedTransferVolume, "USD").isZero();
  rows.push({
    label: "Unpaired transfers",
    value: saved.unpairedTransferVolume,
    kind: "money",
    source: unpaired
      ? "Transfer legs with no counterparty in another tracked account — never guessed either way (ADR-040 §3)"
      : "Every transfer found its counterparty",
    ...(unpaired ? { missing: true, href: "/accounts" } : {}),
  });

  return rows;
}
