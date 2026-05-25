"use server";

import { db } from "@/db/client.ts";
import { accounts } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { createAccountSchema } from "@/lib/schemas/account.ts";
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
