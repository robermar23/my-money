# PLAN — Phase 9 (Investment Depth II: History, Performance, Asset Intelligence, Forward View)

> Phase 5 (PLAN5) built the investment *foundation*: `securities`, `holdings`, `holding_lots`, `investment_transactions`, and a `/investments` dashboard showing **current** positions, cost basis, gain/loss, an asset-allocation donut, and a dividend/interest income breakdown. That is a snapshot of *today*.
>
> Round 3 ([IDEAS2.md](IDEAS2.md)) asks to expand investments the way Phase 8 expanded spend: **"Historical as well as future. Can we bring in any info on the invested assets? How can we slice the data?"** The gap is the same shape Phase 8 closed for cash — there is no per-position *history*, no performance-over-time, no per-security drill-down, no metadata to slice by (sector/industry/region), and no forward-looking view.
>
> Phase 9 closes it in five moves: (1) lay a **per-holding historical foundation** (`holding_snapshots`) so investment value can be sliced over time by asset class / account / security; (2) **enrich securities** with sector, industry, asset type, region, and forward dividend data pulled from the same public market-data source we already use for prices; (3) ship a **performance layer** — value & gain/loss over time, contributions-vs-market-growth, time- and money-weighted return, and a benchmark comparison; (4) add **per-security drill-down and richer slicing** (by sector/region/account/holding, concentration); (5) add a **forward-looking view** — projected dividend income, income-growth trend, a clearly-labeled value projection, and a lightweight goal/retirement marker.
>
> **Hard boundary (CLAUDE.md §Domain Scope) — read before writing any math.** Phase 5's boundary still holds and is *reaffirmed*, not relaxed: every performance figure (gain/loss, TWR, XIRR, projection) is a **display number**, not a tax or advice engine. Phase 9 does **NOT** add tax-lot selection (FIFO/LIFO/specific-ID), wash-sale tracking, realized vs. unrealized capital-gains *reporting*, 1099 generation, or any AI/advice feature. TWR/XIRR are read-only performance *display*; the value projection is a labeled estimate, never a recommendation. If a future ask crosses that line it needs a FEATURE.md decision update first (P9-00 records the scope note).
>
> **Privacy (CLAUDE.md §Privacy & Data Sovereignty) — binding.** The new "asset intelligence" fetch sends **only ticker symbols** outbound to the public market-data endpoint — the exact data category and trust boundary the Phase 2/5 price fetch already crosses. **No quantities, balances, account names, or holdings leave the host.** All analytics are first-party SQL over local Postgres. No third-party analytics SDK, no LLM. P9-00 + the Batch 6 privacy pass make this explicit.
>
> **Companion docs** — read for context, do not duplicate:
> - [PLAN5.md](PLAN5.md) — the investment foundation this extends: ADR-011 (Plaid Investments sync model), ADR-012 (`securities`/`holding_lots`/`investment_transactions` schema + cost-basis precedence), ADR-013 (allocation donut; cash-flow Sankey deferred), and its §Open Items (per-security price-history charts, contributions tracking) which seed this plan.
> - [PLAN8.md](PLAN8.md) — the **template for this phase**: ADR-018's structured-analytics approach, `src/lib/analytics/` aggregation library, the range/account URL-param pattern, the Recharts island-per-chart shape, trailing-average forecast, and the batch/scope-gate discipline. Phase 9 is "Phase 8 for the investment side."
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Money & Numeric Precision (ALL performance/return/yield math through `Money`/`decimal.js`; `Number()` only at the chart display edge; **TWR/XIRR computed with `Decimal`, never native float**), §Domain Scope (boundary above), §Privacy (boundary above), §Background Jobs (new nightly jobs are idempotent, one logical unit each), §Database & Drizzle Specifics ("Never `drop column` … without a paired backup"; `numeric` everywhere; one file per concept), §Testing Philosophy (snapshot computation, return math, income projection are pure "always-test" surfaces).
> - [IDEAS.md](IDEAS.md) §11 Decision Log (current max **ADR-018**; Phase 9 appends ADR-019 → ADR-022), §5 market data (Yahoo for equities + metals, CoinGecko for crypto — the enrichment fetcher slots in here), ADR-005/013 (Recharts island per chart).
> - [SKILLS.md](SKILLS.md) — Phase 5/8 skill maps apply; see §Skills Map below.

---

## What already exists (do not rebuild — extend these)

Phase 9 is overwhelmingly *additive*. Inventory before writing code:

