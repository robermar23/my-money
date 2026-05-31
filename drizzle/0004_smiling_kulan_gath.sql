CREATE TABLE "plaid_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plaid_item_id" text NOT NULL,
	"institution_id" text NOT NULL,
	"institution_name" text NOT NULL,
	"access_token_ciphertext" "bytea" NOT NULL,
	"transactions_cursor" text,
	"products_consented" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error_code" text,
	"error_message" text,
	"last_synced_at" timestamp with time zone,
	"last_webhook_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plaid_items_status_check" CHECK ("plaid_items"."status" IN ('active', 'login_required', 'pending_disconnect', 'revoked', 'removed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_items_plaid_item_id_unique" ON "plaid_items" USING btree ("plaid_item_id");--> statement-breakpoint
CREATE INDEX "plaid_items_status_idx" ON "plaid_items" USING btree ("status") WHERE "plaid_items"."status" != 'removed';