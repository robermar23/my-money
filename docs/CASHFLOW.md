# Cash flow — what lands, when, and what that leaves (Phase 16)

Every number the app produced before this phase was a **stock** (balance, net
worth, allocation, cost basis) or a **rate** (savings rate, monthly spend, APR,
TWR). Almost nothing was a **date**. But a household's money runs on a calendar:
the mortgage on the 1st, daycare on the 3rd, paychecks on the 15th and 30th,
insurance twice a year, property tax in November.

This phase adds the missing dimension, and it exists to answer one question:

> **"Can I spend $400 on the car repair this week, or does something bounce?"**

It answers with two sentences:

> *Your lowest projected balance is **$312 on March 14**.*
>
> *You can spend **$1,240** over the next 60 days on top of your usual spending,
> keeping $1,000 in reserve.*

Locked by **ADR-036** (detection proposes, never commits), **ADR-037** (the
schedule schema), and **ADR-038** (the projection methodology) in
[IDEAS.md](../plans/features/IDEAS.md) §11; task breakdown in
[PLAN16.md](../plans/features/PLAN16.md).

> **Scope (binding — CLAUDE.md §Domain Scope).** This phase reports **timing**.
> It adds **no bill pay, no money movement, no ACH initiation** — a due date here
> is an observation, never an instruction, and the app remains read-only. No
> **envelope budgeting**: no money is partitioned, reserved, allocated, or moved
> between virtual buckets, and Round 2's simple monthly targets stay simple
> (ADR-018 unamended). No **double-entry accounting** — obligations are not
> liabilities and do not post. No **AI or LLM** over your financial data:
> detection is a deterministic periodicity test with a stated tolerance, and when
> it cannot decide it says so. No **probabilistic modelling** — the projection is
> a single deterministic line, never a fan chart (ADR-022 still stands). No
> **user-authored goals**: an obligation is a recorded fact about a recurring
> cost, not a target you fund.
>
> **Privacy (binding — CLAUDE.md §Privacy).** The cash-flow layer makes **zero
> outbound HTTP on any code path**. There is no biller directory, no
> merchant-enrichment service, no "we recognized this as Netflix" lookup — payee
> normalization is local string work over your own transaction names, and the
> detector treats a global brand exactly like a string it has never seen.
> Obligation labels are new user-authored text that names real vendors,
> landlords, and sometimes real people: they live in local Postgres and ride the
> nightly `age`-encrypted `pg_dump` (ADR-014). No balance, projection figure,
> safe-to-spend value, or obligation amount is ever logged, and none of them ever
> reaches the content-free alert email (ADR-015). A regression test
> ([privacy-egress.test.ts](../src/lib/cashflow/privacy-egress.test.ts)) fails
> the build if any of that stops being true — it audits the layer against an
> **allowlist** of imports, so a dependency nobody thought to ban still trips it.

---

## Where to find it

| Surface | What it shows |
|---|---|
| **`/plan/cashflow`** | The projection page: safe-to-spend with its horizon and floor, the low-water sentence, the daily balance chart, upcoming bills grouped by week, and the inputs the figure used. |
| **`/plan/cashflow/review`** | Detected candidates awaiting your decision, and the obligations you have already confirmed. Nothing is written until you click. |
| **Dashboard card** | Safe-to-spend, the low-water date, and the next bill, linking to `/plan/cashflow`. |
| **`/settings/household`** | Your cash floor and projection horizon. |
| **`/alerts`** | A projected shortfall, a bill that did not post, a bill whose amount moved. |

---

## How detection works

Once a week (Sundays, 06:30) the detector reads your **last 24 months** of
transactions and proposes recurring series. It is three plain tests, in order,
and every threshold below is a checked-in constant you can read in a diff.

