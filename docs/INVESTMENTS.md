# Investments

How my-money tracks investment value: positions, cost basis, gain/loss, asset
allocation, and dividend/interest income. Two ingestion tracks feed the same
`/investments` dashboard — **Plaid Investments** (automated, for brokerages
that support it) and **manual entry** (for everything Plaid can't reach).

> **Every figure here is a display number, not tax or investment advice.**
> Gain/loss is simply `current value − cost basis`; performance metrics (TWR,
> XIRR, contributions-vs-growth, benchmark) are read-only display figures; the
> value projection is an **illustrative estimate**, never a recommendation.
> my-money does **not** do tax-lot selection (FIFO/LIFO/specific-ID), wash-sale
> tracking, realized-vs-unrealized capital-gains reporting, or 1099 generation —
> those are explicitly out of scope (CLAUDE.md §Domain Scope). Lots exist to make
> the cost-basis number *more accurate*, nothing more. For taxes, use your
> brokerage's documents.
>
> **Privacy:** the asset-intelligence fetch (sector/industry/dividend metadata)
> sends **only ticker symbols** outbound to the same public market-data endpoint
> the nightly price fetch already uses. No quantities, balances, account names,
> or holdings ever leave the host; every chart and metric is first-party SQL over
> local Postgres. See [THREAT_MODEL_MARKETDATA.md](THREAT_MODEL_MARKETDATA.md).

---

## What counts as an "investment account"

The `/investments` page aggregates every holding on accounts of type
`investment` (brokerages, 401k) and `crypto_ira` (iTrust gold + crypto). Their
value is `quantity × latest price`, not a typed-in balance. Cash, credit-card,
loan, and property accounts are not shown here.

Reach the dashboard from the **"Investments →"** link on the home page or the
accounts page. The investments surface has three sub-tabs (top-right of each
page): **Overview** (this dashboard), **Performance** (returns over time), and
**Forecast** (forward income + value projection). Clicking a position's symbol
opens its **per-security detail** page.

---

## Track 1 — Plaid Investments (Fidelity brokerage)

Plaid's Investments product pulls **holdings** (current positions + security
metadata) and the **investment-transaction stream** (buys, sells, dividends,
interest, fees). Per ADR-011 this is a *separate* Plaid Item from the cash
accounts, consenting to the `investments` product only.

### Connecting

1. Run **both** the dev server and the worker (`pnpm dev` + `pnpm worker`) —
   the initial sync runs in the worker, same as the cash sync. See
   [PLAID.md](PLAID.md) §0.
2. Open `/settings/connections` and click **"Connect investment institution"**
   (the second CTA — it requests the `investments` product, whereas "Connect
   new institution" requests `transactions`).
3. Complete Plaid Link for the brokerage (Sandbox: First Platypus Bank).
4. On the mapping page, link each Plaid investment account to an existing
   manual account or **Create new** (it lands as `type='investment'`). Submit.
5. The progress page polls until the initial sync finishes; then the positions
   appear on `/investments`.

### What the sync does (and doesn't)

- **Holdings** are a full-snapshot upsert each run: a position you sold shows
  up missing on the next sync and is removed. Manually-entered holdings on the
  same account are **never** touched by the sync.
- **Securities** map to a canonical symbol: `ticker_symbol` → `cusip` →
  `SEC:<plaid_security_id>`. Tickered securities are priced by the nightly
  Yahoo fetch; securities with no public ticker (proprietary funds, some 401k
  options) are valued from Plaid's reported `institution_price`.
- **Cost basis** from Plaid is used when present, but Plaid's cost basis is
  frequently thin or absent (IDEAS.md §4.2). When you enter lots manually, the
  sync will **not** overwrite your basis (see precedence below).
- **Buys** automatically create cost-basis lots; **dividends/interest** feed
  the income breakdown.
- Webhooks (`HOLDINGS`, `INVESTMENTS_TRANSACTIONS`) keep it current; the 03:00
  safety-net cron re-syncs daily in case a webhook was dropped.

### Coverage caveats

- **Fidelity 401k / NetBenefits** coverage through Plaid is patchy — track
  those **manually** (Track 2) rather than fighting Link.
- Sandbox investments fixtures are limited; expect production institutions to
  surprise you. The manual path is always available as a fallback.

---

## Track 2 — Manual entry (iTrust gold + crypto, 401k)

For accounts Plaid can't reach, enter holdings by hand on the account page —
the same flow since Phase 1, now with cost-basis lots.

### Quarterly ritual (~15 min)

1. Open the account (e.g. the iTrust crypto/metals IRA).
2. In **Add or update holding**, enter each position:
   - iTrust gold: symbol `XAU`, asset class `physical_metal`, unit `troy_oz`.
   - Crypto: symbol `BTC`/`ETH`/…, asset class `crypto`, unit `coin`.
   - 401k funds: symbol (ticker if it has one), asset class `equity`,
     unit `shares`.
3. Re-submitting the same symbol updates the quantity in place.
4. The account page shows a **"Last updated … — review quarterly"** hint so you
   know when you last touched it.

Prices update automatically overnight: gold via Yahoo COMEX futures (`GC=F`),
crypto via CoinGecko, equities via Yahoo. You only enter *quantities*.

### Cost-basis lots

Under each holding on the account page is a **Cost-basis lots** editor. Add one
lot per acquisition (date optional, quantity, total dollars paid). The holdings
table then shows a lots-aware cost basis and gain/loss. If the lots don't add
up to the full position, a `*` flags "lots cover N of M shares".

---

## Cost-basis precedence (one rule)

A holding's cost basis is resolved in this order (`src/lib/investments/lots.ts`):

1. **Sum of `holding_lots`** — if any lots exist, their total is the basis.
2. Else the holding's **aggregate `cost_basis`** column (a Plaid-reported total
   or a single typed-in number).
