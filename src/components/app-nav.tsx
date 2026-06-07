import { openAlertCount } from "@/lib/alerts/queries.ts";
import Link from "next/link";

/**
 * Top navigation chrome shown on authenticated pages.
 *
 * Server component. Reads the open-alert count for the nav badge (P6-15).
 * Active-link styling + a responsive/collapsing layout arrive in P6-17.
 */
export async function AppNav(): Promise<React.JSX.Element> {
  const alertCount = await openAlertCount();

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
          <Link href="/settings/categories" className="hover:underline">
            Categories
          </Link>
          <Link href="/settings/connections" className="hover:underline">
            Connections
          </Link>
          <Link href="/alerts" className="flex items-center gap-1 hover:underline">
            Alerts
            {alertCount > 0 && (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 font-medium text-white text-xs">
                {alertCount}
              </span>
            )}
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
