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
    // Session points at a user that no longer exists (e.g. after a db-reset).
    // We must NOT clear the cookie here: requireUser runs inside Server
    // Component renders, and cookie mutation is only legal in a Server Action
    // or Route Handler (Next throws otherwise). Just redirect — the stale
    // cookie is inert (it resolves to no user) and gets overwritten by the
    // next successful `loginOrBootstrap`. LoginPage tolerates a stale userId
    // so this doesn't loop.
    redirect("/login");
  }

  return user;
}
