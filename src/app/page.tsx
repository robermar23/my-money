import { userCount } from "@/lib/auth/require-user.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { redirect } from "next/navigation";

export default async function HomePage(): Promise<React.JSX.Element> {
  // First-run gate: no users exist yet → go to setup wizard.
  if ((await userCount()) === 0) {
    redirect("/setup");
  }

  const user = await requireUser();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h1 className="font-semibold text-3xl tracking-tight">my-money</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Signed in as <span className="font-mono">{user.email}</span>.
        </p>
        <p className="mt-4 text-sm text-zinc-500">
          Phase 0 bedrock — accounts and dashboard arrive in Phase 1.
        </p>
        <form action="/logout" method="post" className="mt-8">
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
