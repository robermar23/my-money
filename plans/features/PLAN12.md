# PLAN — Phase 12 (Search everywhere: a ⌘K command palette + per-page filtering so the user can find any account, category, security, watchlist item, or transaction — across all accounts — without scrolling)

> Phases 1–11 grew the data: cash/credit/brokerage/IRA accounts, holdings, the mortgage, the home, personal assets, paper watchlist positions, and — the volume problem — **transactions**, which accumulate by the thousand from QFX/CSV imports and (Phase 4) Plaid sync. Round 6 ([IDEAS2.md](IDEAS2.md)) names the pain verbatim: *"Searching. The user should be able to search for things on every page. Whether it be the accounts page. The items page per account. You get the idea. Transactions/items add up quickly over time and the user needs to find specific ones easily."*
>
> Two complementary capabilities are bundled in that sentence, and the user confirmed **both** (clarifying-question round, 2026-06-23):
> 1. **A global "jump to anything" command palette** (⌘K / Ctrl-K, plus a click target in the nav) that fuzzy-matches across **every** entity type — accounts, categories, securities, watchlist items, and the top transaction matches across **all** accounts — and navigates straight to the result. This is the answer to "search on every page": one keystroke, available everywhere, no matter where you are.
> 2. **Per-list inline filtering** on the pages that grow unbounded — the accounts list, the per-account transaction list, the cross-account transaction view, the investments/securities list, and the watchlist. Each narrows *its own* list in place, with state in the **URL** (shareable, refresh-stable, back-button-correct) exactly like the existing `?page=` / `?closed=` params. For transactions the user also confirmed **structured filters**: free-text payee/memo, **amount range**, **date range**, **category** (including "Uncategorized"), and a mode that searches **across all accounts** at once.
>
> The good news matches Phase 11: this is **overwhelmingly additive and read-only.** It introduces **zero new tables** — search reads the columns we already store. The only schema change is **non-destructive index DDL**: enable the `pg_trgm` extension once and add a handful of trigram **GIN indexes** so fuzzy substring matching (`amazn` → `Amazon`) stays fast as the transaction count climbs into five and six figures — which is precisely the "add up quickly over time" failure mode Round 6 calls out. Everything else is query helpers (`src/lib/search/`), one internal authenticated route handler for the palette, server-component filter bars wired to `searchParams`, and one new cross-account `/transactions` surface.
>
> Phase 12 closes the round in seven batches: (0) **scope gate + ADRs**; (1) **search infrastructure** — `pg_trgm` + GIN indexes, a sanitized trigram match helper, Zod filter schemas; (2) **transaction search backend** — extend `listTransactions` with structured filters + a cross-account search query; (3) **per-page filter UI** — accounts filter, per-account transaction filter bar, new cross-account `/transactions` page; (4) **global ⌘K command palette** — internal search route handler + client island + nav trigger + keyboard shortcut; (5) **multi-entity coverage** — categories, securities/investments, watchlist filters + their palette result groups; (6) **tests, docs, privacy pass, E2E**.
>
> **Hard boundary (CLAUDE.md §Domain Scope) — read before writing code.** Search is a *read path*. Phase 12 does **NOT** add: a public/external search API (the route handler is session-guarded and same-origin only — single user, no external surface per CLAUDE.md §Domain Scope); a third-party search service (no Algolia, Elastic Cloud, Typesense Cloud, Meilisearch SaaS, OpenSearch — that would ship the user's payee names and balances off-box, a §Privacy violation); any LLM/"semantic"/embedding search that sends transaction text to a hosted model (§Privacy, hard no); saved-search/"smart folder" persistence, search history, or "recent searches" storage (YAGNI for one user; the URL *is* the saved search — bookmark it); cross-entity write actions from the palette (it navigates and reads; it never mutates — no "quick-categorize from search" in this phase); or full-document/attachment-body search of uploaded asset proofs (we index filenames/descriptions only, never file bytes). Any of those needs a FEATURE.md decision update first (P12-00 records the scope note).
>
> **Privacy (CLAUDE.md §Privacy & Data Sovereignty) — binding; this phase introduces _no egress whatsoever_.** Unlike the price pipeline, search touches **only local Postgres**. No ticker, no payee, no balance, no query string ever leaves the box — there is no outbound HTTP on any search code path. The ⌘K route handler is an **internal, authenticated, same-origin** endpoint (guarded by `requireUser()` like every other route); query strings are server-side only and are **not** logged (CLAUDE.md: financial data never logged — a payee fragment is financial data). P12-00 + the Batch 6 privacy pass make this explicit and add a regression test asserting no search module imports an HTTP client.
>
> **Companion docs** — read for context, do not duplicate:
> - [PLAN11.md](PLAN11.md) / [PLAN10.md](PLAN10.md) / [PLAN9.md](PLAN9.md) — the **template for this phase's structure** (batch/ADR/scope-gate discipline, additive-posture, "what already exists" inventory, URL-param-as-state, `text`+CHECK reasoning, `Number()`-only-at-the-display-edge, server-component-first with thin client islands).
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Privacy (no egress, no SaaS search, no third-party AI, never log financial data), §Domain Scope (no external API surface), §Performance (profile before optimizing; pagination not 10k DOM nodes; debounce input-driven ops), §TypeScript Performance (`Map`/`Set` for keyed lookups), §Database & Drizzle Specifics (Postgres-only; `numeric` stays string; never drop a column), §Architecture (separate UI / business-logic / data layers), §Testing Philosophy (parsers/query-builders + the privacy regression are "always-test" surfaces; pure UI is sparingly tested).
> - [IDEAS.md](IDEAS.md) §11 Decision Log (current max **ADR-026**; Phase 12 appends **ADR-027 → ADR-028**), ADR-005/013 (Recharts island posture — the palette is the same "thin client island, server does the data" pattern), ADR-007 (categorization — the `category_id`/`category` columns search joins against).
> - [SKILLS.md](SKILLS.md) §Suggested Workflow — see §Skills Map below.

---

## What already exists (do not rebuild — extend these)

Phase 12 is mostly *reuse*. Inventory before writing a line of code:

- **Server-component list pages with URL-param state** — [accounts/page.tsx](../../src/app/accounts/page.tsx) (`?closed=1` toggle), [accounts/[id]/page.tsx](../../src/app/accounts/[id]/page.tsx) (`?page=` paging), [transactions-section.tsx](../../src/app/accounts/[id]/transactions-section.tsx) (URL-param pagination nav). **Every filter in this phase follows the same pattern** — read `searchParams`, pass to a query, render server-side. No client state store.
- **Transaction queries** — [listTransactions](../../src/lib/transactions/queries.ts) (per-account, paginated, `(account_id, posted_at DESC)` indexed) and `listTransactionsForCategory` (the cross-account + date-range + account-filter precedent — Phase 12's transaction search **generalizes exactly this shape**: it already does `gte/lte` on `posted_at`, `inArray` on accounts, paginated count + rows, and joins the account name). Extend, don't fork.
- **Transactions schema** — [transactions.ts](../../src/db/schema/transactions.ts): `name` (payee), `memo`, `category` (legacy text), `category_id` (FK), `amount` `NUMERIC(18,2)`, `posted_at` `date`. Existing indexes: `(account_id, posted_at DESC)`, partial `(category)`, `(category_id, posted_at)`. Phase 12 adds **trigram GIN** indexes on `name`/`memo` — additive, no column change.
- **Accounts / securities / categories / watchlist columns** — [accounts.ts](../../src/db/schema/accounts.ts) (`name`, `institution`, `description`), [securities.ts](../../src/db/schema/securities.ts) (`symbol`, `name`, `ticker_symbol`), [categories.ts](../../src/db/schema/categories.ts) (`name`), [watchlist-items.ts](../../src/db/schema/watchlist-items.ts) (`symbol`, `label`, `notes`). All already-stored text — search reads it; nothing new to persist.
- **Category options + groups** — [listCategoriesWithGroups](../../src/lib/categories/queries.ts) already shapes the category dropdown used in [transactions-section.tsx](../../src/app/accounts/[id]/transactions-section.tsx); the transaction **category filter** reuses the same option list.
- **Nav + chrome** — [nav-menu.tsx](../../src/components/nav-menu.tsx) (`LINKS` array + responsive desktop/mobile split, `usePathname` active state — this is where the ⌘K trigger lands) and [app-nav.tsx](../../src/components/app-nav.tsx) (server shell that mounts the client menu). The palette trigger is a sibling client island mounted from `AppNav`.
- **Auth guard** — [requireUser](../../src/lib/auth/require-user.ts) on every page; [getSession](../../src/lib/auth/session.ts) for route handlers. The search route handler guards with the same session check — no new auth.
- **Validation + money** — Zod schemas in [src/lib/schemas/](../../src/lib/schemas/) (the `isoDateSchema` / `moneyAmountSchema` precedent in [account.ts](../../src/lib/schemas/account.ts)); [Money](../../src/lib/money/money.ts) for the amount-range comparison. Filter inputs parse through Zod at the boundary; amounts stay strings.
- **Money formatting at the edge** — [Money.format()](../../src/lib/money/money.ts); `Number()` only at display. Search never does money arithmetic except the amount-range `>=`/`<=` comparison, which stays in SQL on the `NUMERIC` column (no JS float).

---

## ADRs locked at plan time

Two decisions surface in Phase 12. Both are 🔲 **Proposed** — append to [IDEAS.md](IDEAS.md) §11 Decision Log (next free numbers **ADR-027 → ADR-028**; verified ADR-026 is current max) after this plan is approved (P12-00).

---

### ADR-027 — Two-tier search: a global ⌘K command palette **plus** URL-param per-list filters, both server-rendered, no client state store

**Status**: 🔲 Proposed

**Context**: Round 6 asks for search "on every page." That spans two distinct UX needs that are tempting to conflate: (a) "I'm anywhere and want to *jump* to a known thing" (an account, a category, a security) and (b) "I'm looking *at a list* and want to *narrow* it" (this account's transactions, filtered to >$1,000 in March). One mechanism can't serve both well — a global box that also paginates a filtered table is a muddle, and a per-page filter can't jump you to a different page. The user confirmed they want **both**.

**Decision**:
1. **Global command palette (⌘K / Ctrl-K)** — a single thin client island, mounted once from [AppNav](../../src/components/app-nav.tsx), opened by keyboard shortcut or a nav button. It debounces input (250 ms) and `fetch`es an **internal, session-guarded route handler** `GET /api/search?q=…` that returns **grouped, capped** results (e.g. ≤5 accounts, ≤5 categories, ≤5 securities, ≤5 watchlist items, ≤8 transaction matches across all accounts). Selecting a result **navigates** (`router.push`) to that entity's page — the palette **never mutates**. Results are *jump targets*, not an editable surface.
2. **Per-list filters via URL search params** — each growing list page reads its filter state from `searchParams` (server component) and passes it to the query. No Zustand, no client filter store (CLAUDE.md §Architecture: server components first; URL params for navigation/filter state). State in the URL = shareable, refresh-stable, back-button-correct, and bookmarkable (the URL *is* the "saved search," so we ship no saved-search table). A small client island provides the debounced input box and pushes updated params; the server re-renders the filtered list.
3. **Transaction search is the heavyweight** — it gets the full structured filter set (free text on `name`/`memo`, amount min/max, date from/to, category incl. "Uncategorized", and an **all-accounts** mode). It lives in two places sharing one query helper: the **per-account** list ([accounts/[id]](../../src/app/accounts/[id]/page.tsx), scoped to that account) and a **new cross-account `/transactions` page** (the "find it without knowing which account" surface).
4. **The route handler is internal and read-only** — same-origin, `requireUser()`-guarded, returns JSON, no external exposure (CLAUDE.md §Domain Scope keeps the *public* API surface at zero; an authenticated same-origin handler for our own UI is not a public API). Query strings are never logged (§Privacy).

**Consequences**:
- ✅ Each need is served by the mechanism that fits it; neither is contorted to do the other's job.
- ✅ Zero new tables, zero client state store, zero egress. Filters are bookmarkable URLs.
- ✅ The route handler is the *only* new "endpoint," and it's read-only + session-guarded + same-origin.
- ⚠️ The palette is a Client Component doing `fetch` (a small departure from "server components do the data"), justified because a keystroke-driven incremental search genuinely needs client interactivity. The *data* still comes from the server; the island is thin (input + list + keyboard nav).
- ⚠️ Two transaction surfaces (per-account + cross-account) share one query helper — a refactor of `listTransactions` rather than a duplicate path, to avoid drift.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Single global box that also drives the transaction table | Conflates "jump" and "narrow"; the URL/pagination semantics fight the modal. Two mechanisms is clearer. |
| Client-side filtering (fetch all rows, filter in JS) | Breaks at the exact scale Round 6 names ("add up quickly"); ships 10k+ rows to the browser (CLAUDE.md §Performance: never render 10k DOM nodes). Server-side SQL filter + pagination is correct. |
| Persist saved searches / search history in a table | YAGNI for one user; the URL is the saved search. Storing search history also stores *what the user looks for* — needless data at rest. |
| Zustand store for filter state | CLAUDE.md §Architecture + ADR-003: server components + URL params first; a store buys nothing here and loses shareable/refresh-stable URLs. |

---

### ADR-028 — Postgres `pg_trgm` trigram matching with GIN indexes (fuzzy, typo-tolerant, fast on large transaction sets)

**Status**: 🔲 Proposed

**Context**: The search has to stay fast and forgiving as transactions grow to five/six figures over years of imports — the exact pain Round 6 names. Three Postgres-native options: plain `ILIKE '%term%'` (leading wildcard ⇒ sequential scan, no typo tolerance), full-text search (`tsvector`, word/stemming aware but weak on partial tokens and tickers like `AAPL` or payee fragments like `amzn`), or trigram (`pg_trgm`: substring + fuzzy/similarity, GIN-indexable, ideal for short identifiers and messy payee strings). The user chose trigram.

**Decision**:
1. **Enable `pg_trgm`** via a one-line `CREATE EXTENSION IF NOT EXISTS pg_trgm;` in a migration. (drizzle-kit's `generate` does not emit `CREATE EXTENSION`; the established move is to hand-prepend it to the generated migration — see P12-02.)
2. **Trigram GIN indexes** on the searched text columns: `transactions.name`, `transactions.memo`, `accounts.name`, `accounts.institution`, `securities.symbol`, `securities.name`, `securities.ticker_symbol`, `categories.name`, `watchlist_items.symbol`, `watchlist_items.label`. Each `USING gin (col gin_trgm_ops)`. Declared in the Drizzle schema files via `index().using("gin", sql\`… gin_trgm_ops\`)` so the schema stays source-of-truth; the extension line is prepended to the generated migration.
3. **Matching strategy** — case-insensitive substring via `ILIKE '%' || term || '%'` (now index-backed by the trigram GIN) for the predicate, with `similarity(col, term)` available for **ranking** the palette's capped result groups (most-similar first). A short helper sanitizes/escapes the user term (strip `%` `_` `\`, collapse whitespace, length-cap) before interpolation — parameterized via Drizzle's `sql` template, never string-concatenated into raw SQL.
4. **Threshold** — leave `pg_trgm.similarity_threshold` at its default; ranking uses raw `similarity()` ordering, not a `%`-operator cutoff, so short/rare terms still match via the `ILIKE` predicate even when their trigram similarity is low.

**Consequences**:
- ✅ Typo-tolerant (`amazn`→`Amazon`), fast at scale (GIN index serves the leading-wildcard `ILIKE`), and ranked results in the palette.
- ✅ Zero new dependency, zero egress — it's core Postgres. No SaaS, no service to run.
- ⚠️ Trigram GIN indexes add write cost on insert (transactions are bulk-inserted during import). Bounded by single-user import cadence; acceptable, and imports already run in a BullMQ job off the request path.
- ⚠️ `pg_trgm` must exist in the container image. Postgres ships it as a standard contrib module (present in the official `postgres` image); the migration's `CREATE EXTENSION` is the only setup. Document it in the restore runbook so a fresh DB enables it.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Plain `ILIKE`, no extension | No typo tolerance; leading-wildcard scans degrade exactly as the transaction count grows — the pain Round 6 calls out. |
| Postgres FTS (`tsvector` + GIN) | Word/stemming-oriented; weaker for partial tokens, tickers, and payee fragments; heavier setup (generated tsvector column + triggers) for worse domain fit. |
| External search engine (Elastic/Typesense/Meilisearch/Algolia) | Ships payees + balances off-box (SaaS) or adds a whole service to self-host for one user. §Privacy + YAGNI. Postgres already holds the data and can index it. |
| LLM / embedding "semantic" search | Sends financial text to a model; §Privacy hard-no. Trigram covers the real need (find a known payee/symbol). |

---

## Batches

> Each task is atomic and independently reviewable. Task IDs are `P12-NN`. Batches land as separate commits/PRs following the Phase 11 cadence. **P12-00 gates everything** — no code before the scope note + ADRs are recorded.

### Batch 0 — Scope gate + ADRs

- **P12-00** — Record the §Domain Scope + §Privacy scope note (no external search API, no SaaS/LLM search, no saved-search persistence, no attachment-body indexing, palette is read-only) in this plan's header (done above) and append **ADR-027** + **ADR-028** to [IDEAS.md](IDEAS.md) §11 Decision Log (verify ADR-026 is still the max at commit time). Update [FEATURE.md](FEATURE.md) with a Round 6 → Phase 12 section mirroring the Phase 10/11 blurbs. **Gate: nothing else in Batch 1+ starts until this is committed.**

### Batch 1 — Search infrastructure (extension, indexes, helpers, schemas)

- **P12-01** — Add trigram GIN index definitions to the Drizzle schema files ([transactions.ts](../../src/db/schema/transactions.ts) `name`/`memo`; [accounts.ts](../../src/db/schema/accounts.ts) `name`/`institution`; [securities.ts](../../src/db/schema/securities.ts) `symbol`/`name`/`ticker_symbol`; [categories.ts](../../src/db/schema/categories.ts) `name`; [watchlist-items.ts](../../src/db/schema/watchlist-items.ts) `symbol`/`label`) using `index("…_trgm_idx").using("gin", sql\`${table.col} gin_trgm_ops\`)`. No column changes.
- **P12-02** — `pnpm drizzle-kit generate` to emit the GIN-index migration; **hand-prepend** `CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint` as the first statement (drizzle-kit won't generate it). Verify the migration applies cleanly against a fresh DB (`make db-reset` + migrate). Add a one-line note to [docs/RESTORE.md](../../docs/RESTORE.md) that a restored DB needs `pg_trgm` (the migration handles it; document for awareness).
- **P12-03** — `src/lib/search/term.ts`: a pure `sanitizeSearchTerm(raw): string | null` — trim, collapse internal whitespace, strip/escape SQL-LIKE metacharacters (`%`, `_`, `\`), enforce a min length (return `null` for empty/1-char so callers short-circuit to "no query"), and cap length. **Vitest** for it (always-test surface — it guards a SQL predicate).
- **P12-04** — `src/lib/search/predicates.ts`: small Drizzle helpers — `trigramIlike(column, term)` returning a parameterized `sql` `ILIKE '%' || $term || '%'` predicate, and `similarityRank(column, term)` for `ORDER BY similarity(...) DESC`. Built on Drizzle's `sql` template (parameterized — never raw concatenation). Unit-test the produced predicate shape.
- **P12-05** — `src/lib/schemas/search.ts`: Zod schemas for the transaction filter set — `q` (optional text), `from`/`to` (`isoDateSchema`, optional, `from ≤ to` refinement), `minAmount`/`maxAmount` (money strings, optional, `min ≤ max` refinement), `categoryId` (uuid or the literal `"uncategorized"`), `accountId` (uuid, optional ⇒ all-accounts), `page`. Reuse `isoDateSchema`/`moneyAmountSchema` from [account.ts](../../src/lib/schemas/account.ts). **Vitest** for the refinements.

### Batch 2 — Transaction search backend

- **P12-06** — Refactor [listTransactions](../../src/lib/transactions/queries.ts) to accept an optional `filters` object (`q`, `from`, `to`, `minAmount`, `maxAmount`, `categoryId | "uncategorized"`) and make `accountId` **optional** (omitted ⇒ all accounts). Build the `WHERE` with `and(...)` of only the provided clauses (the `listTransactionsForCategory` pattern), join `accounts.name` so cross-account rows are legible, keep the paginated `rows` + `COUNT(*)` shape. `q` matches `name OR memo` via `trigramIlike`. Preserve the existing no-filter call sites (defaults ⇒ current behavior).
- **P12-07** — Amount-range semantics: filter on the **stored signed `amount`** (`gte`/`lte` on the `NUMERIC` column in SQL, no JS float). Document in a code comment that the range is on the stored sign convention (credit-card display flips sign in the UI, not in the filter) and that the cross-account `/transactions` page labels the field accordingly. **Vitest**: assert the WHERE composition for representative filter combos (text-only, amount-only, all-filters, uncategorized) against an in-memory/fixture query builder or a seeded test DB per the project's existing query-test approach.
- **P12-08** — `src/lib/search/global.ts`: `globalSearch(term, limits)` running the capped, ranked, grouped queries for the palette — accounts, categories, securities, watchlist items, and top-N transactions (each `SELECT … WHERE trigramIlike(...) ORDER BY similarity(...) DESC LIMIT n`). Returns a typed discriminated-union `SearchResult[]` (`{kind, id, title, subtitle, href}`). Runs the group queries in parallel (`Promise.all`). No egress, no logging of `term`.

### Batch 3 — Per-page filter UI

- **P12-09** — `src/components/search-input.tsx`: a reusable thin client island — a debounced (250 ms) text box that pushes/updates a named `searchParams` key via `useRouter`/`useSearchParams` (resets `page` to 1 on change), with a clear (×) button. Used by accounts + transactions + watchlist + investments lists. Accessible (`role="searchbox"`, label, `Esc` to clear).
- **P12-10** — Accounts list ([accounts/page.tsx](../../src/app/accounts/page.tsx)): read `?q=`, filter `listAccounts` by `name`/`institution`/`description` (trigram), render the `SearchInput` above the table, show a "no matches" empty state distinct from "no accounts." Preserve the `?closed=` toggle (compose both params).
- **P12-11** — Per-account transactions ([accounts/[id]/page.tsx](../../src/app/accounts/[id]/page.tsx) + [transactions-section.tsx](../../src/app/accounts/[id]/transactions-section.tsx)): add a **filter bar** island (`src/app/accounts/[id]/transaction-filters.tsx`) with payee text, amount min/max, date from/to, and category select (reusing the existing `categoryOptions`). Parse via `src/lib/schemas/search.ts`, pass to the refactored `listTransactions` scoped to this `accountId`. Keep pagination; show active-filter count + a "Clear filters" link. Empty state: "No transactions match these filters."
- **P12-12** — New cross-account page `src/app/transactions/page.tsx` ("All transactions"): the same filter bar **without** an account scope (all-accounts mode), each row linking to its account, an account selector to optionally narrow. Add `/transactions` to the nav `LINKS` ([nav-menu.tsx](../../src/components/nav-menu.tsx)). This is the "find a transaction without knowing which account" surface Round 6 implies.

### Batch 4 — Global ⌘K command palette

- **P12-13** — Internal route handler `src/app/api/search/route.ts`: `GET`, `requireUser()`-guarded (401 JSON if no session), parses `?q=` through `sanitizeSearchTerm`, returns `globalSearch(...)` JSON. Same-origin/read-only; **does not log `q`**. Short-circuits to empty groups for null/short terms.
- **P12-14** — `src/components/command-palette.tsx`: the client island — opens on ⌘K / Ctrl-K (global `keydown` listener) and on a nav button; debounced `fetch` to `/api/search` with `AbortController` (cancel in-flight on new keystroke per CLAUDE.md §Performance); grouped results with keyboard up/down/enter navigation; `router.push(href)` on select; `Esc`/backdrop to close; focus-trap + `aria-` roles (`combobox`/`listbox`/`option`). Loading + empty states. No result is editable.
- **P12-15** — Mount the palette + trigger from [app-nav.tsx](../../src/components/app-nav.tsx)/[nav-menu.tsx](../../src/components/nav-menu.tsx): a "Search…" button (with a `⌘K` hint) in the desktop nav and an icon entry in the mobile menu, both opening the same island. Mounted once at the chrome level so it's available on every authenticated page (the literal "search on every page").

### Batch 5 — Multi-entity coverage (investments, watchlist, categories)

- **P12-16** — Investments/securities list ([investments/page.tsx](../../src/app/investments/page.tsx)): add `?q=` filtering on `symbol`/`name`/`ticker_symbol` via the `SearchInput`, scoped to the holdings/securities the page already lists. (Securities also appear in the palette via P12-08.)
- **P12-17** — Watchlist list ([watchlist/page.tsx](../../src/app/watchlist/page.tsx)): add `?q=` filtering on `symbol`/`label`/`notes`. (Already in the palette via P12-08.)
- **P12-18** — Categories management ([settings/categories/page.tsx](../../src/app/settings/categories/page.tsx)): add `?q=` filtering on category `name` (the category list grows as the user adds them — Round 2's "categories page is not very user friendly" overlap, addressed minimally here without rescoping Phase 8). Confirm the palette's category group links to the right destination.

### Batch 6 — Tests, docs, privacy pass, E2E

- **P12-19** — Vitest coverage for the always-test surfaces (gather): `sanitizeSearchTerm` (metachar escaping, length caps, null short-circuit), the search Zod refinements (`from≤to`, `min≤max`, `uncategorized` literal), and the `listTransactions` WHERE composition across filter combos. (Most authored inline with their batch; this task ensures the suite is complete + green.)
- **P12-20** — **Privacy regression test** (mandatory, CLAUDE.md §Privacy): assert no module under `src/lib/search/` nor `src/app/api/search/route.ts` imports an HTTP client (`fetch` to an external host, `axios`, `undici`, the price fetchers, etc.) — search is local-only, zero egress — and assert the route handler does not pass `q` to any logger. (Mirrors the Phase 11 privacy-regression posture.)
- **P12-21** — `docs/SEARCH.md`: how trigram search works, the `pg_trgm` dependency + the `CREATE EXTENSION` migration, the URL-param filter contract (so bookmarked filtered views are documented), the palette keyboard shortcuts, and the explicit privacy/scope boundaries (local-only, read-only, no external API). Link it from [README.md](../../README.md) + [FEATURE.md](FEATURE.md).
- **P12-22** — **Playwright** E2E (one focused flow, per CLAUDE.md §Testing Philosophy — don't over-test UI): seed a handful of accounts + transactions, open the ⌘K palette, type a payee fragment, assert the grouped result appears and selecting it navigates to the right page; then on the cross-account `/transactions` page apply an amount + date filter and assert the row set narrows. Keep it to this single critical path.
- **P12-23** — Perf sanity (CLAUDE.md §Performance — measure, don't guess): with a seeded large transaction set (e.g. 50–100k rows), `EXPLAIN` the trigram `ILIKE` query to confirm the GIN index is used (not a seq scan), and confirm the palette route stays snappy. Record findings in `docs/SEARCH.md`. No premature optimization beyond the indexes already added.

---

## Skills Map (when each pays off this phase)

Per [SKILLS.md](SKILLS.md) §Suggested Workflow — invoke at the moment of leverage, not preemptively:

- **`postgres-best-practices`** / **`postgresql-optimization`** — Batch 1 (trigram GIN index design, `gin_trgm_ops`, `CREATE EXTENSION` placement) and Batch 6 P12-23 (`EXPLAIN` the index is used). The pg_trgm index/opclass choices are the one genuinely Postgres-specific decision this phase.
- **`drizzle-orm-expert`** — Batch 1–2 (expressing GIN indexes + parameterized `sql` trigram predicates in Drizzle; the `and(...)`-of-optional-clauses dynamic WHERE; generate the index migration).
- **`zod-validation-expert`** — Batch 1 P12-05 (filter-input schemas + `from≤to`/`min≤max` refinements at the boundary).
- **`nextjs-app-router-patterns`** — Batch 3–5 (server-component filter pages reading `searchParams`; the thin client islands; the internal route handler typed with `NextRequest`/`NextResponse`).
- **`frontend-security-coder`** — Batch 4 (palette renders user-entered payee/account names → confirm no XSS in our own data; the route handler is same-origin + session-guarded).
- **`test-driven-development`** — Batch 1 P12-03/P12-04 (the sanitizer + predicate builders are pure functions with crisp I/O — write tests first).
- **`e2e-testing-patterns`** — Batch 6 P12-22 (the one Playwright search flow).
- **`tailwind-patterns`** — Batch 3–4 (filter bar + palette styling, dark-mode, mobile responsiveness, consistent with existing chrome).
- **`systematic-debugging`** — reactive, if the GIN index isn't picked up or a filter combo returns wrong rows.

Note in each batch's PLAN task which skill was the reference when invoked for real (per [SKILLS.md](SKILLS.md) §Maintenance).

---

## Open Items (deferred — record, don't build)

- **Saved searches / smart folders** — explicitly deferred (ADR-027 rejected alternatives). The URL is the saved search; revisit only if the user asks to name/pin filtered views.
- **Search history / recent searches** — deferred (stores "what the user looks for" at rest; YAGNI for one user).
- **Quick-actions from the palette** (e.g. categorize a transaction without leaving ⌘K) — deferred; the palette is read-only/navigate-only this phase. A future phase could add write actions behind an explicit decision.
- **Attachment-body / OCR search of asset proof documents** — out (we index filenames/descriptions only; indexing file bytes is a different, heavier feature).
- **Real-time "search-as-you-type" on the per-list tables** (vs. the debounced URL-param submit) — the palette is incremental; the list filters submit on debounce to keep state in the URL. If the user wants instant per-list filtering without URL writes, revisit — it trades shareable URLs for snappier keystrokes.

---

*End of PLAN12.md*
