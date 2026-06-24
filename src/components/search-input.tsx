"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

interface Props {
  /** The `searchParams` key this box reads/writes (default `"q"`). */
  readonly paramKey?: string;
  readonly placeholder?: string;
  /** Accessible label (visually hidden); also the input's `aria-label`. */
  readonly label?: string;
  /** Debounce before the URL is updated, in ms (default 250 per ADR-027). */
  readonly debounceMs?: number;
  readonly className?: string;
}

/**
 * Reusable debounced search box (Phase 12, P12-09, ADR-027).
 *
 * A thin client island shared by the growing list pages (accounts,
 * transactions, watchlist, investments). It keeps its state in the **URL** — on
 * each (debounced) change it pushes an updated `searchParams` value and **resets
 * `page` to 1**, so filtered views stay shareable, refresh-stable, and
 * back-button-correct (no client store, per CLAUDE.md §Architecture). The server
 * component re-renders the narrowed list.
 *
 * Controlled input mirrored from the URL: external changes (a "Clear filters"
 * link, browser back) flow back into the box. `Esc` and the × button clear it.
 */
export function SearchInput({
  paramKey = "q",
  placeholder = "Search…",
  label = "Search",
  debounceMs = 250,
  className,
}: Props): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get(paramKey) ?? "";
  const [value, setValue] = useState(current);
  const inputId = useId();

  // Reflect external URL changes (back/forward, a Clear-filters link that wipes
  // the param) back into the controlled input.
  const lastCurrent = useRef(current);
  useEffect(() => {
    if (current !== lastCurrent.current) {
      lastCurrent.current = current;
      setValue(current);
    }
  }, [current]);

  // Debounced push: only when the typed value diverges from the URL.
  useEffect(() => {
    if (value === current) return;
    const timer = setTimeout(() => {
      const sp = new URLSearchParams(params.toString());
      if (value === "") sp.delete(paramKey);
      else sp.set(paramKey, value);
      sp.delete("page"); // a new filter resets pagination to page 1
      lastCurrent.current = value;
      const qs = sp.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [value, current, params, paramKey, pathname, router, debounceMs]);

  return (
    <div className={`relative ${className ?? ""}`}>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <input
        id={inputId}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setValue("");
        }}
        className="w-full rounded-md border border-zinc-300 py-1.5 pr-8 pl-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
      {value !== "" && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => setValue("")}
          className="-translate-y-1/2 absolute top-1/2 right-2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          ✕
        </button>
      )}
    </div>
  );
}
