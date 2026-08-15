# Dashboard (Phase 13)

The landing page. One screen that answers *"where do I stand?"* without a click,
then hands you off to the page that owns each number. Locked by **ADR-029**
(curated fixed-section dashboard) in [IDEAS.md](../plans/features/IDEAS.md) §11;
task breakdown in [PLAN13.md](../plans/features/PLAN13.md).

> **Privacy & scope (binding — CLAUDE.md §Privacy, §Domain Scope).** The dashboard
> is a **read-only view with zero egress.** It fetches nothing from the network —
> no HTTP client, no price fetcher, no Plaid call, no analytics or telemetry SDK
> is reachable from any dashboard module. Every figure comes from local Postgres
> via functions that already existed. **Nothing on this page is logged**: every
> field it touches is financial data. The loader is `server-only`, so the composed
> figures cannot be bundled into the browser; the single client island
> ([`RangeToggle`](../src/components/dashboard/range-toggle.tsx)) receives only the
> active range string. A regression test
> ([src/lib/dashboard/privacy-egress.test.ts](../src/lib/dashboard/privacy-egress.test.ts))
> fails the build if any of that stops being true.

---

## The single source of truth

The dashboard **computes nothing**. `loadDashboard(range)`
([src/lib/dashboard/loader.ts](../src/lib/dashboard/loader.ts)) is the only place
it fetches data, and it composes the *same* library functions the dedicated pages
call. That is the whole design (ADR-029 §2 — **cards are dumb, the loader is
smart**): the dashboard's numbers are identical to `/investments`, `/analysis`,
and friends **by construction**, not by luck. There is no dashboard-specific SQL
and no dashboard-specific metric.

If a figure looks wrong here, it is wrong on its deep page too — fix it there.

### Card inventory

| Card | Shows | Fed by | Deep link |
|---|---|---|---|
| **Net worth** (hero) | Total, as-of date, signed change over the range, history chart | `computeNetWorth` + `netWorthSeries` + [`rangeDelta`](../src/lib/dashboard/delta.ts) | accounts table below |
| **Allocation** | Asset-class donut + total | `listValuedPositions` → `allocationByAssetClass` | `/investments` |
| **Performance** | Time-weighted return for the range, delta vs. `^GSPC`, value-over-time | `listHoldingSnapshots` / `listInvestmentFlows` / `benchmarkCloseSeries` → `valueSeries`, `twr`, `benchmarkTwr`, `gainLossSeries` | `/investments/performance` |
| **Spending** | This month's spend vs. budget, run-rate projection, top over-budget categories | `budgetVsActual` + `spendingSummary` | `/analysis` |
| **Forward income** | Estimated forward 12-month income, yield-on-cost, largest payers | `listValuedPositions` → `forwardIncome` | `/investments/forecast` |
| **Alerts** | Open-alert count + the three most recent titles | `listOpenAlerts` | `/alerts` |
| **Watchlist movers** | Top two and bottom two *paper* movers | `listWatchlist` (Phase 11 `paperValuation`) | `/watchlist` |
| **Savings rate** | Employee contributions ÷ projected annual gross, with the employer match beside it | `savingsRateInputs` → `savingsRate` (Phase 14, ADR-030/031) | `/settings/income` |

Three of those carry a label that is not decoration:

- **Performance** never invents a return. Fewer than two snapshot days in the
  range ⇒ "Insufficient history for this range." (**ADR-021**).
- **Forward income** is an *estimate* — today's holdings at today's distribution
  rate — and says so next to the number, not in a footnote (**ADR-022**).
- **Watchlist movers** are *pretend* positions and are labeled "not counted in
  net worth" (**ADR-025**). They are structurally outside net worth: a watchlist
  item is neither an account nor a holding.

The **savings rate** carries the same kind of label for the same kind of reason:
its denominator is *projected* (current gross × pay periods) while its numerator
is *measured* (contributions materialized in the window), so the card says
"estimate" and names the window it summed.

Alert titles are **content-free** (**ADR-015**) — the card shows the title and the
count, never a figure.

---

## The `?range=` contract

One control, one URL param, shared by everything time-based.

```
/?range=1M | 3M | 6M | 1Y | YTD | ALL
```

- **Default `1Y`.** A missing, empty, or unrecognized value falls back to it
  rather than erroring ([range.ts](../src/lib/dashboard/range.ts)).
