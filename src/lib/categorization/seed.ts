import "server-only";

import { db } from "@/db/client.ts";
import { categoryRules } from "@/db/schema/index.ts";

/**
 * Default category rules.
 *
 * Seeded automatically on first import if `category_rules` is empty
 * (idempotent — re-running is a no-op once any rule exists).
 *
 * Priority bands (lower = higher priority):
 *   - 10..19 : explicit overrides (payments, transfers)
 *   - 20..29 : food + grocery
 *   - 30..39 : travel + transport
 *   - 40..49 : utilities + bills
 *   - 50..59 : shopping
 *   - 60..69 : entertainment
 *   - 70..79 : finance (interest, fees, dividends)
 */
export const DEFAULT_RULES: ReadonlyArray<{
  pattern: string;
  category: string;
  priority?: number;
  flags?: string;
  field?: "name" | "memo";
}> = [
  // Payments + transfers (highest priority)
  { pattern: "PAYMENT\\s+THANK\\s+YOU|AUTOMATIC PAYMENT", category: "Payment", priority: 10 },
  { pattern: "TRANSFER\\s+(TO|FROM)|XFER", category: "Transfer", priority: 11 },

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

  // Shopping
  { pattern: "AMAZON|AMZN", category: "Shopping", priority: 50 },
  { pattern: "TARGET|WALMART|BEST BUY|HOME DEPOT|LOWES?", category: "Shopping", priority: 51 },

  // Entertainment + subscriptions
  {
    pattern: "NETFLIX|HULU|DISNEY\\+|SPOTIFY|APPLE\\.COM/BILL|PRIME VIDEO",
    category: "Subscriptions",
    priority: 60,
  },

  // Finance
  { pattern: "INTEREST PAID|INTEREST EARNED", category: "Interest", priority: 70 },
  { pattern: "FEE|SERVICE CHARGE|OVERDRAFT", category: "Fees", priority: 71 },
  { pattern: "PAYROLL|DIRECT DEPOSIT|DIRECTDEP", category: "Income", priority: 72 },
];

/**
 * Seed default rules if the table is empty. Idempotent: returns the number of
 * rows inserted (0 when already seeded).
 */
export async function seedDefaultRulesIfEmpty(): Promise<number> {
  const existing = await db.select({ id: categoryRules.id }).from(categoryRules).limit(1);
  if (existing.length > 0) return 0;

  const values = DEFAULT_RULES.map((r) => ({
    pattern: r.pattern,
    category: r.category,
    priority: r.priority ?? 100,
    flags: r.flags ?? "i",
    field: r.field ?? "name",
  }));
  await db.insert(categoryRules).values(values);
  return values.length;
}