**1. Grouping.** Transactions are grouped by `(account, payee key, direction)`.
The payee key is `normalizePayee()` lowercased — *the same function the category
rule engine uses*, deliberately, so "the same merchant" means one thing across
the app. It drops standalone digit runs (dates, store numbers, reference ids),
turns punctuation into word breaks, collapses whitespace and folds case.

Payments and receipts from the same payee are **separate series**: a landlord you
pay and a tenant who pays you are not one obligation.

**2. Periodicity.** The gaps between the dates in a group are measured, and the
**median** gap is tested against seven buckets:

| Cadence | Nominal gap | Accepted range |
|---|---|---|
| `weekly` | 7 days | 6–8 |
| `biweekly` | 14 days | 12–16 |
| `semimonthly` | 15 days | 13–18 |
| `monthly` | 30 days | 28–31 |
| `quarterly` | 91 days | 89–93 |
| `semiannual` | 182 days | 178–187 |
| `annual` | 365 days | 360–370 |

Three further rules decide whether the series is real:

- **At least 3 occurrences.** Two dates make a gap, not a rhythm.
- **At least half the gaps must fit** the winning bucket. A median that lands in
  a bucket while most gaps do not is a coincidence, not a cadence.
- **A gap may skip up to 4 periods** and still count as a fit, so one missed
  month does not disqualify a mortgage.

`biweekly` and `semimonthly` overlap on purpose — 26/year and 24/year are two
days apart and genuinely ambiguous from gaps alone. They are separated by
**counting occurrences per month**: semimonthly produces exactly two a month
forever; biweekly produces three in some months. A month-end series that clamps
31 → 28 → 31 is read as monthly rather than irregular, and anchored on the
largest observed day.

**If nothing fits, the detector proposes nothing.** It never guesses.

**3. Amount stability.** The amounts are measured with **median absolute
deviation**, not standard deviation. A rent series with one annual true-up has a
standard deviation that says "variable" and a MAD that correctly says "fixed with
an outlier". A spread within **2% of the median** is `fixed`; anything wider is
`trailing_median`, which prices future occurrences from the trailing median and
gets a wider matching tolerance.

**Staleness.** A series whose last occurrence is more than **2 nominal periods**
old is not proposed — a cancelled subscription should stop showing up, and one
that is merely late should not.

Transfer categories are excluded in both directions: moving your own money
between your own accounts is not an obligation.

---

## Detection proposes; it never commits

**Nothing writes an obligation without you clicking** (ADR-036 §2). This is the
same posture as QFX import — parse → preview → confirm — and it is not a
courtesy.

A confirmed obligation changes the number a household makes a spending decision
on. If detection wrote directly, a mis-read cadence would silently move
safe-to-spend, and the user would have no way to know which of the app's
assumptions was wrong. Confirming is also the moment you get to **edit**: the
label, the amount, the cadence, the anchor date and the category are all yours to
correct before anything is stored.

Detection is also **not** categorization. A confirmed obligation inherits the
category its transactions already have; it does not assign one.

A candidate you **dismiss** stays dismissed — indefinitely, or snoozed for a
stated number of days. A candidate you **confirm** is never re-proposed: the
detection key is stored on the obligation under a partial unique index, so the
same series cannot appear twice.

---

## Bills you already told the app about

Detection guesses from bank text. A **loan** is the one bill whose schedule you
have already stated: recording its terms gives the app the principal, the rate
and the term, and the payment follows in closed form. Waiting to *recognize* a
payment you already described is a strange thing for the app to do — so it does
not (ADR-047).

Every `loan` account with recorded terms proposes a schedule on
**`/plan/cashflow/review`**, above the detector's suggestions and under its own
heading. It is still a **suggestion**: nothing goes on the calendar until you
click, on a fresh install or on an upgrade. There is no confidence grade on these
rows, because nothing was guessed.

