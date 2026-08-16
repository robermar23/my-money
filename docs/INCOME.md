# Income & retirement contributions (Phase 14)

A 401k shows what it is *worth*. It rarely shows what it **cost** — employer
plans almost never report a cost basis, so gain/loss renders "—" forever.

The fix is not better data from the institution. It is the observation that for a
payroll-funded retirement account, **cost basis is just the sum of what you
contributed** — and you already know that number, because you chose it. So you
define your paycheck and your contribution rule, and a nightly job turns each
payday into a real acquisition in the investment ledger.

Locked by **ADR-030** (the data model) and **ADR-031** (materialization) in
[IDEAS.md](../plans/features/IDEAS.md) §11; task breakdown in
[PLAN14.md](../plans/features/PLAN14.md).

> **Scope (binding — CLAUDE.md §Domain Scope).** This models income **only as far
> as it defines a retirement contribution and a savings rate.** It is **not
> payroll and not budgeting-income**: no net pay, no withholding, no FICA, no
> deduction stack, no paycheck stub. We store *gross per period* and nothing
> about taxes. `pretax` is a **label**; it drives no tax math. Contributions
> create *acquisition* lots — there is still no tax-lot selection, no wash-sale
> handling, no realized-gain or 1099 reporting.
>
> **Privacy (binding — CLAUDE.md §Privacy).** Gross pay is the most sensitive
> data class in the app, and Phase 14 adds **no new egress class**. Income,
> contribution, and match amounts live in local Postgres and are **never sent
> anywhere and never logged**. There is no payroll integration — no ADP, no
> Gusto, no Plaid-payroll — by design: you *define* your income, which is the
> whole point. The only outbound call anywhere near a contribution is the
> pre-existing nightly price fetch for a ticker you already hold, which sends a
> symbol and never a dollar. A regression test
> ([privacy-egress.test.ts](../src/lib/income/privacy-egress.test.ts)) fails the
> build if any of that stops being true.

---

## The model: three tables

| Table | Holds | Grain |
|---|---|---|
| [`income_sources`](../src/db/schema/income-sources.ts) | The paycheck: cadence, gross per period, anchor date, active window | One per job |
| [`retirement_contributions`](../src/db/schema/retirement-contributions.ts) | The rule: employee %/$, employer match + cap, which account/holding it funds | One (or more) per source |
| [`income_contributions`](../src/db/schema/income-contributions.ts) | The materialized ledger: what was actually contributed, and what it created | One per **(rule, pay date)** |

The third table is what makes the feature safe. `UNIQUE (retirement_contribution_id, pay_date)`
is the idempotency key: the job can run twice, overlap with the backfill, or be
re-run after a crash, and no payday is ever contributed twice.

Three tables rather than one because a single row collapses the moment there are
two jobs, or the rate changes mid-year, or you need to answer *"did we already
book March 15th?"*. A mid-year change is a new source with the old one
end-dated; history stays intact in the ledger either way.

---

## Defining a paycheck — `/settings/income`

**A source** is a cadence (`weekly` / `biweekly` / `semimonthly` / `monthly`), a
gross per period, and an **anchor date** — any real payday. The anchor *phases*
the schedule; it does not bound it. Pay dates generate in both directions, so
anchoring on your most recent payday still backfills correct history.

Day-of-month cadences **clamp rather than drift**: monthly anchored on the 31st
pays Jan 31 → Feb 28 → Mar 31, because the day always comes from the anchor and
never from the previous (clamped) result. Semimonthly pays on `d` and `d + 15`,
so a 30th anchor and a 15th anchor describe the same schedule.

**A rule** attaches to a source:

- **Employee** — a percent of gross, or a fixed dollar amount. A fixed amount
  larger than gross is **clamped to gross**; the preview shows the correction
  rather than letting you discover it months later inside your gain/loss.
- **Employer match** — `none`, `percent_of_gross`, `percent_of_contribution`, or
  a flat `amount`, then clamped to `match_cap_percent × gross` when a cap is set.
  Single-tier only; a tiered "100% to 4%, then 50% to 6%" engine is a recorded
  Open Item.
- **Target** — the investment account, and *optionally* the holding to buy.

Saving is not the interesting moment — the job is. So the form **previews the
effect before you commit**: this period's employee and employer dollars, and the
annual savings rate that would result.

Every one of those computations goes through `Money`/decimal.js. Percent-of-gross
on a float is the single most likely way a contribution feature produces a wrong
cost basis, so native arithmetic on a money value appears nowhere in this phase.

