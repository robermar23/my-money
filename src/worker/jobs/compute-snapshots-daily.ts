import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  holdingLots,
  holdingSnapshots,
  holdings,
  liabilities,
} from "@/db/schema/index.ts";
import { valueHolding } from "@/lib/holdings/value.ts";
import { resolveCostBasis } from "@/lib/investments/lots.ts";
import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth } from "@/lib/mortgage/amortization.ts";
import type { Job } from "bullmq";
import { desc, eq, inArray, sql } from "drizzle-orm";

/**
 * Phase 1 nightly job: write today's snapshot for every account.
 *
 * Idempotent via UNIQUE (account_id, date) — re-running the same job for the
 * same day updates rather than duplicates.
 *
 * Strategy per account type:
 *   - loan: compute live amortization balance, negate, write.
 *   - everything else: carry forward the most-recent prior snapshot. Phase 2
 *     replaces this for investment/crypto_ira accounts with sum(quantity * price)
 *     once the prices table is populated.
 *
 * Manual balance entries (made via the UI) already write their own snapshot
 * for the chosen date — those take precedence because they're written first
 * and the carry-forward logic skips dates that already have a row.
 */
/**
 * Value every holding in an account as of `date`, write each position's
 * `holding_snapshots` row, and return the account total (PLAN9 P9-02, ADR-019).
 *
 * Replaces the old `valueAccountHoldings` call inside the snapshot job: it hits
 * the same cached prices (no extra reads) but additionally records the
 * per-holding history that `account_snapshots` cannot express.
 *
 * Honesty rule: a snapshot is written only for a position whose value is real —
 * a priced security, or a `cash`/`property` position valued at face. An unpriced
 * security contributes $0 to today's total (we don't know its price yet) but a
 * $0 *history* row would be a lie, so it is skipped.
 *
 * Idempotent via the `(holding_id, date)` PK + `ON CONFLICT DO UPDATE`.
 *
 * @param accountId - The account whose holdings to value + snapshot.
 * @param currency - The account's currency (value is stored in it).
 * @param date - The snapshot date (YYYY-MM-DD).
 * @returns The summed value of the account's holdings as Money.
 */
async function snapshotAccountHoldings(
  accountId: string,
  currency: string,
  date: string,
): Promise<Money> {
  const rows = await db.select().from(holdings).where(eq(holdings.accountId, accountId));
  if (rows.length === 0) return Money.zero(currency);

  // Load lots once for resolved cost basis (P5-07 precedence).
  const lotRows = await db
    .select({
      holdingId: holdingLots.holdingId,
      quantity: holdingLots.quantity,
      costBasisTotal: holdingLots.costBasisTotal,
    })
    .from(holdingLots)
    .where(
      inArray(
        holdingLots.holdingId,
        rows.map((r) => r.id),
      ),
    );
  const lotsByHolding = new Map<string, { quantity: string; costBasisTotal: string }[]>();
  for (const lot of lotRows) {
    const arr = lotsByHolding.get(lot.holdingId) ?? [];
    arr.push({ quantity: lot.quantity, costBasisTotal: lot.costBasisTotal });
    lotsByHolding.set(lot.holdingId, arr);
  }

  let total = Money.zero(currency);
  for (const h of rows) {
    const valuation = await valueHolding(h, currency, date);
    total = total.add(valuation.value);

    const isCashLike = h.assetClass === "cash" || h.assetClass === "property";
    const priced = valuation.closeUsed !== null || isCashLike;
    if (!priced) continue;

    // Cash/property are basis-free (mirrors the /investments page); otherwise
    // resolve lots → aggregate → null per the cost-basis precedence rule.
    const costBasis = isCashLike
      ? null
      : resolveCostBasis({ costBasis: h.costBasis }, lotsByHolding.get(h.id) ?? [], currency);
    const value = valuation.value.toString();
    const basis = costBasis ? costBasis.toString() : null;

    await db
      .insert(holdingSnapshots)
      .values({ holdingId: h.id, date, quantity: h.quantity, value, costBasis: basis, currency })
      .onConflictDoUpdate({
        target: [holdingSnapshots.holdingId, holdingSnapshots.date],
        set: { quantity: h.quantity, value, costBasis: basis, currency },
      });
  }
  return total;
}

export async function computeSnapshotsDailyProcessor(_job: Job): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const all = await db.select().from(accounts);

  for (const account of all) {
    let balance: string;

    if (account.type === "loan") {
      const [liab] = await db
        .select()
        .from(liabilities)
        .where(eq(liabilities.accountId, account.id))
        .limit(1);
      if (!liab) continue;
      const start = new Date(`${liab.startDate}T00:00:00Z`);
      const now = new Date();
      const months =
        (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
        (now.getUTCMonth() - start.getUTCMonth());
      const remaining = balanceAtMonth(
        Money.fromString(liab.principalAtOrigination, account.currency),
        liab.annualRate,
        liab.termMonths,
        Math.max(0, months),
      );
      balance = remaining.negate().toString();
    } else if (account.type === "investment" || account.type === "crypto_ira") {
      // Phase 2: value the account's holdings using today's cached prices, and
      // (PLAN9 P9-02) write each position's per-day snapshot in the same pass.
      // If no prices have been fetched yet OR the account has no holdings, fall
      // back to the carry-forward behavior so manual-only setups still work.
      const holdingsValue = await snapshotAccountHoldings(account.id, account.currency, today);
      if (!holdingsValue.isZero()) {
        balance = holdingsValue.toString();
      } else {
        const [prior] = await db
          .select({ balance: accountSnapshots.balance })
          .from(accountSnapshots)
          .where(eq(accountSnapshots.accountId, account.id))
          .orderBy(desc(accountSnapshots.date))
          .limit(1);
        if (!prior) continue;
        balance = prior.balance;
      }
    } else {
      // depository / credit_card / property: carry forward the most-recent prior
      // snapshot. The user enters these manually; the job preserves the trend
      // line on days where no manual entry happens.
      const [prior] = await db
        .select({ balance: accountSnapshots.balance })
        .from(accountSnapshots)
        .where(eq(accountSnapshots.accountId, account.id))
        .orderBy(desc(accountSnapshots.date))
        .limit(1);
      if (!prior) continue;
      balance = prior.balance;
    }

    await db
      .insert(accountSnapshots)
      .values({ accountId: account.id, date: today, balance })
      .onConflictDoUpdate({
        target: [accountSnapshots.accountId, accountSnapshots.date],
        set: { balance },
      });
  }

  // Touch a no-op so a future "did the snapshot run today" probe can use NOW().
  // Cheap and avoids needing a separate job_runs table for Phase 1.
  await db.execute(sql`SELECT 1`);
}
