# PLAN — Phase 14 (Intentional income & retirement contributions: let the user define their paycheck(s) and 401k contribution so the money they invest every period becomes real cost basis on the 401k holding, drives gain/loss, and surfaces a savings rate on the dashboard)

> A 401k (an `investment` account) shows holdings and current value, but its **cost basis is blank** — Plaid/employer-plan data rarely carries it, so gain/loss renders "—". Round 8 ([IDEAS2.md](IDEAS2.md)) reframes the problem from the *user's* point of view: *"401k investments from a retirement plan do not show cost basis or gain/loss which is understood. However, from a user's perspective, the 'cost basis' would be the amount of income they invest in their 401k every paycheck. Can the user not have the ability to define their 'income' in an intentional way and have the 401k amount or percentage defined so it is included in investment calculations?"*
>
> The insight is exactly right: for a payroll-funded retirement account, **cost basis is just the sum of what you contributed.** The user confirmed the shape (clarifying-question round, 2026-06-28):
> 1. **Income sources + auto-contributions** (not a passive setting) — the user defines one or more income sources (paycheck cadence + gross per period), and each source's 401k rule (employee amount or percent, plus **employer match**) is **materialized into real contribution transactions** in the 401k account on its pay schedule. Those contributions flow into the existing `holding_lots` → cost-basis → gain/loss → performance machinery, so the 401k's gain/loss "just works" against money actually put in.
> 2. **Employer match** is tracked (it's part of what's invested and part of the basis).
> 3. **Multiple income sources** are supported (e.g. a job change mid-year, or two jobs).
> 4. **A savings-rate metric** surfaces on the dashboard (the Round 7/8 tie-in — contributions ÷ gross), dropping into the slot [PLAN13.md](PLAN13.md) reserves.
>
> This is **mostly additive** — three new tables and **one new scheduled job** — but it is the first phase that *writes* into the investment ledger from a user-defined rule, so the ADRs are about (a) the income/contribution data model and (b) how a contribution becomes a lot without inventing a payroll/tax engine. It introduces **no new egress class**: the only outbound call on any contribution path is the *existing* price fetch for the designated holding's ticker (the same data category Phases 2/5/11 already send). Income figures themselves never leave the box.
>
> Phase 14 closes the round in six batches: (0) **scope gate + ADRs**; (1) **income schema** — `income_sources`, `retirement_contributions`, `income_contributions` + migration; (2) **contribution math** — pure functions for pay-schedule expansion, employee/employer dollar computation, and lot construction; (3) **materialization job** — the scheduled worker that creates due contributions as `investment_transactions` + `holding_lots`, idempotently, + a run-once backfill; (4) **income management UI** — `/settings/income` to define sources + the 401k rule; (5) **surfacing** — 401k cost-basis/gain-loss now populated, the dashboard savings-rate card, the contribution ledger on the account; (6) **tests, docs, privacy pass, E2E**.
>
> **Hard boundary (CLAUDE.md §Domain Scope) — read before writing code.** This phase models **income only as far as it defines a retirement contribution and a savings rate.** It is **NOT** payroll and **NOT** budgeting-income. Phase 14 does **NOT** add: net-pay / take-home modeling, tax withholding, FICA/Medicare, pre-tax vs Roth tax treatment beyond a simple label, deduction stacks, or a paycheck stub (we store *gross per period* + *contribution* — nothing about taxes); a general "income" ledger feeding budgets/cash-flow envelopes (Round 2/Phase 8 budgeting stays expense-side; income here is a contribution-basis input, not a budget line); any tax-lot *selection*, wash-sale, realized/unrealized **tax** reporting, or 1099 generation (reaffirms the PLAN5/PLAN9/CLAUDE.md boundary — contributions create *acquisition* lots; gain/loss stays a display figure); multi-tier "100% to 4%, then 50% to 6%" employer-match formula engines (single-tier match + cap this phase; tiered match is an Open Item); or pulling real payroll data from an external provider (no ADP/Gusto/Plaid-payroll integration — §Privacy, and the user *defines* it intentionally, which is the point). Lifting "define income" into scope is justified the same way budgets were in ADR-018: it is the **owner's explicit ask in [IDEAS2.md](IDEAS2.md)**, recorded in FEATURE.md (P14-00).
>
> **Privacy (CLAUDE.md §Privacy & Data Sovereignty) — binding; no new egress class.** Income, gross pay, and contribution amounts are the **most sensitive new data class** in the app — and they stay **100% in local Postgres.** The only outbound HTTP on any contribution code path is the *existing* `fetch-prices-daily` pipeline pricing the designated holding's ticker (already-egressing data category; only the symbol leaves, never a dollar amount). No income figure is logged (a gross-pay number is financial data — CLAUDE.md: never logged). P14-00 + the Batch 6 privacy pass add a regression test asserting the income modules do no outbound HTTP and log no income figure.
>
> **Money & Numeric Precision (CLAUDE.md §Money — CRITICAL).** Every dollar here (`gross_per_period`, employee/employer contribution, lot cost basis) is `NUMERIC(18,2)` stored as a string; percentages are `NUMERIC(7,4)`; share quantities `NUMERIC(28,8)`. **All** contribution arithmetic (percent-of-gross, employee+employer sum, dollars ÷ price → shares) goes through the [Money](../../src/lib/money/money.ts) / `decimal.js` helpers — **never** native `+ - * /`. `Number()` only at the display edge. This is the #1 way a contribution feature produces wrong cost basis; it is non-negotiable.
>
> **Companion docs** — read for context, do not duplicate:
> - [PLAN5.md](PLAN5.md) / [PLAN9.md](PLAN9.md) — the investment schema + cost-basis precedence (ADR-012: `sum(lots) → holdings.cost_basis → null`), `holding_lots`, `investment_transactions`, the `holding_snapshots`/performance engine that contributions will feed. **The lot model this phase writes into is theirs — read it first.**
> - [PLAN13.md](PLAN13.md) — the dashboard this phase adds the savings-rate card to (it reserves the slot + the `DashboardData.savingsRate` seam in P13-13).
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Money & Numeric Precision (Decimal-only, `numeric` stays string), §Domain Scope (no payroll/tax/double-entry), §Privacy (income never egresses or logs), §Background Jobs (one job per logical unit; idempotent by design; `ON CONFLICT`; scheduled via BullMQ repeatable jobs not OS cron), §Database & Drizzle Specifics (UUID PKs, `timestamptz`, `numeric` money, never drop a column).
> - [IDEAS.md](IDEAS.md) §11 Decision Log (current max **ADR-029** after Phase 13; Phase 14 appends **ADR-030 → ADR-031**), ADR-012 (cost-basis precedence — contributions create lots that resolve through it), ADR-019/021 (snapshots/performance — contributed basis makes 401k gain/loss + TWR meaningful), ADR-018 (the precedent for lifting an owner-requested feature out of "out of scope").
> - [SKILLS.md](SKILLS.md) §Suggested Workflow — see §Skills Map below.

