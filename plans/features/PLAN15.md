# PLAN — Phase 15 (Household money guidance: a deterministic, fully-local recommendation engine that turns the data the app already holds — income, contributions, spend, balances, debt — into recommended budgets, a savings waterfall, emergency-fund sizing, cash tiering, and debt-payoff ordering)

> Rounds 2–8 made the app **descriptive**: here is what you spent, what you hold, what you contributed, what it projects to. Round 9 ([IDEAS2.md](IDEAS2.md)) asks it to become **prescriptive**: *"Given all of the sources of data available to the app, including now income and investment contributions, can it now 'recommend' some things? Recommend budgets. Recommend how much to save, long term vs short term. How much to keep on hand and how much to keep in medium-term savings like CD's. Help the user manage their money, not investments. Help them based off of standard and well known best practices for managing family, household money. Perhaps the app needs to know extra info, like how many household members and age… Remember this apps data is all local."*
>
> The owner confirmed the shape (clarifying-question round, 2026-08-15):
> 1. **The full waterfall, including debt payoff** — not a savings-only subset.
> 2. **Prerequisite schema is in scope this phase** — without an account `subtype` the app cannot tell checking from savings from a CD, and "how much on hand vs. medium-term" is literally unanswerable.
> 3. **Take-home is derived from observed income transactions**, not declared — the deposits that actually landed *are* take-home.
> 4. **A household member list with ages** (birth *year*), not just counts.
>
> Two properties make "the app recommends things" safe to build here. First, it is a **deterministic rules engine, never a model** — CLAUDE.md §Privacy forbids sending financial data to a hosted LLM, so every recommendation is a pure function that names the heuristic it implements and lists the inputs it used. That is not a constraint working against us: it makes the whole surface Vitest-able, offline, and auditable in a way a model never is. Second, it recommends **structures and amounts, never products** — *"a 4-rung ladder for the $18k above your reserve"* is in; *"buy VOO at Vanguard"* is out.
>
> Phase 15 lands in eight batches: (0) **scope gate + ADRs**; (1) **prerequisite schema** — account subtype/APY/maturity/tax-treatment, category necessity, a `credit_lines` table, household profile + members, dismissals; (2) **baseline computation** — observed net income, essential expenses, cash tiers, unified debt terms, and the single snapshot loader; (3) **the rules engine** — pure functions per rule plus the waterfall composition; (4) **budget recommendations** — the median/p75 suggester and the needs/wants diagnostic; (5) **data-entry surfaces** — the settings UIs that make the new columns real; (6) **delivery** — the `/plan` page, the dashboard card, dismiss/snooze, and material-change alerts; (7) **tests, docs, privacy pass, E2E**.
>
> **Hard boundary (CLAUDE.md §Domain Scope) — read before writing code.** This phase recommends **structures and amounts** and nothing else. It does **NOT** add: any AI/LLM advisor over financial data (§Privacy hard-no — guidance is deterministic or it does not ship); recommendation of a **specific security, fund, institution, or product** (that is advice; we are a tracker); **tax computation of any kind** — `accounts.tax_treatment` describes the *container* so the waterfall can order it and drives **no math**, reaffirming ADR-030's "`pretax` is a label only"; Roth-vs-traditional conversion analysis, tax-loss harvesting, or withdrawal sequencing; Monte Carlo or probabilistic retirement planning (**ADR-022 — still rejected**); **user-authored goals** with per-goal projections and funding rules — waterfall rungs are *derived state* the user cannot create, name, reorder, or fund, which is exactly why **ADR-022 stands unamended** (see ADR-032 §6); insurance adequacy, estate/will planning, or education/529 accounts; double-entry accounting or envelope budgeting (Round 2 stayed simple monthly targets, and it stays that way). Lifting *guidance* into scope is justified the same way ADR-018 lifted budgets and ADR-030 lifted income: it is the **owner's explicit ask in [IDEAS2.md](IDEAS2.md)**, recorded in [FEATURE.md](FEATURE.md) (P15-00).
>
> **Privacy (CLAUDE.md §Privacy & Data Sovereignty) — binding; no new egress class, and this time literally zero.** The advice engine makes **no outbound HTTP on any code path**. Every benchmark constant (statutory limits, default reserve months, the needs/wants split) is **checked into the repo**, not fetched. The "what yield am I forgoing" figure uses a **user-entered benchmark APY**, never a live rate feed — that is the entire reason rate fetching was rejected in ADR-033. Household member names and birth years are the new PII: local Postgres only, riding the nightly `age`-encrypted `pg_dump` (ADR-014), **deliberately excluded from the ⌘K search index** (ADR-027/028), never in the content-free notification email. No income, balance, or recommendation figure is ever logged. P15-00 plus the Batch 7 privacy pass enforce all of this with a regression test.
>
> **Money & Numeric Precision (CLAUDE.md §Money — CRITICAL).** Every dollar here — essential-expense baselines, reserve targets, ladder rungs, payoff schedules, suggested budgets — is a `numeric` string combined only through [Money](../../src/lib/money/money.ts)/`decimal.js`. **Never** native `+ - * /`. The debt-payoff simulator (P15-19) is the sharpest edge in the phase: it iterates month over month accruing interest, and a float there compounds error into a wrong "months to debt-free." Percentages are `numeric(7,4)`, APRs `numeric(8,6)`. `Number()` only at the display edge inside the Recharts islands.
>
> **Companion docs** — read for context, do not duplicate:
> - [PLAN14.md](PLAN14.md) — the income model this phase reads (`income_sources`, `retirement_contributions`, `income_contributions`) and the **savings-rate function it must not duplicate**. ADR-034 §2 is explicit: exactly one savings rate exists, and PLAN14 already shipped it.
> - [PLAN13.md](PLAN13.md) — the dashboard, its `loadDashboard` contract, and the "cards are dumb, the loader is smart" rule that ADR-032 extends to advice.
> - [PLAN8 budgets / analytics](../../src/lib/analytics/) — `spendByCategory`/`spendByMonth`/`MonthlyTotals` and [forecast.ts](../../src/lib/analytics/forecast.ts). **Read the forecast module before writing the budget suggester** — it uses a trailing *mean* and P15-22 deliberately does not (ADR-034 §3).
> - [../../CLAUDE.md](../../CLAUDE.md) — §Money (Decimal-only), §Domain Scope (no tax engine, no double-entry, no LLM), §Privacy (zero egress, nothing logged), §Testing Philosophy (money math is an always-test surface), §Database & Drizzle Specifics (UUID PKs, `timestamptz`, `numeric` money, never drop a column).
> - [IDEAS.md](IDEAS.md) §11 Decision Log (current max **ADR-031** after Phase 14; Phase 15 appends **ADR-032 → ADR-034**), ADR-018 (budgets — the precedent for lifting an owner-requested feature into scope), ADR-021 ("insufficient history" — the precedent P15-13 generalizes), ADR-022 (forward views + the goals boundary this phase must *not* cross), ADR-029 (the loader/card split), ADR-030/031 (income + the one true savings rate).
> - [SKILLS.md](SKILLS.md) §Suggested Workflow — see §Skills Map below.

