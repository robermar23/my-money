"use server";

import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  categories,
  holdingLots,
  holdings,
  liabilities,
  transactions,
} from "@/db/schema/index.ts";
import { getAccount } from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { createRuleFromPayee } from "@/lib/categorization/rule-from-payee.ts";
import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth } from "@/lib/mortgage/amortization.ts";
import {
  createMortgageSchema,
  recordBalanceSchema,
  recordPropertyValueSchema,
  updateAccountSchema,
  updateAssetMetadataSchema,
  upsertHoldingSchema,
  upsertLotSchema,
} from "@/lib/schemas/account.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export interface ActionResult {
  error?: string;
  ok?: boolean;
  /** Non-error advisory message (e.g. "type was kept because the account has data"). */
  note?: string;
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
 * Whether the account has any data that would make a type/currency change unsafe
 * (P7-01). True if it has at least one transaction, holding, or snapshot.
 *
 * @param accountId - The account to inspect.
 * @returns True when changing type/currency would corrupt valuation.
 */
async function accountHasData(accountId: string): Promise<boolean> {
  const [txn, hold, snap] = await Promise.all([
    db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.accountId, accountId))
      .limit(1),
    db.select({ id: holdings.id }).from(holdings).where(eq(holdings.accountId, accountId)).limit(1),
    db
      .select({ d: accountSnapshots.date })
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, accountId))
      .limit(1),
  ]);
  return txn.length > 0 || hold.length > 0 || snap.length > 0;
}

/**
 * Edit an account's metadata (P7-01).
 *
 * `name` and `institution` are always editable. `type` and `currency` are only
 * applied when the account has no transactions/holdings/snapshots — changing
 * them after data exists would corrupt valuation/aggregation, so submitted
 * values are ignored and a note is returned.
 *
 * @param accountIdRaw - The account UUID from the route.
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - Form fields: name, institution, type, currency.
 * @returns ActionResult with `ok` on success, optional `note`, or `error`.
 */
