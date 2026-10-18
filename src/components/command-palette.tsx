"use client";

import { openHelp } from "@/lib/help/events.ts";
import type { HelpRoute } from "@/lib/help/routes.ts";
import type { searchHelp } from "@/lib/help/search.ts";
import type { SearchResult, SearchResultKind } from "@/lib/search/global.ts";
import { searchPages } from "@/lib/search/pages.ts";
import { MIN_SEARCH_TERM_LENGTH } from "@/lib/search/term.ts";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * Global ⌘K command palette (Phase 12, P12-14, ADR-027/028).
 *
 * A single thin client island, mounted once from {@link ../components/app-nav}
 * so it is reachable on every authenticated page — the literal "search on every
 * page" of Round 6. It opens on **⌘K / Ctrl-K** or via the nav trigger (which
 * dispatches {@link OPEN_COMMAND_PALETTE_EVENT}), debounces input, and `fetch`es
 * the internal, session-guarded `GET /api/search` ([../app/api/search/route]).
 *
 * Results are *jump targets*: selecting one `router.push`es to its `href`. The
 * palette **never mutates** — no result is editable (ADR-027).
 *
 * Since ADR-035 the first group is **Pages**: every nav-manifest destination,
 * matched locally and synchronously by {@link searchPages} with no query and no
 * round-trip, so it paints before the debounced record search resolves. That is
 * what makes a two-level nav safe — a page three clicks deep in a dropdown is
 * still one keystroke away (NAV-11).
 *
 * **Privacy (CLAUDE.md §Privacy — binding):** the only network call is to our own
 * same-origin handler; the term is never logged. In-flight requests are cancelled
 * via `AbortController` on each keystroke (CLAUDE.md §Performance: debounce + abort
 * input-driven ops), so we never race stale results onto the screen.
 *
 * Accessibility: a `combobox`/`listbox`/`option` pattern with `aria-activedescendant`
 * (the active option is highlighted without moving DOM focus off the input);
 * Arrow ↑/↓ move the selection, Enter navigates, Esc/backdrop close, and Tab is
 * trapped within the dialog.
 */

/**
 * Window event that opens the palette. The nav trigger dispatches it so a button
 * anywhere in the chrome can open the single mounted island without prop-drilling
 * or a shared store.
 */
export const OPEN_COMMAND_PALETTE_EVENT = "money:open-command-palette";

/** Debounce before firing a search request, in ms (matches ADR-027's 250 ms). */
const DEBOUNCE_MS = 250;

/** Human-facing group headers, in the order {@link globalSearch} returns them. */
const GROUP_LABELS: Record<SearchResultKind, string> = {
  page: "Pages",
  help: "Help",
  account: "Accounts",
  category: "Categories",
  security: "Securities",
  watchlist: "Watchlist",
  transaction: "Transactions",
};

const GROUP_ORDER: readonly SearchResultKind[] = [
  "page",
  "help",
  "account",
  "category",
  "security",
  "watchlist",
  "transaction",
];

/** One contiguous run of results sharing a `kind`, for rendering group headers. */
interface ResultGroup {
  readonly kind: SearchResultKind;
  /** Flat indices into the results array, so keyboard nav stays a single list. */
  readonly items: readonly { readonly result: SearchResult; readonly index: number }[];
}

/**
 * Bucket the flat, pre-ordered results into display groups while preserving each
 * result's flat index (the index the keyboard navigation operates on).
 */
function groupResults(results: readonly SearchResult[]): ResultGroup[] {
  const byKind = new Map<SearchResultKind, { result: SearchResult; index: number }[]>();
  let index = 0;
  for (const result of results) {
    const bucket = byKind.get(result.kind) ?? [];
    bucket.push({ result, index });
    byKind.set(result.kind, bucket);
    index++;
  }
  const groups: ResultGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const items = byKind.get(kind);
    if (items && items.length > 0) groups.push({ kind, items });
  }
  return groups;
}

interface SearchApiResponse {
  readonly results: readonly SearchResult[];
}

