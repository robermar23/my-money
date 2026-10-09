# my-money

I want to be able to track all of my income and expenses, assets, savings and investements.

I am not trying to replace Quicken or Quickbooks.

But I want a tool I can use to store personal finances.

Ideally it can integrate into the company's systems I use for banking and investing and any other online tool that can help gather info on those topics.

- I have accounts with M&T Bank where all income and payments go in and out of
- I have investment/401k accounts with:
  - Fidelity Investments
  - iTrust Capital
- I own a home and it has value and a mortgage with Sunwest Mortage
- I have a credit card account to track

Now even if not all these systems can be integrated with, I want to track them all over time.

how much I have vs owe.  total in accounts.  total value.

For investments, I want it to track value of stocks and minerals and crypto.

There are tools for this online but they call cost money and/or off easy integrations but then sell your data or advertise to you.

I want my own tool tracking my own data.

---

## Scope updates

This section records explicit, owner-approved changes to the domain scope that
CLAUDE.md §Domain Scope marks as requiring an explicit decision before they may
be built. CLAUDE.md points here as the authoritative place for those decisions.

### 2026-06-19 — Spending analytics + simple budgets (in scope)

Source: [IDEAS2.md](IDEAS2.md). The owner explicitly asked to "expand my-money
to provide details on spending and budgets related to categories" and to see
"historical and future trends … as a whole, per category, per account."

- **In scope (newly added):**
  - **Spending analytics** — historical income/expense trends as a whole, per
    category, per group, and per account, over time (first-party SQL only).
  - **Simple monthly per-category budget targets** — a recurring monthly target
    per category with actual-vs-target tracking, plus a deterministic
    trailing-average forecast of future spend.
- **Still explicitly OUT of scope:** envelope / rollover / "assign every dollar"
  (YNAB-style) budgeting; tax forms or capital-gains reporting; anything that
  ships financial data to a third-party (no LLM categorization, no analytics
  SaaS — per CLAUDE.md §Privacy).

Implemented under **ADR-018** (IDEAS.md §11 Decision Log) via [PLAN8.md](PLAN8.md).

### 2026-06-20 — Investment history, performance, asset intelligence, forward view (in scope)

Source: [IDEAS2.md](IDEAS2.md) Round 3. The owner asked to expand investments the
way spend was expanded: "Historical as well as future. Can we bring in any info on
the invested assets? How can we slice the data?"

- **In scope (newly added):**
  - **Per-holding history** — a daily value per position (`holding_snapshots`) so
    investment value can be sliced over time by asset class / account / security.
  - **Asset intelligence** — sector / industry / asset-type / region / forward
    dividend metadata pulled from the same public market-data source already used
    for prices, to slice allocation and project forward income.
  - **Performance display** — value & gain/loss over time, contributions-vs-market-
    growth, time-weighted (TWR) and money-weighted (XIRR) return, and an `^GSPC`
    benchmark comparison. **All read-only display metrics.**
  - **Forward view** — projected forward dividend income + yield-on-cost, an
    income-growth trend, and a **clearly-labeled illustrative value projection**
    with a single-target goal/retirement marker.
- **Reaffirmed OUT of scope (not relaxed):** tax-lot selection (FIFO/LIFO/specific-
  ID), wash-sale tracking, realized-vs-unrealized capital-gains *reporting*, 1099
  generation, and any financial *advice* feature. TWR/XIRR/projection are display
  numbers; the value projection is a labeled estimate, never a recommendation.
  Crossing this line needs a new FEATURE.md decision first.
- **Privacy stance:** the asset-intelligence fetch sends **only ticker symbols**
  outbound to the public market-data endpoint — the exact data category and trust
  boundary the existing price fetch already crosses. No quantities, balances,
  account names, or holdings leave the host; all analytics are first-party SQL.

Implemented under **ADR-019 → ADR-022** (IDEAS.md §11 Decision Log) via [PLAN9.md](PLAN9.md).

### 2026-06-20 — Personal high-value assets + proof documents (in scope)

Source: [IDEAS2.md](IDEAS2.md) Round 4. The owner asked to "create an asset that
has value that they can change over time and track over time" — vehicles, boats,
jewelry, art/collectibles — that "count towards net worth," with the option to
"upload a file associated with the asset for proof of authenticity."

- **In scope (newly added):**
  - **Personal high-value assets** — a new `personal_asset` account type
    (categories: vehicle / watercraft / jewelry / collectible / other) whose value
    the user **manually records and adjusts over time**, tracked via the existing
    `account_snapshots` machinery and **counting toward net worth**.
  - **Acquisition metadata + simple gain/loss** — optional acquired date and
    acquisition cost, with current-value-vs-cost shown as a **display** gain/loss
    (same shape as the holdings gain/loss already shipped).
  - **Proof-of-authenticity documents** — optional file attachments per asset
    (images or PDF, capped at 10 MB), stored as Postgres `bytea` and served only
    through an authenticated, attachment-only download route.
- **Reaffirmed OUT of scope (not relaxed):** automated/AVM asset valuation (no
  KBB/Edmunds/auction/appraisal API), depreciation schedules, insurance/warranty
  management, document OCR/parsing or e-signing, and asset↔financing-loan linking.
  Value is manually entered; the acquisition gain/loss is a labeled display figure,
  not a tax or cap-gains figure. Crossing this line needs a new FEATURE.md decision
  first.
- **Privacy stance:** personal assets and their proof documents are **100% local**
  — manual value entry, **no outbound fetch of any kind**, file bytes stored in our
  own Postgres and captured by the existing nightly `age`-encrypted `pg_dump`.
  Nothing about an asset ever leaves the host; documents are never served to a CDN.

Implemented under **ADR-023 → ADR-024** (IDEAS.md §11 Decision Log) via [PLAN10.md](PLAN10.md).

