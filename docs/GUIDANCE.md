# Household money guidance (Phase 15)

Everything through Phase 14 was **descriptive**: here is what you spent, what you
hold, what you contributed, what it projects to. This phase is the first that is
**prescriptive** — it looks at the data the app already has and says what to do
about it.

Two properties make that safe to build.

**It is a rules engine, never a model.** Every recommendation is a pure function
of your own data that names the heuristic it applies and lists the inputs it
used. Nothing is sent anywhere; there is no model to be wrong in ways you cannot
inspect. If a number looks off, the recommendation tells you which input produced
it, and you can fix the input.

**It recommends structures and amounts, never products.** *"Split the $18k above
your reserve across a 4-rung ladder maturing every 3 months"* is in scope.
*"Buy VOO at Vanguard"* is not, and never will be.

**It is US-specific.** The rungs implement US retirement accounts
(401(k)/403(b)/457, IRA, HSA) and IRS contribution limits. Outside the US they
will not produce meaningful output (ADR-053 §1).

Locked by **ADR-032** (the engine and its boundaries), **ADR-033** (the
prerequisite schema), and **ADR-034** (benchmark methodology) in
[IDEAS.md](../plans/features/IDEAS.md) §11; task breakdown in
[PLAN15.md](../plans/features/PLAN15.md).

> **This is not financial advice.** The app says so, unconditionally, on every
> surface that shows a recommendation — see §The disclaimer below. The heuristics
> here are *conventional*, not personalized. The app does not know your taxes,
> your job security, your health, or anything you have not recorded in it.
>
> **Scope (binding — CLAUDE.md §Domain Scope).** No AI or LLM advisor over your
> financial data — guidance is deterministic or it does not ship. No specific
> security, fund, institution, or product is ever named. **No tax computation of
> any kind**: `accounts.tax_treatment` exists so the waterfall can *order*
> containers and drives no math, reaffirming ADR-030's "`pretax` is a label
> only." No Roth-vs-traditional analysis, no tax-loss harvesting, no withdrawal
> sequencing, no Monte Carlo retirement planning (ADR-022 — still rejected). No
> user-authored goals: waterfall rungs are **derived state** you cannot create,
> name, reorder, or fund, which is exactly why ADR-022 stands unamended.
>
> **Privacy (binding — CLAUDE.md §Privacy).** The advice engine makes **zero
> outbound HTTP on any code path** — not "no new egress class" as in earlier
> phases, but literally none. Every benchmark constant (statutory limits, reserve
> multipliers, the needs/wants split) is **checked into this repository**, never
> fetched. The "what yield am I forgoing" figure uses a **benchmark APY you
> type**, never a live rate feed. Household member names and birth years are the
> most personal data the app has ever asked for: they live in local Postgres,
> ride the nightly `age`-encrypted `pg_dump`, are **deliberately excluded from
> the ⌘K search index** (ADR-033 §7), and never appear in the content-free alert
> email. No income, balance, or recommendation figure is ever logged. A
> regression test
> ([privacy-egress.test.ts](../src/lib/advice/privacy-egress.test.ts)) fails the
> build if any of that stops being true — it audits the advice layer against an
> **allowlist** of imports, so a dependency nobody thought to ban still trips it.

---

## Where to find it

| Surface | What it shows |
|---|---|
| **`/plan`** | The full guidance page: the waterfall ladder, then the ranked recommendations, each with its rationale, the heuristic it implements, and the inputs it used. |
| **Dashboard card** | The single most urgent open recommendation plus your current rung, linking to `/plan`. |
| **`/alerts`** | A *material change* in guidance — a new critical or warning item. A standing condition never re-fires (see §Alerts). |
| **`/settings/household`** | Household members, reserve override, benchmark APY, split overrides, high-interest threshold. |

---

## The waterfall

The core of the feature is a **fixed ordering** (ADR-034 §4). Every household
argument about "should I pay down the card or fund the IRA" has a conventional
answer, and the ordering encodes it once:

