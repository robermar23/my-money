import Link from "next/link";

/**
 * Top navigation chrome shown on authenticated pages.
 *
 * Server component — no client state needed for Phase 1. Active-link styling
 * arrives in Phase 6 polish.
 */
export function AppNav(): React.JSX.Element {
  return (
    <header className="border-zinc-200 border-b dark:border-zinc-800">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link href="/" className="font-semibold tracking-tight">
          my-money
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/" className="hover:underline">
            Dashboard
          </Link>
          <Link href="/accounts" className="hover:underline">
            Accounts
          </Link>
          <form action="/logout" method="post">
            <button
              type="submit"
              className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
            >
              Sign out
            </button>
          </form>
        </div>
      </nav>
    </header>
  );
}