### 2026-06-21 — Watchlist, paper positions, and price-target alerts (in scope)

Source: [IDEAS2.md](IDEAS2.md) Round 5. The owner asked to "add a stock to track the
history of and 'pretend' they purchased it at a certain date/time and track its
progress and even get alerted when the stock/metal/whatever reaches a specific
value, up or down. This should not count towards net worth of course."

- **In scope (newly added):**
  - **Watchlist** — follow a symbol (stock / ETF / metal / crypto) the user does
    **not** own, in a standalone `watchlist_items` table that is **structurally
    excluded from net worth** (it is neither an account nor a holding).
  - **Pretend / paper position** — an optional `(purchase date, quantity, unit
    cost)` so the item shows a **simple display gain/loss** and a price-history
    chart from the purchase date forward — the same shape as the holdings
    gain/loss already shipped.
  - **Price-target alerts** — "tell me when SYMBOL crosses $X, up or down" as
    one-shot targets, evaluated **once daily** after the nightly price fetch and
    surfaced through the existing `/alerts` page + content-free email.
- **Reaffirmed OUT of scope (not relaxed):** order placement or any brokerage/trade
  API; real-time/streaming or intraday quotes (alerts are daily-batch; intraday is
  a deferred, env-gated future option); options/derivatives; technical-analysis
  indicators; backtesting/strategy simulation; multi-symbol "paper portfolios" with
  their own performance attribution; tax-lot or realized-gain accounting on the
  pretend position; and any third-party alert channel beyond the existing
  self-hosted SMTP doorbell (no SMS/push/webhook-out). Crossing this line needs a
  new FEATURE.md decision first.
- **Privacy stance:** introduces **no new egress class** — a watchlist symbol is
  fetched from the **same** public Yahoo / CoinGecko endpoints already used for held
  symbols, and **only the ticker string** leaves the host. The pretend qty/cost and
  the target thresholds are **100% local**, ride the nightly `age`-encrypted
  `pg_dump`, and never appear in the (content-free) notification email.

Implemented under **ADR-025 → ADR-026** (IDEAS.md §11 Decision Log) via [PLAN11.md](PLAN11.md). See [docs/WATCHLIST.md](../../docs/WATCHLIST.md).

### 2026-06-23 — Search everywhere: ⌘K command palette + per-list filters (in scope)

Source: [IDEAS2.md](IDEAS2.md) Round 6. The owner asked: "Searching. The user should
be able to search for things on every page. Whether it be the accounts page. The items
page per account. You get the idea. Transactions/items add up quickly over time and the
user needs to find specific ones easily."

- **In scope (newly added):**
  - **Global command palette** — a ⌘K / Ctrl-K (and nav-button) overlay available on
    **every** authenticated page that fuzzy-matches across accounts, categories,
    securities, watchlist items, and the top transaction matches **across all
    accounts**, and **navigates** straight to the result. Read-only: it jumps, it
    never edits.
  - **Per-list filters** — the growing list pages (accounts, per-account
    transactions, a **new cross-account `/transactions` view**, investments,
    watchlist, categories) gain an in-place filter whose state lives in the **URL
    `searchParams`** (shareable, refresh-stable, back-button-correct), exactly like
    the existing `?page=` / `?closed=` params.
  - **Structured transaction filters** — free-text payee/memo, **amount range**
    (min/max), **date range** (from/to), **category** (including "Uncategorized"),
    and an **all-accounts** mode, all composed server-side as a SQL `WHERE` + paged
    count (never ship 10k rows to the browser).
  - **Fuzzy matching** — Postgres `pg_trgm` trigram indexes give typo-tolerant
    substring search (`amazn` → `Amazon`) that stays fast as transactions climb into
    five/six figures.
- **Reaffirmed OUT of scope (not relaxed):** any public/external search API (the one
  route handler is session-guarded + same-origin — single user, zero public surface);
  a third-party/SaaS search engine (Algolia, Elastic Cloud, Typesense Cloud,
  Meilisearch SaaS, OpenSearch — ships payees + balances off-box); LLM/embedding
  "semantic" search (sends financial text to a hosted model); persisted saved
  searches / search history / "recent searches" (the URL is the saved search); write
  actions from the palette ("quick-categorize from search"); and full-document /
  attachment-body / OCR search of uploaded asset proofs (we index filenames +
  descriptions only, never file bytes). Crossing any of these needs a new FEATURE.md
  decision first.
- **Privacy stance:** introduces **no egress whatsoever** — search touches **only
  local Postgres**. No payee, ticker, balance, or query string ever leaves the box;
  there is no outbound HTTP on any search code path. The search route handler is
  internal/authenticated/same-origin and **never logs the query string** (a payee
  fragment is financial data — CLAUDE.md §Privacy).

Implemented under **ADR-027 → ADR-028** (IDEAS.md §11 Decision Log) via [PLAN12.md](PLAN12.md). See [docs/SEARCH.md](../../docs/SEARCH.md).

### 2026-06-28 — Enhance the dashboard: a curated at-a-glance command center (in scope)

Source: [IDEAS2.md](IDEAS2.md) Round 7. The owner asked: "Enhance Dashboard. The dashboard
has not been touched since we added several features to my-money. What can and should we add
to the dashboard to make it more informative given all of the features we have added?"

- **In scope (newly added):**
  - **A curated, fixed-section dashboard** — the Phase-1 net-worth page (number + history
    line + accounts table) becomes a hand-designed responsive layout: a full-width
    **net-worth hero** (value + range delta + history) over a responsive **card grid**.
    No drag-and-drop, no per-widget show/hide, no persisted custom layout (single user —
    re-curate by editing the template, not a config system).
  - **The four highest-value cards** on top of the hero: **asset allocation**,
    **investment performance** (TWR + benchmark), **spending vs budget (this month)**, and
    **dividend / forward income**. Plus secondary cards whose data is already computed and
    cheap to surface — **open alerts** and **watchlist movers** — and a **reserved slot for
    a savings-rate card** added later by Round 8 ([PLAN14.md](PLAN14.md)).
  - **One shared time-range control** (`?range=`, default 1Y) drives the time-series cards
    (hero history + performance); point-in-time cards (allocation, this-month budget,
    forward income) intentionally ignore it.