| # | Rung | Satisfied when |
|---|---|---|
| 1 | **Starter buffer** | You hold $1,000 in cash. A deliberately small, flat figure whose only job is to stop the next flat tire from becoming credit-card debt. |
| 2 | **Employer match** | You are contributing enough to capture the full employer match. This is the highest guaranteed return available to a household and it sits above debt payoff for that reason. |
| 3 | **High-interest debt** | No debt remains above your threshold (default **7% APR**, tunable). |
| 4 | **Full emergency reserve** | Your reserve tier covers 3–6 months of essential expenses. |
| 5 | **IRA and HSA** | Ordered by `tax_treatment`. **No tax math is performed** — the label orders the containers and computes nothing. |
| 6 | **Workplace plan to the annual cap** | On pace to use the year's elective-deferral room. |
| 7 | **Taxable and medium-term savings** | Everything above. Where the cash-drag ladder suggestion lands. |

Each rung reports one of four states, **with its reason**:

- **`done`** — satisfied, on data the app actually has.
- **`in_progress`** — this is your current focus.
- **`blocked`** — something earlier must happen first.
- **`unknown_input`** — *the app cannot tell.* Rendered in amber, and deliberately
  unlike `done`, because the single most damaging thing this feature could do is
  let "we cannot tell" read as "you are fine."

A rung is **never** reported `done` on absent data. That property has its own
test, and it is the one worth keeping if you only keep one.

> **The IRA/HSA rung has a known limitation.** The app tracks *payroll*
> contributions (ADR-030). An IRA you fund by bank transfer in April leaves no
> record it can read, and a balance is not a contribution — so this rung will
> under-report if you fund outside payroll. It says so rather than guessing.

---

## The rules catalog

Every rule is a pure function in [`src/lib/advice/rules/`](../src/lib/advice/rules/).
`Min. history` is ADR-034 §7's gating: below it, the rule renders "insufficient
history" instead of a confident wrong number.

| Rule | Heuristic it implements | Reads | Min. history |
|---|---|---|---|
| **`emergency_fund`** | 3–6 months of essential expenses held in liquid savings | Essential-expense baseline, reserve tier, household members | 3 months |
| **`employer_match`** | Contribute at least enough to capture the full employer match | `retirement_contributions` (match basis / value / cap) | 0 |
| **`high_interest_debt`** | Pay down anything above the threshold before investing the same dollar | Unified debt terms (APR) | 0 |
| **`credit_utilization`** | Keep each card, and the total, under 30% of its limit | `credit_lines` limit vs. balance | 0 |
| **`cash_drag`** | Cash beyond operating + reserve belongs somewhere it earns | Cash tiers, account APY, benchmark APY | 3 months |
| **`contribution_pacing`** | Use as much of the year's elective-deferral room as cash flow allows | `income_contributions` by pay date vs. `limitsForYear` | 0 |
| **`budget_coverage`** | Material spend should have a budget; a budget that misses 3 months running is the wrong budget | Budgets vs. actuals | 3 months |
| **`needs_wants_split`** | The 50/30/20 diagnostic | Spend by `necessity` vs. observed net income | 6 months |
| **`waterfall`** | The composition above | Everything | 3 months |

Two thresholds worth knowing: credit utilization flags at **30%** and escalates
at **90%** (a maxed card is a different conversation from "a bit high"). The
cash-drag rule stays quiet below **$2,000** of excess — a four-rung ladder over
$600 is $150 a rung, and your time is worth more than the yield difference.

### Why every recommendation shows its inputs

Each one renders an **inputs-used** list: the figures it consumed, and where each
came from. This is ADR-032 §2, and it is the difference between a number you can
argue with and one you can only distrust.

A missing input is the most important row in that list, so it renders in amber as
**"not recorded"** — never as a blank, and never as a zero.

---

## How observed net income is derived

Nearly every household benchmark is stated against **take-home**, and the app
deliberately stores gross only (ADR-030). So take-home is **observed, not
declared**: the deposits that actually landed *are* take-home.

It is the sum of transactions in categories with `kind='income'`, minus any
category marked `excluded_from_baseline`. No tax math, and ADR-030's gross-only
boundary is untouched.

**To correct it**, go to `/settings/categories`. The app lists the contributing
categories rather than trying to filter bonuses and refunds heuristically — a
tax refund is not income, but only you know that the "Reimbursements" category is
your employer paying back a flight. Auditability over cleverness.