export function CommandPalette(): React.JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // The help matcher imports every page's help, so it loads on first open
  // rather than riding in the chrome's bundle (PLAN20 P20-07).
  const [helpSearch, setHelpSearch] = useState<typeof searchHelp | null>(null);
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<readonly SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = useCallback((i: number): string => `${baseId}-option-${i}`, [baseId]);

  const close = useCallback((): void => {
    setOpen(false);
    setQuery("");
    setRecords([]);
    setActiveIndex(-1);
    setLoading(false);
  }, []);

  // Global open: ⌘K / Ctrl-K, plus the nav trigger's custom event.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpenEvent = (): void => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    };
  }, []);

  useEffect(() => {
    if (!open || helpSearch !== null) return;
    let current = true;
    void import("@/lib/help/search.ts")
      .then((mod) => {
        if (current) setHelpSearch(() => mod.searchHelp);
      })
      .catch(() => {
        // No Help group is better than a broken palette.
      });
    return () => {
      current = false;
    };
  }, [open, helpSearch]);

  // Focus the input when the palette opens; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Debounced, abortable search. Short terms short-circuit to no request (the
  // server would return [] anyway — this just spares the round-trip).
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < MIN_SEARCH_TERM_LENGTH) {
      setRecords([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
            signal: controller.signal,
          });
          if (!res.ok) {
            setRecords([]);
            setLoading(false);
            return;
          }
          const data = (await res.json()) as SearchApiResponse;
          setRecords(data.results);
          setLoading(false);
        } catch (err) {
          // A cancelled keystroke is expected; swallow it. Never log the term.
          if ((err as Error).name !== "AbortError") {
            setRecords([]);
            setLoading(false);
          }
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  // Pages are matched in-process from the nav manifest, so they are available
  // on the keystroke — no debounce, no request. Records arrive afterwards and
  // append below them.
  // Help is local too, and comes straight after Pages: "Help: <this page>"
  // first, then entries matching the query. The flat order must match
  // GROUP_ORDER so keyboard order matches what is drawn.
  const pages = useMemo(() => searchPages(query), [query]);
  const help = useMemo(
    () => (helpSearch ? helpSearch(query, pathname) : []),
    [helpSearch, query, pathname],
  );
  const results = useMemo<readonly SearchResult[]>(
    () => [...pages, ...help, ...records],
    [pages, help, records],
  );

  // Keep the highlight on the first result as the list changes underneath it
  // (pages paint first, records land ~250 ms later and extend the same list).
  useEffect(() => {
    setActiveIndex(results.length > 0 ? 0 : -1);
  }, [results]);

  const select = useCallback(
    (result: SearchResult): void => {
      close();
      if (result.kind === "help") {
        // Go to the page (unless it has an `<id>`, when href is where we
        // already are), then open the panel on that page's help. A help
        // result's id is its route pattern, set by searchHelp.
        if (result.href !== pathname) {
          router.push(result.href as Parameters<typeof router.push>[0]);
        }
        openHelp(result.id as HelpRoute);
        return;
      }
      // hrefs are app-internal jump targets built server-side in globalSearch.
      router.push(result.href as Parameters<typeof router.push>[0]);
    },
    [close, router, pathname],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (results.length === 0 ? -1 : Math.min(i + 1, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (results.length === 0 ? -1 : Math.max(i - 1, 0)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = results[activeIndex];
      if (chosen) select(chosen);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  // Trap Tab within the dialog so focus never escapes to the page behind it.
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Keep the active option scrolled into view as Arrow keys move it.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, optionId]);

  if (!open) return null;

  const term = query.trim();
  const tooShort = term.length > 0 && term.length < MIN_SEARCH_TERM_LENGTH;
  const groups = groupResults(results);
  const showEmpty = !loading && term.length >= MIN_SEARCH_TERM_LENGTH && results.length === 0;
  // Pages render immediately; only the record half is still in flight.
  const showSpinner = loading && results.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
      role="presentation"
      onMouseDown={(e) => {
        // Backdrop click (not a click bubbling up from the panel) closes.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={onDialogKeyDown}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-2 border-zinc-200 border-b px-3 dark:border-zinc-800">
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4 shrink-0 text-zinc-400"
            fill="none"
            stroke="currentColor"
            role="img"
            aria-hidden="true"
          >
            <title>Search</title>
            <circle cx="11" cy="11" r="7" strokeWidth="2" />
            <path strokeWidth="2" strokeLinecap="round" d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search accounts, transactions, securities…"
            aria-label="Search accounts, transactions, securities, categories, and watchlist"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-zinc-400"
          />
          <button
            type="button"
            onClick={close}
            aria-label="Close search"
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 ring-1 ring-zinc-200 ring-inset hover:text-zinc-700 dark:ring-zinc-700 dark:hover:text-zinc-200"
          >
            Esc
          </button>
        </div>

        <div
          role="listbox"
          id={listboxId}
          aria-label="Search results"
          className="max-h-[60vh] overflow-y-auto py-1"
        >
          {tooShort && (
            <div className="px-3 py-6 text-center text-sm text-zinc-400">
              Keep typing to search…
            </div>
          )}
          {showSpinner && (
            <div className="px-3 py-6 text-center text-sm text-zinc-400">Searching…</div>
          )}
          {showEmpty && (
            <div className="px-3 py-6 text-center text-sm text-zinc-400">
              No matches for “{term}”.
            </div>
          )}
          {groups.map((group) => (
            <div key={group.kind} role="group" aria-label={GROUP_LABELS[group.kind]}>
              <div
                aria-hidden="true"
                className="px-3 pt-2 pb-1 font-medium text-[11px] text-zinc-400 uppercase tracking-wide"
              >
                {GROUP_LABELS[group.kind]}
              </div>
              {group.items.map(({ result, index }) => {
                const isActive = index === activeIndex;
                return (
                  <button
                    key={result.id}
                    type="button"
                    id={optionId(index)}
                    role="option"
                    aria-selected={isActive}
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => select(result)}
                    className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm ${
                      isActive ? "bg-zinc-100 dark:bg-zinc-800" : ""
                    }`}
                  >
                    <span className="truncate text-zinc-900 dark:text-zinc-50">{result.title}</span>
                    {result.subtitle && (
                      <span className="ml-auto truncate text-xs text-zinc-400">
                        {result.subtitle}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
