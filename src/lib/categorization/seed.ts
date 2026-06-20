import "server-only";

import { db } from "@/db/client.ts";
import { type CategoryKind, categories, categoryGroups, categoryRules } from "@/db/schema/index.ts";

/**
 * Default structured taxonomy + regex rules (ADR-018, extending ADR-007).
 *
 * Seeded automatically on first import / first visit to the rules page
 * (idempotent — re-running is a no-op once any category / rule exists). The
 * one-shot backfill (`backfillCategories`) also calls the seed to guarantee the
 * default groups/categories exist before linking legacy free-text values.
 *
 * Rule priority bands (lower = higher priority):
 *   - 10..19 : explicit payments + transfers (must win over merchant matches)
 *   - 20..29 : food + grocery
 *   - 30..39 : travel + transport
 *   - 40..49 : utilities + bills
 *   - 50..59 : shopping
 *   - 60..69 : entertainment
 *   - 70..79 : finance + income
 */

/** A rollup group (Food, Housing, …). `name` is matched case-insensitively. */
interface SeedGroup {
  readonly name: string;
  readonly sortOrder: number;
}

/** A leaf category mapped to its group + analytics `kind`. */
interface SeedCategory {
  readonly name: string;
  readonly group: string;
  readonly kind: CategoryKind;
}

/** A regex rule referencing a category by name (resolved to an id at seed time). */
interface SeedRule {
  readonly pattern: string;
  readonly category: string;
  readonly priority: number;
  readonly flags?: string;
  readonly field?: "name" | "memo";
}

export const DEFAULT_GROUPS: readonly SeedGroup[] = [
  { name: "Income", sortOrder: 10 },
  { name: "Housing", sortOrder: 20 },
  { name: "Food", sortOrder: 30 },
  { name: "Transport", sortOrder: 40 },
  { name: "Utilities", sortOrder: 50 },
  { name: "Shopping", sortOrder: 60 },
  { name: "Entertainment", sortOrder: 70 },
  { name: "Health", sortOrder: 80 },
  { name: "Finance", sortOrder: 90 },
  { name: "Transfers", sortOrder: 100 },
  { name: "Other", sortOrder: 110 },
];

/**
 * Leaf categories. `kind` drives analytics:
 *   - income  → counted as income
 *   - expense → counted as spend
 *   - transfer→ EXCLUDED from both (card payments, WEB XFER, P2P apps)
 *
 * P2P apps (Venmo/Zelle/CashApp/Apple Cash) and PayPal default to `transfer`
 * per ADR-018 — they're ambiguous, so we keep them OUT of spend by default and
 * let the owner reclassify the leaf to `expense` if they actually spend through
 * them. Mortgage/loan payments are real expenses; SSA/payroll are income.
 */
export const DEFAULT_CATEGORIES: readonly SeedCategory[] = [
  // Income
  { name: "Income", group: "Income", kind: "income" },
  // Housing
  { name: "Mortgage", group: "Housing", kind: "expense" },
  { name: "Rent", group: "Housing", kind: "expense" },
  // Food
  { name: "Groceries", group: "Food", kind: "expense" },
  { name: "Coffee", group: "Food", kind: "expense" },
  { name: "Restaurant", group: "Food", kind: "expense" },
  // Transport
  { name: "Transport", group: "Transport", kind: "expense" },
  { name: "Gas", group: "Transport", kind: "expense" },
  { name: "Travel", group: "Transport", kind: "expense" },
  // Utilities
  { name: "Utilities", group: "Utilities", kind: "expense" },
  // Shopping
  { name: "Shopping", group: "Shopping", kind: "expense" },
  // Entertainment
  { name: "Subscriptions", group: "Entertainment", kind: "expense" },
  // Health
  { name: "Health", group: "Health", kind: "expense" },
  // Finance
  { name: "Interest", group: "Finance", kind: "income" },
  { name: "Fees", group: "Finance", kind: "expense" },
  { name: "Loan Payment", group: "Finance", kind: "expense" },
  // Transfers (excluded from spend)
  { name: "Transfer", group: "Transfers", kind: "transfer" },
  { name: "Payment", group: "Transfers", kind: "transfer" },
  { name: "Credit Card Payment", group: "Transfers", kind: "transfer" },
  { name: "P2P Transfer", group: "Transfers", kind: "transfer" },
];

