import "server-only";

import { db } from "@/db/client.ts";
import {
  accounts,
  categories,
  securities,
  transactions,
  watchlistItems,
} from "@/db/schema/index.ts";
import { type SQL, desc, eq, sql } from "drizzle-orm";
import { similarityRank, trigramIlikeAny } from "./predicates.ts";
import { sanitizeSearchTerm } from "./term.ts";

/**
 * Global (⌘K palette) cross-entity search (Phase 12, P12-08, ADR-027/028).
 *
 * Runs the capped, trigram-ranked group queries that back the command palette —
 * accounts, categories, securities, watchlist items, and the top transaction
 * matches across **all** accounts. Each group is a `… WHERE trigramIlike(...)
 * ORDER BY similarity(...) DESC LIMIT n` query; the groups run in parallel
 * (`Promise.all`). Results are *jump targets* (`href`) — the palette navigates,
 * never mutates.
 *
 * **Privacy (CLAUDE.md §Privacy — binding):** this path touches only local
 * Postgres. There is **no egress** and the search term is **never logged** (a
 * payee/ticker fragment is financial data). No HTTP client is imported here.
 */

/**
 * The kinds a palette result can be.
 *
 * `page` is the odd one out: a **nav-manifest destination**, not a database
 * row. Page results are matched locally and synchronously in the client island
 * by {@link ./pages.ts#searchPages} — no query runs here for them — and are
 * prepended ahead of the record groups so every destination stays one keystroke
 * away no matter how deep the nav puts it (ADR-035 rule 5, NAV-11). The kind
 * lives in this union so the palette renders every group through one shape.
 *
 * `help` is the same kind of exception (PLAN20 P20-07): a page's static help
 * entry, matched in the palette by `src/lib/help/search.ts`. It carries no
 * household data, and nothing here queries for it.
 */
export type SearchResultKind =
  | "page"
  | "account"
  | "category"
  | "security"
  | "watchlist"
  | "transaction"
  | "help";

/**
 * One palette result — a jump target, discriminated by {@link SearchResultKind}.
 * Uniform shape so the client island can render any group identically.
 */
export interface SearchResult {
  readonly kind: SearchResultKind;
  readonly id: string;
  /** Primary label (account name, ticker, payee…). */
  readonly title: string;
  /** Secondary context (institution, account name…); `null` when none. */
  readonly subtitle: string | null;
  /** Destination route — selecting the result `router.push`es here. */
  readonly href: string;
}

/** Per-group result caps. Sensible defaults; the palette can override. */
export interface SearchLimits {
  readonly accounts?: number;
  readonly categories?: number;
  readonly securities?: number;
  readonly watchlist?: number;
  readonly transactions?: number;
}

const DEFAULT_LIMITS: Required<SearchLimits> = {
  accounts: 5,
  categories: 5,
  securities: 5,
  watchlist: 5,
  transactions: 8,
};

/** `GREATEST(similarity(a,term), similarity(b,term), …)` for multi-column ranking. */
function bestSimilarity(
  term: string,
  ...columns: readonly Parameters<typeof similarityRank>[0][]
): SQL<number> {
  const ranks = columns.map((c) => similarityRank(c, term));
  return sql<number>`GREATEST(${sql.join(ranks, sql`, `)})`;
}

/**
 * Search every entity type for `rawTerm`, returning a flat, per-group-capped,
 * similarity-ranked list of jump targets.
 *
 * @param rawTerm - The user-entered query (sanitized here; short/blank ⇒ `[]`).
 * @param limits - Optional per-group caps (defaults: 5/5/5/5/8).
 * @returns Ordered results: accounts, categories, securities, watchlist, then
 *   transactions — each group internally ranked most-similar first. Empty when
 *   the term is too short to search for.
 */
export async function globalSearch(
  rawTerm: string,
  limits: SearchLimits = {},
): Promise<SearchResult[]> {
  const term = sanitizeSearchTerm(rawTerm);
  if (term === null) return [];

  const caps = { ...DEFAULT_LIMITS, ...limits };

  const [accountRows, categoryRows, securityRows, watchlistRows, transactionRows] =
    await Promise.all([
      db
        .select({ id: accounts.id, name: accounts.name, institution: accounts.institution })
        .from(accounts)
        .where(trigramIlikeAny([accounts.name, accounts.institution], term))
        .orderBy(desc(bestSimilarity(term, accounts.name, accounts.institution)))
        .limit(caps.accounts),
      db
        .select({ id: categories.id, name: categories.name, kind: categories.kind })
        .from(categories)
        .where(trigramIlikeAny([categories.name], term))
        .orderBy(desc(similarityRank(categories.name, term)))
        .limit(caps.categories),
      db
        .select({
          id: securities.id,
          symbol: securities.symbol,
          name: securities.name,
          ticker: securities.tickerSymbol,
        })
        .from(securities)
        .where(trigramIlikeAny([securities.symbol, securities.name, securities.tickerSymbol], term))
        .orderBy(
          desc(bestSimilarity(term, securities.symbol, securities.name, securities.tickerSymbol)),
        )
        .limit(caps.securities),
      db
        .select({
          id: watchlistItems.id,
          symbol: watchlistItems.symbol,
          label: watchlistItems.label,
        })
        .from(watchlistItems)
        .where(trigramIlikeAny([watchlistItems.symbol, watchlistItems.label], term))
        .orderBy(desc(bestSimilarity(term, watchlistItems.symbol, watchlistItems.label)))
        .limit(caps.watchlist),
      db
        .select({
          id: transactions.id,
          name: transactions.name,
          accountId: transactions.accountId,
          accountName: accounts.name,
        })
        .from(transactions)
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .where(trigramIlikeAny([transactions.name, transactions.memo], term))
        .orderBy(desc(bestSimilarity(term, transactions.name, transactions.memo)))
        .limit(caps.transactions),
    ]);

  const results: SearchResult[] = [];

  for (const a of accountRows) {
    results.push({
      kind: "account",
      id: a.id,
      title: a.name,
      subtitle: a.institution,
      href: `/accounts/${a.id}`,
    });
  }
  for (const c of categoryRows) {
    results.push({
      kind: "category",
      id: c.id,
      title: c.name,
      subtitle: c.kind,
      href: `/analysis/category/${c.id}`,
    });
  }
  for (const s of securityRows) {
    results.push({
      kind: "security",
      id: s.id,
      title: s.symbol,
      subtitle: s.name,
      href: `/investments/security/${s.id}`,
    });
  }
  for (const w of watchlistRows) {
    results.push({
      kind: "watchlist",
      id: w.id,
      title: w.symbol,
      subtitle: w.label,
      href: `/watchlist/${w.id}`,
    });
  }
  for (const t of transactionRows) {
    results.push({
      kind: "transaction",
      id: t.id,
      title: t.name,
      subtitle: t.accountName,
      href: `/accounts/${t.accountId}`,
    });
  }

  return results;
}