---

## What already exists (do not rebuild — extend these)

Phase 14 plugs into the Phase-5 investment ledger. Inventory before writing a line of code:

- **Investment ledger** — [investment_transactions](../../src/db/schema/investment-transactions.ts) (`type` ∈ buy/sell/cash/fee/transfer/cancel, `subtype`, `tradeDate`, `quantity`, `price`, `amount` signed-inflow-positive, `source` ∈ plaid/manual, partial-unique dedup on `(account_id, plaid_investment_transaction_id)`). Contributions are **a new `source` value** (`'income'`) writing `type='buy'` rows — the dedup unique index already tolerates NULL plaid ids, and we add a contribution-keyed dedup of our own (P14-08).
- **Cost-basis lots** — [holding_lots](../../src/db/schema/holding-lots.ts) (`quantity`, `cost_basis_total`, `acquiredAt`, `source` ∈ manual/plaid, partial-unique on `(holding_id, plaid_investment_transaction_id)`). [lots.ts](../../src/lib/investments/lots.ts): `lotFromBuy(txn, holdingId)` already turns a buy into a `NewHoldingLot`; `aggregateLots` / `resolveCostBasis` already roll lots up to the holding's basis. **A contribution lot is just a `lotFromBuy` with `source='income'`** — this is the seam that makes "contributed = cost basis" work with zero changes to gain/loss.
- **Gain/loss + performance** — [gain-loss.ts](../../src/lib/investments/gain-loss.ts), [performance.ts](../../src/lib/investments/performance.ts) (`twr`/`xirr`/`gainLossSeries`), [holding_snapshots](../../src/db/schema/holding-snapshots.ts) written nightly by [compute-snapshots-daily.ts](../../src/worker/jobs/compute-snapshots-daily.ts). Once contributions create lots, **the 401k's gain/loss and TWR populate automatically** — and `xirr` already consumes external flows (a contribution *is* an external flow), so money-weighted return becomes correct too.
- **Prices** — [prices](../../src/db/schema/prices.ts) + [fetch-prices-daily.ts](../../src/worker/jobs/fetch-prices-daily.ts) + `latestCloseOnOrBefore(symbol, date)`. The materialization job prices a contribution's shares from the holding's symbol at the pay date. The designated symbol joins the fetch work-list automatically (it's a held holding).
- **Worker scheduling** — [src/worker/index.ts](../../src/worker/index.ts) registers BullMQ repeatable jobs via `upsertJobScheduler` (the established cron pattern — see `fetch-prices-daily-cron` at 01:30, `compute-snapshots-daily-cron` at 02:00); [src/lib/queue/queues.ts](../../src/lib/queue/queues.ts) `lazyQueue` + `QUEUE_NAMES`. The new `materialize-contributions` job follows this exact pattern; the run-once backfill follows [run-once.ts](../../src/worker/run-once.ts) (like the Phase 9/11 backfills).
- **Accounts** — [accounts.ts](../../src/db/schema/accounts.ts) / [enums.ts](../../src/db/schema/enums.ts): `type='investment'` is the 401k. No new account type — a 401k is already an investment account; the income rule *links to* one.
- **Validation + money** — Zod schemas in [src/lib/schemas/](../../src/lib/schemas/) (the `moneyAmountSchema` / `isoDateSchema` precedent in [account.ts](../../src/lib/schemas/account.ts)); [Money](../../src/lib/money/money.ts) for every computation. Server actions validate at the boundary (CLAUDE.md §Zod).
- **Settings pages** — [settings/categories](../../src/app/settings/categories/page.tsx), [settings/connections](../../src/app/settings/connections/actions.ts) are the precedent for the new `/settings/income` management surface (server components + server actions, `requireUser`-guarded).

---

## ADRs locked at plan time

Two decisions surface in Phase 14. Both are 🔲 **Proposed** — append to [IDEAS.md](IDEAS.md) §11 Decision Log (next free numbers **ADR-030 → ADR-031**; verified ADR-029 is current max after Phase 13) after this plan is approved (P14-00).

---

### ADR-030 — Income & retirement-contribution model: `income_sources` (the paycheck) + `retirement_contributions` (the 401k rule) + `income_contributions` (the materialized ledger); multiple sources; single-tier employer match with a cap

**Status**: 🔲 Proposed

**Context**: Round 8 needs three distinct things stored: *what the paycheck is* (cadence + gross), *the rule that turns a paycheck into a 401k contribution* (employee %/$, employer match, which account/holding it funds), and *the record that a specific period's contribution happened* (so materialization is idempotent and the basis is auditable). Conflating them into one table breaks down the moment there are two income sources, or the rule changes mid-year, or we need to dedupe "did we already create March 15th's contribution?"

**Decision** — three additive tables (UUID PKs, `timestamptz`, `numeric` money as string per CLAUDE.md):

1. **`income_sources`** — the paycheck. `name`, `cadence` text+CHECK ∈ `('weekly','biweekly','semimonthly','monthly')`, `gross_per_period numeric(18,2)`, `currency` (default USD), `anchor_date date` (a known real pay date to phase the schedule from), `active boolean`, `start_date`, optional `end_date`, `notes`. (text+CHECK over `pgEnum`, matching the `transactions.source`/`holding_lots.source` posture.)
2. **`retirement_contributions`** — the 401k rule attached to a source. `income_source_id` FK (`onDelete: cascade`), `account_id` FK → the `investment` (401k) account, **optional** `holding_id` FK → the specific position the contribution buys (null ⇒ basis-only/cash, see ADR-031), `employee_basis` text+CHECK ∈ `('percent','amount')`, `employee_value numeric(18,4)` (percent-of-gross when `percent`, else fixed $/period), `pretax boolean` (a *label* only — drives no tax math), and the **single-tier employer match**: `match_basis` text+CHECK ∈ `('none','percent_of_gross','percent_of_contribution','amount')`, `match_value numeric(18,4)`, `match_cap_percent numeric(7,4)` nullable (cap as % of gross). `active boolean`.
3. **`income_contributions`** — the materialized ledger (one row per source per pay date). `retirement_contribution_id` FK (`onDelete: cascade`), `pay_date date`, `gross_amount`, `employee_amount`, `employer_amount` (all `numeric(18,2)`), `investment_transaction_id` FK (the buy row it created; nullable for basis-only), `holding_lot_id` FK (nullable), `created_at`. **UNIQUE `(retirement_contribution_id, pay_date)`** — the idempotency key that makes materialization + backfill safe to re-run.

**Consequences**:
- ✅ Multiple income sources fall out for free (rows, not a singleton). A mid-year change is a new source (end-date the old) or an edited rule going forward; history stays intact via the materialized ledger.
- ✅ Employer match is first-class and part of the basis, with a cap, without a tax engine.
- ✅ The materialized `income_contributions` ledger makes the whole thing auditable and idempotent — you can see exactly which periods produced which lots.
- ✅ Zero change to `investment_transactions`/`holding_lots` schema — contributions reuse them via a new `source`/marker.
- ⚠️ Single-tier match only. A tiered "100%→4%, 50%→6%" formula is deferred (Open Item) — the cap covers the common "match up to X%" case the single user most likely has.
- ⚠️ `gross_per_period` is sensitive. It is encrypted-at-rest only insofar as the whole DB is (the `pg_dump | age` backup, ADR-014); it is never logged and never leaves the box. Documented in the privacy pass.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| One `income` table with the rule inlined | Can't represent two sources, a mid-year rule change, or per-period idempotency cleanly; the materialized ledger needs its own rows regardless. |
| A passive `account.contribution_setting` (no tables) | Derives a synthetic basis but builds no real lots — gain/loss/TWR/allocation wouldn't reflect actual acquisitions, and there'd be no audit trail. The user chose auto-contributions specifically. |
| Full paycheck model (net pay, withholding, deductions) | Payroll/tax engine — out of scope (CLAUDE.md §Domain Scope). We need gross + contribution, nothing else. |
| `pgEnum` for cadence/basis/match | Project posture is text+CHECK for these small, evolvable vocabularies (matches `transactions.source`, `holding_lots.source`). |

---

### ADR-031 — A scheduled job materializes each due contribution into the investment ledger as a `buy` + cost-basis lot (priceable holdings) or a basis-only increment (unpriceable funds); idempotent by `(rule, pay_date)`; run-once backfill from each source's start

**Status**: 🔲 Proposed

**Context**: ADR-030 stores the *rule*; something has to turn "biweekly, 6% of $4,000, 50% match up to 4%" into actual cost basis on the 401k. The cleanest integration is to make a contribution **look exactly like a buy**, so the existing lots → cost-basis → gain/loss → TWR/XIRR machinery (ADR-012/019/021) consumes it with zero special-casing. But 401k plans split into two real cases: (a) the position is a **priceable** fund/ETF with a public ticker (e.g. `FXAIX`) — we can compute shares from the contribution-date close; (b) the position is an **institutional fund with no public price** — we know the dollars contributed but not a defensible share count.

**Decision**:
1. **A BullMQ repeatable job `materialize-contributions`** (daily, chained after `fetch-prices-daily` so prices are fresh — same posture as `evaluate-price-targets`). For each active `retirement_contribution`, it expands the pay schedule (ADR-030 cadence + anchor) up to today, and for each pay date **not yet in `income_contributions`** (the UNIQUE `(rule, pay_date)` guard), computes employee + employer dollars (Decimal math) and materializes:
   - **Priceable holding** (`holding_id` set, symbol has a `latestCloseOnOrBefore(symbol, pay_date)`): create an `investment_transactions` row `type='buy'`, `source='income'`, `quantity = dollars ÷ close` (Decimal), `price = close`, `amount = dollars`; then `lotFromBuy(...)` with `source='income'`, `cost_basis_total = dollars`. The 401k now has real shares + basis; gain/loss, allocation, snapshots, and XIRR all light up.
   - **Basis-only** (`holding_id` null, or symbol unpriceable): create an `investment_transactions` row `type='cash'`/`subtype='deposit'`, `source='income'`, `amount = dollars` (no quantity/price), and a `holding_lots` row carrying `cost_basis_total = dollars` against the designated holding with `quantity` left to the user's manual quarterly entry (the existing IRA pattern). Cost basis still accrues (the user's literal ask); quantity stays user-maintained. The contribution is recorded and savings-rate-counted either way.
