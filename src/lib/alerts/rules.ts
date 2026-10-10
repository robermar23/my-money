import { createHash } from "node:crypto";
import { Money } from "@/lib/money/money.ts";

/**
 * Deterministic anomaly rules (Phase 6, ADR-015).
 *
 * Each rule is a PURE function over already-fetched rows + thresholds, returning
 * `DetectedAlert[]`. No DB access, no clock-reading (the clock is passed in) —
 * so they're trivially testable and re-runnable. The detection job (P6-13) wires
 * them to Postgres and persists results.
 *
 * Money comparisons go through `Money`/Decimal — never `Number()` (CLAUDE.md
 * §Money). Titles carry NO raw amounts (those live in `detail`, shown only in the
 * authenticated UI); see ADR-015.
 */

export type AlertType =
  | "large_transaction"
  | "balance_drop"
  | "item_login_required"
  | "stale_snapshot"
  | "stale_price"
  | "sync_failure"
  | "backup_failure"
  | "price_target"
  /** Phase 15 (P15-36): a material change in household guidance. */
  | "advice"
  /** Phase 16 (P16-28): the projection dips below the household's cash floor. */
  | "projected_shortfall"
  /** Phase 16 (P16-28): a confirmed obligation's window closed with no match. */
  | "obligation_missed"
  /** Phase 16 (P16-28): a matched bill posted for materially more or less. */
  | "obligation_amount_changed"
  /**
   * Phase 19 (P19-06, ADR-052): nightly backups are disabled because
   * `BACKUP_AGE_RECIPIENT` is unset. Written and cleared by the backup job,
   * like `backup_failure`, so it is NOT in {@link RULE_ALERT_TYPES}.
   */
  | "backup_not_configured";

export type AlertSeverity = "info" | "warning" | "critical";

export interface DetectedAlert {
  readonly type: AlertType;
  readonly severity: AlertSeverity;
  readonly dedupHash: string;
  readonly title: string;
  readonly detail: Record<string, unknown>;
}

export interface AlertThresholds {
  readonly largeTxnUsd: number;
  readonly balanceDropPct: number;
  readonly staleDays: number;
  readonly currency: string;
}

/**
 * The rule-managed types swept by the anomaly resolve-loop. Excludes the
 * externally/one-shot-written types: `backup_failure` and `backup_not_configured`
 * (both written by the backup job, cleared only on a successful backup — P19-06),
 * `price_target` (one-shot, written by the
 * price-target evaluator and never re-armed automatically — ADR-026), `advice`
 * (P15-36 — see `src/lib/advice/alerts.ts` on why a guidance alert must not
 * auto-resolve merely because the rule stopped speaking), and every Phase-16
 * cash-flow type (see {@link CASHFLOW_SWEPT_ALERT_TYPES} for why those are swept
 * by their own job rather than by this one).
 */
export const RULE_ALERT_TYPES: readonly AlertType[] = [
  "large_transaction",
  "balance_drop",
  "item_login_required",
  "stale_snapshot",
  "stale_price",
  "sync_failure",
];

/**
 * The three Phase-16 cash-flow types (P16-28), written by
 * `project-cashflow-daily` and by nothing else.
 */
export const CASHFLOW_ALERT_TYPES: readonly AlertType[] = [
  "projected_shortfall",
  "obligation_missed",
  "obligation_amount_changed",
];

/**
 * The cash-flow types the cash-flow job resolve-sweeps — and the reason this is
 * a SECOND list rather than three more entries in {@link RULE_ALERT_TYPES}.
 *
 * PLAN16 P16-28 asks for `projected_shortfall` to be resolve-swept, and it is
 * right to: a projected shortfall is a standing condition that genuinely clears
 * when the projection recovers, unlike the one-shot occurrence events beside it.
 * But `RULE_ALERT_TYPES` is not "the swept types" in general — it is *the set
 * `detect-anomalies-daily` owns*, and that job's sweep resolves every open alert
 * of every type in the list that it did not itself re-detect on that run. Adding
 * a type it never detects would resolve the shortfall at 05:00 the same night
 * the cash-flow job raised it at 02:00, before anyone read it.
 *
 * So the ownership is explicit instead: each job sweeps its own types, and a
 * test asserts the two sets stay disjoint.
 */