---

## How a contribution becomes cost basis

The design goal was **zero special-casing downstream**. A contribution is written
to look exactly like a buy, so the existing machinery consumes it unchanged:

```
pay date → employee + employer dollars → investment_transactions (buy)
                                       → holding_lots (source='income')
                                       → resolveCostBasis (ADR-012: sum of lots)
                                       → gain/loss · TWR · XIRR · allocation · snapshots
```

`resolveCostBasis` prefers summed lots over `holdings.cost_basis`, and it does not
look at `source`. That is the entire seam — and it is
[tested end to end](../src/lib/income/contribution-basis.test.ts) rather than
assumed, because it is the claim the whole phase rests on.

### Priceable vs. basis-only

Real 401ks come in two flavors, and only one of them can be turned into shares.

| | **Priceable** | **Basis-only** |
|---|---|---|
| When | The rule targets a holding whose symbol has a close on/before the pay date | No holding designated, an opaque institutional fund, or a date older than our price history |
| Transaction | `type='buy'`, `subtype='contribution'` | `type='cash'`, `subtype='deposit'` |
| Quantity | `dollars ÷ close` at the pay-date close | **None** — a zero-quantity lot carrying full basis |
| Position quantity | Incremented by the job | Stays your manual entry |
| Cost basis | ✅ | ✅ |
| Savings rate | ✅ | ✅ |

