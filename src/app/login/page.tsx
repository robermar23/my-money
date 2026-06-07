import { db } from "@/db/client.ts";
import { users } from "@/db/schema/index.ts";
import { getSession } from "@/lib/auth/session.ts";
import { eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { LoginForm } from "./login-form.tsx";

export default async function LoginPage(): Promise<React.JSX.Element> {
  // Already signed in (cookie resolves to a real user)? Bounce to the dashboard.
  // A stale cookie (userId set but the row is gone, e.g. after a db-reset) is
  // treated as logged-out: we render the form instead of bouncing to `/`, which
  // would ping-pong with requireUser's redirect-to-login. The form's submit
  // overwrites the stale session via `loginOrBootstrap`.
  const session = await getSession();
  if (session.userId) {
    const [current] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    if (current) {
      redirect("/");
    }
  }

  // No user row yet = first-run. The form's submit sets the password.
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  const isFirstRun = (row?.count ?? 0) === 0;

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <h1 className="font-semibold text-3xl tracking-tight">my-money</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {isFirstRun
            ? "Set a password. This becomes the only password for this instance."
            : "Enter your password."}
        </p>
        <div className="mt-6">
          <LoginForm isFirstRun={isFirstRun} />
        </div>
      </div>
    </main>
  );
}
