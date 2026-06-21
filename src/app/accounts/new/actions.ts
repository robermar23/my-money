"use server";

import { db } from "@/db/client.ts";
import { accountSnapshots, accounts } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { createAccountSchema, createAssetSchema } from "@/lib/schemas/account.ts";
import { redirect } from "next/navigation";

export interface CreateAccountResult {
  error?: string;
}

export async function createAccountAction(
  _prev: CreateAccountResult,
  formData: FormData,
): Promise<CreateAccountResult> {
  await requireUser();

  const parsed = createAccountSchema.safeParse({
    name: formData.get("name"),
    institution: formData.get("institution"),
    type: formData.get("type"),
    currency: formData.get("currency") || "USD",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const [created] = await db
    .insert(accounts)
    .values({
      name: parsed.data.name,
      institution: parsed.data.institution,
      type: parsed.data.type,
      currency: parsed.data.currency,
    })
    .returning({ id: accounts.id });

  if (!created) {
    return { error: "Failed to create account" };
  }

  redirect(`/accounts/${created.id}`);
}

/**
 * Create a personal high-value asset (Phase 10, P10-04, ADR-023).
 *
 * Inserts a `personal_asset` account with `institution` defaulted server-side to
 * the `"Personal asset"` sentinel (the form never surfaces it) plus the four
 * asset columns. When `initialValue` is supplied, an `account_snapshots` row is
 * written in the same transaction so the asset counts toward net worth right
 * away; otherwise it stays hidden until its first recorded value.
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - Asset fields (name, category, optional description /
 *   acquisition date / cost / currency / initial value + date).
 * @returns CreateAccountResult with `error` on failure; redirects on success.
 */
export async function createAssetAction(
  _prev: CreateAccountResult,
  formData: FormData,
): Promise<CreateAccountResult> {
  await requireUser();

  const parsed = createAssetSchema.safeParse({
    name: formData.get("name"),
    assetCategory: formData.get("assetCategory"),
    description: formData.get("description") || "",
    acquiredAt: formData.get("acquiredAt") || "",
    acquisitionCost: formData.get("acquisitionCost") || "",
    currency: formData.get("currency") || "USD",
    initialValue: formData.get("initialValue") || "",
    initialValueDate: formData.get("initialValueDate") || "",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const {
    name,
    assetCategory,
    description,
    acquiredAt,
    acquisitionCost,
    currency,
    initialValue,
    initialValueDate,
  } = parsed.data;

  const created = await db.transaction(async (tx) => {
    const [acc] = await tx
      .insert(accounts)
      .values({
        name,
        institution: "Personal asset",
        type: "personal_asset",
        currency,
        assetCategory,
        description: description ? description : null,
        acquiredAt: acquiredAt ? acquiredAt : null,
        acquisitionCost: acquisitionCost ? acquisitionCost : null,
      })
      .returning({ id: accounts.id });

    if (acc && initialValue) {
      await tx.insert(accountSnapshots).values({
        accountId: acc.id,
        date: initialValueDate ? initialValueDate : new Date().toISOString().slice(0, 10),
        balance: initialValue,
      });
    }
    return acc;
  });

  if (!created) {
    return { error: "Failed to create asset" };
  }

  redirect(`/accounts/${created.id}`);
}