---

## What already exists (do not rebuild — extend these)

Phase 15 is unusually reuse-heavy: most of its inputs already ship. Inventory before writing a line of code.

- **Spend analytics** — [spending.ts](../../src/lib/analytics/spending.ts): `spendByCategory`, `spendByMonth` (→ `MonthlyTotals`), `spendingSummary`, `categoryDetail`. **These are the essential-expense and budget-suggestion inputs.** Do not write new aggregation SQL; add a `necessity` filter to the existing query shape.
- **Forecasting** — [forecast.ts](../../src/lib/analytics/forecast.ts): `forecastMonthlySpend` (trailing **mean**) and `runRateToMonthEnd`. Reused for the "will you close the gap" projections. **Not** reused for budget targets — ADR-034 §3.
- **Budgets** — [budgets/queries.ts](../../src/lib/budgets/queries.ts): `setBudget` (upsert), `listBudgets`, `budgetVsActual`, `monthRange`. The budget recommender **applies through `setBudget`** and invents no parallel write path.
- **Income + contributions** — [income/queries.ts](../../src/lib/income/queries.ts) (`loadIncomeSettings`, `savingsRateInputs`, `listAccountContributions`) and [savings-rate.ts](../../src/lib/income/savings-rate.ts) (`savingsRate`). The employer-match rule reads `retirement_contributions` (`match_basis`/`match_value`/`match_cap_percent` vs `employee_value`); contribution pacing reads `income_contributions` by `pay_date`. **The savings rate is already computed — consume it, never recompute it.**
- **Dashboard** — [dashboard/loader.ts](../../src/lib/dashboard/loader.ts) (`loadDashboard`, `DashboardData`, the optional `savingsRate` slot) and [src/components/dashboard/](../../src/components/dashboard/) (`card.tsx`, `grid.ts`, `skeleton.tsx`, and the shipped cards). The advice card follows the same contract: **the loader computes, the card renders**.
- **Alerts** — [alerts.ts](../../src/db/schema/alerts.ts) (`type` text+CHECK, `severity`, `dedup_hash` UNIQUE, `detail jsonb`, `resolved_at`) + [alerts/rules.ts](../../src/lib/alerts/rules.ts) (`RULE_ALERT_TYPES`) + [alerts/notify.ts](../../src/lib/alerts/notify.ts) (`notifyNewAlerts`, content-free). Material-change alerts add **one** new type and reuse all of it, following ADR-026's `price_target` posture exactly.
- **Accounts, snapshots, net worth** — [accounts.ts](../../src/db/schema/accounts.ts), [snapshots.ts](../../src/db/schema/snapshots.ts), and the net-worth/snapshot helpers. Liquid-cash tiering reads the **latest `account_snapshots` row per account**; it does not invent a balance path.
- **Liabilities + amortization** — [liabilities.ts](../../src/db/schema/liabilities.ts) (`principal_at_origination`, `annual_rate`, `term_months`, `start_date`) + [src/lib/mortgage/](../../src/lib/mortgage/). The amortizing side of the debt engine derives its APR and scheduled payment from these — **left completely untouched** by this phase (ADR-033).
- **Categories** — [categories.ts](../../src/db/schema/categories.ts): `kind` ∈ income/expense/transfer is what makes observed-net-income possible at all (transfers are already excluded by construction). `necessity` is a second, orthogonal axis — **not** a replacement for `kind`.
- **Worker + queues** — [src/worker/index.ts](../../src/worker/index.ts) (`upsertJobScheduler` repeatable-job pattern), [queues.ts](../../src/lib/queue/queues.ts) (`QUEUE_NAMES`, `lazyQueue`), [run-once.ts](../../src/worker/run-once.ts).
- **Validation** — Zod at every boundary; `moneyAmountSchema` / `isoDateSchema` in [schemas/account.ts](../../src/lib/schemas/account.ts) are the reuse targets.
- **Settings surfaces** — [settings/categories](../../src/app/settings/categories/) and [settings/income](../../src/app/settings/income/) are the pattern for every new management page (server components + `requireUser`-guarded server actions + `revalidatePath`).

---

## ADRs locked at plan time

Three decisions surface in Phase 15. All ✅ **Locked 2026-08-15** — appended to [IDEAS.md](IDEAS.md) §11 Decision Log as **ADR-032 → ADR-034** (ADR-031 verified as the max after Phase 14) under P15-00.