2. **Idempotent by design** (CLAUDE.md §Background Jobs): the UNIQUE `(retirement_contribution_id, pay_date)` on `income_contributions` means re-running the job (or running it twice on a Redis hiccup) is a no-op; the buy/lot are written in **one DB transaction** with the ledger row, so a partial failure can't leave an orphan lot.
3. **Run-once backfill** (`backfill-contributions`, follows [run-once.ts](../../src/worker/run-once.ts)): walks each source from `start_date`/`anchor_date` to today, materializing every historical pay date so the 401k's **historical** cost basis and the contribution timeline are correct from day one. Bounded by single-user pay cadence (≤ a few hundred rows per source per decade); idempotent via the same unique key. Honest about prices: historical shares use the historical close where available; pre-price-history dates fall back to basis-only.
4. **Savings rate is derived, not stored**: `annual_employee_contributions ÷ annualized_gross` (Decimal), computed on read for the dashboard card (PLAN13 slot). No stored, staleable rate (same principle as ADR-020's "don't store yield").
5. **Reconciliation, not enforcement**: the contribution stream is the user's *intent*; if Plaid also syncs the 401k, contributions and synced buys can double-count. The job **only** writes `source='income'` rows and never touches `source='plaid'`/`'manual'` rows; the account view shows a clear "contributions (defined)" vs "synced" split, and the docs warn against enabling both on the same holding. (For the single user's manually-tracked 401k, income is the sole source — the common case.)

