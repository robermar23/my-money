# Search (Phase 12)

How to find anything in my-money — across every account — without scrolling.
Two complementary mechanisms, both server-rendered, both reading only your local
Postgres. Locked by **ADR-027** (two-tier search) and **ADR-028** (`pg_trgm`
trigram matching) in [IDEAS.md](../plans/features/IDEAS.md) §11; task breakdown in
[PLAN12.md](../plans/features/PLAN12.md).

> **Privacy & scope (binding — CLAUDE.md §Privacy, §Domain Scope).** Search is a
> **read path with zero egress.** No payee, ticker, balance, or query string ever
> leaves the host — there is no outbound HTTP on any search code path. The command
> palette is backed by an **internal, same-origin, session-guarded** route handler
> (`requireUser()` like every page) — it is **not** a public API. The palette
> **navigates and reads; it never mutates.** The query term is **never logged** (a
> payee fragment is financial data). No third-party search service (Algolia,
> Elastic/Typesense/Meilisearch SaaS) and no LLM/"semantic"/embedding search — both
> would ship your data off-box. A regression test
> ([src/lib/search/privacy-egress.test.ts](../src/lib/search/privacy-egress.test.ts))
> fails the build if a search module ever gains an HTTP-client import or the route
> handler logs `q`.

---

## Two ways to search

### 1. The ⌘K command palette — "jump to anything"