---

### ADR-032 — Household money guidance as a deterministic, local rules engine: recommend structures and amounts, never products; derived rungs, not user-authored goals

**Status**: ✅ Locked 2026-08-15

**Context**: Round 9 is the first round that asks the app to tell the user what to *do*. Everything through ADR-031 was descriptive. Prescription raises three questions at once: *how* is the recommendation produced (and can it be trusted), *how far* does it go before it becomes financial advice, and *does it collide with ADR-022*, which capped goal tracking at "a single-target marker — no multi-goal planner"?

**Decision**:

1. **A pure rules engine in `src/lib/advice/`.** Every rule is an I/O-free function `(input: AdviceInput) => Recommendation[]`. A single `loadFinancialSnapshot()` performs all DB reads and hands the rules a fully-assembled, typed, money-as-strings snapshot. This is ADR-029's "loader is smart, cards are dumb" applied to advice, and it is what makes the entire surface unit-testable without a database.
2. **Deterministic and explainable, never a model.** CLAUDE.md §Privacy forbids shipping financial data to a hosted LLM, so guidance is rule-based by necessity — and better for it. Each `Recommendation` carries `{ id, severity, title, rationale, benchmark, currentValue, suggestedValue, inputsUsed[], confidence }` and **names the heuristic it implements**. The UI renders `inputsUsed[]` so the user can see *why* and correct a bad input rather than distrust the whole feature.
3. **Computed on read, never stored.** Same principle as ADR-020's unstored yield and ADR-031's derived savings rate: a stored recommendation is a recommendation that goes stale silently. The **only** persisted advice state is `recommendation_dismissals` — because "I have consciously rejected this" is user intent, not a derived figure, and re-nagging is the failure mode ADR-026 already rejected for alerts.
4. **The product boundary.** Recommend a *structure and an amount*; never a security, fund, institution, or product. No tax computation of any kind — `accounts.tax_treatment` exists so the waterfall can *order* containers and drives no math, reaffirming ADR-030's "`pretax` is a label only."
5. **A mandatory unconditional disclaimer** on every advice surface, stronger than ADR-022's projection banner. Not dismissible, not conditional on the rule, not buried in a tooltip.
6. **Waterfall rungs are DERIVED STATE, not goals.** The user cannot create, name, reorder, delete, or assign funding to a rung; every target is computed from their own data (essential expenses, the match cap, a statutory limit). This is a diagnostic checklist, not the multi-goal planner ADR-022 rejected — **that rejection stands unamended**, and ADR-032 cross-references it so a future reader gets the answer in place.

