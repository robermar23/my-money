CREATE TABLE "securities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plaid_security_id" text,
	"symbol" text NOT NULL,
	"ticker_symbol" text,
	"cusip" text,
	"name" text NOT NULL,
	"type" text,
	"is_cash_equivalent" boolean DEFAULT false NOT NULL,
	"iso_currency_code" text DEFAULT 'USD' NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holding_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"acquired_at" date,
	"quantity" numeric(28, 8) NOT NULL,
	"cost_basis_total" numeric(18, 2) NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"plaid_investment_transaction_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holding_lots_source_check" CHECK ("holding_lots"."source" IN ('manual', 'plaid'))
);
--> statement-breakpoint
CREATE TABLE "investment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"security_id" uuid,
	"plaid_investment_transaction_id" text,
	"type" text NOT NULL,
	"subtype" text,
	"trade_date" date NOT NULL,
	"quantity" numeric(28, 8),
	"price" numeric(18, 8),
	"fees" numeric(18, 2),
	"amount" numeric(18, 2) NOT NULL,
	"name" text,
	"iso_currency_code" text DEFAULT 'USD' NOT NULL,
	"source" text NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_txns_type_check" CHECK ("investment_transactions"."type" IN ('buy', 'sell', 'cash', 'fee', 'transfer', 'cancel')),
	CONSTRAINT "investment_txns_source_check" CHECK ("investment_transactions"."source" IN ('plaid', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "holdings" ADD COLUMN "security_id" uuid;--> statement-breakpoint
ALTER TABLE "holdings" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "holdings" ADD COLUMN "cost_basis_overridden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "holding_lots" ADD CONSTRAINT "holding_lots_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_transactions" ADD CONSTRAINT "investment_transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_transactions" ADD CONSTRAINT "investment_transactions_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "securities_plaid_security_id_unique" ON "securities" USING btree ("plaid_security_id") WHERE "securities"."plaid_security_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "holding_lots_holding_id_idx" ON "holding_lots" USING btree ("holding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "holding_lots_holding_plaid_txn_unique" ON "holding_lots" USING btree ("holding_id","plaid_investment_transaction_id") WHERE "holding_lots"."plaid_investment_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "investment_txns_account_plaid_id_unique" ON "investment_transactions" USING btree ("account_id","plaid_investment_transaction_id") WHERE "investment_transactions"."plaid_investment_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "investment_txns_account_trade_date_idx" ON "investment_transactions" USING btree ("account_id","trade_date" DESC);--> statement-breakpoint
CREATE INDEX "investment_txns_security_id_idx" ON "investment_transactions" USING btree ("security_id");--> statement-breakpoint
CREATE INDEX "investment_txns_subtype_idx" ON "investment_transactions" USING btree ("subtype") WHERE "investment_transactions"."subtype" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holdings_security_id_idx" ON "holdings" USING btree ("security_id");--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_source_check" CHECK ("holdings"."source" IN ('manual', 'plaid'));