# PLAN — Phase 11 (Watchlist & paper positions: track a symbol you don't own, "pretend" you bought it, and get alerted at a target price)

> Phases 1–10 built net worth from things the user **actually owns** — cash, credit, brokerage holdings, IRA metals, the mortgage, the home, and (Phase 10) personal high-value assets. Round 5 ([IDEAS2.md](IDEAS2.md)) asks for the opposite: **things the user does _not_ own but wants to follow.** Verbatim: *"What if a user wants to add a stock to track the history of and 'pretend' they purchased it at a certain date/time and track its progress and even get alerted when the stock/metal/whatever reaches a specific value, up or down. This should not count towards net worth of course."*
>
> Three distinct capabilities are bundled in that sentence:
> 1. **Watch a symbol** (stock / ETF / metal / crypto) that is **not a holding** — so it must be invisible to `computeNetWorth`, `holding_snapshots`, allocation, and performance.
> 2. **A "paper" / pretend purchase** — an optional `(date, quantity, cost-per-unit)` so the item shows a **simple display gain/loss** and a **price-history chart from the purchase date forward**, identical in shape to the real-holding gain/loss already shipped in Phase 5/9 — but with **no realized P&L, no tax lots, no 1099** (CLAUDE.md §Domain Scope).
> 3. **Price-target alerts** — "tell me when SYMBOL crosses $X, up or down" — surfaced through the **existing `/alerts` page + content-free email** built in Phase 6 (ADR-015), with **zero financial data leaving the box**.
>
> The good news, again, is that this is **overwhelmingly additive and reuses machinery we already have.** The price pipeline ([fetch-prices-daily](../../src/worker/jobs/fetch-prices-daily.ts) → [prices](../../src/db/schema/prices.ts), routed by [asset_class](../../src/lib/prices/router.ts)) already fetches and stores a daily close for any symbol we ask it to; the alert system ([alerts](../../src/db/schema/alerts.ts) + [rules.ts](../../src/lib/alerts/rules.ts) + [notify.ts](../../src/lib/alerts/notify.ts)) already detects conditions, dedupes them, and rings a content-free doorbell; the per-security **price-history chart island** ([price-history-chart.tsx](../../src/app/investments/security/price-history-chart.tsx)) and the [gainLoss](../../src/lib/investments/gain-loss.ts) helper render exactly the views this feature needs. Phase 11 introduces **two small tables** (`watchlist_items`, `price_targets`), **one new historical-series fetch** (so a freshly-added symbol gets a chart back to its purchase date), **one new alert rule + evaluator job**, and **one new `/watchlist` UI surface** — and gets net-worth exclusion **for free** by simply *not* being an account or a holding.
>
> Phase 11 closes the round in six moves: (0) **scope gate + ADRs**; (1) **schema** — `watchlist_items`, `price_targets`, and a one-line widening of the `alerts` type CHECK; (2) **price plumbing** — fold watchlist symbols into the nightly fetch, add a historical daily-series fetch + an on-add backfill job, and a pure paper-valuation helper; (3) **price-target alerts** — a pure rule + a daily evaluator that reuses `alerts`/`notify`; (4) **UI** — nav entry, list page, add form, detail page (history chart + paper gain/loss + targets), and lifecycle (edit/delete); (5) **server actions + Zod**; (6) **tests, docs, security/privacy pass, E2E**.
>
> **Hard boundary (CLAUDE.md §Domain Scope) — read before writing code.** This stays a *read-only personal tracker*. Phase 11 does **NOT** add: order placement or any brokerage integration (we never touch a trade API); real-time/streaming quotes or a websocket price feed; intraday tick storage; options/derivatives modeling; technical-analysis indicators (RSI/MACD/etc.); backtesting or strategy simulation; multi-leg "paper portfolios" with their own performance attribution (a watchlist item is a *single* pretend position, not a competing portfolio engine); tax-lot or realized-gain accounting on the pretend position; or **any** third-party alerting channel beyond the existing self-hosted SMTP doorbell (no Twilio/SMS, no push-notification SaaS, no webhooks out). Real-time intraday alerting is explicitly **scoped-but-deferred** (see ADR-026 + Open Items): the shipped cadence is a **once-daily** evaluation right after the nightly price fetch. Any of those crossing-the-line features needs a FEATURE.md decision update first (P11-00 records the scope note).
>
> **Privacy (CLAUDE.md §Privacy & Data Sovereignty) — binding; this phase introduces _no new egress class_.** A watchlist symbol is fetched from the **same** public Yahoo / CoinGecko endpoints the price pipeline already hits for held symbols — only a **ticker string** egresses, never a quantity, cost, target, account name, or balance (exactly the existing posture in [yahoo-chart.ts](../../src/lib/prices/yahoo-chart.ts) / [coingecko.ts](../../src/lib/prices/coingecko.ts)). The pretend `(quantity, cost, target)` data is **100% local**, lives in our own Postgres, and rides the nightly `age`-encrypted `pg_dump`. The price-target email remains the Phase-6 **content-free** doorbell — a count + sign-in link, **no symbol, no price, no amount** (the figures live only in the authenticated `/alerts` and `/watchlist` pages). P11-00 + the Batch 5 privacy pass make this explicit and add a privacy-regression test asserting the target-alert path emits nothing financial.
>
> **Companion docs** — read for context, do not duplicate:
> - [PLAN9.md](PLAN9.md) / [PLAN10.md](PLAN10.md) — the **template for this phase's structure** (batch/ADR/scope-gate discipline, additive-schema posture, "what already exists" inventory, `text`+CHECK vs `pgEnum` reasoning, `Number()`-only-at-the-display-edge rule).
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Money & Numeric Precision (cost, price, target are `NUMERIC`; all arithmetic through [Money](../../src/lib/money/money.ts)/`decimal.js`; `Number()` only at the display edge), §Domain Scope (boundary above), §Privacy (boundary above), §Background Jobs (one job per unit of work; idempotent; repeatable BullMQ cron not OS cron), §Database & Drizzle Specifics (UUID PKs; `numeric` for money; `date(mode:'string')`; `timestamp({withTimezone:true})`; one file per concept; never drop a column without a backup), §Testing Philosophy (the price-target rule + paper-valuation are pure functions → "always-test" surfaces; the alert privacy-regression is mandatory).
> - [IDEAS.md](IDEAS.md) §11 Decision Log (current max **ADR-024**; Phase 11 appends **ADR-025 → ADR-026**), §5 market data (Yahoo equities+metals, CoinGecko crypto), ADR-015 (alerts: in-app primary, content-free email), ADR-005/013 (Recharts island per chart).
> - [SKILLS.md](SKILLS.md) §Suggested Workflow — see §Skills Map below.

