ALTER TABLE "scheduled_obligations" DROP CONSTRAINT "scheduled_obligations_source_check";--> statement-breakpoint
ALTER TABLE "scheduled_obligations" ADD COLUMN "liability_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduled_obligations" ADD CONSTRAINT "scheduled_obligations_liability_fk" FOREIGN KEY ("liability_id") REFERENCES "public"."liabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_obligations_liability_id_unique" ON "scheduled_obligations" USING btree ("liability_id") WHERE "scheduled_obligations"."liability_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_obligations" ADD CONSTRAINT "scheduled_obligations_source_check" CHECK ("scheduled_obligations"."source" IN ('detected', 'manual', 'liability'));