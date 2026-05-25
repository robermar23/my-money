import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Users table.
 *
 * my-money is single-user (per CLAUDE.md §Domain Scope). This table will have
 * exactly one row — created via the /setup wizard on first run, never via signup.
 * Password is hashed with argon2id at the application layer (see src/lib/auth/password.ts).
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