**The amount prefers your own payments over the computed one, and that matters
more than it sounds.** The closed-form figure is *principal and interest*. A real
escrowed mortgage payment is materially larger — property tax, insurance, PMI
ride along — and the matcher only accepts a posted payment within ±15% of what it
expected. Expect P&I, watch a payment that is 25% bigger arrive, and the app
would report that a bill *did not post* on a mortgage you paid on time. So:

| What the app can see | What it proposes | What it says |
|---|---|---|
| Two or more matching payments in the last six months | Their median, priced as `varies` | Both figures side by side, so the gap — your escrow — is visible once |
| No payments yet | Principal and interest | That escrow and PMI are **not** in the figure, and that you should correct it if you know better |

Two more things it will not do. It **never guesses which account pays it** — if
your own payments do not point at exactly one everyday account, the row asks you
to pick. And it **never dates a payment it has no evidence for**: with no imported
payments the schedule starts today rather than at the loan's origination, because
back-dating six years of occurrences would report every one of them as a bill
that did not post.

If the detector has *also* proposed something that looks like the same payment,
the row says so before you confirm. Both are legitimate rows and the app cannot
tell them apart for you — but adding both would put the same money on the
calendar twice.

A confirmed loan schedule is marked **"from your loan terms"** wherever it
appears, so a bill you never typed in by hand still explains itself.

---

## The obligation lifecycle

```
        detector (weekly)              you (review page)
transactions ──────────► candidate ──────────────────► scheduled_obligation
                             │  confirm                        │
                             │                                 │ materialize
                             └── dismiss ──► (gone)             │  (nightly)
                                                                ▼
                                                    obligation_occurrences
                                                       status = scheduled
                                                                │
                                        ┌───────────────────────┼──────────────┐
                                        │ sweep (nightly)       │              │ you
                                        ▼                       ▼              ▼
                                     matched                 missed         skipped
```

**`scheduled_obligations`** is the confirmed record: label, cadence, anchor date,
expected amount, direction, amount mode, account, optional category, optional end
date, and an `active` flag. Deactivating one keeps its history rather than
deleting it.

**`obligation_occurrences`** is the materialized calendar — one row per due date,
written nightly out to the horizon plus a 30-day lead so the calendar never runs
out mid-projection. Materialization is idempotent on `(obligation_id, due_date)`:
running it twice writes nothing the second time, and re-running over a date that
already matched **preserves the match**.

Each occurrence **snapshots its expected amount** at materialization (ADR-037
§5). It does not read through to the obligation. If you raise the expected rent
in June, May's occurrence still says what May expected — otherwise editing an
obligation would silently rewrite history and every past variance would vanish.

**Statuses**

| Status | Meaning |
|---|---|
| `scheduled` | Materialized, not yet reconciled against reality. |
| `matched` | A transaction was found for it. Carries the transaction id, the **actual** amount, and when the match was made. |
| `missed` | Its match window closed with nothing found. This is what the "the mortgage did not post" alert reads. |
| `skipped` | You said this one is not happening. Deliberately distinct from `missed`: a skip is intent and never raises an alert. |

**Matching tolerances** (`DEFAULT_MATCH_TOLERANCE`): ±**5 days** around the due
date — a weekend plus a bank holiday — and an amount within **15% or $5**,
whichever is larger, so a small bill is not held to a percentage. A
`trailing_median` obligation gets **50%**, because a seasonal utility swing is
what that mode *means*.

The pick is **deterministic**: closest date, then smallest amount difference, then
transaction id. Two occurrences never claim the same transaction, and an
occurrence that is already `matched`, `missed` or `skipped` is never re-decided.

A matched occurrence is displayed at **what actually posted**, not at what was
expected — otherwise the calendar would contradict the transactions page.

---

## The residual rate, and the double-count it prevents

**This is the most important piece of arithmetic in the phase**, and the bug it
exists to prevent is not a crash. It is a plausible number that is quietly wrong.