- **Reaffirmed OUT of scope (not relaxed):** any new metric the underlying libraries don't
  already compute (the dashboard *displays* what Phases 2–12 built — every figure comes from
  an existing tested function, never new math in a component); a configurable/customizable
  widget system, saved layouts, or a "dashboard settings" table; any write action from the
  dashboard (every card is read-only and links out to the page that owns the mutation); a
  third-party dashboard/BI/embed (no Grafana, Metabase, Looker, charting SaaS — the app *is*
  the dashboard); and new chart libraries (Recharts only, reusing the existing islands).
  Crossing any of these needs a new FEATURE.md decision first.
- **Privacy stance:** introduces **no egress whatsoever** — like search, the dashboard
  touches **only local Postgres** through functions already on the read path. No balance,
  ticker, payee, or amount leaves the box; there is no outbound HTTP on any dashboard code
  path, nothing financial is logged, and the page is `requireUser()`-guarded exactly as today.

Implemented under **ADR-029** (IDEAS.md §11 Decision Log) via [PLAN13.md](PLAN13.md). See [docs/DASHBOARD.md](../../docs/DASHBOARD.md).

### 2026-08-09 — Intentional income + 401k contributions as cost basis (in scope)

Source: [IDEAS2.md](IDEAS2.md) Round 8. The owner asked: "401k investments from a
retirement plan do not show cost basis or gain/loss which is understood. However, from a
user's perspective, the 'cost basis' would be the amount of income they invest in their
401k every paycheck. Can the user not have the ability to define their 'income' in an
intentional way and have the 401k amount or percentage defined so it is included in
investment calculations?"

The owner is right, and the framing is the feature: for a payroll-funded retirement
account, **cost basis is just the sum of what you contributed**. Employer-plan data
(Plaid or otherwise) rarely carries basis, so the 401k renders "—" for gain/loss forever
unless the user can state what they put in. Defining income is therefore lifted into
scope on exactly the ADR-018 grounds that lifted budgets: **the owner explicitly asked
for it**, and this file is where that decision is recorded.