---

## What already exists (do not rebuild — extend these)

Phase 11 is mostly *reuse*. Inventory before writing a line of code:

- **Price pipeline** — [fetch-prices-daily](../../src/worker/jobs/fetch-prices-daily.ts) walks a work-list of `(symbol, asset_class)` from [distinctHeldSymbols](../../src/lib/prices/store.ts), routes each via [PriceRouter](../../src/lib/prices/router.ts) (Yahoo equities + metals, CoinGecko crypto), and UPSERTs into [prices](../../src/db/schema/prices.ts) on `(symbol, date)`. Phase 11 **adds watchlist symbols to that same work-list** — one new `distinctWatchlistSymbols()` source unioned in. No new fetcher, no new price table.
- **Latest + historical price reads** — [latestCloseOnOrBefore](../../src/lib/prices/store.ts) (valuation) and the `securityPriceHistory(symbol, {from,to})` query in [queries.ts](../../src/lib/investments/queries.ts) (the chart series). The watchlist detail page reuses the **identical** read shape.
- **Historical backfill posture** — [backfill-history.ts](../../src/lib/investments/backfill-history.ts) (PLAN9/ADR-019) is the precedent for "best-effort backfill from the `prices` table." But it only reads prices we *already* have; a brand-new watchlist symbol has **none** before purchase date. So Phase 11 adds a **historical daily-series fetch** (`fetchYahooDailySeries` next to [fetchYahooClose](../../src/lib/prices/yahoo-chart.ts), same unauthenticated chart endpoint, just reading the full `close[]` array + `timestamp[]`) plus a CoinGecko market-chart counterpart, invoked by an **on-add backfill job** that seeds `prices` from the purchase date forward.
- **Gain/loss + valuation** — [gainLoss](../../src/lib/investments/gain-loss.ts) (`{value, costBasis} → {absolute, percent}`) and the value-formatting in [format.ts](../../src/lib/investments/format.ts). The paper position's gain/loss is the **same** computation against the pretend cost — no realized P&L.
- **Alert system (ADR-015)** — [alerts](../../src/db/schema/alerts.ts) table (`type`+`severity` are `text`+CHECK, `dedup_hash` UNIQUE → fire-once), the **pure** rule functions in [rules.ts](../../src/lib/alerts/rules.ts), the orchestrator [detect-anomalies-daily](../../src/worker/jobs/detect-anomalies-daily.ts), the **content-free** [notifyNewAlerts](../../src/lib/alerts/notify.ts), the [/alerts page](../../src/app/alerts/page.tsx) + dismiss action, and [openAlertCount](../../src/lib/alerts/queries.ts) (drives the nav badge). Phase 11 **adds `'price_target'` to the type CHECK**, a `priceTargetAlerts()` pure rule, and a small **evaluator job** — it does **not** fold price targets into the anomaly resolve-sweep (they're **one-shot**, like `backup_failure`).
- **Chart island (ADR-005/013)** — [price-history-chart.tsx](../../src/app/investments/security/price-history-chart.tsx) (`"use client"`, `ResponsiveContainer`, `Intl.NumberFormat`, `Number()` at the edge, dark-mode `currentColor`). The watchlist detail chart **reuses this component as-is**, optionally overlaying a target/cost reference line.
- **Symbol entry + asset-class routing** — the manual-holding flows already validate a symbol + `asset_class` and know the metal-symbol map (`XAU`→`GC=F`, in [yahoo-metals.ts](../../src/lib/prices/yahoo-metals.ts)) and the crypto coin-id map ([coingecko.ts](../../src/lib/prices/coingecko.ts)). The watchlist add form reuses the same `asset_class` discriminator (`equity | crypto | physical_metal`) and the same [isFetchableAssetClass](../../src/lib/prices/router.ts) guard.
- **Nav + chrome** — [nav-menu.tsx](../../src/components/nav-menu.tsx) `LINKS` array (add one entry) and the [AppNav](../../src/components/app-nav.tsx) badge plumbing.
- **Worker registration + cron** — [worker/index.ts](../../src/worker/index.ts) (queue/worker wiring + `upsertJobScheduler` cron pattern) and the queue/connection helpers it imports from `src/lib/queue/`. New jobs follow the existing register-worker + schedule-cron pattern and the graceful-shutdown list.
- **Validation + money** — [Money](../../src/lib/money/money.ts) + `decimal.js`; Zod schemas at every server-action boundary (the `src/lib/schemas/` precedent). Reuse `moneyAmountSchema` / `isoDateSchema` shapes.

---

## ADRs locked at plan time

Two decisions surface in Phase 11. Both are 🔲 **Proposed** — append to [IDEAS.md](IDEAS.md) §11 Decision Log (next free numbers **ADR-025 → ADR-026**; verified ADR-024 is current max) after this plan is approved (P11-00).

---

### ADR-025 — Watchlist / paper positions as a standalone `watchlist_items` table, **structurally excluded** from net worth, reusing the price pipeline

**Status**: ✅ Locked 2026-06-21

**Context**: Round 5 wants to follow a symbol the user does **not** own, optionally with a "pretend" purchase, and it must **not** count toward net worth. The app values net worth exclusively from `accounts` → (`account_snapshots` | `holdings` → `holding_snapshots`). The question is *where* a watched symbol lives so that exclusion is **guaranteed by structure**, not by a fragile "remember to filter it out" flag.

**Decision**:
1. **New first-class `watchlist_items` table** — a watched symbol is **neither an account nor a holding**. Because `computeNetWorth`/`netWorthSeries`/allocation/performance read only `accounts`/`holdings`/their snapshots, a `watchlist_items` row is **invisible to net worth by construction** — exclusion needs **zero filtering code** and cannot regress. Columns:
   - `id uuid pk default random`
   - `symbol text not null` — canonical ticker (uppercased), e.g. `AAPL`, `XAU`, `BTC`.
   - `asset_class asset_class not null` — reuses the existing `pgEnum`, but **CHECK-constrained to the fetchable subset** `('equity','crypto','physical_metal')` (cash/property make no sense to watch).
   - `label text` — optional display name ("Apple Inc."); free-text, display-only, not parsed.
   - `pretend_quantity numeric(28,8)` — **nullable**; the pretend share/coin/oz count. NULL = "just watching, no pretend position."
   - `pretend_unit_cost numeric(18,8)` — **nullable**; pretend price *per unit* at purchase. (Per-unit, not total, mirroring how a quote is per-unit; total cost is derived = qty × unit cost.)
   - `pretend_purchased_at date (mode:'string')` — **nullable**; the pretend purchase date, also the **start of the history backfill window**.
   - `currency text not null default 'USD'`.
   - `notes text` — optional.
   - `created_at` / `updated_at timestamptz default now()`.
   - Constraints: **UNIQUE `(symbol, asset_class)`** (one watch row per instrument — re-adding is an edit, not a duplicate); CHECK on `asset_class`; a CHECK that the three `pretend_*` columns are **all-NULL or all-non-NULL** (a paper position is coherent or absent — no half-specified pretend buys).
2. **Valuation is read-only and on-the-fly** — current value = `pretend_quantity × latestCloseOnOrBefore(symbol, today)`; gain/loss = [gainLoss](../../src/lib/investments/gain-loss.ts) against `pretend_quantity × pretend_unit_cost`. **No snapshot table** for watchlist items — they aren't net worth, the history *is* the `prices` series, and a daily per-item snapshot would be pure bloat. (Contrast with holdings, which snapshot because they *are* net worth and quantity changes over time.)
3. **Prices come from the existing pipeline** — `fetch-prices-daily` is extended to union `distinctWatchlistSymbols()` into its work-list, so every watched symbol gets a fresh daily close in `prices` (idempotent on `(symbol, date)`; a symbol that is *both* held and watched is fetched once). Going forward the chart fills in automatically; **history before today** is seeded by the on-add backfill (point 4).
4. **On-add historical backfill** — adding a watchlist item enqueues a **one-shot `backfill-watchlist-symbol` job** that fetches the daily close series from `pretend_purchased_at` (or a default 24-month window when no pretend date) up to today via a new `fetchYahooDailySeries` (equities/metals) or CoinGecko `market_chart` (crypto), UPSERTing into `prices`. Best-effort and idempotent (same posture as [backfill-history.ts](../../src/lib/investments/backfill-history.ts)); a failed backfill just means a shorter chart until the nightly job catches up.
5. **No new egress class** — only the ticker string leaves the box, to the same public endpoints already used for held symbols (CLAUDE.md §Privacy). Pretend qty/cost never egress.

**Consequences**:
- ✅ Net-worth exclusion is **structural and permanent** — no filter to forget, no test to guard a flag.
- ✅ Reuses the entire price pipeline, the price-history chart, the gain/loss helper, and `prices` storage. New surface is one table + one backfill fetch.
- ✅ A symbol held *and* watched coexists cleanly: the holding values net worth; the watch row is a separate follow with its own pretend basis.
- ⚠️ Watchlist symbols enlarge the nightly fetch work-list (more Yahoo/CoinGecko calls). Bounded by single-user scale + the existing per-symbol `delayMs` spacing; negligible.
- ⚠️ Backfill accuracy depends on the public endpoint's history depth and symbol resolution (foreign tickers, delisted names, obscure coins may 404/partial). Best-effort, surfaced as "limited history," not an error.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Model a watch as a `holding` with a "paper" flag in a hidden account | Holdings *are* net worth; one boolean away from a balance bug, and it pollutes allocation/performance/snapshot queries with "remember to exclude paper" filters everywhere. Structural exclusion (separate table) is safer. |
| Reuse `securities` + a `watchlist` join table | `securities` is the Plaid-securities metadata map keyed to holdings; watch items are often hand-typed symbols with no Plaid identity. A self-contained table avoids coupling the watch feature to the holdings/securities graph. |
| Snapshot watchlist value nightly into its own table | Pure bloat — watch items aren't net worth and their history *is* the `prices` series. Compute value on read. |
| Allow watching cash/property classes | Nothing to fetch a price for; constrained out via CHECK. |

---

### ADR-026 — Price-target alerts: **one-shot** targets reusing the `alerts` table + content-free notification, evaluated **once daily** after the price fetch (intraday deferred)

**Status**: ✅ Locked 2026-06-21

**Context**: Round 5 wants "get alerted when the stock/metal/whatever reaches a specific value, **up or down**." We already have a complete, privacy-correct alert system (ADR-015): `/alerts` page primary, content-free email doorbell, dedup-by-hash, BullMQ-scheduled detection. The questions are: where targets live, how "crossing" is defined, what fires the evaluation, and how often.

**Decision**:
1. **New `price_targets` table** — one row per "tell me when X" rule:
   - `id uuid pk default random`
   - `watchlist_item_id uuid` FK → `watchlist_items` `onDelete: cascade` (a target dies with its watch row). *Targets attach to a watchlist item* (not a free-floating symbol) so the UI has a home and the symbol/asset_class are inherited.
   - `direction text not null` CHECK `('above','below')` — fire when price rises **to/above** (`above`) or falls **to/at-or-below** (`below`) the threshold. Covers "up or down."
   - `threshold numeric(18,8) not null` — the target price per unit.
   - `active boolean not null default true` — false once triggered (one-shot) or user-paused.
   - `triggered_at timestamptz` / `triggered_price numeric(18,8)` — stamped when it fires.
   - `note text` — optional ("sell target", "buy the dip").
   - `created_at`/`updated_at`.
   - Index `(watchlist_item_id)`; partial index on `active = true` for the evaluator scan.
2. **One-shot semantics** — a target fires **once**: when the latest close satisfies the direction, write an `alerts` row and set `active = false`, `triggered_at`, `triggered_price`. It does **not** re-arm automatically (avoids nightly nagging on a symbol parked past its threshold) and is **not** swept by the anomaly resolve-loop — so `'price_target'` is added to the `alerts` type CHECK but **NOT** to `RULE_ALERT_TYPES` in [rules.ts](../../src/lib/alerts/rules.ts) (same exemption as `backup_failure`). The user re-arms by re-activating/editing the target.
3. **Pure rule + thin evaluator** — `priceTargetAlerts(targets, latestPrices)` is a **pure function** (Money/Decimal comparison, no clock, no DB) returning `DetectedAlert[]` with `dedupHash = sha256('price_target' | targetId | thresholdCrossedDay)` and a title carrying **only the symbol + direction** ("AAPL reached your target") — the threshold, the price, and the pretend P&L go in `detail` (shown only in the authenticated UI), exactly per ADR-015. A small `evaluate-price-targets` job loads active targets + each symbol's latest close, runs the rule, INSERTs `...ON CONFLICT (dedup_hash) DO NOTHING`, flips the fired targets inactive, and reuses [notifyNewAlerts](../../src/lib/alerts/notify.ts) for the content-free email.
4. **Cadence: once daily, chained off the price fetch** — the evaluator runs **immediately after** `fetch-prices-daily` (enqueued on that job's completion), guaranteeing it sees the freshest close with **no race**. This is the privacy- and rate-limit-simple choice and matches the app's whole "nightly batch" rhythm. **Real-time / intraday alerting is explicitly deferred** (Open Item): it would need an intraday poll loop, more frequent egress, and careful rate-limit handling for marginal value to a self-hosted single user. An env-gated higher-frequency poll is the documented future path.
5. **Notification stays content-free** — the email is the Phase-6 doorbell (count + sign-in link, no symbol/price/amount). Figures live only in `/alerts` + `/watchlist`. A privacy-regression test asserts the price-target path emits nothing financial.

**Consequences**:
- ✅ Reuses the entire alert + notification + nav-badge surface; new code is one pure rule, one small job, one table, one CHECK widening.
- ✅ One-shot + dedup-by-day means a target fires exactly once, never nags, and is idempotent under job re-runs.
- ✅ "Up or down" is the `direction` enum; nothing special-cased.
- ⚠️ **Not real-time** — a target that's hit and retraces intraday before the nightly fetch won't fire that day. Documented as a known limitation; intraday is the deferred Open Item. Acceptable for a long-horizon personal tracker.
- ⚠️ Adds `'price_target'` to a CHECK constraint → a migration that drops + re-adds the CHECK. Lighter than an enum-add; same posture the alerts table already documents.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Real-time intraday polling / websocket feed | Continuous egress + rate-limit complexity + a streaming dependency, for marginal value to a single self-hosted user. Daily batch fits the app; intraday deferred as an env-gated Open Item. |
| Fold price targets into `detect-anomalies-daily` | That job runs at 05:00 and owns the resolve-sweep; price targets are one-shot and depend on the 01:30 price fetch. A separate evaluator chained off the fetch is cleaner and keeps each job single-purpose (CLAUDE.md §Background Jobs). |
| Re-arming/recurring targets | Nightly nagging while a symbol sits past threshold. One-shot + manual re-arm is calmer and simpler; recurring is a later toggle if it earns it. |
| SMS / push / third-party alert channel (Twilio, Pushover, ntfy SaaS) | New egress of (at minimum) the fact-of-alert through a third party; the content-free self-hosted SMTP doorbell already exists and satisfies §Privacy. |
| Put the threshold/price in the alert **title** | Violates ADR-015 (titles carry no raw figures). Symbol + direction only in the title; numbers in `detail`. |

---

## Phase 11 — Schema (two new tables + one CHECK widening)

All follow CLAUDE.md §Database & Drizzle Specifics: UUID PKs, `numeric` for money/quantity (never float), `date(mode:'string')` for dates, `timestamp({withTimezone:true})`, one file per concept under [src/db/schema/](../../src/db/schema/), re-exported from [index.ts](../../src/db/schema/index.ts). **No column dropped; no destructive change.**

```text
src/db/schema/
├── watchlist-items.ts   (NEW: watched symbol + optional pretend position)
├── price-targets.ts     (NEW: one-shot above/below target → alert)
├── alerts.ts            (UPDATED: type CHECK += 'price_target')
└── index.ts             (UPDATED: re-export the two new tables + relations)
```

Migration: `drizzle-kit generate` produces (a) two `CREATE TABLE`, (b) a `DROP CONSTRAINT alerts_type_check` + `ADD CONSTRAINT … IN (… ,'price_target')`. Reviewed by hand before `migrate` (the CHECK swap must list the full existing set + the new value).

---

## Batches & tasks

> Task IDs are `P11-NN`. Each is atomic, independently reviewable, and ends green (typecheck + Biome + the stated tests). Acceptance criteria are concrete. Skills to invoke are named per task; see §Skills Map.

**Status — ✅ all batches complete (2026-06-21).** P11-00 → P11-24 shipped: scope/ADRs, schema (`watchlist_items`, `price_targets`, `alerts` CHECK widening), price plumbing (work-list union, Yahoo/CoinGecko daily-series fetch, on-add backfill, `paperValuation`), one-shot price-target alerts (pure rule + evaluator chained off the price fetch), the `/watchlist` UI (nav, list, add/edit, detail, targets, delete), and Batch 5 — unit-test sweep, the **mandatory privacy-regression test** ([privacy-egress.test.ts](../../src/lib/watchlist/privacy-egress.test.ts)), the security checklist + docs ([docs/WATCHLIST.md](../../docs/WATCHLIST.md)), and the E2E happy path ([phase11-watchlist.spec.ts](../../e2e/phase11-watchlist.spec.ts)). `evaluate-price-targets` is wired into [run-once.ts](../../src/worker/run-once.ts) for manual verification.

### Batch 0 — Scope gate & ADRs

- **P11-00 — Record scope + lock ADRs.** Append ADR-025 + ADR-026 to [IDEAS.md](IDEAS.md) §11 Decision Log (status 🔲→✅ on approval); add the Round-5 scope note to [FEATURE.md](FEATURE.md) (in-scope: watch symbol, pretend position, daily price-target alert; out-of-scope list from the boundary above). **Acceptance**: both ADRs present with the next sequential numbers (025, 026); FEATURE.md links them to PLAN11; no code yet.
  - *Skills*: `architecture-decision-records`.

### Batch 1 — Schema

- **P11-01 — `watchlist_items` table.** New [src/db/schema/watchlist-items.ts](../../src/db/schema/watchlist-items.ts) per ADR-025: columns, the UNIQUE `(symbol, asset_class)`, the `asset_class IN ('equity','crypto','physical_metal')` CHECK, and the all-or-nothing `pretend_*` CHECK (`(pretend_quantity IS NULL) = (pretend_unit_cost IS NULL) AND (pretend_quantity IS NULL) = (pretend_purchased_at IS NULL)`). Export `WatchlistItem`/`NewWatchlistItem` types and a `watchlistItemsRelations` (`many(priceTargets)`). **Acceptance**: `$inferSelect` types compile; CHECKs present in generated SQL.
  - *Skills*: `drizzle-orm-expert`, `typescript-pro`.
- **P11-02 — `price_targets` table.** New [src/db/schema/price-targets.ts](../../src/db/schema/price-targets.ts) per ADR-026: FK → `watchlist_items` cascade, `direction` CHECK `('above','below')`, `threshold`, `active`, `triggered_at`/`triggered_price`, indexes (`watchlist_item_id`; partial on `active = true`). Export types + `priceTargetsRelations` (`one(watchlistItems)`). **Acceptance**: FK cascade + CHECK + partial index in generated SQL.
  - *Skills*: `drizzle-orm-expert`, `postgres-best-practices`.
- **P11-03 — Widen `alerts` type CHECK + re-exports.** Add `'price_target'` to the CHECK in [alerts.ts](../../src/db/schema/alerts.ts); re-export the two new tables + relations from [index.ts](../../src/db/schema/index.ts). **Acceptance**: CHECK lists the full prior set + `price_target`; index re-exports resolve.
  - *Skills*: `drizzle-orm-expert`.
- **P11-04 — Generate + review + apply migration.** `pnpm drizzle-kit generate`; hand-review the CHECK drop/add lists the full set; apply via `migrate` on a dev DB. **Acceptance**: migration applies cleanly on a fresh DB; `alerts` accepts a `price_target` insert; `watchlist_items` rejects a half-specified pretend buy and a `cash` asset_class.
  - *Skills*: `drizzle-orm-expert`, `database-migration` (only if a data step is needed — here it isn't).

### Batch 2 — Price plumbing (fetch + backfill + paper valuation)

- **P11-05 — `distinctWatchlistSymbols()` + union into the daily fetch.** Add the helper to [store.ts](../../src/lib/prices/store.ts) (distinct `(symbol, asset_class)` from `watchlist_items`, excluding none — all are fetchable by the CHECK). In [fetch-prices-daily.ts](../../src/worker/jobs/fetch-prices-daily.ts), union watchlist symbols into the work-list, **de-duplicating** against held symbols (a symbol fetched once even if held+watched) and against the benchmark. **Acceptance**: unit test — given held `{AAPL}` and watched `{AAPL, BTC}`, the work-list is `{AAPL, BTC, ^GSPC}` (no dup AAPL); existing fetch tests stay green.
  - *Skills*: `drizzle-orm-expert`, `test-driven-development`.
- **P11-06 — `fetchYahooDailySeries(symbol, fromIso)`.** New export in [yahoo-chart.ts](../../src/lib/prices/yahoo-chart.ts) (or a sibling `yahoo-series.ts`) hitting the **same** unauthenticated chart endpoint with `interval=1d` and a `range`/`period1` covering `fromIso → today`, returning `{date, close}[]` from the `timestamp[]` + `indicators.quote[0].close[]` arrays (Zod-validated; nulls skipped; dates as `YYYY-MM-DD` UTC). **Acceptance**: unit test against a captured fixture returns a sorted, null-free series; a 429 retries via the existing `withRateLimitRetry`.
  - *Skills*: `zod-validation-expert`, `test-driven-development`.
- **P11-07 — CoinGecko historical series.** Add a `marketChartSeries(coinId, fromIso)` to [coingecko.ts](../../src/lib/prices/coingecko.ts) using `/market_chart/range` (or `/market_chart?days=`), reusing the existing coin-id resolution + Zod parsing, returning the same `{date, close}[]` shape (one close per UTC day). **Acceptance**: unit test against a fixture; unknown coin throws (caught by the backfill job, logged, item still created).
  - *Skills*: `zod-validation-expert`, `test-driven-development`.
- **P11-08 — `backfill-watchlist-symbol` job + queue.** New [src/worker/jobs/backfill-watchlist-symbol.ts](../../src/worker/jobs/backfill-watchlist-symbol.ts): given `{watchlistItemId}`, load the item, pick the series fetcher by `asset_class` (Yahoo equities/metals incl. the metal-symbol map, CoinGecko crypto), fetch from `pretend_purchased_at ?? 24-months-ago` → today, UPSERT into `prices` via the existing [upsertPrice](../../src/lib/prices/store.ts) shape (batch). Register the queue/worker in [worker/index.ts](../../src/worker/index.ts) + graceful-shutdown list; **no cron** (on-demand only). **Acceptance**: job test with a mock fetcher writes N price rows idempotently (re-run = no change); a fetch failure returns `{written:0}` without throwing the whole job.
  - *Skills*: `bullmq-specialist`, `drizzle-orm-expert`.
- **P11-09 — `paperValuation` pure helper.** New [src/lib/watchlist/valuation.ts](../../src/lib/watchlist/valuation.ts): pure function `(item, latestClose) → { value, costBasis, gainLoss }` using [Money](../../src/lib/money/money.ts) + [gainLoss](../../src/lib/investments/gain-loss.ts); returns `null` value when `latestClose` is missing or the item has no pretend position. **No `Number()`** except never (helper stays in Money/string). **Acceptance**: unit tests — gain, loss, no-pretend (watch-only), and missing-price cases; cents exact via Decimal.
  - *Skills*: `test-driven-development`, `typescript-pro`.

### Batch 3 — Price-target alerts

- **P11-10 — `priceTargetAlerts()` pure rule.** Add to [rules.ts](../../src/lib/alerts/rules.ts): input `{targetId, watchlistItemId, symbol, direction, threshold, latestClose, latestDate, pretend?}[]`, output `DetectedAlert[]` for satisfied targets. `above` fires when `close ≥ threshold`; `below` when `close ≤ threshold` (Money/Decimal compare, no floats). Title = `"${symbol} hit your ${direction} target"` (**no numbers**); `detail` = `{symbol, direction, threshold, price, date, watchlistItemId, …pretendPnl?}`. `dedupHash('price_target', targetId, latestDate)`. Add `'price_target'` to the `AlertType` union but **leave it out of `RULE_ALERT_TYPES`** (one-shot, not resolve-swept). **Acceptance**: unit tests — above-hit, below-hit, not-yet, exact-equality boundary (fires), and "title contains no digits" assertion.
  - *Skills*: `test-driven-development`.
- **P11-11 — `evaluate-price-targets` job + queue.** New [src/worker/jobs/evaluate-price-targets.ts](../../src/worker/jobs/evaluate-price-targets.ts): load `active = true` targets joined to their watchlist item (symbol, asset_class, pretend); load each symbol's latest close ([latestCloseOnOrBefore](../../src/lib/prices/store.ts)); run `priceTargetAlerts`; INSERT `alerts …ON CONFLICT (dedup_hash) DO NOTHING`; for each fired target set `active=false, triggered_at, triggered_price`; reuse [notifyNewAlerts](../../src/lib/alerts/notify.ts) for whatever's now open+un-notified (or let the existing 05:00 notify pass pick them up — pick one path and document; **chosen**: this job notifies, consistent with one-shot immediacy). Deps injectable (load/now/notify) per the `detect-anomalies-daily` pattern. **Acceptance**: job test — a hit target produces one alert, flips inactive, and is a no-op on re-run (dedup + inactive); a missed target does nothing.
  - *Skills*: `bullmq-specialist`, `drizzle-orm-expert`, `test-driven-development`.
- **P11-12 — Chain evaluator off the price fetch + register.** Enqueue `evaluate-price-targets` at the **end** of `fetch-prices-daily` (after the work-list completes) so it sees fresh closes; register the queue/worker + shutdown in [worker/index.ts](../../src/worker/index.ts). (No standalone cron — it rides the 01:30 fetch.) **Acceptance**: with the worker running against a seeded hit target, a manual fetch run results in an `/alerts` row + the nav badge incrementing; re-running is idempotent.
  - *Skills*: `bullmq-specialist`.

### Batch 4 — UI (`/watchlist`)

- **P11-13 — Nav entry.** Add `{ href: "/watchlist", label: "Watchlist" }` to `LINKS` in [nav-menu.tsx](../../src/components/nav-menu.tsx) (placed after Investments). **Acceptance**: link renders + active-state works on `/watchlist` desktop + mobile.
  - *Skills*: `nextjs-app-router-patterns`, `tailwind-patterns`.
- **P11-14 — Watchlist queries.** New [src/lib/watchlist/queries.ts](../../src/lib/watchlist/queries.ts): `listWatchlist()` (items + latest close + `paperValuation` + active-target count), `watchlistItemDetail(id)` (item + targets + price history via the `securityPriceHistory`-shaped read). **Acceptance**: returns display-ready rows; missing-price items render "—" not a throw.
  - *Skills*: `drizzle-orm-expert`, `nextjs-app-router-patterns`.
- **P11-15 — List page.** New [src/app/watchlist/page.tsx](../../src/app/watchlist/page.tsx) (Server Component, `requireUser`): table of watched symbols — symbol/label, asset class, last price, pretend gain/loss (green/red, `—` when watch-only), active targets, link to detail; empty state; "Add" entry point. Mirrors the [investments page](../../src/app/investments/page.tsx) layout/tokens. **Acceptance**: renders held+watch-only rows; `Number()` only in the chart/format edge.
  - *Skills*: `nextjs-app-router-patterns`, `tailwind-patterns`.
- **P11-16 — Add/edit form + server action.** New [src/app/watchlist/new/](../../src/app/watchlist/new/) form (symbol, asset_class select, optional label, optional pretend qty/unit-cost/date, notes) → `createWatchlistItemAction`; Zod schema [src/lib/schemas/watchlist.ts](../../src/lib/schemas/watchlist.ts) (uppercases symbol; enforces the all-or-nothing pretend trio; restricts asset_class to the fetchable subset). On create, enqueue `backfill-watchlist-symbol`. Reuse for edit. **Acceptance**: invalid (half pretend, cash class, blank symbol) rejected with field errors; valid create redirects to detail + kicks the backfill; `revalidatePath('/watchlist')`.
  - *Skills*: `zod-validation-expert`, `nextjs-app-router-patterns`, `react-hook-form` (if the existing forms use it), `frontend-security-coder` (symbol/label/notes are user-entered → escape on display).
- **P11-17 — Detail page + price-history chart.** New [src/app/watchlist/[id]/page.tsx](../../src/app/watchlist/[id]/page.tsx): header (symbol, label, asset class, current price, pretend value + gain/loss), the **reused** [PriceHistoryChart](../../src/app/investments/security/price-history-chart.tsx) over the item's `prices` series (optional cost/target reference line), the targets section, and a "limited history" note when the series is short. **Acceptance**: chart renders ≥2 points; watch-only items omit the gain/loss block; bad UUID → `notFound()`.
  - *Skills*: `nextjs-app-router-patterns`, `tailwind-patterns`.
- **P11-18 — Targets UI + actions.** On the detail page: list targets (direction, threshold, active/triggered state, triggered price/date), add-target form (`direction` select + `threshold`) → `createPriceTargetAction`, plus `togglePriceTargetAction` (re-arm/pause) and `deletePriceTargetAction`; Zod-validated; `revalidatePath`. **Acceptance**: add → appears active; a triggered target shows triggered price+date and an inactive badge with a re-arm button; delete removes it (and cascades nothing else).
  - *Skills*: `zod-validation-expert`, `nextjs-app-router-patterns`.
- **P11-19 — Delete watchlist item.** `deleteWatchlistItemAction` (cascades `price_targets`; leaves `prices` rows — they're shared/cheap and may serve a re-add) + a confirm control on the detail page. **Acceptance**: delete removes the item + its targets; net worth unchanged (it never counted); `/watchlist` no longer lists it.
  - *Skills*: `nextjs-app-router-patterns`.

### Batch 5 — Tests, docs, security/privacy pass, E2E

- **P11-20 — Unit test sweep (always-test surfaces).** Confirm coverage on the pure/critical surfaces: `paperValuation` (P11-09), `priceTargetAlerts` (P11-10), `fetchYahooDailySeries`/CoinGecko series parsing (P11-06/07), work-list union/dedup (P11-05), and the evaluator job idempotency (P11-11). **Acceptance**: all green; boundary cases (exact-equality target, missing price, watch-only) covered.
  - *Skills*: `test-driven-development`, `vitest`.
- **P11-21 — Privacy-regression test (mandatory).** Assert the price-target → `notifyNewAlerts` path produces an email body containing **no** symbol, threshold, price, or amount (only a count + link) — extend the existing ADR-015 privacy test. Assert the daily fetch egress for a watched symbol carries only the ticker (no qty/cost). **Acceptance**: test fails if any pretend/target figure appears in the rendered notification.
  - *Skills*: `backend-security-coder`, `secrets-management` (egress hygiene).
- **P11-22 — Security pass.** `frontend-security-coder` over the add/target forms (XSS on symbol/label/notes — escape on render, already React-default but verify no `dangerouslySetInnerHTML`); confirm all watchlist routes are `requireUser`-gated and scoped by id; confirm no `NEXT_PUBLIC_*` leakage and no new outbound host beyond Yahoo/CoinGecko. **Acceptance**: a written checklist in the PR; no finding open.
  - *Skills*: `frontend-security-coder`, `code-reviewer`.
- **P11-23 — Docs.** New `docs/WATCHLIST.md` (what it is, the net-worth-exclusion guarantee, the daily-not-realtime alert cadence + the deferred intraday Open Item, the content-free email reminder, the best-effort backfill caveat); link it from [FEATURE.md](FEATURE.md) and README. **Acceptance**: doc explains the one-shot target semantics + re-arm.
  - *Skills*: none specific.
- **P11-24 — E2E (one happy path).** Playwright: add a watchlist item with a pretend buy → it appears on `/watchlist` with a gain/loss → add an `above` target → (seed a price ≥ threshold + run the evaluator) → an alert appears on `/alerts` and the nav badge increments. Keep it to the single critical flow (CLAUDE.md §Testing Philosophy). **Acceptance**: spec passes headless in CI.
  - *Skills*: `e2e-testing-patterns`.

---

## Skills Map (Phase 11)

| Skill | Tasks | Why |
|---|---|---|
| `architecture-decision-records` | P11-00 | Lock ADR-025/026 in the established template. |
| `drizzle-orm-expert` | P11-01..05, 08, 11, 14 | Two tables, CHECK widening, FK cascade, partial index, migration. |
| `postgres-best-practices` | P11-02 | Index strategy for the active-target scan; CHECK conventions. |
| `typescript-pro` | P11-01, 09 | Inferred types, discriminated asset_class, Money-as-string discipline. |
| `zod-validation-expert` | P11-06, 07, 16, 18 | Validate upstream series at the boundary + every server-action input. |
| `bullmq-specialist` | P11-08, 11, 12 | Idempotent on-add backfill + chained daily evaluator; shutdown wiring. |
| `test-driven-development` / `vitest` | P11-05..11, 20 | Pure rule + valuation + parsers + job idempotency are crisp-I/O TDD wins. |
| `nextjs-app-router-patterns` | P11-13..19 | Server-first pages, server actions, typed routes, `revalidatePath`. |
| `tailwind-patterns` | P11-13, 15, 17 | List/detail layout + dark mode reusing existing tokens. |
| `frontend-security-coder` | P11-16, 22 | User-entered symbol/label/notes XSS surface. |
| `backend-security-coder` / `secrets-management` | P11-21 | Egress hygiene + content-free notification regression. |
| `code-reviewer` | P11-22 | End-of-phase structured pass. |
| `e2e-testing-patterns` | P11-24 | The single critical Playwright flow. |

---

## Open Items (deferred, with rationale)

- **Real-time / intraday price-target alerting** — the shipped cadence is once-daily after the nightly fetch (ADR-026). An env-gated higher-frequency poll loop (e.g. every N minutes during market hours) is the documented future path; deferred for rate-limit + privacy-simplicity reasons. Revisit only if asked.
- **Recurring / re-arming targets** — one-shot + manual re-arm ships; a "fire every time it crosses" toggle is a later cosmetic add if it earns it.
- **Multi-symbol "paper portfolio" with its own performance attribution** — out of scope (a watch item is a single pretend position, not a competing portfolio engine). Would be its own phase.
- **Backfill exactness for delisted / foreign / obscure symbols** — best-effort; partial/empty history is surfaced as "limited history," not retried aggressively.
- **Promote-to-holding flow** ("I actually bought it") — a convenience action to convert a watchlist item into a real holding could be added later; not requested in Round 5.

---

*End of PLAN11.md*