Recurring obligations are **already inside observed spend**. The mortgage that
left the account on the 1st is a transaction like any other, and it is in the
trailing-spend total. So a projection that takes a total-spend run-rate **and
also** puts the mortgage on the calendar on the 1st has charged you for your
mortgage twice — every month, forever.

On a household spending $4,500 a month of which $2,700 is confirmed obligations,
the naive version projects $7,200 of outflow against $4,500 of reality:
safe-to-spend collapses, the low-water mark invents a shortfall, and the family
learns the feature lies.

The fix is arithmetic, not machinery. Everything the calendar states **exactly**
is removed from the rate, and only what is left is spread flat:

```
residual daily rate = (observed expense − expense attributable to
                       confirmed obligations) ÷ window days
```

The window is the trailing **90 days**. The attribution comes from matched
occurrences, so it improves as matching improves.

**The clamp is not defensive programming.** A negative residual would say the
household earns money by existing. When attribution exceeds observation, what is
wrong is the *attribution* — a mis-matched occurrence, a duplicate import, a
stale expected amount. The rate goes to zero and the fact is carried upward so it
is reportable rather than invisible.

**Coverage is displayed, not buried.** Alongside the rate, the app reports what
share of your recent spending the calendar accounts for. *"$20/day of everyday
spending, 62% of your spend accounted for by known bills"* is a number you can
judge; *"$20/day"* alone is a number you can only trust. Coverage rises visibly
as you confirm obligations, which is what makes the feature improve rather than
merely exist.

---

## Safe-to-spend

```
safe-to-spend = min(closing balance across the horizon) − cash floor,
                clamped at zero
```

**Why the low point rather than the ending balance.** A horizon that ends at
$4,000 but dips to $80 the week before payday has $80 of headroom, not $4,000.
Spending against the ending balance is exactly how a household overdrafts while
its app says everything is fine. The binding constraint is the worst moment in
the window, so that is the moment the figure comes from — and **its date travels
with the number**, because *"you can spend $312"* is advice and *"you can spend
$312; the tight day is March 14"* is something a family can plan around.

**Falling below the floor is a different sentence.** A negative result is not an
allowance of minus two hundred dollars, it is a **shortfall**, and it is reported
as one: how far below, and on which day. "You could spend $0" is useless; "you
are short $1,400 on the 14th" is actionable.

**Landing exactly on the floor is not a shortfall.** A household whose low point
sits exactly on its stated buffer has a plan that works with nothing to spare.

**The figure never appears without its horizon and its floor** — on the page or
on the dashboard card, in every state. A bare "$1,240" reads as a balance, and it
is not one: it is what you may spend *on top of your usual spending*, over a
stated window, before breaching a cushion you chose.

### What it deliberately excludes

The projection walks **operating cash only** — accounts whose subtype is
`checking` or `cash_management` (ADR-038 §6). It excludes:

- **Savings and money market** (`reserve`). Spending your emergency fund is not
  headroom. That is what the [guidance](GUIDANCE.md) waterfall is for.
- **CDs** (`medium_term`). The money is term-locked; counting it would say you
  can spend cash you cannot reach without a penalty.
- **Brokerage and retirement.** Not cash, and not same-day.
- **Credit cards.** Available credit is not money you have.

An account with **no subtype set** is unclassified and contributes nothing —
loudly, via the degraded state below, rather than silently.

### What a shortfall means when your savings could close it

The line stays exactly as described above: **savings never enters it**, and that
is deliberate. A projection that quietly drew on the emergency fund could never
tell you that you are overspending — it would run flat until the savings ran out
and then fall off a cliff with no warning.

But *reporting* a shortfall without looking at your savings was its own problem.
"You are projected to run out of money on October 22" is one sentence serving two
opposite situations: for a household with a funded emergency fund it over-alarms,
and for one without it under-states a real problem. So the figure is unchanged and
a **second sentence** now goes with it (ADR-048):