export const DEFAULT_RULES: readonly SeedRule[] = [
  // Payments + transfers (highest priority — must beat merchant matches)
  { pattern: "PAYMENT\\s+THANK\\s+YOU|AUTOMATIC PAYMENT", category: "Payment", priority: 10 },
  {
    pattern: "CITI CARD ONLINE PAYMENT|CITI(BANK)? PAYMENT",
    category: "Credit Card Payment",
    priority: 11,
  },
  { pattern: "TRANSFER\\s+(TO|FROM)|WEB XFER|XFER", category: "Transfer", priority: 12 },
  { pattern: "VENMO", category: "P2P Transfer", priority: 13 },
  { pattern: "ZELLE", category: "P2P Transfer", priority: 13 },
  { pattern: "CASH ?APP|CASHAPP|SQ \\*CASH", category: "P2P Transfer", priority: 13 },
  { pattern: "APPLE CASH", category: "P2P Transfer", priority: 13 },
  { pattern: "PAYPAL", category: "P2P Transfer", priority: 14 },
  { pattern: "MORTGAG(E)?|SUN ?WEST", category: "Mortgage", priority: 15 },
  { pattern: "INSTALLMENT LOAN", category: "Loan Payment", priority: 16 },

  // Food + grocery
  {
    pattern: "WEGMANS|WHOLEFDS|WHOLE FOODS|TRADER JOE|COSTCO|SAFEWAY|KROGER|PUBLIX|ALDI",
    category: "Groceries",
    priority: 20,
  },
  { pattern: "STARBUCKS|DUNKIN|PEET'?S COFFEE", category: "Coffee", priority: 21 },
  {
    pattern: "MCDONALD|BURGER KING|CHIPOTLE|TACO BELL|SUBWAY|WENDY|PANERA|CHICK-?FIL-?A",
    category: "Restaurant",
    priority: 22,
  },

  // Transport + travel
  { pattern: "UBER|LYFT", category: "Transport", priority: 30 },
  { pattern: "SHELL|EXXON|CHEVRON|MOBIL|BP\\s|MARATHON|SUNOCO", category: "Gas", priority: 31 },
  {
    pattern: "UNITED|DELTA|AMERICAN AIRLINES|SOUTHWEST|JETBLUE|ALASKA AIR",
    category: "Travel",
    priority: 32,
  },

  // Utilities + bills
  {
    pattern: "ATT|VERIZON|T-MOBILE|SPRINT|XFINITY|COMCAST|SPECTRUM",
    category: "Utilities",
    priority: 40,
  },
  { pattern: "DUKE ENERGY|CON ED|PG&E|ELECTRIC", category: "Utilities", priority: 41 },
  { pattern: "NATURAL GAS|GAS & ELECTRIC", category: "Utilities", priority: 42 },

  // Shopping
  { pattern: "AMAZON|AMZN", category: "Shopping", priority: 50 },
  { pattern: "TARGET|WALMART|BEST BUY|HOME DEPOT|LOWES?", category: "Shopping", priority: 51 },

  // Entertainment + subscriptions
  {
    pattern: "NETFLIX|HULU|DISNEY\\+|SPOTIFY|APPLE\\.COM/BILL|PRIME VIDEO",
    category: "Subscriptions",
    priority: 60,
  },

  // Finance + income
  { pattern: "INTEREST PAID|INTEREST EARNED", category: "Interest", priority: 70 },
  { pattern: "FEE|SERVICE CHARGE|OVERDRAFT", category: "Fees", priority: 71 },
  { pattern: "PAYROLL|DIRECT DEPOSIT|DIRECTDEP", category: "Income", priority: 72 },
  { pattern: "SOCIAL SECURITY|SSA TREAS", category: "Income", priority: 73 },
];

export interface SeedResult {
  readonly groupsInserted: number;
  readonly categoriesInserted: number;
  readonly rulesInserted: number;
}

/**
 * Seed the default taxonomy + rules. Idempotent on two independent axes:
 *   - groups + categories are inserted only when `categories` is empty;
 *   - rules are inserted only when `category_rules` is empty.
 * This split lets a legacy install (rules already present from ADR-007, but no
 * structured categories yet) gain the taxonomy without duplicating rules — the
 * backfill then links the existing rules by name.
 *
 * @returns Counts of rows actually inserted (all zero when fully seeded).
 */
export async function seedDefaultCategoriesAndRulesIfEmpty(): Promise<SeedResult> {
  let groupsInserted = 0;
  let categoriesInserted = 0;
  let rulesInserted = 0;

  const haveCategory = await db.select({ id: categories.id }).from(categories).limit(1);
  if (haveCategory.length === 0) {
    const insertedGroups = await db
      .insert(categoryGroups)
      .values(DEFAULT_GROUPS.map((g) => ({ name: g.name, sortOrder: g.sortOrder })))
      .returning({ id: categoryGroups.id, name: categoryGroups.name });
    groupsInserted = insertedGroups.length;

    const groupIdByName = new Map(insertedGroups.map((g) => [g.name.toLowerCase(), g.id]));

    const insertedCategories = await db
      .insert(categories)
      .values(
        DEFAULT_CATEGORIES.map((c, i) => ({
          name: c.name,
          kind: c.kind,
          groupId: groupIdByName.get(c.group.toLowerCase()) ?? null,
          sortOrder: 10 + i,
        })),
      )
      .returning({ id: categories.id });
    categoriesInserted = insertedCategories.length;
  }

  const haveRule = await db.select({ id: categoryRules.id }).from(categoryRules).limit(1);
  if (haveRule.length === 0) {
    // Resolve each rule's category name → id from whatever categories exist.
    const allCategories = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories);
    const categoryIdByName = new Map(allCategories.map((c) => [c.name.toLowerCase(), c.id]));

    const ruleValues = DEFAULT_RULES.map((r) => ({
      pattern: r.pattern,
      flags: r.flags ?? "i",
      field: r.field ?? "name",
      category: r.category,
      categoryId: categoryIdByName.get(r.category.toLowerCase()) ?? null,
      priority: r.priority,
    }));
    if (ruleValues.length > 0) {
      await db.insert(categoryRules).values(ruleValues);
      rulesInserted = ruleValues.length;
    }
  }

  return { groupsInserted, categoriesInserted, rulesInserted };
}

/**
 * Backwards-compatible shim for ADR-007 call sites that only cared about rules.
 * Delegates to the structured seed and returns the number of rules inserted.
 *
 * @returns Count of category rules inserted (0 when already seeded).
 */
export async function seedDefaultRulesIfEmpty(): Promise<number> {
  const result = await seedDefaultCategoriesAndRulesIfEmpty();
  return result.rulesInserted;
}
