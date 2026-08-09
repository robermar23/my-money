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
| **Savings rate** | — reserved seam, renders nothing | *(Phase 14, ADR-030/031)* | — |

Three of those carry a label that is not decoration:

- **Performance** never invents a return. Fewer than two snapshot days in the
  range ⇒ "Insufficient history for this range." (**ADR-021**).
- **Forward income** is an *estimate* — today's holdings at today's distribution
  rate — and says so next to the number, not in a footnote (**ADR-022**).
- **Watchlist movers** are *pretend* positions and are labeled "not counted in
  net worth" (**ADR-025**). They are structurally outside net worth: a watchlist
  item is neither an account nor a holding.

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
month** (a "3M budget" is not a thing), and allocation, forward income, alerts,
and movers are all **as-of-now** figures with no time window to rewind.

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

**Per-read cost and queries issued, `ALL` window:**

| Read | Time | Queries |
|---|---:|---:|
| `netWorthSeries` | **84,717 ms** | **98,089** |
| `listHoldingSnapshots` | 110 ms | 215 |
| `computeNetWorth` | 109 ms | ~13 |
| `listValuedPositions` | 62 ms | 8 |
| `listWatchlist` | 18 ms | ~1 |
| `budgetVsActual` | 12 ms | ~1 |
| `spendingSummary` | 8 ms | ~1 |
| `listInvestmentFlows` | 6 ms | ~1 |
| `benchmarkCloseSeries` | 5 ms | ~1 |
| `listOpenAlerts` | 4 ms | ~1 |

*(Postgres flushes per-database stats about once a second, so the sub-second
reads under-report their query count — those are floors. The 98k is real.)*

**End to end:** `1M` 85.1 s · `1Y` 87.1 s · `ALL` 86.7 s.

### Verdicts

**✅ The fan-out is parallel.** Wall time (86.7 s) tracks the *slowest single read*
(84.7 s), not the sum of the ten (85.1 s). The one `Promise.all` in
`loadDashboard` does what P13-14 requires — there is no stray sequential `await`.

**✅ Nine of the ten reads are fast and flat.** Every card except the hero's
history costs single- or double-digit milliseconds against three years of data,
because they read snapshot/indexed tables and return summaries. No *card* triggers
an N+1.

**❌ `netWorthSeries` is a severe N+1 — and it is the whole page's cost.**
[`netWorthSeries`](../src/lib/net-worth/compute.ts) calls `computeNetWorth` once
per distinct snapshot date, and each of those queries once per account plus once
per holding for live valuation. That is **O(days × (accounts + holdings))**
queries: 1,096 days × 12 accounts × 32 holdings ⇒ ~98k queries and ~85 s. It grows
every single day the snapshot job runs.

Two things make it worse on this page specifically:

1. The loader calls `netWorthSeries()` **unranged** and filters the result in JS,
   so a `1M` view pays the full-history cost — the timings above are flat across
   ranges for exactly that reason.
2. It sits on the **landing page**, so it is the first thing that runs after login.

**This is pre-existing Phase 1 library code, not something Phase 13 introduced** —
the same call backs the net-worth chart elsewhere. But the dashboard is what makes
it hurt. The Suspense boundary (P13-15) keeps the shell painting immediately, so
the page is never blank, but the content behind it still takes ~85 s at this
scale.

**Recommended fix (not applied — needs an explicit decision, see
[PLAN13.md](../plans/features/PLAN13.md) §Open Items):** replace the
date-loop-of-`computeNetWorth` with a single set-based query — a lateral join (or
window function) picking each account's latest snapshot on or before each date,
aggregated in SQL — and give `netWorthSeries` a date-range parameter so a `1M`
view reads a month. That is a change to the net-worth math the whole app depends
on, with its own tests, and belongs in its own task rather than inside a dashboard
batch.

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