| What the app can see | What it says | Alert |
|---|---|---|
| Savings ≥ the shortfall | A **timing** problem: what to move, by when, and what is left in savings afterwards | `info` — stated, never silenced |
| Savings > 0 but less than the shortfall | What moving all of it still leaves you short | unchanged |
| Savings accounts on file, and empty | A **solvency** problem, said plainly | unchanged |
| Cash accounts still unclassified | That it cannot tell, and where to fix that | unchanged |

A covered shortfall is graded down to `info` rather than suppressed. A household
that raids its emergency fund every single month is technically fine every single
month, and the repetition of a quiet alert is the only way that pattern becomes
visible.

Two things this page still will not tell you. It **states no emergency-fund
target** — whether what remains is *enough* is [guidance](GUIDANCE.md)'s question,
answered there against the full picture, and computing a second "how many months"
here is how two numbers come to disagree on one screen. And it **moves no money**:
there is no transfer button and never will be (this is a read-only tracker). What
you get is a sentence about a number you already had.

### The two settings

Both live at **`/settings/household`**, both are optional, and both default to a
constant checked into the repo rather than a value pinned into the database on
install day.

| Setting | Default | Range | What it does |
|---|---|---|---|
| **Cash floor** | `0.00` | ≥ 0 | The buffer subtracted from the low point. A default cushion would silently reduce a number you act on by an amount nobody chose — so the default is zero, and the figure always shows the floor beside it. |
| **Projection horizon** | 60 days | 14–365 | How far the walk runs. 60 days contains a full pay cycle plus two monthly bill cycles — the window you can still act in. Past roughly 90 days the residual rate dominates the line and it stops being information; 365 is a guard rail, not an endorsement. |

---

## When the app cannot say it honestly

Four levels, in order of how fundamental the missing input is (ADR-038 §7). Every
one of them **names the missing input and links to where you supply it**.

| Level | When | What you see |
|---|---|---|
| `no_operating_account` | No account is marked `checking` or `cash_management` | **No projection at all.** There is no balance to walk forward from, so the page does not draw a line. Links to `/accounts`. |
| `insufficient_history` | Under **3 months** of transactions | The dated **schedule** renders, labelled as a schedule rather than a forecast. **No safe-to-spend figure.** Links to import older statements. |
| `run_rate_only` | No confirmed obligations | A real projection carrying your everyday spending rate and nothing else — no rent, mortgage or subscriptions on the dates they land. **Labelled as such**, with the number of candidates waiting. Links to `/plan/cashflow/review`. |
| `ok` | Everything present | The figure, with its coverage percentage beside it. |

**Why `insufficient_history` withholds the figure** even though a projection
technically exists for it: the residual rate is zeroed at that level, because
there is no honest one. Any safe-to-spend derived from it would assume the
household spends nothing day to day — which **inflates** the number, and ADR-038
§5 names inflation as the dangerous direction. The calendar is still useful; the
headline would be a lie. The alert engine refuses to alert from that level for the
same reason, and both read the same list
([`STATED_FIGURE_STATUSES`](../src/lib/cashflow/status.ts)).

Under `ok`, **thin coverage shows its percentage** beside the number — under 25%
it is highlighted, because a projection accounting for a fifth of your spending
is a projection you should read sceptically.

---

## Alerts

Three types, all written by `project-cashflow-daily` and by nothing else.

| Type | Fires when |
|---|---|
| `projected_shortfall` | The projection dips below your cash floor inside the horizon. Severity is `critical` if the balance actually goes negative, `warning` if it merely breaches your buffer — different sentences. It drops to `info` when your savings covers the gap, which is a timing problem rather than a crisis (ADR-048). |
| `obligation_missed` | A confirmed occurrence's match window closed with nothing found. Fires for receipts too: a rent cheque that never arrived leaves the projection wrong in the optimistic direction. |
| `obligation_amount_changed` | A matched bill posted for more than **5% or $5** off its expectation, whichever is larger. `trailing_median` obligations never fire — varying is what that mode means. |

