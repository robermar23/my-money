import { openAlertCount } from "@/lib/alerts/queries.ts";
import Link from "next/link";
import { NavMenu } from "./nav-menu.tsx";

/**
 * Top navigation chrome shown on authenticated pages.
 *
 * Server component — reads the open-alert count for the badge (P6-15), then
 * hands the interactive, responsive body to the `NavMenu` client island (P6-17).
 * `relative` anchors the mobile dropdown panel (`top-full`).
 */
export async function AppNav(): Promise<React.JSX.Element> {
  const alertCount = await openAlertCount();

  return (
    <header className="relative border-zinc-200 border-b dark:border-zinc-800">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link href="/" className="font-semibold tracking-tight">
          my-money
        </Link>
        <NavMenu alertCount={alertCount} />
      </nav>
    </header>
  );
}
