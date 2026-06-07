# PLAN — Phase 5 (Investment Depth)

> Phase 4 made the *cash* side of the app self-driving: M&T checking/savings and the credit card auto-sync via Plaid. Phase 5 does the same for the *investment* side, and adds the analytics that make an investment tracker worth opening: **positions, cost basis, gain/loss, asset allocation, and dividend/interest income**.
>
> Two ingestion tracks, mirroring the cash side:
> 1. **Plaid Investments** for Fidelity brokerage (where the institution supports it) — pulls holdings, securities, and the buy/sell/dividend/interest transaction stream.
> 2. **Manual entry** for iTrust Capital (physical gold + crypto, no Plaid coverage) and Fidelity NetBenefits / 401k (patchy Plaid coverage). This already half-exists (the holdings form from Phase 1); Phase 5 adds **lot-level cost basis** entry.
>
> The headline deliverable is a dedicated **`/investments` dashboard**: every position across every investment/crypto_ira account, valued from cached prices, with cost basis and gain/loss, an asset-allocation donut, and an income breakdown.
>
> **Hard boundary (CLAUDE.md §Domain Scope):** gain/loss is a **simple display** of `value − cost_basis`. We are NOT building tax-lot accounting, wash-sale tracking, 1099 generation, or capital-gains reporting. Lots exist to make cost basis *more accurate*, not to drive a tax engine. If a future ask crosses that line, it needs a FEATURE.md update first.
>
> **Companion docs** — read for context, do not duplicate here:
> - [FEATURE.md](FEATURE.md) — "track value of stocks and minerals and crypto" (§investments)
> - [IDEAS.md](IDEAS.md) — §4.2 Fidelity, §4.3 iTrust, §5 market data, §9 Phase 5 scope, ADR-005 (charts), §11 Decision Log
> - [SKILLS.md](SKILLS.md) — Phase 5 skills map (`drizzle-orm-expert`, `typescript-pro`)
> - [PLAN0_1.md](PLAN0_1.md) — schema bedrock, holdings table, snapshot job, dashboard
> - [PLAN4.md](PLAN4.md) — Plaid infrastructure this phase extends (Items, tokens, webhook, sync worker, sync-runs) + its §Open Items, which seed this plan
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Money & Numeric Precision, §Plaid Safety Rules, §Schema Invariants, §Background Jobs, §Testing Philosophy

---

## What already exists (do not rebuild)

Phase 5 is mostly *additive* — it leans hard on infrastructure already shipped. Before writing code, inventory:

- **Holdings**: [src/db/schema/holdings.ts](../../src/db/schema/holdings.ts) — one row per `(account_id, symbol)`, with `quantity NUMERIC(28,8)`, `asset_class` (discriminated enum), `quantity_unit`, and a nullable aggregate `cost_basis`. Phase 5 **extends** this (security FK, source, cost-basis watermark) and adds a `holding_lots` child table.
- **Valuation**: [src/lib/holdings/value.ts](../../src/lib/holdings/value.ts) already prices a holding as `quantity × latestCloseOnOrBefore(symbol, asOf)`, with `cash`/`property` as face value. **Plaid-synced holdings get valued for free** the moment their ticker lands in `prices`. Phase 5 adds cost-basis/gain-loss on top — it does not touch the valuation primitive.
- **Prices pipeline**: [src/lib/prices/store.ts](../../src/lib/prices/store.ts) (`upsertPrice`, `distinctHeldSymbols`, `latestCloseOnOrBefore`), [src/lib/prices/router.ts](../../src/lib/prices/router.ts) (equity→Yahoo, crypto→CoinGecko, metal→Yahoo metals), [src/worker/jobs/fetch-prices-daily.ts](../../src/worker/jobs/fetch-prices-daily.ts). Phase 5 writes Plaid's `institution_price` into `prices` for securities with no public ticker, and teaches the daily fetcher to skip synthetic symbols.
- **Snapshots**: [src/worker/jobs/compute-snapshots-daily.ts](../../src/worker/jobs/compute-snapshots-daily.ts) already values `investment` and `crypto_ira` accounts via `valueAccountHoldings`. **No change needed** — once Plaid holdings exist + are priced, they flow into snapshots and the net-worth chart automatically.
- **Plaid plumbing (Phase 4)**: `plaid_items` ([src/db/schema/plaid-items.ts](../../src/db/schema/plaid-items.ts)) with `products_consented text[]`, encrypted token store ([src/lib/plaid/tokens.ts](../../src/lib/plaid/tokens.ts)), webhook verifier + route ([src/app/api/plaid/webhook/route.ts](../../src/app/api/plaid/webhook/route.ts)), sync worker pattern ([src/worker/jobs/sync-plaid-item.ts](../../src/worker/jobs/sync-plaid-item.ts)), `plaid_sync_runs`, Link UI + mapping flow ([src/app/settings/connections/](../../src/app/settings/connections/)). Phase 5 adds an `investments` product path **alongside** the existing `transactions` path — same Items table, same webhook route, same sync-runs ledger.
- **Plaid txn mapper**: [src/lib/plaid/map.ts](../../src/lib/plaid/map.ts) — the sign-flip + field-mapping idiom (`Money.negate()`, never `Number()`) is the template for the new investment-transaction mapper.
- **Charts**: [src/app/net-worth-chart.tsx](../../src/app/net-worth-chart.tsx) — the Recharts `'use client'` island pattern (ADR-005). The allocation donut and income bar chart follow it exactly.
- **Money helpers**: [src/lib/money/money.ts](../../src/lib/money/money.ts) + `decimal.js`. All cost-basis/gain-loss math goes through these. **Percentages are computed with `Decimal` and rendered at the display boundary only.**
- **Forms idiom**: [src/app/accounts/[id]/holding-form.tsx](../../src/app/accounts/%5Bid%5D/holding-form.tsx) + [src/app/accounts/[id]/actions.ts](../../src/app/accounts/%5Bid%5D/actions.ts) + zod schemas in [src/lib/schemas/account.ts](../../src/lib/schemas/account.ts) — the `useActionState` + server-action + zod-validation pattern the lot-entry UI copies.

---

## ADRs locked at plan time

Three decisions surface in Phase 5. All three are ✅ locked below; after this plan is approved, append them to [IDEAS.md](IDEAS.md) §11 Decision Log.

---

### ADR-011 — Plaid Investments: product scope & sync model

**Status**: ✅ Locked 2026-06-06

