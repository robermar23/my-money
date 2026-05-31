CREATE TABLE "webhook_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_hash" text NOT NULL,
	"webhook_type" text NOT NULL,
	"webhook_code" text NOT NULL,
	"plaid_item_id" text,
	"body" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	CONSTRAINT "webhook_log_status_check" CHECK ("webhook_log"."status" IN ('queued', 'processed', 'duplicate', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_log_idempotency_hash_unique" ON "webhook_log" USING btree ("idempotency_hash");--> statement-breakpoint
CREATE INDEX "webhook_log_plaid_item_id_received_at_idx" ON "webhook_log" USING btree ("plaid_item_id","received_at" DESC);