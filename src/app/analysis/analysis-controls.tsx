"use client";

import { RANGE_PRESETS, type RangeKey } from "@/lib/analytics/range.ts";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

interface AccountOption {
  readonly id: string;
  readonly name: string;
}

interface Props {
  readonly activeKey: RangeKey;
  readonly accounts: readonly AccountOption[];
  readonly activeAccountId: string | null;
  /** Current custom range (echoed into the date inputs). */
  readonly from: string;
  readonly to: string;
}

/**
 * Range + account filter island for the analysis surface (P8-13). All state
 * lives in the URL search params (per ADR-003: URL params handle filter state)
 * so the server component re-renders with fresh aggregations on every change and
 * the view is shareable/bookmarkable.
 */
export function AnalysisControls({
  activeKey,
  accounts,
  activeAccountId,
  from,
  to,
}: Props): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);

  function push(next: Record<string, string | null>): void {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") sp.delete(k);
      else sp.set(k, v);
    }
    router.push(`${pathname}?${sp.toString()}`);
  }

  const presetClass = (key: RangeKey): string =>
    `rounded-md px-2.5 py-1 text-sm ${
      activeKey === key
        ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
        : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
    }`;

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={presetClass(p.key)}
            onClick={() => push({ range: p.key, from: null, to: null })}
          >
            {p.label}
          </button>
        ))}
      </div>

      {accounts.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">Account</span>
          <select
            value={activeAccountId ?? ""}
            onChange={(e) => push({ account: e.target.value || null })}
            className="rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex items-end gap-1.5">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">From</span>
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">To</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <button
          type="button"
          disabled={!customFrom || !customTo || customFrom > customTo}
          onClick={() => push({ range: "custom", from: customFrom, to: customTo })}
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm disabled:opacity-40 dark:border-zinc-700"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
