# my-money — IDEAS

> Brainstorming artifact for the personal finance tracker described in [FEATURE.md](FEATURE.md).
> This is **not a plan and not an implementation spec**. It's a structured idea matrix
> exploring approaches, integrations, costs, and trade-offs so a confident plan can follow.

---

## ⚓ ADR-001 — Build from scratch (locked 2026-05-25)

**Decision**: Build my-money from scratch. Do **not** fork Maybe Finance.

**Why**:
- Maybe is Rails/Ruby. Ruby (like Java) creates its own development world — version managers (rbenv/rvm), gem hell, native extension build failures, "just `bundle install`" rituals that turn into half-day yak-shaves. The user has a strong, established aversion to this class of environment.
- Forking inherits all of that, forever.
- AI-coded implementation changes the build-vs-fork calculus dramatically: the "months of work" that originally justified forking shrinks to days/weeks of focused iteration.

**Maybe's role going forward**: **Reference architecture, not codebase to fork.** The clone at `E:\AntiGravityCode\maybe` is read-only inspiration for:
- Domain model (Family → Accounts → Entries; Investment → Holdings → Securities → Trades)
- Sync orchestration patterns (PlaidItem → Sync record → background jobs)
- Balance::Syncer nightly snapshot pattern (this is exactly the `account_snapshots` table from §6)
- Two-track ingestion (Plaid push + manual CSV import)
- Multi-currency: store in base currency, fetch FX rates separately
- Separation of `entries` (cash movements) from `trades` (investment events)

**What we discard**: Rails, Sidekiq, Hotwire/Turbo/Stimulus, ViewComponent, ERB, Doorkeeper, Brakeman, Minitest, Sprockets, the whole Bundler/asset-pipeline universe.

This decision supersedes the §7 and §13 recommendations to spike-or-fork Maybe.

---

## ⚓ ADR-002 — Self-hosted web app + Postgres (locked 2026-05-25)

**Decision**: Build as a **self-hosted web app** (Option B from §3) with **Postgres** as the primary datastore.

**Why web app (not desktop/plain-text)**:
- Real-time Plaid webhooks require an always-on, internet-reachable host.
- Phone access matters for a finance dashboard.
- Scheduled jobs (nightly snapshots, daily price fetches) are first-class on a server, awkward on a laptop.
- The "machine is off, data is stale" failure mode of a desktop app is exactly what kills personal-finance projects.

**Why Postgres (not SQLite)**:
- Concurrent webhook handlers + background job workers + UI reads — Postgres handles this cleanly; SQLite's write lock becomes a bottleneck the moment jobs and webhooks race.
- Richer types: `numeric` for money (exact), `jsonb` for Plaid raw payloads, `timestamptz` for unambiguous time, range types, partial indexes.
- Trivial Docker Compose deployment alongside the app.
- Real migrations toolchain across every backend ecosystem.
- The cost (one extra container) is zero; the future-proofing is significant.

**Deployment shape (locked)**:

```
[Browser / Phone]
      |
      | (HTTPS via Cloudflare Tunnel or Tailscale)
      v
[Caddy reverse proxy]
      |
      v
[App container]  <--->  [Postgres container]  <--->  [Backups]
      |
      v
[Worker container]  -- cron + Plaid webhooks + price fetches
```

- Host: home server / NAS / Pi / cheap VPS (Hetzner CX22 ≈ $5/mo). Decision deferred to user's hardware.
- Public reach: **Cloudflare Tunnel** (zero open ports) or **Tailscale** (LAN-only) — pick at deploy time, not now.
- Backups: `pg_dump` nightly → encrypted with `age` → off-host (Backblaze B2 or second disk).

This decision supersedes the §3 architecture options (A and C are out) and the §6 storage recommendation (SQLite is out).

---

## ⚓ ADR-003 — TypeScript / Next.js / Drizzle / Postgres (locked 2026-05-25)

**Decision**: Stack A from §7.5.

**Locked components**:

- **Language**: TypeScript end-to-end
- **Framework**: Next.js 15 (App Router) — single app for UI + API routes + server actions
- **ORM**: Drizzle ORM — honest SQL with full types, no ActiveRecord-style magic
- **Database**: Postgres (per ADR-002), running in a sibling container
- **Migrations**: `drizzle-kit`
- **Plaid SDK**: `plaid` (official Node SDK, flagship of Plaid's offerings)
- **Background jobs**: BullMQ + Redis container (for webhook processing, nightly snapshots, price fetches)
- **Auth**: Lucia or Auth.js (defer choice to plan phase — both are TS-native, no friction)
- **Styling**: Tailwind v4 (matches Maybe's choice — proven for finance UIs)
- **Charts**: Recharts or Observable Plot (defer pick; both are first-class)
- **Tests**: Vitest + Playwright for the handful of critical user flows
- **Package manager**: `pnpm` (faster, stricter, smaller node_modules than npm)
- **Linter/formatter**: Biome (single tool; no ESLint+Prettier dual setup)
- **Container**: Multi-stage Dockerfile → ~150MB final image, deployed via `docker compose`

**What this explicitly rules out**: Webpack config tinkering (Next handles it), bespoke build pipelines, microservices, GraphQL, tRPC (server actions are enough), Prisma (Drizzle is the modern pick), Redux/Zustand at the start (server components handle most state).

---

## 0. Skills Consulted

This document was shaped by these skills under `C:\Users\Robert\AppData\Roaming\Antigravity\skills\skills\`:

| Skill | How it shaped this doc |
|---|---|
| `brainstorming` | Structure: Understanding Lock → assumptions → alternatives → decision log. No implementation yet. |
| `multi-agent-brainstorming` | Built in a "Skeptic" pass and a "Constraint Guardian" pass per option. |
| `plaid-fintech` | Real-world Plaid pricing, sandbox vs. prod gotchas, item-error/reauth UX, sync cursor model. |
| `alpha-vantage` | The "cache nightly" pattern (free-tier-friendly) shaped §5. AV itself was dropped 2026-05-27 after they removed metals from the free tier; the cache pattern stuck. |
| `plan-writing` | Phased rollout (Phase 1 manual → Phase 2 aggregator → Phase 3 enrichment). |

---

## 1. Understanding Lock (what I think you want)

- **What**: A private, self-owned personal finance tracker. Net worth, cash flow, and holdings over time across all accounts.
- **Why**: Quicken/Mint/Empower/Monarch either cost money, sell/monetize your data, or both. You want sovereignty over your own financial picture.
- **Who**: You. Single user, household-scale. Not a product.
- **Scope IN**:
  - Cash accounts (M&T Bank checking/savings)
  - Credit card balances + transactions
  - Brokerage / retirement (Fidelity, iTrust Capital)
  - Mortgage liability (Sunwest)
  - Home value as an asset
  - Investments: stocks, precious metals ("minerals"), crypto
  - **Net worth and totals over time** — history is a first-class requirement
- **Scope OUT (non-goals)**:
  - Not replacing Quicken/QuickBooks (no double-entry GL, no tax reporting, no bill-pay)
  - Not multi-user / not a SaaS product
  - Not selling/sharing data — ever
- **Implicit constraint**: Prefer **free** or **one-time-cost**; tolerate small monthly fees only where the alternative is hours of manual work per month.

### Open questions (resolved 2026-05-25)

1. **Hosting**: ✅ **Home server / NAS / Pi already owned.** Linux + Docker Compose target. Reachable via Tailscale or Cloudflare Tunnel (deferred to deploy time). ARM64 considered if it's a Pi.
2. **Update cadence**: ✅ **Daily end-of-day.** One nightly cron handles prices + snapshots + reconciliation. Plaid webhooks still process in real-time but don't trigger UI refreshes — they queue work for the next nightly recompute.
3. **History depth**: ✅ **Backfill as much as exports allow.** Phase 3 QFX importers must handle bulk historical statements (years per institution). Plaid initial sync requests max available history (up to 24 months on `transactions/sync`). For pre-history periods, `account_snapshots` is derived by walking transactions backward from current balance.
4. **"Minerals"**: ✅ **Physical precious metals — specifically gold held in iTrust Capital IRA.** Stock-style mining tickers flow through normal equity tracking; the new requirement is a `physical_metal` asset class (see §4.3 and schema in §6 — both updated below). Quantity in troy ounces × daily spot price = holding value.
5. **Effort budget**: ✅ (Implied by other answers) — daily EOD + manual quarterly for iTrust + manual quarterly for home value = roughly 15 minutes/quarter of manual entry. Monthly QFX import drag-and-drop is the only other ritual.

---

## 2. Non-Functional Requirements (proposed defaults — confirm or override)

| NFR | Proposed default | Why |
|---|---|---|
| **Privacy** | All data stored locally or on your own server. No third-party telemetry. | Stated explicitly in FEATURE.md. |
| **Security** | Credentials & access tokens encrypted at rest (libsodium / age / OS keychain). HTTPS-only for any web UI. | Plaid skill flags unencrypted access tokens as a CRITICAL bug. |
| **Availability** | Best-effort. Single user — if it's down for an hour, no SLA. | YAGNI on HA. |
| **Performance** | Net-worth dashboard < 1s on a year of daily snapshots. | Trivially achievable on SQLite. |
| **Scale** | ~10 accounts, ~50k transactions over 10 years, ~100 unique holdings. | Single-user finance; SQLite easily handles 100× this. |
| **Data durability** | Nightly backup to encrypted file (Borg/Restic/Duplicati to a second disk or cloud). | History over time is the whole point. |
| **Maintainability** | One person (you) can maintain it. Boring stack > clever stack. | Solo project. |
| **Portability** | Data must be exportable to CSV/Parquet at any time. No lock-in to your own tool. | Hedge against your own future abandonment. |

---

## 3. Architecture Options (top-level shape)

Three viable shapes. Pick one; the per-institution integrations layer on top of any of them.

### Option A — Local-first desktop app (Tauri or Electron)

```
[Tauri/Electron shell] -> [Local SQLite] -> [Sync workers as background tasks]
```

- **Stack**: Tauri (Rust + web UI) or Electron (Node + web UI), SQLite via better-sqlite3 / rusqlite, React/Svelte UI.
- **Where it runs**: Your laptop. Data lives in `~/.my-money/db.sqlite` (encrypted with SQLCipher).

| Pros | Cons |
|---|---|
| Maximum privacy — data never leaves the machine | No webhooks (machine must be on to sync) |
| No hosting cost | Plaid webhooks lose their value; falls back to polling |
| Easy backup (one file) | Phone access requires extra work |
| Snappy UI | Multi-device sync is a project unto itself |

**Skeptic view**: "You'll forget to open it for two weeks, then have a stale picture."
**Constraint Guardian view**: Plaid sandbox webhooks won't fire to localhost without a tunnel; in production you'd lose the real-time transaction sync. Acceptable for a personal tracker that you check weekly.

---

### Option B — Self-hosted web app on a home server / VPS

```
[Browser] -> [Next.js / FastAPI / Rails] -> [Postgres or SQLite] -> [Cron + webhook handlers]
```

- **Stack**: Next.js + Prisma + Postgres, OR FastAPI + SQLAlchemy + SQLite, OR Rails (if you fork Maybe Finance — see §7).
- **Where it runs**: A Raspberry Pi, an old NUC, your Synology, or a $5–10/mo VPS (Hetzner, Fly.io free tier, Oracle Cloud Always Free).
- Reach via Tailscale / Cloudflare Tunnel — no exposed ports.

| Pros | Cons |
|---|---|
| Webhooks work (real Plaid push updates) | Hosting effort: OS updates, certs, backups |
| Accessible from phone & laptop | A small ongoing money cost if you don't already have a box |
| Scheduled jobs (nightly snapshot, market-data refresh) just work | Bigger attack surface than a local app |
| Easier to layer on a 2nd person later if you want | More moving parts to maintain |

**Skeptic view**: "Self-hosted projects rot. You'll patch it for 6 months then bit-rot will eat it."
**Constraint Guardian view**: If you use Cloudflare Tunnel + Tailscale + Caddy for auto-HTTPS, the ops burden drops to "occasional `docker compose pull`."

---

### Option C — Plain-text accounting + dashboards (Beancount / hledger)

```
[Hand-edited .beancount files in git] -> [bean-query / Fava web UI] -> [Browser charts]
```

- **Stack**: [Beancount](https://beancount.github.io/) or [hledger](https://hledger.org/), [Fava](https://beancount.github.io/fava/) for UI, a thin Python wrapper for importers and price fetches.
- **Where it runs**: Anywhere. Data is text in a git repo.

| Pros | Cons |
|---|---|
| Bulletproof data format (text + git = forever) | Steep learning curve (debit/credit thinking) |
| Zero vendor lock-in — ever | Beautiful charts are not its strong suit |
| Free, mature, well-loved by finance nerds | "Integration" usually means importer scripts you wrote |
| Trivially diffable and auditable | Crypto and stock holdings tracking is workable but not native-feeling |

**Skeptic view**: "You said you don't want Quickbooks, but plain-text accounting is *more* accounting-flavored, not less."
**User Advocate view**: If the goal is a *dashboard* of net worth and trends — not bookkeeping — this option fights you a bit.

---

### Architecture decision matrix

| Criterion | A. Desktop | B. Self-hosted web | C. Plain-text |
|---|---|---|---|
| Setup time | Medium | Medium-high | Low (install) / High (learn) |
| Ongoing maintenance | Low | Medium | Low-Medium |
| Privacy ceiling | Highest | High | Highest |
| Webhook / push sync | ❌ | ✅ | ❌ |
| Phone access | Hard | Easy | Medium (via Fava) |
| History over time | ✅ (snapshots table) | ✅ (snapshots table) | ✅ (git history) |
| Custom analytics | ✅ | ✅ | ✅ (SQL via beancount.query) |
| Risk of bit-rot in 3 years | Low | Medium | Lowest |
| Fits FEATURE.md vibe ("dashboard of what I have") | ✅✅ | ✅✅✅ | ✅ |

**Recommendation seed**: Option B (self-hosted web) if you have or want a home server / Pi; otherwise Option A (Tauri desktop). Option C is the "data layer" backup plan — even if you build A or B, **export to beancount nightly** as a vendor-lock-in hedge.

> **✅ Locked: Option B (self-hosted web).** Per ADR-002. Options A and C are out. The Option C "data layer" idea survived as the nightly beancount export — **shipped in Phase 6 (ADR-016)**, not Phase 4.

---

## 4. Per-Institution Integration Matrix (the hard part)

This is where personal finance projects die. Each US institution is its own special case.
Columns: **automation route**, **realistic cost**, **expected effort**, **what you actually get**.

### 4.1 M&T Bank — checking, savings, payments

| Route | Cost | Effort | Quality | Notes |
|---|---|---|---|---|
| **Plaid (Development tier)** | Free for first 100 Items; ~$0.30/mo per active connection after. M&T is supported. | Medium (Link flow, webhooks, encryption) | Best | Transactions sync API is incremental, webhook-driven. Limit yourself to <100 Items and stay free indefinitely. |
| **MX / Finicity / Yodlee** | Generally enterprise pricing, not viable solo | High | Best | Skip — built for fintechs, not individuals. |
| **SimpleFIN Bridge** | $1.50/mo flat (any number of banks) | Low | Good for transactions, no balances detail | Great fit for hobby finance apps. Used by Actual Budget. |
| **Manual OFX/QFX export** | Free | Low (per export) | Good (transactions + balances) | M&T supports "Download to Quicken/Money" → .QFX file. Import nightly or weekly. Mature parsers exist in every language. |
| **CSV export** | Free | Low | OK (no machine-readable categories) | Always works as a fallback. |
| **Browser automation (Playwright)** | Free | High + fragile | Brittle | Banks actively defeat scraping; MFA breaks it; ToS issues. **Don't.** |

**Recommendation**: Start with **monthly QFX import** (zero cost, zero risk). Layer **Plaid Development** when you want push updates. Keep SimpleFIN as plan B if you ever exceed Plaid's free tier.

---

### 4.2 Fidelity Investments — brokerage, 401k, NetBenefits

| Route | Cost | Effort | Quality | Notes |
|---|---|---|---|---|
| **Plaid (brokerage `Investments` product)** | Free up to 100 Items, then ~$0.35/mo/connection | Medium | Good for holdings + transactions; cost basis sometimes thin | Fidelity is well-supported. NetBenefits (401k) coverage is patchier than brokerage. |
| **SnapTrade** | Free dev tier (5 connections), then ~$2/connection/mo | Medium | **Best for investments** — orders, holdings, history | Purpose-built for retail investor data. Worth a hard look here. |
| **Fidelity OFX direct connect** | Free | Low (per export) | Good | Fidelity supports Quicken-style OFX export. Manual. |
| **fidelityapi-py / unofficial libs** | Free | High + fragile | Variable | Reverse-engineered. Breaks when Fidelity updates their site. **Avoid for serious use.** |
| **CSV downloads** | Free | Low | OK | Always works. |

**Recommendation**: **Plaid** for brokerage, **manual CSV** for 401k/NetBenefits unless Plaid covers it for your specific plan. Consider **SnapTrade** if you want clean position/lot data.

---

### 4.3 iTrust Capital — crypto + **physical gold** IRA

**Holdings mix (confirmed 2026-05-25)**: user holds **physical gold bullion** through iTrust (allocated metals storage), plus possibly crypto positions. Both share the same custodian but track differently.

| Route | Cost | Effort | Quality | Notes |
|---|---|---|---|---|
| **Plaid** | — | — | ❌ Not supported (as of 2026) | iTrust is a niche IRA custodian. Plaid coverage is unlikely. |
| **iTrust statements (PDF/CSV)** | Free | Medium | OK | iTrust provides monthly statements. PDF parsing is painful; check if CSV/XLS is available in the portal. |
| **Manual quarterly entry of positions** | Free | Low | Good | Enter **ounces of gold** and **units of each crypto** held. App auto-revalues nightly using spot prices. |
| **Derive from contributions + market price** | Free | Low | Approximate | Loses precision on internal trades; not recommended now that we have first-class metal tracking. |

**Recommendation (locked)**: **Manual quarterly entry of physical metal quantity (oz) + crypto unit counts.** Daily auto-revaluation via:

- Gold spot price → Yahoo Finance (`GC=F` front-month COMEX futures; revised 2026-05-27, see §5.3)
- Crypto unit prices → CoinGecko

Schema implication (see §6): `holdings` table needs an `asset_class` discriminator and a `quantity_unit` field. For physical gold, `asset_class='physical_metal'`, `symbol='XAU'`, `quantity_unit='troy_oz'`.

---

### 4.4 Sunwest Mortgage — home loan liability

| Route | Cost | Effort | Quality | Notes |
|---|---|---|---|---|
| **Plaid (Liabilities product)** | Add-on; pricing similar to Transactions tier | Medium | Decent if supported | Sunwest may or may not be in Plaid's mortgage coverage — verify in Plaid's institution search. |
| **Amortization schedule** | Free | Low (one-time setup) | Excellent | Given principal, rate, start date, term → compute monthly balance deterministically. Reconcile against monthly statement. |
| **Manual statement entry** | Free | Low (monthly, 30 sec) | Perfect | Once a month: type in current balance + payment split (principal/interest/escrow). |

**Recommendation**: **Amortization schedule + monthly reconciliation**. The math is trivial and the data is correct by construction. Plaid Liabilities is overkill here.

---

### 4.5 Credit Card

| Route | Cost | Effort | Quality | Notes |
|---|---|---|---|---|
| **Plaid (Transactions)** | Free in dev tier | Medium | Best | Most major issuers supported. |
| **OFX/QFX export** | Free | Low | Good | Amex, Chase, Citi, Cap One, Discover all support direct connect or QFX download. |
| **CSV export** | Free | Low | OK | Universal fallback. |

**Recommendation**: Same as M&T — **QFX monthly to start, Plaid when you want push**.

---

### 4.6 Home Value (asset)

| Route | Cost | Effort | Quality | Notes |
|---|---|---|---|---|
| **Zillow Zestimate API** | ❌ Deprecated for public use | — | — | Was free, was killed. |
| **RentCast API** | Free tier: 50 calls/mo; paid from ~$74/yr | Low | Good | AVM (automated valuation) + rental estimate. Generous free tier given you only need monthly checks. |
| **Redfin estimate (scrape)** | Free | High + ToS-grey | OK | Scraping a single page once a month works but is fragile. |
| **Manual quarterly entry** | Free | Negligible | Coarse but honest | Look at Zillow/Redfin in your browser quarterly, type in the number. **Most realistic.** |
| **County assessor (assessed value)** | Free | Low | Tax basis, not market | Useful as a sanity check, not as the headline number. |

**Recommendation**: **Manual quarterly entry** as primary; optional RentCast free tier for monthly automated estimates if you want a trend chart.

---

## 5. Market Data Sources (for stocks, crypto, metals)

### 5.1 Stocks / ETFs

| Source | Cost | Rate limit | Notes |
|---|---|---|---|
| **Alpha Vantage** | Free tier | 25 calls/day | Documented in the [`alpha-vantage` skill]. Works if you cache. Premium $50/mo for serious use. |
| **Yahoo Finance (`yfinance`)** | Free | Best-effort, unofficial | Python's `yfinance` is the de facto hobby standard. Breaks occasionally when Yahoo changes things. |
| **Finnhub** | Free tier | 60 calls/min | Generous free tier. Good intraday data. |
| **Tiingo** | Free tier | 1000 req/hr, EOD only | High data quality. Best free EOD option. |
| **Polygon.io** | Free tier | 5 calls/min, 2yr history | Becomes expensive fast for real-time. |
| **IEX Cloud** | Shut down Aug 2024 | — | RIP. |

**Recommendation (locked)**: **`yahoo-finance2` (Node port of yfinance, free, no key) for prices.** Tiingo remains a documented fallback if Yahoo breaks; we'll wire it in only when that happens. Fundamentals (P/E, dividends, etc.) are a Phase 5+ concern and out of scope here.

### 5.2 Crypto

| Source | Cost | Notes |
|---|---|---|
| **CoinGecko** | Free tier, no key needed | 10–30 calls/min. Covers basically every coin. The gold standard for hobby use. |
| **CoinMarketCap** | Free tier with key | 10k calls/mo. Solid. |
| **Binance / Kraken public APIs** | Free | Only their listed pairs. Good for BTC/ETH; weaker for altcoins. |

**Recommendation**: **CoinGecko free tier**. Done.

### 5.3 Precious Metals (confirmed: physical gold in iTrust IRA)

The user's specific need: **value the physical gold held in their iTrust Capital IRA** by multiplying ounces held × current spot price. Mining stocks/ETFs (GLD, NEM, etc.) flow through normal equity tracking in §5.1.

| Source | Cost | Notes |
|---|---|---|
| **Yahoo Finance** | Free, no key | Front-month COMEX futures (`GC=F` gold, `SI=F` silver, `PL=F` platinum, `PA=F` palladium). Tracks spot within a fraction of a percent — fine for personal net-worth tracking. |
| **metals.live** | Free, no key | Spot prices for gold/silver/platinum/palladium. Simple JSON. |
| **MetalpriceAPI** | Free tier: 100 req/mo | Spot + historical. 100/mo is plenty for daily-snapshot use. |
| **GoldAPI.io** | Free tier with email signup | Plenty for daily-snapshot use. |
| **Alpha Vantage** | ~~Free, in same skill~~ | ~~Commodity endpoints cover gold/silver/oil/etc.~~ ❌ **Removed metals from free tier in 2026** — `CURRENCY_EXCHANGE_RATE` for XAU now returns `"Invalid API call"`. Cheapest paid plan that restores access ≈ $50/mo. |

**Recommendation (locked 2026-05-25, revised 2026-05-27)**: **Yahoo Finance** for metals, via the same `yahoo-finance2` library used for equities. The fetcher translates the user-facing canonical metal symbol (`XAU`/`XAG`/`XPT`/`XPD`) to Yahoo's futures ticker (`GC=F`/`SI=F`/`PL=F`/`PA=F`) at the boundary and stores the price back under the canonical symbol, so the `prices` table is keyed by `symbol='XAU'` regardless of source. metals.live and GoldAPI.io remain documented fallbacks if Yahoo ever breaks. **Why not AV (original pick):** AV dropped metals from the free tier in early 2026; their cheapest plan that restores access is ~$50/mo, disproportionate for one daily fetch.

**Historical fill**: iTrust statements typically show end-of-month bullion value. When importing past statements, also backfill `prices` for those month-end dates so historical net-worth snapshots reflect actual gold valuations at the time.

**Cache pattern**: All market data fetched once per day after market close, stored in a `prices(symbol, date, close)` table. The dashboard reads from cache, never from APIs. This single design choice keeps you under every free tier forever.

---

## 6. Storage & Schema (sketch only)

### Storage engine

| Engine | When to pick | Why |
|---|---|---|
| **SQLite** | Solo user, single host | Zero ops, fastest dev loop, one file to back up. Comfortably handles 10M+ rows. |
| **Postgres** | Self-hosted web (Option B) with future-proofing | Better concurrency, richer types (numeric, jsonb). Overkill at this scale but cheap insurance. |
| **DuckDB** | Analytics-heavy use | Column store, blazing fast for reports. Could sit alongside SQLite as a read-replica for charts. |

**Recommendation**: **SQLite primary**. If you outgrow it (you won't), migration to Postgres is a one-day job.

> **✅ Locked: Postgres.** Per ADR-002. SQLite is out. Concurrent webhooks + workers + UI reads + `numeric` for money + `jsonb` for raw Plaid payloads make Postgres the right pick despite the single-user scale.

### Minimal schema sketch (updated 2026-05-25 for physical-metal class)

```sql
accounts(id, institution, name, type, currency, opened_at, closed_at, plaid_item_id)
holdings(
  id, account_id,
  symbol,                    -- 'AAPL', 'BTC', 'XAU', 'NULL for cash'
  quantity NUMERIC(28,8),    -- shares, coins, troy ounces — precision matters
  quantity_unit,             -- 'shares', 'coin', 'troy_oz'
  cost_basis NUMERIC(18,2),  -- nullable; not always known (IRA gold often isn't)
  asset_class                -- 'equity', 'crypto', 'physical_metal', 'cash', 'property'
)
transactions(id, account_id, posted_at, amount NUMERIC(18,2), name, category, plaid_txn_id, fitid)
prices(
  symbol, date, close NUMERIC(18,8), source,
  PRIMARY KEY (symbol, date)
)
account_snapshots(
  account_id, date, balance NUMERIC(18,2), holdings_value NUMERIC(18,2),
  PRIMARY KEY (account_id, date)
)                                -- daily; the source of "history over time"
liabilities(id, name, principal_at_origination, rate, term_months, start_date, current_balance_computed)
fx_rates(date, base, quote, rate)
```

Two notes:

- **`NUMERIC` not `float`** for everything money-shaped. Postgres `numeric` is exact; floats silently lose pennies over time. The `plaid-fintech` skill flags this implicitly.
- **`fitid`** on `transactions` is the OFX/QFX unique transaction ID — used for QFX import deduplication so re-importing the same statement is idempotent.

The `account_snapshots` table is the single most important table — **it's what makes net-worth-over-time queries trivial**. Written nightly via cron.

---

## 7. "Don't build it from scratch" — fork or extend?

Honest consideration: there are **open-source apps that already do 70% of this**.

| Project | Stack | What it gets right | What you'd add |
|---|---|---|---|
| **[Maybe Finance](https://github.com/maybe-finance/maybe)** | Rails + Postgres | Open-sourced 2024. Net worth, accounts, holdings, Plaid integration. Closest to your stated goal. | iTrust import, mortgage amortization tracking, precious metals. |
| **[Actual Budget](https://actualbudget.org/)** | Node + React, local-first | Envelope budgeting, local-first, SimpleFIN integration. Beautiful UX. | Investment tracking is weak; would need a sidecar. |
| **[Firefly III](https://www.firefly-iii.org/)** | PHP/Laravel | Mature, self-hosted, double-entry. | Investment tracking weak; no auto-import (use [firefly-iii-data-importer]). |
| **[Ghostfolio](https://ghostfol.io/)** | Nest.js + Angular | Investment-tracker focused. Net worth, holdings, dividends. | Bank/cash account tracking weaker than Maybe. |
| **[Wealthfolio](https://wealthfolio.app/)** | Tauri (desktop) | Pure local, investment-focused, beautiful. | No bank sync at all — investment-only. |
| **Beancount + Fava** | Python | Plain-text, forever-data. | Everything UI-related; you'd write importers. |

### Build vs. fork matrix

| Option | Effort | Control | Long-term risk | "Mine" factor |
|---|---|---|---|---|
| Build from scratch | High (months) | Total | You own the bit-rot | Highest |
| **Fork Maybe Finance, add custom importers** | Medium | High | Inherits a maintained project | High |
| Run Ghostfolio + Actual side-by-side, glue with a tiny dashboard | Low | Medium | Two upstream projects to track | Medium |
| Beancount + Fava + custom importers | Medium | Total (text files) | Lowest — data outlives the tools | High |

**A real recommendation**: Spend **one evening installing Maybe Finance locally** and seeing if it covers 70% of FEATURE.md before writing a line of code. If it does, **fork it** and add the iTrust importer + mortgage amortization + precious-metals price feed. You'd ship in days, not months, and inherit ongoing maintenance from the upstream project.

> **❌ Superseded by ADR-001 (2026-05-25).** Build from scratch. Maybe stays as a reference architecture in `E:\AntiGravityCode\maybe`, not a fork target.

---

## 7.5 Tech Stack Options (from-scratch, no Ruby/Java)

Per ADR-002 (self-hosted web + Postgres), the stack must be:

- A web framework with a real HTTP server
- A Postgres client/ORM with migrations
- A first-class Plaid SDK
- A frontend story (SPA, MPA with islands, or HTMX)
- A background job/cron mechanism
- A test runner
- A clean, **non-cursed** development environment (the bar set by ADR-001)

Three viable, modern stacks. All three avoid Ruby and Java entirely.

### Stack A — TypeScript end-to-end (RECOMMENDED)

```
Next.js 15 (App Router)  +  Drizzle ORM  +  Postgres
       +  Plaid Node SDK  +  BullMQ (jobs)  +  Vitest
       +  Tailwind v4  +  Recharts or Observable Plot
```

| Pros | Cons |
|---|---|
| One language end-to-end (no context switch between API and UI) | Node ecosystem churn is a real tax (mitigated by sticking to Next + Drizzle, both stable) |
| **Plaid's flagship SDK is TypeScript** — best docs, best types | `node_modules` is fat (but reproducible via `pnpm` + lockfile) |
| Drizzle = honest SQL with types, no ORM-magic surprises like ActiveRecord | Need Redis container for BullMQ (one more service) |
| Massive charting / UI library ecosystem | — |
| AI-coding throughput is highest here (training data abundance) | — |
| `pnpm install` → done. No version managers, no native-extension hell. | — |
| Maybe's own JS layer is TS — proven idiom for finance UIs | — |

**Dev env feel**: `pnpm i && pnpm dev`. Done. Hot reload. Type errors in the IDE. Single `package.json`.

---

### Stack B — Python (FastAPI + SQLAlchemy + SvelteKit frontend)

```
FastAPI  +  SQLAlchemy 2.x  +  Alembic  +  Postgres
       +  Plaid Python SDK  +  APScheduler or Arq (jobs)  +  pytest
       +  SvelteKit frontend (separate app)  OR  HTMX/Jinja (server-rendered)
```

| Pros | Cons |
|---|---|
| **Best-in-class finance/data ecosystem**: pandas, numpy, yfinance native | Two languages if you go SvelteKit; one language but uglier UI if you go HTMX |
| FastAPI is genuinely delightful, OpenAPI for free | SQLAlchemy is powerful but verbose vs. Drizzle |
| `uv` makes Python envs fast & reproducible — *not* the pip/venv hell of old | Plaid Python SDK lags TypeScript SDK slightly in docs/examples |
| Easy to drop into a Jupyter notebook for ad-hoc analysis of your own data | Async story is fine but less ergonomic than Node |
| Strong types via Pydantic + mypy | — |

**Dev env feel**: `uv sync && uv run uvicorn ...`. Genuinely clean since `uv` came out. Closer to Go's bar than the old `pip install -r requirements.txt` ritual.

---

### Stack C — Go backend + Svelte frontend (the "rock-solid dev env" pick)

```
Go (chi or Echo)  +  sqlc  +  Postgres  +  pgx
       +  plaid-go SDK  +  goroutines/cron lib for jobs  +  Go test
       +  SvelteKit frontend
```

| Pros | Cons |
|---|---|
| **Cleanest dev env of any modern stack.** Single static binary. No version managers. | Two languages (Go + TS for frontend) |
| `go build` → one file. Trivial Docker. ~10MB image. | Less library coverage for finance data (no `yfinance` analog; you'd write HTTP calls yourself) |
| Goroutines mean job workers, webhook handlers, and cron all in-process — no Redis | sqlc is great but more ceremony than Drizzle for rapid iteration |
| Compiles in seconds even at scale | AI-coding throughput slightly lower than TS (less training data) |
| Best fit if the "death by a thousand cuts" pain from ADR-001 is your top concern | — |

**Dev env feel**: `go run ./cmd/server`. The frontend has its own `pnpm dev`. Two terminals, zero environment drama.

---

### Stack decision matrix

| Criterion | A. TypeScript | B. Python | C. Go |
|---|---|---|---|
| Single language end-to-end | ✅ | ⚠️ (if HTMX) / ❌ (if SPA) | ❌ |
| Plaid SDK quality | ✅✅✅ flagship | ✅✅ | ✅✅ |
| Finance data ecosystem | ✅ (npm has decent libs) | ✅✅✅ (pandas, yfinance, ccxt) | ⚠️ (DIY) |
| Dev env cleanliness | ✅✅ (pnpm) | ✅✅ (uv) | ✅✅✅ (go) |
| AI-coding throughput | Highest | High | Medium |
| Long-term bit-rot risk | Medium (JS churn) | Low | Lowest |
| Charting / UI libs | ✅✅✅ | ✅ (via JS frontend) | ✅✅ (via Svelte) |
| Background jobs | BullMQ + Redis | Arq + Redis, or APScheduler in-proc | Goroutines, no Redis |
| Memory footprint | ~200MB | ~150MB | ~30MB |
| **Maps to "I hate cursed dev envs"** | ✅ | ✅ (with `uv`) | ✅✅✅ |

### Recommendation

**Stack A (TypeScript / Next.js / Drizzle / Postgres)**, primarily because:

1. Plaid's TS SDK is the flagship — and Plaid is the riskiest integration in this whole project.
2. One language end-to-end reduces context-switching when I'm writing both API routes and React components in the same session.
3. AI-coding throughput is empirically highest here, which matters because I'm the one writing it (per your point).
4. `pnpm` + `Next.js` + `Drizzle` is the *least cursed* TS stack — no Webpack hell, no `node_modules` mystery breakages.

**Stack C (Go)** is my close second if your tolerance for *any* JS ecosystem weirdness is zero. It's the most boring, most permanent option.

**Stack B (Python)** wins if you anticipate doing heavy custom analytics over your own data (the pandas + Jupyter loop is unmatched). Less critical for a dashboard.

---

## 8. Cost Summary (annualized, worst case)

Assuming Option B (self-hosted web) with Plaid for what supports it:

| Line item | Cost / year |
|---|---|
| Hosting (Hetzner CX11 or Pi you already own) | $0 – $60 |
| Domain (optional, use Tailscale instead) | $0 – $12 |
| Plaid (under 100 Items, Development tier) | **$0** |
| SimpleFIN (if you skip Plaid) | $18 |
| Market data (yfinance + CoinGecko + metals.live free tiers) | **$0** |
| RentCast (optional, home value monthly) | $0 (free tier) – $74 |
| Backups (Backblaze B2 or Duplicati to second disk) | $0 – $24 |
| **Total realistic** | **$0 – $80/year** |

For comparison: Monarch is $100/yr, Empower is "free" (they sell your data and try to upsell you to their advisors), Quicken is $60–120/yr.

---

## 9. Phased Rollout (recalibrated for AI-coded delivery)

> Removed weekend estimates — they assumed human throughput. Reframing as **scope per iteration**: each phase is a coherent, demoable slice that ends with the app in a working state.

### Phase 0 — Bedrock (no app code yet)

- Initialize Next.js 15 + TypeScript + Tailwind v4 + Biome + pnpm
- `docker compose` with: app, Postgres, Redis (for BullMQ)
- Drizzle setup + first migration scaffolding
- Auth scaffolding (single user — you — but real password / session)
- Caddy + Cloudflare Tunnel notes in the README (actual deploy deferred)
- **Demo state**: `pnpm dev` launches an empty authenticated app at `localhost:3000`

### Phase 1 — Manual entry + a real net-worth chart

- Schema: `families`, `users`, `accounts`, `holdings`, `entries` (transactions/trades), `securities`, `prices`, `account_snapshots`, `exchange_rates`
- All accounts created manually via UI: M&T checking, M&T savings, credit card, Fidelity, iTrust, Sunwest, "Home" (property)
- Manual entry forms for: balances, holdings, mortgage origination data
- Mortgage amortization computed deterministically from `(principal, rate, term, start_date)` — no Plaid needed
- Nightly cron job writes `account_snapshots` (sums of all accounts at end-of-day)
- Single dashboard page: net worth line chart, accounts breakdown table
- **Demo state**: You enter your real numbers once and see a real net-worth dashboard

### Phase 2 — Market data ingestion

- Daily cron job fetches prices for held symbols:
  - Stocks/ETFs: `yfinance`-equivalent (Node has `yahoo-finance2`) with Tiingo fallback
  - Crypto: CoinGecko free tier
  - Metals: Yahoo Finance front-month COMEX futures (`GC=F` etc.); see §5.3 for why not AV
- All prices cached in `prices(symbol, date, close, source)` table
- Holdings auto-revalue nightly using cached prices
- Charts now show *real* movement, not just manual snapshots
- **Demo state**: Your holdings update overnight; you see real portfolio drift on the dashboard

### Phase 3 — QFX/CSV import for cash & credit accounts

- File upload UI: drop a `.qfx` from M&T or your credit card → parsed → transactions imported
- Deduplication on `fitid` (the OFX transaction ID — already unique per institution)
- Category assignment: rules engine (regex on `name` → category) + manual override
- Statement-period reconciliation: show "imported balance" vs "computed from transactions" diff
- **Demo state**: Monthly ritual is "download QFXs, drop them in, done" — fully automated cash-flow history

### Phase 4 — Plaid push integration (the big one)

- Plaid Link flow for M&T + credit card (start with 2 connections under the free tier)
- Encrypted-at-rest access tokens (libsodium or `@noble/ciphers`)
- Webhook endpoint (Cloudflare Tunnel exposes it to Plaid)
- Idempotent webhook handler with signature verification (per `plaid-fintech` skill)
- Transaction sync via `/transactions/sync` with cursor persistence
- Item-error handling + reauth UI for `ITEM_LOGIN_REQUIRED`
- QFX importer becomes the fallback, not the primary path
- **Demo state**: Transactions arrive within minutes of posting at your bank

### Phase 5 — Investment depth

- Plaid Investments for Fidelity brokerage (where supported)
- Manual quarterly holdings entry for iTrust + Fidelity 401k
- Lot-level cost basis (optional; required for tax reporting if added later)
- Dividend / interest income breakdown view
- Asset allocation pie/sankey chart
- **Demo state**: Investments dashboard shows positions, cost basis, gain/loss, asset mix

### Phase 6 — Polish & longevity

> ✅ **Shipped 2026-06-07.** Full task breakdown in [PLAN6.md](PLAN6.md); the three new ADRs (014 backup, 015 alerts, 016 beancount) are in §11.

- ✅ Nightly export to beancount format → permanent text-file backup (one-way hedge, **ADR-016**; [docs/BEANCOUNT.md](../../docs/BEANCOUNT.md))
- ✅ Mobile-responsive layouts (Tailwind makes this cheap) — collapsing hamburger nav + `overflow-x-auto` tables, 375px Playwright smoke
- ✅ Anomaly alerts — in-app `/alerts` page primary; email is **notification-only** (count + sign-in link, **zero financial data**) via self-hosted SMTP. *Resend was rejected: emailing balances through a SaaS relay violates CLAUDE.md §Privacy* (**ADR-015**; [docs/ALERTS.md](../../docs/ALERTS.md))
- ✅ `pg_dump | age` backup job → encrypted → off-host, recipient-only (private identity never on the box) (**ADR-014**; [docs/BACKUP.md](../../docs/BACKUP.md))
- ✅ Restore-from-backup runbook ([docs/RESTORE.md](../../docs/RESTORE.md)); unattended-operation deploy runbook ([docs/DEPLOY.md](../../docs/DEPLOY.md))
- **Demo state**: System runs unattended; you only check it because you want to, not because you have to

Each phase is independently shippable. After Phase 1 you already have a working personal finance tracker. Everything after that is automation + breadth.

---

## 10. Risks & Sharp Edges

From the `plaid-fintech` skill and general experience:

| Risk | Mitigation |
|---|---|
| Plaid access tokens leaked → full bank-history exposure | Encrypt at rest (libsodium/age); never log; rotate via Link update mode if suspected. |
| `ITEM_LOGIN_REQUIRED` errors silently break syncing | Webhook handler must surface these as a notification; weekly "are any Items broken?" check. |
| Yahoo Finance / yfinance breaks one Monday | Tiingo fallback; cache means you don't lose history, just stop updating until you fix it. |
| Free API tier exhaustion | Cache aggressively; one fetch per symbol per day. |
| Schema regret (changing a NUMERIC column after 2 years of data) | Use migrations from day one (Alembic / Prisma migrate / Rails). |
| Project abandonment risk (you stop touching it for 3 months) | Plain-text export nightly. Worst case, you can read your data forever in `less`. |
| Backup not actually working | **Test restore quarterly.** A backup you've never restored isn't a backup. |
| "Minerals" ambiguity → wrong data source picked | Resolve open question #4 before Phase 1. |

---

## 11. Decision Log

| # | Decision | Outcome | Status | Rationale |
|---|---|---|---|---|
| ADR-001 | Build from scratch vs. fork Maybe Finance | **Build from scratch.** Maybe stays as read-only reference architecture only. | ✅ Locked 2026-05-25 | User has strong aversion to Ruby/Rails-style "own development world" environments. AI-coded delivery changes the build-vs-fork math. |
| ADR-002 | Architecture + database | **Self-hosted web app + Postgres.** | ✅ Locked 2026-05-25 | Webhooks, phone access, scheduled jobs require always-on host. Postgres handles concurrent webhooks + workers + UI cleanly; SQLite would bottleneck. |
| ADR-003 | Tech stack | **TypeScript / Next.js 15 / Drizzle / Postgres / BullMQ.** | ✅ Locked 2026-05-25 | Plaid's flagship SDK is TS. One language end-to-end. `pnpm` + Next + Drizzle is the least cursed JS stack. Highest AI-coding throughput. |
| 4 | M&T Bank ingestion | QFX import → Plaid push in Phase 4 | 🟡 Recommendation | Phase in; stay free; learn the data shape before APIs. |
| 5 | Fidelity ingestion | Plaid Investments for brokerage; manual for 401k/NetBenefits if not covered | 🟡 Recommendation | Plaid free under 100 Items. SnapTrade as upgrade path if cost basis matters. |
| 6 | iTrust Capital ingestion | Manual quarterly holdings entry | 🟡 Recommendation | No Plaid coverage; low trade frequency. |
| 7 | Sunwest Mortgage | Deterministic amortization schedule + monthly reconciliation | 🟡 Recommendation | Free, exact, no third-party dependency. |
| 8 | Home value | Manual quarterly entry | 🟡 Recommendation | Coarse but honest; avoid scraping ToS issues. |
| 9 | Market data | yahoo-finance2 (stocks AND metals via `GC=F` etc.) + CoinGecko (crypto), all cached daily | ✅ Locked 2026-05-25, revised 2026-05-27 (metals provider: AV → Yahoo, since AV dropped metals from its free tier; see §5.3) | All free tiers, zero API keys; cache pattern keeps usage under every limit. |
| 10 | Backups | `pg_dump` nightly → `age`-encrypted → off-host (Backblaze B2 or 2nd disk) | ✅ Resolved 2026-06-07 → **see ADR-014** | History is the product. Quarterly restore tests mandatory. Shipped as a BullMQ-scheduled job in Phase 6 (ADR-014). |
| 11 | Auth library | Lucia vs. Auth.js | ✅ Resolved 2026-05-25 → **see ADR-004** | Lucia deprecated; Auth.js overkill; rolled our own (see ADR-004). |
| 12 | Chart library | Recharts vs. Observable Plot | ✅ Resolved 2026-05-25 → **see ADR-005** | Recharts picked (see ADR-005). |
| 13 | Public exposure | Cloudflare Tunnel vs. Tailscale-only | ✅ Resolved 2026-06-01 → **see ADR-010** | Cloudflare Tunnel picked — sidecar `cloudflared` container, no inbound ports on the home router, TLS terminated at Cloudflare. Full ADR in [PLAN4.md](PLAN4.md). |
| ADR-004 | Auth library + UX | **Roll our own** with `iron-session` + `@node-rs/argon2` (argon2id). **Revised 2026-05-25 (same day)**: single `/login` page, one password field, no email, no username, no min-length policy, 1-year session. First submit sets the password; subsequent submits verify. Forgotten = `make db-reset` + re-bootstrap. | ✅ Locked 2026-05-25 (revised same day) | Lucia sunset March 2025; Auth.js/Better Auth heavy for single-user. Initial design imported generic-SaaS UX patterns (email field, min-length, rolling expiry) — stripped out because they add zero security on a single-user self-hosted box behind Tailscale, just friction. Full ADR in [PLAN0_1.md](PLAN0_1.md). |
| ADR-005 | Chart library | **Recharts**. Client Component island per chart. | ✅ Locked 2026-05-25 (Sankey note re-deferred 2026-06-06 → ADR-013) | React-native, SVG-based (accessible), lightweight, ships Phase 1 fastest. Phase 5 ships the asset-allocation **donut** in Recharts; the cash-flow **Sankey** is re-deferred (it's a flow viz, wrong for allocation) — see ADR-013. Full ADR in [PLAN0_1.md](PLAN0_1.md). |
| 14 | Update cadence | Daily-EOD / intraday / real-time | **Daily-EOD.** One nightly cron does prices + snapshots + reconciliation. Webhooks process in real-time but don't trigger UI recomputes. | ✅ Locked 2026-05-25 |
| 15 | Backfill strategy | Backfill / fresh-start / hybrid | **Backfill as much as exports allow.** QFX importers in Phase 3 handle bulk historical statements. Plaid initial sync requests max history (≤24mo). Pre-history `account_snapshots` derived by walking transactions backward from current balance. | ✅ Locked 2026-05-25 |
| 16 | "Minerals" definition | Physical metals / mining stocks / mined coins | **Physical gold in iTrust IRA.** New `asset_class='physical_metal'` with quantity in troy oz, priced from Yahoo Finance front-month COMEX futures (`GC=F`); fetcher maps canonical `XAU` ↔ `GC=F` at the boundary. metals.live as documented fallback. Mining stocks flow through normal equity tracking. | ✅ Locked 2026-05-25, revised 2026-05-27 (provider only — `asset_class` unchanged; AV dropped metals from free tier) |
| 17 | Hosting target | Decide later / VPS / home box | **Home server/NAS/Pi already owned.** Linux + Docker Compose target. ARM64 considered if it's a Pi. Tailscale or Cloudflare Tunnel decided at deploy time. | ✅ Locked 2026-05-25 |
| ADR-006 | QFX/OFX parsing | **Roll our own minimal SGML + XML parser** in `src/lib/importers/qfx/`. Zero npm dependency on a file-upload code path; ~120 LOC. Amounts returned as strings (never round-trip through Number). | ✅ Locked 2026-05-27 | Existing OFX npm packages are unmaintained or browser-oriented. Format is small, stable, well-documented. Test fixtures from real institutions lock behavior. Full ADR in [PLAN3.md](PLAN3.md). |
| ADR-007 | Transaction categorization | **Regex rule engine** in `category_rules` table; first match (lowest priority) wins. ~20 seeded defaults; inline override per transaction with `category_overridden_at` watermark; "Re-categorize all" button skips overridden rows. | ✅ Locked 2026-05-27 | LLM categorization is a non-starter (CLAUDE.md §Privacy). Local ML is overkill for one user. Regex is privacy-preserving, deterministic, debuggable. Full ADR in [PLAN3.md](PLAN3.md). |
| ADR-008 | Plaid environment + product scope | **Sandbox → Production** (skipping retired Development tier). **Transactions product only** (no Auth, Identity, Investments, Liabilities). **One Plaid Item per institution.** Two M&T accounts share an Item; the credit card is its own Item. | ✅ Locked 2026-05-31 | Plaid retired the Development tier in 2024–2025. Production's first 100 Items are free at ~$0/mo. Transactions-only minimizes scope drift; Investments deferred to Phase 5 (Fidelity), Liabilities replaced by deterministic amortization (ADR row 7). Full ADR in [PLAN4.md](PLAN4.md). |
| ADR-009 | Token encryption at rest | **AES-256-GCM via `node:crypto`** (zero new dependency). Versioned envelope `0x01 \|\| nonce(12) \|\| ct \|\| tag(16)`. Key in `MONEY_ENCRYPTION_KEY` (32 raw bytes, base64-encoded). Single reader: `loadAccessToken()` in `src/lib/plaid/tokens.ts`; column visibility enforced by a regression grep test. | ✅ Locked 2026-05-31 | libsodium's XChaCha20-Poly1305 adds 200 KB WASM + async init for no security upside at our scale (≤ 10 encryptions per token lifecycle). `node:crypto` AES-GCM is FIPS-aligned, dependency-free, and the versioned envelope makes future migration a `version === 0x02` branch. Key rotation runbook in [docs/CRYPTO_ROTATION.md](../../docs/CRYPTO_ROTATION.md). Full ADR in [PLAN4.md](PLAN4.md). |
| ADR-010 | Webhook public exposure | **Cloudflare Tunnel** (cloudflared sidecar). Outbound-dialed tunnel — zero open ports on the home router, TLS terminated at Cloudflare's edge. Dev uses `*.trycloudflare.com` quick tunnels. | ✅ Locked 2026-05-31 | Tailscale Funnel has reported delivery hiccups for Plaid webhooks; ngrok paid plan defeats the free-hosting line in §8; port-forwarding exposes the WAN IP and contradicts ADR-002's posture. Cloudflare's $10/yr domain is the only realistic Phase-4 dollar cost. Resolves deferred row 13. Full ADR in [PLAN4.md](PLAN4.md). |
| ADR-011 | Plaid Investments: product scope + sync model | **Separate Fidelity Item** consenting to `investments` only. **Products-based sync routing**: `HOLDINGS`/`INVESTMENTS_TRANSACTIONS` webhooks → new `sync-investments-item` worker; `TRANSACTIONS` → existing `sync-plaid-item`. Holdings = full-snapshot upsert + reconcile-missing; transactions = offset-paginated over 24mo, deduped by `investment_transaction_id`. Reuses the Phase-4 Item/token/webhook/sync-run infra. | ✅ Locked 2026-06-06 | Plaid Investments has no `/transactions/sync` cursor and its own webhooks; an investments-only Item must never hit `/transactions/sync`. SnapTrade deferred unless Plaid cost basis proves too thin. Full ADR in [PLAN5.md](PLAN5.md). |
| ADR-012 | Investment schema | New `securities`, `holding_lots`, `investment_transactions` tables + additive `holdings` columns (`security_id`, `source`, `cost_basis_overridden_at`). `holdings` stays the canonical current position. **Cost-basis precedence**: sum(lots) → aggregate `cost_basis` → null. Plaid sync preserves a user-owned basis via the `cost_basis_overridden_at` watermark; reconcile never deletes `source='manual'` rows. | ✅ Locked 2026-06-06 | A flat holdings row can't express security metadata, per-lot basis, or the buy/sell/dividend stream. `NUMERIC` everywhere; gain/loss is a display number, no tax-lot engine (domain boundary). Canonical symbol `ticker → cusip → SEC:<id>`; synthetics priced from `institution_price`. Full ADR in [PLAN5.md](PLAN5.md). |
| ADR-013 | Asset-allocation chart | **Recharts donut now** (zero new dep); **cash-flow Sankey re-deferred** (a flow viz, wrong for a part-of-whole allocation). | ✅ Locked 2026-06-06 | Resolves the ADR-005 "Sankey deferred to Phase 5" note. A donut reads "share of whole" fastest for ≤6 asset classes; the net-worth line already covers time-series. `@nivo/sankey` revisited if/when a cash-flow feature is built (Phase 6-flavored). Full ADR in [PLAN5.md](PLAN5.md). |
| ADR-014 | Database backup mechanism | **BullMQ-scheduled `pg_dump \| age`** in the worker (not OS cron, not a sidecar) → encrypted to a mount, retained `BACKUP_RETAIN_DAYS` (default 14), off-host replication is the user's job. Recipient-only `age` encryption — the private identity is **never** on the server. Failure raises a `backup_failure` alert. | ✅ Locked 2026-06-07 | CLAUDE.md §Background Jobs: "keep scheduling visible inside the app." Separates the DB-backup key from `MONEY_ENCRYPTION_KEY` (a backup leak can't decrypt Plaid tokens). `pg_dump`/`age` binaries added to the worker image; job shells out via args-array (no shell injection). Restore is documented + tested (P6-07). Full ADR in [PLAN6.md](PLAN6.md). |
| ADR-015 | Anomaly alerts: detection + transport | **Deterministic rules** over Postgres (large txn, balance drop, item-login-required, stale snapshot/price, sync/backup failure) persisted to an `alerts` table (deduped by hash); **in-app `/alerts` page is primary**; email is **optional + notification-only** (count + sign-in link, **zero financial data**) via user-configured SMTP (`nodemailer`). | ✅ Locked 2026-06-07 | IDEAS.md §9 floated "Resend," but emailing balances/account names through a SaaS relay violates CLAUDE.md §Privacy. The email is a doorbell; figures live only in the authenticated UI (a test asserts no financial data in the body). No ML (hosted = §Privacy non-starter; local = overkill) — deterministic rules mirror the ADR-007 categorizer. Full ADR in [PLAN6.md](PLAN6.md). |
| ADR-016 | Beancount export | **Nightly one-way plain-text mirror** (`money.beancount`) to a mount: `open` directives, `balance` assertions from `account_snapshots`, `price` directives, best-effort two-posting transactions. Generated, never hand-edited; export-only (never re-imported). | ✅ Locked 2026-06-07 | The IDEAS.md §2/§10 longevity hedge — readable in `less` forever, surviving the app's own abandonment. Stays a *hedge*, not a ledger: one-way + best-effort transactions + no balance enforcement keeps us inside CLAUDE.md §Domain Scope (not double-entry accounting). The `age` `pg_dump` is the machine-faithful copy; this is the human-readable one. Full ADR in [PLAN6.md](PLAN6.md). |
| ADR-017 | Manual data management: edit / close / delete | **Accounts get a soft close (`closed_at`, already in schema) + a hard delete behind typed-name confirmation.** Name/institution always editable; **type/currency lock once the account has any transaction/holding/snapshot** (changing them after data exists corrupts valuation). **Plaid-linked accounts can't be hard-deleted** while connected — Disconnect first. Deletes cascade child rows in one DB transaction (every FK to `accounts.id` is `ON DELETE CASCADE`); deleting/editing a transaction/snapshot re-runs the affected-date snapshot recompute. **Closed accounts drop from current net worth but stay in historical chart points** (`closed_at IS NULL OR closed_at > asOf`). Plaid-sourced rows re-appear on the next sync by design; only `category` stays user-editable. | ✅ Locked 2026-06-15 | The single owner needs to correct their own data without destroying historical financial data (the product's value). No schema change — `closed_at` already exists. Kickoff decisions: typed-name confirm (vs plain "Are you sure?"), lock type/currency once data exists (vs warn), keep history intact on close (vs zero it). Full ADR + task breakdown in [PLAN7.md](PLAN7.md). |
| ADR-018 | Structured categories, groups, and simple budgets | **Replace free-text categories with a managed two-level taxonomy** (`category_groups` → `categories`), each category carrying a `kind ∈ {income, expense, transfer}` so transfers (WEB XFER, card payments, P2P) are excluded from spend totals. `transactions.category_id` + `category_rules.category_id` FKs are added **alongside** the existing `category` text columns (kept as a denormalized cache + rollback net; **not dropped this phase** — a drop needs a paired backup step). The **ADR-007 regex engine is retained**; `matchCategory` now resolves a rule's `category_id`. A one-shot idempotent backfill maps existing free-text values to leaves (unknowns → *Other*), never destroying data. Adds first-party spending analytics (`/analysis`), **simple monthly per-category budget targets** (not envelope/rollover), and a deterministic **trailing-average forecast**. All analytics are first-party SQL over local Postgres; **no LLM categorization, no third-party analytics**. | ✅ Locked 2026-06-19 | The owner's explicit ask in [IDEAS2.md](IDEAS2.md) ("details on spending and budgets related to categories"; "most items are not categorized"; "categories page is not very user-friendly") lifts simple budgeting from out-of-scope (it required an explicit ask per CLAUDE.md §Domain Scope) and motivates the move from fragile free-text categories to a reliable rollup model. Kickoff defaults: P2P apps (Venmo/Zelle/CashApp/Apple Cash) default to `kind='transfer'` (reclassifiable per category); analytics route `/analysis`; trailing-3-month forecast; category-level budgets with read-only group rollup; legacy `category` text columns retained this phase. Full ADR + task breakdown in [PLAN8.md](PLAN8.md). |

---

## 12. What "spare no expense" actually costs here

You said spare no expense. Honest answer: **the most expensive thing you can do is pick a paid aggregator (MX/Yodlee/Finicity)** — they're priced for fintech companies, not individuals, and would run $thousands/year. **Avoid.**

If you're willing to spend modestly:

| Splurge | Cost / year | What it buys you |
|---|---|---|
| Plaid Production (vs. Development) | ~$50–150 | Cleaner UX (no Plaid sandbox banner), production webhooks, more institutions |
| SnapTrade for Fidelity | ~$24 (1 connection) | Best-in-class brokerage data, lot-level cost basis |
| RentCast paid tier | $74 | Monthly automated home-value AVM |
| Tiingo paid | $120 | Better intraday data, real fundamentals |
| Hetzner CX22 VPS | ~$60 | Always-on host with webhooks |
| **All splurges together** | **~$330/year** | Still cheaper than Monarch + Empower combined, and **you own the data** |

---

## 13. Recommended Next Step

**All blocking decisions are locked.** Three ADRs (build from scratch, self-hosted web + Postgres, TS/Next/Drizzle stack) plus four directional answers (daily-EOD cadence, full backfill, physical-gold tracking, home-server hosting).

**The plan can now be written.**

`PLAN.md` will use the `plan-writing` skill format and contain:

1. **Phase 0 tasks** — atomic, each with explicit verification criteria. Initialize repo, Docker Compose with Postgres + Redis, Drizzle scaffolding, Next.js 15 boilerplate, Biome config, auth scaffold, first deployment dry-run on the home box.
2. **Phase 1 Drizzle schema** — concrete table definitions matching §6 (with the updated `physical_metal` asset class), plus the first migration.
3. **Phase 1 UI tasks** — manual account creation flows, balance entry, holdings entry (including troy-ounce input for gold), mortgage amortization computation, nightly snapshot cron, single net-worth dashboard.
4. **Dependency graph** — what blocks what; what can be done in parallel.
5. **Verification per task** — `pnpm test`, browser smoke check, or specific DB-query expected output.

Three minor deferred decisions (auth library, chart library, public-exposure model) get resolved inline at the phase that needs them.

After PLAN.md is approved → Phase 0 implementation begins.

---

*End of IDEAS.md*