**Context**:
IDEAS.md §4.2 recommends Plaid Investments for the Fidelity *brokerage* (manual for 401k/NetBenefits). PLAN4 ADR-008 deliberately scoped Phase 4 to `transactions` only and deferred Investments here. Plaid's Investments product is a different shape from Transactions:
- It has **no `/transactions/sync` cursor endpoint**. Holdings come from `/investments/holdings/get` (a full current-state snapshot, re-fetched each time). The transaction stream comes from `/investments/transactions/get` (date-range + `offset`/`count` pagination, deduped by `investment_transaction_id`).
- Its webhooks are `HOLDINGS: DEFAULT_UPDATE` and `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE` / `HISTORICAL_UPDATE` — not the `TRANSACTIONS: SYNC_UPDATES_AVAILABLE` the Phase 4 route handles.

**Decision**:
1. **A separate Plaid Item for Fidelity** with `products: ['investments']`. It does **not** consent to `transactions` — Fidelity brokerage cash movements we care about arrive as investment transactions (buys/sells/dividends/interest), not as a checking-style ledger.
2. **Products-based sync routing.** `plaid_items.products_consented` (already a `text[]`, no migration) is the dispatcher. The webhook route enqueues `sync-plaid-item` for `TRANSACTIONS` webhooks and a new `sync-investments-item` for `HOLDINGS`/`INVESTMENTS_TRANSACTIONS` webhooks. An Item only runs the sync paths for products it consented to — so the Fidelity Item never hits `/transactions/sync` (which would error without the product).
3. **Holdings = full-snapshot upsert; transactions = incremental by id.** Each holdings sync replaces the current position set for the Item's accounts (upsert by `(account_id, symbol)`, plus a reconcile for positions that disappeared). Each transactions sync pages through `/investments/transactions/get` over the last 24 months on initial run, then incrementally on webhook, deduping on `investment_transaction_id`.
4. **One `sync-investments-item` job per Item per trigger** (CLAUDE.md §Background Jobs — one job per logical unit of work). Reuses the `plaid_sync_runs` ledger and the daily safety-net cron from Phase 4.

**Consequences**:
- ✅ Zero new Plaid cost — one more Item, still inside the 100-free ceiling (now three Items: M&T, credit card, Fidelity).
- ✅ The webhook receiver, idempotency table, token store, and sync-runs ledger are all reused unchanged. Phase 5 adds a sibling worker, not a parallel universe.
- ✅ The existing nightly valuation + snapshot pipeline picks up Plaid holdings automatically once their tickers are in `prices`.
- ⚠️ Holdings-snapshot semantics differ from the cash cursor model: a sold-out position must be *removed* on the next holdings sync, not left stale. Handled explicitly in P5-16 (reconcile-missing).
- ⚠️ Sandbox Investments fixtures are limited; cost basis is frequently absent in both sandbox and production (IDEAS.md §4.2: "cost basis sometimes thin"). Lot construction is best-effort, manual entry is the always-available fallback.
- ⚠️ Fidelity 401k / NetBenefits coverage is patchy (IDEAS.md §4.2). Those accounts stay **manual** in Phase 5 — no attempt to force Plaid coverage.

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Add `investments` to the existing M&T/credit Items | Wrong institution; Items are per-institution (ADR-008). Fidelity is its own Item. |
| SnapTrade for Fidelity (IDEAS.md §4.2) | Better lot data, but a second aggregator integration + a recurring fee for one account. Plaid is already wired; revisit only if Plaid cost basis proves unusable. Logged in §Open Items. |
| Treat investment transactions as rows in the existing `transactions` table | Different shape (security_id, quantity, price, fees, type/subtype). Forcing them in pollutes the cash ledger and the categorizer. Separate table (ADR-012). |
| Use `/investments/transactions/get` as the source of *holdings* (derive positions) | Plaid explicitly provides `/investments/holdings/get` as the authoritative current state; deriving is error-prone. Use the snapshot endpoint. |

---

### ADR-012 — Investment schema: `securities`, `holding_lots`, `investment_transactions` + additive `holdings` columns

**Status**: ✅ Locked 2026-06-06

**Context**:
Phase 1's `holdings` table is a flat "current position" row (one per account+symbol, one aggregate cost basis). Phase 5 needs three things it can't express:
1. **Security metadata** — Plaid returns a `security_id` per holding; we need to map it to a ticker (for the existing price pipeline) and keep its name/type/cusip. Many securities have no public ticker (proprietary funds, 401k options) and must still be valued.
2. **Lot-level cost basis** — a position is acquired in lots over time; accurate gain/loss wants per-lot basis, not one blended number. Optional (IRA gold has none).
3. **The investment transaction stream** — buys/sells/dividends/interest/fees, which feed both lot construction and the income breakdown.

**Decision** — `holdings` stays the canonical *current position*; three new tables hang off it:

- **`securities`** — Plaid security metadata + canonical-symbol resolution. One row per distinct security. `(account, symbol)` on `holdings` still identifies the position; `securities` enriches it. Canonical `symbol` resolution at the mapping boundary: `ticker_symbol` → `cusip` → `SEC:<plaid_security_id>` (a stable synthetic). Holdings whose symbol resolves to a synthetic are valued from Plaid's `institution_price` (written into `prices` with `source='plaid'`), not from Yahoo.
- **`holding_lots`** — optional per-lot basis, child of `holdings` (`onDelete: cascade`). When lots exist for a holding, `holdings.cost_basis` is *derived* (sum of lot basis); when none exist, the aggregate `cost_basis` is used directly. Lots are created manually (P5-18) or from Plaid buy transactions (P5-14), deduped via `plaid_investment_transaction_id`.
- **`investment_transactions`** — buys/sells/cash/fees/transfers, child of `accounts`. Deduped on `(account_id, plaid_investment_transaction_id)`. Sign convention flipped to match the rest of the app (positive = cash inflow), same as [src/lib/plaid/map.ts](../../src/lib/plaid/map.ts). Subtype `dividend`/`interest` rows feed the income breakdown.

- **Additive `holdings` columns** (all nullable / defaulted — manual holdings unaffected):
  - `security_id uuid` FK → `securities.id` (`onDelete: set null`).
  - `source text NOT NULL DEFAULT 'manual'` + CHECK `in ('manual','plaid')` — so a Plaid holdings sync never clobbers a manually-curated position's metadata blindly.
  - `cost_basis_overridden_at timestamptz` — sticky-manual-cost-basis watermark, mirroring `transactions.category_overridden_at`. A Plaid sync that returns no/low-confidence cost basis must **not** overwrite a user-entered basis.

**Cost-basis precedence** (single source of truth, encoded in `src/lib/investments/lots.ts`, P5-07):
`sum(holding_lots.cost_basis_total)` if any lots → else `holdings.cost_basis` (manual or Plaid-aggregate) → else `null` (unknown; gain/loss renders "—").

