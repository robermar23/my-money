import "server-only";

import { db } from "@/db/client.ts";
import { type User, users } from "@/db/schema/users.ts";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSession } from "./session.ts";

/**
 * Server-side guard: returns the authenticated user, or redirects to /login.
 *
 * Use at the top of every authenticated server component and server action:
 *
 *   const user = await requireUser();
 *
 * Per CLAUDE.md §Privacy & Data Sovereignty, there is exactly one user — this
 * function therefore answers "is the cookie valid and does the user row still exist?"
 */
export async function requireUser(): Promise<User> {
  const session = await getSession();
  if (!session.userId) {
    redirect("/login");
  }

  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) {
    // Session points at a user that no longer exists — destroy it and redirect.
    session.destroy();
    redirect("/login");
  }

  return user;
}

/**
 * Returns the user count without authentication. Used by the setup wizard to
 * detect "first run".
 */
export async function userCount(): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}