There is still **exactly one savings rate** in the app — the gross-based figure
from Phase 14 ([INCOME.md](INCOME.md)). Observed net is used only as the 50/30/20
denominator and as a reserve input, under a different name. Two rates that
disagree read as a bug even when both are correct.

### Baselines use the median, not the mean

Deliberately unlike [`forecast.ts`](../src/lib/analytics/forecast.ts), whose
trailing mean is correct for *forecasting* and wrong for *target-setting*. One
$2,000 transmission repair permanently inflates an Auto budget built on a mean —
you would then miss that budget in five months out of six. The divergence is
pinned by a test that runs both on the same fixture.

---

## Cash tiering

"How much on hand, how much in medium-term savings" is unanswerable without
knowing which account is which, so `accounts.subtype` drives it:

| Subtype | Tier | Meaning |
|---|---|---|
| `checking`, `cash_management` | **Operating** | Pays this month's bills. Target: 1 month of essentials. |
| `savings`, `money_market` | **Reserve** | The emergency fund. Liquid, no maturity. |
| `cd` | **Medium-term** | Committed, maturity-dated. Where excess above the reserve belongs. |
| *unset* | **Unclassified** | Counted, but reported separately — see below. |

An unset subtype stays **distinguishable from a deliberate one**; there is no
backfilled default. Unclassified cash is shown as its own line with a link to fix
it, because a reserve figure that silently swallowed your CD would be wrong in the
direction that makes you feel safer than you are.

---

## Debt terms are manual-first

APR, credit limit, and minimum payment are entered by hand on the account page.
**Plaid `/liabilities/get` is not enabled** — it is a per-Item subscription-fee
product on any paid plan, requires re-linking existing Items through update mode,
and still would not cover manual accounts the engine has to serve anyway. Three
rarely-changing numbers per card, typed once, is less total effort.

The **entry date is shown alongside** each figure, so a stale APR is visible as
stale rather than quietly wrong.

Mortgages and other amortizing debts need nothing typed: APR and scheduled
payment derive from the existing `liabilities` row.

A debt with **no APR recorded** reports `unknown_input` and is excluded from
payoff ordering. It is never treated as 0%, which would silently sort it last.

### Payoff ordering

The engine simulates both **avalanche** (highest APR first) and **snowball**
(smallest balance first) month by month, accruing interest and rolling each
cleared debt's minimum into the next. It reports months-to-debt-free and total
interest for each, plus the delta.

If a debt's minimum payment does not cover its monthly interest, the simulation
reports **`blocked`** and stops — it does not loop forever, and it does not
pretend a payoff date exists.

---

## What happens every January

Statutory limits are **year-keyed and fail loud** (ADR-034 §5). `limitsForYear()`
returns `null` for a year that is not in the table, which **suppresses that rung**
with *"The contribution limit is not configured for 2027"*, naming the file to
edit (ADR-053 §2), rather than silently applying last year's dollars to this
year's money.

The table is hand-maintained in
[`constants.ts`](../src/lib/advice/constants.ts). **Settings → Instance** lists
the configured years and warns once this year or next is missing.

**To update it:** the IRS announces the following year's figures each autumn. Add
a row to `STATUTORY_LIMITS`, and the pacing rule and the workplace rung come back
to life on their own. **Do not carry a year forward.** The honest failure mode of
a stale hand-maintained table is silence, not confident wrong dollars.

---

## Dismissing a recommendation

The **only** persisted advice state is `recommendation_dismissals`. Everything
else is computed on read, because a stored recommendation is one that goes stale
silently.

- **Not now (30 days)** / **Not this quarter (90 days)** — a snooze, stored as an
  absolute expiry. The item returns on its own.
- **Dismiss for good** — indefinite.
- **Undo** — a delete. "I want to see this again" is the absence of a dismissal,
  not a third state.

Dismissals are per `(rule, subject)`, so hiding the advice about one card does
not hide it for the other. Everything you have hidden is listed at the bottom of
`/plan` with its date and a restore button — an irreversible, invisible dismissal
would be a page that quietly stopped mentioning a $9,000 balance because of a
click nine months ago.

