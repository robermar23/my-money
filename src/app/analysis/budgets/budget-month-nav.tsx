"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

interface Props {
  /** Active month, `YYYY-MM`. */
  readonly month: string;
}

/** Shift a `YYYY-MM` key by `delta` whole months (UTC, no TZ drift). */
function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7)) - 1; // 0-based
  const d = new Date(Date.UTC(year, mon + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Human label, e.g. "June 2026". */
function label(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/**
 * Month switcher for the budgets page (P8-19). State lives in the `month` URL
 * search param (per ADR-003: URL params handle filter state) so the server
 * component re-computes actual-vs-target on every change.
 */
export function BudgetMonthNav({ month }: Props): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function go(next: string): void {
    const sp = new URLSearchParams(params.toString());
    sp.set("month", next);
    router.push(`${pathname}?${sp.toString()}`);
  }

  const btn =
    "rounded-md border border-zinc-300 px-2 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={btn}
        onClick={() => go(shiftMonth(month, -1))}
        aria-label="Previous month"
      >
        ←
      </button>
      <span className="min-w-36 text-center font-medium text-sm">{label(month)}</span>
      <button
        type="button"
        className={btn}
        onClick={() => go(shiftMonth(month, 1))}
        aria-label="Next month"
      >
        →
      </button>
    </div>
  );
}
