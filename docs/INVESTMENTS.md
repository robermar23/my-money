# Investments

How my-money tracks investment value: positions, cost basis, gain/loss, asset
allocation, and dividend/interest income. Two ingestion tracks feed the same
`/investments` dashboard — **Plaid Investments** (automated, for brokerages
that support it) and **manual entry** (for everything Plaid can't reach).

> **Gain/loss here is a display figure, not tax advice.** It is simply
> `current value − cost basis`. my-money does **not** do tax-lot selection
> (FIFO/LIFO/specific-ID), wash-sale tracking, realized-vs-unrealized
> capital-gains reporting, or 1099 generation — those are explicitly out of
> scope (CLAUDE.md §Domain Scope). Lots exist to make the cost-basis number
> *more accurate*, nothing more. For taxes, use your brokerage's documents.

---

## What counts as an "investment account"

The `/investments` page aggregates every holding on accounts of type
`investment` (brokerages, 401k) and `crypto_ira` (iTrust gold + crypto). Their
value is `quantity × latest price`, not a typed-in balance. Cash, credit-card,
loan, and property accounts are not shown here.

Reach the dashboard from the **"Investments →"** link on the home page or the
accounts page.

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
