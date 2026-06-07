CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"dedup_hash" text NOT NULL,
	"title" text NOT NULL,
	"detail" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "alerts_type_check" CHECK ("alerts"."type" IN ('large_transaction', 'balance_drop', 'item_login_required', 'stale_snapshot', 'stale_price', 'sync_failure', 'backup_failure')),
	CONSTRAINT "alerts_severity_check" CHECK ("alerts"."severity" IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedup_hash_unique" ON "alerts" USING btree ("dedup_hash");--> statement-breakpoint
CREATE INDEX "alerts_open_detected_at_idx" ON "alerts" USING btree ("detected_at" DESC) WHERE "alerts"."resolved_at" IS NULL;