# PLAN — Phase 8 (Categorization Depth + Spending Analytics + Budgets)

> Phases 0–7 built a working tracker with a regex categorizer (ADR-007) and a single net-worth chart. But the screenshot in [checking-transactions.png](checking-transactions.png) shows the gap: **most transactions are "Uncategorized."** The category model is free-text, the only way to add a category is the separate `/settings/categories` regex page, and there is **zero spending analysis** — no per-category, per-account, or over-time view, and no budgets.
>
> Phase 8 closes that gap in four moves: (1) replace free-text categories with a **structured `categories` + `category_groups` model** so analytics can roll up reliably; (2) make categorizing **fast and inline** (bulk "review uncategorized" queue, create-category-and-rule from the transaction row, smarter seeded defaults); (3) ship a **spending-analysis surface** (historical trends by category / group / account / month, income vs. expense, with Recharts islands); (4) add **monthly per-category budgets** with actual-vs-target tracking and a **trailing-average forecast** of future spend.
>
> **Scope-gate note (read first):** CLAUDE.md §Domain Scope lists "Budgeting / envelope systems" as out-of-scope *"never without explicit ask."* The owner has now explicitly asked (see [IDEAS2.md](IDEAS2.md) — "expand my-money to provide details on spending and budgets related to categories"). This plan therefore includes **simple monthly per-category targets only** — **not** an envelope/rollover (YNAB-style) system, which stays out of scope. P8-00 updates FEATURE.md + IDEAS.md to record this scope change before any budget code lands.
>
> **Companion docs** — read for context, do not duplicate here:
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Money & Numeric Precision (all spend/budget math through `Money`/`decimal.js`, `Number()` only at the display edge), §Privacy & Data Sovereignty (no third-party analytics — these dashboards are first-party SQL aggregations only; **no LLM categorization**), §Database & Drizzle Specifics ("Never `drop column` … without a paired data backup step" — the free-text→structured migration keeps the old column until a later, backed-up drop), §Testing Philosophy (aggregation/forecast/budget math are pure-function "always-test" surfaces).
> - [IDEAS.md](IDEAS.md) §11 Decision Log + **ADR-007** (regex categorization — this phase *extends* it, it does not replace the regex engine), **ADR-005/013** (Recharts island-per-chart — every new chart follows this).
> - [PLAN3.md](PLAN3.md) — where ADR-007 (`category_rules`, first-match-wins, `category_overridden_at` watermark) is specified.
> - [PLAN7.md](PLAN7.md) — the server-action conventions (`ActionResult`, `requireUser()` → ownership → mutate → `revalidatePath`), and the **shared snapshot-recompute helper** pattern Phase 8 reuses for nothing-new (categorization does not touch balances).
> - [SKILLS.md](SKILLS.md) — skills invoked below; `database-migration` is **promoted from Tier 3** for this phase (the free-text→structured backfill is the "non-trivial data movement" its skip-note reserved it for).

---

## What already exists (do not rebuild — extend these)

Inventory before writing code. Phase 8 builds on shipped categorization plumbing:

