CREATE TABLE "plaid_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plaid_item_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"cursor_before" text,
	"cursor_after" text,
	"added_count" integer DEFAULT 0 NOT NULL,
	"modified_count" integer DEFAULT 0 NOT NULL,
	"removed_count" integer DEFAULT 0 NOT NULL,
	"pagination_count" integer DEFAULT 1 NOT NULL,
	"trigger" text NOT NULL,
	"error" text,
	CONSTRAINT "plaid_sync_runs_trigger_check" CHECK ("plaid_sync_runs"."trigger" IN ('webhook', 'manual', 'cron', 'initial'))
);
--> statement-breakpoint
ALTER TABLE "plaid_sync_runs" ADD CONSTRAINT "plaid_sync_runs_plaid_item_id_plaid_items_id_fk" FOREIGN KEY ("plaid_item_id") REFERENCES "public"."plaid_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plaid_sync_runs_item_started_at_idx" ON "plaid_sync_runs" USING btree ("plaid_item_id","started_at" DESC);