**Consequences**:
- ✅ Each new table is one domain concept in one file (CLAUDE.md §Database & Drizzle Specifics).
- ✅ Manual holdings keep working untouched; `source='manual'` + the override watermark protect user data from sync.
- ✅ Securities-without-tickers are valued, so 401k/proprietary funds don't show $0.
- ✅ Gain/loss is `value − resolved_cost_basis` — a pure display number, no tax-lot machinery (domain boundary held).
- ⚠️ Lot/aggregate reconciliation can disagree with `holdings.quantity` (e.g., Plaid holding qty ≠ sum of lots when history is incomplete). We surface the discrepancy in the UI (a small "lots cover N of M shares" note) rather than silently trusting either — same philosophy as the import reconciliation banner.
- ⚠️ `NUMERIC` everywhere money/quantity-shaped (CLAUDE.md §Money): `quantity NUMERIC(28,8)`, `price NUMERIC(18,8)`, `amount`/`cost_basis NUMERIC(18,2)`. No floats.

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Put lots inline as a `jsonb` array on `holdings` | Can't query/aggregate income or reconcile per-lot in SQL; loses dedup-on-id. |
| Reuse `transactions` for investment transactions | Shape mismatch (see ADR-011); categorizer pollution. |
| Make lots mandatory | IRA gold and many holdings have no lot history; mandatory lots block manual entry. Optional with precedence rule is honest. |
| Store `cost_basis` per-unit instead of per-lot-total | Per-unit re-introduces float-division rounding; total basis + qty lets us compute per-unit at the display boundary precisely. |

---

### ADR-013 — Asset-allocation chart: Recharts donut now; cash-flow Sankey deferred

**Status**: ✅ Locked 2026-06-06

**Context**:
IDEAS.md §9 Phase 5 lists "Asset allocation pie/sankey chart," and ADR-005 noted "Sankey deferred to Phase 5 (may pull in `@nivo/sankey` then)." Two distinct visualizations are conflated in that line:
- **Asset allocation** — "what fraction of my portfolio is equity vs. crypto vs. metal vs. cash" → a part-of-whole chart → a **pie/donut**.
- **Sankey** — naturally a *flow* diagram (income → categories → expenses, or account → account transfers). It is a cash-flow visualization, not an allocation one.

**Decision**:
1. **Ship asset allocation as a Recharts donut** (`PieChart` + `Pie`, `innerRadius` set), a `'use client'` island per ADR-005. **Zero new dependency** — Recharts is already in `package.json`.
2. **Defer the Sankey** (cash-flow flow diagram) out of Phase 5. It is not required to "show positions, cost basis, gain/loss, asset mix" (the Phase 5 demo state). When we do build it (a cash-flow feature, more Phase 6-flavored), we revisit `@nivo/sankey` vs. a hand-rolled SVG then.

**Consequences**:
- ✅ No new chart dependency; the allocation deliverable ships with the library we already vet.
- ✅ Keeps Phase 5 focused on *investment depth*; a cash-flow Sankey is a different feature with its own data plumbing (income/expense categorization over time).
- ⚠️ Re-defers an IDEAS.md line item; logged explicitly in §Open Items so it isn't lost. This resolves the ADR-005 "Sankey deferred to Phase 5" note by re-deferring with rationale.

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Add `@nivo/sankey` now and build both | Sankey for *allocation* is the wrong viz; a flow diagram for a part-of-whole relationship misleads. New dep for no Phase-5 deliverable. |
| Build allocation as a stacked bar | A donut reads "share of whole" faster for ≤6 asset classes; bar is better for time-series, which the net-worth line already covers. |

---

## Phase 5 — Goal

After Phase 5 ships:

1. The user opens `/settings/connections`, clicks **"Connect investment institution"**, completes Plaid Link for Fidelity (Sandbox in dev), and maps the returned brokerage accounts to existing manual Fidelity accounts (or auto-creates them as `type='investment'`).
2. An initial sync pulls current **holdings** (positions + securities) and up to 24 months of **investment transactions** (buys/sells/dividends/interest/fees). Holdings land in `holdings` (with `security_id`, `source='plaid'`); tickered securities are priced by the existing daily Yahoo fetch; non-tickered ones are valued from Plaid's `institution_price`.
3. The **`/investments` page** shows every position across all investment/crypto_ira accounts: symbol, name, quantity, latest price, value, cost basis, and **gain/loss in $ and %** — with an **asset-allocation donut** and portfolio totals at the top.
4. A **dividend/interest income breakdown** view aggregates investment-transaction income by month/quarter/year.
5. For **iTrust** (gold + crypto) and **Fidelity 401k/NetBenefits**, the user enters holdings manually (as today) and can optionally record **cost-basis lots** for accurate gain/loss; a quarterly-update hint nudges the cadence (IDEAS.md §1 effort budget).
6. When Fidelity posts a trade or dividend, a `HOLDINGS`/`INVESTMENTS_TRANSACTIONS` webhook arrives, is verified + deduped by the **existing** Phase 4 receiver, and enqueues `sync-investments-item`; the position and income views reflect it on next render.
7. The net-worth chart and snapshots already reflect investment value (no change) — Phase 5 adds the *depth* (basis, gain/loss, allocation, income) on top.

**Not in Phase 5** (held by CLAUDE.md §Domain Scope): tax-lot selection (FIFO/LIFO/specific-ID), wash sales, realized vs. unrealized capital-gains reports, 1099 generation, dividend reinvestment optimization. Gain/loss is a single display number.

---

## Phase 5 — Schema (new tables + holdings extensions)

All follow CLAUDE.md §Database & Drizzle Specifics: UUID PKs, `numeric` for money/quantity, `timestamp({ withTimezone: true })`, `jsonb` for raw payloads, one file per concept under [src/db/schema/](../../src/db/schema/), re-exported from [index.ts](../../src/db/schema/index.ts).

```text
src/db/schema/
├── securities.ts              (NEW)
├── holding-lots.ts            (NEW)
├── investment-transactions.ts (NEW)
├── holdings.ts                (UPDATED: security_id, source, cost_basis_overridden_at)
└── index.ts                   (UPDATED: re-export the three new)
```

### `securities` (Plaid security metadata + canonical-symbol map)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `defaultRandom()` |
| `plaid_security_id` | `text` UNIQUE | Plaid's `security_id`. Nullable for manually-created securities (rare). |
| `symbol` | `text` NOT NULL | Canonical symbol used to join `prices`/`holdings`: `ticker_symbol` → `cusip` → `SEC:<plaid_security_id>`. |
| `ticker_symbol` | `text` | Plaid `ticker_symbol`, may be null. |
| `cusip` | `text` | Optional identifier. |
| `name` | `text` NOT NULL | Display name. |
| `type` | `text` | Plaid security `type` (`equity`, `etf`, `mutual fund`, `cash`, `fixed income`, `derivative`, `other`). Informational. |
| `is_cash_equivalent` | `boolean` NOT NULL DEFAULT false | Plaid flag — money-market sweeps etc. |
| `iso_currency_code` | `text` NOT NULL DEFAULT `'USD'` | |
| `raw` | `jsonb` | Full Plaid security payload for re-derivation. |
| `created_at` / `updated_at` | `timestamptz` | |

