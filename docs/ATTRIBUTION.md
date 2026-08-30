# Net-worth attribution — why the number moved (Phase 17)

The dashboard has always been able to tell you that your net worth went up
$18,400 last quarter. It has never been able to tell you **why**, and "why" is
the question a household actually asks:

> **"Did we do that, or did the market?"**

Those are opposite answers to the same figure. The first is a habit that
compounds. The second is weather. A page that shows only the total treats them
as the same event.

This phase answers with a decomposition of a number that already exists:

> *Your net worth rose **$18,400**. Most of it — **$14,900** — was market
> movement, and **$3,100** was money you kept. **$400** is unexplained.*

Locked by **ADR-039** (the endpoints are given, the rungs are the hypothesis),
**ADR-040** (the household boundary), and **ADR-041** (the rung formulas) in
[IDEAS.md](../plans/features/IDEAS.md) §11; task breakdown in
[PLAN17.md](../plans/features/PLAN17.md).

> **Scope (binding — CLAUDE.md §Domain Scope).** This is a **read-only
> decomposition**. It adds no table, no migration, no background job and no
> dependency (ADR-039 §3) — every figure is computed on read, every read, from
> rows that already exist. It is **not** a general ledger: there are no debits,
> no credits, no journal entries, and no principal/interest split on a
> transaction row. It is **not** tax reporting. It makes **no forecast** — every
> figure describes a window that has already happened.
>
> **Privacy (binding — CLAUDE.md §Privacy).** The attribution layer makes **zero
> outbound HTTP on any code path**. The obvious temptation here is a
> **benchmark** — "your portfolio returned 4.1%, the S&P returned 6.2%" is one
> fetch away — and it is also the exact shape of a request that tells a third
> party *this household holds these positions*, one page load at a time. The
> `^GSPC` closes already arrive through the nightly price job (ADR-021), so the
> rule is not "no benchmark ever": it is that a benchmark comes through the
> existing price pipeline or not at all. Nothing here is logged, this phase adds
> **no alert type** and therefore contributes nothing to the content-free alert
> email (ADR-015), and diagnostics name **accounts** but never **payees**. A
> regression test
> ([privacy-egress.test.ts](../src/lib/net-worth/privacy-egress.test.ts)) fails
> the build if any of that stops being true — it audits the layer against an
> **allowlist** of imports, so a dependency nobody thought to ban still trips it.

---

## Where to find it