- Parsing is case-insensitive and trims whitespace; `?range=all` works.
- State lives in the **URL**, not a store (ADR-003) — so the view is shareable,
  refresh-stable, and back-button-correct. The toggle writes only `range` and
  leaves every other param alone.
- The server parses it, so the highlighted segment is authoritative — no
  client/server disagreement after a back-navigation.

**What the range drives:** the hero's history chart and its change badge, and the
performance card (its TWR window and its benchmark window).

**What it deliberately does not drive:** spending is always the **current calendar
month** (a "3M budget" is not a thing); the savings rate always reads a **trailing
12 months**, because an annual ratio measured over one month is not a zoomed-in
number but a wrong one (see [INCOME.md](INCOME.md)); and allocation, forward
income, alerts, and movers are all **as-of-now** figures with no time window to
rewind.

---

## Degrading gracefully

The dashboard never errors because a feature is unused. Every card carries a
discriminated `status` from the loader — `ok` / `empty` / `insufficient` — so the
card renders its degraded state without re-deriving "is this empty?" (ADR-029 §5).

| Situation | What you see |
|---|---|
| **No accounts at all** (fresh install) | The whole grid collapses to one "Add your first account" panel ([first-run.tsx](../src/components/dashboard/first-run.tsx)) — not eight empty cards |
| No priced holdings | Allocation + performance show a calm dashed placeholder with an "Add an investment" nudge |
| Investments but < 2 snapshot days in range | Performance says "Insufficient history for this range." |
| Spend but no budgets | Spending shows the total plus a "Set budgets" nudge — *not* a meaningless 0%-of-0 bar |
| No spend and no budgets | Spending shows the calm empty state |
| No dividend payers | Forward income shows an empty state |
| No open alerts | Alerts shows the empty state — here that is good news |
| No priced paper positions | Movers shows an empty state |
| No income source defined | Savings rate says "Define your income…" — *not* 0%, which would claim you save nothing |

---

## Layout, loading, and what this page is not

**Fixed layout.** Hero (full width) → the shared history chart + range toggle →
the card grid → the accounts table, de-emphasized at the bottom. The grid is
1-up on mobile, 2-up at `sm`, 3-up at `lg`, with the two chart-bearing cards
taking a true half-width. The geometry lives in one place
([grid.ts](../src/components/dashboard/grid.ts)) so the page and its loading
skeleton cannot drift apart.

**Loading.** The page shell renders immediately and the data-dependent half
streams in behind a `<Suspense>` boundary showing a
[skeleton](../src/components/dashboard/skeleton.tsx) that matches the grid. This
is a page-scoped boundary **on purpose** rather than `src/app/loading.tsx`: a
root-segment `loading.tsx` is inherited by every nested route that lacks its own,
which would flash a dashboard skeleton on the way to `/accounts` and `/analysis`.

**Not customizable — by design (ADR-029 §1).** No drag-and-drop, no widget
picker, no saved-layout table, no per-card date ranges. A single-user app does
not need a layout engine; the curated order *is* the opinion. Adding a card means
adding a component and one loader field, not building a dashboard builder.

**Read-only.** Every card links out; nothing on this page mutates anything.

---

## Performance

Measured, not guessed (CLAUDE.md §Performance). The harness is
[scripts/dashboard-perf.ts](../scripts/dashboard-perf.ts):

```bash
pnpm perf:dashboard             # seed a 3-year book into the TEST db, then measure
pnpm perf:dashboard --no-seed   # re-measure against the existing seed
```

It refuses to run against anything but `TEST_DATABASE_URL` (same guard as
`vitest.setup.ts`), times each read, counts the queries each one issues, and
compares the parallel fan-out against the sum of the same reads run serially.

### Findings — 3-year seeded book

Dataset: 12 accounts, 32 holdings, 1,096 snapshot days, ~36k price rows, ~36k
holding snapshots, ~7.6k transactions.

**Per-read cost, `ALL` window:**

| Read | Time |
|---|---:|
| `netWorthSeries` (ALL) | 342 ms |
| `computeNetWorth` | 110 ms |
| `listHoldingSnapshots` | 98 ms |
| `listValuedPositions` | 58 ms |
| `netWorthSeries` (1M) | 16 ms |
| `listWatchlist` | 14 ms |
| `budgetVsActual` | 11 ms |
| `spendingSummary` | 6 ms |
| `listInvestmentFlows` | 4 ms |
| `benchmarkCloseSeries` | 3 ms |
| `listOpenAlerts` | 3 ms |

