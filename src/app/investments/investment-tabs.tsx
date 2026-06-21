import Link from "next/link";

/**
 * Sub-navigation for the investments surface (P9-22): Overview / Performance /
 * Forecast. A plain server component — the active tab is passed in rather than
 * derived from `usePathname()`, so this stays JS-free and rendered server-side
 * (the top-level {@link import('@/components/nav-menu.tsx').NavMenu} still owns
 * the global `/investments` entry). The per-security detail pages link back
 * here via the "Overview" tab.
 */

type Tab = "overview" | "performance" | "forecast";

const TABS: readonly { key: Tab; label: string; href: string }[] = [
  { key: "overview", label: "Overview", href: "/investments" },
  { key: "performance", label: "Performance", href: "/investments/performance" },
  { key: "forecast", label: "Forecast", href: "/investments/forecast" },
];

interface Props {
  readonly active: Tab;
}

export function InvestmentTabs({ active }: Props): React.JSX.Element {
  return (
    <nav className="flex items-center gap-4 text-sm" aria-label="Investments sections">
      {TABS.map((t) =>
        t.key === active ? (
          <span key={t.key} className="font-medium text-zinc-900 dark:text-zinc-50">
            {t.label}
          </span>
        ) : (
          <Link key={t.key} href={t.href} className="text-zinc-500 hover:underline">
            {t.label}
          </Link>
        ),
      )}
    </nav>
  );
}
