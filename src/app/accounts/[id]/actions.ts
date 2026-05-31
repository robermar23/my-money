"use server";

import { db } from "@/db/client.ts";
import { accountSnapshots, holdings, liabilities, transactions } from "@/db/schema/index.ts";
import { getAccount } from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth } from "@/lib/mortgage/amortization.ts";
import {
  createMortgageSchema,
  recordBalanceSchema,
  recordPropertyValueSchema,
  upsertHoldingSchema,
} from "@/lib/schemas/account.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export interface ActionResult {
  error?: string;
  ok?: boolean;
}

async function loadAccount(accountIdRaw: string) {
  await requireUser();
  const accountId = toAccountId(accountIdRaw);
  const account = await getAccount(accountId);
  if (!account) {
    throw new Error("Account not found");
  }
  return { accountId, account };
}

/**
 * Record an end-of-day balance snapshot. Used by depository, credit_card, and
 * crypto_ira accounts (where the user just types in the balance from their
 * statement / portal).
 *
 * Idempotent: UPSERT on (account_id, date) — re-recording the same date overwrites.
 */
export async function recordBalanceAction(
  accountIdRaw: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { accountId } = await loadAccount(accountIdRaw);
  const parsed = recordBalanceSchema.safeParse({
    date: formData.get("date"),
    balance: formData.get("balance"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  await db
    .insert(accountSnapshots)
    .values({ accountId, date: parsed.data.date, balance: parsed.data.balance })
    .onConflictDoUpdate({
      target: [accountSnapshots.accountId, accountSnapshots.date],
      set: { balance: parsed.data.balance },
    });
  revalidatePath(`/accounts/${accountIdRaw}`);
  revalidatePath("/accounts");
  revalidatePath("/");
  return { ok: true };
}

/**
 * Upsert a holding on an investment / crypto_ira / property account.
 * (account_id, symbol) is UNIQUE — re-adding the same symbol updates the row.
 */
export async function upsertHoldingAction(
  accountIdRaw: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { accountId } = await loadAccount(accountIdRaw);
  const parsed = upsertHoldingSchema.safeParse({
    symbol: formData.get("symbol"),
    quantity: formData.get("quantity"),
    quantityUnit: formData.get("quantityUnit"),
    assetClass: formData.get("assetClass"),
    costBasis: formData.get("costBasis") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  await db
    .insert(holdings)
    .values({
      accountId,
      symbol: parsed.data.symbol.toUpperCase(),
      quantity: parsed.data.quantity,
      quantityUnit: parsed.data.quantityUnit,
      assetClass: parsed.data.assetClass,
      costBasis: parsed.data.costBasis ? parsed.data.costBasis : null,
    })
    .onConflictDoUpdate({
      target: [holdings.accountId, holdings.symbol],
      set: {
        quantity: parsed.data.quantity,
        quantityUnit: parsed.data.quantityUnit,
        assetClass: parsed.data.assetClass,
        costBasis: parsed.data.costBasis ? parsed.data.costBasis : null,
        updatedAt: new Date(),
      },
    });
  revalidatePath(`/accounts/${accountIdRaw}`);
  return { ok: true };
}

/**
 * Set up the amortization parameters for a `loan` account. One row per loan
 * account (FK is unique) — submitting again updates the parameters.
 *
 * Also writes an immediate snapshot at the start_date with -principal so the
 * loan shows up in net-worth right away.
 */
export async function createOrUpdateMortgageAction(
  accountIdRaw: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { accountId, account } = await loadAccount(accountIdRaw);
  if (account.type !== "loan") {
    return { error: "This action only applies to loan accounts" };
  }
  const parsed = createMortgageSchema.safeParse({
    name: formData.get("name"),
    principalAtOrigination: formData.get("principalAtOrigination"),
    annualRate: formData.get("annualRate"),
    termMonths: formData.get("termMonths"),
    startDate: formData.get("startDate"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await db
    .insert(liabilities)
    .values({
      accountId,
      name: parsed.data.name,
      principalAtOrigination: parsed.data.principalAtOrigination,
      annualRate: parsed.data.annualRate,
      termMonths: parsed.data.termMonths,
      startDate: parsed.data.startDate,
    })
    .onConflictDoUpdate({
      target: liabilities.accountId,
      set: {
        name: parsed.data.name,
        principalAtOrigination: parsed.data.principalAtOrigination,
        annualRate: parsed.data.annualRate,
        termMonths: parsed.data.termMonths,
        startDate: parsed.data.startDate,
        updatedAt: new Date(),
      },
    });

  // Snapshot at start date with -principal (liabilities reduce net worth).
  await db
    .insert(accountSnapshots)
    .values({
      accountId,
      date: parsed.data.startDate,
      balance: Money.fromString(parsed.data.principalAtOrigination, account.currency)
        .negate()
        .toString(),
    })
    .onConflictDoUpdate({
      target: [accountSnapshots.accountId, accountSnapshots.date],
      set: {
        balance: Money.fromString(parsed.data.principalAtOrigination, account.currency)
          .negate()
          .toString(),
      },
    });

  revalidatePath(`/accounts/${accountIdRaw}`);
  revalidatePath("/accounts");
  revalidatePath("/");
  return { ok: true };
}

/**
 * Record a property valuation (home value). Same shape as a balance snapshot.
 */
export async function recordPropertyValueAction(
  accountIdRaw: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { accountId, account } = await loadAccount(accountIdRaw);
  if (account.type !== "property") {
    return { error: "This action only applies to property accounts" };
  }
  const parsed = recordPropertyValueSchema.safeParse({
    date: formData.get("date"),
    value: formData.get("value"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  await db
    .insert(accountSnapshots)
    .values({ accountId, date: parsed.data.date, balance: parsed.data.value })
    .onConflictDoUpdate({
      target: [accountSnapshots.accountId, accountSnapshots.date],
      set: { balance: parsed.data.value },
    });
  revalidatePath(`/accounts/${accountIdRaw}`);
  revalidatePath("/accounts");
  revalidatePath("/");
  return { ok: true };
}

/**
 * Helper used by the loan account detail page to compute the live balance from
 * the amortization schedule without touching account_snapshots.
 */
export async function loanBalanceNow(accountIdRaw: string): Promise<Money | null> {
  const { accountId, account } = await loadAccount(accountIdRaw);
  if (account.type !== "loan") return null;
  const [liability] = await db
    .select()
    .from(liabilities)
    .where(eq(liabilities.accountId, accountId))
    .limit(1);
  if (!liability) return null;
  const start = new Date(`${liability.startDate}T00:00:00Z`);
  const now = new Date();
  const monthsElapsed =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - start.getUTCMonth());
  return balanceAtMonth(
    Money.fromString(liability.principalAtOrigination, account.currency),
    liability.annualRate,
    liability.termMonths,
    Math.max(0, monthsElapsed),
  );
}

/**
 * Inline category override for a single transaction. Used by the transactions
 * table on the account detail page.
 */
export async function setTransactionCategoryAction(
  accountIdRaw: string,
  transactionIdRaw: string,
  rawCategory: string,
): Promise<ActionResult> {
  await requireUser();
  const accountId = toAccountId(accountIdRaw);
  if (!/^[0-9a-f-]{36}$/i.test(transactionIdRaw)) {
    return { error: "Invalid transaction id" };
  }
  const trimmed = rawCategory.trim();
  await db
    .update(transactions)
    .set({
      category: trimmed.length === 0 ? null : trimmed,
      categoryOverriddenAt: new Date(),
    })
    .where(and(eq(transactions.id, transactionIdRaw), eq(transactions.accountId, accountId)));

  revalidatePath(`/accounts/${accountIdRaw}`);
  return { ok: true };
}