**Consequences**:
- ✅ Every rule is a pure function with crisp I/O — the highest-value TDD surface in the project since PLAN9's performance engine.
- ✅ Recommendations are auditable and correctable; a wrong number points at a wrong *input*, which the user can fix.
- ✅ Zero egress, zero new dependencies, works fully offline.
- ✅ ADR-022 needs no amendment, so the decision log keeps recording genuine changes of mind rather than scope patches.
- ⚠️ Rule quality is bounded by input quality — an unclassified `necessity` or a missing APR degrades a rule to "unknown input." This must render honestly (P15-13's gating), never as a confident wrong number.
- ⚠️ The heuristics encoded are *conventional*, not personalized. The disclaimer is doing real work and is non-negotiable.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| An LLM / "AI advisor" over the user's financial data | CLAUDE.md §Privacy hard-no (no hosted model ever sees this data), and it would be unauditable — the opposite of what a money recommendation needs. |
| Storing generated recommendations in a table | Staleness with no upside; recomputation is cheap and always current. Only *dismissals* are real state. |
| Recommending specific tickers/funds/institutions | Crosses from structure into advice. We are a tracker; the owner asked for help managing money, not a broker. |
| Amending ADR-022 to permit goals | An amendment should record a genuine change of mind. Derived rungs are not the user-authored planner ADR-022 rejected, so the cleaner answer is a boundary clause. |
| Recommendations with no shown inputs | An unfalsifiable number about someone's money is worse than no number. |

---

### ADR-033 — Prerequisite schema for guidance: account `subtype`/`apy`/`maturity_date`/`tax_treatment`, `categories.necessity`, a new `credit_lines` table, `household_profile` + `household_members`, `recommendation_dismissals`; manual-first debt terms

**Status**: ✅ Locked 2026-08-15

**Context**: Each of Round 9's specific asks is blocked on data the app has never modeled. `accounts` has `type` but no `subtype`, so checking, savings, money-market and CD are indistinguishable — which makes "how much to keep on hand and how much in medium-term savings like CD's" unanswerable in principle, not just unimplemented. Emergency funds size against *essential* expenses, but `categories` carries only `kind` ∈ income/expense/transfer. Debt payoff needs APR, limit and minimum payment, which exist nowhere. And the owner explicitly offered household data ("how many household members and age") that has no home — `users` is one row with a password hash, deliberately.

**Decision** — all additive; the one existing table with `NOT NULL` columns (`liabilities`) is **not touched**:

1. **`accounts`** — four nullable additive columns, following the nullable-Plaid and personal-asset precedents: `subtype` text+CHECK ∈ `('checking','savings','money_market','cd','cash_management')`; `apy numeric(7,4)`; `maturity_date date` (CDs); `tax_treatment` text+CHECK ∈ `('taxable','tax_deferred','roth','hsa')`. All CHECKs are **NULL-tolerant**, mirroring `accounts_asset_category_check`.
2. **`categories`** — `necessity` text+CHECK ∈ `('essential','discretionary','savings')`, nullable = unclassified; plus `excluded_from_baseline boolean not null default false` so a refund or reimbursement category can be kept out of the observed-net-income baseline (ADR-034 §1).
3. **A new `credit_lines` table** — revolving terms: `account_id` FK **UNIQUE** (`onDelete: cascade`), `apr numeric(8,6)`, `credit_limit numeric(18,2)`, `minimum_payment numeric(18,2)`, `minimum_payment_percent numeric(7,4)` nullable, `notes`, CHECKs for non-negativity and a sane APR range.
4. **`household_profile`** (singleton, like `users`) — `reserve_months_override integer`, `retirement_target_age integer`, `benchmark_savings_apy numeric(7,4)`, `needs_pct`/`wants_pct`/`savings_pct numeric(5,2)` split overrides, `high_interest_threshold_apr numeric(8,6)`, `currency`. **`household_members`** — `label text`, **`birth_year integer`**, `is_dependent boolean`.
5. **`recommendation_dismissals`** — `rule_id text`, `subject_key text` (the per-subject discriminator, e.g. a category or account id, `''` for whole-rule), `dismissed_at`, `snooze_until` nullable, **UNIQUE `(rule_id, subject_key)`**.
6. **Debt terms are manual-first.** APR / limit / minimum payment are user-editable columns. **Plaid `/liabilities/get` is not enabled.**
7. **Privacy handling of the new PII** — household rows ride the existing `age`-encrypted `pg_dump` (ADR-014) and are **excluded from the ⌘K search index** (ADR-027/028); no trigram index is added to `household_members.label`.

**Consequences**:
- ✅ Every Round 9 ask becomes computable; nothing is left structurally unanswerable.
- ✅ Entirely additive — no `DROP NOT NULL`, no data movement, no risk to shipped mortgage code.
- ✅ Birth *year* gives every age-based rule what it needs with strictly less PII at rest than a birth date.
- ⚠️ New columns are inert until populated. Batch 5 exists precisely so the schema does not ship empty, and every rule must degrade gracefully while it is (ADR-032 consequence 1).
- ⚠️ Manual debt terms go stale if an APR changes and the user does not update it. Surfaced by showing the entry date alongside the figure.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Add revolving columns to `liabilities` | Its `principal_at_origination` / `term_months` / `start_date` are `NOT NULL` and meaningless for a card — this would force `DROP NOT NULL` on a working table for no gain. A separate `credit_lines` is purely additive; the payoff engine unions the two in a helper. |
| `pgEnum` for `subtype` / `necessity` / `tax_treatment` | Project posture is text+CHECK for small evolvable vocabularies (`transactions.source`, `holding_lots.source`, ADR-030's `cadence`). Extending a CHECK beats an enum-add migration. |
| Store full birth dates | Birth year drives every age-based rule identically, with less PII. |
| Enable Plaid `/liabilities/get` | It *is* available on Plaid's free Trial plan, but it is a **per-Item subscription-fee product** on any paid plan, it requires re-linking existing Items through update mode with an added product, and it still would not cover manual accounts the engine must serve anyway. Three rarely-changing numbers per card, typed once, is less total effort. Deferred as an optional pre-fill (Open Item). |
| Fetch live CD / HYSA market rates | A new egress class plus a staleness problem, for marginal gain. A **user-entered benchmark APY** answers "what yield am I forgoing" with zero egress. |
| A `goals` table to anchor medium-term savings | That is the ADR-022 planner. Generic ladder sizing off excess cash needs no goals; dated `planned_expenses` is an Open Item to be justified on real use. |

---

### ADR-034 — Benchmark methodology: observed net income, a median-based essential-expense baseline, a fixed waterfall ordering, year-keyed statutory constants, per-rule minimum-history gating

**Status**: ✅ Locked 2026-08-15

**Context**: The rules are only as honest as their inputs and their arithmetic conventions. Three conventions decide whether this feature is trustworthy: where take-home comes from (ADR-030 stores **gross only**, deliberately, and nearly every household benchmark is stated against take-home), which statistic defines a "normal" month, and what happens when an input is missing or a year rolls over.

**Decision**:

1. **Take-home is OBSERVED, not declared.** Sum `transactions` in categories with `kind='income'`, minus any marked `excluded_from_baseline`. The deposits that actually landed **are** take-home — no tax math, and **ADR-030's gross-only boundary is untouched**. Rather than heuristically filtering bonus/refund outliers, the UI **lists the contributing categories** and lets the user exclude them: auditability over cleverness, the same philosophy as showing each recommendation's `inputsUsed[]`.
2. **Exactly ONE savings rate exists** — the shipped gross-based figure (ADR-031 §4). Observed net is used *only* as the 50/30/20 denominator and as a reserve input, under a **different name**. Pre-tax 401k dollars never appear as a deposit, so a second net-based rate would visibly contradict the first, and two disagreeing rates read as a bug even when both are correct.
3. **Baselines use the MEDIAN (or p75 where a buffer is wanted), not the mean.** Deliberately unlike [forecast.ts](../../src/lib/analytics/forecast.ts), whose trailing mean is correct for *forecasting* and wrong for *target-setting*: one $2,000 transmission repair permanently inflates an Auto budget built on a mean.
4. **A fixed waterfall ordering**: starter buffer → **employer match** → high-interest debt → full 3–6 month reserve → IRA/HSA → 401k to the statutory cap → taxable / medium-term. Each rung reports `done` / `in_progress` / `blocked` / `unknown_input`, with the reason.
5. **Statutory constants are YEAR-KEYED and fail loud.** `limitsForYear(year)` returns `null` when the year is unconfigured, which **suppresses that rung** with "limit not configured for YYYY" rather than silently applying last year's dollars to this year's money.
6. **The high-interest threshold is a visible, user-tunable default** (`household_profile.high_interest_threshold_apr`), not a magic number buried in a rule.
7. **Every rule declares `minMonthsHistory`** and renders ADR-021's "insufficient history" rather than a confident wrong number. A two-month-old install must not confidently recommend budgets.

**Consequences**:
- ✅ Household benchmarks become computable without reopening ADR-030 or building a tax engine.
- ✅ Outlier-resistant targets; the app stops recommending a budget inflated by a one-off.
- ✅ January cannot silently produce wrong contribution guidance.
- ⚠️ Observed net is only as clean as the user's income categorization. Mitigated by the contributing-category list + `excluded_from_baseline`, not by hidden heuristics.
- ⚠️ **The model assumes a steady paycheck.** Variable and self-employed income is a *stated assumption*, not a solved case (Open Item).

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| An optional `net_per_period` column on `income_sources` | Reopens ADR-030's "gross and nothing about taxes," and goes stale at every raise. Observed deposits are self-correcting. |
| A second, net-based savings rate | Two rates that disagree read as a bug. One rate, one definition. |
| Trailing **mean** baselines (reuse `forecastMonthlySpend` as-is) | Outlier-fragile for target-setting; a single large repair permanently inflates the target. |
| Hardcoding one year's IRS limits | Silently wrong every January — the worst kind of wrong for a money app. |
| Auto-detecting recurring/fixed expenses to derive "essentials" | `categories.necessity` is explicit and user-correctable; a cadence detector is guessing where an answer is available. Open Item. |

---

## Batches

> Each task is atomic and independently reviewable. Task IDs are `P15-NN`. Batches land as separate commits/PRs following the Phase 11–14 cadence. **P15-00 gates everything** — no code before the scope note + ADRs are recorded.

### Batch 0 — Scope gate + ADRs

- **P15-00** — Record the §Domain Scope + §Privacy + §Money scope note (structures and amounts only; no LLM; no product recommendations; no tax math; ADR-022 goals boundary intact; zero egress; Decimal-only) in this plan's header (done above); append **ADR-032 → ADR-034** to [IDEAS.md](IDEAS.md) §11 Decision Log (verify ADR-031 is the max at commit time); add the Round 9 → Phase 15 section to [FEATURE.md](FEATURE.md) mirroring the ADR-018/ADR-030 "owner explicitly asked, so it's in scope" framing. **Gate: nothing in Batch 1+ starts until this is committed.**

### Batch 1 — Prerequisite schema + migration

- **P15-01** — [accounts.ts](../../src/db/schema/accounts.ts): add `subtype`, `apy numeric(7,4)`, `maturity_date date`, `tax_treatment` per ADR-033 §1, with **NULL-tolerant** CHECKs mirroring `accounts_asset_category_check`. Export the two vocabularies as `const` tuples + types (the `INCOME_CADENCES` precedent). Do **not** backfill a default subtype — an unset subtype must stay distinguishable from a deliberate one.
- **P15-02** — [categories.ts](../../src/db/schema/categories.ts): add `necessity` text+CHECK (nullable = unclassified) and `excluded_from_baseline boolean not null default false` per ADR-033 §2. Export `CATEGORY_NECESSITIES`. Note in the file header that `necessity` is **orthogonal to `kind`**, not a replacement.
- **P15-03** — `src/db/schema/credit-lines.ts`: the `credit_lines` table per ADR-033 §3 — `account_id` FK UNIQUE `onDelete: cascade`, `apr numeric(8,6)`, `credit_limit`, `minimum_payment`, `minimum_payment_percent`, `notes`, non-negativity + APR-range CHECKs, FK index. Relations to `accounts`. `$inferSelect`/`$inferInsert` exports.
- **P15-04** — `src/db/schema/household.ts`: `household_profile` (singleton — document the one-row invariant the way [users.ts](../../src/db/schema/users.ts) does) + `household_members` (`label`, `birth_year integer` with a sane-range CHECK, `is_dependent`). **No trigram index on `label`** — ADR-033 §7; add a comment saying so explicitly so a future search phase does not add one reflexively.
- **P15-05** — `src/db/schema/recommendation-dismissals.ts`: `rule_id`, `subject_key`, `dismissed_at`, `snooze_until`, **UNIQUE `(rule_id, subject_key)`**. Document that this is the *only* persisted advice state (ADR-032 §3).
- **P15-06** — Re-export everything new from [src/db/schema/index.ts](../../src/db/schema/index.ts); confirm no identifier exceeds Postgres' 63-char limit (the `income_contributions` FK-naming lesson from P14-03 — name FKs explicitly if near the bound).
- **P15-07** — `pnpm drizzle-kit generate`; verify the migration applies cleanly against a fresh DB (`make db-reset` + migrate) **and** against a populated dev DB (all changes are additive/nullable, so both must pass). Confirm typecheck + `pnpm build` green.

### Batch 2 — Baseline computation (the inputs every rule consumes)

- **P15-08** — `src/lib/advice/net-income.ts`: `observedNetIncome(window)` per ADR-034 §1 — monthly series from `kind='income'` categories minus `excluded_from_baseline`, returning `{ monthly[], trailingMedian, contributingCategories[] }`. Reuses the [spending.ts](../../src/lib/analytics/spending.ts) query shape. **Vitest**: excluded categories drop out; transfers never appear; a bonus month does not move the median much.
- **P15-09** — `src/lib/advice/essential-expenses.ts`: `essentialMonthlyBaseline(window)` — trailing **median** of `necessity='essential'` expense plus minimum debt service, with `unclassifiedShare` reported so the UI can say "18% of your spend is unclassified; this estimate is low." **Vitest** incl. the all-unclassified degenerate case.
- **P15-10** — `src/lib/advice/cash-tiers.ts`: pure `classifyCashTiers(accounts, latestBalances, essentialMonthly, profile)` → `{ operating, reserve, mediumTerm, unclassified }` totals per ADR-033 §1 subtypes. **Vitest** across subtype coverage and the "no subtype set" degradation.
- **P15-11** — `src/lib/advice/debt-terms.ts`: `unifyDebtTerms()` — union `liabilities` (amortizing: APR from `annual_rate`, scheduled payment via [src/lib/mortgage/](../../src/lib/mortgage/)) and `credit_lines` (revolving) into one `DebtTerm[]` (`{ accountId, kind, balance, apr, minimumPayment, creditLimit? }`), balances from the latest `account_snapshots` row per account. **Vitest** for both branches and for a debt with no terms recorded (→ `unknown_input`, never silently zero).
- **P15-12** — `src/lib/advice/snapshot.ts`: `loadFinancialSnapshot()` — **the one and only DB-reading function in the advice layer** (ADR-032 §1). Assembles net income, essential baseline, cash tiers, debt terms, contribution rules + YTD contributions, household profile + members, budgets, holdings totals, and a `historyMonths` depth figure for the gating in P15-13. Returns a typed, money-as-strings `AdviceInput`. Every downstream rule is pure.

### Batch 3 — The rules engine (pure functions, TDD)

- **P15-13** — `src/lib/advice/types.ts`: `Recommendation`, `RuleId`, `Severity`, `RungState` (`done`/`in_progress`/`blocked`/`unknown_input`), and the `Rule` interface (`id`, `minMonthsHistory`, `evaluate(input): Recommendation[]`). Discriminated unions throughout (CLAUDE.md §TypeScript). Include the `inputsUsed[]` shape that the UI renders — this is the ADR-032 §2 contract, so define it once here.
- **P15-14** — `src/lib/advice/constants.ts`: year-keyed statutory limits (401(k) elective deferral, IRA, HSA self/family, catch-up thresholds) exposed as `limitsForYear(year): Limits | null`, **returning `null` for unconfigured years** (ADR-034 §5); plus default reserve months, the default high-interest APR threshold, and the default 50/30/20 split. **Vitest** covering the unconfigured-future-year path explicitly — this is the test that stops January from lying.
- **P15-15** — `src/lib/advice/rules/emergency-fund.ts`: multiplier from household (dependents or single income concentration → 6 months, else 3; `reserve_months_override` wins), target = months × essential baseline, compared against the reserve tier; reports the gap and months-to-close at the current surplus rate. **Vitest** across multiplier selection, override, funded, and unknown-input cases.
- **P15-16** — `src/lib/advice/rules/employer-match.ts`: the match-gap rule — reads `retirement_contributions` and reports unclaimed employer dollars per year. **Needs no new data; computable from what PLAN14 already shipped.** **Vitest** across every `match_basis` value plus the `match_cap_percent` boundary and the already-maximized case.
- **P15-17** — `src/lib/advice/rules/high-interest-debt.ts`: flags debts above the threshold (P15-14/profile) and orders them. **Vitest**.
- **P15-18** — `src/lib/advice/payoff.ts`: the **avalanche vs. snowball simulator** — month-by-month, Decimal-only, accruing interest and applying minimums plus the snowball surplus; returns `{ order[], monthsToDebtFree, totalInterest }` for each strategy plus the delta. **This is the sharpest math in the phase** (CLAUDE.md §Money: a float here compounds into a wrong answer). **Vitest first**: single debt, tie-breaking, a debt whose minimum does not cover interest (must terminate and report `blocked`, never loop forever), and avalanche-beats-snowball-on-interest as an invariant.
- **P15-19** — `src/lib/advice/rules/utilization.ts`: credit utilization per card and overall from `credit_limit` vs balance, flagged against a conventional threshold. **Vitest** incl. no-limit-recorded → `unknown_input`.
- **P15-20** — `src/lib/advice/rules/cash-drag.ts`: excess beyond operating + reserve; suggests an **N-rung equal-amount ladder structure** with staggered maturities, and — only when both the account APY and `benchmark_savings_apy` are present — the forgone-yield figure. **Never names a product or institution** (ADR-032 §4). **Vitest** incl. the no-excess and no-APY paths.
- **P15-21** — `src/lib/advice/rules/contribution-pacing.ts`: YTD employee contributions (from `income_contributions` by `pay_date`) vs. the year's limit; on-pace projection to year end; **suppressed entirely when `limitsForYear` returns null**. **Vitest** incl. the unconfigured-year suppression.
- **P15-22** — `src/lib/advice/rules/waterfall.ts`: the ordered rung state machine per ADR-034 §4, composing P15-15/16/17/20/21 plus the starter buffer, IRA/HSA (ordered by `accounts.tax_treatment`, **no tax math**), and taxable/medium-term. Each rung yields a `RungState` **with its reason**. **Vitest** for ordering stability, for correct `unknown_input` propagation when an input is missing, and for the property that no rung is ever reported `done` on absent data.
- **P15-23** — `src/lib/advice/engine.ts`: `runAdvice(input, dismissals, today)` — runs every rule, applies `minMonthsHistory` gating (ADR-034 §7), filters dismissed/snoozed, sorts by severity then impact. **Vitest** for gating, dismissal filtering, snooze expiry.

### Batch 4 — Budget recommendations

- **P15-24** — `src/lib/advice/budget-suggest.ts`: `suggestBudgets(monthlyByCategory, options)` — per-category target from the trailing **median or p75** (ADR-034 §3), returning `{ categoryId, suggested, observedRange, basisMonths, confidence }`. **Vitest**: an outlier month must not move the suggestion the way a mean would — assert this against `forecastMonthlySpend` on the same fixture so the divergence is documented by test, not comment.
- **P15-25** — `src/lib/advice/rules/budget-coverage.ts`: categories with material spend and **no** budget; budgets diverged far from actuals for N consecutive months. **Vitest**.
- **P15-26** — `src/lib/advice/rules/needs-wants-split.ts`: the 50/30/20 diagnostic — bucket spend by `necessity`, compare against observed net income, honor the `household_profile` split overrides. Framed as a **diagnostic, not a prescription** ("your needs are 62% of take-home vs. your 50% target"). **Vitest** incl. the unclassified-share caveat and a custom split.
- **P15-27** — Apply-suggestions server action: **preview → confirm**, never a silent bulk mutation (the importer posture from CLAUDE.md §Importers). Writes exclusively through the existing `setBudget` ([budgets/queries.ts](../../src/lib/budgets/queries.ts)); no parallel write path. Zod-validated, `requireUser`-guarded, `revalidatePath`.

### Batch 5 — Data-entry surfaces (make the new columns real)

- **P15-28** — `src/lib/schemas/advice.ts`: Zod schemas for every new input — account subtype/APY/maturity/tax-treatment (refine: `maturity_date` only meaningful when `subtype='cd'`; APY within a sane range), credit-line terms, category necessity + baseline exclusion, household profile (split percentages must sum to 100) and members (birth year within a sane range). Reuse `moneyAmountSchema` / `isoDateSchema` from [schemas/account.ts](../../src/lib/schemas/account.ts). **Vitest** for every refinement.
- **P15-29** — Account edit flow: subtype / APY / maturity / tax-treatment fields, shown **conditionally by account type** (subtype + APY + maturity for `depository`; tax treatment for `investment`/`crypto_ira`). Server action + `revalidatePath`.
- **P15-30** — Credit-line terms entry on `credit_card` accounts (APR, limit, minimum payment or percent), with the **entry date shown alongside** so a stale APR is visible as stale (ADR-033 consequence 2).
- **P15-31** — Category necessity classification in the existing [settings/categories](../../src/app/settings/categories/) manager: inline per-category control plus a **bulk "classify unclassified" pass**, and the `excluded_from_baseline` toggle on income-kind categories. Surface the unclassified share as a nudge, since P15-09's honesty depends on it.
- **P15-32** — `src/app/settings/household/page.tsx` + `actions.ts`: profile (reserve-months override, retirement target age, benchmark savings APY, split overrides, high-interest threshold) + member CRUD (label, birth year, dependent). `requireUser`-guarded. Include a short in-page privacy note stating this data never leaves the box (it is the most personal data the app has ever asked for — say so plainly).

### Batch 6 — Delivery surfaces

- **P15-33** — `src/app/plan/page.tsx`: the guidance surface — server component, `requireUser`-guarded, calling `loadFinancialSnapshot()` → `runAdvice()`. Renders the **waterfall ladder** (each rung with its state and reason) above the ranked recommendation list; each recommendation shows its rationale, the benchmark it implements, and its `inputsUsed[]`. **The mandatory unconditional disclaimer banner (ADR-032 §5) is part of this task, not a follow-up.** Add `/plan` to the nav.
- **P15-34** — Dismiss / snooze server action writing `recommendation_dismissals` (UNIQUE upsert), with an "undo" affordance and a way to view dismissed items. Zod-validated, `requireUser`-guarded.
- **P15-35** — Dashboard card (`src/components/dashboard/advice-card.tsx`): the **single** highest-severity open recommendation plus the waterfall's current rung, linking to `/plan`. Wire an `advice` slot into `DashboardData` / `loadDashboard` ([dashboard/loader.ts](../../src/lib/dashboard/loader.ts)) — **the loader computes, the card renders** (ADR-029). Empty state when no input exists yet.
- **P15-36** — Material-change alerts: add **one** new type `'advice'` to the [alerts](../../src/db/schema/alerts.ts) `type` CHECK; **deliberately NOT in `RULE_ALERT_TYPES`** (exempt from the resolve-sweep, exactly like `price_target` and `backup_failure`). A `dedup_hash` over `(rule_id, subject_key, state)` so a **standing** condition never re-nags — only a genuine state change fires. Figures live in `detail`, never the title (ADR-015). A thin daily `evaluate-advice` job chained after `compute-snapshots-daily`, registered via `upsertJobScheduler` in [src/worker/index.ts](../../src/worker/index.ts) + `QUEUE_NAMES` in [queues.ts](../../src/lib/queue/queues.ts), reusing the content-free `notifyNewAlerts`.
- **P15-37** — Graceful degradation pass across every surface (ADR-029 §5 + ADR-034 §7): no history → "insufficient history"; no household → generic multipliers with a "add household details to refine" prompt; no subtypes → cash tiering shows `unclassified` with a link to fix it; no APRs → debt rungs show `unknown_input`, never a confident zero. **Every empty state must name the missing input and link to where to supply it.**

### Batch 7 — Tests, docs, privacy pass, E2E

- **P15-38** — Vitest sweep (gather): baselines (P15-08/09/10/11), constants incl. unconfigured-year (P15-14), every rule (P15-15→22), the payoff simulator's termination and invariants (P15-18), the engine's gating/dismissal (P15-23), budget suggestion vs. forecast divergence (P15-24), needs/wants (P15-26), and the Zod refinements (P15-28). Confirm complete + green. These are all "always-test" surfaces — money math driving user decisions.
- **P15-39** — **Privacy regression test** (mandatory, CLAUDE.md §Privacy): assert **no module under `src/lib/advice/` makes or imports outbound HTTP** (the strongest form of this test in the codebase — the advice layer's egress budget is exactly zero); assert no balance, income, or recommendation figure reaches a logger; assert `household_members.label` is **not** reachable from the ⌘K search route handler (ADR-033 §7); assert the advice alert `detail` is not included in the notification email body.
- **P15-40** — `docs/GUIDANCE.md`: the rules catalog (each rule, the heuristic it implements, its inputs, its `minMonthsHistory`), the waterfall ordering and what each rung means, how observed net income is derived and how to correct it, the manual debt-terms workflow and the Plaid-Liabilities deferral, the constants-staleness behavior every January, and the explicit scope boundaries (structures not products, no tax math, no goals, no LLM). Link from [README.md](../../README.md) + [FEATURE.md](FEATURE.md); cross-link [docs/INCOME.md](../../docs/INCOME.md) (the one true savings rate) and [docs/DASHBOARD.md](../../docs/DASHBOARD.md).
- **P15-41** — **Playwright** E2E (one focused flow, per CLAUDE.md §Testing Philosophy): seed income + spend history + a depository account with a subtype + a credit line; set household details; visit `/plan`; assert the waterfall renders with the employer-match rung in a determinate state, apply a suggested budget through preview → confirm, and dismiss a recommendation and confirm it disappears and stays gone. Keep it to this single critical path.

---

## Skills Map (when each pays off this phase)

Per [SKILLS.md](SKILLS.md) §Suggested Workflow — invoke at the moment of leverage, not preemptively:

- **`test-driven-development`** — Batches 3–4. **The highest-TDD-payoff phase in the project.** Every rule is a pure function with crisp I/O and nasty edges; the payoff simulator (P15-18) and the constants gate (P15-14) should have failing tests before a line of implementation.
- **`typescript-pro`** — Batch 3 (the `RungState` / `Recommendation` discriminated unions, the `Rule` interface, keeping money as branded strings end-to-end).
- **`drizzle-orm-expert`** — Batch 1 (four additive account columns with NULL-tolerant CHECKs, the new tables, the UNIQUE dismissal key, FK indexing).
- **`postgres-best-practices`** — Batch 1 (numeric precision on APR/APY, CHECK design, FK indexes, the 63-char identifier limit).
- **`zod-validation-expert`** — Batch 5 P15-28 (the split-sums-to-100 and CD-maturity refinements).
- **`nextjs-app-router-patterns`** — Batches 5–6 (the settings surfaces, `/plan`, the dashboard slot, server actions + `revalidatePath`).
- **`bullmq-specialist`** — Batch 6 P15-36 (the daily `evaluate-advice` job, the chain-after-snapshots ordering, dedup-driven idempotency).
- **`e2e-testing-patterns`** — Batch 7 P15-41 (the single Playwright guidance flow).
- **`systematic-debugging`** — reactive, if a rule produces an implausible figure (check the pure-function tests and the rendered `inputsUsed[]` before touching the loader).

Note in each batch's PLAN task which skill was the reference when invoked for real (per [SKILLS.md](SKILLS.md) §Maintenance).

---

## Open Items (deferred — record, don't build)

- **Plaid `/liabilities/get` as an APR/limit pre-fill** — manual entry ships first (ADR-033 §6). Revisit only if hand-maintaining card terms actually chafes; note it is a per-Item subscription-fee product on any paid Plaid plan and needs Items re-linked through update mode.
- **`planned_expenses` (dated medium-term goals)** — generic equal-rung ladders ship first (P15-20). A known dated expense (`label`, `amount`, `target_date`) would size rungs precisely; justify it on real use, not speculation. Note this is still **not** an ADR-022 goal (no projection, no progress tracking, no priority ranking).
- **User-authored goals with per-goal projections** — remains rejected under ADR-022. If ever wanted, it needs its own ADR justified by wanting *that feature*, not by guidance needing it.
- **Live CD / HYSA rate fetching** — rejected in ADR-033 in favor of a user-entered benchmark APY. Revisit only with a §Privacy-clean source and a staleness story.
- **Recurring / fixed-expense detection** — `categories.necessity` is explicit and correctable; a merchant-cadence detector is guessing where an answer exists. Reconsider if the unclassified share stays stubbornly high in real use. **✅ Resolved 2026-08-23 — and this reasoning was reaffirmed, not reversed.** [PLAN16.md](PLAN16.md) ships a merchant-cadence detector under **ADR-036 §1**, and the deferral above still holds for the question it was answering. `necessity` answers *"is this essential?"* — a **classification** question, where an explicit, correctable answer already exists and a detector would be guessing over it. Round 10 asks *"when does it land, and for how much?"* — a **timing** question on an orthogonal axis that `necessity` cannot answer at any level of classification quality. Detection in Phase 16 therefore **schedules; it does not classify**: it never writes, reads, or infers `necessity`, and a confirmed obligation inherits its `category_id` from the transactions that produced it. It also never auto-commits — it emits candidates the user confirms (ADR-036 §2), so it is not "guessing where an answer exists" in the sense this bullet warned about.
- **Variable / self-employed income** — the whole model assumes a steady paycheck cadence, which `income_sources` enforces structurally. A stated assumption, not a solved case.
- **Roth vs. traditional ordering math, tax-loss harvesting, withdrawal sequencing** — permanently out under CLAUDE.md §Domain Scope; `tax_treatment` orders containers and computes nothing.
- **Education / 529 accounts, insurance adequacy, estate planning** — out of scope; dependents in `household_members` inform reserve sizing only.
- **Tiered employer match** — still open from PLAN14; the match-gap rule (P15-16) inherits the single-tier limitation.
- **Hard double-count guard (income vs. Plaid on one holding)** — still open from PLAN14; unchanged by this phase.

---

*End of PLAN15.md*