- **In scope (newly added):**
  - **Intentional income sources** — the user defines one or more paychecks (name,
    cadence ∈ weekly/biweekly/semimonthly/monthly, **gross per period**, anchor pay date,
    start/optional end). Multiple sources are first-class (a job change mid-year, or two
    jobs), not a singleton setting.
  - **A 401k contribution rule per source** — employee contribution as a **percent of
    gross or a fixed dollar amount**, plus a **single-tier employer match**
    (none / % of gross / % of contribution / flat amount) with an optional
    **cap as a % of gross**, targeting a specific `investment` account and optionally a
    specific holding. A `pretax` flag is stored as a **label only**.
  - **Contributions materialized into the real investment ledger** — a daily job turns
    each due pay date into an actual `investment_transactions` row + a `holding_lots`
    cost-basis lot, so the 401k's **cost basis, gain/loss, TWR, XIRR, allocation, and
    snapshots populate through the machinery Phases 5/9 already built** — no parallel
    "retirement" valuation path. Holdings with a public price get real shares
    (dollars ÷ that day's close); opaque institutional funds accrue **basis only** with
    quantity left to manual entry, honestly labeled as such.
  - **A run-once backfill** materializes every historical pay date from each source's
    start, so historical basis and the contribution timeline are right from day one.
  - **A savings-rate card on the dashboard** — annual employee contributions ÷ annualized
    gross, **derived on read, never stored** — dropping into the slot Round 7 reserved.
  - **A contribution ledger** on the 401k account (date, employee, employer, total) so the
    basis is auditable from the account it funds.
- **Reaffirmed OUT of scope (not relaxed):** this models income **only as far as it
  defines a retirement contribution and a savings rate** — it is not payroll and not
  budgeting-income. Specifically still out: net-pay / take-home modeling, tax
  withholding, FICA, deduction stacks, or a paycheck stub (we store *gross per period* +
  *contribution*, nothing about taxes); pre-tax vs Roth **tax treatment** beyond the
  label; a general income ledger feeding budgets or cash-flow envelopes (Round 2 budgeting
  stays expense-side); any tax-lot **selection**, wash-sale tracking, realized/unrealized
  **tax** reporting, or 1099 generation (gain/loss remains a display figure — reaffirms
  the PLAN5/PLAN9 boundary); multi-tier employer-match formula engines ("100% to 4%, then
  50% to 6%"); IRS contribution-limit enforcement; and **pulling real payroll data from an
  external provider** (no ADP, Gusto, or Plaid-payroll — the user *defines* it
  intentionally, which is the entire point). Crossing any of these needs a new FEATURE.md
  decision first.
- **Privacy stance:** income, gross pay, and contribution amounts are the **most sensitive
  new data class in the app**, and they stay **100% in local Postgres**. This phase
  introduces **no new egress class** — the only outbound HTTP on any contribution code
  path is the *existing* daily price fetch for the designated holding's ticker (the same
  data category Phases 2/5/11 already send: **only the symbol leaves the box, never a
  dollar amount**). No income or contribution figure is ever logged, and none of it
  appears in the content-free notification email. It rides the nightly `age`-encrypted
  `pg_dump` like everything else. A regression test enforces both properties.

Implemented under **ADR-030 → ADR-031** (IDEAS.md §11 Decision Log) via [PLAN14.md](PLAN14.md). See [docs/INCOME.md](../../docs/INCOME.md).

### 2026-08-15 — Household money guidance: the app recommends, deterministically and locally (in scope)

Source: [IDEAS2.md](IDEAS2.md) Round 9. The owner asked: "Given all of the sources of data
available to the app, including now income and investment contributions, can it now
'recommend' some things? Recommend budgets. Recommend how much to save, long term vs short
term. How much to keep on hand and how much to keep in medium-term savings like CD's. Help
the user manage their money, not investments. Help them based off of standard and well
known best practices for managing family, household money. Perhaps the app needs to know
extra info, like how many household members and age… Remember this apps data is all local."

This is the **first round that asks the app to be prescriptive.** Everything through
Round 8 was descriptive — "here is what happened, here is what it projects to." Guidance is
lifted into scope on the same grounds ADR-018 lifted budgets and ADR-030 lifted income:
**the owner explicitly asked**, and this file is where that is recorded. Two properties make
it safe to say yes: it is a **deterministic rules engine, never a model** (CLAUDE.md
§Privacy forbids sending financial data to a hosted LLM — so recommendations are pure
functions that cite their heuristic and show their inputs), and it recommends **structures
and amounts, never products.**

Owner decisions from the clarifying round (2026-08-15):

1. **The full waterfall, including debt payoff** — not a savings-only subset.
2. **Prerequisite schema is in scope this phase** — without account subtypes the "how much
   on hand vs. CDs" question is literally unanswerable.
3. **Take-home is derived from observed income transactions**, not declared.
4. **A household member list with ages** (birth *year*), not just counts.

- **In scope (newly added):**
  - **A local recommendation engine** (`src/lib/advice/`) — pure, I/O-free rules over a
    single assembled snapshot, each returning recommendations that name the heuristic they
    implement and list the inputs used, so the user can audit and correct them.
  - **A savings waterfall** — starter buffer → **employer match** → high-interest debt →
    full 3–6 month reserve → IRA/HSA → 401k to the statutory cap → taxable/medium-term,
    each rung reporting done / in-progress / blocked / unknown-input.
  - **Emergency-fund sizing** against **essential** monthly expenses (not total spend),
    with the 3-vs-6-month multiplier informed by dependents and income concentration.
  - **Cash tiering** — operating cash vs. reserve vs. medium-term, and a **CD/T-bill ladder
    structure** suggested for genuinely excess cash. Structure and amounts only.
  - **Debt payoff ordering** — avalanche vs. snowball, months-to-debt-free, total interest,
    and credit utilization, from **manually entered** APR / limit / minimum payment.
  - **Recommended budgets** — per-category targets from the trailing **median/p75** (not the
    mean), applied through the existing `setBudget` under a preview → confirm flow.
  - **A 50/30/20 needs/wants/savings diagnostic** against observed take-home, with a
    user-tunable split (50/30/20 breaks in high-cost-of-living areas).
  - **A household profile** — members with birth year and dependent flag, reserve-month
    override, retirement target age, benchmark savings APY.
  - **Delivery on three surfaces** — a `/plan` page (the full waterfall + rationale), one
    dashboard card (the single most pressing item), and alerts **only on material change**.
- **Reaffirmed OUT of scope (not relaxed):** any AI/LLM advisor over financial data
  (§Privacy hard-no — guidance is deterministic or it does not ship); recommending a
  **specific security, fund, institution, or product** (that is advice; we recommend
  structures and amounts); tax computation of any kind — `accounts.tax_treatment` describes
  the *container* for ordering and drives no math, reaffirming ADR-030's "`pretax` is a label
  only"; Roth-vs-traditional conversion analysis, tax-loss harvesting, or withdrawal
  sequencing; Monte Carlo or probabilistic retirement planning (ADR-022 — still rejected);
  **user-authored goals with per-goal projections and funding rules** — waterfall rungs are
  *derived state* the user cannot create, name, reorder, or fund, so **ADR-022 stands
  unamended**; insurance adequacy, estate/will planning, and education/529 accounts;
  enabling **Plaid Liabilities** (free on Plaid's Trial plan today, but a per-Item
  subscription-fee product on any paid plan, and it would still not cover the manual
  accounts the engine must serve — manual entry first, sync deferred); and fetching live
  CD/HYSA market rates (a user-entered benchmark APY answers the same question with zero
  egress). Crossing any of these needs a new FEATURE.md decision first.
- **Privacy stance:** guidance introduces **no new egress class whatsoever** — the advice
  engine makes **zero outbound HTTP** on every code path, and every benchmark constant is
  checked into the repo rather than fetched. Household member names and birth years are new
  PII: they stay in local Postgres, ride the nightly `age`-encrypted `pg_dump` (ADR-014),
  are **deliberately excluded from the ⌘K search index** (ADR-027/028), and never appear in
  the content-free notification email. No income, balance, or recommendation figure is ever
  logged. A regression test enforces all of it.

Implemented under **ADR-032 → ADR-034** (IDEAS.md §11 Decision Log) via [PLAN15.md](PLAN15.md). See [docs/GUIDANCE.md](../../docs/GUIDANCE.md).

### 2026-08-23 — Cash-flow timing: what is due when, and one safe-to-spend number (in scope)

Source: [IDEAS3.md](IDEAS3.md) Round 10. The owner's question is the one a household with a
mortgage and kids asks most often: *"Can I spend $400 on the car repair this week, or does
something bounce?"*

The app cannot answer it — and the reason is structural rather than a missing feature. Every
number it produces today is a **stock** (balance, net worth, allocation, cost basis) or a
**rate** (savings rate, monthly spend, APR, TWR). Almost nothing is a **date**. But a
household's money runs on a calendar: the mortgage on the 1st, daycare on the 3rd, paychecks
on the 15th and 30th, insurance twice a year, property tax in November. Phase 16 adds the
missing dimension — what lands, when, and what that leaves.

Timing is lifted into scope on exactly the grounds ADR-018 lifted budgets, ADR-030 lifted
income, and ADR-032 lifted guidance: **the owner explicitly asked**, and this file is where
that is recorded. Two properties make it safe to say yes. It is **deterministic arithmetic
over data the app already holds** — a periodicity test with a stated tolerance and a day-by-day
Decimal walk, never a model. And it **reports timing without ever acting on it**: the app
proposes what it thinks is recurring, the user confirms or rejects it, and no money is ever
moved, reserved, or partitioned.

The deliverable is one sentence a family acts on — *"Your lowest projected checking balance is
$312 on March 14"* — and one number on the dashboard: **safe-to-spend**.

- **In scope (newly added):**
  - **Recurring-series detection** (`src/lib/cashflow/`) — pure periodicity and
    amount-stability analysis over transaction history per normalized payee, producing
    **candidates, never rows**. It returns `null` rather than guessing when nothing fits.
  - **Scheduled obligations** — the confirmed record of what is due and when. Detection
    proposes; the user disposes, through the **parse → preview → confirm** posture CLAUDE.md
    §Importers already mandates. **Manual entry is first-class**, not a fallback: the bills
    that hurt most (a premium from an untracked account, tuition on a payment plan, a
    quarterly estimated payment) never touch a tracked account at all.
  - **A daily cash-flow projection** — starting balance, plus take-home phased by the pay
    schedule, minus dated obligations, minus a **residual** discretionary run-rate, day by
    day over a user-settable horizon (default 60 days, range 14–365).
  - **Safe-to-spend** — the horizon's lowest projected closing balance less a user-set cash
    floor, clamped at zero. One number, on the dashboard and on a new `/plan/cashflow` page.
  - **Timing alerts** — a projected shortfall ahead; an obligation whose due date passed
    unmatched; an obligation whose amount moved materially.
  - **Two `household_profile` settings** — `cash_floor` and `projection_horizon_days`. No new
    settings table.
- **The correctness rule that defines this phase:** recurring obligations are **already
  inside** observed spend. Projecting an average daily spend **and** adding the mortgage on
  the 1st counts the mortgage twice, and makes safe-to-spend quietly, badly low — the failure
  direction that trains a household to ignore the number. The discretionary rate is therefore
  a **residual**: total observed spend minus the spend attributable to confirmed obligations
  in the same window. It is test-first, and it has a dedicated invariant test that exists to
  keep it from ever regressing.
- **Reaffirmed OUT of scope (not relaxed):** **bill pay, money movement, or ACH initiation of
  any kind** — a due date is an observation, never an instruction, and this stays a read-only
  tracker; **envelope budgeting** — nothing is partitioned, reserved, allocated, or moved
  between virtual buckets, and Round 2's simple monthly targets stay simple (ADR-018
  unamended); **double-entry accounting** — obligations are not liabilities and do not post;
  **any AI or LLM over financial data** (§Privacy hard-no — detection is a deterministic
  periodicity test, and when it cannot decide it says so); **probabilistic cash-flow
  modeling** — no Monte Carlo, no confidence bands, no fan chart (ADR-022 stands; the
  projection is a single deterministic line, and uncertainty is expressed as stated inputs the
  user can correct); **user-authored goals** (ADR-022, ADR-032 §6 — an obligation is a
  recorded fact about a recurring cost, not a target the user funds); and **live rate, fee, or
  biller data of any kind**. Crossing any of these needs a new FEATURE.md decision first.
