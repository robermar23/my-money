CREATE TABLE "scheduled_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"category_id" uuid,
	"label" text NOT NULL,
	"expected_amount" numeric(18, 2) NOT NULL,
	"direction" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"cadence" text NOT NULL,
	"anchor_date" date NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"active" boolean DEFAULT true NOT NULL,
	"amount_mode" text DEFAULT 'fixed' NOT NULL,
	"source" text NOT NULL,
	"detection_key" text,
	"confidence" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_obligations_direction_check" CHECK ("scheduled_obligations"."direction" IN ('outflow', 'inflow')),
	CONSTRAINT "scheduled_obligations_cadence_check" CHECK ("scheduled_obligations"."cadence" IN ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'semiannual', 'annual')),
	CONSTRAINT "scheduled_obligations_amount_mode_check" CHECK ("scheduled_obligations"."amount_mode" IN ('fixed', 'trailing_median')),
	CONSTRAINT "scheduled_obligations_source_check" CHECK ("scheduled_obligations"."source" IN ('detected', 'manual')),
	CONSTRAINT "scheduled_obligations_confidence_check" CHECK ("scheduled_obligations"."confidence" IS NULL OR "scheduled_obligations"."confidence" IN ('high', 'medium', 'low')),
	CONSTRAINT "scheduled_obligations_amount_non_negative_check" CHECK ("scheduled_obligations"."expected_amount" >= 0),
	CONSTRAINT "scheduled_obligations_date_order_check" CHECK ("scheduled_obligations"."end_date" IS NULL OR "scheduled_obligations"."end_date" >= "scheduled_obligations"."start_date")
);
--> statement-breakpoint
CREATE TABLE "obligation_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obligation_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"expected_amount" numeric(18, 2) NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"matched_transaction_id" uuid,
	"matched_amount" numeric(18, 2),
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obligation_occurrences_status_check" CHECK ("obligation_occurrences"."status" IN ('scheduled', 'matched', 'missed', 'skipped')),
	CONSTRAINT "obligation_occurrences_amount_non_negative_check" CHECK ("obligation_occurrences"."expected_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "household_profile" ADD COLUMN "cash_floor" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "household_profile" ADD COLUMN "projection_horizon_days" integer;--> statement-breakpoint
ALTER TABLE "scheduled_obligations" ADD CONSTRAINT "scheduled_obligations_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_obligations" ADD CONSTRAINT "scheduled_obligations_category_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_occurrences" ADD CONSTRAINT "obligation_occurrences_obligation_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."scheduled_obligations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_occurrences" ADD CONSTRAINT "obligation_occurrences_matched_transaction_fk" FOREIGN KEY ("matched_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_obligations_account_detection_key_unique" ON "scheduled_obligations" USING btree ("account_id","detection_key") WHERE "scheduled_obligations"."detection_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "scheduled_obligations_account_id_idx" ON "scheduled_obligations" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "obligation_occurrences_obligation_id_due_date_unique" ON "obligation_occurrences" USING btree ("obligation_id","due_date");--> statement-breakpoint
CREATE INDEX "obligation_occurrences_due_date_status_idx" ON "obligation_occurrences" USING btree ("due_date","status");--> statement-breakpoint
CREATE INDEX "obligation_occurrences_matched_transaction_id_idx" ON "obligation_occurrences" USING btree ("matched_transaction_id") WHERE "obligation_occurrences"."matched_transaction_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "household_profile" ADD CONSTRAINT "household_profile_cash_floor_check" CHECK ("household_profile"."cash_floor" IS NULL OR "household_profile"."cash_floor" >= 0);--> statement-breakpoint
ALTER TABLE "household_profile" ADD CONSTRAINT "household_profile_horizon_days_check" CHECK ("household_profile"."projection_horizon_days" IS NULL
        OR ("household_profile"."projection_horizon_days" >= 14 AND "household_profile"."projection_horizon_days" <= 365));