Basis-only is the honest failure mode, not a degraded one. We know the dollars
exactly; we do not know the share count. Inventing one would produce a
confidently wrong position, so the app declines to — and says so on the page
("some contributions could not be priced, so their basis is recorded without
shares — this position's quantity is your own entry").

Both classify as an **external flow**, so TWR and XIRR see the contribution
either way and money-weighted return stays correct.

---

## The jobs

| Job | When | Window |
|---|---|---|
| [`materialize-contributions`](../src/worker/jobs/materialize-contributions.ts) | Nightly **01:45** | Trailing 45 days |
| [`backfill-contributions`](../src/worker/jobs/backfill-contributions.ts) | Run-once, on demand | Each source's `start_date` → today |

**01:45 is not arbitrary.** It sits after `fetch-prices-daily` (01:30) so a
same-day contribution prices off a same-day close, and before
`compute-snapshots-daily` (02:00) so the lots and quantities written tonight are
valued tonight. No change to the snapshot job was needed.

**The 45-day lookback** self-heals an outage. A NAS that was off for a fortnight
catches up on its own without anyone running the backfill; re-covering dates that
already exist costs one indexed lookup each, which the UNIQUE key absorbs.

**The backfill is a thin wrapper over the same code path** with a wider window —
deliberately, so historical basis and ongoing basis can never disagree about what
a contribution is. It is honest about prices: dates predating our price history
record dollars only, dates with a close buy real shares, and one backfill
typically spans both.

```bash
# Materialize every historical pay date from each source's start.
node --env-file=.env.local --import tsx src/worker/run-once.ts backfill-contributions

# Or force tonight's window immediately.
node --env-file=.env.local --import tsx src/worker/run-once.ts materialize-contributions
```

Both print counts — rules considered, contributions created, priceable vs.
basis-only. **Never a dollar figure**; that is a typed property of the result, not
a convention.

### Idempotency, in order

Each contribution **claims** its `(rule, pay_date)` slot with an
`ON CONFLICT DO NOTHING` insert *before* anything derived is written. If the
claim loses a race, the transaction commits having written nothing. One
transaction per **pay date**, not per rule: a failure on the 40th date of a
52-date backfill leaves the first 39 committed and correct, and the re-run picks
up exactly where it stopped.

Deactivating a rule or its source pauses materialization without losing either
the rule or its history.

---

## The savings rate

```
annual gross    = Σ over ACTIVE sources of (gross_per_period × periods/yr)
annual employee = Σ employee_amount over the window
rate %          = annual employee ÷ annual gross × 100
```

**Derived, never stored** — there is no `savings_rate` column and there should
never be one. A corrected paycheck or a re-run backfill fixes the number
everywhere at once.

**This is the app's only savings rate**, and Phase 15's guidance engine consumes
it rather than recomputing one (ADR-034 §2). The guidance layer does derive an
*observed net income* figure from the deposits that actually landed, but it is
used only as the 50/30/20 denominator and as a reserve input, under a different
name — never as a second savings rate. Pre-tax 401k dollars never appear as a
deposit, so a net-based rate would visibly contradict this one, and two
disagreeing rates read as a bug even when both are correct. See
[GUIDANCE.md](GUIDANCE.md).

The [dashboard card](DASHBOARD.md) reads a **trailing 12 months regardless of the
selected `?range=`**. A savings rate is annual by definition: a one-month
numerator over an annual gross is not a zoomed-in figure, it is a wrong one.

The card says **"estimate"** and names its window, because the denominator is
*projected* (current gross × periods/yr) while the numerator is *measured*
(contributions actually materialized). A rule created mid-year, or a backfill
that hasn't run yet, legitimately shows a low rate — the window label is what
makes that legible instead of alarming.

Three states worth distinguishing:

| Situation | Shows |
|---|---|
| No income source defined | The empty card — **not** 0%, which would assert you save nothing |
| Source defined, nothing materialized yet | An honest **0%** |
| All sources paused | **No rate** (there is no denominator), while past contributions still show |

Only the **employee** side counts toward the rate. An employer match is real cost
basis, but it is not income you chose to save, so it is displayed beside the rate
and excluded from it.

One honest edge: retiring a source removes it from gross while its historical
contributions remain, which can push the rate above 100% in that year. That is
correct arithmetic on a real situation, not a bug to clamp away.

---

## ⚠️ Double-counting: income rules vs. Plaid sync

**If the same holding is both Plaid-synced and funded by a contribution rule, its
basis can double-count.** Plaid reports the buys the plan actually made; your rule
books the same dollars from the other direction.

What the app does about it:

- **Source-scoping.** The job writes only `source='income'` rows and never reads,
  updates, or deletes a `source='plaid'` or `source='manual'` transaction or lot.
  There is a test for exactly this.
- **Quantity deference.** A Plaid-sourced holding's quantity is left to the sync;
  the job adds basis but not shares, because incrementing there would double-count
  until the next sync overwrote it.
- **An inline warning** on `/settings/income` when a rule targets a holding that
  already carries Plaid lots.

It is a warning rather than a refusal: the pairing is legitimate during a
transition, and the guardrail belongs to the person who can see both sides. For a
manually-tracked 401k — the common case — income is the sole source and none of
this arises. A hard guard is a recorded Open Item if the soft one ever bites.

---

## Where it surfaces

| Surface | Shows |
|---|---|
| `/settings/income` | Sources, rules, live preview, materialized count + last pay date |
| Dashboard | The savings-rate card |
| `/accounts/[id]` (investment) | A read-only **Contributions** ledger — pay date, source, you, employer, total — plus a `†` on contribution-funded cost basis |
| `/investments` | `†` marker + per-account footnote on contribution-funded basis |
| `/investments/security/[id]` | "Cost basis tracked from payroll contributions", the basis-only caveat, and a **Source** column on the lots table |

The ledger is read-only everywhere. The job is the sole writer of contributions —
edit the rule, not the rows.

---

## Tests

| Surface | Where |
|---|---|
| Pay-schedule expansion (drift, clamping, both directions) | [schedule.test.ts](../src/lib/income/schedule.test.ts) |
| Contribution + match math, cap boundaries, clamps | [contribution.test.ts](../src/lib/income/contribution.test.ts) |
| Savings-rate derivation | [savings-rate.test.ts](../src/lib/income/savings-rate.test.ts) |
| Planner: priceable vs. basis-only, dedup, window intersection | [materialize.test.ts](../src/lib/income/materialize.test.ts) |
| Job: writes, idempotency, reconciliation guard | [materialize-contributions.test.ts](../src/worker/jobs/materialize-contributions.test.ts) |
| Backfill: count + total basis at two-year scale | [backfill-contributions.test.ts](../src/worker/jobs/backfill-contributions.test.ts) |
| **Contributed dollars → cost basis → gain/loss** (the seam) | [contribution-basis.test.ts](../src/lib/income/contribution-basis.test.ts) |
| Form validation + refinements | [income.test.ts](../src/lib/schemas/income.test.ts) |
| Zero-egress + no-logging regression | [privacy-egress.test.ts](../src/lib/income/privacy-egress.test.ts) |
| The rendered flow (E2E) | [phase14-income.spec.ts](../e2e/phase14-income.spec.ts) |

Date math and money math are always-test surfaces (CLAUDE.md §Testing Philosophy)
for the obvious reason: a schedule that drifts or a percentage that rounds wrong
puts a bad cost basis on a retirement account and leaves it there for years.
