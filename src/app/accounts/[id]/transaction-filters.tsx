"use client";

import type { CategoryOption } from "@/components/category-picker.tsx";
import { UNCATEGORIZED } from "@/lib/schemas/search.ts";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

interface AccountOption {
  readonly id: string;
  readonly name: string;
}

interface Props {
  /** Categories for the category filter (reuses the page's option list). */
  readonly categories: readonly CategoryOption[];
  /**
   * When provided, renders an account selector — the cross-account
   * `/transactions` view (P12-12) uses it to optionally narrow to one account.
   * Omitted on the per-account page, where the account is fixed by the route.
   */
  readonly accounts?: readonly AccountOption[];
}

const fieldClass =
  "rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

/** The filter keys this bar owns, in apply order. `accountId` only when shown. */
const BASE_KEYS = ["q", "from", "to", "minAmount", "maxAmount", "categoryId"] as const;

/**
 * Structured transaction-filter bar (Phase 12, P12-11, ADR-027) — payee text,
 * amount min/max, date from/to, and a category select (incl. "Uncategorized").
 *
 * A thin client island: all state lives in the **URL** (`searchParams`), so the
 * server re-renders the filtered, paginated list and the view stays
 * shareable/refresh-stable (no client store, per CLAUDE.md §Architecture).
 * "Apply" pushes the composed params (resetting `page`); "Clear filters" wipes
 * them. The reusable account selector (cross-account view) is rendered only when
 * `accounts` is supplied. Money/date values stay strings — no float math here.
 */
export function TransactionFilters({ categories, accounts }: Props): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [q, setQ] = useState(params.get("q") ?? "");
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  const [minAmount, setMinAmount] = useState(params.get("minAmount") ?? "");
  const [maxAmount, setMaxAmount] = useState(params.get("maxAmount") ?? "");
  const [categoryId, setCategoryId] = useState(params.get("categoryId") ?? "");
  const [accountId, setAccountId] = useState(params.get("accountId") ?? "");

  // Group categories for <optgroup>, preserving first-seen group order.
  const grouped = useMemo(() => {
    const byGroup = new Map<string, CategoryOption[]>();
    for (const c of categories) {
      const key = c.groupName ?? "Ungrouped";
      const list = byGroup.get(key);
      if (list) list.push(c);
      else byGroup.set(key, [c]);
    }
    return [...byGroup.entries()];
  }, [categories]);

  // Active filters are counted from the URL (committed), not unsaved edits.
  const activeKeys = accounts ? [...BASE_KEYS, "accountId"] : BASE_KEYS;
  const activeCount = activeKeys.filter((k) => (params.get(k) ?? "") !== "").length;

  // Disable Apply on an impossible date range (ISO strings compare correctly;
  // the amount-range order is validated server-side to avoid float math here).
  const badDateRange = from !== "" && to !== "" && from > to;

  function apply(event: React.FormEvent): void {
    event.preventDefault();
    const sp = new URLSearchParams();
    const set = (key: string, value: string): void => {
      const v = value.trim();
      if (v !== "") sp.set(key, v);
    };
    set("q", q);
    set("from", from);
    set("to", to);
    set("minAmount", minAmount);
    set("maxAmount", maxAmount);
    set("categoryId", categoryId);
    if (accounts) set("accountId", accountId);
    const qs = sp.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function clear(): void {
    setQ("");
    setFrom("");
    setTo("");
    setMinAmount("");
    setMaxAmount("");
    setCategoryId("");
    setAccountId("");
    router.push(pathname);
  }

  return (
    <form
      onSubmit={apply}
      className="flex flex-wrap items-end gap-x-3 gap-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">Payee / memo</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search text…"
          className={`w-40 ${fieldClass}`}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">Min amount</span>
        <input
          type="text"
          inputMode="decimal"
          value={minAmount}
          onChange={(e) => setMinAmount(e.target.value)}
          placeholder="0.00"
          className={`w-24 font-mono ${fieldClass}`}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">Max amount</span>
        <input
          type="text"
          inputMode="decimal"
          value={maxAmount}
          onChange={(e) => setMaxAmount(e.target.value)}
          placeholder="0.00"
          className={`w-24 font-mono ${fieldClass}`}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">From</span>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className={fieldClass}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">To</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className={fieldClass}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">Category</span>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className={fieldClass}
        >
          <option value="">All categories</option>
          <option value={UNCATEGORIZED}>— Uncategorized —</option>
          {grouped.map(([groupName, opts]) => (
            <optgroup key={groupName} label={groupName}>
              {opts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {accounts && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">Account</span>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className={fieldClass}
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

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={badDateRange}
          className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900"
        >
          Apply filters
        </button>
        {activeCount > 0 && (
          <button type="button" onClick={clear} className="text-sm text-zinc-500 hover:underline">
            Clear filters ({activeCount})
          </button>
        )}
      </div>
      {badDateRange && (
        <p className="w-full text-red-600 text-xs dark:text-red-400">
          The start date must be on or before the end date.
        </p>
      )}
    </form>
  );
}
