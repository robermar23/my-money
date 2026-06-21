CREATE TABLE "watchlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"asset_class" "asset_class" NOT NULL,
	"label" text,
	"pretend_quantity" numeric(28, 8),
	"pretend_unit_cost" numeric(18, 8),
	"pretend_purchased_at" date,
	"currency" text DEFAULT 'USD' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_items_asset_class_check" CHECK ("watchlist_items"."asset_class" IN ('equity', 'crypto', 'physical_metal')),
	CONSTRAINT "watchlist_items_pretend_all_or_nothing_check" CHECK (("watchlist_items"."pretend_quantity" IS NULL) = ("watchlist_items"."pretend_unit_cost" IS NULL)
        AND ("watchlist_items"."pretend_quantity" IS NULL) = ("watchlist_items"."pretend_purchased_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "price_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watchlist_item_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"threshold" numeric(18, 8) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"triggered_at" timestamp with time zone,
	"triggered_price" numeric(18, 8),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_targets_direction_check" CHECK ("price_targets"."direction" IN ('above', 'below'))
);
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_type_check";--> statement-breakpoint
ALTER TABLE "price_targets" ADD CONSTRAINT "price_targets_watchlist_item_id_watchlist_items_id_fk" FOREIGN KEY ("watchlist_item_id") REFERENCES "public"."watchlist_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_items_symbol_asset_class_unique" ON "watchlist_items" USING btree ("symbol","asset_class");--> statement-breakpoint
CREATE INDEX "price_targets_watchlist_item_id_idx" ON "price_targets" USING btree ("watchlist_item_id");--> statement-breakpoint
CREATE INDEX "price_targets_active_idx" ON "price_targets" USING btree ("watchlist_item_id") WHERE "price_targets"."active" = true;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_type_check" CHECK ("alerts"."type" IN ('large_transaction', 'balance_drop', 'item_login_required', 'stale_snapshot', 'stale_price', 'sync_failure', 'backup_failure', 'price_target'));