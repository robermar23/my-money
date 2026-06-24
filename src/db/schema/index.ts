// Schema barrel: re-exports every table + relations file so the Drizzle client
// can pick them up in one import and so drizzle-kit can discover them.
//
// Each domain concept gets its own file (per CLAUDE.md §Database & Drizzle Specifics).

export * from "./enums.ts";
export * from "./users.ts";
export * from "./accounts.ts";
export * from "./securities.ts";
export * from "./holdings.ts";
export * from "./holding-lots.ts";
export * from "./holding-snapshots.ts";
export * from "./investment-transactions.ts";
export * from "./snapshots.ts";
export * from "./liabilities.ts";
export * from "./prices.ts";
export * from "./fx-rates.ts";
export * from "./import-batches.ts";
export * from "./asset-documents.ts";
export * from "./categories.ts";
export * from "./budgets.ts";
export * from "./transactions.ts";
export * from "./category-rules.ts";
export * from "./plaid-items.ts";
export * from "./webhook-log.ts";
export * from "./plaid-sync-runs.ts";
export * from "./alerts.ts";
export * from "./watchlist-items.ts";
export * from "./price-targets.ts";
