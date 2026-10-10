CREATE TABLE "planned_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"due_date" date NOT NULL,
	"accrual_start_date" date NOT NULL,
	"category_id" uuid,
	"status" text DEFAULT 'planned' NOT NULL,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planned_expenses_status_check" CHECK ("planned_expenses"."status" IN ('planned', 'paid', 'cancelled')),
	CONSTRAINT "planned_expenses_amount_non_negative_check" CHECK ("planned_expenses"."amount" >= 0),
	CONSTRAINT "planned_expenses_date_order_check" CHECK ("planned_expenses"."accrual_start_date" <= "planned_expenses"."due_date")
);
--> statement-breakpoint
ALTER TABLE "planned_expenses" ADD CONSTRAINT "planned_expenses_category_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planned_expenses_status_due_date_idx" ON "planned_expenses" USING btree ("status","due_date");