3. Else **null** — gain/loss renders `—` (unknown, not zero).

Adding a lot stamps the holding's `cost_basis_overridden_at`, which is the
signal that tells a future Plaid sync to leave your basis alone. Delete every
lot and the basis falls back to the aggregate column.

---

## Reading the dashboard

- **Header** — total portfolio value, total cost basis, and aggregate gain/loss
  ($ and %). Gain/loss covers only positions with a *known* basis, so an
  unknown-basis holding (e.g. IRA gold with no recorded purchase price) doesn't
  distort the percentage.
- **Asset allocation** — a donut by asset class (equity / crypto / physical
  metal / cash); slices sum to exactly 100%.
- **Per-account tables** — symbol, name, quantity, price, value, cost basis,
  gain/loss, with a subtotal per account. Unpriced rows show `—`.
- **Dividend & interest income** — stacked bars by month / quarter / year
  (toggle in the URL). Sourced from Plaid investment transactions of subtype
  `dividend`/`interest`; manual accounts have none unless you import them.

---

## Per-position history (`holding_snapshots`)

To slice investment value *over time* — by asset class, account, or a single
security — my-money records a **daily value per position** in `holding_snapshots`
(PK `(holding_id, date)`), one level finer than the account-level
`account_snapshots`. Each row stores the day's quantity, value
(`quantity × close`), resolved cost basis, and currency.

- **Written by the existing nightly job.** `compute-snapshots-daily` already
  values every holding to compute the account snapshot, so it emits the
  per-holding rows in the same pass — no extra price fetches. The write is
  idempotent (`ON CONFLICT (holding_id, date) DO UPDATE`), so re-runs are safe.
- **Unpriced securities are skipped, not written at $0** — an honest gap beats a
  fake zero that would distort the value line.

> **Estimated pre-deploy history.** Plaid reports *current* holdings, not your
> past positions. The one-time backfill (`run-once backfill-holding-snapshots`)
> therefore approximates history as **today's quantity × each past day's close** —
> useful for a value trend, but not an exact reconstruction. From the day the
> nightly job starts running, the recorded quantity is the *actual* held quantity,
> so accuracy improves going forward. The performance and per-security pages carry
> this caveat inline.

---

## Asset intelligence (security enrichment)

Securities are enriched with metadata so allocation can be sliced by **sector /
industry / region / asset type** and forward dividend income can be projected.
The enrichment columns on `securities` are all nullable and additive: `sector`,
`industry`, `asset_type`, `region`, `expense_ratio`, `dividend_rate` (the
**forward annual $/share** — yield is derived at display as `rate ÷ price`, never
stored stale), `dividend_ex_date`, and a `fundamentals_refreshed_at` watermark.

- **Source.** A weekly BullMQ job, `refresh-fundamentals-weekly`, fetches each
  held ticker's profile/summary from the same public Yahoo endpoints used for
  prices and upserts the columns. Fundamentals change slowly, so weekly (not
  daily) is plenty; it refreshes only securities whose watermark is null or older
  than 7 days. Trigger it on demand with `run-once refresh-fundamentals-weekly`.
