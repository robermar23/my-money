# IDEAS3

> **Rounds 10–16.** [IDEAS2.md](IDEAS2.md) ran Rounds 2–9 and every one of them shipped
> (Phases 8–15). This file opens the next block. It is written to the same standard: the
> owner's question first, then the smallest honest description of what would answer it.
>
> **Where these came from.** A repo review on 2026-08-23 asked a different question than the
> earlier rounds did — not *"what feature is missing?"* but *"put yourself in the place of the
> head of a family; what else do you need?"* Seven gaps came out of that framing. They are
> recorded here in the order the head of that family would feel them.
>
> **The one-sentence diagnosis behind all seven.** Every number the app produces today is
> either a **stock** (balance, net worth, allocation, cost basis) or a **rate** (savings rate,
> monthly spend, APR, TWR). Almost nothing is a **date**. But a household's money runs on a
> calendar — the mortgage on the 1st, daycare on the 3rd, paychecks on the 15th and 30th,
> insurance twice a year, property tax in November. The app is missing a dimension, not a
> feature. Rounds 10, 12 and 13 add that dimension; 11, 14, 15 and 16 answer questions the
> existing data can already support but no surface asks.
>
> **What is deliberately NOT here.** Nothing in Rounds 10–16 needs a model, an API, or an
> outbound request. Every one is deterministic arithmetic over data the app already holds,
> which is why none of them collide with [CLAUDE.md](../../CLAUDE.md) §Privacy. The
> [SKILLS.md](SKILLS.md) §Tier 2A/A "on-device intelligence" track (`transformers-js`,
> `local-llm-expert`) is **not** the frontier for this block and stays gated behind its ADR.
>
> **Status**: Round 10 **shipped** as Phase 16 ([PLAN16.md](PLAN16.md), ADR-036 → ADR-038).
> Round 11 **shipped** as Phase 17 ([PLAN17.md](PLAN17.md), ADR-039 → ADR-042).
> Round 12 is planned as Phase 18 ([PLAN18.md](PLAN18.md), ADR-043 → ADR-046) with its
> [FEATURE.md](FEATURE.md) scope entry recorded 2026-09-13. Rounds 13–16 are recorded, not
> committed — each still needs its own clarifying round and a [FEATURE.md](FEATURE.md) scope
> entry before a PLAN exists, per [CLAUDE.md](../../CLAUDE.md) §When in Doubt.

---

## Round 10 — The calendar dimension: what happens next Tuesday

**The family question:** *"Can I spend $400 on the car repair this week, or does something bounce?"*

The app cannot answer this, and it is the most-asked money question in a household with a
mortgage and kids. It knows the average monthly spend and the pay cadence. It has no concept of
**upcoming known obligations on specific days**, so it cannot draw the one line that matters:
projected daily balance over the next 60 days, with the low point named.

*"Your lowest projected checking balance is $312 on March 14."*

**What already exists to build on:** [income/schedule.ts](../../src/lib/income/schedule.ts)
already expands a pay cadence into real dates with clamping (`payDatesBetween`);
[advice/net-income.ts](../../src/lib/advice/net-income.ts) already derives observed take-home;
[analytics/forecast.ts](../../src/lib/analytics/forecast.ts) already run-rates a partial month;
`account_snapshots` already holds the starting balance. This round is largely assembly.

**Shippable features:**

| # | Feature | Ships |
|---|---|---|
| 10.1 | **Recurring-series detection** — periodicity + amount-stability analysis over transaction history, per normalized payee. Produces *candidates*, never rows. | A pure, tested detector |
| 10.2 | **Scheduled obligations** — the confirmed record of what is due and when. Detection proposes, the user confirms (the parse → preview → confirm posture from §Importers). Manual entry for the bills that never touch a tracked account. | A table + a review-and-confirm flow |
| 10.3 | **Daily cash-flow projection** — starting balance + phased take-home − obligations − residual discretionary run-rate, day by day, over a configurable horizon. | A pure engine + a chart |
| 10.4 | **Safe-to-spend** — the horizon's lowest projected closing balance, less a user-set cash floor. One number, on the dashboard. | A dashboard tile + a `/plan/cashflow` page |
| 10.5 | **Timing alerts** — projected shortfall ahead; an obligation whose due date passed unmatched; an obligation whose amount moved materially. | Three new alert types |

**The correctness trap that defines this round:** recurring obligations are *already inside*
observed spend. Projecting an average daily spend **and** adding the mortgage on the 1st counts
the mortgage twice. The discretionary rate must be the **residual** — total observed spend minus
the spend attributable to confirmed obligations. Everything else here is straightforward; this is
the part that must be test-first.

**Boundary:** this is not bill pay and not envelope budgeting. The app never moves money and
never reserves it. It reports timing.

