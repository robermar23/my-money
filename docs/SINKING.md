# Sinking funds — what your known irregular costs require you to be holding now (Phase 18)

A monthly budget can represent rent. It structurally cannot represent the $1,340
car-insurance premium that lands in March, the water bill that arrives every
three months, the property tax in November, the quarterly estimated tax. There is
no month in which those are *normal* — so a household that budgets monthly meets
them with a credit card, in the one month they were always going to arrive.

This phase answers one question:

> **"How much should I already have set aside for the costs I know are coming?"**

It answers with two sentences:

> *You should be holding **$2,180** against the 4 known costs in the next 12
> months.*
>
> *Your reserve above your emergency-fund target is **$600**.*

That is the whole feature. It computes a **requirement** and compares it to a
**balance you already have**. It does not move money, hold money, reserve money,
or know where your money is.

Locked by **ADR-043** (the `planned_expenses` table and the envelope boundary),
**ADR-044** (the accrual identity), **ADR-045** (the two cost sources and the
cadence threshold), and **ADR-046** (the rule, its degradations, and one
implementation) in [IDEAS.md](../plans/features/IDEAS.md) §11; task breakdown in
[PLAN18.md](../plans/features/PLAN18.md).

> **Scope (binding — CLAUDE.md §Domain Scope).** This is **not envelope
> budgeting**, and the difference is not a matter of degree. See
> [What this is not](#what-this-is-not) below — it is the first section worth
> reading, because every design decision in the phase follows from it.
>
> **Privacy (binding — CLAUDE.md §Privacy).** The sinking-fund layer makes
> **zero outbound HTTP on any transitive path** — not a narrow "no fetch in this
> directory", but no network call anywhere in the 60-odd modules reachable from
> it. `planned_expenses.label` and `.notes` are the most sensitive free text in
> the app: *"Fertility treatment"*, *"Dad's care home deposit"*, *"divorce
> lawyer retainer"*. They live in local Postgres, ride the nightly
> `age`-encrypted `pg_dump` (ADR-014), are **never logged**, are **not in the
> search index** (a decision, not an oversight — see
> [What is deliberately absent](#what-is-deliberately-absent)), and never reach
> the content-free alert email (ADR-015). A regression test
> ([privacy-egress.test.ts](../src/lib/sinking/privacy-egress.test.ts)) fails
> the build if any of that stops being true.

---

## Where to find it

| Surface | What it shows |
|---|---|
| **`/plan/sinking`** | The headline requirement, the gap or surplus, the itemized table of every known cost with its own required-today figure, and the manager where you record, edit, mark paid or cancel a one-off cost. |
| **`/plan`** | The `sinking_fund` guidance card. The same figure, the same audit trail, the same words — see [One number, one implementation](#one-number-one-implementation). |
| **`/plan/cashflow`** | A recorded cost inside the projection horizon appears as an event on the daily balance line, tagged **one-off**, and moves the low-water mark and safe-to-spend. A note at the foot of the bill list says how many known costs there are and how many land inside the window. |
| **Nav** | *Planning → Sinking funds*, and in the ⌘K palette. The page is indexed; the costs on it are not. |

There is **no alert** for a sinking-fund shortfall, and no dashboard card. Both
are deliberate — see [What is deliberately absent](#what-is-deliberately-absent).

---

## The two cost sources

A known future cost comes from exactly one of two places, and the whole point of
ADR-045 §1 is that it has to be **both**:

| Source | Where it comes from | Example |
|---|---|---|
| `planned_expense` | You typed it in on `/plan/sinking`. A one-off, with an amount, a due date and a date its funding starts from. | A $1,800 roof repair you want to be ready for by next April. |
| `obligation` | A **recurring bill the app already tracks** (Phase 16), whose cadence is less frequent than monthly. You do not re-enter it. | The $1,200 annual car-insurance premium already confirmed on `/plan/cashflow/review`. |

A requirement built from `planned_expenses` alone would be the obvious
implementation and would be wrong in a specific, quiet way: it would omit the
annual premium the whole feature exists for, because you already told the app
about it once and reasonably expect it to remember. On the household Round 12
describes, that is **$1,200 of a $2,180 requirement** silently missing.

### The cadence threshold, and the double-count it prevents

Only **quarterly, semiannual and annual** obligations accrue. Weekly, biweekly,
semimonthly and monthly ones never do.

This is the one place in the phase where a plausible-looking widening produces a
badly wrong number, so here is the reasoning in full. A bill that arrives
monthly-or-more-often is paid out of the month's income, and the app already
counts it **twice**:

1. It is inside `essentials.monthly`
   ([essential-expenses.ts](../src/lib/advice/essential-expenses.ts)), which
   sizes the **emergency-fund target** that the requirement is measured against.
2. It is inside the trailing observed spend behind the cash-flow **residual
   rate** (ADR-038 §2).

Accruing a reserve for it would demand the household hold a *third* copy of
money it already budgets every month. On a household with $2,700/month of
monthly obligations, a naive 12-month stream asks for roughly **$16,000** against
bills that are simply paid as they arrive — and the card would tell a perfectly
solvent family it is catastrophically behind.

The gate is a compile-time one, not a filter somebody has to remember:
[cadence.ts](../src/lib/sinking/cadence.ts) derives the eligible set from an
exhaustive `Record<ObligationCadence, boolean>`, so adding a cadence to the
vocabulary without deciding whether a household should accrue for it **fails
`tsc`** rather than defaulting to included (double-count) or excluded
(understatement).

### How far the stream can see

The requirement reads **materialized occurrence rows** rather than re-expanding
schedules, because two answers to *"when is this due"* is how they drift.

That has a consequence worth knowing about. The cash-flow materializer runs
about **90 days** ahead at the shipped defaults, against a **365-day** sinking
horizon — so without a change, every annual and semiannual occurrence past those
90 days would simply not exist as a row, and the requirement would be *silently
understated*: a confident, too-small number with nothing red anywhere on the
page. The eligible cadences therefore get a longer materialization lead of
**400 days** (`SINKING_MATERIALIZATION_DAYS_AHEAD`), and only those cadences, so
the extra rows are bounded and small — an annual obligation holds 2 future rows
instead of 1; a weekly bill keeps the short cash-flow lead untouched.

---

## The accrual formula

For one cost:

```text
totalMonths   = max(1, monthsBetween(fundingStart, dueDate))
elapsedMonths = clamp(monthsBetween(fundingStart, today), 0, totalMonths)

requiredToday = amount × elapsedMonths ÷ totalMonths
perMonth      = amount ÷ totalMonths
```

Straight-line over whole months. Nothing is weighted, front-loaded, or aligned
to paychecks — that would be a funding *rule*, which is a goal, which this phase
does not have (ADR-044 consequence 2).

### Why it is one division and not two

Round 12 stated the math as *"required monthly set-aside = amount ÷ months to
due; required balance today = elapsed months × that rate."* Right model, wrong
implementation: taken literally it **rounds twice**. Worked, with Round 12's own
example — $1,340 of car insurance over 7 months:

```text
perMonth    = 1340 ÷ 7   = $191.43   (rounded to cents)
191.43 × 7               = $1,340.01 ← a cent nobody ever owed
1340 × 7 ÷ 7             = $1,340.00 ← what the app computes
```

So `requiredToday = amount × elapsed ÷ total`, as one `Money` multiplication and
one division — **one** rounding. A cent of drift sounds like nothing, but it is
systematic across every cost and every month, and it lands on a figure whose
entire credibility is that it **reconciles against the itemized table printed
beneath it**. ADR-044 deliberately refines the round's literal formula and says
so, so a reader comparing the two finds a reason rather than a discrepancy.

Two consequences follow, and both are visible on the page:

- **`requiredToday` is authoritative; `perMonth` is a display figure.** They may
  differ by a cent or two. Nothing multiplies `perMonth` back up.
- **On the due date the requirement *is* the bill, exactly, as a string.**
  `requiredToday === amount` when `elapsed === total` — not within a cent. An
  invariant suite walks a cost day by day and asserts the figure is monotone
  non-decreasing and never exceeds the amount.

### Whole months, not days

`monthsBetween` counts month boundaries crossed, so the requirement steps up on
the monthly anniversary rather than creeping every morning. Households set money
aside per paycheck or per month, and a figure that moves daily trains you to
check whether it *moved* rather than whether you are *on track*. **This is a
design choice, not a rounding artefact** — it is not a bug to be fixed with
daily proration.

### Where funding starts

| Source | `fundingStart` |
|---|---|
| A planned expense | The accrual start date you set. Defaults to today when you record it, so a cost entered today accrues from today. |
| An obligation | **The previous occurrence's due date, whatever its status.** |

The second one is easy to get wrong, and getting it wrong is invisible. The
previous occurrence of an annual premium is almost always `matched` — it was paid
a year ago. A query that filtered to `scheduled` occurrences, however naturally
that reads next to *"the stream admits only scheduled occurrences"*, would find
no previous row, fall back to the horizon start, and collapse twelve months of
accrual to zero: **$900 of required premium becomes $0**, confidently.

### Two clamps, both stated

- **`totalMonths` floors at 1.** Without it, a cost due inside the month divides
  by zero. The honest answer for a cost due in ten days is *"you need all of
  it now"* — which is exactly what `totalMonths = 1` produces.
- **`elapsedMonths` is capped at `totalMonths`.** Without it, a cost four months
  past due would require $8,000 against a $6,000 bill.

A `paid` or `cancelled` cost accrues `"0.00"` and contributes nothing to any
total, while staying visible in the manager with its own status — ADR-043 §3,
deactivate never delete. Your record of what you once expected to pay is part of
your history.

---

## What "available" means

```text
emergencyTarget = reserveMonthsFor(household) × essentials.baseline
available       = max(0, cash.reserve.total − emergencyTarget)
gap             = max(0, requiredToday − available)
surplus         = max(0, available − requiredToday)
```

Three judgement calls are packed into that, and all three are ADR-046's.

**The reserve tier only.** `available` counts the reserve tier of your cash —
the savings the emergency-fund rule already classifies — and nothing else. Not
total cash: operating money is committed to this month's bills. Not medium-term:
breaking a CD costs a penalty. Counting either would report a fund you cannot
spend on the day the premium lands, which is the one circumstance the figure
exists for.

**Above the emergency-fund target**, because one pot cannot do two jobs and be
called funded twice. Money already standing in for three months of lost income is
not also available for next March's insurance. This is the reserve **tier above
the emergency target** — a second tier of the same unpartitioned balance, named
by subtraction, not a separate account.

**The target comes from the one `reserveMonthsFor`.** This is its fourth caller
(after the emergency-fund rule, the waterfall rung and the cash-drag rule). A
household that set a 4-month target sees the same $12,000 here as on the
emergency-fund card, because it is the same exported function reading the same
snapshot.

`gap` and `surplus` are both non-negative and at most one is non-zero. Exactly
equal is **both zero** — not a $0 surplus dressed up as good news.

### A surplus does not mean the money is spare

The page says so in as many words. A surplus means your reserve covers both the
emergency fund and every known cost *as accrued so far*. The costs are still
coming, and the per-month figure is what keeps the position true.

---

## One number, one implementation

`/plan/sinking` and the `sinking_fund` card on `/plan` **cannot** disagree about
what you should be holding. Not by convention — structurally. Both call the same
four pure functions (`sinkingHorizon` → `sinkingRequirement` →
`sinkingAvailability` → `sinkingStatus`) over the same assembled snapshot, and
both get their audit trail from the same `sinkingInputsUsed`. There is one
computation and two renderers of it.

That is asserted mechanically
([parity.test.ts](../src/lib/sinking/parity.test.ts)): seed a household, load
both surfaces independently, and compare the strings. The test is three lines of
assertion because the composition is shared — and if it ever becomes hard to
write, the composition has been broken.

The cost of doing it that way is real and was taken knowingly: `/plan/sinking`
loads the **full** financial snapshot, most of which it does not need. The
recorded answer, if that is ever too slow, is a narrower loader that composes the
**same pure functions** — never a second computation of the requirement.

---

## How it interacts with the cash-flow projection

A planned expense inside the projection horizon is charged to the daily balance
walk on its due date, as a fourth kind of cash-flow event, tagged **one-off** in
the chart tooltip. A cliff that is a new roof is a decision you already made; a
cliff that is the mortgage is not, and the chart says which is which.

Two things deliberately do **not** happen:

- **The everyday spending rate does not move.** The residual rate subtracts
  confirmed obligations from trailing *observed* spend, because the residual's
  whole job is to remove what observed spend already contains. A cost dated in
  the future has not been spent. Subtracting it would understate your everyday
  rate for a payment that has not happened — which overstates safe-to-spend
  twice over, once through the rate and once through the clamp.
- **Nothing is deduplicated against an obligation.** A cost recorded on the same
  day as a confirmed bill is charged **twice** in the projection, on purpose. See
  [Duplicate entry](#duplicate-entry-is-warned-never-merged).

A cost in a currency other than your household's is **skipped and named** in the
projection's inputs list rather than converted (there is no `fx_rates` lookup in
this phase) or thrown on (one row should not cost you the whole page). On
`/plan/sinking` the same situation fails loudly instead, because a *total* that
silently omits a cost is worse than no total.

---

## When the app cannot say it

Two named degradations, and the page and the card always give the same one.

| Status | What it means | What the app says |
|---|---|---|
| `no_baseline` | There is not enough classified spending to compute your essential monthly expenses, so there is no emergency-fund target, so there is no "available" figure. | *"We cannot tell you how much to set aside yet"*, naming the missing input and linking to where it is fixed. No figure is invented. |
| `no_costs_recorded` | You have recorded nothing. | *"Record the costs you already know are coming"* — **not** "you're on track". |

### An empty cost list is not success

This is the sharpest call in the phase (ADR-046 §5), and the one a future
simplification would undo. With nothing recorded, every figure computes cleanly:
a $0 requirement, a known target, a positive surplus. The arithmetic says *on
track*.

The app must not, because it cannot distinguish *"this household has no large
irregular costs"* from *"it has not recorded them yet"* — and on any install the
second is overwhelmingly likelier. Telling a family with an unrecorded $1,340
premium that they are fine is the one failure that would make this feature
actively harmful.

`no_baseline` wins when both are true, because a missing baseline leaves no
position to report **either way**, while a missing cost list still leaves the
target and the reserve perfectly well stated — and fixing the baseline is one
link to follow instead of two.

A **low confidence** grade never hides the figure. A household with four months
of history still has the same premium due in March, so the grade sits beside the
number rather than instead of it.

---

## What this is not

Read this section even if you skipped the rest. It is the boundary the whole
design is built to respect, and it is a **hard** boundary in CLAUDE.md
§Domain Scope, not a preference.

**This is not an envelope system.** A sinking fund *computes a requirement*. An
envelope system *partitions a real balance*. They produce similar-looking
sentences and are completely different things to build and to trust.

Concretely, the app does **not**:

- **Reserve, allocate, earmark, or move any money.** No transfer is initiated, no
  balance is split, no account is designated. The app is read-only (CLAUDE.md
  §Domain Scope — no bill pay, no money movement, no ACH).
- **Record where money "is".** There is no `funded_amount` column, no `funded`
  status, no `funding_account_id`, and no contributions table. Those absences are
  the design, and they are what a reviewer should check first. **Deleting every
  planned expense leaves every balance in the app unchanged**, because no balance
  was ever derived from one.
- **Track your progress toward funding a cost.** There is no per-cost funded
  figure and no progress bar. The table shows what each cost *requires* today,
  not what you have *put toward* it — the app has no way to know that without
  partitioning a balance, which is the line itself.
- **Give you a goal.** A planned expense is a **recorded fact about a cost you
  expect**, not a target you fund. Goals (ADR-022) are a different, deferred
  thing; a funding *schedule* — front-loaded, paycheck-aligned — would be a goal
  wearing a sinking fund's clothes.
- **Change Round 2's monthly budgets.** Category targets stay exactly as simple
  as they were (ADR-018 unamended). Nothing here touches them.
- **Post anything.** No double-entry ledger, no journal, no accruals in the
  accounting sense. Nothing in this phase is *stored* at all — see below.
- **Use AI or an LLM.** *"What should I be saving for?"* is exactly the question a
  hosted model answers plausibly, and answering it would ship a list of what your
  household is quietly saving for to a third party. Every figure here is
  `amount × elapsed ÷ total` with a stated formula.

The one-sentence test, if you are adding something: **does it record where money
is, or does it compute what is required?** The first is an envelope and belongs
in a different app.

---

## Nothing here is stored

No requirement, accrual, availability figure, gap or status is written to the
database (ADR-032 §3). Everything is computed on read from rows you entered, bills
you confirmed, and balances the app already snapshots.

The only writes in the phase are the ones you make yourself: recording, editing,
marking paid or cancelling a planned expense. The requirement is **relative to
today**, so a persisted copy would answer no question correctly the morning after
it was written.

---

## Documented limitations

These are disclosed rather than smoothed. Every one of them is a case where a
guess would be wrong *silently*, which is the kind of wrong this app is built to
avoid.

### The 12-month horizon is a hard edge

A cost **13 months out contributes nothing today**, and appears next month at a
full month's accrual rather than easing in. Softening the edge would mean
accruing today against a cost whose amount is still a guess. The number is a
checked-in constant, not a setting, so it is reviewable in a diff.

### `trailing_median` obligations are estimates

An obligation whose amount is estimated from history re-prices over time. The
requirement states the **snapshotted** figure written for that due date, which is
the auditable one — and it will move. The same disclosure the projection already
carries applies here.

### Duplicate entry is warned, never merged

Record a $1,340 roof repair on the same day your confirmed annual premium is
due, for the same amount, and the app will **tell you it looks like a duplicate**
— and then let you record it anyway, as a first-class path. It will count both.

That is the correct behaviour, not a missing feature. No structural rule
distinguishes a duplicate from two genuinely different costs on one day for one
amount — two $400 costs in the same week is an ordinary thing for a household to
have — and only you know whether the roof and the roof-shaped bill are the same
roof. Silently dropping a real cost from a total is strictly worse than showing it
twice next to its own name.

Matching is on **amount and due date only**. Label similarity is deliberately not
computed: *"Auto insurance"* versus *"Car insurance"* versus *"State Farm"* is a
brittle string guess, and getting it wrong in the quiet direction (no warning) is
invisible.

### A recorded annual cost can overlap the projection's residual window

If you record an *annually recurring* cost as a one-off planned expense, its
**prior-year instance may sit inside the projection's 90-day trailing residual
window** — in which case `/plan/cashflow` charges a version of it twice: once
spread through your everyday spending rate, once as an event on its due date.

Nothing can tell that case apart from a genuinely new cost that happens to
resemble last quarter's spending, and a guess would be wrong with no surface that
admits it. **The mitigation is to enter recurring costs as obligations**, which is
what the entry form's duplicate warning already nudges toward. This affects the
projection only; the sinking requirement itself is unaffected.

### Nothing matches a payment to a planned expense

There is **no transaction matcher** for planned expenses (ADR-043 §6). Pay the
roofer and the cost stays `planned` until you click *Mark paid* — including past
its due date, where it will show as overdue and keep counting in full. The
guidance card says so when there are past-due costs.

One click was judged better than a matcher that is sometimes wrong about which
$1,800 was the roof. If that ever genuinely chafes, the fix is to reuse the
existing cash-flow matcher, not to write a second one.

### Multi-currency costs are not converted

The currency column exists and defaults to your household's. Totals assume the
base currency: `/plan/sinking` refuses to add two currencies rather than report a
wrong total, and the projection skips and names a foreign cost. Cross-currency
accrual would go through `fx_rates` at the due date (CLAUDE.md §Money), which is
a real design question nobody has asked yet.

### Costs with no fixed cadence fit neither table

The vet; the car that needs something twice a year at no predictable interval.
The honest answer today is a series of one-off planned expenses. Note that a
`cadence: 'irregular'` would mean *"we do not know"*, which is not a schedule —
so it is deliberately not offered.

---

## What is deliberately absent

Recorded so the absence is not read as an oversight.

- **No sinking-fund alert.** *"A cost is due in 30 days and you are $600 short"*
  would be a forward-looking **input-health** signal, which is a job to do once
  across every input rather than one feature at a time. Note also that ADR-015
  makes the alert email content-free: such an alert must never name the cost, and
  the label *is* the cost's name.
- **No search indexing of planned expenses.** `label` and `notes` are the most
  sensitive free text in the app, and indexing them would put them one keystroke
  from the command palette on every page. That is a privacy question deserving
  its own pass. The **route** is indexed so you can navigate to the page; the
  **rows** are not, and a test asserts both halves so neither gets
  "simplified" into the other.
- **No dashboard card.** The requirement is a figure you check monthly, not
  daily.
- **No eighth waterfall rung.** The rule caps its own severity at `info` while
  your emergency-fund target is unmet, and says why in its rationale, rather than
  re-ordering the shipped guidance ladder. Nothing about the cap suppresses the
  figure — the gap is reported in full either way; the cap decides only where the
  card sorts.
- **No netting against the cash-flow reserve sentence.** `/plan/cashflow` may say
  a transfer from reserve *"leaves $X in reserve"*, and that $X may be next
  March's insurance. Folding the requirement into that sentence would amend a
  just-locked ADR as a ride-along, which it declines on principle.

---

## If a number looks wrong

1. **The requirement is smaller than you expect.** Check the cadence of the bill
   you have in mind — monthly-or-more-often obligations never accrue, by design
   ([the cadence threshold](#the-cadence-threshold-and-the-double-count-it-prevents)).
   Then check whether the cost is more than 12 months out.
2. **A confirmed annual bill is missing from the table.** Its occurrence row may
   not be materialized yet. `project-cashflow-daily` writes 400 days ahead for
   the eligible cadences; [CASHFLOW.md](CASHFLOW.md#when-it-runs) has the
   one-off invocation.
3. **There is no "available" figure at all.** That is `no_baseline`: classify a
   few spending categories as essential and it fills in. The requirement is still
   shown.
4. **It says you have recorded nothing and you have.** Check the status of your
   rows — `paid` and `cancelled` costs stay in the manager and count `"0.00"`.
5. **The total is a cent off the column you added up.** It should not be: both
   totals are sums of the per-cost figures shown. If it is, that is a real bug —
   the headline and its table are the same arithmetic.
6. **`/plan` and `/plan/sinking` disagree.** That is a bug by construction, and
   [parity.test.ts](../src/lib/sinking/parity.test.ts) is the test that should
   have caught it.

---

## See also

- [GUIDANCE.md](GUIDANCE.md) — the waterfall this card sits beside, the
  `InputUsed` audit-trail convention, and the emergency-fund target this
  requirement is measured above.
- [CASHFLOW.md](CASHFLOW.md) — the projection a recorded cost appears on, the
  obligations that are this feature's second cost source, and the residual rate
  the cadence threshold exists to avoid double-counting.
- [ALERTS.md](ALERTS.md) — the content-free email, and why this phase adds no
  alert to it.
- [BACKUP.md](BACKUP.md) — the nightly encrypted dump that covers
  `planned_expenses` with no backup-path change.
- [PLAN18.md](../plans/features/PLAN18.md) — the task breakdown, the rejected
  alternatives, and the per-batch record of what was found.
- [IDEAS.md](../plans/features/IDEAS.md) §11 — ADR-043, ADR-044, ADR-045,
  ADR-046.