| Surface | What it shows |
|---|---|
| **`/analysis/networth`** | The decomposition: the summary sentence, a waterfall from opening to closing net worth, a rung table with the inputs each rung used, and the residual with its named causes. Uses the same `?range=` toggle as the rest of `/analysis`. |
| **`/analysis`** | One sentence and a link, reading the same window. No second computation. |
| **Dashboard** | **Nothing.** Deliberately — see [What is deliberately absent](#what-is-deliberately-absent). |

---

## The identity

Everything in this phase is one line:

```
closing − opening = saved
                  + retirementContributions
                  + debtPrincipalPaid
                  + investmentReturn
                  + assetRevaluation
                  + unexplained
```

It holds exactly, on every book, always — because `unexplained` is defined as
whatever makes it hold. That is not a trick; it is the design, and the next two
sections are why.

### The endpoints are given; the rungs are the hypothesis

`opening` and `closing` come from `computeNetWorth` — **the same function behind
the dashboard figure and the net-worth chart** (ADR-039 §1). Nothing in this
layer may derive them a second way.

This matters more than it looks. If attribution disagreed with the chart the
household is looking at, the *chart* is what they trust, and attribution would be
worse than useless: a second number with equal apparent authority and no way to
tell which one is wrong. The rule is enforced, not asserted —
[series-parity.test.ts](../src/lib/net-worth/series-parity.test.ts) asserts the
decomposition's endpoints equal the values `netWorthSeries` reports for the same
dates, over randomly generated books.

The asymmetry is the whole design:

- **The delta is a fact.** Two balance figures, subtracted.
- **The five explained rungs are five independent estimates**, each derived from
  a different source — transactions, an amortization schedule, holdings
  snapshots, investment transactions. They are *not* guaranteed to add up.

### `unexplained` is the point, not a defect

The residual is a first-class rung (ADR-039 §4). It is:

- reported at **full magnitude**, always;
- **never** hidden below a threshold, clamped to zero, or folded into an
  adjacent rung;
- accompanied by **named contributors** pointing at the thin inputs that
  produced it, each with a link to where you fix them.

A decomposition that always reconciles perfectly is one that derived its rungs
from the very balances it claims to explain — it reconciles *by construction* and
therefore says nothing at all. The residual is the disagreement between two
genuinely separate accounts of the same window, and that disagreement is the
most useful number on the page.

When the residual exceeds **half** the size of the change, the page leads with
the diagnostics instead of the rungs. Five confident figures explaining a
minority of what happened should not sit above the admission that most of it is
unaccounted for.

---

## The rungs, one sentence each

| Rung | Formula | Source |
|---|---|---|
| **`saved`** | external inflows − external outflows over the window | `transactions` |
| **`retirement`** | Σ \|amount\| where `source='income'` | `investment_transactions` |
| **`debt_principal`** | Σ `balanceAtMonth(from) − balanceAtMonth(to)` per loan | `liabilities` (the schedule) |
| **`investment_return`** | Σ `marketGrowth` per investment / crypto_ira account | endpoints + `investment_transactions` |
| **`asset_revaluation`** | Σ balance delta across `property` + `personal_asset` | `account_snapshots` |
| **`unexplained`** | delta − (the five above) | — |

Every rung is signed and every rung can legitimately be negative. A household can
spend more than it earned; a market can fall; a house can be revalued downward.
Nothing is clamped — clamping `saved` at zero would tell a family their money
vanished mysteriously when in fact they overspent, which is both true and useful.

### `saved` is a cash-flow figure, not a balance delta

The obvious implementation — "add up how much the cash accounts moved" — would be
a catastrophe dressed as a simplification. Every rung would then be derived from
the same balances the identity is trying to explain, the residual would come out
zero on every book forever, and the single most useful output of this phase would
become a constant.

`saved` is therefore built from transaction rows, independently. That is what
makes the residual a real measurement.

### `investment_return` contains no return math

Phase 9 already answers "contributions versus market growth", correctly and under
test. This phase calls `attribution()` per account and sums `marketGrowth`. If a
line of return arithmetic ever appears in
[investment-return.ts](../src/lib/net-worth/investment-return.ts), it is being
reimplemented — and two implementations of `marketGrowth` is exactly how the
investments page and this page end up disagreeing about the same quarter with no
way to tell which is right.

Dividends, interest and fees stay **inside** market growth: they are money earned
on (or spent from) capital already in the portfolio, which is the right household
reading and the convention Phase 9 already ships.

---

## Why principal is counted twice, with opposite signs

**This is the single most likely thing for a future reader to "fix" into a bug.**
It looks like double-counting. It is not.

A $2,000 mortgage payment of which $500 is principal appears in `transactions` as
**one $2,000 expense**. The app has no principal/interest split on a transaction
row and is not going to invent one (CLAUDE.md §Domain Scope: no general ledger).
So:

| | |
|---|---|
| `saved` falls by | **−$2,000** — the whole payment left the household |
| `debt_principal` adds back | **+$500** — you still own that part |
| net effect on net worth | **−$1,500** — the interest |

−$1,500 is exactly the amount by which paying a mortgage reduces net worth. The
two entries are not two counts of the same money; they are one count of the cash
leaving and one count of the debt shrinking, which are two different real events
that happen to be settled by one bank transaction.

The framing is deliberate. A household reads *"you spent it, and $500 of it you
still own"* correctly. Excluding principal from outflows and showing no rung at
all is arithmetically identical and tells the family nothing.

**Both halves have to be right, and the total cannot tell you whether they are.**
Mis-implementing either direction moves $500 between `saved` and `debt_principal`
while the identity still reconciles perfectly — which is why
[decompose.test.ts](../src/lib/net-worth/decompose.test.ts) asserts the two rungs
*individually*, by name, and treats their sum as the least interesting assertion
in the file.

### Why the schedule and not the payments

`debt_principal` reads the amortization schedule
(`balanceAtMonth(from) − balanceAtMonth(to)`), which needs no transaction data at
all. It is exact, needs no categorization, and cannot be thrown off by a missing
statement.

Its cost is that it describes the loan you **agreed to**, not the one you
actually paid. An extra principal payment, a skipped month, or a refinance is
invisible to it and lands in `unexplained`, where a diagnostic can point at it.
That is the posture throughout: report the gap, never tune the rung to close it.

A loan with no `liabilities` row is skipped by `computeNetWorth` entirely, so it
contributes to neither the endpoints nor this rung — consistently, and with a
named diagnostic.

---

## Why payroll contributions are their own rung

A 401k contribution **never touches checking**. `transactions` cannot see it, so
`saved` misses it entirely — while `attribution()` correctly subtracts it as an
external flow so it is not mistaken for market growth.

Left alone, that money enters the household, raises net worth, and is explained
by no rung: it lands in `unexplained` every single period, at roughly the same
amount, forever. A residual meant to be a data-quality signal would instead be a
constant, and the household would learn to ignore it — which would quietly
destroy the most valuable output of the phase.

**The cancellation is exact by construction, not by coincidence.** The rung is
scoped to `investment_transactions.source = 'income'` — the exact marker Phase
14's materializer writes (ADR-030/031) — and it sums the same `|amount|` that
`externalFlow()` reads. So it re-adds *precisely* the flows the market rung
removed, row for row.

Widening the scope — say, to "every deposit into a retirement account" — would
break that correspondence immediately and silently. A brokerage deposit funded
from a tracked checking account carries `source='plaid'` or `'manual'`, is
correctly *not* re-added here, and reconciles through `saved` and the cash
balance instead.

The magnitude is used rather than the signed amount because a *priceable*
contribution is written as a `buy` with a negative amount and a basis-only one as
a positive `cash`/`deposit`. Both are the same event. Reading the raw sign would
subtract half the contributions and add the other half — the sort of error that
averages out to "roughly plausible" on a real book.

The **employer match rides along by design**: the materializer writes
`employee + employer` as one row, and a match is money that entered the household
without touching checking, which is exactly what this rung exists to capture.

---

## The household boundary

One question, asked of one transaction: **did this money cross the boundary of
the household?** Not "was it discretionary", not "was it planned income" — only
whether net worth could have moved.

`categories.kind ∈ {income, expense, transfer}` is not enough on its own, because
`transfer` covers three materially different events:

1. a move between two accounts this app tracks — genuinely internal, nets to zero;
2. a move to an account this app does **not** track — genuinely external;
3. a person-to-person payment — also external.

Treating all three as internal understates outflows. Treating all three as
external double-counts every card payment. No amount of care applied to `kind`
can tell them apart, because `kind` states your *intent* and the difference here
is about *what happened*.

So the verdict for a transfer is not read off the row. It is decided by whether
the counterparty leg was found in another tracked account.

### Pairing tolerances

| Tolerance | Value | Why |
|---|---|---|
| Date window | **±5 days** | An ACH between two institutions routinely posts on different days; a same-day-only rule would report most real transfers as money leaving the household. |
| Amount | **±$0.01** | Two legs of one move are the same amount. The cent of slack absorbs rounding, not fees — a transfer that arrives materially short is a different event and should not be silently paired. |

Ties are broken by the smallest day gap, then the smallest amount difference,
then by id, so pairing is deterministic on any book.

An unpaired transfer is **not guessed either way**. It is excluded from `saved`
and reported by volume as *"transfers to accounts this app doesn't track"* —
never as "unexplained", which would teach you nothing.

### Uncategorized rows are reported, never assumed

A `NULL` category gets its own verdict and contributes to no rung. It is *not*
guessed into `expense` on the strength of a negative sign: a guess there silently
moves real money into a rung you would then read as measured. Its volume is
reported instead, as a named residual contributor with a link to go and fix it.

### Why `excluded_from_baseline` is applied to take-home but not here

The advice engine excludes flagged income categories — "Reimbursements",
"Refunds" — from **take-home** (ADR-034 §1), because take-home answers *"what can
this household plan against"* and a reimbursement is not recurring.

Attribution asks a different question and gets the opposite answer: **a
reimbursement is real money that really arrived and really moved net worth.**
Excluding it here would manufacture a residual out of money you actually
received, and send you hunting for a data problem that does not exist.

**This is a deliberate divergence, not an oversight, and the two must not be
"fixed" to match each other.** Consistency between two different questions is not
a virtue. The guarantee is structural: the row shape this layer consumes carries
no `excludedFromBaseline` field at all, so it cannot read the flag even by
accident, and a compile-time guard in
[boundary.test.ts](../src/lib/net-worth/boundary.test.ts) fails if one is ever
added.

---

## What `unexplained` means, and everything that causes it

`unexplained` is the gap between the change your balances actually recorded and
the five things the app can account for. Every documented cause:

| Cause | What it looks like | Reported as |
|---|---|---|
| **Uncategorized transactions** | Money moved with no `kind`, so it counted toward neither what you earned nor what you spent. | `uncategorized`, with a count and a link |
| **Transfers to untracked accounts** | A transfer leg with no counterparty in this app — the money is treated as having left the household even if it did not. | `unpaired_transfers` |
| **Manual-balance accounts** | An account whose balance changed over the window with **no transactions in it at all**. Nothing explains the movement because nothing was recorded. | `manual_balance_accounts` |
| **Stale or missing balances** | No balance recorded within **45 days** of one end of the window, so that end is stated from stale data. Usually means the nightly job has not been running. | `snapshot_gap` |
| **Loans with no terms** | A `loan` account with no principal / rate / term recorded is left out of net worth **entirely, at both ends**. | `untracked_loan` |
| **Investment deposits from an untracked source** | A deposit into a brokerage with no matching withdrawal from a tracked cash account — the money looks like it arrived from outside the book. | `unmatched_investment_deposits` |
| **Capital improvements** | A new roof paid from tracked checking appears **twice**: as spending inside `saved`, and as revaluation in `asset_revaluation`. | Not detectable — documented below |
| **The quantity wart** | Historical net worth prices every date at **today's** share counts. | `quantity_drift` |
| **Extra principal, refinance, skipped payment** | The schedule describes the loan you agreed to, not the one you paid. | Not separately detectable |
| **Loan rounding** | A permanent **±$0.01** on any book with a mortgage. | Not detectable — see below |

### The capital-improvement limitation

A new roof paid from a tracked checking account is spending (inside `saved`) and
a revaluation (inside `asset_revaluation`). Your position is double-counted, the
identity still reconciles, and **nothing detects it**.

Modeling it would need an improvement-versus-market split the app does not hold
and a household cannot supply reliably. Naming a limitation you can reason about
beats inventing a number you cannot check.

### The one-cent residual on a mortgage

If you hold an amortizing loan, `Not yet explained` will usually read **$0.01**
or **−$0.01** even on a book where everything else reconciles perfectly. That is
not slop, and it is worth knowing so you do not go looking for a data problem.

The schedule returns the loan balance at full precision. The two endpoints round
once each — `round(Σ your accounts at the start)` and `round(Σ at the end)` —
while `debt_principal` rounds the *difference* of two full-precision balances,
once. Two roundings against one disagree by up to a cent.

It is left that way deliberately. Making the rung agree exactly would mean
deriving it from the same rounded balances the identity is trying to explain —
the *arranged, not checked* failure this whole page is built to avoid — and it
would buy one cent.

### The quantity wart (ADR-039 §2)

`computeNetWorth` values a historical date using **today's** share counts, not the
counts you held on that date. If you bought 50 shares last month, last year's net
worth is computed as though you already held them.

This is a pre-existing property of the shipped net-worth figure, not something
this phase introduced — and this phase deliberately does **not** fix it, because
changing `computeNetWorth` would move every historical figure on the dashboard
and the chart. What it does instead is **surface it**: when the app can see that a
position's share count has moved (or that no opening count was ever recorded), it
says so as a named residual contributor, so a household reading a large
`unexplained` on a window where they bought shares knows why.

"No share count recorded at the start" and "you held nothing at the start" are
different statements, and only one of them is true. The app says the first.

---

## The audit trail

Every rung carries a list of the inputs it used (ADR-039 §5) — the same
`InputUsed` shape the guidance engine uses: a label, the value, where it came
from, whether it was missing, and a link to where you supply it.

That is what makes a wrong figure debuggable. A rung you disagree with points at
an **input you can go and fix**, not at a black box you can only distrust. It is
also why the rung table is the chart's text alternative: every figure the
waterfall draws is in the table with its full trail, so the page is complete with
the chart removed — which is also what a screen reader and a very narrow phone
each get.

---

## When the app cannot say

Degrading is the normal path, not the error path. On a fresh install "we have no
balances recorded" is the *correct* answer, and the page says it as plainly as it
draws a waterfall.

| Status | Condition | What the page does |
|---|---|---|
| `ok` | Balances exist on or before both ends. | Full decomposition. |
| `insufficient_history` | Records begin **inside** the window. | States that the window predates your records, and does not present the opening figure as a measured start. |
| `no_snapshots` | Nothing recorded on or before the window's end. | No chart, no figures. Names the missing input and links to `/accounts`. |

What this ladder deliberately does **not** gate on is a **large residual**. That
is the feature, not a failure: the decomposition is fully stated and the
diagnostics name the causes. Demoting it to a degraded state would hide the one
signal this phase exists to produce.

---

## Balance sign convention

`account_snapshots.balance` is a **net-worth contribution**: assets positive,
liabilities negative. `computeNetWorth` sums snapshot balances verbatim and
negates **only** `loan` accounts, whose value comes from the amortization
schedule.

So a credit card you owe $1,200 on is stored as **`-1200.00`**, not `1200.00`.
Stored unsigned, it would count as an *asset* and overstate your net worth by
twice the balance.

The rule lives in exactly one place — `snapshotBalance()` in
[src/lib/snapshots/sign.ts](../src/lib/snapshots/sign.ts) — and every path that
writes a balance calls it. It is a map from account type to "is this a
liability", written with a `satisfies Record<AccountType, boolean>` so that
adding a new account type without deciding its sign **fails the build** instead
of quietly defaulting to storing the number as typed.

### What you type, and what gets stored

For a credit card the form asks for an **amount owed** — the figure on your
statement, positive when you owe money — and the app stores the negation:

| Account | You enter | Stored | Effect on net worth |
|---|---|---|---|
| Checking | `1,200.00` | `1200.00` | +$1,200 |
| Credit card, $1,200 owed | `1,200.00` | `-1200.00` | −$1,200 |
| Credit card, overpaid by $75 | `-75.00` | `75.00` | +$75 |

An overpaid card is rare but real, and entering it as a *negative amount owed*
reads oddly. That was the accepted cost: every alternative design — refusing
positive card entries, a `CHECK` constraint forcing card balances non-positive —
made the overpaid card **inexpressible** rather than merely awkward.

### Why the read side does not normalize

It would be easy to make `computeNetWorth` negate `credit_card` alongside `loan`
and stop worrying about writers. That would be a bug: the Plaid sync path has
always stored cards correctly negated, so a read-side negation would flip those
rows a *second* time. The convention belongs to whoever writes the row, and this
is why [credit-card-sign.test.ts](../src/lib/net-worth/credit-card-sign.test.ts)
still asserts that the read side sums a card **verbatim** — so a future change
there is a deliberate decision rather than a quiet fix.

### QFX imports warn; they never flip

An OFX `LEDGERBAL` for a credit card is positive at some institutions and
negative at others. There is no reliable rule, so the importer does not guess.
When a card statement's ending balance is positive, the import **preview** says
so, shows the exact value that will be stored, and waits — your confirm click is
the authorization. Nothing is written until then. If your bank writes the amount
owed as a positive number, cancel the import and record that date by hand, where
the field asks for the amount owed.

See **ADR-042** in [IDEAS.md](../plans/features/IDEAS.md) §11 for the full
decision, including the alternatives that were rejected and why.

---

## What is deliberately absent

- **Nothing on the dashboard.** The dashboard already gained a cash-flow card in
  Phase 16, and a backward-looking attribution is a page you visit when you ask
  the question, not a number you need at a glance.
- **No stored decomposition.** It is computed on read, every read. A stored one
  would be a cache of a derivation over data you edit — recategorize a single
  transaction and every stored row is silently stale — and a second copy of your
  financial history with its own retention and backup exposure.
- **No alert.** Nothing here fires a notification, so nothing here can widen what
  the content-free alert email carries.
- **No benchmark fetch.** See the privacy note at the top.
- **No forecast.** Every figure describes a window that has already happened;
  ADR-022's "no probabilistic modelling" still stands.
- **No per-person attribution.** A net-worth change is a household-level figure.
  Splitting it by household member would be a new inference and a new thing to
  leak.

---

## Related

- [docs/DASHBOARD.md](DASHBOARD.md) — where the net-worth figure this page
  decomposes is shown, and the shared `?range=` toggle.
- [docs/INVESTMENTS.md](INVESTMENTS.md) — `attribution()`, TWR/XIRR, and the
  contributions-versus-market-growth split the `investment_return` rung reuses.
- [docs/CASHFLOW.md](CASHFLOW.md) — the forward-looking counterpart: this page
  explains a window that happened, that one projects a window that has not.
- [docs/GUIDANCE.md](GUIDANCE.md) — the `InputUsed` audit-trail convention, and
  the take-home definition this page deliberately diverges from.
- [docs/INCOME.md](INCOME.md) — where `investment_transactions.source = 'income'`
  comes from, which is what makes the retirement rung's cancellation exact.
