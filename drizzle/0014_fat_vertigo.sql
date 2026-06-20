ALTER TABLE "securities" ADD COLUMN "sector" text;--> statement-breakpoint
ALTER TABLE "securities" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "securities" ADD COLUMN "asset_type" text;--> statement-breakpoint
ALTER TABLE "securities" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "securities" ADD COLUMN "expense_ratio" numeric(8, 4);--> statement-breakpoint
ALTER TABLE "securities" ADD COLUMN "dividend_rate" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "securities" ADD COLUMN "dividend_ex_date" date;--> statement-breakpoint
ALTER TABLE "securities" ADD COLUMN "fundamentals_refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "securities" ADD CONSTRAINT "securities_asset_type_check" CHECK ("securities"."asset_type" IS NULL OR "securities"."asset_type" IN ('equity','etf','mutual_fund','bond','crypto','cash','other'));