**Reconciling with PLAN15.** [PLAN15.md](PLAN15.md) §Open Items deferred "recurring /
fixed-expense detection" on the grounds that `categories.necessity` is explicit and correctable,
and a merchant-cadence detector guesses where an answer already exists. That reasoning stands and
is **not** overturned: `necessity` answers *"is this essential?"* — a classification. Round 10
asks *"when does it land, and for how much?"* — a timing question on an orthogonal axis, which
`necessity` cannot answer at any level of classification quality. Detection here schedules; it
does not classify.

---

## Round 11 — Why did our net worth change?

**The family question:** *"We're up $40k this year. Did we earn that, or did the market?"*

The chart goes up and the household cannot tell whether it reflects their discipline or the S&P.
Those two facts imply completely different next actions, and the app reports neither.

**What already exists:** [investments/performance.ts](../../src/lib/investments/performance.ts)
already has `attribution()` — contribution vs. market return — but only for the *brokerage*.
This round lifts the same idea to the whole household.

**Shippable features:**

| # | Feature | Ships |
|---|---|---|
| 11.1 | **External-flow classification** — which transactions move money *into or out of the household* vs. merely between its own accounts. Transfers are already excluded by `categories.kind`; this makes the household boundary explicit. | A pure classifier |
| 11.2 | **Period decomposition** — for any window, split the net-worth delta into saved, investment return, debt principal paid, asset revaluation, and unexplained. | A pure engine |
| 11.3 | **The "why" surface** — a waterfall from opening to closing net worth on `/analysis`, for any range the existing range toggle offers. | A chart + a plain-language summary line |

**Why this is the best value-per-line item in the file:** it is deterministic accounting over
`account_snapshots` — data already captured nightly. No new schema is obviously required. The
**unexplained** bucket is a feature, not a defect: a large residual means a data problem, which
feeds Round 16.

---

## Round 12 — Sinking funds: the bills that break families

**The family question:** *"Car insurance is $1,340 in March. I know it, and it still hurts every year."*

Budgets are monthly. Families do not fail on monthly — they fail on annual, semiannual, and
irregular: insurance, property tax, tuition, Christmas, the vet, the HVAC that was always going to
die. A monthly budget structurally cannot represent these, so they read as a blown month instead
of a known cost.

**Shippable features:**