**End to end:** `1M` ~108 ms · `1Y` ~165 ms · `ALL` ~440 ms.

### Verdicts

**✅ The fan-out is parallel.** Wall time for `ALL` (~440 ms) sits well below the
sum of the ten reads run one after another (~660 ms). The one `Promise.all` in
`loadDashboard` does what P13-14 requires — there is no stray sequential `await`.
No single read dominates any more, so the ten contend for connections and wall
time lands between the slowest read and the sum; that is the expected shape.

**✅ No read triggers an N+1.** Every card costs single- or double-digit
milliseconds against three years of data. The whole fan-out issues single-digit
statement counts, flat with respect to the book size.

**✅ The range actually narrows the work.** `1M` is ~4× cheaper than `ALL`, because
the hero's history query is windowed *in the database* rather than fetched whole
and filtered in JS.

### The `netWorthSeries` rewrite

The first P13-20 run found one severe N+1, and it was the entire page's cost:
`netWorthSeries` called `computeNetWorth` once per distinct snapshot date, and
each of those queried once per account plus once per holding —
**O(days × (accounts + holdings))**. On this same book that was **84,717 ms and
98,089 queries**, 99% of the dashboard's load time, growing by one more
`computeNetWorth` call every night the snapshot job ran.

It is now a **single set-based query** plus one liabilities read — 2 statements
per call, regardless of days, accounts, or holdings. Loans stay in TypeScript,
where `Money`/decimal.js owns the arithmetic; SQL does only the per-date,
per-account "latest value on or before D" lookups.

| | before | after |
|---|---:|---:|
| `netWorthSeries("USD")`, 1,096 days | 84,717 ms | **342 ms** |
| statements issued | 98,089 | **2** |
| `loadDashboard("ALL")` | 86.7 s | **~440 ms** |
| `loadDashboard("1M")` | 85.1 s | **~108 ms** |

**Numbers are unchanged.** That is the acceptance bar, not a hope: the pre-rewrite
implementation is kept as an oracle and run side by side against the new one over
a fixture book exercising every rule, over randomized books
([series-parity.test.ts](../src/lib/net-worth/series-parity.test.ts)), and over
the full 3-year seeded book via
[scripts/networth-parity.ts](../scripts/networth-parity.ts) — **0 mismatches over
1,096 points**. The plan, including the rules the query has to reproduce and the
traps it has to avoid, is
[PLAN_NETWORTH_SERIES.md](../plans/features/PLAN_NETWORTH_SERIES.md).

**No new index.** `EXPLAIN (ANALYZE, BUFFERS)` shows both lateral lookups landing
on primary keys that already existed — `account_snapshots_account_id_date_pk`
(13,152 probes at ~0.002 ms) and `prices_symbol_date_pk` (35,072 probes at
~0.006 ms), both `Index Scan Backward`. The only sequential scans are over
`accounts` (12 rows), `holdings` (32 rows), and the one pass over
`account_snapshots` that builds the date axis (0.8 ms). Adding an index would
have been guessing; the measurement says there is nothing to fix.

The remaining cost is the price lookup (35k index probes ≈ 214 ms of the 342 ms).
That is comfortably inside budget for the default `1Y` view, so it stays as is —
profile before optimizing (CLAUDE.md §Performance).

---

## Tests

| Surface | Where |
|---|---|
| Range parsing + window math | [range.test.ts](../src/lib/dashboard/range.test.ts) |
| Range delta (money math, empty-series guards) | [delta.test.ts](../src/lib/dashboard/delta.test.ts) |
| Loader composition + per-card status discrimination | [loader.test.ts](../src/lib/dashboard/loader.test.ts) |
| Zero-egress + no-logging regression | [privacy-egress.test.ts](../src/lib/dashboard/privacy-egress.test.ts) |
| The rendered page (E2E) | [phase13-dashboard.spec.ts](../e2e/phase13-dashboard.spec.ts) |

The loader tests mock every DB read and leave the composed libraries real — they
pin *which query feeds which card* and *when a card degrades*, not arithmetic
that `allocation.test.ts`, `performance.test.ts`, and `forward-income.test.ts`
already cover.
