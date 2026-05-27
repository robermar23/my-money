import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Users table — exactly one row, ever.
 *
 * Per CLAUDE.md §Domain Scope, my-money is single-user. There is no email,
 * no username, no signup, no recovery flow, no notifications. The first
 * password set via /login becomes THE password. Forgotten? `make db-reset`
 * and re-bootstrap.
 *
 * `id` exists only so the session cookie has something stable to point at;
 * with one row the value is functionally irrelevant.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