- **Privacy stance:** timing introduces **no new egress class — and, like guidance, literally
  zero**. Nothing under `src/lib/cashflow/` makes an outbound HTTP request on any code path.
  There is **no biller directory, no merchant-enrichment service, no "we recognized this as
  Netflix" lookup** — payee normalization is local string work over the user's own transaction
  names. Obligation labels are new user-authored PII-adjacent text (they name real vendors,
  landlords, and sometimes people): local Postgres only, riding the nightly `age`-encrypted
  `pg_dump` (ADR-014). Labels **may** enter the ⌘K index, being payee text of the kind already
  indexed via `transactions.name` (ADR-027/028) — but the projection figures, the safe-to-spend
  number, and the low-water balance **never** appear in the content-free notification email
  (ADR-015: numbers live in `detail`, and the email carries neither). No balance, projection,
  or obligation amount is ever logged. A regression test enforces all of it.
- **Reconciling with the Phase 15 deferral:** [PLAN15.md](PLAN15.md) §Open Items deferred
  recurring detection because "`categories.necessity` is explicit and correctable; a
  merchant-cadence detector is guessing where an answer exists." **That reasoning stands and is
  reaffirmed, not reversed.** `necessity` answers *"is this essential?"* — a **classification**
  question. Round 10 asks *"when does it land, and for how much?"* — a **timing** question on
  an orthogonal axis that `necessity` cannot answer at any level of classification quality.
  Detection here **schedules; it does not classify**: a confirmed obligation inherits its
  category from the transactions that produced it and changes no category's `necessity`.

Implemented under **ADR-036 → ADR-038** (IDEAS.md §11 Decision Log) via [PLAN16.md](PLAN16.md). See [docs/CASHFLOW.md](../../docs/CASHFLOW.md).

### 2026-08-29 — Why did our net worth change? Attributing the delta (in scope)

Source: [IDEAS3.md](IDEAS3.md) Round 11. The owner's question is about the one number the app
puts at the top of the dashboard: *"We're up $40k this year. Did we earn that, or did the
market?"*

The net-worth chart goes up and the household cannot tell whether it reflects their discipline
or the S&P. Those two facts imply completely different next actions — one says *keep doing what
you're doing*, the other says *you got lucky and your savings rate is still wrong* — and the app
reports neither. Phase 17 answers it with one waterfall and one sentence: *"Your net worth rose
$40,200. You saved $23,100 of it, the market added $14,800, you paid down $2,300 of principal,
and $0 is unexplained."*

