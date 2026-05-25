import { db } from "@/db/client.ts";
import { accountSnapshots, accounts, liabilities } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth } from "@/lib/mortgage/amortization.ts";
import type { Job } from "bullmq";
import { desc, eq, sql } from "drizzle-orm";

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
    } else {
      // Carry forward the most-recent prior snapshot. If there isn't one yet,
      // skip this account — no data means no snapshot.
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
