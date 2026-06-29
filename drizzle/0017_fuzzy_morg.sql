-- Phase 12 (ADR-028): enable trigram matching. drizzle-kit's `generate` does not
-- emit CREATE EXTENSION, so it is hand-prepended here (the GIN indexes below
-- depend on the gin_trgm_ops opclass this extension provides). pg_trgm is a
-- standard Postgres contrib module, present in the official `postgres` image.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "accounts_name_trgm_idx" ON "accounts" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "accounts_institution_trgm_idx" ON "accounts" USING gin ("institution" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "securities_symbol_trgm_idx" ON "securities" USING gin ("symbol" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "securities_name_trgm_idx" ON "securities" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "securities_ticker_symbol_trgm_idx" ON "securities" USING gin ("ticker_symbol" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "categories_name_trgm_idx" ON "categories" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "transactions_name_trgm_idx" ON "transactions" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "transactions_memo_trgm_idx" ON "transactions" USING gin ("memo" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "watchlist_items_symbol_trgm_idx" ON "watchlist_items" USING gin ("symbol" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "watchlist_items_label_trgm_idx" ON "watchlist_items" USING gin ("label" gin_trgm_ops);