Attribution is lifted into scope on exactly the grounds ADR-018 lifted budgets, ADR-030 lifted
income, ADR-032 lifted guidance, and ADR-036 lifted timing: **the owner explicitly asked**, and
this file is where that is recorded. Three properties make it safe to say yes. It is
**deterministic accounting over data the app already captures nightly** — `account_snapshots`,
`transactions`, `investment_transactions`, `liabilities` — with a stated one-sentence formula per
rung. It **explains a change that already happened** and never predicts one. And it **adds no
schema, no job, no dependency, and no egress**: the phase is pure composition over shipped code,
and [investments/performance.ts](../../src/lib/investments/performance.ts)'s `attribution()` —
contribution vs. market growth, already tested — is lifted from the brokerage to the household
rather than reimplemented.

- **In scope (newly added):**
  - **External-flow classification** (`src/lib/net-worth/boundary.ts`) — a pure classifier for
    which transactions move money *into or out of the household* versus merely between its own
    accounts. `categories.kind` states **intent**; it does not establish that money crossed the
    boundary, so this is settled **structurally**: a transfer is internal iff its counterparty
    leg is found in another tracked account (`pairTransfers`, modelled on the occurrence matcher
    Phase 16 already ships). An unpaired transfer is **never guessed** — it is reported by
    volume as a named cause.
  - **A period decomposition** (`src/lib/net-worth/decompose.ts`) — for any window, the
    net-worth delta split into **saved**, **retirement contributions**, **debt principal paid**,
    **investment return**, **asset revaluation**, and **unexplained**. Pure, `Money`-only, and
    anchored to `computeNetWorth` at both endpoints so the waterfall cannot silently disagree
    with the dashboard directly above it.
  - **The "why" surface** — a waterfall from opening to closing net worth at
    `/analysis/networth`, for any range the existing range toggle offers, with a plain-language
    summary sentence, a rung table carrying each rung's `InputUsed[]` audit trail, and one
    sentence plus a link on `/analysis` where Round 11 expected to find it.
  - **Residual diagnostics** — `unexplained` names its own causes (uncategorized volume,
    transfers to accounts the app does not track, manual-balance accounts, snapshot gaps, loans
    with no `liabilities` row, the documented historical-quantity wart), each with a magnitude
    and a link to where to fix it.
- **The correctness rule that defines this phase:** a $2,000 mortgage payment appears in
  `transactions` as a single $2,000 expense, because the app has no principal/interest split.
  So `saved` falls by the full $2,000 and `debtPrincipalPaid` **adds back** the $500 of
  principal from the amortization schedule — **counted twice, with opposite signs, on purpose**
  — netting to the −$1,500 of interest, which is precisely the amount by which paying a mortgage
  reduces net worth. Mis-implementing this in either direction moves $500 between two rungs
  **while the total still reconciles**, so the invariant test asserts the rungs *individually*,
  not merely their sum. Payroll-direct 401k contributions are their own rung for the mirror-image
  reason: they never touch checking, so `saved` cannot see them, while `attribution()` correctly
  removes them — scoping the rung to `investment_transactions.source='income'` makes the two
  cancel by construction rather than by coincidence.
- **`unexplained` is a feature, not a defect.** It is computed last, rendered with the same
  weight as every other rung, and is **never hidden, clamped, folded into "other", or absorbed
  into a neighbour**. A household with uncategorized transactions or untracked counterparties
  will see a large residual on day one; that is the app telling the truth about its own inputs,
  and it is the most valuable thing this phase produces. It is emitted in a shape
  [IDEAS3.md](IDEAS3.md) Round 16's input-health work can consume directly.
- **Reaffirmed OUT of scope (not relaxed):** **double-entry accounting or a general ledger** —
  a decomposition is a *report over balances*, and the moment a rung needs a posting rule to be
  correct the design is wrong, not the ledger missing; **tax math of any kind** — no
  realized/unrealized split for tax, no cost-basis-for-1099, no wash sales (ADR-019 and ADR-021
  unamended); **capital-gains reporting** beyond the simple display gain/loss already shipped;
  **benchmark-relative attribution, factor models, or Brinson-style sector attribution** — that
  is portfolio analytics for a professional, needing data the app does not hold, not a household
  question; **budgeting or envelopes** (ADR-018 unamended — a rung describes the past and is
  never a target); **probabilistic or forward-looking attribution** (ADR-022 stands: this looks
  strictly backwards); **any AI or LLM over financial data** (§Privacy hard-no — every rung is
  arithmetic with a stated formula). Crossing any of these needs a new FEATURE.md decision first.
- **Privacy stance:** attribution introduces **no new egress class — and, like guidance and cash
  flow, literally zero**. Nothing under `src/lib/net-worth/` makes or transitively imports an
  outbound HTTP request on any code path. There is **no benchmark-index fetch** (the `^GSPC`
  closes such a feature might want are already cached in `prices` by the nightly job, and this
  phase adds no symbol and no fetch), **no peer comparison, no "households like yours" lookup,
  and no enrichment of any kind**. The phase **creates no new PII**: it stores nothing at all,
  and every figure is a function of rows that already exist. No balance, rung amount, delta, or
  residual is ever logged, and no diagnostic carries a payee string or a household member label.
  A regression test enforces all of it.
- **Two things deliberately not shipped, recorded so the absence is not read as an oversight:**
  **no alert type** — a residual-health alert is really an *input-health* alert, which is Round
  16's job done once across all inputs, so ADR-015's content-free email is not touched; and
  **nothing on the dashboard** — the dashboard already gained a cash-flow card in Phase 16, and
  a backward-looking attribution is a page you visit when you ask the question, not a number you
  need at a glance.