| # | Feature | Ships |
|---|---|---|
| 12.1 | **Planned expenses** — a named, dated, amount-bearing future cost. (Already recorded as a deferred open item in [PLAN15.md](PLAN15.md); Round 10's obligations model may subsume the recurring half of it.) | A table + entry UI |
| 12.2 | **Accrual math** — required monthly set-aside = amount ÷ months to due; required balance today = elapsed months × that rate. | A pure function |
| 12.3 | **A sinking-fund advice rule** — *"you should be holding $2,180 against the four known costs in the next 12 months; your reserve above emergency target is $600."* Degrades to `unknown_input` honestly like every other rule. | One `RuleId` in the existing engine |

**Boundary:** this is still not envelope budgeting. No money is partitioned, reserved, or moved
between virtual buckets. The app computes a number and shows it against reality.

---

## Round 13 — What if?

**The family question:** *"What if I take a $650 car payment? What if I refinance at 5.5%? What if I'm laid off in April?"*

Every input needed already exists — essential expenses, reserve months, amortization, take-home,
forecast. Nothing consumes them under a hypothetical.

**Shippable features:**

| # | Feature | Ships |
|---|---|---|
| 13.1 | **Scenario deltas** — a typed, closed set of adjustments to an `AdviceInput`: add or remove a recurring obligation, change an income, change a debt's rate or balance, change a lump balance. Not free-form editing. | A discriminated union + a pure applier |
| 13.2 | **Re-run under delta** — the existing `runAdvice()` and Round 10's projection, executed against the modified snapshot. Zero new math. | A pure composition |
| 13.3 | **Side-by-side compare** — today vs. scenario: safe-to-spend, low-water mark, reserve months, waterfall rung, months-to-debt-free. | A `/plan/scenarios` page |

**This is explicitly not what [ADR-022](IDEAS.md) rejected.** No Monte Carlo, no probability
distribution, no sequence-of-returns modeling, no saved user-authored goals with funding rules. A
scenario is an ephemeral delta applied to today's inputs — a calculator, not a planner. Whether
scenarios may be *saved* is the one open question, and it decides whether this needs an ADR-022
amendment or merely a boundary clause.

---

## Round 14 — Am I actually on track, or just accumulating?

**The family question:** *"I put money in the 401k every paycheck. Does it get me there?"*

`household_profile.retirement_target_age` exists and **nothing consumes it.**
[investments/projection.ts](../../src/lib/investments/projection.ts) compounds a lump sum with
**no contributions** — precisely the projection a saving household should not be shown.

**Shippable features:**

| # | Feature | Ships |
|---|---|---|
| 14.1 | **Contribution-inclusive projection** — portfolio plus scheduled contributions, compounded to target age. Decimal-only. | A pure function |
| 14.2 | **Coverage ratio** — the supported annual draw at a stated withdrawal rate, against the essential-expense baseline the advice engine already computes. *"Covers 71% of your essential spend."* | A pure function |
| 14.3 | **Three stated scenarios** — conservative / expected / optimistic real return, side by side. Stated assumptions, not a distribution. | A `/plan/retirement` surface |

**Boundary:** stated deterministic scenarios only. ADR-022's rejection of probabilistic retirement
planning stands. No Social Security estimation, no tax math, no withdrawal sequencing, no
Roth-conversion analysis — all permanently out under §Domain Scope.

---

## Round 15 — The bus file

**The family question:** *"If I died tomorrow, could my spouse find any of this?"*

Unglamorous, unavoidable, and the app already holds every input: institutions, accounts, asset
records, documents, mortgage terms. What is missing is one document that assembles them.

**Shippable features:**

| # | Feature | Ships |
|---|---|---|
| 15.1 | **Continuity metadata** — optional per-account and per-asset fields: institution contact, where the physical document lives, holder notes. Free text, local, never indexed. | Additive nullable columns |
| 15.2 | **The inventory report** — a single printable document: every account and institution, every asset and its proof document, every liability and its servicer, and where the backups and the `age` key live. | A print-styled route |

**Boundary — read carefully.** [FEATURE.md](FEATURE.md) puts estate and will planning out of
scope, and that stays out. This is **not** that. It drafts nothing, advises nothing, and computes
nothing; it is a *report over data already held* — an inventory, not an instrument. That
distinction is the whole justification and belongs in the ADR verbatim.

**Privacy note:** this is the highest-concentration document the app can produce, and its natural
use is to be printed and stored physically. That deserves an explicit warning on the page and an
explicit decision about whether it may be exported to a file at all.

---

## Round 16 — Can I trust these numbers?

**The family question:** *"There are sixteen jobs running unattended at 3 a.m. Is any of this still right?"*

The advice engine already degrades honestly *per rule* (`unknown_input`, `insufficient_history`).
Nothing makes the health of the **inputs** a first-class surface. In a self-hosted app with no
SaaS observability — deliberately, per §Privacy — silent wrongness is the realistic failure mode,
and it compounds: every round above makes decisions out of the same inputs.

**Shippable features:**

| # | Feature | Ships |
|---|---|---|
| 16.1 | **Data contracts** — explicit, versioned assertions about what "valid" means, checked on a schedule: snapshot freshness per account, price staleness per held symbol, uncategorized share, import reconciliation diffs, obligations that stopped matching, backup age, last successful restore drill. | A checks registry + a job |
| 16.2 | **A trust surface** — one page listing every failing contract, what it makes unreliable downstream, and a link to fix it. | A `/settings/health` page |
| 16.3 | **A dashboard signal** — one honest indicator that inputs are degraded, so a wrong number is visible *as* wrong rather than confidently displayed. | A dashboard affordance |

**Skill note:** [SKILLS.md](SKILLS.md) §Tier 2A/C already names `data-quality-frameworks` for
exactly this — *"take the data-contract concept; skip the tooling."*
[search/privacy-egress.test.ts](../../src/lib/search/privacy-egress.test.ts) is the same idea in
miniature and is the shape to generalize.

---

## Sequencing

Rounds 10 → 11 → 12 is a deliberate order, not a preference.

- **10 first** because it adds the missing dimension. It is the only round that creates genuinely
  new information rather than re-presenting information already held, and both 12 and 13 hang off
  the obligations model it introduces.
- **11 second** because it is the cheapest and most illuminating — deterministic accounting over
  snapshots already captured — and its "unexplained" residual is the first honest measure of how
  trustworthy the data actually is.
- **12 next** because sinking funds need Round 10's calendar to sit on.
- **13, 14** are calculators over inputs that will by then all exist.
- **15, 16** are longevity and trust work: valuable at any point, easy to defer — which is exactly
  why they should be scheduled rather than left to "later."

---

## Open questions the owner still has to answer

Recorded rather than assumed, per [CLAUDE.md](../../CLAUDE.md) §When in Doubt.

1. **A second adult.** Every round above is written for one person's screen, but "head of a
   family" implies a spouse who cannot currently open the app at all. There are three genuinely
   different answers — the same password on the PWA (needs nothing), a read-only session mode
   (small), or a real second user (contradicts a locked boundary in §Domain Scope). This is a
   decision, not a task, and it is not made here.
2. **The tax-time packet.** "Tax computation" is permanently out of scope, but *"realized
   gain/loss, mortgage interest paid, charitable giving, HSA contributions — for the accountant"*
   is a report over data already held, in the same way Round 15 is. It sits exactly on the
   boundary and needs an explicit yes or no rather than a quiet drift across.
3. **Whether scenarios (Round 13) may be saved.** Ephemeral is unambiguously fine. Persisted,
   named scenarios start to look like the user-authored goals ADR-022 rejected.
4. **Insurance policies as records.** Tracking renewal dates would feed Round 10's calendar
   naturally. Coverage *adequacy* advice is out. Whether the record-keeping half is wanted at all
   is unanswered.

---

*End of IDEAS3.md*