A standing condition **never re-nags** (ADR-026): a household projected short in
March is projected short again tomorrow, and a nightly alert is how you teach
someone to ignore the alerts page. A shortfall alert resolves itself when the
projection recovers.

**No figure appears in an alert title**, and **nothing at all appears in the
email**. The notification is a doorbell carrying a count and a link; the numbers
live in `detail`, which renders only in the authenticated UI. A shortfall alert
may say one exists; it may never carry the number (ADR-015 — this is permanent).

---

## When it runs

| Job | Schedule | What it does |
|---|---|---|
| `detect-obligations-weekly` | Sundays 06:30 | Re-runs detection over 24 months and refreshes the candidate list. |
| `project-cashflow-daily` | Chained after `compute-snapshots-daily` (02:00) | Materializes occurrences to the horizon, sweeps matches, raises and resolves alerts. |

`project-cashflow-daily` is **chained rather than cron'd** on purpose: day zero of
the projection *is* the latest `account_snapshots` row, so a projection built
before the snapshot job ran would be wrong by a day in exactly the direction the
household is asking about. Both jobs are idempotent, so a missed or double run is
safe.

Run either by hand:

```bash
# `register.mjs` stubs Next's `server-only` marker; without it run-once.ts
# aborts with ERR_MODULE_NOT_FOUND (same note as docs/ALERTS.md):
docker compose -f docker/compose.yaml --profile prod run --rm --no-deps worker \
  node --experimental-strip-types --import tsx --import ./scripts/loaders/register.mjs \
  src/worker/run-once.ts project-cashflow-daily
```

Both print **counts only** — never a balance, an amount, or a label.

---

## Nothing here is stored

A projection is **computed on read** from the schedule, the balances and the
trailing spend (ADR-032 §3, applied again). Persisting it would create a second
source of truth that goes stale the moment a transaction imports.

What *is* persisted is the **schedule** (`scheduled_obligations`) and its
**materialized occurrences** — facts about what you have confirmed and what
actually happened, not derived figures.

---

## Documented limitations

These are real and stated rather than hidden. None of them is a bug report.

**The residual rate is flat.** It spreads everyday spending evenly across the
horizon, which ignores weekday clustering and the post-payday spike. A household
that spends most of its discretionary money in the three days after a paycheck
will see a smoother line than reality. Modelling that is deferred until the
projection is *measurably* wrong in real use, rather than modelled on suspicion.

**Variable obligations carry their variance.** A `trailing_median` utility bill is
projected at its trailing median, so a hot August will post above the line. A
seasonal curve is speculation until a real utility series says otherwise.

**Matching quality bounds residual accuracy.** The residual subtraction is only as
exact as occurrence matching. Unmatched obligations leave their spend inside the
run-rate *and* on the calendar — the double-count this phase exists to prevent,
in miniature. This is precisely why **coverage is displayed**: it is the number
that tells you how much to trust the other number.

**A bill recorded as `missed` is still treated as spent.** Attribution counts
an occurrence the sweep marked `missed` at its expected amount, exactly like
one whose window is still open. The reasoning is that a missed mortgage is
usually *late*, not cancelled, and the money is still owed — but the
consequence is worth knowing: the occurrence is not re-dated into the future
either, so a missed bill leaves the projection entirely and safe-to-spend
rises by its share of the rate. The alternative — treating `missed` like
`skipped` — errs the safe way but would double-charge a bill that *did* post
under a renamed payee and was marked missed only because matching failed.
`skipped` is different and unambiguous: you said it is not happening, so it is
attributed nothing.

**All operating accounts are summed into one running balance.** A household that
pays bills out of two checking accounts and transfers between them will see a
correct total that hides a shortfall in one of them. Noted as a stated
assumption; revisit if you actually operate that way.