export const CASHFLOW_SWEPT_ALERT_TYPES: readonly AlertType[] = ["projected_shortfall"];

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function thresholdsFromEnv(env: Record<string, string | undefined>): AlertThresholds {
  return {
    largeTxnUsd: intFromEnv(env.ALERT_LARGE_TXN_USD, 2000),
    balanceDropPct: intFromEnv(env.ALERT_BALANCE_DROP_PCT, 25),
    staleDays: intFromEnv(env.ALERT_STALE_DAYS, 3),
    currency: env.ALERT_CURRENCY?.trim() || "USD",
  };
}

/** sha256(type | subject_id | period_key) — the once-per-condition dedup key. */
export function dedupHash(type: AlertType, subjectId: string, periodKey: string): string {
  return createHash("sha256").update(`${type}|${subjectId}|${periodKey}`).digest("hex");
}

function absMoney(m: Money): Money {
  return m.isNegative() ? m.negate() : m;
}

/** Strict greater-than over Money (same currency), via sub + sign — no floats. */
function gtMoney(a: Money, b: Money): boolean {
  const d = a.sub(b);
  return !d.isNegative() && !d.isZero();
}

/** `a >= b` over Money (same currency): a−b is zero or positive. No floats. */
function gteMoney(a: Money, b: Money): boolean {
  return !a.sub(b).isNegative();
}

