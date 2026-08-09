# PLAN — Phase 13 (Enhance the dashboard: turn the original Phase-1 net-worth page into a curated, at-a-glance command center that surfaces the eleven phases of features we've shipped — allocation, performance, spending-vs-budget, and forward income — without leaving the home page)

> The dashboard ([src/app/page.tsx](../../src/app/page.tsx)) is the **only** screen that hasn't moved since Phase 1. It still shows exactly three things: the net-worth number, the history line chart, and a flat accounts table. Meanwhile Phases 2–12 added asset allocation, a TWR/XIRR performance engine, forward dividend income, spending analytics + budgets, anomaly alerts, a paper watchlist with price targets, personal assets, and global search — **none of which the user sees on landing.** Round 7 ([IDEAS2.md](IDEAS2.md)) names it exactly: *"Enhance Dashboard. The dashboard has not been touched since we added several features to my-money. What can and should we add to the dashboard to make it more informative given all of the features we have added?"*
>
> The user confirmed the shape (clarifying-question round, 2026-06-28):
> 1. **A curated, fixed-section dashboard** — a hand-designed, responsive layout with the most valuable widgets in a deliberate order. **No drag-and-drop, no per-widget show/hide, no persisted custom layout** (YAGNI for a single user; a customization grid would add a persistence table + a client DnD dependency to buy one person the ability to rearrange their own page).
> 2. **The four highest-value cards**, on top of the existing net-worth hero: **asset allocation**, **investment performance**, **spending vs budget (this month)**, and **dividend / forward income**. Secondary cards (open **alerts**, **watchlist movers**) round out the page because their data is already computed and cheap to surface.
> 3. A **savings-rate card is added by [PLAN14.md](PLAN14.md)** (Round 8) — this plan leaves a labeled slot for it so the two phases compose cleanly.
>
> The good news matches Phases 11–12: this is **100% additive, read-only, and zero-egress.** It introduces **no new tables, no new columns, no migration, and no outbound HTTP.** Every card reads from a compute/query function that **already exists** — `computeNetWorth`, `allocationByAssetClass`, `twr`/`gainLossSeries`, `budgetVsActual`, `forwardIncome`, `listOpenAlerts`. Phase 13 is **composition, not new capability**: a dashboard data loader that fans those functions out in parallel, a set of server-rendered "card" sections that reuse the existing Recharts islands, and a single shared time-range control. The whole phase is `src/lib/dashboard/` + `src/components/dashboard/` + a rewritten [page.tsx](../../src/app/page.tsx).
>
> Phase 13 closes the round in six batches: (0) **scope gate + ADR**; (1) **dashboard data layer** — one typed `loadDashboard(range)` that composes the existing loaders + the shared range param; (2) **net-worth hero + allocation + performance cards**; (3) **spending-vs-budget + forward-income cards**; (4) **alerts + watchlist-movers cards + the savings-rate slot**; (5) **page assembly** — the curated responsive grid, empty/insufficient-data states, nav; (6) **tests, docs, perf sanity, E2E**.
>
> **Hard boundary (CLAUDE.md §Domain Scope) — read before writing code.** The dashboard is a *read/compose surface*. Phase 13 does **NOT** add: any new metric the underlying libraries don't already compute (no new analytics — it *displays* what Phases 2–12 built; if a card needs a number, it comes from an existing tested function, not new math invented in a component); a configurable/customizable widget system, saved layouts, or a "dashboard settings" table (explicitly rejected — curated fixed sections per the kickoff); any write action from the dashboard (every card is read-only and links out to the page that owns the mutation); a third-party dashboard/BI/embed (no Grafana, Metabase, Looker, charting SaaS — §Privacy + the app *is* the dashboard, per SKILLS.md); or new chart libraries (Recharts only, per ADR-005/013 — reuse the existing islands). Anything larger needs a FEATURE.md decision update first (P13-00 records the scope note).
>
> **Privacy (CLAUDE.md §Privacy & Data Sovereignty) — binding; this phase introduces _no egress whatsoever_.** Like search (Phase 12), the dashboard touches **only local Postgres** through functions that are already on the read path. No balance, ticker, payee, or amount leaves the box; there is no outbound HTTP on any dashboard code path, and nothing financial is logged. The page is `requireUser()`-guarded exactly as today. P13-00 + the Batch 6 privacy pass add a regression test asserting no dashboard module imports an HTTP client.
>
> **Companion docs** — read for context, do not duplicate:
> - [PLAN12.md](PLAN12.md) / [PLAN11.md](PLAN11.md) / [PLAN9.md](PLAN9.md) — the **template for this phase's structure** (batch/ADR/scope-gate discipline, additive-posture, "what already exists" inventory, URL-param-as-state, server-component-first with thin client islands, `Number()`-only-at-the-display-edge).
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Privacy (no egress, no SaaS dashboards, never log financial data), §Domain Scope (the app is the dashboard; no BI tool), §Performance (profile before optimizing; cache expensive computations; don't render 10k DOM nodes — cards are summaries with links, not full tables), §Architecture (separate UI / business-logic / data layers — cards never query the DB directly, they call the dashboard loader), §Money & Numeric Precision (`numeric` stays string; `Number()` only at `Intl` formatting), §Testing Philosophy (the loader composition + delta math are "always-test"; pure UI cards are sparingly tested).
> - [IDEAS.md](IDEAS.md) §11 Decision Log (current max **ADR-028** after Phase 12; Phase 13 appends **ADR-029**), ADR-005/013 (Recharts island posture — every card chart is the same "thin client island, server does the data" pattern), ADR-021 (performance methodology — the performance card renders `twr`/`gainLossSeries`; it must honor ADR-021's "show 'insufficient history' rather than a bogus return" rule), ADR-018 (budgets — the spend-vs-budget card reads `budgetVsActual`).
> - [SKILLS.md](SKILLS.md) §Suggested Workflow — see §Skills Map below.

---

## What already exists (do not rebuild — compose these)

Phase 13 is **overwhelmingly reuse**. Every number on the new dashboard is produced by a function that already ships and is already tested. Inventory before writing a line of code:

- **Net worth** — [computeNetWorth(asOf, baseCurrency)](../../src/lib/net-worth/compute.ts) returns `{ total, asOf, items[] }`; [netWorthSeries(baseCurrency)](../../src/lib/net-worth/compute.ts) returns the dated history. The current [page.tsx](../../src/app/page.tsx) already calls both. The hero card keeps them and adds a **range delta** (value now vs value at range start).
- **Asset allocation** — [allocationByAssetClass](../../src/lib/investments/allocation.ts) / `allocationByAccount` / `allocationBySector` consume a `ValuedHolding[]`; the valued-holdings loader behind [investments/page.tsx](../../src/app/investments/page.tsx) (via [src/lib/investments/queries.ts](../../src/lib/investments/queries.ts)) already assembles them. The chart island is [allocation-chart.tsx](../../src/app/investments/allocation-chart.tsx) — **reuse it verbatim** in a card.
- **Performance** — [valueSeries](../../src/lib/investments/performance.ts) / `gainLossSeries` / `twr` / `benchmarkTwr` over `holding_snapshots` (Phase 9, ADR-019/021). The dedicated [investments/performance/page.tsx](../../src/app/investments/performance/page.tsx) already assembles these and renders [value-over-time-chart.tsx](../../src/app/investments/performance/value-over-time-chart.tsx) + [return-vs-benchmark-chart.tsx](../../src/app/investments/performance/return-vs-benchmark-chart.tsx). The card shows a **compact** version (one sparkline + the TWR figure) and links to the full page. **Honor ADR-021**: if the selected range has no real snapshot data, render "insufficient history," never a fabricated %.
- **Spending vs budget** — [budgetVsActual(month)](../../src/lib/budgets/queries.ts) returns per-category budget vs actual + group rollups; [spendingSummary](../../src/lib/analytics/spending.ts) returns the month's totals; [forecast.ts](../../src/lib/analytics/forecast.ts) the trailing-average projection. The [/analysis](../../src/app/analysis/page.tsx) page owns the deep view; the card shows **this month's** total-spend-vs-budget bar + the top 3 over-budget categories, linking to `/analysis`.
- **Forward income** — [forwardIncome(holdings, currency)](../../src/lib/investments/forward-income.ts) returns the forward-12-month dividend estimate + per-account/holding breakdown; [income.ts](../../src/lib/investments/income.ts) the realized-income history. The [investments/forecast/page.tsx](../../src/app/investments/forecast/page.tsx) owns the deep view; the card shows the forward-12-mo number + yield-on-cost, linking out.
- **Alerts** — [listOpenAlerts](../../src/lib/alerts/queries.ts) / [openAlertCount](../../src/lib/alerts/queries.ts) (Phase 6, ADR-015). The card shows the open count + the most recent 3 titles (titles are content-free per ADR-015), linking to [/alerts](../../src/app/alerts/page.tsx).
- **Watchlist** — [src/lib/watchlist/](../../src/lib/watchlist/) paper-valuation queries (Phase 11, ADR-025) compute each watched symbol's current value + gain/loss on the fly. The "movers" card shows the top ±movers since the pretend/purchase date (or day-over-day), linking to [/watchlist](../../src/app/watchlist/page.tsx).
- **Time-range helper** — [src/lib/analytics/range.ts](../../src/lib/analytics/range.ts) already maps a range token to a `{ from, to }` window (used by the analysis page). The dashboard reuses it for the single `?range=` control so the hero history + performance card share one window.
- **Chrome + auth** — [app-nav.tsx](../../src/components/app-nav.tsx) / [nav-menu.tsx](../../src/components/nav-menu.tsx) (the dashboard is the `/` home link already present); [requireUser](../../src/lib/auth/require-user.ts) guards the page exactly as today.
- **Money formatting at the edge** — [Money.format()](../../src/lib/money/money.ts); `Number()` only at display. Cards never do money arithmetic; deltas reuse `Money` subtraction (no JS float).

---

## ADRs locked at plan time

One decision surfaces in Phase 13. It is 🔲 **Proposed** — append to [IDEAS.md](IDEAS.md) §11 Decision Log (next free number **ADR-029**; verified ADR-028 is current max on this branch) after this plan is approved (P13-00).

---

### ADR-029 — A curated, server-rendered dashboard of reusable "card" sections that reuse existing compute functions; one shared `?range=` control; no customization, no persistence, no new metrics

**Status**: 🔲 Proposed

**Context**: Round 7 asks "what should we add to the dashboard." The temptation is two-fold and both are traps: (a) build a *customizable* widget grid (drag/drop, show/hide, saved layouts) — which needs a persistence table, a client DnD library, and reset/migration logic to serve exactly one user who can already edit the code; or (b) compute *new* numbers inside the dashboard components — which scatters business logic into the UI layer (CLAUDE.md §Architecture) and risks the dashboard disagreeing with the dedicated pages. The user chose a **curated fixed layout**, and every figure must come from an **already-tested library function**.

**Decision**:
1. **Curated fixed sections.** The dashboard is a hand-designed, responsive layout: a full-width **net-worth hero** (value + range delta + history chart), then a responsive **card grid** — allocation, performance, spending-vs-budget, forward-income, alerts, watchlist-movers, and a slot reserved for PLAN14's savings-rate card. Order and breakpoints are fixed in the template. **No drag/drop, no per-widget config, no saved-layout table.**
2. **Cards are dumb; the loader is smart.** Cards are server components that receive already-computed, typed data from a single `loadDashboard(range)` in `src/lib/dashboard/`. A card **never** queries the DB or computes a financial figure — it formats and links. The loader composes the existing functions (§What already exists) and runs the independent ones in parallel (`Promise.all`). This keeps the dashboard's numbers **identical by construction** to the dedicated pages (same function, same result).
3. **One shared time-range control.** A single `?range=` URL param (e.g. `1M | 3M | 6M | 1Y | YTD | ALL`, default `1Y`) drives the hero history window and the performance card, via the existing [analytics/range.ts](../../src/lib/analytics/range.ts). State lives in the URL (shareable, refresh-stable, back-button-correct — same posture as Phase 12 filters). A thin client island is the range toggle; the server re-renders.
4. **Charts reuse the existing Recharts islands** (ADR-005/013) — `allocation-chart.tsx`, the performance sparkline, the income/spend bars — wrapped in compact card frames. No new chart component types, no new chart dependency.
5. **Graceful degradation.** Each card renders an empty/insufficient-data state when its inputs are absent (no holdings ⇒ allocation/performance/income cards show "Add an investment"; no budgets ⇒ spend card shows just the spend total with a "Set budgets" link; no snapshot history in range ⇒ performance shows "insufficient history" per ADR-021). The dashboard never errors because one feature is unused.

**Consequences**:
- ✅ Zero new tables, zero migration, zero egress. The phase is pure composition + presentation.
- ✅ Dashboard figures can't drift from the dedicated pages — they call the same functions.
- ✅ Fastest path to "informative landing page"; the single user can re-curate by editing the template, which is cheaper than a config system they'd maintain.
- ⚠️ The dashboard fans out several queries on one request. Mitigated by `Promise.all`, by each card being a *summary* (small result sets + links, not full tables — CLAUDE.md §Performance), and by the underlying functions already being indexed/snapshot-backed. P13-23 measures it; if a card is heavy, it gets a `loading.tsx` Suspense boundary, not a redesign.
- ⚠️ The range control only governs the time-series cards (hero history, performance). Allocation/budget/income are point-in-time/this-month by nature; the control intentionally doesn't touch them (documented in the card copy).

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Customizable widget grid (drag/drop, saved layout) | Persistence table + client DnD dep + reset/migration logic for one user who can edit the source. YAGNI; the kickoff explicitly chose curated. |
| Cards compute their own numbers | Scatters business logic into the UI (CLAUDE.md §Architecture); risks the dashboard disagreeing with the dedicated pages. Loader-composes-tested-functions keeps them identical. |
| Embed a BI tool (Grafana/Metabase) pointed at Postgres | Ships financial data into a second service + new infra to self-host; the app already *is* the dashboard (SKILLS.md skips observability SaaS). §Privacy + YAGNI. |
| One mega time-range that also re-aggregates budgets/allocation | "This month's budget" and "current allocation" aren't range-parameterized concepts; forcing them under one control confuses semantics for no gain. |

---

## Batches

> Each task is atomic and independently reviewable. Task IDs are `P13-NN`. Batches land as separate commits/PRs following the Phase 11/12 cadence. **P13-00 gates everything** — no code before the scope note + ADR are recorded.

### Batch 0 — Scope gate + ADR

- **P13-00** — Record the §Domain Scope + §Privacy scope note (no customization/persistence, no new metrics, no BI/SaaS dashboard, no write actions, read-only zero-egress) in this plan's header (done above) and append **ADR-029** to [IDEAS.md](IDEAS.md) §11 Decision Log (verify ADR-028 is still the max at commit time). Update [FEATURE.md](FEATURE.md) with a Round 7 → Phase 13 section mirroring the Phase 11/12 blurbs. **Gate: nothing in Batch 1+ starts until this is committed.**

### Batch 1 — Dashboard data layer

- **P13-01** — `src/lib/dashboard/range.ts` (or reuse [analytics/range.ts](../../src/lib/analytics/range.ts) directly): a typed `DashboardRange = "1M" | "3M" | "6M" | "1Y" | "YTD" | "ALL"`, a parser that defaults to `"1Y"` for missing/garbage `?range=`, and a `rangeWindow(range): { from, to }`. **Vitest** for the default + window boundaries (YTD vs ALL edge).
- **P13-02** — `src/lib/dashboard/loader.ts`: a single `loadDashboard(range): Promise<DashboardData>` that composes the existing loaders — `computeNetWorth`, `netWorthSeries` (sliced to range), valued-holdings → `allocationByAssetClass`, performance (`valueSeries`/`gainLossSeries`/`twr`/`benchmarkTwr`), `budgetVsActual(currentMonth)` + `spendingSummary`, `forwardIncome`, `listOpenAlerts`, watchlist movers — fanning the independent reads out with `Promise.all`. Returns a typed `DashboardData` with one field per card, each carrying a discriminated `{ status: "ok" | "empty" | "insufficient", … }` so cards render their degraded state without re-deriving "is this empty." **No new DB queries** — it calls library functions only (CLAUDE.md §Architecture).
- **P13-03** — `src/lib/dashboard/delta.ts`: a pure `rangeDelta(series, range): { abs: Money, pct: string | null, direction: "up"|"down"|"flat" }` computing now-vs-range-start from the net-worth series using `Money` subtraction (no JS float; `pct` is `null` when the start value is zero). **Vitest** (always-test — it's display math on money). Mirrors the ADR-021 "no bogus number" rule: empty/one-point series ⇒ `direction: "flat"`, `pct: null`.

### Batch 2 — Hero + allocation + performance cards

- **P13-04** — `src/components/dashboard/card.tsx`: the shared card frame (server component) — title, optional "→ deep page" link, body slot, and a `<DashboardCard.Empty>` sub-component for the degraded state. Tailwind, dark-mode, consistent with existing chrome ([page.tsx](../../src/app/page.tsx) section styling). Pure presentation.
- **P13-05** — `src/components/dashboard/range-toggle.tsx`: a thin client island — the `?range=` segmented control (`useRouter`/`useSearchParams`, resets nothing else), accessible (`role="radiogroup"`). Reused by the hero + performance cards (they read the same param).
- **P13-06** — **Net-worth hero**: rewrite the top of [page.tsx](../../src/app/page.tsx) to show `total.format()`, the **range delta** (P13-03) with ▲/▼ + colored sign, the range toggle (P13-05), and the history chart (existing `NetWorthChart`, sliced to range). Keep the accounts table below (it's still useful) but de-emphasize it under the cards.
- **P13-07** — **Allocation card** (`src/components/dashboard/allocation-card.tsx`): renders the existing [allocation-chart.tsx](../../src/app/investments/allocation-chart.tsx) island with `allocationByAssetClass` data from the loader, plus a compact legend (top classes + %), linking to `/investments`. Empty state ("Add an investment to see your allocation") when no valued holdings.
- **P13-08** — **Performance card** (`src/components/dashboard/performance-card.tsx`): the TWR figure for the selected range + a compact `gainLossSeries` sparkline + the benchmark delta (vs `^GSPC`), linking to `/investments/performance`. **Honor ADR-021**: render "Insufficient history for this range" (not a number) when the range lacks real snapshots. Reuses the performance islands in a small frame.

### Batch 3 — Spending-vs-budget + forward-income cards

- **P13-09** — **Spending-vs-budget card** (`src/components/dashboard/spend-card.tsx`): this month's total spend vs total budget as a progress bar (over/under colored), the trailing-average forecast end-of-month figure ([forecast.ts](../../src/lib/analytics/forecast.ts)), and the top 3 over-budget categories from `budgetVsActual`, linking to `/analysis`. Degraded states: no budgets ⇒ show spend total + "Set budgets →"; no spend this month ⇒ "No spending recorded yet."
- **P13-10** — **Forward-income card** (`src/components/dashboard/income-card.tsx`): the forward-12-month dividend estimate from `forwardIncome`, the blended forward yield + yield-on-cost, and a one-line "next likely payers" hint from the per-holding breakdown, linking to `/investments/forecast`. Empty state when no dividend-paying holdings. **Carry the ADR-022 framing** — this is an *estimate* label where the number could read as a promise.

### Batch 4 — Alerts + watchlist-movers cards + savings-rate slot

- **P13-11** — **Alerts card** (`src/components/dashboard/alerts-card.tsx`): the open-alert count (badge) + the 3 most recent open-alert **titles** (content-free per ADR-015 — never render a balance/figure here), linking to `/alerts`. Empty state: "No open alerts" (a calm, good-news state, styled distinctly).
- **P13-12** — **Watchlist-movers card** (`src/components/dashboard/movers-card.tsx`): the top ±2 movers from the watchlist paper-valuation queries (gain/loss since pretend date or day-over-day), linking to `/watchlist`. Empty state when the watchlist is empty. Reuses the Phase 11 valuation — no new compute.
- **P13-13** — **Savings-rate slot**: add a labeled, documented placeholder position + a `DashboardData.savingsRate?: …` optional field on the loader's return type so [PLAN14.md](PLAN14.md) drops the savings-rate card in without restructuring the grid. The card itself ships in Phase 14; this task only reserves the seam (and renders nothing when the field is absent).

### Batch 5 — Page assembly

- **P13-14** — Assemble the curated grid in [page.tsx](../../src/app/page.tsx): hero (full width) → responsive 2-up/3-up card grid (`sm:`/`lg:` breakpoints, single column on mobile per the Phase 6 responsive posture) → accounts table at the bottom. One `await loadDashboard(range)` feeds every card; cards receive typed slices. Verify `Promise.all` fan-out (one round-trip of parallel queries, not N sequential awaits).
- **P13-15** — `src/app/loading.tsx` (or per-card `<Suspense>`): a skeleton for the dashboard so a slow card (e.g. performance over ALL) doesn't block first paint. Keep it simple — skeleton cards matching the grid.
- **P13-16** — Empty-first-run polish: when there are no accounts at all, the dashboard shows the existing "Add your first account" prompt (don't render eight empty cards on a brand-new install). Confirm the curated grid collapses gracefully from "everything" to "nothing."

### Batch 6 — Tests, docs, privacy pass, perf, E2E

- **P13-17** — Vitest for the always-test surfaces (gather): the range parser/window (P13-01), `rangeDelta` money math + empty-series guards (P13-03), and the loader's status-discrimination (`ok`/`empty`/`insufficient`) for each card given representative fixture inputs (mock the underlying library functions — test the *composition*, not the already-tested libs).
- **P13-18** — **Privacy regression test** (mandatory, CLAUDE.md §Privacy): assert no module under `src/lib/dashboard/` nor `src/components/dashboard/` imports an HTTP client or a price/Plaid fetcher — the dashboard is local-compose-only, zero egress — and that no financial figure is passed to a logger. (Mirrors the Phase 11/12 privacy-regression posture.)
- **P13-19** — `docs/DASHBOARD.md`: the curated card inventory + which library function feeds each card (the "single source of truth" map), the `?range=` contract, the degraded-state behavior, and the explicit privacy/scope boundaries (read-only, local-only, no customization). Link it from [README.md](../../README.md) + [FEATURE.md](FEATURE.md).
- **P13-20** — Perf sanity (CLAUDE.md §Performance — measure, don't guess): time `loadDashboard("ALL")` against a seeded multi-year dataset; confirm the fan-out is parallel and total time is acceptable; confirm no card triggers an N+1. Record findings in `docs/DASHBOARD.md`; add a Suspense boundary only if a specific card measures slow (don't pre-optimize).
- **P13-21** — **Playwright** E2E (one focused flow, per CLAUDE.md §Testing Philosophy): seed accounts + holdings + a budget + a snapshot history, load `/`, assert the hero value + at least the allocation and spend cards render real figures, switch the range toggle and assert the hero history + performance card update, and assert each "→ deep page" link navigates. Keep it to this single critical path.

---

## Skills Map (when each pays off this phase)

Per [SKILLS.md](SKILLS.md) §Suggested Workflow — invoke at the moment of leverage, not preemptively:

- **`nextjs-app-router-patterns`** — Batch 1–5 (server-component cards reading one composed loader; the thin range-toggle island; `loading.tsx`/Suspense; the parallel `Promise.all` fan-out on the page).
- **`tailwind-patterns`** — Batch 2–5 (the curated responsive card grid, breakpoints, dark-mode, the card frame, mobile single-column — consistent with the Phase 6 responsive work).
- **`react-state-management`** — Batch 2 (only the range toggle has client state; confirm it stays URL-param-driven, no store — per ADR-003/029).
- **`postgresql-optimization`** — Batch 6 P13-20 (only if a card measures slow — `EXPLAIN` the underlying query; otherwise the existing indexes/snapshots suffice).
- **`e2e-testing-patterns`** — Batch 6 P13-21 (the one Playwright dashboard flow).
- **`code-reviewer`** — end-of-phase pass (this phase touches the most-seen screen; a structured review before declaring done).
- **`systematic-debugging`** — reactive, if a card's number disagrees with its dedicated page (it shouldn't — both call the same function; a mismatch is a composition bug).

Note in each batch's PLAN task which skill was the reference when invoked for real (per [SKILLS.md](SKILLS.md) §Maintenance).

---

## Open Items (deferred — record, don't build)

- **Customizable / draggable dashboard** — explicitly deferred (ADR-029 rejected alternatives). Revisit only if the single user genuinely wants to rearrange (cheaper to edit the template until then).
- **Per-card time ranges** — the shared `?range=` governs the time-series cards only. If the user later wants independent ranges per card, revisit; it trades the one-control simplicity for flexibility.
- **Dashboard alert "snooze"/quick-resolve from the card** — the alerts card is read-only/navigate-only this phase (mirrors the Phase 12 palette posture). A write action needs an explicit decision.
- **Configurable "primary metric"** (net worth vs investable assets vs liquid cash as the hero number) — net worth is the hero by default; a metric switcher is a future nicety, not Round 7's ask.
- **Savings-rate card** — built in [PLAN14.md](PLAN14.md) (Round 8); this phase only reserves the slot + the loader seam.
- **~~`netWorthSeries` N+1 (found by P13-20)~~ — FIXED.** [`netWorthSeries`](../../src/lib/net-worth/compute.ts) called `computeNetWorth` once per distinct snapshot date, and each call queried per account and per holding: **O(days × (accounts + holdings))**. Measured on a seeded 3-year book (12 accounts, 32 holdings, 1,096 snapshot days): **~98,000 queries, ~85 s** — 99% of the whole dashboard's load time. It is now a single set-based query plus one liabilities read (**2 statements, 342 ms**), with an optional date window so `?range=1M` reads a month instead of all of history. Numbers are unchanged, proven against the pre-rewrite implementation as an oracle: **0 mismatches over 1,096 points**. Delivered per [PLAN_NETWORTH_SERIES.md](PLAN_NETWORTH_SERIES.md); before/after numbers in [docs/DASHBOARD.md](../../docs/DASHBOARD.md) §Performance, harness at [scripts/dashboard-perf.ts](../../scripts/dashboard-perf.ts) (`pnpm perf:dashboard`), real-data check at [scripts/networth-parity.ts](../../scripts/networth-parity.ts) (`pnpm parity:networth`).

---

*End of PLAN13.md*