**Index**: `CREATE UNIQUE INDEX securities_plaid_security_id_unique ON securities (plaid_security_id) WHERE plaid_security_id IS NOT NULL;` (partial — manual securities have NULL).

### `holding_lots` (optional per-lot cost basis)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `holding_id` | `uuid` FK → holdings `onDelete: cascade` NOT NULL | Lots die with their position. |
| `acquired_at` | `date` (`mode: 'string'`) | Nullable — acquisition date unknown for some. |
| `quantity` | `numeric(28,8)` NOT NULL | Shares/coins/oz in this lot. |
| `cost_basis_total` | `numeric(18,2)` NOT NULL | Total $ basis for this lot (per-unit derived at display via `Money`). |
| `source` | `text` NOT NULL DEFAULT `'manual'` | CHECK `in ('manual','plaid')`. |
| `plaid_investment_transaction_id` | `text` | The buy that created a Plaid-derived lot; dedup key. |
| `note` | `text` | Optional user note. |
| `created_at` / `updated_at` | `timestamptz` | |

**Index**: `CREATE UNIQUE INDEX holding_lots_holding_plaid_txn_unique ON holding_lots (holding_id, plaid_investment_transaction_id) WHERE plaid_investment_transaction_id IS NOT NULL;`

### `investment_transactions` (buy/sell/cash/fee stream)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `account_id` | `uuid` FK → accounts `onDelete: cascade` NOT NULL | |
| `security_id` | `uuid` FK → securities `onDelete: set null` | Nullable — pure-cash transactions have none. |
| `plaid_investment_transaction_id` | `text` | Plaid id; dedup key (NULL for manual). |
| `type` | `text` NOT NULL | CHECK `in ('buy','sell','cash','fee','transfer','cancel')` (Plaid investment_transaction `type`). |
| `subtype` | `text` | Plaid `subtype` (`dividend`, `interest`, `deposit`, `withdrawal`, …). Drives the income breakdown. |
| `trade_date` | `date` (`mode: 'string'`) NOT NULL | Plaid `date`. |
| `quantity` | `numeric(28,8)` | Nullable — cash rows have none. |
| `price` | `numeric(18,8)` | Per-unit price; nullable. |
| `fees` | `numeric(18,2)` | Nullable. |
| `amount` | `numeric(18,2)` NOT NULL | **Signed, our convention (positive = cash inflow)** — flipped from Plaid at the mapper boundary. |
| `name` | `text` | Plaid `name`. |
| `iso_currency_code` | `text` NOT NULL DEFAULT `'USD'` | |
| `source` | `text` NOT NULL | CHECK `in ('plaid','manual')`. |
| `raw` | `jsonb` | Full Plaid payload. |
| `created_at` | `timestamptz` | |

**Indexes**:
```sql
CREATE UNIQUE INDEX investment_txns_account_plaid_id_unique
  ON investment_transactions (account_id, plaid_investment_transaction_id)
  WHERE plaid_investment_transaction_id IS NOT NULL;
CREATE INDEX investment_txns_account_trade_date_idx
  ON investment_transactions (account_id, trade_date DESC);
CREATE INDEX investment_txns_subtype_idx
  ON investment_transactions (subtype) WHERE subtype IS NOT NULL;
```

### `holdings` extensions

Add three columns; additive, manual rows unaffected:

| Column | Type | Notes |
|---|---|---|
| `security_id` | `uuid` FK → securities `onDelete: set null` | Links a position to its security metadata. NULL for hand-typed symbols with no security row. |
| `source` | `text` NOT NULL DEFAULT `'manual'` | CHECK `in ('manual','plaid')`. |
| `cost_basis_overridden_at` | `timestamptz` | Sticky-manual watermark; Plaid sync skips cost-basis overwrite when set. |

### No new enums

