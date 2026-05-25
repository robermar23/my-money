CREATE TYPE "public"."account_type" AS ENUM('depository', 'credit_card', 'investment', 'crypto_ira', 'loan', 'property');--> statement-breakpoint
CREATE TYPE "public"."asset_class" AS ENUM('equity', 'crypto', 'physical_metal', 'cash', 'property');--> statement-breakpoint
CREATE TYPE "public"."quantity_unit" AS ENUM('shares', 'coin', 'troy_oz', 'usd');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"institution" text NOT NULL,
	"type" "account_type" NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"quantity" numeric(28, 8) NOT NULL,
	"quantity_unit" "quantity_unit" NOT NULL,
	"asset_class" "asset_class" NOT NULL,
	"cost_basis" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_snapshots" (
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"balance" numeric(18, 2) NOT NULL,
	CONSTRAINT "account_snapshots_account_id_date_pk" PRIMARY KEY("account_id","date")
);
--> statement-breakpoint
CREATE TABLE "liabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"principal_at_origination" numeric(18, 2) NOT NULL,
	"annual_rate" numeric(8, 6) NOT NULL,
	"term_months" integer NOT NULL,
	"start_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "liabilities_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"symbol" text NOT NULL,
	"date" date NOT NULL,
	"close" numeric(18, 8) NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	CONSTRAINT "prices_symbol_date_pk" PRIMARY KEY("symbol","date")
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"date" date NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric(28, 12) NOT NULL,
	CONSTRAINT "fx_rates_date_base_quote_pk" PRIMARY KEY("date","base","quote")
);
--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_snapshots" ADD CONSTRAINT "account_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holdings_account_symbol_unique" ON "holdings" USING btree ("account_id","symbol");