---

## Alerts

Guidance adds **one** alert type, `advice`, evaluated nightly right after the
snapshot job (chaining, not a separate cron — evaluating against yesterday's
balances would fire alerts that are already wrong by morning).

Only **critical** and **warning** items alert. An `info` nudge is not an
interruption.

**A standing condition never re-nags.** The dedup hash covers
`(rule, subject, severity|status)` and **deliberately excludes the amount** —
folding in the impact figure would make every cent of balance drift a fresh
"material change," which is the same nightly nag wearing a disguise. Only a
genuine state change fires.

`advice` alerts are **not auto-resolved**, unlike most rule alerts. A rule can go
quiet for two very different reasons — the household fixed the problem, or an
input it depended on went missing — and auto-resolving would treat those
identically, announcing good news the app has no evidence for.

Per ADR-015, the alert **title carries no figures** (a recommendation's own title
routinely does — *"Build your emergency fund to $18,000.00"*). The figures live in
`detail`, visible only in the authenticated UI. The email remains a doorbell: a
count, a date, and a sign-in link.

---

## When the app doesn't have enough to go on

Every empty state names the missing input and links to where to supply it. A "no
data" message tells you the app is broken; *"2 cash accounts have no type set"*
tells you what to do.

| Missing | What degrades | Where to fix it |
|---|---|---|
| Transaction history | Everything — the page says so plainly | `/transactions` |
| Category `necessity` | Essential baseline is low, so reserve targets are low. The unclassified share is stated as a percentage. | `/settings/categories` |
| Account `subtype` | Cash tiering shows the balance as unclassified | `/accounts` |
| Debt APR | Payoff ordering and the high-interest rung report `unknown_input` | `/accounts` |
| Observed net income | The 50/30/20 diagnostic has no denominator | `/settings/categories` |
| Household details | Generic 3-month multipliers instead of a sized reserve | `/settings/household` |

There is no error state on `/plan` — only progressively less to say.

---

## The disclaimer

Every advice surface carries an unconditional banner (ADR-032 §5). It is not
dismissible, not conditional on the rule, and not buried in a tooltip — a
stronger commitment than ADR-022's projection banner, because the forecast page
shows a number you know is a guess, while this page uses the imperative mood, and
a sentence that starts *"pay down"* needs to be bounded more firmly than one that
starts *"projected"*.

---

## Stated assumptions

- **A steady paycheck.** The income model assumes a regular cadence. Variable and
  self-employed income is a stated assumption, not a solved case.
- **Conventional heuristics.** 3–6 months, 50/30/20, 30% utilization, match-first
  ordering — these are widely-held rules of thumb, not optimization.
- **Single-tier employer match.** Inherited from Phase 14; a tiered match is not
  modeled.
- **Your classification quality.** An unclassified `necessity` or a missing APR
  degrades a rule to "unknown input" — honestly, and visibly, but it degrades.

---

## See also

- [CASHFLOW.md](CASHFLOW.md) — the timing half: when the money actually moves, and what
  that leaves. This page says where a dollar *should* go; that one says whether it is
  there on the 14th
- [ATTRIBUTION.md](ATTRIBUTION.md) — why net worth moved over a window. It reuses this
  page's `InputUsed` audit-trail convention, and deliberately does **not** apply
  `excluded_from_baseline` — a reimbursement is not plannable income, but it is real
  money that really moved net worth
- [SINKING.md](SINKING.md) — the `sinking_fund` card in full: what your known irregular
  costs require you to be holding, measured against the reserve **above** the
  emergency-fund target this page sizes. The page and the card cannot disagree, and a
  test proves it rather than a convention asking for it
- [INCOME.md](INCOME.md) — the income model this reads, and the one true savings rate
- [DASHBOARD.md](DASHBOARD.md) — the loader/card contract the advice card follows
- [ALERTS.md](ALERTS.md) — the alert pipeline and the content-free email
- [PLAN15.md](../plans/features/PLAN15.md) — task breakdown and rejected alternatives
- [IDEAS.md](../plans/features/IDEAS.md) §11 — ADR-032, ADR-033, ADR-034
