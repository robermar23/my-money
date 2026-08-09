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