Implemented under **ADR-039 → ADR-041** (IDEAS.md §11 Decision Log) via [PLAN17.md](PLAN17.md). See [docs/ATTRIBUTION.md](../../docs/ATTRIBUTION.md).

### 2026-08-30 — Two cash-flow gaps: the bill the app already knows, and the savings that already close the shortfall (in scope)

Source: the owner, reading `/plan/cashflow` against their own book. Two complaints, one sentence
each: *"It's missing my mortgage — which should be auto calculated/figured out"*, and *"instead of
listing the shortfall, if the user has a savings account that can transfer in funds, shouldn't it
show that advice?"* Both are Phase 16 defects rather than new features, and both are **corrections
to what a screen says**, not additions to what the app computes.

- **The diagnosis that sizes the whole change: the totals are right, the DATES are wrong.** An
  unconfirmed mortgage is not missing from the projection. It is a transaction like any other, so
  it sits inside trailing observed spend, so it sits inside the residual daily rate and is spread
  flat across every day of the horizon as *"Everyday spending"*. The household's money is fully
  accounted for; what is wrong is that a payment which actually leaves on the 1st is charged at a
  flat daily rate for two months. That is exactly what the page's own coverage caveat reports, and
  it is why the projected line slopes instead of stepping. **The consequence is that the low-water
  date is wrong** — and the low-water date is the entire product of that page. So the fix
  **re-dates** money the line already contains; it never adds any.
- **In scope, gap 1 (ADR-047):** a `liabilities` row on an active `loan` account now produces an
  obligation **candidate** on `/plan/cashflow/review`, pre-filled from stated loan terms and ranked
  above detected suggestions under its own heading. ADR-036 §2 — *confirm, never infer* — is
  **unchanged**: nothing is written to `scheduled_obligations` without a click, on install or on
  upgrade. The proposed amount prefers the household's **observed** payments over computed
  principal-and-interest, because escrow makes a real payment materially larger than P&I and the
  matcher's ±15% band would then report a correctly-paid mortgage as missed.
- **In scope, gap 2 (ADR-048):** a projected shortfall is **classified against reserve cash** before
  it is reported — covered, partly covered, uncovered, or reserve-unknown. A shortfall the emergency
  fund covers is a *timing* problem; one it does not cover is a *solvency* problem, and those are
  different sentences with different next actions. A covered shortfall's alert drops to `info`; it
  is **never** silenced, because a monthly raid on the emergency fund is itself worth surfacing.
- **What deliberately does NOT change:** the projection walks **operating cash only** (ADR-038 §6),
  exactly as before. Savings never enters the balance line, the low-water mark, or safe-to-spend —
  a line that quietly absorbed reserve cash could no longer tell a household it is overspending.
  Gap 2 adds a second *sentence* about the same number, never a second number, and the projected
  series is byte-identical before and after it.
- **Reaffirmed OUT of scope (not relaxed):** **no transfer is initiated, offered, simulated, or
  scheduled** — money movement stays permanently out of scope, and this remains a read-only tracker;
  **no envelope or virtual-bucket partition** of a real balance; **no emergency-fund target stated
  on the cash-flow page** (that is `/plan`'s number, and two implementations of "how many months"
  is two numbers that can disagree on one screen); **no interest/principal split on the calendar**;
  **no escrow model** — escrow is absorbed by `trailing_median` and its annual step is reported by
  the existing amount-drift alert; and **no live rate, servicer, or biller lookup of any kind**.
- **Privacy stance:** unchanged and still literally zero egress. `monthlyPayment()` is arithmetic
  over terms the user typed in; the reserve total is a sum over accounts the app already holds.
  Both new modules are pure, both are covered by the existing cash-flow egress allowlist, and no
  servicer name, label, or figure reaches a log line.

Implemented under **ADR-047 → ADR-048** (IDEAS.md §11 Decision Log) via
[PLAN_CASHFLOW_GAPS.md](PLAN_CASHFLOW_GAPS.md).

### 2026-09-13 — Sinking funds: the annual and one-off costs a monthly budget cannot represent (in scope)

Source: [IDEAS3.md](IDEAS3.md) Round 12. The owner's question is about the bill everyone saw
coming: *"Car insurance is $1,340 in March. I know it, and it still hurts every year."*

The diagnosis is structural, not motivational. Budgets are monthly; families do not fail on
monthly, they fail on **annual, semiannual, and irregular** — insurance, property tax, tuition,
Christmas, the vet, the HVAC that was always going to die. A monthly budget cannot represent a
cost that arrives once a year, so when it arrives it reads as a **blown month** instead of a
**known cost**. Phase 18 answers it with one number and one sentence: *"You should be holding
$2,180 against the four known costs in the next 12 months. Your reserve above your
emergency-fund target is $600."*

Sinking funds are lifted into scope on exactly the grounds ADR-018 lifted budgets, ADR-030
lifted income, ADR-032 lifted guidance, ADR-036 lifted timing and ADR-039 lifted attribution:
**the owner explicitly asked**, and this file is where that is recorded. Three properties make it
safe to say yes. It **computes a requirement and stores no funding state** — a function of dated
costs and today's date, shown beside an unpartitioned real balance. It is **deterministic
arithmetic with a stated formula** (one division, ADR-044). And it closes its gap with **one
narrow table**, because the recurring half of the problem is already solved: `scheduled_obligations`
has carried `quarterly`, `semiannual` and `annual` cadences since Phase 16, so the round's own
$1,340 insurance bill is representable today — what is missing is the accrual arithmetic, not a
way to record it.

