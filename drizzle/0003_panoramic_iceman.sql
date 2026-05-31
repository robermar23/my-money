CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source" text NOT NULL,
	"filename" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"raw_file" "bytea",
	"parsed_payload" jsonb,
	"parser_metadata" jsonb,
	"statement_start" date,
	"statement_end" date,
	"statement_ending_balance" numeric(18, 2),
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"invalid_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "import_batches_status_check" CHECK ("import_batches"."status" IN ('pending', 'previewed', 'confirmed', 'failed')),
	CONSTRAINT "import_batches_source_check" CHECK ("import_batches"."source" IN ('qfx', 'csv'))
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"posted_at" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"name" text NOT NULL,
	"memo" text,
	"category" text,
	"category_overridden_at" timestamp with time zone,
	"fitid" text NOT NULL,
	"source" text NOT NULL,
	"import_batch_id" uuid,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_source_check" CHECK ("transactions"."source" IN ('qfx', 'csv', 'manual', 'plaid'))
);
--> statement-breakpoint
CREATE TABLE "category_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pattern" text NOT NULL,
	"flags" text DEFAULT 'i' NOT NULL,
	"field" text DEFAULT 'name' NOT NULL,
	"category" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_rules_field_check" CHECK ("category_rules"."field" IN ('name', 'memo'))
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batches_account_uploaded_at_idx" ON "import_batches" USING btree ("account_id","uploaded_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_account_fitid_unique" ON "transactions" USING btree ("account_id","fitid");--> statement-breakpoint
CREATE INDEX "transactions_account_posted_at_idx" ON "transactions" USING btree ("account_id","posted_at" DESC);--> statement-breakpoint
CREATE INDEX "transactions_category_idx" ON "transactions" USING btree ("category") WHERE "transactions"."category" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "category_rules_priority_idx" ON "category_rules" USING btree ("priority") WHERE "category_rules"."enabled" = true;