- **Privacy.** The fetch sends **only the ticker symbol** outbound — the same data
  category and trust boundary as the price fetch. No holdings, quantities, or
  balances are transmitted. Synthetic `SEC:` symbols and crypto/metals are
  skipped (no public fundamentals); their `asset_type` is set from the existing
  `asset_class`. See [THREAT_MODEL_MARKETDATA.md](THREAT_MODEL_MARKETDATA.md).
- **Coverage is patchy.** Proprietary/401k funds, foreign tickers, and anything
  `SEC:`-synthetic stay null and render as an **"Unclassified"** allocation
  bucket — never a crash, never a guess.

On the **Overview** page the allocation donut has a slice-dimension toggle (asset
class / sector / region / account), and a **top-holdings concentration** table
flags single-name risk (each row's percent is its share of the *whole*
portfolio, so the top N need not sum to 100%).

---

## Reading the Performance tab

`/investments/performance` answers "how did my investments actually do?" — all
read-only display metrics, computed with `decimal.js` (never float), from
`holding_snapshots` + the investment-transaction stream + one benchmark symbol.
Pick a date range and (optionally) a single account with the controls at top.

- **Gain / loss** — `value − cost basis` at the latest dated point with a known
  basis. The "what is it worth vs. what I paid" number.
- **Time-weighted return (TWR)** — chains daily sub-period returns and
  *neutralizes the timing and size of your contributions*. This is the
  "how did the **investments** perform" rate, comparable to a fund's published
  return — and the apples-to-apples basis for the benchmark.
- **Money-weighted return (XIRR)** — the *personal* rate of return, which **does**
  account for when and how much you contributed. If you bought heavily right
  before a run-up, XIRR rewards that timing; TWR does not. They differ when
  contributions are lumpy — that difference is the point.
- **vs S&P 500** — your TWR minus a buy-and-hold `^GSPC` TWR over the same range,
  both indexed to 100 at the range start. The benchmark price rides the existing
  nightly fetcher (just another symbol in `prices`).
- **Contributions vs. market growth** — splits the change in value into money you
  *added* (`netExternalFlows` = buys/deposits − sells/withdrawals) versus
  `marketGrowth = (end − start) − netFlows`. Answers "did it grow, or did I just
  add money?"

> If a range has fewer than two days of real snapshot data, the page shows
> **"insufficient history"** rather than a misleading return. Early ranges that
> rest on the approximate backfill carry the estimated-history caveat.

---

## Reading the Forecast tab

`/investments/forecast` is the **forward** view. A single unconditional banner
states up front: *"Projections are illustrative estimates, not financial advice."*

- **Forward 12-month income** — `Σ held_shares × forward dividend_rate`, with a
  per-holding and per-account breakdown and a **yield-on-cost** figure (forward
  income ÷ cost basis). Grounded in held quantity × the published forward rate —
  an estimate of distributions, not a market prediction. Holdings with no
  distribution contribute nothing.
- **Income growth** — *actual* dividend/interest received per year, with
  year-over-year growth and a trailing-12-month run rate. History, not a forecast.
- **Value projection** — a deterministic compound projection of the current total
  at a user-chosen assumption (5 / 7 / 10%), drawn as a **dashed** line because it
  is illustrative end-to-end. It does **not** predict the market.
- **Goal marker** — enter a target and an optional monthly contribution; the page
  marks the projected date the portfolio reaches it (or says it isn't reached
  within 100 years). A single-target marker only — no Monte Carlo, no withdrawal
  modeling (those are explicitly deferred per ADR-022).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Position shows value `—` | No price yet for the symbol | Wait for the nightly fetch, or confirm the ticker is valid; non-tickered Plaid securities price from `institution_price` after the next sync. |
| Gain/loss shows `—` | No cost basis recorded | Add lots, or enter an aggregate cost basis on the holding. |
| Cost basis looks wrong after a Plaid sync | Plaid overwrote a thin basis | Enter lots — they take precedence and the watermark blocks future overwrites. |
| A sold position still appears | Holdings sync hasn't run since the sale | Force a sync or wait for the 03:00 cron; the next holdings snapshot removes it. |
| `/investments` is empty after connecting | Worker not running | Start `pnpm worker`; the initial sync is a queued job. |

See [PLAID.md](PLAID.md) for Link/credentials/mapping and
[RUNBOOK_PLAID.md](RUNBOOK_PLAID.md) for sync failure modes.