- **In scope (newly added):**
  - **Planned expenses** (`planned_expenses`) — a named, dated, amount-bearing **one-off** cost:
    a roof, a wedding, a deposit, this December's Christmas. Manual entry only. No cadence column
    — a cost that repeats is a scheduled obligation, which already expands, materializes, matches
    and alerts (ADR-043).
  - **Accrual math** (`src/lib/sinking/accrual.ts`) — straight-line over whole months from a
    stated funding start; `requiredToday` computed with **one** division so it equals the bill
    exactly on the due date (ADR-044).
  - **A known-future-cost stream** spanning planned expenses **and** non-monthly obligation
    occurrences, with a compile-checked cadence threshold (ADR-045).
  - **A `sinking_fund` advice rule** — the requirement against the reserve tier above the
    emergency-fund target, degrading to `unknown_input` honestly (ADR-046).
  - **`/plan/sinking`** — the headline sentence, the itemized cost table, and the planned-expense
    manager; one Planning nav item; one sentence plus a link on `/plan/cashflow`.
  - **Planned expenses on the calendar** — a fourth `CashFlowEvent` kind, so a $4,000 cost inside
    the projection horizon moves the low-water mark instead of being invisible to it.
- **The line between a sinking fund and an envelope, stated once.** An envelope system
  **partitions a real balance** and constrains spending against the partitions; its state lives
  in the database and diverges from the bank. A sinking fund as built here **computes a
  requirement** and **displays it beside an unpartitioned balance**. Nothing is reserved, nothing
  is moved, and if every planned expense is deleted the money is exactly where it was. The test
  for any future task: **does it make the app store a number that says where money "is" other
  than the account it is actually in?** If yes, the design is wrong. The schema enforces this by
  absence — no `funded_amount`, no `funded` status, no `funding_account_id`, no contributions
  table, and no `account_id` on a planned expense at all.
- **The correctness rule that defines this phase:** obligations of **monthly or shorter** cadence
  are **excluded** from the requirement. A monthly bill is paid out of the month's income — it is
  already inside the essential baseline that sizes the emergency-fund target, and already inside
  the trailing spend behind the cash-flow residual. Including it would demand a second copy of
  money the household already budgets monthly: roughly $16,000 of "required reserve" against
  $2,700 a month of ordinary bills, telling a solvent family it is catastrophically behind. The
  exclusion is an exhaustive compile-time mapping, so a new cadence without a verdict fails the
  build.
- **A deliberate refinement of Round 12's stated formula.** The round says *"required balance today
  = elapsed months × the monthly rate."* Taken literally that rounds twice — $1,340 over 7 months is
  $191.43 a month, and seven of those is $1,340.01. ADR-044 computes `amount × elapsed ÷ total`
  with one division instead. Recorded here so the deviation is found rather than discovered.
- **Reaffirmed OUT of scope (not relaxed):** **envelope budgeting or any virtual-bucket partition**
  of a real balance (ADR-018 unamended); **user-authored goals with funding rules, progress
  tracking or per-goal projections** (ADR-022 unamended — a planned expense is a dated bill you
  already know about, not a goal you chose); **front-loaded or paycheck-aligned funding schedules**
  (a funding rule is a goal); **money movement of any kind** — no transfer, allocation, or "move
  $180 into this bucket" action; **double-entry accounting or a general ledger**; **tax math**;
  **probabilistic projection**; **a transaction matcher for planned expenses** (`Mark paid` is one
  click); **a `cadence: 'irregular'`** (it would mean "we do not know", which is not a schedule);
  **any AI or LLM over financial data** (§Privacy hard-no). Crossing any of these needs a new
  FEATURE.md decision first.
- **Privacy stance:** zero egress, again literally. Nothing under `src/lib/sinking/` makes or
  transitively imports an outbound request — no insurance-price lookup, no "typical cost of a new
  roof" service, no benchmark, no enrichment. **This phase does create new PII**, which the last
  two did not: `planned_expenses.label` and `.notes` are free text a household writes about itself
  (*"Emma's braces"*, *"Mom's care-home deposit"*). They **never appear in a log line**, **never
  reach the content-free notification email** (ADR-015), **are not added to the search index**,
  and never leave local Postgres. `pg_dump` covers the table under ADR-014's encrypted-backup path
  with no change. A regression test enforces all of it.
- **Four things deliberately not shipped, recorded so the absence is not read as an oversight:**
  **no alert type** — Round 12 does not ask for one, a "cost due soon and you are short" signal is
  forward-looking input health (Round 16's job), and ADR-015 is not touched; **no new worker job** —
  if the existing `project-cashflow-daily` materializer's lead is widened for non-monthly cadences
  so annual occurrences exist 12 months out, that is a change to a shipped job, not a new one;
  **no dashboard tile** — the dashboard gained a cash-flow card in Phase 16, and a set-aside
  requirement is a page you visit when you plan, not a number you need at a glance; and **no search
  indexing of planned expenses** — the most sensitive free text in the app deserves its own privacy
  pass before it is concentrated in an index.

Implemented under **ADR-043 → ADR-046** (IDEAS.md §11 Decision Log) via [PLAN18.md](PLAN18.md).

### 2026-10-08 — Take-home per paycheck on income sources (in scope)

The owner reported the cash-flow calendar was wrong for their income set: every payday — a
biweekly salary and two monthly SSA benefits of $3,251 and $1,625 — showed the same $2,787.67.
The cause was ADR-038 §3's even split of one household take-home median across all pay events,
which is exact only when paychecks are alike. The owner approved storing a **take-home per
period** on each source, and asked that the form **recommend it from deposits** already found.

- **In scope:** an optional, user-stated `income_sources.net_per_period`; the projection lands it
  exactly on that source's paydays and shares only the remainder of observed take-home among
  unstated sources; the income form suggests candidates from deposits that line up with the
  source's own paydays, each named by payee, never auto-applied.
- **Still out of scope:** withholding, tax math, deduction stacks, paystubs. The 2026-08-09
  "no net pay" line is amended to "no net pay *computed*": the figure is what the household says
  reaches the bank, not something derived from gross.

Implemented under **ADR-049** (IDEAS.md §11 Decision Log).
