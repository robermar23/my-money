CREATE TABLE "holding_snapshots" (
	"holding_id" uuid NOT NULL,
	"date" date NOT NULL,
	"quantity" numeric(28, 8) NOT NULL,
	"value" numeric(18, 2) NOT NULL,
	"cost_basis" numeric(18, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	CONSTRAINT "holding_snapshots_holding_id_date_pk" PRIMARY KEY("holding_id","date")
);
--> statement-breakpoint
ALTER TABLE "holding_snapshots" ADD CONSTRAINT "holding_snapshots_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holding_snapshots_date_idx" ON "holding_snapshots" USING btree ("date");