- **Category model (free-text today)**: [src/db/schema/transactions.ts](../../src/db/schema/transactions.ts) — `category text` (nullable) + `categoryOverriddenAt` watermark + partial index `transactions_category_idx`. [src/db/schema/category-rules.ts](../../src/db/schema/category-rules.ts) — `category text`, `pattern`/`flags`/`field`/`priority`/`enabled`. **Both carry the category as a string; Phase 8 adds a `category_id` FK alongside and backfills.**
- **Match engine**: [src/lib/categorization/match.ts](../../src/lib/categorization/match.ts) — `matchCategory(name, memo, rules)` (first-match-wins, regex cache), `sortRules`, `validateRegex`. Returns a category **string** today; will resolve a rule's `category_id`.
- **Seed**: [src/lib/categorization/seed.ts](../../src/lib/categorization/seed.ts) — `DEFAULT_RULES` (~20 regexes) + `seedDefaultRulesIfEmpty()`. Phase 8 rewrites this to also seed the structured `categories`/`category_groups` and to wire rules to category IDs. **The screenshot's payees (Venmo, Zelle, CashApp, State Pension Board, mortgage/loan servicers, Apple Cash, CITI CARD payment, WEB XFER) are the smarter-defaults target.**
- **Re-categorize path**: [src/lib/importers/persist.ts](../../src/lib/importers/persist.ts) `recategorizeAll()` (skips `categoryOverriddenAt IS NOT NULL`), the worker job [src/worker/jobs/recategorize-all.ts](../../src/worker/jobs/recategorize-all.ts), and `buildPreview`/`persistImportBatch` (categorize on import). Plaid path categorizes in [src/worker/jobs/sync-plaid-item.ts](../../src/worker/jobs/sync-plaid-item.ts) via `matchCategory`.
- **Plaid raw payload**: [src/lib/plaid/map.ts](../../src/lib/plaid/map.ts) leaves `category` null and keeps the full Plaid object in `transactions.raw` — including `personal_finance_category`. *(Using Plaid's category as a fallback was considered and **deliberately not selected** this phase; the data stays in `raw` if we revisit. Do not silently add it.)*
- **Rules settings UI**: [src/app/settings/categories/page.tsx](../../src/app/settings/categories/page.tsx), [rule-form.tsx](../../src/app/settings/categories/rule-form.tsx), [rule-actions.tsx](../../src/app/settings/categories/rule-actions.tsx), [actions.ts](../../src/app/settings/categories/actions.ts) (`createRuleAction`/`toggleRuleAction`/`deleteRuleAction`/`recategorizeAllAction`/`testRuleAction`), plus `test-panel.tsx`. **No `updateRuleAction` was added in Phase 7's Batch 4 yet — confirm and reuse if present.**
- **Inline category editor**: [src/app/accounts/[id]/category-cell.tsx](../../src/app/accounts/[id]/category-cell.tsx) — `"use client"`, `<input list>` + `<datalist>` of `suggestions`, commits via `setTransactionCategoryAction`. **This is the surface that gains "create new category + optional rule" inline.**
- **Transaction queries**: [src/lib/transactions/queries.ts](../../src/lib/transactions/queries.ts) — `listTransactions` (paginated), `distinctCategories()` (feeds the datalist), `setCategory(txnId, category)`. The list renders in [transactions-section.tsx](../../src/app/accounts/[id]/transactions-section.tsx).
- **Chart island pattern**: [src/app/net-worth-chart.tsx](../../src/app/net-worth-chart.tsx) — `"use client"`, Recharts `ResponsiveContainer`, `Number(value)` only at the display edge, `Intl.NumberFormat` for axes/tooltips. **Every Phase 8 chart copies this shape.**
- **Aggregation precedent**: [src/lib/net-worth/compute.ts](../../src/lib/net-worth/compute.ts) — server-side aggregation returning `Money`/strings. New spending aggregations live beside it under `src/lib/analytics/`.
- **Nav**: [src/components/nav-menu.tsx](../../src/components/nav-menu.tsx) `LINKS` — add an **Analysis** entry; **Categories** link stays (rules live there).
- **Sign convention**: positive = inflow, negative = outflow (OFX convention, enforced at the Plaid boundary in `map.ts`). Spend = `-SUM(amount)` over expense-kind categories; income = `SUM(amount)` over income-kind; **transfer-kind is excluded from both** (this is why a structured `kind` matters — credit-card payments and WEB XFERs must not count as spending).

---

## ADR-018 — Structured categories, groups, and simple budgets

**Status**: 🔲 Proposed — append to [IDEAS.md](IDEAS.md) §11 after kickoff approval. Supersedes the free-text half of ADR-007 (the **regex engine of ADR-007 stays**; only the category *value* becomes a managed entity).

**Context**: Free-text categories fragment under typos ("Coffee" vs "coffee" vs "Cofee"), carry no income/expense/transfer semantics (so transfers pollute spend totals), and can't be grouped for rollups. Reliable per-category / per-group / per-account analytics and budgets require a managed taxonomy. Budgeting was out-of-scope until the owner's explicit ask in IDEAS2.md.

**Decision**:
1. **Two-level taxonomy.** New `category_groups` (e.g. *Food*, *Housing*, *Transport*, *Income*, *Transfers*) and `categories` (leaf, e.g. *Restaurant*, *Coffee*) with `categories.group_id`. Leaves are what transactions reference. Groups are rollup-only (no transaction points directly at a group).
2. **`kind` is on the category.** One of `'income' | 'expense' | 'transfer'`. Drives analytics: spend excludes `transfer`; income vs. expense split is by `kind`. Transfers (WEB XFER, credit-card payments, internal moves) are `kind='transfer'` and never appear in spending totals.
3. **`transactions.category_id` (uuid, FK → `categories.id`, `onDelete: set null`) is added alongside the existing `category` text column.** The text column is kept as a denormalized cache + rollback safety net and is **not dropped this phase** (per CLAUDE.md — a drop needs a paired backup step; deferred to a later migration). `category_overridden_at` semantics are unchanged.
4. **`category_rules.category_id` (FK) is added; the regex engine is untouched.** A rule resolves to a `category_id`; `matchCategory` returns the id. Creating a rule may create the category inline.
5. **Migration backfills, never destroys.** A one-shot idempotent backfill creates `categories`/`category_groups` from (seed defaults ∪ distinct existing `transactions.category` ∪ distinct `category_rules.category`), maps them to groups + kinds via a static seed map, then sets `category_id` on both tables by name match. Unmapped free-text values land in an *Uncategorized*/`Other` leaf, never lost.
6. **Budgets = monthly per-category targets only.** New `category_budgets (category_id UNIQUE, amount, currency)` = a recurring monthly target. Actual-vs-target is computed per calendar month from transactions. **No envelopes, no rollover, no "assign every dollar."** Group budgets are a read-only rollup (sum of child category targets).
7. **Forecast = trailing average, deterministic.** Projected monthly spend per category = mean of the trailing N months (default 3, configurable in code). No ML, no recurring-merchant detection this phase (recorded as a future option). Pure function, unit-tested.
8. **Privacy unchanged.** All analytics are first-party SQL over the local Postgres. No third-party analytics SDK, no LLM categorization (CLAUDE.md §Privacy is binding).

**Consequences**: One migration adds 3 tables + 2 FK columns + indexes and runs a backfill. `matchCategory`/`seed`/`persist`/Plaid sync change their category type from string→id (mechanical, well-tested). The settings page and inline editor switch from free-text to a managed picker (with inline-create). New `/analysis` route + `src/lib/analytics/`. FEATURE.md domain-scope and IDEAS.md decision log updated (P8-00).

**Rejected alternatives**: free-text + analytics on top (fragile — typos fragment data; no transfer exclusion); self-referential single-table hierarchy (flexible but messier queries than two fixed levels for one user); envelope budgeting (explicitly larger than the ask).

---

## Task breakdown

> Batches are ordered by dependency: **1 → 2 → 3 → 4 → 5**. Batch 1 (data model + migration) gates everything. Batches 3/4/5 are independently shippable once Batch 1 lands. Task IDs follow the `P8-xx` convention. Invoke the cited skill at the start of each batch.

### Batch 0 — Scope gate (docs only, no code)

**P8-00 — Record the budgeting scope change.**
- Append **ADR-018** to [IDEAS.md](IDEAS.md) §11 Decision Log (next free number — verified ADR-017 is the current max).
- Edit [plans/features/FEATURE.md](FEATURE.md) §Domain Scope: move "simple monthly per-category budgets" from out-of-scope to in-scope, citing IDEAS2.md + ADR-018. Leave "envelope/rollover budgeting" explicitly out-of-scope.
- *Skill: `architecture-decision-records`.* No deploy.

### Batch 1 — Structured category data model + migration

*Skills: `drizzle-orm-expert`, `postgres-best-practices`, `database-migration` (promoted), `typescript-pro`.*

**P8-01 — `category_groups` + `categories` schema.**
- New `src/db/schema/categories.ts`:
  - `category_groups`: `id uuid pk`, `name text not null`, `sortOrder integer default 100`, `color text` (nullable), `createdAt`/`updatedAt`. Unique index on `lower(name)`.
  - `categories`: `id uuid pk`, `groupId uuid` FK → `category_groups.id` (`onDelete: set null`, nullable), `name text not null`, `kind text not null default 'expense'` with `CHECK (kind IN ('income','expense','transfer'))`, `color text` (nullable), `sortOrder integer default 100`, `archivedAt timestamp` (nullable, withTimezone), `createdAt`/`updatedAt`. Unique index on `lower(name)`. Index on `groupId`.
- Add `kind`/group relations; export `Category`, `NewCategory`, `CategoryGroup`, `NewCategoryGroup` via `$inferSelect`/`$inferInsert`. Re-export from [schema/index.ts](../../src/db/schema/index.ts).

**P8-02 — FK columns on `transactions` + `category_rules`.**
- `transactions`: add `categoryId uuid` FK → `categories.id` (`onDelete: set null`, nullable). Add index `transactions_category_id_idx`. **Keep the existing `category` text column** (cache + rollback). Add a composite index `(category_id, posted_at)` to cover the dominant analytics group-by.
- `category_rules`: add `categoryId uuid` FK → `categories.id` (`onDelete: restrict` — deleting a category in use should require reassigning rules; surface a friendly error). Keep `category` text.

**P8-03 — Seed map + rewritten seed.**
- Rewrite [src/lib/categorization/seed.ts](../../src/lib/categorization/seed.ts):
  - `DEFAULT_GROUPS` (Income, Housing, Food, Transport, Utilities, Shopping, Entertainment, Health, Finance, Transfers, Other).
  - `DEFAULT_CATEGORIES` (leaf → group → kind), covering the existing ~12 categories **plus the screenshot's gaps**: Venmo/Zelle/CashApp/Apple Cash → *Transfers* (`kind=transfer`) **unless** the owner reclassifies; Mortgage/Loan payment → *Housing*/*Finance*; State Pension Board / Payroll → *Income*; CITI CARD / credit-card payment + WEB XFER → *Transfers*.
  - `DEFAULT_RULES` updated to reference category **names** (resolved to ids during seed), with new regexes for the screenshot payees (`VENMO`, `ZELLE|ZELLE P2P`, `CASH ?APP`, `APPLE CASH`, `SOCIAL SECURITY|SSA TREAS`, `WEB XFER|XFER (TO|FROM)`, `MORTGAG(E)?|SUN WEST`, `INSTALLMENT LOAN`, `CITI CARD ONLINE PAYMENT`, `PAYPAL`, `NATURAL GAS|GAS & ELECTRIC`).
  - `seedDefaultCategoriesAndRulesIfEmpty()` — idempotent (no-op if `categories` non-empty); inserts groups, then categories, then rules wired to `categoryId`. Replaces `seedDefaultRulesIfEmpty()` (keep a thin shim or update all call sites: `persist.ts`, `categories/page.tsx`).

**P8-04 — One-shot backfill.**
- `src/lib/categorization/backfill.ts`: `backfillCategories()` — idempotent:
  1. Ensure seed groups/categories exist (calls P8-03).
  2. Collect distinct non-null `transactions.category` ∪ `category_rules.category`. For each not already a `categories` row, create a leaf under *Other* (`kind='expense'`) — unless it matches a known seed name (case-insensitive).
  3. `UPDATE transactions SET category_id = c.id FROM categories c WHERE lower(transactions.category) = lower(c.name) AND transactions.category_id IS NULL`.
  4. Same for `category_rules`.
  5. Return counts `{ groupsCreated, categoriesCreated, txnsLinked, rulesLinked }`.
- Expose via [src/worker/run-once.ts](../../src/worker/run-once.ts) (matches the existing one-shot pattern) so it runs once post-deploy. Safe to re-run.

**P8-05 — Match engine returns category id.**
- [src/lib/categorization/match.ts](../../src/lib/categorization/match.ts): `matchCategory` returns `{ categoryId: string; name: string } | null` (or `string | null` of the id — pick id; callers fetch name from a small cache map). Update `sortRules`/cache untouched.
- Update writers: [persist.ts](../../src/lib/importers/persist.ts) `buildPreview`/`persistImportBatch`/`recategorizeAll` set `categoryId` (keep writing the legacy `category` text from the resolved name for the cache column), and [sync-plaid-item.ts](../../src/worker/jobs/sync-plaid-item.ts).
- **Run the full existing importer + sync Vitest suites after this change — it is the highest-regression-risk task in the phase.**

**P8-06 — Category CRUD queries + server actions.**
- `src/lib/categories/queries.ts`: `listCategoriesWithGroups()`, `getCategory`, `createCategory`, `updateCategory` (rename/recolor/regroup/rekind/archive), `archiveCategory` (set `archivedAt`; archived categories stay valid for history but drop from pickers), `mergeCategory(fromId, toId)` (repoint transactions + rules, then archive source — needed for cleaning up backfilled duplicates).
- `src/app/settings/categories/category-actions.ts`: server actions wrapping the above (`requireUser()` → Zod validate → mutate → `revalidatePath('/settings/categories')` + `/analysis`). *Skill: `zod-validation-expert`* — `categorySchema` in `src/lib/schemas/`.

**P8-07 — Batch 1 tests.** *Skill: `test-driven-development`.*
- `match.test.ts` updated for id return.
- `backfill.test.ts` (integration, test DB): backfill is idempotent; every non-null free-text value ends linked; unknown values land under *Other*; re-run changes nothing.
- `seed.test.ts`: seeding is idempotent; rules resolve to real category ids; transfer-kind assigned to Venmo/XFER/CC-payment.

### Batch 2 — Fast categorization UX

*Skills: `nextjs-app-router-patterns`, `tailwind-patterns`, `frontend-security-coder` (payee strings are user/bank data rendered in the queue — escape, no `dangerouslySetInnerHTML`).*

**P8-08 — Managed category picker + inline create.**
- Replace the free-text `<datalist>` in [category-cell.tsx](../../src/app/accounts/[id]/category-cell.tsx) with a picker over real categories (grouped). Add an inline **"+ New category…"** affordance that calls `createCategory` (P8-06) and assigns it in one go.
- Add **"…and make a rule"** checkbox: on assign, optionally create a `category_rules` row from the transaction's payee (a literal-escaped regex of `name`, `field='name'`, default priority) via `createRuleAction`. This is the "all future ones auto-categorize" lever.
- `setTransactionCategoryAction` switches to `categoryId` (keep writing the cache text).

**P8-09 — Bulk "Review uncategorized" queue.**
- New route `src/app/analysis/review/page.tsx` (or `/transactions/review`): server-loads uncategorized transactions (`category_id IS NULL`) across **all** accounts, **grouped by normalized payee** (reuse [src/lib/importers/normalize.ts](../../src/lib/importers/normalize.ts) for the grouping key) with count + total per group.
- Client island: per payee-group, one category picker → **"Categorize all N"** (one server action bulk-updates every txn in the group) + a **"create rule from this payee"** toggle so the group never reappears.
- Server action `bulkSetCategoryAction(txnIds, categoryId, { makeRule })` — Zod-validated id list, ownership implicit (single user), `categoryOverriddenAt` set (these are explicit human choices), `revalidatePath`.

**P8-10 — Rule editor wired to category picker.**
- Update [rule-form.tsx](../../src/app/settings/categories/rule-form.tsx) + [actions.ts](../../src/app/settings/categories/actions.ts): the rule "Category" free-text becomes the managed picker (with inline-create). `createRuleAction` accepts `categoryId`. Confirm/add `updateRuleAction` if Phase 7 Batch 4 didn't land it.
- Categories page gains a **Categories & Groups** management section (list, rename, recolor, regroup, set kind, archive, merge) above the rules table — this is the "don't make me go to a separate page just to add a category" fix from IDEAS2.md.

**P8-11 — Batch 2 tests.** Action-level: `bulkSetCategoryAction` updates all ids + optionally creates exactly one rule; inline-create assigns the new category; rule-from-payee escapes regex metacharacters in the payee. (UI components stay sparingly tested per CLAUDE.md.)

### Batch 3 — Spending analytics (historical)

*Skills: `postgres-best-practices`, `nextjs-app-router-patterns`, `tailwind-patterns`, `typescript-pro`; charts per ADR-005/013.*

**P8-12 — Analytics aggregation library.** `src/lib/analytics/`:
- `spendByCategory({ from, to, accountIds?, groupBy: 'category'|'group' })` → rows of `{ id, name, kind, total: string }`. Spend = `-SUM(amount)` over `kind='expense'`; income separate; **`kind='transfer'` excluded**.
- `spendByMonth({ from, to, accountIds?, categoryIds? })` → `{ month: 'YYYY-MM', byCategory: Record<id,string>, income, expense, net }` for stacked-bar + income/expense over time.
- `categoryDetail(categoryId, range)` → monthly series + transaction list.
- All money returned as **strings**, summed in SQL with `numeric` (never `Number`); the chart islands do the single `Number()` at the display edge. Date bucketing via `date_trunc('month', posted_at)`.

**P8-13 — `/analysis` page + nav.**
- `src/app/analysis/page.tsx` (server component): range selector (URL search params — last 3/6/12 mo / YTD / custom), account filter (URL param), summary tiles (total income, total expense, net, savings rate).
- Add **Analysis** to [nav-menu.tsx](../../src/components/nav-menu.tsx) `LINKS`.

**P8-14 — Chart islands (Recharts).**
- `spend-by-month-chart.tsx` — stacked bar (category/group share per month) + a net line.
- `category-breakdown-chart.tsx` — donut/bar of spend share for the selected range (reuse the Phase 5 donut shape if present).
- `category-trend-chart.tsx` — line for a single category/group over time (on the detail view).
- Each: `"use client"`, `ResponsiveContainer`, `Intl.NumberFormat`, dark-mode `currentColor`, copying [net-worth-chart.tsx](../../src/app/net-worth-chart.tsx).

**P8-15 — Drill-down.** Category/group row → `/analysis/category/[id]` (monthly trend + paginated transaction list reusing `listTransactions` filtered by `categoryId`). Per-account spending reuses the same lib with `accountIds=[id]`, surfaced as a section on the existing account page.

**P8-16 — Batch 3 tests.** *Skill: `test-driven-development`.* Aggregation correctness on a fixture ledger: expense excludes transfers; income/expense signs correct; month bucketing on a UTC boundary; multi-account filter; empty-range → zeros (no NaN). These are pure SQL+map functions — high TDD payoff.

### Batch 4 — Budgets (monthly per-category targets)

*Skills: `drizzle-orm-expert`, `zod-validation-expert`, `test-driven-development`.*

**P8-17 — `category_budgets` schema.** `src/db/schema/budgets.ts`: `id uuid pk`, `categoryId uuid` FK → `categories.id` (`onDelete: cascade`) **UNIQUE**, `amount numeric(18,2) not null`, `currency text not null default 'USD'`, `createdAt`/`updatedAt`. Migration + index. Re-export.

**P8-18 — Budget queries + actions.** `src/lib/budgets/`:
- `setBudget(categoryId, amount)` (upsert, `ON CONFLICT (category_id) DO UPDATE`), `deleteBudget`, `listBudgets()`.
- `budgetVsActual(month)` → per category `{ name, target: string, actual: string, remaining: string, pct: number }` using P8-12 actuals + `Money` math; group rollup = sum of children. Server actions in `src/app/analysis/budgets/actions.ts` (Zod-validated money via `Money.fromString`, never `Number`).

**P8-19 — Budgets UI.** `src/app/analysis/budgets/page.tsx`: per-category target inputs (grouped), current-month actual-vs-target progress bars (over = red, under = green), month switcher (URL param), totals row. Lives under Analysis.

**P8-20 — Batch 4 tests.** Budget math: actual-vs-target for a month with mixed signs + transfers excluded; remaining = target − actual via `Money` (penny-exact); over-budget pct; group rollup sums children; upsert idempotency.

### Batch 5 — Forecast (trailing average)

*Skills: `test-driven-development`, `typescript-pro`.*

**P8-21 — Forecast function.** `src/lib/analytics/forecast.ts`: `forecastMonthlySpend(history: MonthlyTotals, { months: 3 })` → projected next-month spend per category = mean of trailing N non-empty months (skip leading empties; `Money`-based mean, banker's-rounding-free string math). Pure, no I/O.

**P8-22 — Forecast surfacing.** On `/analysis`: an extended series on `spend-by-month-chart` showing projected months as a dashed segment; on budgets page, a "projected end-of-month" marker per category from month-to-date run-rate. Clearly label projections as estimates.

**P8-23 — Batch 5 tests.** Forecast: trailing-3 average with a gap month; single-month history; all-zero history → zero (no divide-by-zero); penny precision.

---

## Testing (per CLAUDE.md §Testing Philosophy)

**Always-test surfaces this phase adds** (Vitest, against the test Postgres where DB is involved):
- **Backfill idempotency + no-data-loss** (P8-07) — historical data is the product.
- **Match-engine id resolution** + importer/Plaid sync no-regression (P8-05/07).
- **Spend aggregation** — sign convention + transfer exclusion + month bucketing (P8-16).
- **Budget actual-vs-target money math** (P8-20) and **forecast averaging** (P8-23) — pure functions, crisp I/O.

**Sparingly tested**: the picker, review-queue, analysis pages, and chart islands (UI per the rules — cover the actions and the math, not the buttons).

**Playwright** (extend the existing critical-flow suite only if cheap): import a QFX → open Review queue → categorize-all a payee group → confirm it leaves the queue and shows on `/analysis`. Optional; don't add a flaky flow just to have one.

## Migration & data safety

- One Drizzle migration (`drizzle-kit generate` → `migrate`) for **all** Batch-1 schema (3 tables + 2 FK columns + indexes). The **backfill** (P8-04) is a separate idempotent runtime step (via `run-once`), **not** raw SQL in the migration, so it's testable and re-runnable.
- **No column is dropped.** `transactions.category` / `category_rules.category` stay as cache + rollback. A later plan drops them *with a paired backup step* (CLAUDE.md) once the structured path is proven in production.
- Take a `pg_dump` (existing backup job, [docs/BACKUP.md](../../docs/BACKUP.md)) **before** running the backfill on real data.

## Sequencing & shipping

1. **P8-00** (docs/ADR) — no deploy.
2. **Batch 1** — migrate, deploy app+worker, run `backfill` once via `run-once`, verify counts; rerun importer/sync suites for regression. This is the gate.
3. **Batch 2** — categorization UX; deploy app (worker unchanged unless `seed`/`match` shared code shifted — then recreate worker too).
4. **Batch 3** (analytics) and **Batch 4** (budgets) — independent; can share one image push.
5. **Batch 5** (forecast) — smallest; bundle with 3/4 or ship after.
- Each batch: `make image-push PLATFORMS=linux/amd64` then `docker compose … up -d --force-recreate app` (+ `worker` when worker-shared code changed).

## Decisions to confirm at kickoff

1. **Transfer classification of P2P apps** — treat Venmo/Zelle/CashApp/Apple Cash as `kind='transfer'` by default (recommended; keeps them out of spend) vs `expense`? They're ambiguous (could be either); default to transfer, let the owner reclassify per-category. **Confirm.**
2. **Analysis route name** — `/analysis` (recommended) vs `/spending` vs `/reports`.
3. **Forecast window** — trailing **3** months default (recommended) vs 6.
4. **Budget granularity** — category-level targets with group rollup (recommended, per ADR-018) vs also allow directly setting a group-level target.
5. **Drop legacy `category` text columns** — keep this phase (recommended), schedule the backed-up drop for a Phase 8.1 cleanup.