- **Investment schema (Phase 5)**: [securities.ts](../../src/db/schema/securities.ts) (Plaid metadata + canonical-symbol map; `raw jsonb`), [holdings.ts](../../src/db/schema/holdings.ts) (one row per `(account, symbol)`, `security_id` FK, `source`, `cost_basis_overridden_at`), [holding-lots.ts](../../src/db/schema/holding-lots.ts) (optional per-lot basis), [investment-transactions.ts](../../src/db/schema/investment-transactions.ts) (buy/sell/cash/fee/dividend/interest stream, **signed positive=inflow**, `trade_date`, `quantity`, `price`, `fees`). Phase 9 **adds `holding_snapshots`**, **extends `securities`** with enrichment columns, and **adds nothing destructive**.
- **Valuation**: [src/lib/holdings/value.ts](../../src/lib/holdings/value.ts) — `valueHolding(holding, currency, asOf)` = `quantity × latestCloseOnOrBefore(symbol, asOf)`, cash/property at face value. **Already date-parameterized** — Phase 9's history backfill and TWR engine call it at past `asOf` dates with zero changes to the primitive.
- **Snapshots job**: [src/worker/jobs/compute-snapshots-daily.ts](../../src/worker/jobs/compute-snapshots-daily.ts) already iterates every holding to value `investment`/`crypto_ira` accounts via `valueAccountHoldings`. Phase 9 **extends this same pass** to also emit per-holding `holding_snapshots` rows (one pass, no extra price reads) — see ADR-019.
- **Prices pipeline**: [store.ts](../../src/lib/prices/store.ts) (`upsertPrice`, `distinctHeldSymbols` already excludes `SEC:%` synthetics, `latestCloseOnOrBefore`), [router.ts](../../src/lib/prices/router.ts), [yahoo-chart.ts](../../src/lib/prices/yahoo-chart.ts) (raw unauthenticated `/v8/finance/chart` fetch — the model for the enrichment fetcher), [fetch-prices-daily.ts](../../src/worker/jobs/fetch-prices-daily.ts). **Benchmark prices (`^GSPC`) ride this exact pipeline** — a benchmark is just another symbol in `prices`.
- **Existing investment math (Phase 5, all pure + tested)**: [gain-loss.ts](../../src/lib/investments/gain-loss.ts) (`gainLoss`, `portfolioGainLoss`), [lots.ts](../../src/lib/investments/lots.ts) (`resolveCostBasis`, `aggregateLots`, `lotCoverage`, cost-basis precedence), [allocation.ts](../../src/lib/investments/allocation.ts) (`allocationByAssetClass`, `allocationByAccount` — **Phase 9 adds `allocationBySector`/`byRegion` on the same shape**), [income.ts](../../src/lib/investments/income.ts) (`incomeByPeriod` over dividend/interest — **Phase 9 extends with growth + forward projection**), [format.ts](../../src/lib/investments/format.ts).
- **Investment queries**: [src/lib/investments/queries.ts](../../src/lib/investments/queries.ts) — `listInvestmentPositions`, `listBalanceOnlyInvestmentAccounts`, `listInvestmentLots`, `listInvestmentIncome`. Phase 9 adds history/series/per-security queries beside them.
- **Dashboard**: [src/app/investments/page.tsx](../../src/app/investments/page.tsx) (server component; positions grouped by account, portfolio totals, allocation, income-by-period toggle), [allocation-chart.tsx](../../src/app/investments/allocation-chart.tsx), [income-chart.tsx](../../src/app/investments/income-chart.tsx), [refresh-prices-button.tsx](../../src/app/investments/refresh-prices-button.tsx). Phase 9 **adds tabs/sub-routes** (`/investments/performance`, `/investments/security/[id]`, `/investments/forecast`) rather than overloading the one page.
- **Chart island pattern (ADR-005/013)**: [net-worth-chart.tsx](../../src/app/net-worth-chart.tsx) + the Phase 5/8 charts — `"use client"`, `ResponsiveContainer`, `Intl.NumberFormat`, `Number(value)` only at the display edge, dark-mode `currentColor`. **Every Phase 9 chart copies this.**
- **Analytics precedent (Phase 8)**: [src/lib/analytics/](../../src/lib/analytics/) (spend aggregation returning strings/`Money`, `date_trunc` bucketing, trailing-average `forecast.ts`) — the **structural template** for `src/lib/investments/` history/performance/forecast modules.
- **Worker / cron infra**: [src/lib/queue/queues.ts](../../src/lib/queue/queues.ts), [src/worker/index.ts](../../src/worker/index.ts), repeatable-job registration, [run-once.ts](../../src/worker/run-once.ts) (the one-shot pattern the history backfill reuses).

---

## ADRs locked at plan time

Four decisions surface in Phase 9. All are 🔲 **Proposed** — append to [IDEAS.md](IDEAS.md) §11 Decision Log (next free numbers ADR-019 → ADR-022; verified ADR-018 is current max) after this plan is approved (P9-00).

---

### ADR-019 — Per-holding historical snapshots (`holding_snapshots`) as the analytics foundation

**Status**: 🔲 Proposed

**Context**: To slice investment value *over time* by asset class, account, or individual security — the core of Round 3's "historical … per category, per account" ask — we need a daily value per position. Today only account-level [account_snapshots](../../src/db/schema/snapshots.ts) exist; they can't break an account's value into its holdings, and they can't power per-security history or attribution. The net-worth chart shows the *total* line and nothing beneath it.

