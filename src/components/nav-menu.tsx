"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * Responsive nav body (P6-17). A single inline row at `sm:` and up; a
 * hamburger-toggled column below it. Active link is derived from the current
 * pathname. The open-alert count drives the red badge next to "Alerts".
 *
 * `as const` on LINKS keeps each href a literal type so it satisfies Next's
 * typed-routes without casts.
 */
const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/accounts", label: "Accounts" },
  { href: "/investments", label: "Investments" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/analysis", label: "Analysis" },
  { href: "/settings/categories", label: "Categories" },
  { href: "/settings/connections", label: "Connections" },
  { href: "/alerts", label: "Alerts" },
] as const;

interface Props {
  readonly alertCount: number;
}

function Badge({ count }: { readonly count: number }): React.JSX.Element | null {
  if (count <= 0) return null;
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 font-medium text-white text-xs">
      {count}
    </span>
  );
}

function SignOut(): React.JSX.Element {
  return (
    <form action="/logout" method="post">
      <button
        type="submit"
        className="py-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
      >
        Sign out
      </button>
    </form>
  );
}

export function NavMenu({ alertCount }: Props): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string): boolean =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const linkClass = (href: string): string =>
    `flex items-center gap-1.5 ${
      isActive(href)
        ? "font-medium text-zinc-900 dark:text-zinc-50"
        : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
    }`;

  return (
    <>
      {/* Desktop: inline row */}
      <div className="hidden items-center gap-4 text-sm sm:flex">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={linkClass(l.href)}>
            {l.label}
            {l.href === "/alerts" && <Badge count={alertCount} />}
          </Link>
        ))}
        <SignOut />
      </div>

      {/* Mobile: hamburger toggle */}
      <button
        type="button"
        aria-label="Toggle navigation menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-10 w-10 items-center justify-center rounded-md text-zinc-700 hover:bg-zinc-100 sm:hidden dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          role="img"
          aria-hidden="true"
        >
          <title>Menu</title>
          {open ? (
            <path strokeWidth="2" strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          ) : (
            <path strokeWidth="2" strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
          )}
        </svg>
        {!open && alertCount > 0 && (
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-600" />
        )}
      </button>

      {/* Mobile: dropdown panel */}
      {open && (
        <div className="absolute inset-x-0 top-full z-20 border-zinc-200 border-b bg-white sm:hidden dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto flex max-w-5xl flex-col px-6 py-2 text-sm">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-1.5 py-2.5 ${
                  isActive(l.href)
                    ? "font-medium text-zinc-900 dark:text-zinc-50"
                    : "text-zinc-600 dark:text-zinc-400"
                }`}
              >
                {l.label}
                {l.href === "/alerts" && <Badge count={alertCount} />}
              </Link>
            ))}
            <div className="border-zinc-100 border-t py-2.5 dark:border-zinc-900">
              <SignOut />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
