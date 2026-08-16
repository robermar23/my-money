import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * recommendation_dismissals: the ONLY persisted advice state in the app
 * (Phase 15, PLAN15 P15-05, ADR-032 §3).
 *
 * Recommendations themselves are COMPUTED ON READ and never stored — the same
 * principle as ADR-020's unstored dividend yield and ADR-031's derived savings
 * rate. A stored recommendation is a recommendation that goes stale silently,
 * and recomputation from a fresh snapshot is cheap. If you find yourself adding
 * a `recommendations` table, re-read ADR-032 first.
 *
 * A dismissal is different in kind: "I have consciously rejected this" is USER
 * INTENT, not a derived figure. Nothing else in the system can reconstruct it,
 * and re-nagging about a consciously-rejected item is precisely the failure
 * mode ADR-026 already rejected for price-target alerts. So this, and only
 * this, is written down.
 *
 * ── The key ────────────────────────────────────────────────────────────────
 * `(rule_id, subject_key)` is UNIQUE, and `subject_key` is the per-subject
 * discriminator: an account id, a category id, or `''` for a whole-rule
 * dismissal. Empty string rather than NULL on purpose — NULL would defeat the
 * unique constraint (NULLs are never equal in Postgres), letting the same
 * whole-rule dismissal be inserted repeatedly. With `''` the dismiss action is
 * a plain UPSERT on a real key.
 *
 * Dismissing "you have no budget for Groceries" must not also dismiss "you have
 * no budget for Auto", which is why the subject is part of the key at all.
 *
 * ── Dismiss vs. snooze ─────────────────────────────────────────────────────
 * `snooze_until IS NULL` ⇒ dismissed indefinitely (until the user undoes it
 * from the dismissed-items view, P15-34). `snooze_until` set ⇒ suppressed only
 * while `snooze_until > now`, after which the recommendation reappears on its
 * own. The engine (P15-23) applies both filters; nothing here expires rows, so
 * the history of what the user rejected stays inspectable.
 */
export const recommendationDismissals = pgTable(
  "recommendation_dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The `RuleId` of the dismissed recommendation (see
     * `src/lib/advice/types.ts`). Plain text, not a FK — rule ids live in code,
     * and a renamed/retired rule should leave a harmless orphan row rather than
     * fail a migration.
     */
    ruleId: text("rule_id").notNull(),
    /**
     * Per-subject discriminator: an account id, a category id, or `''` for a
     * whole-rule dismissal. NEVER NULL — see the file header on why.
     */
    subjectKey: text("subject_key").notNull().default(""),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** NULL = dismissed indefinitely; a timestamp = suppressed until then. */
    snoozeUntil: timestamp("snooze_until", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // The idempotency key for the dismiss/snooze upsert (P15-34).
    ruleSubjectUnique: uniqueIndex("recommendation_dismissals_rule_subject_unique").on(
      table.ruleId,
      table.subjectKey,
    ),
    // A blank rule id would be a silent catch-all; reject it at the boundary.
    ruleIdNonEmptyCheck: check(
      "recommendation_dismissals_rule_id_check",
      sql`length(${table.ruleId}) > 0`,
    ),
  }),
);

export type RecommendationDismissal = typeof recommendationDismissals.$inferSelect;
export type NewRecommendationDismissal = typeof recommendationDismissals.$inferInsert;