**Decision**:
1. **New `holding_snapshots` table**, PK `(holding_id, date)` — mirrors `account_snapshots` one level down. Columns: `quantity numeric(28,8)`, `value numeric(18,2)` (in the account's currency), `cost_basis numeric(18,2)` nullable (resolved basis on that date), `currency text`. One row per position per day.
2. **Written by the existing nightly pass, not a new fetch.** Extend [compute-snapshots-daily.ts](../../src/worker/jobs/compute-snapshots-daily.ts): it *already* values every holding to compute the account snapshot, so it emits the per-holding rows in the same loop — zero extra price reads. `ON CONFLICT (holding_id, date) DO UPDATE` keeps it idempotent (CLAUDE.md §Background Jobs). This is the *same logical unit of work* (value-as-of-date) at finer grain, so it stays one job rather than a sibling.
3. **Best-effort historical backfill** via `run-once` (P9-03): for each holding, write `value = current_quantity × latestCloseOnOrBefore(symbol, date)` for each date the `prices` table covers. This is an **approximation** — past *quantity* isn't reconstructed (Plaid gives current holdings, not historical positions) — and is documented as such. Going forward, the nightly job records the *actual* quantity each day, so accuracy improves from deploy date onward. (A more exact transaction-replay backfill is logged as an Open Item, not built — YAGNI for one user with limited history.)
4. **Currency** stored per row so multi-currency accounts aggregate through `fx_rates` at the snapshot's date, consistent with net-worth aggregation.

**Consequences**:
- ✅ Per-asset-class, per-account, and per-security value-over-time become trivial SQL group-bys — no transaction replay at render time.
- ✅ Reuses the existing valuation primitive and nightly job; the only new runtime is `ON CONFLICT` inserts already in the loop.
- ✅ TWR/XIRR (ADR-021) get daily portfolio values for sub-period chaining for free.
- ⚠️ Backfill is approximate for pre-deploy dates (current qty × historical price). Surfaced in the UI as "history before {deploy date} estimates today's holdings against past prices." Honest, like the Phase 5 lot-coverage note.
- ⚠️ Storage grows ~`(#holdings × #days)` rows. For one user with tens of holdings over years this is trivial (low thousands/year); indexed by `(holding_id, date)` PK + a `(date)` index for cross-holding day slices.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Reconstruct positions from `investment_transactions` at render | Complex, slow over long ranges, and blind to manual holdings (iTrust gold, 401k) that have no transaction history. |
| Account-level snapshots only | Can't slice by asset class or security — misses the core Round 3 ask. |
| Snapshot value as `jsonb` blob on `account_snapshots` | Can't `GROUP BY` or join to `securities`; loses per-holding indexing. |

---

### ADR-020 — Security enrichment (`securities` columns) from public market data

**Status**: 🔲 Proposed

**Context**: Round 3: "Can we bring in any info on the invested assets?" To slice allocation by **sector / industry / region / asset type** and to project **forward dividend income**, securities need metadata they don't carry today. We already fetch *prices* for held tickers from Yahoo's public endpoints; the question is enrichment, not a new trust boundary.

**Decision**:
1. **Extend `securities`** with nullable enrichment columns (additive, manual rows unaffected): `sector text`, `industry text`, `asset_type text` (equity/etf/mutual_fund/bond/crypto/cash/other — normalized from the provider), `region text` (country/region), `expense_ratio numeric(8,4)` (funds), `dividend_rate numeric(18,8)` (**forward annual $/share**), `dividend_ex_date date`, and `fundamentals_refreshed_at timestamptz` (watermark). **Yield is NOT stored** — it's derived at display as `dividend_rate ÷ current_price` (CLAUDE.md §Money: no stale, lossy stored yield).
2. **New enrichment fetcher** [src/lib/prices/yahoo-fundamentals.ts](../../src/lib/prices/yahoo-fundamentals.ts), same raw-fetch posture as [yahoo-chart.ts](../../src/lib/prices/yahoo-chart.ts) (unauthenticated endpoint, Zod-validated narrow slice, retry/backoff). Pulls `assetProfile` (sector/industry/country) + `summaryDetail`/`defaultKeyStatistics` (forward dividend rate, ex-date, expense ratio). **Sends only the ticker symbol** — no holdings, quantities, or balances. Synthetic `SEC:%` symbols and crypto/metals are skipped (no public fundamentals); their `asset_type` is set from the existing `asset_class`.
3. **New weekly repeatable job** `refresh-fundamentals-weekly` (BullMQ) — fundamentals (sector/industry/dividend rate) change slowly, so weekly, not daily. Refreshes securities whose `fundamentals_refreshed_at` is null or stale (> 7 days). One job, idempotent, rate-limit-aware (reuses `withRateLimitRetry`).
4. **Privacy is unchanged** (CLAUDE.md §Privacy): outbound traffic is ticker symbols to a public market-data endpoint — the same data category Phase 2/5 already send. No new user-data egress. Stated in P9-00 and the Batch 6 privacy pass.

**Consequences**:
- ✅ Allocation by sector/industry/region/asset-type, plus forward-income projection, all become local SQL over enriched columns.
- ✅ No new dependency — reuses the raw-fetch + Zod + retry pattern already vetted for prices.
- ⚠️ Coverage is patchy (proprietary/401k funds, foreign tickers, anything `SEC:`-synthetic). Unknown fields stay null and render as an "Unclassified" allocation bucket — never a crash, never a guess.
- ⚠️ Enrichment data quality is provider-dependent; `raw` is retained for re-derivation, and `fundamentals_refreshed_at` makes staleness visible.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Separate 1:1 `security_fundamentals` table | Over-normalized for one-to-one optional columns; `securities` is already joined everywhere — extra join for no benefit. |
| Store computed `dividend_yield` | Goes stale the moment price moves; violates §Money (derive at display from rate ÷ price). |
| A paid fundamentals API (e.g. AV fundamentals) | Cost + another integration; Yahoo's public profile/summary covers sector/industry/dividend at $0, consistent with the existing price source. |
| Refresh fundamentals daily | Sector/industry are near-static; weekly halves the egress for no information loss. |

---

### ADR-021 — Performance methodology: TWR, XIRR, contributions-vs-growth, benchmark — all display figures

**Status**: 🔲 Proposed

**Context**: Round 3 wants performance, "historical as well as future." A real investor view answers "how much did my portfolio actually return, and was it me adding money or the market growing?" — and "how did I do vs. the market?" These are computable from data we already have (`holding_snapshots` for daily values, `investment_transactions` for dated cash flows, `prices` for a benchmark) **without** crossing the tax-engine boundary.

**Decision** — four pure, `Decimal`-based, unit-tested functions in `src/lib/investments/performance.ts`:
1. **Value & gain/loss over time** — `valueSeries(snapshots, bucket)` and `unrealizedSeries` (value − resolved cost basis) at portfolio, asset-class, and security grain. Straight from `holding_snapshots`.
2. **Contributions vs. market growth** — `attribution(snapshots, flows, range)`: `marketGrowth = (endValue − startValue) − netExternalFlows`, where `netExternalFlows` = signed sum of buys/deposits − sells/withdrawals from `investment_transactions`. Answers "did it grow or did I just add money?"
3. **Money-weighted return (XIRR)** — `xirr(datedFlows, endValue)` via Newton–Raphson on `Decimal` (bisection fallback for non-convergence), over the dated external cash flows + ending value. The personal rate of return.
4. **Time-weighted return (TWR)** — `twr(dailyValues, flowsByDate)`: chain daily sub-period returns, neutralizing the timing/size of external flows. The "how did the *investments* do" rate, comparable to a fund's published return — and the apples-to-apples basis for the benchmark.
5. **Benchmark** — store `^GSPC` (S&P 500) daily closes in `prices` via the existing fetcher; `benchmarkTwr(range)` runs the same TWR on a hypothetical buy-and-hold of the index. Overlaid on the portfolio TWR line. The benchmark symbol is a code constant (no new table).

**All five are read-only display figures.** No tax-lot selection, no realized/unrealized *tax* reporting, no wash sales, no 1099 — reaffirms the PLAN5/CLAUDE.md boundary. Returns are labeled performance metrics, not advice.

**Consequences**:
- ✅ The "real investor" metrics, entirely from local data + one benchmark symbol fetch.
- ✅ `holding_snapshots` (ADR-019) makes TWR sub-period chaining tractable; without daily values TWR would be guesswork.
- ⚠️ XIRR/TWR are edge-case-heavy (zero/negative periods, flows on boundary days, sub-1-month history). High TDD payoff — these are exactly CLAUDE.md "always-test" pure functions (P9-13).
- ⚠️ Pre-deploy history rests on the approximate backfill (ADR-019); early returns carry the same "estimated history" caveat. Don't present a return number for a range with no real snapshot data — show "insufficient history."

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Simple gain/loss % only (Phase 5) | Already shipped; Round 3 explicitly asks for more ("historical as well as future," performance over time). |
| TWR only (skip XIRR) | TWR hides the *personal* return when contributions are lumpy; XIRR answers "what did I personally earn." Both are cheap given the data. |
| Pull returns from Plaid/provider | Plaid doesn't compute portfolio TWR/XIRR; deriving locally is the only first-party option and keeps the math auditable. |
| Benchmark as a new `benchmarks` table | One symbol in `prices` + a constant suffices; a table is premature for a single index. |

---

### ADR-022 — Forward-looking views: forward income, income growth, labeled value projection; goal/retirement scoped-but-deferred

**Status**: 🔲 Proposed

**Context**: Round 3: "Future." Phase 8 used a trailing-average *spend* forecast. Investments differ — the strongest forward signal is **dividend income** (forward rate × held shares is concrete), not a speculative price forecast.

**Decision**:
1. **Projected forward income** (`forwardIncome(holdings, securities)`): sum of `held_shares × dividend_rate` (ADR-020) → forward 12-month dividend/interest estimate, with per-holding and per-account breakdown and a **yield-on-cost** figure (forward income ÷ cost basis). Grounded in held quantity × published forward rate.
2. **Income growth trend** (`incomeGrowth`): extend Phase 5's `incomeByPeriod` into a YoY-growth + run-rate series (actual dividend/interest received, trailing — not a projection). A real "is my income growing?" line.
3. **Value projection** (`projectValue(currentValue, annualRatePct, years)`): deterministic compound projection at user-chosen assumptions (e.g. 5/7/10%), rendered as a dashed forward segment. **Explicitly labeled an estimate, never advice** (CLAUDE.md §Domain Scope) — a single banner: "Projections are illustrative, not financial advice."
4. **Goal / retirement marker — scoped, lightweight, possibly deferred.** Build only a *single-target* marker: given a target number and the value projection (#3), show the projected date the portfolio reaches it. **No** Monte Carlo, no withdrawal modeling, no multi-goal planner — those are a future phase. If even the single-target marker proves to want more than a thin UI over `projectValue`, it ships as its own PLAN; this plan caps it at the marker (P9-21) and logs the rest as an Open Item.

**Consequences**:
- ✅ Forward income is data-grounded (held shares × forward rate), not a guess.
- ✅ Value projection and the goal marker are thin, deterministic functions over one assumption input — clearly fenced as illustrative.
- ⚠️ Value projection is inherently speculative; the labeling guardrail is a *requirement*, enforced in the UI task (P9-20) and the docs (P9-23), not optional polish.
- ⚠️ "Goal/retirement" can balloon; the decision **caps** it at a marker and pre-commits to deferring anything larger — avoids scope creep mid-phase.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Monte Carlo / probabilistic retirement planning | Far larger than the ask; a planning app inside a tracker. Deferred to its own phase if ever. |
| Forecast future *price* per security | Speculative and low-value; we don't predict markets. Value projection uses a flat user assumption, clearly labeled. |
| Skip value projection entirely | The owner explicitly selected it; ship it *with* the estimate-not-advice guardrail rather than omit it. |

---

## Phase 9 — Schema (one new table + additive `securities` columns)

All follow CLAUDE.md §Database & Drizzle Specifics: UUID/composite PKs, `numeric` for money/quantity (never float), `timestamp({ withTimezone: true })`, one file per concept under [src/db/schema/](../../src/db/schema/), re-exported from [index.ts](../../src/db/schema/index.ts). **No column is dropped; no destructive change.**

```text
src/db/schema/
├── holding-snapshots.ts        (NEW)
├── securities.ts               (UPDATED: sector, industry, asset_type, region, expense_ratio,
│                                          dividend_rate, dividend_ex_date, fundamentals_refreshed_at)
└── index.ts                    (UPDATED: re-export holding-snapshots)
```

### `holding_snapshots` (NEW — per-position daily history)

| Column | Type | Notes |
|---|---|---|
| `holding_id` | `uuid` FK → holdings `onDelete: cascade` NOT NULL | Part of PK. Snapshots die with the position. |
| `date` | `date` (`mode: 'string'`) NOT NULL | Part of PK. |
| `quantity` | `numeric(28,8)` NOT NULL | Position size on that date (actual going forward; current-qty approximation in backfill). |
| `value` | `numeric(18,2)` NOT NULL | `quantity × close` in the account currency. |
| `cost_basis` | `numeric(18,2)` | Resolved basis on that date (lots-aware, P5-07). Nullable when unknown. |
| `currency` | `text` NOT NULL DEFAULT `'USD'` | Account currency for FX-correct aggregation. |

**PK**: `(holding_id, date)`. **Index**: `holding_snapshots_date_idx ON (date)` — for cross-holding "all positions on day D" slices (sector/asset-class series). FK is covered by the PK's leading column.

### `securities` extensions (UPDATED — all nullable, additive)

| Column | Type | Notes |
|---|---|---|
| `sector` | `text` | From Yahoo `assetProfile.sector`. |
| `industry` | `text` | From `assetProfile.industry`. |
| `asset_type` | `text` | Normalized: `equity`/`etf`/`mutual_fund`/`bond`/`crypto`/`cash`/`other`. CHECK constraint. |
| `region` | `text` | Country/region from `assetProfile.country`. |
| `expense_ratio` | `numeric(8,4)` | Funds only. |
| `dividend_rate` | `numeric(18,8)` | **Forward annual $/share.** Yield derived at display = rate ÷ price. |
| `dividend_ex_date` | `date` (`mode: 'string'`) | Next/last ex-dividend date. |
| `fundamentals_refreshed_at` | `timestamptz` | Staleness watermark; the weekly job refreshes when null or > 7 days. |

### No new enums

Same posture as Phase 5/8: `asset_type` is `text` + CHECK, not `pgEnum` (we expect to add provider types over time; dropping a CHECK is lighter than an enum-add migration). `asset_class`/`quantity_unit`/`account_type` remain `pgEnum`.

### Migration order (one Drizzle migration, `drizzle-kit generate` → `migrate`)

1. `CREATE TABLE holding_snapshots` (FK → holdings, which exists) + the `(date)` index.
2. `ALTER TABLE securities ADD COLUMN …` ×8 (all nullable/defaulted) + the `asset_type` CHECK.

The **history backfill** (P9-03) and **first fundamentals fill** (P9-06) are idempotent runtime steps via `run-once`/the weekly job — **not** raw SQL in the migration — so they're testable and re-runnable. Take a `pg_dump` (existing backup job, [docs/BACKUP.md](../../docs/BACKUP.md)) before the first real backfill.

---

## Task breakdown

> Batches are dependency-ordered: **0 → 1 → {2,3} → 4 → 5 → 6**. Batch 1 (history foundation) gates the performance/series work (Batch 3) and slicing (Batch 4); Batch 2 (enrichment) gates sector slicing + forward income but runs parallel to Batch 3. Task IDs follow `P9-xx`. Invoke the cited skill at the start of each batch (§Skills Map). Always-test surfaces (snapshot math, return math, income projection) get Vitest without asking (CLAUDE.md §Testing Philosophy).

### Batch 0 — Scope gate + ADRs (docs only, no code)

**P9-00 — Record scope + privacy notes; append ADRs.**
- Append **ADR-019 → ADR-022** to [IDEAS.md](IDEAS.md) §11 Decision Log (verified next free numbers after ADR-018).
- Add a short [FEATURE.md](FEATURE.md) §investments note: Phase 9 adds investment *history, performance display, asset metadata, and forward income/projection* — **reaffirming** that tax-lot/cap-gains/1099 and financial *advice* stay out of scope; the value projection is a labeled estimate. Record the enrichment privacy stance (only ticker symbols egress, same boundary as the price fetch).
- *Skill: `architecture-decision-records`.* No deploy.

### Batch 1 — Historical foundation (`holding_snapshots`)

*Skills: `drizzle-orm-expert`, `postgres-best-practices`, `bullmq-specialist`, `database-migration` (backfill), `typescript-pro`.*

**P9-01 — `holding_snapshots` schema.** ✅ **Done.** Created [src/db/schema/holding-snapshots.ts](../../src/db/schema/holding-snapshots.ts) per spec (composite PK `(holding_id, date)`, FK `onDelete: cascade`, `holding_snapshots_date_idx`), `HoldingSnapshot`/`NewHoldingSnapshot` exports, re-exported from [index.ts](../../src/db/schema/index.ts) + reverse `snapshots` relation on [holdings.ts](../../src/db/schema/holdings.ts). Migration `drizzle/0013_huge_morg.sql` generated + applied (`pnpm db:migrate` green). → **Verify**: PK + date index present in the SQL; the P9-02/P9-03 tests insert/upsert rows (two dates for one holding succeed; the PK enforces one row per `(holding_id, date)`).

**P9-02 — Extend the nightly job to emit per-holding rows.** ✅ **Done.** Added `snapshotAccountHoldings()` to [compute-snapshots-daily.ts](../../src/worker/jobs/compute-snapshots-daily.ts) — replaces the `valueAccountHoldings` call in the investment/crypto_ira branch: values each holding (same cached prices, no extra reads), upserts a `holding_snapshots` row (`ON CONFLICT (holding_id, date) DO UPDATE`) with quantity / value / resolved cost basis (P5-07, cash & property basis-free) / currency, and returns the account total (account_snapshots path unchanged). **Honesty rule:** unpriced securities are skipped, not written at $0. → **Verify**: [compute-snapshots-daily.test.ts](../../src/worker/jobs/compute-snapshots-daily.test.ts) — priced position → correct `1500.00` snapshot + matching account snapshot + idempotent re-run; unpriced security → no row. Full suite **462 passed** (no regression).

**P9-03 — Best-effort history backfill (`run-once`).** ✅ **Done.** Created [src/lib/investments/backfill-history.ts](../../src/lib/investments/backfill-history.ts): `backfillHoldingSnapshots(windowMonths = 24)` — per holding, one snapshot per priced date in the window, `value = current_quantity × close`, resolved basis, currency; batch upsert using `excluded.*` (idempotent); symbols with no prices skipped. Wired into [run-once.ts](../../src/worker/run-once.ts) as `backfill-holding-snapshots`. Current-qty approximation documented in the module header. → **Verify**: [backfill-history.test.ts](../../src/lib/investments/backfill-history.test.ts) — 3 priced dates → 3 rows with `qty × close`, re-run keeps 3; no-price symbol → 0 rows, no crash.

**P9-04 — History query helpers.** ✅ **Done.** Added to [queries.ts](../../src/lib/investments/queries.ts): `listHoldingSnapshots(range)`, `portfolioValueSeries(range)`, `valueSeriesByAssetClass(range)`, `valueSeriesByAccount(range)` (+ `SnapshotRange`/`HoldingSnapshotRow`/`ValuePoint`/`DimensionValuePoint` types). Group-by-date sums in SQL via `numeric` (`sum(value)`), all results **strings**; shared `snapshotFilters()` builder (date range + account/holding filters; series restrict to investment account types). Single-currency aggregation (cross-currency FX deferred — §Open Items). → **Verify**: `tsc --noEmit` clean; consumed by Batch 3 series tests.

### Batch 2 — Asset intelligence (security enrichment)

*Skills: `zod-validation-expert` (Yahoo response boundary), `bullmq-specialist`, `drizzle-orm-expert`, `backend-security-coder` (outbound-egress review).*

**P9-05 — Extend `securities` schema.** ✅ **Done.** Added 8 nullable enrichment columns (`sector`, `industry`, `asset_type`, `region`, `expense_ratio`, `dividend_rate`, `dividend_ex_date`, `fundamentals_refreshed_at`) + `securities_asset_type_check` (NULL-tolerant) to [securities.ts](../../src/db/schema/securities.ts). Migration `drizzle/0014_fat_vertigo.sql` — `ADD COLUMN`-only + the CHECK; applied (`pnpm db:migrate` green). Manual securities unaffected.

**P9-06 — Yahoo fundamentals fetcher.** ✅ **Done.** Created [src/lib/prices/yahoo-fundamentals.ts](../../src/lib/prices/yahoo-fundamentals.ts): pure `parseFundamentals(json)` (Zod-validated narrow slice of `quoteSummary` modules `assetProfile,summaryDetail,quoteType`; `{raw}` unwrap; unix→ISO ex-date) + `normalizeAssetType` + `fetchFundamentals(symbol)` (raw unauthenticated fetch, `withRateLimitRetry`, **only the symbol egresses**, `SEC:` short-circuit, never throws → null on any failure). → **Verify**: [yahoo-fundamentals.test.ts](../../src/lib/prices/yahoo-fundamentals.test.ts) — 5 tests: full + sparse fixture parse, malformed/error/empty → null, asset-type map, SEC: short-circuits without a network call. *(Skill: `zod-validation-expert`.)*

**P9-07 — Enrichment store + weekly job.** ✅ **Done.** [src/lib/investments/fundamentals.ts](../../src/lib/investments/fundamentals.ts): `upsertFundamentals(securityId, data)` (writes columns + watermark, leaves `securities.raw` untouched) + `assetTypeFromPlaidType` fallback. [src/worker/jobs/refresh-fundamentals-weekly.ts](../../src/worker/jobs/refresh-fundamentals-weekly.ts): selects null/stale (>7d) securities, fetches, upserts; injectable `fetchFn` for tests. Queue `REFRESH_FUNDAMENTALS_WEEKLY` + worker + Sunday-06:00 scheduler ([queues.ts](../../src/lib/queue/queues.ts), [index.ts](../../src/worker/index.ts)); manual trigger via [run-once.ts](../../src/worker/run-once.ts). → **Verify**: [refresh-fundamentals-weekly.test.ts](../../src/worker/jobs/refresh-fundamentals-weekly.test.ts) — enriches stale, skips fresh, SEC: falls back to Plaid-type asset_type, stamps watermark, second run is a no-op. *(Skills: `bullmq-specialist`, `drizzle-orm-expert`.)*

**P9-08 — Outbound-egress privacy assertion.** ✅ **Done.** Added [src/lib/investments/fundamentals-egress.test.ts](../../src/lib/investments/fundamentals-egress.test.ts) (sibling to the Plaid hardening audit): the fetcher source (comments stripped) references **no** holdings/account/quantity/balance/cost-basis identifier, imports no `@/db/*`, and builds the request URL from `encodeURIComponent(symbol)` alone. → **Verify**: 3 assertions green. *(Skill: `backend-security-coder`.)*

### Batch 3 — Performance layer (math + dashboard)

*Skills: `test-driven-development`, `typescript-pro`; charts per ADR-005/013; `postgres-best-practices` for series queries.*

**P9-09 — Value & gain/loss series.** ✅ **Done.** Created [src/lib/investments/performance.ts](../../src/lib/investments/performance.ts): `valueSeries(snapshots)` (sum value per date) + `gainLossSeries(snapshots)` (the "unrealized" series — value, known cost basis, and gain over the *basis-known subset*, mirroring `portfolioGainLoss` so cash/manual positions don't distort the line). `ValuedSnapshot` is a structural subset of `HoldingSnapshotRow`, so query rows pass straight through. `Money`/string output; empty → `[]` (never NaN). → **Verify**: [performance.test.ts](../../src/lib/investments/performance.test.ts) — buckets per date, gain tracks value−basis, null basis/gain when none known, empty → `[]`.

**P9-10 — Contributions vs. market growth.** ✅ **Done.** `externalFlow(txn)` classifies a transaction as a portfolio-boundary flow (buy/deposit = in, sell/withdrawal = out; dividend/interest/fee/transfer → null, internal); direction comes from `type`/`subtype`, magnitude from `|amount|` (robust to Plaid's per-type sign). `attribution(startValue, endValue, flows)` → `{startValue, endValue, netFlows, marketGrowth}` where `marketGrowth = (end − start) − netFlows`. `Decimal`/`Money`. Flow rows come from new `listInvestmentFlows(range)` in [queries.ts](../../src/lib/investments/queries.ts). → **Verify**: flat market + deposit ⇒ growth 0; appreciation, no flows ⇒ growth = Δ; mixed penny-exact; classifier in/out/null cases.

**P9-11 — XIRR (money-weighted return).** ✅ **Done.** `xirr(datedFlows)` core solver (investor convention, NPV `Σ amount/(1+r)^years = 0`): Newton–Raphson on `Decimal` with a bracketed-bisection fallback; returns annualized 2dp % string or null when undefined (single flow / no sign change / all flows same day). `moneyWeightedReturn({startValue,startDate,endValue,endDate,flows})` wraps it (start value = initial purchase, end value = liquidation). → **Verify**: textbook 10%, multi-flow root of x²+x−2.2 ⇒ 6.52%, loss case −20%, undefined → null; wrapper neutralizes mid-period contribution; empty portfolio → null. No native float.

**P9-12 — TWR + benchmark.** ✅ **Done.** `twr(dailyValues, flows)` chains per-day sub-returns `V_t/(V_{t−1}+F_t)−1` (flows at start-of-day, so a pure contribution day yields 0%); collapses to the simple return with no flows; `< 2` valued days → null. `benchmarkTwr(closes)` runs the same engine on index closes; `twrIndexSeries(...)` emits the "growth of 100" line for the overlay. `BENCHMARK_SYMBOL = "^GSPC"` constant; taught [fetch-prices-daily.ts](../../src/worker/jobs/fetch-prices-daily.ts) to always fetch it (equity-class, same Yahoo pipeline — just another `prices` row); `benchmarkCloseSeries()` query added. → **Verify**: TWR = simple return with no flows; mid-period flow doesn't distort; index series neutralizes flows; insufficient history → null; fetch-prices tests updated for the always-on benchmark.

**P9-13 — Performance math test sweep.** ✅ **Done.** [performance.test.ts](../../src/lib/investments/performance.test.ts) — **25 tests** across P9-09→P9-12 (value/gain-loss series, flow classification, attribution, XIRR + wrapper, TWR + index + benchmark, edge cases: single flow, no sign change, same-day, insufficient history, empty input). Full suite **496 passed** (was 471). → **Verify**: `pnpm test` green; no native float anywhere (all `Decimal`/`Money`).

**P9-14 — `/investments/performance` page + chart islands.** ✅ **Done.** New server route [src/app/investments/performance/page.tsx](../../src/app/investments/performance/page.tsx): reuses the Phase 8 `resolveRange` + `AnalysisControls` (range + investment-account URL params); summary tiles (TWR, XIRR, gain/loss, vs-S&P delta, all "—" on insufficient history); islands [value-over-time-chart.tsx](../../src/app/investments/performance/value-over-time-chart.tsx) (value area + dashed cost-basis line ⇒ gap = unrealized gain), [return-vs-benchmark-chart.tsx](../../src/app/investments/performance/return-vs-benchmark-chart.tsx) (two growth-of-100 lines, merged by date), [attribution-chart.tsx](../../src/app/investments/performance/attribution-chart.tsx) (contributions vs market-growth bars, signed colors). Each `"use client"` + `ResponsiveContainer` + `Intl.NumberFormat`. Unconditional estimate/advice caveat in the footer; insufficient-history empty states; "Performance →" link from the overview page. → **Verify**: `tsc` clean, biome clean on changed files; insufficient-history renders cleanly. (Live operator render pending deploy.)

### Batch 4 — Slicing + per-security drill-down

*Skills: `nextjs-app-router-patterns`, `tailwind-patterns`, `postgres-best-practices`.*

**P9-15 — Sector/region/asset-type allocation.** Extend [allocation.ts](../../src/lib/investments/allocation.ts) with `allocationBySector`, `allocationByRegion`, `allocationByAssetType` (same `ValuedHolding`+percent-balancing shape; null metadata → "Unclassified" bucket). Plus `concentration(positions)` — top-N holdings as % of portfolio. → **Verify**: Vitest — grouping, Unclassified bucket for null sector, percents sum to 100.00, concentration ordering.

**P9-16 — Allocation slice UI.** On `/investments`, a slice-dimension toggle (asset class / sector / region / account) over the existing donut (reuse `allocation-chart.tsx`), driven by a URL param; a concentration table (top holdings). → **Verify**: `pnpm check`; toggling re-renders the donut server-side; operator-verified.

**P9-17 — Per-security detail page.** New `src/app/investments/security/[id]/page.tsx`: for a holding/security — header (name, sector/industry/region, asset type, forward yield), price-history sparkline (from `prices`, resolves the Phase 5 Open Item), value/cost-basis history (from `holding_snapshots`), lots table (P5-18), dividends received (income txns for the security), and per-security gain/loss + return. Queries in [queries.ts](../../src/lib/investments/queries.ts) (`securityDetail`, `securityPriceHistory`, `securityIncome`). → **Verify**: `pnpm check`; renders for a tickered holding (full data) and a manual/`SEC:` holding (graceful nulls); operator-verified.

**P9-18 — Drill-down wiring.** Position rows on `/investments` link to `/investments/security/[id]`; allocation slices and concentration rows link to filtered views. → **Verify**: `pnpm check`; links resolve; no regression in the positions table.

### Batch 5 — Forward-looking views

*Skills: `test-driven-development`, `typescript-pro`, `nextjs-app-router-patterns`, `tailwind-patterns`.*

**P9-19 — Forward income + income growth math.** In [income.ts](../../src/lib/investments/income.ts) (or `forward-income.ts`): `forwardIncome(holdings, securities)` = Σ `shares × dividend_rate`, per-holding/account breakdown + yield-on-cost (forward income ÷ cost basis); `incomeGrowth(txns, period)` = YoY growth + run-rate over actual received income. `Money`/`Decimal`. → **Verify**: Vitest — forward income sums correctly, null `dividend_rate` contributes 0 (not NaN), yield-on-cost null when basis unknown; YoY growth sign + run-rate; empty → zeros.

**P9-20 — Value projection + goal marker math.** `projectValue(currentValue, annualRatePct, years)` deterministic compound series; `goalDate(currentValue, monthlyContribution, ratePct, target)` → projected date target is reached (or null if never under the assumption). Pure, `Decimal`. → **Verify**: Vitest — known compound results, zero rate ⇒ linear from contributions, target already met ⇒ today, unreachable ⇒ null.

**P9-21 — `/investments/forecast` page.** New server route: projected forward 12-month income (breakdown + yield-on-cost), income-growth trend chart (extend `income-chart.tsx`), a value-projection chart with an assumption control (5/7/10% via URL param) rendering the future segment **dashed**, and a single-target goal marker. **Mandatory banner**: "Projections are illustrative estimates, not financial advice" (ADR-022). → **Verify**: `pnpm check`; the estimate banner is present and unconditional; operator-verified; dashed projection visually distinct from actuals.

### Batch 6 — Nav, tests, docs, security/privacy pass

*Skills: `e2e-testing-patterns`, `code-reviewer`, `threat-modeling-expert`/`007` (light), `backend-security-coder`.*

**P9-22 — Navigation + tabs.** Add sub-tabs to the investments surface (Overview / Performance / Forecast) and link the per-security pages; ensure [nav-menu.tsx](../../src/components/nav-menu.tsx) still points at `/investments`. → **Verify**: `pnpm check`; all routes reachable + `requireUser`-gated.

**P9-23 — Docs.** Extend [docs/INVESTMENTS.md](../../docs/INVESTMENTS.md): the history foundation (+ the estimated-pre-deploy-history caveat), enrichment + weekly refresh, how to read performance (TWR vs XIRR vs gain/loss, contributions-vs-growth, benchmark), the forward views, and a restated **"performance figures and projections are display/illustrative, not tax or investment advice; no 1099/cap-gains"** boundary up top. Note the enrichment privacy stance (only tickers egress). README §Usage pointer. → **Verify**: doc walks history → enrichment → performance → forecast; boundary + privacy stated.

**P9-24 — Privacy/security pass.** Extend [docs/THREAT_MODEL_PLAID.md](../../docs/THREAT_MODEL_PLAID.md) (or a new `docs/THREAT_MODEL_MARKETDATA.md`) with the enrichment egress surface (only-ticker assertion from P9-08, STRIDE rows: data-exfil via outbound fetch, response-injection via Zod boundary, rate-limit/DoS, stale-fundamentals integrity). Confirm fundamentals/benchmark endpoints are called only from worker/server code. → **Verify**: grep shows no client-side fundamentals calls; P9-08 assertion green; `pnpm check` clean. *Skills: `threat-modeling-expert`, `backend-security-coder`.*

**P9-25 — E2E (manual path, ungated).** Extend the Playwright suite: bootstrap → investment account → AAPL holding → seed several days of `prices` + a `dividend_rate` via SQL → run the snapshot job (or seed `holding_snapshots`) → `/investments/performance` shows a value series and a gain/loss figure; `/investments/forecast` shows a forward-income number and the estimate banner; `/investments/security/[id]` renders the price-history sparkline. Mirror the Phase 5 manual-path seeding idiom. → **Verify**: `pnpm exec playwright test` green (new specs pass; any Sandbox-gated specs stay skipped). *Skill: `e2e-testing-patterns`.*

---

## Testing (per CLAUDE.md §Testing Philosophy)

**Always-test surfaces this phase adds** (Vitest; test Postgres where DB is involved):
- **Snapshot emission + history backfill idempotency / no-data-loss** (P9-02/03) — historical data is the product.
- **Performance math** — value/gain-loss series, contributions-vs-growth attribution, **XIRR**, **TWR + benchmark** (P9-09→P9-13). Edge-case-heavy pure functions = highest TDD payoff.
- **Fundamentals parsing** at the Yahoo boundary (P9-06) + **enrichment job** staleness logic (P9-07).
- **Forward income + projection + goal** math (P9-19/20).
- **Outbound-egress assertion** (P9-08) — only tickers leave the host.

**Sparingly tested** (per the rules — cover the math/actions, not the buttons): the performance/forecast/detail pages, allocation toggle, and chart islands.

**Playwright**: extend the existing critical-flow suite with the ungated manual path only (P9-25). Don't add a flaky flow just to have one.

---

## Migration & data safety

- **One Drizzle migration** for all Batch-1/2 schema (1 table + 8 `securities` columns + indexes/CHECK). `generate` → `migrate`.
- The **history backfill** (P9-03) and **fundamentals fill** (P9-06/07) are idempotent runtime steps (`run-once` / weekly job), **not** raw SQL in the migration — testable and re-runnable.
- **No column dropped.** Phase 9 is purely additive; nothing in Phase 5's schema changes shape.
- Take a `pg_dump` (existing backup job, [docs/BACKUP.md](../../docs/BACKUP.md)) **before** the first real history backfill.

---

## Sequencing & shipping

1. **P9-00** (docs/ADR) — no deploy.
2. **Batch 1** — migrate; deploy app+worker; the nightly job starts emitting `holding_snapshots`; run `backfillHoldingSnapshots` once via `run-once`; verify counts. Gates Batches 3/4.
3. **Batch 2** — enrichment; deploy worker (new weekly job) + app; let `refresh-fundamentals-weekly` populate metadata (or trigger once). Runs parallel to Batch 3.
4. **Batch 3** (performance) + **Batch 4** (slicing/drill-down) — independent once Batch 1 (and Batch 2 for sector slicing) land; can share an image push.
5. **Batch 5** (forecast) — depends on Batch 2 (`dividend_rate`); smallest UI batch.
6. **Batch 6** — nav/docs/tests/security; bundle with the last app push.
- Each batch: `make image-push PLATFORMS=linux/amd64` then `docker compose … up -d --force-recreate app` (+ `worker` when worker-shared code changed).

---

## Skills Map (per task cluster)

Per [SKILLS.md](SKILLS.md) §Suggested Workflow (Phase 5 investments + Phase 8 analytics maps apply). Invoke when the cluster opens, not upfront.

| Task cluster | Primary skill(s) |
|---|---|
| P9-00 (scope gate + ADRs) | `architecture-decision-records` |
| P9-01 → P9-04 (history schema + nightly job + backfill + queries) | `drizzle-orm-expert`, `postgres-best-practices`, `bullmq-specialist`, `database-migration` |
| P9-05 → P9-08 (security enrichment + fetcher + weekly job + egress audit) | `zod-validation-expert`, `bullmq-specialist`, `backend-security-coder` |
| P9-09 → P9-13 (performance math — TWR/XIRR/attribution/series) | `test-driven-development`, `typescript-pro` |
| P9-14 (performance page + charts) | `nextjs-app-router-patterns`, `tailwind-patterns` |
| P9-15 → P9-18 (slicing + per-security drill-down) | `nextjs-app-router-patterns`, `tailwind-patterns`, `postgres-best-practices` |
| P9-19 → P9-21 (forward income / projection / goal) | `test-driven-development`, `typescript-pro`, `nextjs-app-router-patterns` |
| P9-22 → P9-25 (nav, docs, privacy pass, E2E) | `e2e-testing-patterns`, `threat-modeling-expert`, `backend-security-coder`, `code-reviewer` |

---

## Open Items (out of scope for this plan, captured for future PLAN docs)

- **Exact transaction-replay history backfill** — reconstruct *past quantities* (not just current-qty × past price) from `investment_transactions`. More accurate pre-deploy history; deferred (YAGNI for one user with limited history; nightly job gives exact data going forward).
- **Goal/retirement planning beyond a single-target marker** (ADR-022) — Monte Carlo, withdrawal/drawdown modeling, multi-goal planner. Its own phase if ever asked; capped at a marker here.
- **Realized gain/loss & tax lots** — FIFO/LIFO/specific-ID, wash sales, cap-gains/1099. **Explicitly out** per CLAUDE.md §Domain Scope; needs a FEATURE.md decision update before any work. Reaffirmed, not relaxed, by Phase 9.
- **Cash-flow Sankey** (ADR-013, carried from Phase 5) — income→category→expense flow diagram; still deferred.
- **SnapTrade for Fidelity** (carried from Phase 5) — better lot-level basis if Plaid's proves too thin in production.
- **Additional benchmarks / custom blends** — only `^GSPC` this phase; a multi-benchmark or blended index is a later add (constant → small table when it earns it).
- **Dividend reinvestment (DRIP) lot modeling** (carried from Phase 5) — auto-create lots from reinvested dividends; YAGNI until the data shows it matters.
- **Multi-currency performance nuance** — TWR/XIRR across accounts in different base currencies uses `fx_rates` at snapshot date; a dedicated FX-attribution (currency vs. asset return split) is deferred.

---

*End of PLAN9.md*
