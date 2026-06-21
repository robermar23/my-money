ALTER TYPE "public"."account_type" ADD VALUE 'personal_asset';--> statement-breakpoint
CREATE TABLE "asset_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"description" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "asset_category" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "acquired_at" date;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "acquisition_cost" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_documents_account_uploaded_at_idx" ON "asset_documents" USING btree ("account_id","uploaded_at" DESC);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_asset_category_check" CHECK ("accounts"."asset_category" IS NULL OR "accounts"."asset_category" IN ('vehicle', 'watercraft', 'jewelry', 'collectible', 'other'));