CREATE TABLE "income_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"cadence" text NOT NULL,
	"gross_per_period" numeric(18, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"anchor_date" date NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_sources_cadence_check" CHECK ("income_sources"."cadence" IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
	CONSTRAINT "income_sources_gross_non_negative_check" CHECK ("income_sources"."gross_per_period" >= 0),
	CONSTRAINT "income_sources_date_order_check" CHECK ("income_sources"."end_date" IS NULL OR "income_sources"."end_date" >= "income_sources"."start_date")
);
--> statement-breakpoint
CREATE TABLE "retirement_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"income_source_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"holding_id" uuid,
	"employee_basis" text NOT NULL,
	"employee_value" numeric(18, 4) NOT NULL,
	"pretax" boolean DEFAULT true NOT NULL,
	"match_basis" text DEFAULT 'none' NOT NULL,
	"match_value" numeric(18, 4) DEFAULT '0' NOT NULL,
	"match_cap_percent" numeric(7, 4),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_contributions_employee_basis_check" CHECK ("retirement_contributions"."employee_basis" IN ('percent', 'amount')),
	CONSTRAINT "retirement_contributions_match_basis_check" CHECK ("retirement_contributions"."match_basis" IN ('none', 'percent_of_gross', 'percent_of_contribution', 'amount')),
	CONSTRAINT "retirement_contributions_employee_value_check" CHECK ("retirement_contributions"."employee_value" >= 0
        AND ("retirement_contributions"."employee_basis" <> 'percent' OR "retirement_contributions"."employee_value" <= 100)),
	CONSTRAINT "retirement_contributions_match_value_check" CHECK ("retirement_contributions"."match_value" >= 0
        AND ("retirement_contributions"."match_basis" NOT IN ('percent_of_gross', 'percent_of_contribution')
             OR "retirement_contributions"."match_value" <= 100)),
	CONSTRAINT "retirement_contributions_match_cap_check" CHECK ("retirement_contributions"."match_cap_percent" IS NULL
        OR ("retirement_contributions"."match_cap_percent" >= 0 AND "retirement_contributions"."match_cap_percent" <= 100))
);
--> statement-breakpoint
CREATE TABLE "income_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retirement_contribution_id" uuid NOT NULL,
	"pay_date" date NOT NULL,
	"gross_amount" numeric(18, 2) NOT NULL,
	"employee_amount" numeric(18, 2) NOT NULL,
	"employer_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"investment_transaction_id" uuid,
	"holding_lot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_contributions_amounts_non_negative_check" CHECK ("income_contributions"."gross_amount" >= 0
        AND "income_contributions"."employee_amount" >= 0
        AND "income_contributions"."employer_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "holding_lots" DROP CONSTRAINT "holding_lots_source_check";--> statement-breakpoint
ALTER TABLE "investment_transactions" DROP CONSTRAINT "investment_txns_source_check";--> statement-breakpoint
ALTER TABLE "retirement_contributions" ADD CONSTRAINT "retirement_contributions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_contributions" ADD CONSTRAINT "retirement_contributions_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_contributions" ADD CONSTRAINT "retirement_contributions_source_fk" FOREIGN KEY ("income_source_id") REFERENCES "public"."income_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_contributions" ADD CONSTRAINT "income_contributions_rule_fk" FOREIGN KEY ("retirement_contribution_id") REFERENCES "public"."retirement_contributions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_contributions" ADD CONSTRAINT "income_contributions_investment_txn_fk" FOREIGN KEY ("investment_transaction_id") REFERENCES "public"."investment_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_contributions" ADD CONSTRAINT "income_contributions_holding_lot_fk" FOREIGN KEY ("holding_lot_id") REFERENCES "public"."holding_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "income_sources_active_idx" ON "income_sources" USING btree ("start_date") WHERE "income_sources"."active" = true;--> statement-breakpoint
CREATE INDEX "retirement_contributions_income_source_id_idx" ON "retirement_contributions" USING btree ("income_source_id");--> statement-breakpoint
CREATE INDEX "retirement_contributions_account_id_idx" ON "retirement_contributions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "retirement_contributions_holding_id_idx" ON "retirement_contributions" USING btree ("holding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_contributions_rule_pay_date_unique" ON "income_contributions" USING btree ("retirement_contribution_id","pay_date");--> statement-breakpoint
CREATE INDEX "income_contributions_investment_transaction_id_idx" ON "income_contributions" USING btree ("investment_transaction_id");--> statement-breakpoint
CREATE INDEX "income_contributions_holding_lot_id_idx" ON "income_contributions" USING btree ("holding_lot_id");--> statement-breakpoint
ALTER TABLE "holding_lots" ADD CONSTRAINT "holding_lots_source_check" CHECK ("holding_lots"."source" IN ('manual', 'plaid', 'income'));--> statement-breakpoint
ALTER TABLE "investment_transactions" ADD CONSTRAINT "investment_txns_source_check" CHECK ("investment_transactions"."source" IN ('plaid', 'manual', 'income'));