export async function updateAccountAction(
  accountIdRaw: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { accountId, account } = await loadAccount(accountIdRaw);
  const parsed = updateAccountSchema.safeParse({
    name: formData.get("name"),
    institution: formData.get("institution"),
    type: formData.get("type"),
    currency: formData.get("currency") || "USD",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const hasData = await accountHasData(accountId);
  const typeOrCurrencyChanged =
    parsed.data.type !== account.type || parsed.data.currency !== account.currency;

  await db
    .update(accounts)
    .set(
      hasData
        ? { name: parsed.data.name, institution: parsed.data.institution, updatedAt: new Date() }
        : {
            name: parsed.data.name,
            institution: parsed.data.institution,
            type: parsed.data.type,
            currency: parsed.data.currency,
            updatedAt: new Date(),
          },
    )
    .where(eq(accounts.id, accountId));

  revalidatePath(`/accounts/${accountIdRaw}`);
  revalidatePath("/accounts");
  revalidatePath("/");

  if (hasData && typeOrCurrencyChanged) {
    return {
      ok: true,
      note: "Type and currency were kept — clear this account's data to change them.",
    };
  }
  return { ok: true };
}

/**
 * Close (archive) an account (P7-02). Sets `closed_at` to now. Historical
 * snapshots are preserved; the account is dropped from net worth going forward.
 *
 * @param accountIdRaw - The account UUID from the route.
 * @returns ActionResult with `ok` on success.
 */
export async function closeAccountAction(accountIdRaw: string): Promise<ActionResult> {
  const { accountId } = await loadAccount(accountIdRaw);
  await db
    .update(accounts)
    .set({ closedAt: new Date(), updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
  revalidatePath(`/accounts/${accountIdRaw}`);
  revalidatePath("/accounts");
  revalidatePath("/");
  return { ok: true };
}

/**
 * Reopen a previously-closed account (P7-02). Clears `closed_at`.
 *
 * @param accountIdRaw - The account UUID from the route.
 * @returns ActionResult with `ok` on success.
 */
export async function reopenAccountAction(accountIdRaw: string): Promise<ActionResult> {
  const { accountId } = await loadAccount(accountIdRaw);
  await db
    .update(accounts)
    .set({ closedAt: null, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
  revalidatePath(`/accounts/${accountIdRaw}`);
  revalidatePath("/accounts");
  revalidatePath("/");
  return { ok: true };
}

/**
 * Permanently delete an account and all of its child rows (P7-03).
 *
 * Every FK referencing `accounts.id` is `ON DELETE CASCADE` (transactions,
 * holdings → holding_lots, investment_transactions, account_snapshots,
 * liabilities, import_batches), so a single row delete cascades atomically.
 *
 * Plaid-linked accounts are blocked: deleting one out from under a live Item
 * orphans it and breaks the next sync. The user must Disconnect the connection
 * first (existing `disconnectItemAction`).
 *
 * On success this redirects to `/accounts` (the account page no longer exists).
 *
 * @param accountIdRaw - The account UUID from the route.
 * @returns ActionResult with `error` when blocked; otherwise redirects.
 */
export async function deleteAccountAction(accountIdRaw: string): Promise<ActionResult> {
  const { accountId, account } = await loadAccount(accountIdRaw);
  if (account.plaidItemId) {
    return { error: "Disconnect this account's connection first." };
  }
  await db.delete(accounts).where(eq(accounts.id, accountId));
  revalidatePath("/accounts");
  revalidatePath("/investments");
  revalidatePath("/");
  redirect("/accounts");
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

const LOT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Confirm a holding exists and belongs to the given account. */
async function assertHoldingOnAccount(holdingId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: holdings.id })
    .from(holdings)
    .where(and(eq(holdings.id, holdingId), eq(holdings.accountId, accountId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Add a manual cost-basis lot to a holding (Phase 5, P5-18).
 *
 * Adding a lot stamps the holding's `cost_basis_overridden_at` — the user now
 * owns the cost basis, so a later Plaid sync won't overwrite it (P5-16). With
 * any lots present, the resolved basis is their sum (src/lib/investments/lots.ts).
 */
export async function addLotAction(
  accountIdRaw: string,
  holdingIdRaw: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { accountId } = await loadAccount(accountIdRaw);
  if (!LOT_UUID_RE.test(holdingIdRaw)) {
    return { error: "Invalid holding id" };
  }
  if (!(await assertHoldingOnAccount(holdingIdRaw, accountId))) {
    return { error: "Holding not found on this account" };
  }
  const parsed = upsertLotSchema.safeParse({
    acquiredAt: formData.get("acquiredAt") ?? "",
    quantity: formData.get("quantity"),
    costBasisTotal: formData.get("costBasisTotal"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const acquiredAt =
    parsed.data.acquiredAt && parsed.data.acquiredAt.length > 0 ? parsed.data.acquiredAt : null;

  await db.transaction(async (tx) => {
    await tx.insert(holdingLots).values({
      holdingId: holdingIdRaw,
      acquiredAt,
      quantity: parsed.data.quantity,
      costBasisTotal: parsed.data.costBasisTotal,
      source: "manual",
    });
    await tx
      .update(holdings)
      .set({ costBasisOverriddenAt: new Date(), updatedAt: new Date() })
      .where(eq(holdings.id, holdingIdRaw));
  });

  revalidatePath(`/accounts/${accountIdRaw}`);
  return { ok: true };
}

/**
 * Delete a cost-basis lot. When the last lot is removed, resolved cost basis
 * falls back to the holding's aggregate `cost_basis` (precedence in lots.ts).
 */
export async function deleteLotAction(
  accountIdRaw: string,
  holdingIdRaw: string,
  lotIdRaw: string,
): Promise<ActionResult> {
  const { accountId } = await loadAccount(accountIdRaw);
  if (!LOT_UUID_RE.test(holdingIdRaw) || !LOT_UUID_RE.test(lotIdRaw)) {
    return { error: "Invalid id" };
  }
  if (!(await assertHoldingOnAccount(holdingIdRaw, accountId))) {
    return { error: "Holding not found on this account" };
  }
  await db
    .delete(holdingLots)
    .where(and(eq(holdingLots.id, lotIdRaw), eq(holdingLots.holdingId, holdingIdRaw)));
  revalidatePath(`/accounts/${accountIdRaw}`);
  return { ok: true };
}

/**
 * Delete a holding (and its cost-basis lots) from an account.
 *
 * Permanent for manual holdings. A Plaid-sourced holding will be re-created by
 * the next investments sync (which reflects Plaid's full snapshot), so this is
 * mainly for cleaning up mistaken manual entries.
 */
export async function deleteHoldingAction(
  accountIdRaw: string,
  holdingIdRaw: string,
): Promise<ActionResult> {
  const { accountId } = await loadAccount(accountIdRaw);
  if (!LOT_UUID_RE.test(holdingIdRaw)) {
    return { error: "Invalid id" };
  }
  if (!(await assertHoldingOnAccount(holdingIdRaw, accountId))) {
    return { error: "Holding not found on this account" };
  }
  await db.transaction(async (tx) => {
    await tx.delete(holdingLots).where(eq(holdingLots.holdingId, holdingIdRaw));
    await tx
      .delete(holdings)
      .where(and(eq(holdings.id, holdingIdRaw), eq(holdings.accountId, accountId)));
  });
  revalidatePath(`/accounts/${accountIdRaw}`);
  revalidatePath("/investments");
  revalidatePath("/");
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
 * Record a personal-asset valuation (Phase 10, P10-05, ADR-023). Same shape and
 * idempotency as `recordPropertyValueAction` — UPSERT on `(account_id, date)`,
 * so re-recording the same date overwrites rather than duplicating. Gated to
 * `type === 'personal_asset'`.
 *
 * @param accountIdRaw - The asset's account UUID from the route.
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - Fields: date, value.
 * @returns ActionResult with `ok` on success, or `error`.
 */
export async function recordAssetValueAction(
  accountIdRaw: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { accountId, account } = await loadAccount(accountIdRaw);
  if (account.type !== "personal_asset") {
    return { error: "This action only applies to personal-asset accounts" };
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
 * Edit a personal asset's metadata (Phase 10, P10-06). The name and all four
 * asset columns (category, description, acquired date, acquisition cost) are
 * always editable — none of them affect valuation/aggregation, so unlike
 * `updateAccountAction` there is no `accountHasData` guard. Gated to
 * `type === 'personal_asset'`.
 *
 * @param accountIdRaw - The asset's account UUID from the route.
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - Fields: name, assetCategory, description, acquiredAt,
 *   acquisitionCost.
 * @returns ActionResult with `ok` on success, or `error`.
 */
export async function updateAssetMetadataAction(
  accountIdRaw: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { accountId, account } = await loadAccount(accountIdRaw);
  if (account.type !== "personal_asset") {
    return { error: "This action only applies to personal-asset accounts" };
  }
  const parsed = updateAssetMetadataSchema.safeParse({
    name: formData.get("name"),
    assetCategory: formData.get("assetCategory"),
    description: formData.get("description") || "",
    acquiredAt: formData.get("acquiredAt") || "",
    acquisitionCost: formData.get("acquisitionCost") || "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  await db
    .update(accounts)
    .set({
      name: parsed.data.name,
      assetCategory: parsed.data.assetCategory,
      description: parsed.data.description ? parsed.data.description : null,
      acquiredAt: parsed.data.acquiredAt ? parsed.data.acquiredAt : null,
      acquisitionCost: parsed.data.acquisitionCost ? parsed.data.acquisitionCost : null,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

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

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Inline category override for a single transaction (ADR-018/P8-08). Sets the
 * structured `categoryId` FK (source of truth) plus the legacy `category` text
 * cache, and stamps `categoryOverriddenAt` so a later rule re-run won't clobber
 * this explicit human choice.
 *
 * Passing `categoryId = null` clears the category. With `opts.makeRule`, a
 * category rule is derived from the transaction's payee (normalized + escaped)
 * so future matching transactions auto-categorize — the "do this for all of
 * them" lever from IDEAS2.md.
 *
 * @param accountIdRaw - The owning account UUID (scopes the update).
 * @param transactionIdRaw - The transaction UUID.
 * @param categoryId - Target category id, or null to clear.
 * @param opts.makeRule - When true, also create a rule from the payee.
 * @returns ActionResult with `ok`, or `error` on bad input.
 */
export async function setTransactionCategoryAction(
  accountIdRaw: string,
  transactionIdRaw: string,
  categoryId: string | null,
  opts?: { makeRule?: boolean },
): Promise<ActionResult> {
  await requireUser();
  const accountId = toAccountId(accountIdRaw);
  if (!UUID_RE.test(transactionIdRaw)) {
    return { error: "Invalid transaction id" };
  }

  let categoryName: string | null = null;
  if (categoryId !== null) {
    if (!UUID_RE.test(categoryId)) return { error: "Invalid category id" };
    const [cat] = await db
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!cat) return { error: "Category not found" };
    categoryName = cat.name;
  }

  const [updated] = await db
    .update(transactions)
    .set({
      category: categoryName,
      categoryId,
      categoryOverriddenAt: new Date(),
    })
    .where(and(eq(transactions.id, transactionIdRaw), eq(transactions.accountId, accountId)))
    .returning({ name: transactions.name });

  if (updated && opts?.makeRule && categoryId !== null && categoryName !== null) {
    await createRuleFromPayee(updated.name, categoryId, categoryName);
  }

  revalidatePath(`/accounts/${accountIdRaw}`);
  revalidatePath("/analysis/review");
  return { ok: true };
}
