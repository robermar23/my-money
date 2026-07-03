"use client";

import { DASHBOARD_RANGES, type DashboardRange } from "@/lib/dashboard/range.ts";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Dashboard range toggle (Phase 13, P13-05, ADR-029 §3).
 *
 * The *only* client state on the dashboard: a segmented control that writes the
 * shared `?range=` param. State lives in the URL (per ADR-003 — URL params handle
 * navigation/filter state; no store), so the server re-renders the hero history +
 * performance card with the new window and the view stays shareable / refresh-
 * stable / back-button-correct. It sets only `range` and leaves every other param
 * untouched. Rendered as an accessible `radiogroup`.
 */

interface Props {
  /** The currently active range (server-parsed, so the highlight is authoritative). */
  readonly active: DashboardRange;
}

export function RangeToggle({ active }: Props): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function select(range: DashboardRange): void {
    const sp = new URLSearchParams(params.toString());
    sp.set("range", range);
    router.push(`${pathname}?${sp.toString()}`);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="inline-flex flex-wrap items-center gap-1"
    >
      {DASHBOARD_RANGES.map((r) => {
        const isActive = r.key === active;
        return (
          <button
            key={r.key}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: intentional ARIA segmented control (radiogroup + radio buttons), not a native <input type="radio"> — matches the toggle pattern the plan specifies
            role="radio"
            aria-checked={isActive}
            onClick={() => select(r.key)}
            className={`rounded-md px-2.5 py-1 text-sm ${
              isActive
                ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}