**Consequences**:
- ✅ "Contributed = cost basis" becomes true through the *existing* lot model — gain/loss, TWR, XIRR, allocation, and snapshots all reflect real money in, no special cases.
- ✅ Works for both real-world 401k flavors (public-ticker funds and opaque institutional funds) without blocking the opaque case on data we don't have.
- ✅ Idempotent + backfillable + auditable; one job, one logical unit of work (CLAUDE.md §Background Jobs).
- ✅ No new egress class — the only network call is the existing price fetch for an already-held symbol.
- ⚠️ Basis-only contributions accrue dollars but not shares; the holding's quantity stays manual. Surfaced honestly in the UI ("basis tracked from contributions; quantity entered manually").
- ⚠️ Double-counting risk if both Plaid and income fund the same holding. Mitigated by source-scoping + the docs warning + the account-view split; a hard guard (refuse income rule on a Plaid-synced holding) is an Open Item if it bites.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Materialize at render time (no stored contributions) | Re-deriving the whole schedule on every page load is slow and gives no audit trail/idempotency; performance + snapshots want real rows. |
| Always require a priceable holding | Excludes the common opaque-institutional-fund 401k; the user's ask is about *basis*, which we can track without a share price. |
| Increment `holdings.cost_basis` directly (skip lots) | Loses per-contribution granularity + the acquisition date that XIRR/TWR need; `resolveCostBasis` already prefers lots, so lots are the right grain. |
| A separate "retirement" valuation path | Reinventing the snapshot/gain-loss engine for one account type; the whole point is to reuse the existing one. |

