"use server";

import { db } from "@/db/client.ts";
import { categoryRules, transactions } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { validateRegex } from "@/lib/categorization/match.ts";
import { recategorizeAll } from "@/lib/importers/persist.ts";
import { eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

export interface RuleActionResult {
  error?: string;
  ok?: boolean;
  testMatches?: Array<{ id: string; name: string; postedAt: string }>;
}

const RULE_INPUT_SCHEMA = z.object({
  pattern: z.string().trim().min(1, "Pattern is required"),
  flags: z.string().trim().max(8).default("i"),
  field: z.enum(["name", "memo"]).default("name"),
  category: z.string().trim().min(1, "Category is required").max(60),
  priority: z.coerce.number().int().min(0).max(1000).default(100),
});

export async function createRuleAction(
  _prev: RuleActionResult,
  formData: FormData,
): Promise<RuleActionResult> {
  await requireUser();
  const parsed = RULE_INPUT_SCHEMA.safeParse({
    pattern: formData.get("pattern"),
    flags: formData.get("flags") || "i",
    field: formData.get("field") || "name",
    category: formData.get("category"),
    priority: formData.get("priority") || 100,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const validationError = validateRegex(parsed.data.pattern, parsed.data.flags);
  if (validationError) {
    return { error: `Bad regex: ${validationError}` };
  }
  await db.insert(categoryRules).values({
    pattern: parsed.data.pattern,
    flags: parsed.data.flags,
    field: parsed.data.field,
    category: parsed.data.category,
    priority: parsed.data.priority,
  });
  revalidatePath("/settings/categories");
  return { ok: true };
}

export async function toggleRuleAction(ruleId: string, enabled: boolean): Promise<void> {
  await requireUser();
  if (!/^[0-9a-f-]{36}$/i.test(ruleId)) return;
  await db.update(categoryRules).set({ enabled }).where(eq(categoryRules.id, ruleId));
  revalidatePath("/settings/categories");
}

export async function deleteRuleAction(ruleId: string): Promise<void> {
  await requireUser();
  if (!/^[0-9a-f-]{36}$/i.test(ruleId)) return;
  await db.delete(categoryRules).where(eq(categoryRules.id, ruleId));
  revalidatePath("/settings/categories");
}

export async function recategorizeAllAction(): Promise<{ updated: number }> {
  await requireUser();
  const updated = await recategorizeAll();
  revalidatePath("/settings/categories");
  return { updated };
}

/**
 * Test a regex against the user's existing transactions. Returns up to 20
 * sample matches. Used by the rule-editor preview panel.
 *
 * Rate-limited UX-side (debounced); also bounded server-side: at most 20 hits.
 */
const TEST_INPUT_SCHEMA = z.object({
  pattern: z.string().trim().min(1).max(500),
  flags: z.string().trim().max(8).default("i"),
  field: z.enum(["name", "memo"]).default("name"),
});

export async function testRuleAction(
  _prev: RuleActionResult,
  formData: FormData,
): Promise<RuleActionResult> {
  await requireUser();
  const parsed = TEST_INPUT_SCHEMA.safeParse({
    pattern: formData.get("pattern"),
    flags: formData.get("flags") || "i",
    field: formData.get("field") || "name",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const err = validateRegex(parsed.data.pattern, parsed.data.flags);
  if (err) return { error: `Bad regex: ${err}` };

  let re: RegExp;
  try {
    re = new RegExp(parsed.data.pattern, parsed.data.flags);
  } catch (e) {
    return { error: `Bad regex: ${(e as Error).message}` };
  }

  // Load only what's needed; pattern-matching happens server-side in JS so
  // we don't expose user regexes to Postgres' regex engine.
  const rows = await db
    .select({
      id: transactions.id,
      name: transactions.name,
      memo: transactions.memo,
      postedAt: transactions.postedAt,
    })
    .from(transactions)
    .limit(2000);

  const matches: Array<{ id: string; name: string; postedAt: string }> = [];
  for (const r of rows) {
    const subject = parsed.data.field === "memo" ? (r.memo ?? "") : r.name;
    if (re.test(subject)) {
      matches.push({ id: r.id, name: r.name, postedAt: r.postedAt });
      if (matches.length >= 20) break;
    }
  }
  return { ok: true, testMatches: matches };
}

// `isNull` is part of the public surface for related helpers; keep referenced.
void isNull;