Press **⌘K** (macOS) / **Ctrl-K** (Windows/Linux) anywhere in the app, or click
**Search…** in the nav (there's an icon entry in the mobile menu too). Start
typing and results stream in, grouped by entity:

| Group | Matches on | Cap | Selecting navigates to |
|---|---|---|---|
| Accounts | `name`, `institution` | 5 | `/accounts/{id}` |
| Categories | `name` | 5 | `/analysis/category/{id}` |
| Securities | `symbol`, `name`, `ticker_symbol` | 5 | `/investments/security/{id}` |
| Watchlist | `symbol`, `label` | 5 | `/watchlist/{id}` |
| Transactions | `name` (payee), `memo` — **across all accounts** | 8 | the owning account |

- **Keyboard:** ↑/↓ move the selection, **Enter** jumps, **Esc** (or a backdrop
  click) closes. Focus is trapped in the dialog while it's open.
- Input is **debounced 250 ms** and each keystroke **aborts** the in-flight
  request (`AbortController`), so stale results never race onto the screen.
- Results are **jump targets only** — nothing in the palette is editable
  (ADR-027: the palette never mutates).
- The palette is a single thin client island mounted once from
  [`AppNav`](../src/components/app-nav.tsx) → it's reachable on *every*
  authenticated page (the literal "search on every page" of Round 6). It fetches
  the internal handler `GET /api/search?q=…`
  ([route](../src/app/api/search/route.ts) → [globalSearch](../src/lib/search/global.ts)).

### 2. Per-list URL-param filters — "narrow what I'm looking at"

Each growing list page reads its filter state from the **URL** (`searchParams`)
and re-renders server-side. State in the URL means the filtered view is
**shareable, refresh-stable, back-button-correct, and bookmarkable** — *the URL
is the saved search*, which is exactly why there is no saved-search table.

A small client island ([`SearchInput`](../src/components/search-input.tsx))
provides the debounced box and pushes the param (resetting `page` to 1 on
change); the server does the actual filtering in SQL.

| Page | Param(s) | Filters on |
|---|---|---|
| [`/accounts`](../src/app/accounts/page.tsx) | `?q=` (composes with `?closed=`) | account `name` / `institution` / `description` |
| [`/transactions`](../src/app/transactions/page.tsx) (cross-account) | the full filter set ↓ | all accounts, or narrowed by `accountId` |
| [`/accounts/{id}`](../src/app/accounts/[id]/page.tsx) (per-account) | the full filter set ↓ (scoped to that account) | that account's transactions |
| [`/investments`](../src/app/investments/page.tsx) | `?q=` | holding `symbol` / security `name` (narrows the per-account tables; portfolio totals/allocation stay whole) |
| [`/watchlist`](../src/app/watchlist/page.tsx) | `?q=` | `symbol` / `label` / `notes` |
| [`/settings/categories`](../src/app/settings/categories/page.tsx) | `?q=` | category `name` (the "Merge into…" picker keeps the full list) |

#### The transaction filter set

The transaction surfaces share one query helper
([`listTransactions`](../src/lib/transactions/queries.ts)) and one Zod schema
([`transactionFilterSchema`](../src/lib/schemas/search.ts)). The URL params:

| Param | Meaning |
|---|---|
| `q` | free text on payee (`name`) **or** `memo` |
| `from` / `to` | inclusive ISO date range on `posted_at` (`from ≤ to` enforced) |
| `minAmount` / `maxAmount` | inclusive range on the **stored signed `amount`** (`min ≤ max` enforced) |
| `categoryId` | a category UUID, or the literal `uncategorized` (→ `category_id IS NULL`) |
| `accountId` | optional; omit for **all accounts** (cross-account mode) |
| `page` | 1-based pagination |

> **Amount sign convention.** The range filters the value *as stored* — e.g. a
> $50 expense is stored negative, so "expenses between $10 and $500" is
> `minAmount=-500&maxAmount=-10`. The credit-card display flips sign in the UI,
> not in the filter; the cross-account page labels the field accordingly.

A blank/1-character `q` is treated as **no filter** (the sanitizer short-circuits
— see below), so an empty box never runs a degenerate query.

---

## How trigram matching works (ADR-028)

Postgres' `pg_trgm` contrib module breaks text into 3-character "trigrams" and
indexes them with **GIN**, which makes both leading-wildcard substring matching
(`ILIKE '%term%'`) and fuzzy similarity fast — and typo-tolerant
(`amazn` → `Amazon`). This is the right fit for short identifiers (tickers like
`AAPL`) and messy payee strings, where full-text `tsvector` (word/stemming
oriented) is weak.

**The matching pipeline:**

1. **Sanitize** — every user term passes through
   [`sanitizeSearchTerm`](../src/lib/search/term.ts): trim, collapse internal
   whitespace, reject `< 2` chars (callers short-circuit to "no query"), cap
   length. Its output is the operand used for `similarity()` ranking.
2. **Predicate** — [`trigramIlike` / `trigramIlikeAny`](../src/lib/search/predicates.ts)
   build a **parameterized** `col ILIKE '%' || $term || '%' ESCAPE '\'`. The term
   is always a **bound parameter** (never concatenated into raw SQL), and LIKE
   metacharacters (`%`, `_`, `\`) are escaped so they match literally.
3. **Rank** — `similarityRank(col, term)` adds `ORDER BY similarity(col, term)
   DESC` so the palette's capped groups surface the closest matches first. The
   `pg_trgm.similarity_threshold` is left at its default; ranking uses raw
   `similarity()` ordering rather than a `%`-operator cutoff, so short/rare terms
   still match via the `ILIKE` predicate even when their trigram score is low.

### The extension + indexes

`pg_trgm` is enabled and the GIN indexes are created by migration
[`drizzle/0017_fuzzy_morg.sql`](../drizzle/0017_fuzzy_morg.sql). drizzle-kit's
`generate` does **not** emit `CREATE EXTENSION`, so the line is hand-prepended to
the generated migration:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Trigram GIN indexes (`USING gin (col gin_trgm_ops)`), declared in the Drizzle
schema files so the schema stays source-of-truth:

`accounts.name`, `accounts.institution`, `securities.symbol`, `securities.name`,
`securities.ticker_symbol`, `categories.name`, `transactions.name`,
`transactions.memo`, `watchlist_items.symbol`, `watchlist_items.label`.

> **Restore note.** A freshly restored database needs `pg_trgm`. The migration
> handles it (`CREATE EXTENSION IF NOT EXISTS`), and `pg_trgm` ships in the
> standard `postgres` image — so a normal `pnpm db:migrate` against a clean DB is
> all that's required. See [RESTORE.md](RESTORE.md).

---

## Performance (P12-23)

The whole point of the GIN indexes is that the leading-wildcard `ILIKE` stays an
**index scan** for the common case, instead of a sequential scan, as transactions
climb into five/six figures. Verify with `EXPLAIN` against a seeded large set:

```sql
EXPLAIN ANALYZE
SELECT id, name FROM transactions
WHERE name ILIKE '%amazon%' OR memo ILIKE '%amazon%'
ORDER BY similarity(name, 'amazon') DESC
LIMIT 8;
```

### Measured findings (50k-row seed, P12-23)

What an actual `EXPLAIN ANALYZE` shows — the planner's choice is **selectivity-
and table-size-dependent**, which is the honest, useful result:

- **Single-column `ILIKE`** (the per-page filters that hit one column, and the
  palette's account/category/security/watchlist groups over short identifier
  columns) → the planner **naturally picks** `Bitmap Index Scan on
  …_trgm_idx` (~2 ms for a selective term). This is the dominant path.
- **The two-column transaction `name OR memo`** query → at 50k rows the planner
  may still choose a **`Seq Scan`** (~30 ms) over a `BitmapOr` of the two GIN
  indexes, depending on term selectivity and how populated `memo` is. Forcing
  `SET enable_seqscan = off` confirms the index path is correctly wired and
  faster when taken (`BitmapOr` of `transactions_name_trgm_idx` +
  `transactions_memo_trgm_idx`, ~5 ms). The seq-scan/bitmap crossover moves in
  the index's favor as the table grows past this size.

**Conclusion:** the trigram GIN indexes are present, valid, and used for the
single-column lookups that make up most of the search surface; the worst current
case (the 2-column OR at 50k) is a bounded ~30 ms seq scan, and the index wins as
the row count climbs. No code change is warranted now (CLAUDE.md §Performance:
measure, don't guess) — revisit only if a populated-`memo` corpus at six figures
measures slow, where a combined expression index or a `name || ' ' || memo`
generated column would be the next lever.

The palette runs its five group queries in parallel (`Promise.all`) and each is
`LIMIT`-capped, so a keystroke is a handful of small lookups regardless.

**Write-cost trade-off (ADR-028):** trigram GIN indexes add cost on insert.
Bounded by single-user import cadence — and bulk imports already run in a BullMQ
job off the request path — so it's acceptable.

---

## Files

- [`src/lib/search/term.ts`](../src/lib/search/term.ts) — sanitize/escape (pure).
- [`src/lib/search/predicates.ts`](../src/lib/search/predicates.ts) — parameterized trigram `sql` builders.
- [`src/lib/search/global.ts`](../src/lib/search/global.ts) — `globalSearch` (the palette's grouped, capped, ranked queries).
- [`src/lib/schemas/search.ts`](../src/lib/schemas/search.ts) — `transactionFilterSchema` (Zod, with `from≤to` / `min≤max` refinements).
- [`src/lib/transactions/queries.ts`](../src/lib/transactions/queries.ts) — `listTransactions` / `buildTransactionWhere` (the shared filter query).
- [`src/app/api/search/route.ts`](../src/app/api/search/route.ts) — the internal `GET /api/search` handler.
- [`src/components/command-palette.tsx`](../src/components/command-palette.tsx) — the ⌘K island.
- [`src/components/search-input.tsx`](../src/components/search-input.tsx) — the reusable per-list filter box.

Tests: `term.test.ts`, `predicates.test.ts`, `schemas/search.test.ts`,
`transactions/queries.where.test.ts` (always-test surfaces — sanitizer, predicate
shape, Zod refinements, WHERE composition) and `privacy-egress.test.ts` (the
mandatory zero-egress / never-log-`q` regression).