---

## Batches

> Each task is atomic and independently reviewable. Task IDs are `P14-NN`. Batches land as separate commits/PRs following the Phase 11/12/13 cadence. **P14-00 gates everything** — no code before the scope note + ADRs are recorded.

### Batch 0 — Scope gate + ADRs

- **P14-00** — Record the §Domain Scope + §Privacy + §Money scope note (income only for contribution-basis + savings rate; no payroll/tax/net-pay; no external payroll provider; no double-counting with Plaid; Decimal-only money) in this plan's header (done above) and append **ADR-030** + **ADR-031** to [IDEAS.md](IDEAS.md) §11 Decision Log (verify ADR-029 is the max at commit time). Update [FEATURE.md](FEATURE.md) with a Round 8 → Phase 14 section, mirroring the ADR-018 "owner explicitly asked, so it's in scope" framing. **Gate: nothing in Batch 1+ starts until this is committed.**

### Batch 1 — Income schema + migration

- **P14-01** — `src/db/schema/income-sources.ts`: the `income_sources` table per ADR-030 (cadence/`text`+CHECK, `gross_per_period numeric(18,2)`, `anchor_date`, `active`, `start_date`/`end_date`, `notes`), `$inferSelect`/`$inferInsert` exports, relations. Re-export from [src/db/schema/index.ts](../../src/db/schema/index.ts).
- **P14-02** — `src/db/schema/retirement-contributions.ts`: the rule table per ADR-030 (FKs to `income_sources`/`accounts`/`holdings`, `employee_basis`/`employee_value`, `pretax` label, `match_basis`/`match_value`/`match_cap_percent`, `active`), CHECK constraints, FK indexes (Postgres doesn't auto-index FKs — postgres-best-practices), relations. Re-export.
- **P14-03** — `src/db/schema/income-contributions.ts`: the materialized ledger per ADR-030 with **UNIQUE `(retirement_contribution_id, pay_date)`**, FKs to the rule + `investment_transactions` + `holding_lots` (the latter two nullable, `onDelete: set null`), money columns `numeric(18,2)`, `(retirement_contribution_id, pay_date DESC)` index. Re-export.
- **P14-04** — `pnpm drizzle-kit generate` + verify the migration applies cleanly against a fresh DB (`make db-reset` + migrate). No data movement (all new tables). Confirm `pnpm build`/typecheck green with the new `$inferSelect` types wired into `src/db/schema/index.ts`.

### Batch 2 — Contribution math (pure functions, TDD)

- **P14-05** — `src/lib/income/schedule.ts`: pure `payDatesBetween(cadence, anchorDate, from, to): string[]` — expand a cadence (weekly/biweekly/semimonthly/monthly) from an anchor across a window. **Vitest first** (always-test — date math is bug-prone: biweekly drift, semimonthly 15th/last, month-end). No `Date` float math; ISO-string dates throughout.
- **P14-06** — `src/lib/income/contribution.ts`: pure `computeContribution(rule, grossPerPeriod): { employee, employer }` — Decimal-only: employee = percent-of-gross or fixed amount; employer = the single-tier match (`none`/`percent_of_gross`/`percent_of_contribution`/`amount`) clamped to `match_cap_percent × gross`. **Vitest** across every `match_basis` + the cap boundary + zero/over-cap cases. Returns `Money` strings.
- **P14-07** — `src/lib/income/savings-rate.ts`: pure `savingsRate(sources, contributions): { annualGross, annualEmployee, ratePct }` — annualize gross by cadence, sum employee contributions, divide (Decimal; `null` rate when gross is zero). **Vitest**. This is what the dashboard card (P14-15) renders.
- **P14-08** — `src/lib/income/materialize.ts`: pure `planContributions(rule, source, existingPayDates, priceLookup): PlannedContribution[]` — given the rule, the already-materialized pay dates (dedup), and a `(symbol, date) → close | null` lookup, return the buy-or-basis-only plan per pay date per ADR-031 (shares = dollars ÷ close via Decimal when priceable; basis-only otherwise). **Vitest** for the priceable vs basis-only branch + the dedup skip. Pure — the DB/price IO is injected, so it's fully unit-testable.

### Batch 3 — Materialization job + backfill

- **P14-09** — `src/worker/jobs/materialize-contributions.ts`: the processor — load active rules, call `planContributions` with `latestCloseOnOrBefore` as the price lookup, and for each planned contribution write the `investment_transactions` buy/cash row + `holding_lots` lot (via `lotFromBuy`, `source='income'`) + the `income_contributions` ledger row **in one DB transaction**. Idempotent via the UNIQUE key (`ON CONFLICT DO NOTHING` on the ledger short-circuits a re-run). Register the queue in [queues.ts](../../src/lib/queue/queues.ts) (`QUEUE_NAMES` + `lazyQueue`). **Vitest** for the processor against a seeded DB (one new contribution created; second run a no-op).
- **P14-10** — Schedule it in [src/worker/index.ts](../../src/worker/index.ts) as a daily repeatable job **chained after `fetch-prices-daily`** (so the pay-date close exists), mirroring the `evaluate-price-targets`/`fetch-prices-daily-cron` pattern (`removeJobScheduler` then `upsertJobScheduler`). Document the chain in a comment.
- **P14-11** — `src/worker/jobs/backfill-contributions.ts` + a `run-once` entry ([run-once.ts](../../src/worker/run-once.ts)): materialize every historical pay date from each source's `start_date`/`anchor_date` to today, idempotent via the same UNIQUE key, basis-only fallback for pre-price-history dates. **Vitest** for a multi-year backfill producing the expected contribution count + total basis. After backfill, the nightly [compute-snapshots-daily](../../src/worker/jobs/compute-snapshots-daily.ts) picks up the new lots/quantities for `holding_snapshots` (no change to that job needed — note this dependency).
- **P14-12** — Reconciliation guard (ADR-031 §5): the job writes/reads only `source='income'` rows; add a Vitest asserting it never updates/deletes a `source='plaid'` or `source='manual'` lot/txn. Add a non-fatal warning to the income UI (P14-14) when an income rule targets a holding that also has `source='plaid'` lots (double-count risk).

### Batch 4 — Income management UI

- **P14-13** — `src/lib/schemas/income.ts`: Zod schemas for the income-source form (cadence enum, `moneyAmountSchema` gross, `isoDateSchema` anchor/start/end with `start ≤ end` refinement) and the contribution rule (employee basis/value, match basis/value/cap, account/holding selection; refine: `percent` values ≤ 100, cap ≤ 100, holding belongs to the chosen account). **Vitest** for the refinements. Reuse `moneyAmountSchema`/`isoDateSchema` from [account.ts](../../src/lib/schemas/account.ts).
- **P14-14** — `src/app/settings/income/page.tsx` + `actions.ts`: server-component management surface (`requireUser`-guarded) — list income sources, create/edit/deactivate a source, and attach/edit the 401k contribution rule (account picker scoped to `type='investment'`, optional holding picker, employee %/$ + employer match + cap, pretax label). Server actions validate via P14-13, `revalidatePath`. Mirrors the [settings/categories](../../src/app/settings/categories/category-manager.tsx) pattern. Add `/settings/income` to the nav/settings index. Show the double-count warning from P14-12 inline.
- **P14-15** — "Preview before save" affordance: when a rule is created/edited, show the computed per-period employee + employer dollars and the resulting annual savings rate (calls P14-06/P14-07) so the user sees the effect before the job runs. Read-only preview; the job does the actual materialization.

### Batch 5 — Surfacing (cost basis, savings-rate card, contribution ledger)

- **P14-16** — 401k account/investment view: the holding's cost basis + gain/loss now populate from the contribution lots (via the existing `resolveCostBasis`/`gain-loss.ts` — **no change needed**, verify it renders). Add a "Cost basis tracked from contributions" annotation + the basis-only "quantity entered manually" note where applicable ([investments/page.tsx](../../src/app/investments/page.tsx) / [security/[id]/page.tsx](../../src/app/investments/security/[id]/page.tsx)).
- **P14-17** — **Savings-rate dashboard card** (`src/components/dashboard/savings-rate-card.tsx`): drop into the slot [PLAN13.md](PLAN13.md) reserved (P13-13 — `DashboardData.savingsRate`); wire `savingsRate(...)` (P14-07) into `loadDashboard`. Show the rate %, annual employee + employer contributions, and a "→ Income settings" link. Empty state when no income source is defined ("Define your income to track your savings rate"). Carry the estimate framing if annualization is approximate.
- **P14-18** — Contribution ledger on the 401k account: a compact "Contributions" section listing recent `income_contributions` (date, employee, employer, total) with a link to `/settings/income`, so the basis is auditable from the account it funds. Read-only.

### Batch 6 — Tests, docs, privacy pass, E2E

- **P14-19** — Vitest sweep (gather): schedule expansion (P14-05), contribution + match math incl. cap (P14-06), savings rate (P14-07), the materialize planner branches (P14-08), the job idempotency + reconciliation guards (P14-09/P14-12), and the backfill count/basis (P14-11). Confirm the suite is complete + green. These are the "always-test" surfaces (money + date math + a job that writes financial data).
- **P14-20** — **Privacy regression test** (mandatory, CLAUDE.md §Privacy): assert no module under `src/lib/income/` nor `src/worker/jobs/materialize-contributions.ts`/`backfill-contributions.ts` makes outbound HTTP (the only network is the existing price lookup, which is injected — assert the income modules don't import a fetcher directly) and that no income/gross figure is passed to a logger.
- **P14-21** — `docs/INCOME.md`: the income/contribution model (the three tables + the rule), how a contribution becomes cost basis (priceable vs basis-only), the materialization + backfill jobs + their schedule, the savings-rate derivation, the **double-counting caveat** (income vs Plaid on the same holding), and the explicit scope/privacy boundaries (no payroll/tax, income never egresses or logs). Link from [README.md](../../README.md) + [FEATURE.md](FEATURE.md); cross-link [docs/DASHBOARD.md](../../docs/DASHBOARD.md) for the savings-rate card.
- **P14-22** — **Playwright** E2E (one focused flow, per CLAUDE.md §Testing Philosophy): create an income source + a 401k contribution rule with an employer match against a seeded priceable holding, run the materialize job (or its run-once), and assert the 401k now shows a cost basis + gain/loss and the dashboard shows a savings rate. Keep it to this single critical path.

---

## Skills Map (when each pays off this phase)

Per [SKILLS.md](SKILLS.md) §Suggested Workflow — invoke at the moment of leverage, not preemptively:

- **`drizzle-orm-expert`** — Batch 1 (the three new tables, FK indexes, the UNIQUE idempotency constraint, the transactional multi-table write in the job).
- **`test-driven-development`** — Batch 2 (schedule expansion + contribution/match math + savings rate + the materialize planner are pure functions with crisp I/O and nasty edge cases — write tests first; highest TDD payoff in the phase).
- **`typescript-pro`** — Batch 1–2 (discriminated unions for `employee_basis`/`match_basis`, the priceable-vs-basis-only `PlannedContribution` union, Decimal-string money types).
- **`bullmq-specialist`** — Batch 3 (the daily materialize job + run-once backfill: idempotency, the chain-after-prices ordering, `ON CONFLICT`, one-logical-unit-of-work).
- **`zod-validation-expert`** — Batch 4 (income-source + rule form schemas + refinements at the boundary).
- **`postgres-best-practices`** — Batch 1 (numeric money precision, FK indexing, the partial/unique constraint design).
- **`nextjs-app-router-patterns`** — Batch 4–5 (the `/settings/income` server-component surface + server actions; the dashboard card).
- **`e2e-testing-patterns`** — Batch 6 P14-22 (the one Playwright contribution→basis flow).
- **`systematic-debugging`** — reactive, if a contribution produces a wrong basis or the schedule drifts (compare against the pure-function tests first).

Note in each batch's PLAN task which skill was the reference when invoked for real (per [SKILLS.md](SKILLS.md) §Maintenance).

---

## Open Items (deferred — record, don't build)

- **Tiered employer match** ("100% to 4%, then 50% to 6%") — single-tier + cap this phase; a tiered formula engine is deferred until the single user's plan actually needs it.
- **Pre-tax vs Roth tax treatment** — `pretax` is a *label* only; no tax math. Tax-aware basis (Roth basis ≠ pre-tax basis for withdrawal) is out of scope (CLAUDE.md §Domain Scope) until explicitly asked.
- **Contribution-limit awareness** (the annual 402(g)/415 IRS caps) — could warn when projected contributions exceed the year's limit; deferred (a nicety, and limits change yearly).
- **Hard double-count guard** — currently a soft warning (P14-12) + source-scoping. If the user runs both Plaid sync and an income rule on the same holding and it bites, promote to a hard refuse.
- **Income feeding cash-flow/budgets** — income here is contribution-basis + savings-rate only; wiring gross income into the Phase-8 budget/cash-flow side is a separate decision (Round 2 stayed expense-side).
- **Net-pay / paycheck stub modeling** — explicitly out (payroll engine). We store gross + contribution, nothing about withholding or take-home.

---

*End of PLAN14.md*
