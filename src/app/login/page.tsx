import { db } from "@/db/client.ts";
import { users } from "@/db/schema/index.ts";
import { getSession } from "@/lib/auth/session.ts";
import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { LoginForm } from "./login-form.tsx";

export default async function LoginPage(): Promise<React.JSX.Element> {
  // Already signed in? Just bounce to the dashboard.
  const session = await getSession();
  if (session.userId) {
    redirect("/");
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
