CREATE TABLE "credit_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"apr" numeric(8, 6),
	"credit_limit" numeric(18, 2),
	"minimum_payment" numeric(18, 2),
	"minimum_payment_percent" numeric(7, 4),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_lines_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "credit_lines_apr_range_check" CHECK ("credit_lines"."apr" IS NULL OR ("credit_lines"."apr" >= 0 AND "credit_lines"."apr" <= 1)),
	CONSTRAINT "credit_lines_credit_limit_check" CHECK ("credit_lines"."credit_limit" IS NULL OR "credit_lines"."credit_limit" >= 0),
	CONSTRAINT "credit_lines_minimum_payment_check" CHECK ("credit_lines"."minimum_payment" IS NULL OR "credit_lines"."minimum_payment" >= 0),
	CONSTRAINT "credit_lines_minimum_payment_percent_check" CHECK ("credit_lines"."minimum_payment_percent" IS NULL
        OR ("credit_lines"."minimum_payment_percent" >= 0 AND "credit_lines"."minimum_payment_percent" <= 100))
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"birth_year" integer,
	"is_dependent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_members_birth_year_check" CHECK ("household_members"."birth_year" IS NULL OR ("household_members"."birth_year" >= 1900 AND "household_members"."birth_year" <= 2200))
);
--> statement-breakpoint
CREATE TABLE "household_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reserve_months_override" integer,
	"retirement_target_age" integer,
	"benchmark_savings_apy" numeric(7, 4),
	"needs_pct" numeric(5, 2),
	"wants_pct" numeric(5, 2),
	"savings_pct" numeric(5, 2),
	"high_interest_threshold_apr" numeric(8, 6),
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_profile_reserve_months_check" CHECK ("household_profile"."reserve_months_override" IS NULL
        OR ("household_profile"."reserve_months_override" >= 1 AND "household_profile"."reserve_months_override" <= 60)),
	CONSTRAINT "household_profile_retirement_age_check" CHECK ("household_profile"."retirement_target_age" IS NULL
        OR ("household_profile"."retirement_target_age" >= 30 AND "household_profile"."retirement_target_age" <= 100)),
	CONSTRAINT "household_profile_benchmark_apy_check" CHECK ("household_profile"."benchmark_savings_apy" IS NULL
        OR ("household_profile"."benchmark_savings_apy" >= 0 AND "household_profile"."benchmark_savings_apy" <= 100)),
	CONSTRAINT "household_profile_split_check" CHECK (("household_profile"."needs_pct" IS NULL AND "household_profile"."wants_pct" IS NULL AND "household_profile"."savings_pct" IS NULL)
        OR ("household_profile"."needs_pct" IS NOT NULL AND "household_profile"."wants_pct" IS NOT NULL AND "household_profile"."savings_pct" IS NOT NULL
            AND "household_profile"."needs_pct" >= 0 AND "household_profile"."wants_pct" >= 0 AND "household_profile"."savings_pct" >= 0
            AND "household_profile"."needs_pct" + "household_profile"."wants_pct" + "household_profile"."savings_pct" = 100)),
	CONSTRAINT "household_profile_high_interest_check" CHECK ("household_profile"."high_interest_threshold_apr" IS NULL
        OR ("household_profile"."high_interest_threshold_apr" >= 0 AND "household_profile"."high_interest_threshold_apr" <= 1))
);
--> statement-breakpoint
CREATE TABLE "recommendation_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" text NOT NULL,
	"subject_key" text DEFAULT '' NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snooze_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_dismissals_rule_id_check" CHECK (length("recommendation_dismissals"."rule_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "subtype" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "apy" numeric(7, 4);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "maturity_date" date;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "tax_treatment" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "necessity" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "excluded_from_baseline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_lines" ADD CONSTRAINT "credit_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_lines_account_id_idx" ON "credit_lines" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_dismissals_rule_subject_unique" ON "recommendation_dismissals" USING btree ("rule_id","subject_key");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_subtype_check" CHECK ("accounts"."subtype" IS NULL OR "accounts"."subtype" IN ('checking', 'savings', 'money_market', 'cd', 'cash_management'));--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tax_treatment_check" CHECK ("accounts"."tax_treatment" IS NULL OR "accounts"."tax_treatment" IN ('taxable', 'tax_deferred', 'roth', 'hsa'));--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_apy_range_check" CHECK ("accounts"."apy" IS NULL OR ("accounts"."apy" >= 0 AND "accounts"."apy" <= 100));--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_necessity_check" CHECK ("categories"."necessity" IS NULL OR "categories"."necessity" IN ('essential', 'discretionary', 'savings'));