Same posture as PLAN4 (`plaid_items.status`) and PLAN3 (`category_rules.field`): `holdings.source`, `holding_lots.source`, `investment_transactions.type`/`source` are plain `text` + CHECK constraints, not `pgEnum`. We expect to add transaction types (`transfer` subtypes) over time; dropping a CHECK is lighter than an enum-add migration. (`asset_class`, `quantity_unit`, `account_type` remain `pgEnum` — they're stable and already shipped.)

### Migration order

1. `CREATE TABLE securities`.
2. `CREATE TABLE holding_lots` (FK → holdings, which already exists).
3. `CREATE TABLE investment_transactions` (FK → accounts, securities).
4. `ALTER TABLE holdings ADD COLUMN security_id uuid REFERENCES securities(id) ON DELETE SET NULL`, `ADD COLUMN source text NOT NULL DEFAULT 'manual'`, `ADD COLUMN cost_basis_overridden_at timestamptz`; add the `source` CHECK.

---

## Phase 5 — Tasks

Each task is shippable in isolation, has explicit verification, and follows CLAUDE.md conventions. Order matters where flagged. Always-test surfaces (CLAUDE.md §Testing Philosophy) — cost-basis/gain-loss math, lot aggregation, Plaid investment mappers, sync idempotency — get Vitest without asking.

### Schema + migrations

- [x] **P5-01** — Add `securities` schema. Create [src/db/schema/securities.ts](../../src/db/schema/securities.ts) per the spec; `raw` is `jsonb`; partial UNIQUE on `plaid_security_id`. Re-export from [index.ts](../../src/db/schema/index.ts). Run `pnpm db:generate`. → **Verify**: migration applies; the partial unique index exists; inserting two rows with NULL `plaid_security_id` succeeds (verified — both inserted). *(Used `drizzle-orm-expert` + `postgres-best-practices`: `schema-data-types` confirms `text`/`timestamptz`/`numeric`, `query-partial-indexes` for the NULL-tolerant unique.)*
- [x] **P5-02** — Add `holding_lots` schema. Create [src/db/schema/holding-lots.ts](../../src/db/schema/holding-lots.ts); FK to holdings `onDelete: cascade`; partial unique `(holding_id, plaid_investment_transaction_id)`. Added an explicit `holding_lots_holding_id_idx` FK index (`postgres-best-practices: schema-foreign-key-indexes` — Postgres does not auto-index FKs). → **Verify**: migration applied; FK index + partial unique present in `0009_purple_tenebrous.sql`.
- [x] **P5-03** — Add `investment_transactions` schema. Create [src/db/schema/investment-transactions.ts](../../src/db/schema/investment-transactions.ts) with the four indexes (account+trade_date, security_id FK index, partial subtype, partial unique plaid id) + the `type`/`source` CHECKs. → **Verify**: inserting a row with `type='bogus'` fails with `23514 investment_txns_type_check` (verified live).
- [x] **P5-04** — Extend `holdings` with `security_id`, `source`, `cost_basis_overridden_at` + FK index + source CHECK ([src/db/schema/holdings.ts](../../src/db/schema/holdings.ts)). → **Verify**: diff is `ADD COLUMN`-only; `source` lands `NOT NULL DEFAULT 'manual'`, the other two nullable (verified via `information_schema.columns`); `pnpm exec drizzle-kit check` → "Everything's fine".
- [x] **P5-05** — Apply as one ordered migration set (`drizzle/0009_purple_tenebrous.sql` — repo was already at 0008, not 0004). → **Verify**: `pnpm db:migrate` green; live DB lists `securities`, `holding_lots`, `investment_transactions` + the three new `holdings` columns. *(Applied incrementally, not `db-reset`, to preserve existing data.)*

### Domain logic (TDD — pure functions, money-precise)

- [x] **P5-06** — Gain/loss helpers. Created [src/lib/investments/gain-loss.ts](../../src/lib/investments/gain-loss.ts): `gainLoss({ value, costBasis }): { absolute: Money | null; percent: string | null }` + `portfolioGainLoss(positions, currency)`. Returns `null`s when basis is unknown; percent via `Decimal` (2dp, banker's rounding); zero-basis → percent null (no divide-by-zero); portfolio gain/loss computed over the basis-known subset (unknown-basis positions don't distort it). → **Verify**: [gain-loss.test.ts](../../src/lib/investments/gain-loss.test.ts) — 10 tests: pos/neg/zero gain, null basis, zero basis, percent rounding (3233.33%), currency-mismatch throws, portfolio mixed/all-null/empty. **No floats.** TDD: tests written first, watched fail (module-missing), then implemented.
- [x] **P5-07** — Lot aggregation + cost-basis precedence. Created [src/lib/investments/lots.ts](../../src/lib/investments/lots.ts): `aggregateLots(lots, currency): { totalQuantity: string; totalCostBasis: Money }`, `resolveCostBasis(holding, lots, currency): Money | null` (ADR-012 precedence: lots → holding.cost_basis → null), `lotCoverage(holding, lots)` for the UI discrepancy note. *(Returns `totalQuantity` as a trimmed Decimal string rather than a raw `Decimal` — cleaner for the string-end-to-end convention; deviation from plan signature noted.)* → **Verify**: [lots.test.ts](../../src/lib/investments/lots.test.ts) — 9 tests: sum, fractional no-drift, precedence (lots win), aggregate fallback, null, coverage complete/incomplete/empty.
- [x] **P5-08** — Allocation computation. Created [src/lib/investments/allocation.ts](../../src/lib/investments/allocation.ts): `allocationByAssetClass(valued, currency)` + `allocationByAccount(valued, currency, nameByAccountId?)` over a local `ValuedHolding` shape (decoupled from the server-only valuation module). Percent via `Decimal`; remainder pushed onto the largest slice so percents sum to exactly 100.00; zero-value classes excluded; zero total → []. → **Verify**: [allocation.test.ts](../../src/lib/investments/allocation.test.ts) — 7 tests: grouping/ordering, same-class sum, 33.34/33.33/33.33 remainder balancing, zero-value exclusion, empty, by-account name resolution + id fallback.
- [x] **P5-09** — Income breakdown computation. Created [src/lib/investments/income.ts](../../src/lib/investments/income.ts): `incomeByPeriod(txns, period: 'month'|'quarter'|'year', currency): IncomePoint[]` summing rows where `subtype IN ('dividend','interest')`, split dividend vs. interest, Money-summed. Period keys derived by slicing the `YYYY-MM-DD` string (no Date parse → no timezone ambiguity). → **Verify**: [income.test.ts](../../src/lib/investments/income.test.ts) — 4 tests: month grouping + ignores buys/fees, quarter grouping, year grouping + ascending sort, empty/non-income → empty.

### Plaid Investments — client, mappers, securities

- [x] **P5-10** — Multi-product Link. Extended `createLinkTokenAction` ([src/app/settings/connections/actions.ts](../../src/app/settings/connections/actions.ts)) with a zod-validated `products: ('transactions'|'investments')[]` option (default `['transactions']`; ignored in update mode); added a `PlaidProduct` type + `plaidProductsSchema` + `toPlaidProduct` enum mapper. `exchangePublicTokenAction(publicToken, products?)` now validates and persists `products_consented` from what was requested (was hard-coded `['transactions']`). [link-button.tsx](../../src/app/settings/connections/link-button.tsx) threads a `products` prop into both calls; the connections page ([page.tsx](../../src/app/settings/connections/page.tsx)) renders a second **"Connect investment institution"** CTA requesting `['investments']`. → **Verify**: [actions.test.ts](../../src/app/settings/connections/actions.test.ts) — 6 new tests (TDD, RED→GREEN): link-token requests `['investments']` / defaults to `['transactions']` / rejects unknown product without calling Plaid; exchange records `products_consented=['investments']` / defaults to `['transactions']` / rejects unknown product and persists nothing. Full suite 287 passed; `pnpm check` clean. *(Skills: `nextjs-app-router-patterns` server-action shape, `plaid-fintech` products/consent model + ADR-011, `zod-validation-expert` boundary validation.)*
- [x] **P5-11** — Securities mapper. Created [src/lib/plaid/securities.ts](../../src/lib/plaid/securities.ts): `resolveSymbol` (ticker → cusip → `SEC:<id>`), pure `mapSecurity → NewSecurity`, and `upsertSecurity(plaidSecurity, txOrDb?)` (upsert by `plaid_security_id`, `targetWhere` matches the partial unique index). → **Verify**: [securities.test.ts](../../src/lib/plaid/securities.test.ts) — 7 tests: symbol precedence (ticker / cusip / synthetic), field mapping, name-falls-back-to-symbol, currency/`is_cash_equivalent` null coercion, DB upsert idempotency (insert→update, one row, same id).
- [x] **P5-12** — Holdings mapper. Created [src/lib/plaid/investments-map.ts](../../src/lib/plaid/investments-map.ts): `plaidHoldingToHolding(h, security, accountId): NewHolding` — `classify()` maps Plaid security type → our `asset_class`/`quantity_unit` (cryptocurrency→crypto/coin, cash or cash-equivalent→cash/usd, else equity/shares), `source='plaid'`, cost basis via `toFixed(2)` boundary; plus `institutionPriceQuote(h, security, now?)` returning a `PriceQuote` only for non-tickered (synthetic) securities (tickered ones are Yahoo-priced). Cost-basis-overwrite skipping is enforced by the **caller** (P5-16), not the pure mapper. → **Verify**: [investments-map.test.ts](../../src/lib/plaid/investments-map.test.ts) — asset-class table, cash detection, null cost basis, synthetic-vs-tickered price routing + today-date fallback.
- [x] **P5-13** — Investment-transaction mapper. In [investments-map.ts](../../src/lib/plaid/investments-map.ts): `plaidInvestmentTxnToRow(t, accountId, securityId): NewInvestmentTransaction`. **Sign flip** of `amount` via `Money.negate()` (same idiom as [map.ts](../../src/lib/plaid/map.ts)); maps `type`/`subtype`/`quantity`/`price`/`fees`/`tradeDate` (sliced + validated), `source='plaid'`, `raw=t`. → **Verify**: tests — dividend (Plaid-negative)→positive inflow, buy (Plaid-positive)→negative outflow + qty/price/fees, currency default, null security tolerated.
- [x] **P5-14** — Lot construction from buys. Added `lotFromBuy(txn, holdingId): NewHoldingLot | null` + `BuyTxnInput` to [src/lib/investments/lots.ts](../../src/lib/investments/lots.ts) — a `type='buy'` row with usable quantity becomes a lot (`cost_basis_total = |amount|` via `Money`, `acquired_at = tradeDate`, `plaid_investment_transaction_id` for dedup, `source='plaid'`); non-buy / null-or-zero-quantity → `null`. → **Verify**: [lots.test.ts](../../src/lib/investments/lots.test.ts) — buy→lot with correct basis + dedup id, sell/cash/fee→null, null/zero quantity→null.

### Sync worker + webhook routing

- [x] **P5-15** — Products-based webhook routing. In [src/app/api/plaid/webhook/route.ts](../../src/app/api/plaid/webhook/route.ts), added `syncTargetFor(webhookType, productsConsented)`: `TRANSACTIONS`→transactions sync; `HOLDINGS`/`INVESTMENTS_TRANSACTIONS`→investments sync; `ITEM`→the sync matching the Item's product; else→null (no enqueue). The item lookup now selects `products_consented`. Verification/idempotency/`webhook_log`/status-mapping paths are **unchanged**. → **Verify**: [route.test.ts](../../src/app/api/plaid/webhook/route.test.ts) — new test: a `HOLDINGS/DEFAULT_UPDATE` (valid signature) enqueues `sync-investments-item` (not the transactions queue) + logs a `webhook_log` row; all 12 prior route tests still green.
- [x] **P5-16** — `sync-investments-item` worker. Added `SYNC_INVESTMENTS_ITEM` queue ([queues.ts](../../src/lib/queue/queues.ts)) + worker registration/shutdown ([index.ts](../../src/worker/index.ts)). Created [src/worker/jobs/sync-investments-item.ts](../../src/worker/jobs/sync-investments-item.ts): guards non-investments Items; opens a `plaid_sync_runs` row; `/investments/holdings/get` → `upsertSecurity` + `plaidHoldingToHolding` UPSERT on `(account_id, symbol)` with a `CASE` that **preserves cost basis when `cost_basis_overridden_at IS NOT NULL`**; writes `institution_price` to `prices` for synthetic securities; **reconciles sold-out** `source='plaid'` positions (manual untouched); `/investments/transactions/get` paginated by offset over a 24-month window → `plaidInvestmentTxnToRow` INSERT…DO NOTHING + `lotFromBuy` for buys; all writes in one tx; post-commit snapshot of affected accounts via `valueAccountHoldings`. Idempotent (full-snapshot + dedup indexes). → **Verify**: [sync-investments-item.test.ts](../../src/worker/jobs/sync-investments-item.test.ts) (stubbed Plaid client) — 5 tests: holdings/security upsert, sold-out reconcile (plaid gone, manual kept), txn dedup + buy→lot + idempotent re-run, manual-cost-basis preservation, non-investments-Item no-op.
- [x] **P5-17** — Initial backfill + safety-net. [map-actions.ts](../../src/app/settings/connections/map-actions.ts) now selects `products_consented` and enqueues `sync-investments-item` (`trigger='initial'`) for investment Items, else `sync-plaid-item` — the progress page polls generically, no change. [enqueue-plaid-syncs-daily.ts](../../src/worker/jobs/enqueue-plaid-syncs-daily.ts) fans out the sync matching each active Item's products (investments and/or transactions). → **Verify**: existing `enqueue-plaid-syncs-daily.test.ts` + `actions.test.ts` still green; live multi-page backfill is operator-verified against Sandbox.

### Manual entry enhancements (iTrust + 401k)

- [x] **P5-18** — Lot entry UI + actions. Added `addLotAction` + `deleteLotAction` to [src/app/accounts/[id]/actions.ts](../../src/app/accounts/%5Bid%5D/actions.ts) (gated by `requireUser`, holding-ownership checked, zod-validated via `upsertLotSchema` in [src/lib/schemas/account.ts](../../src/lib/schemas/account.ts)); adding a lot stamps `cost_basis_overridden_at` so a later Plaid sync won't clobber the user's basis (lots already win in `resolveCostBasis`; the watermark is the sync guard). New client editor [lot-form.tsx](../../src/app/accounts/%5Bid%5D/lot-form.tsx) (`LotsEditor`, a `<details>` per holding: lot table with per-unit + delete, plus an Add-lot form via `useActionState`) wired into [page.tsx](../../src/app/accounts/%5Bid%5D/page.tsx); lots loaded via new `listLots` query ([queries.ts](../../src/lib/accounts/queries.ts)). *(Implemented add + delete; "edit" = delete-then-add, sufficient for the verify.)* → **Verify**: [actions.test.ts](../../src/app/accounts/%5Bid%5D/actions.test.ts) — 4 tests: add inserts a lot + stamps `cost_basis_overridden_at`, rejects bad holding id / bad quantity without writing, delete removes the lot. Sync-survival covered by P5-16's manual-cost-basis test.
- [x] **P5-19** — Holdings table polish. [page.tsx](../../src/app/accounts/%5Bid%5D/page.tsx) now computes per-holding **resolved cost basis** (lots-aware, P5-07), **gain/loss** ($ + %, color-coded, P5-06), and a "lots cover N of M shares" coverage note (amber `*` on the basis cell). Gain/loss only renders once a price/face value is known (avoids a misleading −100%). Added a "Last updated {date} — review quarterly" hint on holdings accounts. The aggregate cost-basis column falls back when no lots exist. → **Verify**: covered by the helper unit tests (resolveCostBasis precedence, lotCoverage, gainLoss) + `pnpm check` (tsc) on the page; live render is operator-verified.

### Valuation integration

- [x] **P5-20** — Price-fetch + valuation wiring. Filtered `distinctHeldSymbols` ([src/lib/prices/store.ts](../../src/lib/prices/store.ts)) in SQL with `notLike(holdings.symbol, 'SEC:%')` so synthetic Plaid securities never reach the Yahoo fetcher (they're priced from `institution_price`, written by P5-16). Only used by the daily fetcher ([fetch-prices-daily.ts](../../src/worker/jobs/fetch-prices-daily.ts)), so no caller is surprised. `valueHolding` + the snapshot job are **unchanged** — they read `prices` by symbol regardless of source, so a `SEC:` row written by the sync values fine. → **Verify**: [store.test.ts](../../src/lib/prices/store.test.ts) — new test: a `SEC:…` holding is excluded from the work list while `AAPL` remains (TDD RED→GREEN). Full suite 318 passed; `pnpm check` clean.

### Investments dashboard + charts

- [x] **P5-21** — `/investments` positions page. Created [src/app/investments/page.tsx](../../src/app/investments/page.tsx) (server component, `requireUser`): values every holding across `investment` + `crypto_ira` accounts via `valueHolding`, resolves cost basis (P5-07) and gain/loss (P5-06), groups into per-account sections with subtotals, and a header with portfolio totals via `portfolioGainLoss`. Query helpers in [src/lib/investments/queries.ts](../../src/lib/investments/queries.ts) (`listInvestmentPositions` holdings⋈accounts⋈securities, `listInvestmentLots`, `listInvestmentIncome`). Unpriced rows + null-basis render "—"; gain/loss color-coded. → **Verify**: `pnpm check` (tsc) on the page + the underlying helpers' unit tests; live render operator-verified.
- [x] **P5-22** — Allocation donut. Created [src/app/investments/allocation-chart.tsx](../../src/app/investments/allocation-chart.tsx) (`'use client'`, Recharts `PieChart`/`Pie` donut, `innerRadius`, per ADR-013/ADR-005), fed by P5-08 slices computed server-side (`allocationByAssetClass`). Per-asset-class colors + a legend showing percent + formatted value; empty state mirrors the net-worth chart. Percents already sum to 100.00 (P5-08).
- [x] **P5-23** — Income breakdown view. Added a "Dividend & interest income" section to `/investments` with a month/quarter/year toggle (URL `?period=` — server-computed via `incomeByPeriod` (P5-09), no client store) and a stacked Recharts bar-chart island ([src/app/investments/income-chart.tsx](../../src/app/investments/income-chart.tsx), dividend vs. interest). Income query filters `subtype IN ('dividend','interest')` in SQL.
- [x] **P5-24** — Navigation wiring. Added "Investments →" links on the home dashboard ([page.tsx](../../src/app/page.tsx)) and the accounts page ([accounts/page.tsx](../../src/app/accounts/page.tsx)); the page is `requireUser`-gated. → **Verify**: `pnpm check` clean; full suite 318 passed (no regressions).

### Tests + E2E

- [x] **P5-25** — Vitest suite (written inline across P5-06 → P5-20). Contract coverage: `gain-loss` (10), `lots` (12, incl. `lotFromBuy`), `allocation` (7), `income` (4); `securities` (7), `investments-map` (10); `sync-investments-item` (5) — holdings/security upsert, sold-out reconcile, txn dedup + buy→lot + idempotent re-run, manual-basis preservation, non-investments no-op; webhook HOLDINGS routing (1); price-fetch `SEC:` exclusion (1); multi-product Link (6); lot actions (4). → **Verify**: `pnpm test` → **318 passed**; coverage on the pure modules is 100% (gain-loss/income), 100%/88% (lots), 100%/96% (allocation), securities 96%, plaid map 93%; `worker/jobs` aggregate 72.5% with the new worker's guard clauses each behind a named test. Assertions are behavioral, not vacuous.
- [x] **P5-26** — Playwright E2E: [e2e/phase5-investments.spec.ts](../../e2e/phase5-investments.spec.ts). **Manual path** (ungated, runs against the dev DB like phase2): bootstrap → create an investment account → add an AAPL holding → seed a price via SQL → record two cost-basis lots through the `LotsEditor` → `/investments` shows total value `$2,345.60`, summed cost basis `$2,000.00`, gain/loss `$345.60 (17.28%)`, and a 100%-equity allocation slice. **Plaid investments path** (gated on `PLAID_E2E_SANDBOX=1`, same seeding idiom as PLAN4 P4-32): seed an `investments`-consented Sandbox Item → map its investment account → assert redirect to the progress page + the new account's `type='investment'` + Item linkage (the holdings/transactions sync runs in the worker, which the Playwright webServer doesn't start — same boundary as the Phase 4 specs; the sync itself is Vitest-covered by P5-16). → **Verify**: **actually run 2026-06-07** — `pnpm exec playwright test` → full suite **9 passed, 2 skipped** (the two `PLAID_E2E_SANDBOX`-gated specs); the manual path passes end-to-end. Running it surfaced + fixed a real pre-existing RSC bug: `require-user.ts` called `session.destroy()` (a cookie write) during a Server Component render, which 500'd the app after any DB reset — now it redirects without writing, `LoginPage` is stale-cookie-tolerant, and [require-user.test.ts](../../src/lib/auth/require-user.test.ts) guards the regression. Also fixed two spec-selector issues (substring `getByPlaceholder("10")` matching the `"1000.00"` field; a fragile pre-existing phase2 `getByText("AAPL", exact)` my lots-editor summary exposed). The Plaid investments path additionally needs sandbox creds to un-skip.

### Security + docs

- [x] **P5-27** — Security pass for the investments surface. Extended [docs/THREAT_MODEL_PLAID.md](../../docs/THREAT_MODEL_PLAID.md) with **Surface 7 — Investments sync** (9 STRIDE rows: wrong-product routing, manual-data clobber, partial-write, repudiation, worker-log leakage, new-tables-hold-no-secrets, pagination DoS, synthetic-price amplification, cross-product token use) + an intro note that the new tables add no secret-bearing asset + Open Item 7 (pagination ceiling) + updated the "how to use" file list. Widened the hardening audit ([hardening-audit.test.ts](../../src/lib/plaid/hardening-audit.test.ts)) Audit 4 `SCAN_PATHS` from just `sync-plaid-item.ts` to **all of `src/worker/jobs/`** so the new worker's logs are covered. → **Verify**: grep confirms `/investments/*` endpoints are called only from `src/worker/jobs/sync-investments-item.ts` (server-side); hardening audit 6/6 green (the worker has no `console.*` callsites); `pnpm check` clean; full suite 318 passed.
- [x] **P5-28** — Docs. Added [docs/INVESTMENTS.md](../../docs/INVESTMENTS.md): the two ingestion tracks (Plaid Investments connect flow + the manual quarterly ritual for iTrust gold/crypto/401k), lot entry, the cost-basis precedence rule, how to read the dashboard, a troubleshooting table, and the explicit **"gain/loss is a display figure, not tax advice; no 1099/cap-gains reporting"** boundary up top. Added an **Investments (Phase 5)** section to [README.md](../../README.md) §Usage linking to it. → **Verify**: the doc walks connect → map → sync and manual → lots → dashboard end-to-end; the domain boundary is stated in both the doc header and README.

---

## Phase 5 Done When

- [x] All three new tables (`securities`, `holding_lots`, `investment_transactions`) + three nullable `holdings` columns exist with constraints per spec. *(Applied as `drizzle/0009_purple_tenebrous.sql` via `pnpm db:migrate`, incrementally rather than `db-reset`, to preserve existing data; `drizzle-kit check` green.)*
- [x] `pnpm test` covers gain/loss, lots + cost-basis precedence, allocation, income, the Plaid securities/holdings/investment-transaction mappers, and the `sync-investments-item` worker (idempotency + sold-out reconcile + manual-basis preservation) with meaningful assertions. *(318 passed.)*
- [ ] Against Sandbox: connecting Fidelity (investments) → mapping → initial sync → `/investments` shows positions with value, cost basis, and gain/loss, an allocation donut, and a dividend/interest income breakdown. *(Operator verification — needs the dev server + worker + Sandbox creds; the headless mapping path is in `e2e/phase5-investments.spec.ts` gated on `PLAID_E2E_SANDBOX=1`.)*
- [x] Manual path: adding a holding + cost-basis lots yields a lots-aware cost basis and correct gain/loss. *(Verified by the ungated `e2e/phase5-investments.spec.ts` manual path — **run green** 2026-06-07: two lots → basis `$2,000.00`, gain/loss `$345.60 (17.28%)` on `/investments`. The delete→fallback branch is unit-tested in P5-07/P5-18.)*
- [x] A Plaid holdings sync preserves manually-entered cost basis (watermark) and manual holdings (reconcile skips `source='manual'`); a sold-out Plaid position is removed on the next sync. *(P5-16 Vitest.)*
- [x] Synthetic (`SEC:`) symbols are valued from Plaid's `institution_price`; tickered Plaid holdings are priced by the existing daily Yahoo fetch; the net-worth chart/snapshots reflect investment value with no snapshot-job change. *(P5-20 + P5-16.)*
- [x] `HOLDINGS` / `INVESTMENTS_TRANSACTIONS` webhooks route to `sync-investments-item` through the **existing** verified, idempotent Phase 4 receiver; the 03:00 safety-net cron covers investment Items. *(P5-15 + P5-17.)*
- [x] `docs/THREAT_MODEL_PLAID.md` has Investments rows with mitigations; `docs/INVESTMENTS.md` exists; README updated.
- [x] `pnpm check` clean (Biome + tsc).
- [x] ADR-011, ADR-012, ADR-013 appended to [IDEAS.md](IDEAS.md) §11 Decision Log; ADR-005's "Sankey deferred to Phase 5" note resolved by ADR-013 (re-deferred).

---

## Skills Map (per task cluster)

Per [SKILLS.md](SKILLS.md) §Suggested Workflow → Phase 5. Invoke when the cluster opens, not upfront.

| Task cluster | Primary skill(s) |
|---|---|
| P5-01 → P5-05 (schema + migrations) | `drizzle-orm-expert`, `postgres-best-practices` |
| P5-06 → P5-09 (gain/loss, lots, allocation, income math) | `test-driven-development`, `typescript-pro` |
| P5-10 (multi-product Link) | `nextjs-app-router-patterns`, `plaid-fintech`, `zod-validation-expert` |
| P5-11 → P5-14 (securities + mappers + lot construction) | `plaid-fintech`, `typescript-pro`, `test-driven-development` |
| P5-15 → P5-17 (webhook routing + sync worker + backfill) | `bullmq-specialist`, `plaid-fintech`, `drizzle-orm-expert` |
| P5-18 → P5-19 (manual lot entry UI) | `nextjs-app-router-patterns`, `zod-validation-expert`, `tailwind-patterns` |
| P5-20 (valuation/price wiring) | `drizzle-orm-expert` |
| P5-21 → P5-24 (dashboard + donut + income view) | `nextjs-app-router-patterns`, `tailwind-patterns` |
| P5-25 → P5-26 (Vitest + Playwright) | `test-driven-development`, `e2e-testing-patterns` |
| P5-27 (security pass) | `backend-security-coder`, `threat-modeling-expert`, `007` |
| P5-28 (docs) | — |

---

## Open Items (out of scope for this plan, captured for future PLAN docs)

- **Cash-flow Sankey** (ADR-013) — the income→category→expense flow diagram. A cash-flow feature, not investment depth; revisit `@nivo/sankey` vs. hand-rolled SVG when built (Phase 6-flavored).
- **SnapTrade for Fidelity** (IDEAS.md §4.2, §12) — better lot-level cost basis than Plaid. Only pursue if Plaid's cost basis proves too thin in production; would add a second aggregator adapter behind the same holdings/lots schema.
- **Transfer detection across accounts** (carried from PLAN4 §Open Items + PLAN3) — recognizing "checking → credit-card payment" or "checking → brokerage deposit" as one transfer. Touches both cash `transactions` and `investment_transactions`; deferred.
- **Plaid `personal_finance_category` as a categorizer seed** (carried from PLAN4 §Open Items) — captured in `raw` since Phase 4; still not feeding the rule engine. Polish, not a blocker.
- **Realized gain/loss & tax lots** — FIFO/LIFO/specific-ID selection, wash sales, cap-gains reports, 1099. **Explicitly out** per CLAUDE.md §Domain Scope; would require a FEATURE.md decision update before any work.
- **Dividend reinvestment (DRIP) modeling** — auto-creating lots from reinvested dividends. Plaid surfaces the buy; we'd just construct the lot. YAGNI until the data shows it matters.
- **`/accounts/balance/get` daily fetch for brokerage cash** (carried from PLAN4 §Open Items) — anchor reconciliation against Plaid's cached balance. Phase 5 leaves it computed-from-holdings.
- **Per-security price history charts** — a sparkline per position. The `prices` table already holds the data; purely a UI add when wanted.

---

*End of PLAN5.md*