/** Whole days between an ISO date string and `now` (both at UTC midnight). */
function ageInDays(dateStr: string, now: Date): number {
  const then = Date.parse(`${dateStr}T00:00:00Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((today - then) / 86_400_000);
}

/* ── Rule inputs (narrow row shapes) ─────────────────────────────────────── */

export interface RecentTxn {
  readonly id: string;
  readonly accountId: string;
  readonly postedAt: string;
  readonly amount: string;
  readonly name: string;
}
export interface BalancePair {
  readonly accountId: string;
  readonly accountName: string;
  readonly latestDate: string;
  readonly priorBalance: string;
  readonly latestBalance: string;
}
export interface BrokenItem {
  readonly id: string;
  readonly institutionName: string;
  readonly status: string;
}
export interface AccountStaleness {
  readonly accountId: string;
  readonly accountName: string;
  readonly latestSnapshotDate: string | null;
}
export interface SymbolStaleness {
  readonly symbol: string;
  readonly latestPriceDate: string | null;
}
export interface FailedSyncRun {
  readonly id: string;
  readonly institutionName: string | null;
  readonly error: string;
  readonly startedAt: string;
}

/** The full bundle of rule inputs the detection job assembles from the DB. */
export interface AlertInputs {
  readonly recentTxns: readonly RecentTxn[];
  readonly balancePairs: readonly BalancePair[];
  readonly brokenItems: readonly BrokenItem[];
  readonly accountStaleness: readonly AccountStaleness[];
  readonly symbolStaleness: readonly SymbolStaleness[];
  readonly failedRuns: readonly FailedSyncRun[];
}

/* ── Rules ───────────────────────────────────────────────────────────────── */

/** A single transaction whose magnitude exceeds the threshold. */
export function largeTransactionAlerts(
  txns: readonly RecentTxn[],
  t: AlertThresholds,
): DetectedAlert[] {
  const limit = Money.fromString(String(t.largeTxnUsd), t.currency);
  const out: DetectedAlert[] = [];
  for (const txn of txns) {
    const abs = absMoney(Money.fromString(txn.amount, t.currency));
    if (!gtMoney(abs, limit)) continue;
    out.push({
      type: "large_transaction",
      severity: "warning",
      dedupHash: dedupHash("large_transaction", txn.id, txn.postedAt),
      title: `Large transaction on ${txn.name || "an account"}`,
      detail: {
        transactionId: txn.id,
        accountId: txn.accountId,
        amount: txn.amount,
        name: txn.name,
        date: txn.postedAt,
        thresholdUsd: t.largeTxnUsd,
      },
    });
  }
  return out;
}

/** An account whose latest snapshot fell more than `balanceDropPct` vs the prior. */
export function balanceDropAlerts(
  pairs: readonly BalancePair[],
  t: AlertThresholds,
): DetectedAlert[] {
  const out: DetectedAlert[] = [];
  for (const p of pairs) {
    const prior = Money.fromString(p.priorBalance, t.currency);
    // Only meaningful when shrinking from a positive baseline.
    if (prior.isNegative() || prior.isZero()) continue;
    const latest = Money.fromString(p.latestBalance, t.currency);
    const drop = prior.sub(latest); // positive when the balance fell
    if (drop.isNegative() || drop.isZero()) continue;
    // threshold = prior * pct / 100, computed exactly (integer pct, cents div).
    const threshold = prior.mul(t.balanceDropPct).div(100);
    if (!gtMoney(drop, threshold)) continue;
    out.push({
      type: "balance_drop",
      severity: "warning",
      dedupHash: dedupHash("balance_drop", p.accountId, p.latestDate),
      title: `Large balance drop on ${p.accountName}`,
      detail: {
        accountId: p.accountId,
        accountName: p.accountName,
        priorBalance: p.priorBalance,
        latestBalance: p.latestBalance,
        date: p.latestDate,
        thresholdPct: t.balanceDropPct,
      },
    });
  }
  return out;
}

const BROKEN_STATUSES = new Set(["login_required", "revoked", "pending_disconnect"]);

/** Plaid Items in a broken state (reads PLAN4 status; doesn't re-derive it). */
export function itemLoginRequiredAlerts(items: readonly BrokenItem[]): DetectedAlert[] {
  const out: DetectedAlert[] = [];
  for (const item of items) {
    if (!BROKEN_STATUSES.has(item.status)) continue;
    out.push({
      type: "item_login_required",
      severity: item.status === "revoked" ? "critical" : "warning",
      // period_key = status → a status change (login_required → revoked) re-fires.
      dedupHash: dedupHash("item_login_required", item.id, item.status),
      title: `Reconnect needed: ${item.institutionName}`,
      detail: { plaidItemId: item.id, institutionName: item.institutionName, status: item.status },
    });
  }
  return out;
}

/** An active account whose newest snapshot is older than `staleDays`. */
export function staleSnapshotAlerts(
  accounts: readonly AccountStaleness[],
  now: Date,
  t: AlertThresholds,
): DetectedAlert[] {
  const out: DetectedAlert[] = [];
  for (const a of accounts) {
    // null = never snapshotted (fresh/manual) → skip to avoid setup-time noise.
    if (a.latestSnapshotDate === null) continue;
    if (ageInDays(a.latestSnapshotDate, now) <= t.staleDays) continue;
    out.push({
      type: "stale_snapshot",
      severity: "warning",
      dedupHash: dedupHash("stale_snapshot", a.accountId, a.latestSnapshotDate),
      title: `Snapshots have stopped for ${a.accountName}`,
      detail: {
        accountId: a.accountId,
        accountName: a.accountName,
        latestSnapshotDate: a.latestSnapshotDate,
        staleDays: t.staleDays,
      },
    });
  }
  return out;
}

/** A held symbol whose newest price is older than `staleDays` (price feed dying). */
export function stalePriceAlerts(
  symbols: readonly SymbolStaleness[],
  now: Date,
  t: AlertThresholds,
): DetectedAlert[] {
  const out: DetectedAlert[] = [];
  for (const s of symbols) {
    if (s.latestPriceDate === null) continue; // never priced → skip (could be just-added)
    if (ageInDays(s.latestPriceDate, now) <= t.staleDays) continue;
    out.push({
      type: "stale_price",
      severity: "info",
      dedupHash: dedupHash("stale_price", s.symbol, s.latestPriceDate),
      title: `Prices have stopped updating for ${s.symbol}`,
      detail: { symbol: s.symbol, latestPriceDate: s.latestPriceDate, staleDays: t.staleDays },
    });
  }
  return out;
}

/** A Plaid sync run that recorded an error. */
export function syncFailureAlerts(runs: readonly FailedSyncRun[]): DetectedAlert[] {
  return runs.map((r) => ({
    type: "sync_failure" as const,
    severity: "warning" as const,
    dedupHash: dedupHash("sync_failure", r.id, r.startedAt),
    title: `Sync failed: ${r.institutionName ?? "an institution"}`,
    detail: {
      syncRunId: r.id,
      institutionName: r.institutionName,
      error: r.error,
      date: r.startedAt,
    },
  }));
}

/** A watchlist price target + the latest close to test it against (Phase 11). */
export interface PriceTargetInput {
  readonly targetId: string;
  readonly watchlistItemId: string;
  readonly symbol: string;
  readonly direction: "above" | "below";
  /** Threshold price per unit (decimal string). */
  readonly threshold: string;
  /** Latest close (decimal string) or null when the symbol has no price yet. */
  readonly latestClose: string | null;
  /** Date of `latestClose` (YYYY-MM-DD) — the dedup period key. Null when unpriced. */
  readonly latestDate: string | null;
  /** Currency of the threshold + close (defaults to USD upstream). */
  readonly currency: string;
  /**
   * Optional pretend-position P&L (already valued by the caller) for the
   * authenticated UI only. Lives in `detail`, NEVER in the title or the email.
   */
  readonly pretendPnl?: Record<string, unknown> | null;
}

/**
 * One-shot watchlist price-target alerts (Phase 11, ADR-026).
 *
 * Fires for each target the latest close satisfies: `above` when `close ≥
 * threshold`, `below` when `close ≤ threshold` (Money/Decimal compare — never
 * floats; exact equality fires). Unpriced symbols (no close yet) are skipped.
 *
 * Per ADR-015 the title carries ONLY the symbol + direction — no numbers; the
 * threshold, price, date, and any pretend P&L go in `detail`, shown only in the
 * authenticated UI and never emailed. `dedupHash('price_target', targetId,
 * latestDate)` makes the day's evaluation idempotent under job re-runs.
 *
 * Note this is a PURE rule: it does not flip the target inactive or write a row —
 * the `evaluate-price-targets` job (P11-11) persists the alert and stamps the
 * target. `'price_target'` is deliberately absent from {@link RULE_ALERT_TYPES}
 * (one-shot; never resolve-swept), exactly like `backup_failure`.
 *
 * @param targets - Active targets joined to their latest close.
 * @returns A `DetectedAlert` per satisfied target.
 */
export function priceTargetAlerts(targets: readonly PriceTargetInput[]): DetectedAlert[] {
  const out: DetectedAlert[] = [];
  for (const t of targets) {
    // No price yet → can't test the target; the nightly fetch will catch up.
    if (t.latestClose === null || t.latestDate === null) continue;
    const close = Money.fromString(t.latestClose, t.currency);
    const threshold = Money.fromString(t.threshold, t.currency);
    const hit = t.direction === "above" ? gteMoney(close, threshold) : gteMoney(threshold, close);
    if (!hit) continue;
    const detail: Record<string, unknown> = {
      targetId: t.targetId,
      watchlistItemId: t.watchlistItemId,
      symbol: t.symbol,
      direction: t.direction,
      threshold: t.threshold,
      price: t.latestClose,
      date: t.latestDate,
    };
    if (t.pretendPnl != null) detail.pretendPnl = t.pretendPnl;
    out.push({
      type: "price_target",
      severity: "info",
      dedupHash: dedupHash("price_target", t.targetId, t.latestDate),
      // Symbol + direction only — no figures (ADR-015).
      title: `${t.symbol} hit your ${t.direction} target`,
      detail,
    });
  }
  return out;
}