**Escrow is absorbed, not modelled.** A loan schedule priced from your own
payments carries whatever escrow was in them, as one number. When the servicer
re-analyses escrow — usually once a year — the payment steps, and the existing
*"a recurring bill went up"* alert reports it; there is no tax-and-insurance
breakdown behind it, and a payment shown as `varies` will not fire that alert at
all. Modelling escrow properly is a phase, not a footnote.

**A loan schedule with no imported payments is principal and interest only.** It
will read low by the escrow, and the review row says so before you confirm.
Correct the amount if you know it; otherwise it corrects itself once payments
land.

**A shortfall is classified against savings the app can see.** Reserve cash at an
institution you have not added reads as *uncovered*, which is the app stating what
it knows rather than what is true. Adding the account fixes it. Un-triaged cash is
never counted as savings either — a `NULL` subtype might be a CD, or a second
checking account already inside the line.

**A one-off cost you record can overlap this window.** A planned expense
(see [SINKING.md](SINKING.md)) is charged to the projection on its due date and
tagged *one-off* in the chart. It does **not** change your everyday spending
rate, which is correct — the residual removes what trailing *observed* spend
already contains, and a cost dated in the future has not been spent. The
exception is an *annually recurring* cost recorded as a one-off: its prior-year
instance may sit inside the 90-day residual window, in which case a version of it
is charged twice. Enter recurring costs as obligations, which is what the entry
form's duplicate warning nudges toward.

**A recorded cost is never deduplicated against a confirmed bill.** Both land on
the line, on purpose — only you know whether the roof and the roof-shaped bill are
the same roof, and dropping one silently would decide that for you with nothing
on screen admitting it.

**Plaid's recurring-streams endpoint is deliberately not used.** Local detection
over data already on the box has zero egress and no per-Item cost, and ADR-033
§6's manual-first posture applies identically.

---

## If a number looks wrong

Work down this list — it is ordered by how often each is the cause.

1. **Read the coverage figure first.** A low percentage means the calendar knows
   about little of your spending, so most of the line is a flat rate.
2. **Read the `inputs used` trail** at the bottom of `/plan/cashflow`. Every
   figure names what produced it. A wrong output usually points at a wrong
   *input* you can fix.
3. **Check for an unmatched obligation.** A confirmed bill that never matches is
   counted twice — once in the run-rate, once on the calendar. `/plan/cashflow`
   shows what did not post.
4. **Check account subtypes.** An unclassified checking account contributes
   nothing to the opening balance.
5. **Check the anchor date and cadence** on the obligation itself. A monthly bill
   anchored on the wrong day moves the low-water date.
6. **Check whether a cliff is a one-off you recorded.** The tooltip tags it. A
   cost you entered twice — once here, once as a bill — is charged twice by
   design; [SINKING.md](SINKING.md#duplicate-entry-is-warned-never-merged) says
   why.

---

## See also

- [GUIDANCE.md](GUIDANCE.md) — the waterfall and recommendations that decide
  where money *should* go; this doc is about when it actually moves.
- [SINKING.md](SINKING.md) — what the irregular costs on this calendar require
  you to be **holding now**. Its second cost source is the obligations this doc
  describes, and its cadence threshold exists so a monthly bill is not counted
  both in the residual rate here and in a reserve requirement there.
- [INCOME.md](INCOME.md) — how paychecks are defined; the projection's inflows
  come from **observed** take-home, not declared gross.
- [ATTRIBUTION.md](ATTRIBUTION.md) — the backward-looking counterpart: this doc
  projects a window that has not happened, that one explains one that has.
- [ALERTS.md](ALERTS.md) — the full alert catalog and email setup.
- [DASHBOARD.md](DASHBOARD.md) — the card layout and how cards degrade.
- [IMPORT.md](IMPORT.md) — getting the history the residual rate needs.
- [PLAN16.md](../plans/features/PLAN16.md) — the task breakdown and the rejected
  alternatives.
