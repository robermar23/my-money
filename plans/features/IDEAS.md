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
| ADR-019 | Per-holding historical snapshots (`holding_snapshots`) | **New `holding_snapshots` table**, PK `(holding_id, date)` — `account_snapshots` one level down: `quantity numeric(28,8)`, `value numeric(18,2)`, nullable `cost_basis`, `currency`, one row per position per day, `(date)` index for cross-holding slices. **Written by the existing nightly `compute-snapshots-daily` pass** (which already values every holding), `ON CONFLICT DO UPDATE` for idempotency — zero extra price reads, one logical unit of work at finer grain. A best-effort `run-once` backfill writes `current_qty × latestCloseOnOrBefore(symbol,date)` for each priced date (approximate for pre-deploy dates — past quantity isn't reconstructed; surfaced honestly in the UI). Unpriced securities are skipped, never written at $0. | ✅ Locked 2026-06-20 | Slicing investment value over time by asset class / account / security (Round 3's "historical … per category, per account") needs a daily value per position; account-level snapshots can't break an account into its holdings. Reuses the existing valuation primitive and nightly job. Rejected: transaction-replay at render (slow, blind to manual holdings), `jsonb` blob on `account_snapshots` (can't `GROUP BY`/join). Full ADR + task breakdown in [PLAN9.md](PLAN9.md). |
| ADR-020 | Security enrichment from public market data | **Extend `securities`** with nullable additive columns (`sector`, `industry`, `asset_type` + CHECK, `region`, `expense_ratio`, `dividend_rate` = **forward annual $/share**, `dividend_ex_date`, `fundamentals_refreshed_at` watermark). **Yield is NOT stored** — derived at display as `dividend_rate ÷ price` (§Money: no stale, lossy stored yield). New `yahoo-fundamentals.ts` fetcher reuses the `yahoo-chart` raw-fetch + Zod + retry posture; **only the ticker symbol egresses** (same data category Phase 2/5 already send), `SEC:`/crypto/metals short-circuit. New weekly `refresh-fundamentals-weekly` BullMQ job refreshes null/stale (>7d) securities, idempotent. | ✅ Locked 2026-06-20 | Round 3 "can we bring in any info on the invested assets?" — slicing allocation by sector/industry/region/asset-type + forward-income projection needs metadata securities don't carry. Enrichment, not a new trust boundary. Rejected: separate 1:1 `security_fundamentals` table (over-normalized), stored `dividend_yield` (goes stale on price move), paid fundamentals API (cost; Yahoo's public profile/summary covers it at $0), daily refresh (sector/industry near-static). Full ADR in [PLAN9.md](PLAN9.md). |
| ADR-021 | Performance methodology: TWR, XIRR, attribution, benchmark — all display figures | **Four pure `Decimal`-based functions in `performance.ts`**: value & gain/loss series (from `holding_snapshots`); contributions-vs-market-growth `attribution` (`marketGrowth = (end − start) − netExternalFlows`); money-weighted return `xirr` (Newton–Raphson + bisection fallback); time-weighted return `twr` (chained daily sub-period returns, flow-neutralized). **Benchmark** = `^GSPC` daily closes ride the existing price fetcher (a constant, no new table); `benchmarkTwr` runs the same engine for an overlay. **All read-only display figures** — no tax-lot selection, realized/unrealized *tax* reporting, wash sales, or 1099 (reaffirms the PLAN5/CLAUDE.md boundary). Don't present a return for a range with no real snapshot data — show "insufficient history." | ✅ Locked 2026-06-20 | Round 3 wants performance "historical as well as future"; the real-investor questions ("what did I actually return; was it me adding money or the market; how vs. the market?") are computable from data we already have without crossing the tax-engine boundary. Edge-case-heavy pure functions = highest TDD payoff. Rejected: gain/loss-% only (already shipped), TWR-only (hides personal return), pull returns from Plaid (doesn't compute them), benchmark table (one symbol + constant suffices). Full ADR in [PLAN9.md](PLAN9.md). |
| ADR-022 | Forward-looking views: forward income, income growth, labeled value projection; goal marker scoped | **Forward income** = Σ `held_shares × dividend_rate` (ADR-020) → forward 12-month estimate + per-holding/account breakdown + yield-on-cost (forward income ÷ basis). **Income growth** = Phase 5's `incomeByPeriod` extended to YoY + trailing-12-mo run rate over *actual* received income (history, not a forecast). **Value projection** = deterministic compound `projectValue(currentValue, annualRatePct, years)` at user-chosen 5/7/10%, rendered as a **dashed** segment under a **mandatory unconditional banner** "Projections are illustrative estimates, not financial advice." **Goal/retirement marker capped at a single-target marker** (projected date a target is reached) — **no** Monte Carlo, withdrawal modeling, or multi-goal planner; anything larger is pre-committed to its own future PLAN. | ✅ Locked 2026-06-20 | Round 3 "Future." The strongest forward signal for investments is dividend income (forward rate × held shares is concrete), not a speculative price forecast. The estimate-not-advice labeling is a *requirement* (CLAUDE.md §Domain Scope), enforced in the UI + docs, not optional polish. Rejected: Monte Carlo/probabilistic retirement planning (a planner inside a tracker), forecasting future price (speculative, low-value), skipping the projection (owner explicitly selected it — ship it *with* the guardrail). Full ADR + task breakdown in [PLAN9.md](PLAN9.md). |
| ADR-023 | Personal high-value assets as a `personal_asset` account type | **New `accountTypeEnum` value `personal_asset`** (vehicles, boats, jewelry, collectibles) reusing the existing snapshot/net-worth machinery: value-over-time via `account_snapshots`, net-worth inclusion via `computeNetWorth`/`netWorthSeries` with **zero changes**, and the existing close/reopen/delete lifecycle. **Four nullable additive `accounts` columns** (mirrors the nullable Plaid-column precedent): `asset_category text` + CHECK `IN ('vehicle','watercraft','jewelry','collectible','other')`, `description text`, `acquired_at date`, `acquisition_cost numeric(18,2)`. Value entry reuses the `property` pattern (`recordAssetValueAction`, UPSERT on `(account_id, date)`). `institution` is `NOT NULL`, so the asset flow hides it and the server action defaults it to `'Personal asset'`; the detail/list UIs show the category in that slot. Acquisition-cost vs. current value is a **simple display gain/loss** (existing `gainLoss` helper) — not a tax figure. **No automated valuation, ever** (no KBB/auction/appraisal API — would egress asset data + add a SaaS dependency). | ✅ Locked 2026-06-20 | Round 4 ([IDEAS2.md](IDEAS2.md)): "create an asset that has value that they can change over time and track over time … count towards net worth." The `property` type already does exactly this and `computeNetWorth` aggregates every snapshot-based account uniformly, so a new type is mostly free. Rejected: dedicated `assets`/`asset_valuations` tables (forces compute changes + parallel snapshot machinery + new UI for no functional gain — owner confirmed reuse), reusing `property` (real-estate semantics muddy jewelry labels), modeling as a `holding` (no symbol/quantity — wrong abstraction), auto-depreciation (owner asked for *user-adjustable* value). Full ADR + task breakdown in [PLAN10.md](PLAN10.md). |
| ADR-024 | Proof-of-authenticity documents stored as Postgres `bytea` | **New `asset_documents` table** stores file **bytes as `bytea`** (reuses the `import_batches` `customType`, extracted to a shared `src/db/schema/_bytea.ts`): `account_id` FK `onDelete: cascade`, `filename`, `mime_type`, `size_bytes`, `bytes`, `description`, `uploaded_at`, `(account_id, uploaded_at desc)` index. **`bytea` over filesystem** keeps the single-`pg_dump` backup property — documents ride the existing nightly `age`-encrypted dump (ADR-014), restore unchanged. **Hardened upload** reuses `upload-security.ts` (size cap via `ASSET_DOC_MAX_FILE_BYTES`, default 10 MB; filename sanitize) + a new **magic-byte detector** with a MIME whitelist (`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf`) — **SVG deliberately excluded**, client `Content-Type`/extension never trusted. **Attachment-only authenticated download route** (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, never inline, no CDN). Upload is **optional**. | ✅ Locked 2026-06-20 | Round 4: "upload a file associated with the asset for proof of authenticity." First user-facing document store (the `import_batches.rawFile` bytea is an internal re-parse cache); proof docs (titles, appraisals, photos) are the most sensitive new data class, so storage + serving both need a decision. Rejected: filesystem volume (breaks single-backup; needs a parallel encrypted backup + RESTORE.md change — owner chose bytea), object storage S3/B2/MinIO (SaaS/extra-infra dependency, §Privacy), inline serving / allowing SVG (stored-XSS vector), trusting client `Content-Type` (trivially spoofable). Full ADR + task breakdown in [PLAN10.md](PLAN10.md). |
| ADR-025 | Watchlist / paper positions, structurally excluded from net worth | **New standalone `watchlist_items` table** — a watched symbol is **neither an account nor a holding**, so `computeNetWorth`/allocation/performance (which read only `accounts`/`holdings`/their snapshots) **cannot see it** — net-worth exclusion is structural, needs zero filtering, and can't regress. Columns: `symbol`, `asset_class` (existing `pgEnum`, CHECK-restricted to the fetchable subset `equity`/`crypto`/`physical_metal`), optional `label`, optional **pretend** `(pretend_quantity numeric(28,8)`, `pretend_unit_cost numeric(18,8)`, `pretend_purchased_at date)`, `currency`, `notes`. Constraints: UNIQUE `(symbol, asset_class)`; CHECK the three `pretend_*` are **all-NULL or all-non-NULL** (no half-specified paper buys). **Valuation is read-only on-the-fly** (`pretend_quantity × latestCloseOnOrBefore`), gain/loss via the existing `gainLoss` helper — **no snapshot table** (history *is* the `prices` series). Prices come from the **existing pipeline** (`fetch-prices-daily` unions in `distinctWatchlistSymbols()`, deduped against held symbols); **on-add backfill** seeds `prices` from the pretend date via a new historical daily-series fetch (Yahoo) / CoinGecko `market_chart`. **No new egress class** — only the ticker leaves the box. | ✅ Locked 2026-06-21 | Round 5 ([IDEAS2.md](IDEAS2.md)): "add a stock to track … 'pretend' they purchased it … track its progress … should not count towards net worth." A separate table makes exclusion a property of the data model, not a flag one bug away from a balance error. Rejected: a `holding` with a "paper" flag (pollutes every net-worth/allocation query with "remember to exclude"), `securities` + join table (couples to the Plaid-securities graph; watch items are often hand-typed), nightly snapshot of watch value (pure bloat — not net worth; compute on read), watching cash/property classes (nothing to price — CHECK'd out). Full ADR + task breakdown in [PLAN11.md](PLAN11.md). |
| ADR-026 | Price-target alerts: one-shot, reuse the alert system, daily after the price fetch | **New `price_targets` table** (FK → `watchlist_items` `onDelete: cascade`): `direction` CHECK `('above','below')`, `threshold numeric(18,8)`, `active boolean`, `triggered_at`/`triggered_price`, optional `note`; index `(watchlist_item_id)` + partial index on `active = true`. **One-shot semantics** — fires once when the latest close satisfies the direction (`above` ⇒ `close ≥ threshold`; `below` ⇒ `close ≤ threshold`), writes an `alerts` row and sets `active=false`; user re-arms manually. `'price_target'` is **added to the `alerts` type CHECK** but **NOT** to `RULE_ALERT_TYPES` (exempt from the anomaly resolve-sweep, like `backup_failure`). **Pure rule** `priceTargetAlerts(targets, latestPrices)` (Money/Decimal compare; title carries symbol + direction only, figures in `detail` per ADR-015) + a thin `evaluate-price-targets` job that reuses the content-free `notifyNewAlerts`. **Cadence: once daily, chained off `fetch-prices-daily`** so it sees the freshest close with no race. **Real-time/intraday alerting deferred** (env-gated future Open Item). | ✅ Locked 2026-06-21 | Round 5: "get alerted when the stock/metal/whatever reaches a specific value, up or down." Reuses the complete Phase-6 alert system (ADR-015): `/alerts` primary, content-free email doorbell, dedup-by-hash. Rejected: real-time polling/websocket feed (continuous egress + rate-limit + streaming dependency for marginal single-user value — intraday deferred), folding into `detect-anomalies-daily` (that owns the 05:00 resolve-sweep; targets are one-shot and depend on the 01:30 fetch), recurring/re-arming targets (nightly nagging while parked past threshold; manual re-arm is calmer), SMS/push/SaaS alert channels (new egress; the self-hosted SMTP doorbell already satisfies §Privacy), threshold/price in the alert **title** (violates ADR-015 — numbers live in `detail`). Full ADR + task breakdown in [PLAN11.md](PLAN11.md). |
| ADR-027 | Two-tier search: a global ⌘K command palette **plus** URL-param per-list filters, both server-rendered, no client state store | Round 6 spans two distinct UX needs: (a) "jump to a known thing from anywhere" and (b) "narrow the list I'm looking at." **(1) Global command palette (⌘K / Ctrl-K)** — one thin client island mounted once from `AppNav`, debounces input (250 ms) and `fetch`es an **internal, session-guarded** route handler `GET /api/search?q=…` returning **grouped, capped** results (≤5 accounts/categories/securities/watchlist items, ≤8 transactions across all accounts); selecting **navigates** (`router.push`) — it **never mutates**. **(2) Per-list filters via URL `searchParams`** — each growing list page reads filter state from the URL (server component) → query; no Zustand, no client filter store (the URL *is* the saved search → no saved-search table). **(3) Transaction search is the heavyweight** — full structured filters (free text on `name`/`memo`, amount min/max, date from/to, category incl. "Uncategorized", **all-accounts** mode), shared by the per-account list and a **new cross-account `/transactions` page** via one refactored `listTransactions` helper. **(4) The route handler is internal/read-only** — same-origin, `requireUser()`-guarded, `q` never logged (§Privacy). | ✅ Locked 2026-06-28 | Round 6 ([IDEAS2.md](IDEAS2.md)): "search for things on every page … transactions/items add up quickly over time." One mechanism can't serve both "jump" and "narrow" without one contorting the other; owner confirmed **both**. Rejected: single global box that also drives the transaction table (conflates jump/narrow; URL/pagination fights the modal), client-side filtering (ships 10k+ rows to the browser — §Performance: never render 10k DOM nodes), persisted saved searches / search history (YAGNI for one user; stores *what the user looks for* at rest; the URL is the saved search), Zustand filter store (loses shareable/refresh-stable URLs — ADR-003 + §Architecture: server components + URL params first). Full ADR + task breakdown in [PLAN12.md](PLAN12.md). |
| ADR-028 | Postgres `pg_trgm` trigram matching with GIN indexes — fuzzy, typo-tolerant, fast on large transaction sets | Search must stay fast and forgiving as transactions grow to five/six figures over years of imports (the exact pain Round 6 names). **(1) Enable `pg_trgm`** via `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (drizzle-kit `generate` doesn't emit it — hand-prepend to the generated migration). **(2) Trigram GIN indexes** on the searched columns (`transactions.name`/`memo`, `accounts.name`/`institution`, `securities.symbol`/`name`/`ticker_symbol`, `categories.name`, `watchlist_items.symbol`/`label`), each `USING gin (col gin_trgm_ops)`, declared in the Drizzle schema so it stays source-of-truth. **(3) Matching** — case-insensitive substring `ILIKE '%term%'` (now GIN-backed) for the predicate, `similarity(col, term)` for **ranking** the palette's capped groups; a helper sanitizes/escapes the term (strip `%` `_` `\`, collapse whitespace, length-cap), parameterized via Drizzle's `sql` template — never raw concatenation. **(4) Threshold** left at default; ranking uses raw `similarity()` ordering, not a `%`-operator cutoff, so short/rare terms still match via `ILIKE`. | ✅ Locked 2026-06-28 | Round 6: search has to be fuzzy (`amazn`→`Amazon`) and fast at scale on messy payee strings + short tickers. Owner chose trigram. Rejected: plain `ILIKE` no extension (no typo tolerance; leading-wildcard seq-scans degrade as the count grows), Postgres FTS `tsvector` (word/stemming-oriented; weak on partial tokens/tickers/payee fragments; heavier setup for worse domain fit), external engine Elastic/Typesense/Meilisearch/Algolia (ships payees + balances off-box or adds a whole service for one user — §Privacy + YAGNI), LLM/embedding "semantic" search (sends financial text to a model — §Privacy hard-no). Zero new dependency, zero egress — it's core Postgres contrib. Full ADR + task breakdown in [PLAN12.md](PLAN12.md). |
| ADR-029 | Curated, server-rendered dashboard of reusable "card" sections that **reuse existing compute functions**; one shared `?range=` control; no customization, no persistence, no new metrics | Round 7 ([IDEAS2.md](IDEAS2.md)) asks "what can/should we add to the dashboard given everything we've shipped." **(1) Curated fixed sections** — a hand-designed responsive layout: a full-width **net-worth hero** (value + range delta + history chart), then a responsive **card grid** (allocation, performance, spending-vs-budget, forward-income, alerts, watchlist-movers, and a reserved slot for PLAN14's savings-rate card). **No drag/drop, no per-widget config, no saved-layout table.** **(2) Cards are dumb; the loader is smart** — every card is a server component fed already-computed typed data from a single `loadDashboard(range)` in `src/lib/dashboard/`; a card **never** queries the DB or computes a financial figure (CLAUDE.md §Architecture), so the dashboard's numbers are **identical by construction** to the dedicated pages (same function, same result). **(3) One shared `?range=` URL param** (`1M`/`3M`/`6M`/`1Y`/`YTD`/`ALL`, default `1Y`) drives the time-series cards (hero history + performance) via a thin client toggle; point-in-time cards (allocation/budget/income) intentionally ignore it. **(4) Charts reuse the existing Recharts islands** (ADR-005/013) — no new chart types or deps. **(5) Graceful degradation** — each card renders an empty/insufficient state when its inputs are absent (no holdings ⇒ allocation/performance/income show "add an investment"; no snapshots in range ⇒ performance shows "insufficient history" per ADR-021). **100% additive, read-only, zero-egress: no new tables, no migration, no outbound HTTP.** | ✅ Locked 2026-06-28 | Round 7: the dashboard hasn't moved since Phase 1 while Phases 2–12 added allocation, a TWR/XIRR engine, forward income, budgets, alerts, a paper watchlist, and search — none visible on landing. Owner confirmed a **curated fixed layout** (not a customizable widget grid) with the four highest-value cards on top of the net-worth hero. Rejected: customizable/draggable widget grid + saved layout (persistence table + client DnD dep + reset/migration logic for one user who can edit the source — YAGNI), cards computing their own numbers (scatters business logic into the UI, risks the dashboard disagreeing with the dedicated pages), embedding a BI tool/Grafana/Metabase pointed at Postgres (ships financial data into a second service + new infra — §Privacy; the app already *is* the dashboard), one mega time-range that also re-aggregates budgets/allocation ("this month's budget" and "current allocation" aren't range-parameterized — confuses semantics for no gain). Full ADR + task breakdown in [PLAN13.md](PLAN13.md). |
| ADR-030 | Income & retirement-contribution model: `income_sources` (the paycheck) + `retirement_contributions` (the 401k rule) + `income_contributions` (the materialized ledger) | Round 8 ([IDEAS2.md](IDEAS2.md)) needs three distinct things stored — *what the paycheck is*, *the rule that turns a paycheck into a 401k contribution*, and *the record that a specific period's contribution happened* — so **three additive tables** (UUID PKs, `timestamptz`, `numeric` money-as-string per CLAUDE.md §Money). **(1) `income_sources`** — `name`, `cadence` text+CHECK ∈ `('weekly','biweekly','semimonthly','monthly')`, `gross_per_period numeric(18,2)`, `currency` (default USD), `anchor_date` (a known real pay date phasing the schedule), `active`, `start_date`, optional `end_date`, `notes`. **(2) `retirement_contributions`** — the rule attached to a source: `income_source_id` FK (cascade), `account_id` FK → the `investment` (401k) account, **optional** `holding_id` FK → the position it buys (null ⇒ basis-only, ADR-031), `employee_basis` text+CHECK ∈ `('percent','amount')` + `employee_value numeric(18,4)`, `pretax boolean` (**a label only — drives no tax math**), and a **single-tier employer match**: `match_basis` text+CHECK ∈ `('none','percent_of_gross','percent_of_contribution','amount')`, `match_value numeric(18,4)`, nullable `match_cap_percent numeric(7,4)` (cap as % of gross), `active`. **(3) `income_contributions`** — the materialized ledger, one row per rule per pay date: `retirement_contribution_id` FK (cascade), `pay_date`, `gross_amount`/`employee_amount`/`employer_amount numeric(18,2)`, nullable `investment_transaction_id` + `holding_lot_id` FKs (`set null`), **UNIQUE `(retirement_contribution_id, pay_date)`** — the idempotency key. **Zero change to `investment_transactions`/`holding_lots` schema.** text+CHECK (not `pgEnum`) matches the `transactions.source`/`holding_lots.source` posture. | ✅ Locked 2026-08-09 | Round 8: "the 'cost basis' would be the amount of income they invest in their 401k every paycheck … can the user not define their 'income' in an intentional way?" Lifting "define income" into scope is justified exactly as ADR-018 lifted budgets: the **owner explicitly asked** (recorded in [FEATURE.md](FEATURE.md)). Multiple sources, mid-year rule changes, and per-period idempotency all fall out of separate tables. Rejected: one `income` table with the rule inlined (can't represent two sources, a mid-year rule change, or per-period idempotency; the materialized ledger needs its own rows regardless), a passive `account.contribution_setting` with no tables (derives a *synthetic* basis but builds no real lots — gain/loss, TWR, allocation wouldn't reflect actual acquisitions and there'd be no audit trail; the owner chose auto-contributions), a full paycheck model with net pay/withholding/deductions (payroll+tax engine — CLAUDE.md §Domain Scope hard no; we store gross + contribution and nothing about taxes), multi-tier match formula engines (single-tier + cap covers "match up to X%"; tiered is an Open Item), pulling real payroll from ADP/Gusto/Plaid-payroll (new egress + defeats the "intentional" framing — §Privacy). Full ADR + task breakdown in [PLAN14.md](PLAN14.md). |
| ADR-031 | A scheduled job materializes each due contribution into the **existing** investment ledger as a `buy` + cost-basis lot (priceable) or a basis-only increment (unpriceable); idempotent by `(rule, pay_date)`; run-once backfill | ADR-030 stores the *rule*; something must turn "biweekly, 6% of $4,000, 50% match up to 4%" into real cost basis. **(1) A BullMQ repeatable job `materialize-contributions`** (daily, **chained after `fetch-prices-daily`** so the pay-date close is fresh — same posture as `evaluate-price-targets`) expands each active rule's pay schedule to today and, for every pay date **not already in `income_contributions`**, computes employee + employer dollars (Decimal) and writes either: **priceable holding** (`holding_id` set and `latestCloseOnOrBefore(symbol, pay_date)` exists) ⇒ an `investment_transactions` row `type='buy'`, `source='income'`, `quantity = dollars ÷ close`, `price = close`, `amount = dollars`, plus a `holding_lots` row via the existing `lotFromBuy` with `source='income'`, `cost_basis_total = dollars`; or **basis-only** (`holding_id` null or symbol unpriceable) ⇒ `type='cash'`/`subtype='deposit'` + a lot carrying `cost_basis_total` with quantity left to the user's manual entry. **(2) Idempotent by design** — the UNIQUE `(rule, pay_date)` short-circuits re-runs (`ON CONFLICT DO NOTHING`) and the buy + lot + ledger row are written in **one DB transaction** so a partial failure can't orphan a lot. **(3) Run-once `backfill-contributions`** walks each source from `start_date`/`anchor_date` to today (same unique key; basis-only fallback for pre-price-history dates). **(4) Savings rate is derived, not stored** (`annual_employee ÷ annualized_gross`, computed on read — same principle as ADR-020's "don't store yield"). **(5) Reconciliation, not enforcement** — the job writes/reads **only** `source='income'` rows and never touches `plaid`/`manual` rows; the account view splits "contributions (defined)" from "synced" and the docs warn against enabling both on one holding. **No new egress class** — the only outbound call on any contribution path is the *existing* price fetch for an already-held symbol. | ✅ Locked 2026-08-09 | Round 8: making a contribution **look exactly like a buy** means the whole existing machinery (ADR-012 cost-basis precedence, ADR-019 snapshots, ADR-021 TWR/XIRR — which already consumes external flows) lights the 401k up with **zero special-casing**. Real 401k plans split into public-ticker funds and opaque institutional funds; the basis-only branch serves the latter without blocking on a share price we don't have. Rejected: materializing at render time with no stored rows (re-deriving the schedule every page load is slow and leaves no audit trail or idempotency key; snapshots want real rows), always requiring a priceable holding (excludes the common opaque-fund 401k — the ask is about *basis*, trackable without a price), incrementing `holdings.cost_basis` directly and skipping lots (loses per-contribution granularity + the acquisition date XIRR/TWR need; `resolveCostBasis` already prefers lots), a separate "retirement" valuation path (reinvents the snapshot/gain-loss engine for one account type — reuse is the whole point). Known risk: double-counting if Plaid and an income rule fund the same holding — mitigated by source-scoping + a soft UI warning; a hard guard is an Open Item. Full ADR + task breakdown in [PLAN14.md](PLAN14.md). |
| ADR-032 | Household money guidance as a **deterministic, local rules engine**: recommend *structures and amounts*, **never products**; derived rungs, not user-authored goals | Round 9 ([IDEAS2.md](IDEAS2.md)) is the first round that asks the app to be **prescriptive** ("recommend budgets… how much to save… how much to keep on hand"). **(1) A pure rules engine in `src/lib/advice/`** — every rule is an I/O-free function `(AdviceInput) => Recommendation[]`; a single `loadFinancialSnapshot()` assembles all inputs (ADR-029's "loader is smart, cards are dumb", applied to advice). **(2) Deterministic and explainable, never a model** — CLAUDE.md §Privacy bans hosted LLMs, so each `Recommendation` carries `{ id, severity, title, rationale, benchmark, currentValue, suggestedValue, inputsUsed[], confidence }` and **names the heuristic it implements**; the UI shows the inputs so the user can audit and correct them. **(3) Computed on read, never stored** (same principle as ADR-020's unstored yield and ADR-031's derived savings rate); the *only* persisted advice state is `recommendation_dismissals` (dismiss/snooze), so the app doesn't re-nag a consciously rejected item. **(4) The product boundary** — recommend a *structure and an amount* ("a 4-rung ladder for the $18k above your reserve"), **never a security, fund, institution, or product** ("buy VOO at Vanguard"); no tax computation (`accounts.tax_treatment` describes the *container*, it drives no tax math — reaffirms ADR-030's "`pretax` is a label only"). **(5) Mandatory unconditional disclaimer**, stronger than ADR-022's projection banner, on every advice surface. **(6) Waterfall rungs are DERIVED STATE, not goals** — the user cannot create, name, reorder, or fund a rung; every target is computed from their own data. **ADR-022's rejection of a multi-goal planner therefore stands unamended.** | ✅ Locked 2026-08-15 | Round 9: "can it now *recommend* some things… help the user manage their money… based off standard, well-known best practices for family/household money." Owner selected the **full waterfall including debt payoff**. Determinism is a feature, not a constraint: pure functions are Vitest-able (an always-test surface — money math driving user decisions), offline, and auditable in a way a model never is. Rejected: an LLM/"AI advisor" over financial data (§Privacy hard-no, and unauditable); storing generated recommendations (staleness with no upside — recompute is cheap); recommending specific tickers/funds/institutions (crosses from structure into advice, and this is a tracker); amending ADR-022 to permit goals (an amendment should record a genuine change of mind, not paper over a scope question with a cleaner structural answer — derived rungs simply aren't the planner ADR-022 rejected); silent recommendations with no shown inputs (unfalsifiable numbers are worse than none). Full ADR + task breakdown in [PLAN15.md](PLAN15.md). |
| ADR-033 | Prerequisite schema for guidance: account `subtype`/`apy`/`maturity_date`/`tax_treatment`, `categories.necessity`, a new `credit_lines` table, `household_profile` + `household_members`, `recommendation_dismissals` — **manual-first debt terms** | Round 9's specific asks are each blocked on data the app has never modeled. **(1) `accounts`** gains four nullable additive columns (the nullable-Plaid/personal-asset precedent): `subtype` text+CHECK ∈ `('checking','savings','money_market','cd','cash_management')` — **without it, checking vs. savings vs. CD is indistinguishable and "how much on hand vs. medium-term" is unanswerable**; `apy numeric(7,4)`; `maturity_date date` (CDs); `tax_treatment` text+CHECK ∈ `('taxable','tax_deferred','roth','hsa')` — describes the container for waterfall *ordering* only. **(2) `categories`** gains `necessity` text+CHECK ∈ `('essential','discretionary','savings')` (nullable = unclassified) — emergency funds size against **essential** expenses, not total spend — plus `excluded_from_baseline boolean` so a stray refund category can be kept out of the observed-net-income baseline. **(3) A new `credit_lines` table** (`account_id` FK UNIQUE, `apr`, `credit_limit`, `minimum_payment`, `minimum_payment_percent`) for revolving terms — **`liabilities` is left untouched**. **(4) `household_profile`** (singleton: reserve-months override, retirement target age, benchmark savings APY, needs/wants/savings split overrides) **+ `household_members`** (`label`, **`birth_year`** — not a birth date, `is_dependent`). **(5) `recommendation_dismissals`** (`rule_id`, `subject_key`, `dismissed_at`, `snooze_until`, UNIQUE on the pair). **(6) Debt terms are manual-first** — APR/limit/minimum are user-editable columns; Plaid `/liabilities/get` is **not** enabled. All new PII rides the existing `age`-encrypted `pg_dump` (ADR-014) and is **excluded from the ⌘K search index** (ADR-027/028). | ✅ Locked 2026-08-15 | Round 9; owner selected **prerequisites in scope** and a **member list with ages**. Rejected: adding revolving columns to `liabilities` (its `principal_at_origination`/`term_months`/`start_date` are `NOT NULL` and meaningless for a card — would force `DROP NOT NULL` on a working table for no gain; a separate table is purely additive and the payoff engine unions them in a helper); `pgEnum` for `subtype`/`necessity`/`tax_treatment` (project posture is text+CHECK for evolvable vocabularies — `transactions.source`, `holding_lots.source`, ADR-030's `cadence`); storing full birth dates (birth *year* drives every age-based rule with strictly less PII at rest); **enabling Plaid Liabilities** (it *is* free on Plaid's Trial plan and Liabilities is listed among its products — but it is a **per-Item subscription-fee product** billed on any paid plan, it needs existing Items re-linked through update mode with an added product, and it would still not cover manual accounts the engine must serve anyway; three rarely-changing numbers per card typed once is less effort — deferred as an optional pre-fill, Open Item); fetching live CD/HYSA rates (new egress + staleness for marginal gain — a **user-entered benchmark APY** answers "what yield am I forgoing" with zero egress). Full ADR + task breakdown in [PLAN15.md](PLAN15.md). |
| ADR-034 | Benchmark methodology: **observed** net income from income-kind transactions, a median-based essential-expense baseline, a fixed waterfall ordering, **year-keyed** statutory constants, and per-rule minimum-history gating | The rules are only as honest as their inputs. **(1) Take-home is OBSERVED, not declared** — summed from `transactions` in `kind='income'` categories (minus `excluded_from_baseline`): the deposits that actually landed **are** take-home, so no tax math is needed and **ADR-030's gross-only boundary is untouched**. **(2) Exactly ONE savings rate exists** — the shipped gross-based figure (ADR-031 §4). Observed net is used *only* as the 50/30/20 denominator and a reserve input, under a different name, because pre-tax 401k dollars never appear as a deposit and a second net-based rate would visibly contradict the first. **(3) Baselines use the MEDIAN (or p75), not the mean** — deliberately unlike [forecast.ts](../../src/lib/analytics/forecast.ts), whose trailing mean is right for forecasting and wrong for budget-setting (one $2,000 repair permanently inflates the target). **(4) A fixed waterfall ordering**: starter buffer → **employer match** → high-interest debt → full 3–6mo reserve → IRA/HSA → 401k to the statutory cap → taxable/medium-term. Each rung reports done / in-progress / blocked / **unknown-input**. **(5) Statutory constants are YEAR-KEYED** (`limitsForYear(year)`) and **return `null` when unconfigured**, suppressing that rung with "limit not configured for YYYY" rather than silently applying last year's dollars. **(6) The high-interest threshold is a visible, user-tunable default**, not a magic number. **(7) Every rule declares `minMonthsHistory`** and renders ADR-021's "insufficient history" instead of a confident wrong number. | ✅ Locked 2026-08-15 | Round 9; owner selected **derive net income from income transactions**. The observed-deposit definition is the one path to household benchmarks that doesn't reopen ADR-030 or build a tax engine. Auditability over cleverness: rather than heuristically detecting bonus/refund outliers, the UI **lists the contributing categories** and lets the user exclude them — same philosophy as showing each recommendation's `inputsUsed[]`. Rejected: an optional `net_per_period` column on `income_sources` (reopens ADR-030's "gross and nothing about taxes", and goes stale at every raise); a second net-based savings rate (two rates that disagree read as a bug even when both are correct); trailing **mean** baselines (outlier-fragile for target-setting); hardcoding a single year's IRS limits (silently wrong every January); auto-detecting recurring/fixed expenses to derive essentials (`categories.necessity` is explicit and correctable — a detector is an Open Item). Known limitation: the model assumes a steady paycheck; variable/self-employed income is a stated assumption, not a solved case. Full ADR + task breakdown in [PLAN15.md](PLAN15.md). |
| ADR-035 | Navigation: a **grouped top bar of disclosure menus** driven by a single **nav manifest**, plus a per-section sub-nav strip and page results in ⌘K — no sidebar | The flat bar in [nav-menu.tsx](../../src/components/nav-menu.tsx) carries **12 links + search + sign-out in a `max-w-5xl` row** (~1,010 px of content in a 1,024 px container) and every phase has appended to it; meanwhile **7 real destinations** (`/analysis/budgets`, `/analysis/review`, `/investments/performance`, `/investments/forecast`, and the watchlist/connections sub-flows) are reachable **only** from ad-hoc inline links inside page bodies. **(1) One manifest, four consumers** — `src/lib/nav/manifest.ts` is the single source of truth (`NavGroup[]` of `NavItem`s: `href` as a typed `Route`, `label`, `description`, optional `match[]` prefixes, `exact`, `badge` slot). It imports **neither React nor `next/navigation`**, so the top bar, the mobile accordion, the section strip, and the `GET /api/search` route handler all read the same data. **Adding a destination edits one file and nothing else** — the chrome components are never touched again. **(2) Five groups, capped at six** — Dashboard · Accounts · Investing · Planning · Settings, with Search/Alerts/Account as right-aligned *utilities*, not group members (alerts are a notification, so the badge stays permanently visible rather than hiding one level down). A **seventh group means the taxonomy is wrong**, not that the bar needs another slot. **(3) Two levels, no third** — group menus cap at ~7 items; each section's `layout.tsx` renders a `SectionNav` strip of that group's siblings, which persists across in-section navigation. Beyond that depth the answer is a section landing page, never a deeper menu. **(4) Longest-prefix active resolution** in four pure, I/O-free functions (`resolveActive`, `sectionItemsFor`, `isCurrent`, `allDestinations`) — so `/investments/performance` beats `/investments`, `/analysis/category/[id]` resolves to Overview and not Budgets, and `'/'` is `exact` (it would otherwise win every path). The **resolvers** get Vitest coverage; the dropdown chrome does **not** (CLAUDE.md §Testing: pure UI is sparingly tested). **(5) Manifest membership is MANDATORY, and a test enforces it** — a guard globs `src/app/**/page.tsx` and fails when a page resolves to no group. Every manifest destination is also prepended to ⌘K as a new `page` result kind, matched **locally and synchronously** (no query, no `pg_trgm`), so nothing is ever more than one keystroke away no matter how deep the menu puts it — the escape hatch that makes the hierarchy safe. **(6) ARIA *disclosure navigation*, never `role="menubar"`** — these are links, not application menu items; `menubar` would oblige roving tabindex, typeahead, and arrow wraparound while making screen readers announce navigation as a menu. `Esc` returns focus to the trigger, one group open at a time, `aria-current="page"` on the active link. **(7) Zero new dependencies and zero page-body edits** — the disclosure is ~40 lines, so Radix/Headless UI are declined on the same grounds as ADR-006/009/013. | ✅ Locked 2026-08-23 | Owner asked to rethink the bar because "we have too many options to fit" and it "needs to scale so we can add more features over time." Both halves are answered by *where the list lives*, not by how it is styled: the overflow is a symptom, the manifest is the cure. **Rejected: a left sidebar** — the right answer for a large IA and the wrong one here, because all 29 pages center themselves with their own `max-w-*` (19 × `max-w-3xl`, 12 × `max-w-5xl`, plus one-offs), so adopting it means rewriting the container on every page and the root layout to show the same 19 destinations the grouped bar shows for free. It is recorded as the **designated upgrade path** if the taxonomy ever exceeds six groups, so the decision is not re-litigated from scratch. **Rejected: a flat bar + a "More" overflow menu** — the cheap fix and a trap: `More` carries no meaning, so every future feature lands in it and discoverability ends up worse than today (a 12-item unlabelled dropdown instead of a 12-item bar). **Rejected: a mega-menu panel** (over-built for 19 destinations); **palette-only navigation** (undiscoverable in an app used weekly, and there is no ⌘K on a phone); **breadcrumbs** (two nav levels plus a breadcrumb is redundant at this depth — `breadcrumbFor()` is a ~20-line follow-up once a third level exists). **Deliberately unamended**: ADR-027's palette is **read-only, never mutating**, so `page` results are jump targets only — "Add account"-style *commands* would reopen that ADR and are deferred. Full design, component spec, and NAV-01…NAV-13 task breakdown in [PLAN_NAV.md](PLAN_NAV.md). |
| ADR-036 | Cash-flow timing as a first-class dimension: **detect-and-confirm** scheduled obligations, never auto-commit; **one** occurrence-expansion implementation shared with income | Round 10 ([IDEAS3.md](IDEAS3.md)) asks the most-common household money question — *"can I spend $400 on the car repair this week, or does something bounce?"* — which the app cannot answer **in principle**, not merely in implementation: every figure it produces is a **stock** (balance, net worth, allocation, basis) or a **rate** (savings rate, monthly spend, APR, TWR), and almost none is a **date**. **(1) Detection schedules; it does not classify — and PLAN15 is reaffirmed, not reversed.** [PLAN15.md](PLAN15.md) §Open Items deferred recurring detection because "`categories.necessity` is explicit and correctable; a merchant-cadence detector is guessing where an answer exists." That stands: `necessity` answers *"is this essential?"* — a **classification**. Round 10 asks *"when does it land, and for how much?"* — a **timing** question on an orthogonal axis that `necessity` cannot answer at any level of classification quality. A confirmed obligation **inherits** its `category_id` and changes no category's `necessity`. **(2) Detection proposes; the user disposes** — the detector emits **candidates** and writes **zero** `scheduled_obligations` rows; confirmation is an explicit action through the shipped [analysis/review](../../src/app/analysis/review/) idiom. This is CLAUDE.md §Importers' *"never silently mutate… require a click"* applied to a second inference surface, and the stakes are higher than an import row because an invented obligation lands inside a number the user spends against. **(3) Manual entry is first-class, not a fallback** — the bills that hurt most (a premium from an untracked account, tuition on a payment plan, a quarterly estimated payment) never touch a tracked account; manual and confirmed-detected obligations are indistinguishable downstream except by `source`, for provenance. **(4) The projection is computed on read and never stored** — same principle as ADR-020's unstored yield, ADR-031's derived savings rate, and ADR-032 §3's unstored recommendations; a stored projection goes stale the moment a transaction posts. The **only** persisted state is the obligation record and its occurrence rows, which are facts about a schedule rather than derived figures. **(5) Exactly one occurrence-expansion implementation** — `payDatesBetween` is generalized into a shared `occurrenceDatesBetween` and income **delegates** to it; obligations get no parallel copy. ADR-031's "one savings rate, one implementation" applied to date math, with identical stakes: a second copy is a second place for a clamping or DST bug to be fixed in only one of them. **(6) Safe-to-spend is a derived floor-adjusted low-water mark, not a budget** — `min(projected closing balance over the horizon) − cash_floor`, clamped at zero. It allocates nothing, reserves nothing, moves nothing; it **reports the worst point of a projection**, which is why it is compatible with §Domain Scope's exclusion of envelope budgeting. **(7) The projection line is single and deterministic** — no confidence bands, no fan chart, no distribution. ADR-022's rejection of probabilistic modeling applies here identically; uncertainty is expressed as **stated inputs the user can see and correct** (ADR-032 §2's auditability contract), never as shading that implies rigor the model does not have. | ✅ Locked 2026-08-23 | Round 10 is the **owner's explicit ask**, recorded in [FEATURE.md](FEATURE.md) — the same grounds on which ADR-018 lifted budgets, ADR-030 lifted income, and ADR-032 lifted guidance. The phase is unusually **assembly-heavy**: `payDatesBetween`, `observedNetIncome`, `forecastMonthlySpend`, `classifyCashTiers`, and `account_snapshots` already exist; the genuinely new code is a detector, a projection engine, and one table. Rejected: **auto-creating obligations from high-confidence detections** (puts inferred rows into a spending decision — precisely the class of mistake §Importers' preview→confirm posture exists to prevent); **manual entry only, no detection** (the data is already there, and hand-entering twenty recurring bills is the reason nobody would ever turn the feature on); **a hosted biller/merchant-enrichment API** (§Privacy hard-no — it ships the user's payee list to a third party, and local string work over the user's own data is sufficient for periodicity); **storing the daily projection nightly** (stale within hours of any posted transaction; recomputation is a few hundred Decimal ops over an in-memory event list); **modeling obligations as `liabilities` rows** (a liability is a principal balance that amortizes — a $14 subscription is not one, and `liabilities` has `NOT NULL` columns meaningless for it, the same reasoning that produced a separate `credit_lines` in ADR-033 §3); **copying `payDatesBetween` and extending the copy**; **a probability band** (ADR-022 stands). Known limits, stated not hidden: projection quality is **bounded by obligation coverage** and must say so rather than present a thin projection as a complete one; detection will miss variable-amount bills and mis-group payees whose descriptor string changes — **recall is not the goal, precision plus an easy manual path is**, because a missed bill is an annoyance and an invented bill is a defect. Full ADR + P16-00…P16-38 task breakdown in [PLAN16.md](PLAN16.md). |
| ADR-037 | Schema for the calendar dimension: a `scheduled_obligations` table with **materialized** `obligation_occurrences`, an obligation cadence vocabulary **wider than income's**, and two `household_profile` settings | An obligation needs a schedule, an expected amount, an account, and a provenance trail back to the transactions that suggested it. Occurrences must be **matched against reality** so the app can say "the mortgage did not post" — and a match needs somewhere idempotent to live. Phase 14 solved a structurally identical problem for pay dates; that answer is reused, not re-litigated. All changes are **additive**; no existing `NOT NULL` column is touched. **(1) `scheduled_obligations`** — `id uuid pk`, `account_id` FK → `accounts` (cascade), `category_id` FK → `categories` (set null, nullable), `label text not null`, `expected_amount numeric(18,2) not null` (**positive magnitude**; sign carried by `direction`, with a non-negativity CHECK), `direction text` CHECK ∈ `('outflow','inflow')`, `currency text default 'USD'`, `cadence text` CHECK ∈ the §3 vocabulary, `anchor_date`/`start_date date not null`, `end_date date` (nullable = open-ended), `active boolean default true`, `amount_mode text default 'fixed'` CHECK ∈ `('fixed','trailing_median')`, `source text` CHECK ∈ `('detected','manual')`, `detection_key text` (the normalized payee that produced it; nullable for manual), `confidence text` CHECK ∈ `('high','medium','low')` nullable, `notes text`, timestamps. A **partial** UNIQUE index on `(account_id, detection_key) where detection_key is not null` — one payee series cannot be confirmed twice, while unlimited manual obligations stay legal. **(2) `obligation_occurrences`** — `id`, `obligation_id` FK (cascade), `due_date date`, `expected_amount numeric(18,2)` **snapshotted at materialization**, `status text` CHECK ∈ `('scheduled','matched','missed','skipped')`, `matched_transaction_id` FK → `transactions` (set null, nullable), `matched_amount`, `matched_at`, `created_at`. **UNIQUE `(obligation_id, due_date)`** is the idempotency key, exactly mirroring `income_contributions`' UNIQUE `(rule, pay_date)` from P14-09; index on `(due_date, status)` for the projection scan and the miss sweep. **(3) A wider cadence vocabulary for obligations than for income** — `income_sources.cadence` stays exactly `('weekly','biweekly','semimonthly','monthly')` and its CHECK is **not touched**, so `periodsPerYear` keeps its four-member map; `scheduled_obligations.cadence` is that set **plus** `('quarterly','semiannual','annual')`. Both expand through the same shared function (ADR-036 §5); the two vocabularies are separate `const` tuples with `ObligationCadence` a **declared superset** of `IncomeCadence`, enforced by a compile-time assertion so neither can silently diverge. **(4) Two settings on the existing `household_profile` singleton**, not a new table: `cash_floor numeric(18,2)` (NULL = 0) and `projection_horizon_days integer` (NULL = the 60-day default) with a NULL-tolerant 14–365 range CHECK. **(5) Occurrences are materialized forward on a schedule, not computed on read** — a deliberate copy of P14-09, buying the same three things: the miss sweep has rows to sweep, a match has somewhere to live, and a re-run is a **provable** no-op via the UNIQUE key. **(6) Occurrence-to-transaction matching is recorded, never inferred at read time** — a match is a durable fact with a timestamp; recomputing it per page load would let a match flicker as surrounding data changes. **(7) Text+CHECK, not `pgEnum`**, for every vocabulary here — consistent with `transactions.source`, `holding_lots.source`, ADR-030's `cadence`, and ADR-033 §2's `subtype`. | ✅ Locked 2026-08-23 | Round 10 needs a durable substrate or the miss/drift alerts become recomputed guesses. Entirely additive: no `DROP NOT NULL`, no data movement, no risk to shipped income or mortgage code, and the occurrence table mirrors a pattern already proven in production by the income materializer — including its idempotency story. Rejected: **no occurrence table, expand dates on read** (then a match, a skip, and a miss have nowhere to live and "the mortgage did not post" flickers — P14-09 already answered this); **one cadence vocabulary shared by income and obligations** (a quarterly *paycheck* is not something this app models, and widening `income_sources.cadence` would put `periodsPerYear` — the savings-rate annualizer — one careless edit away from a wrong denominator on a shipped number); **signing the amount instead of a `direction` column** (sign conventions already differ between `transactions.amount` and display; a signed "expected amount" invites a sign bug in the most expensive possible place); **a new `cashflow_settings` table** (`household_profile` is the established singleton for this class of setting per ADR-033 §4 — a second settings table is pure sprawl); **storing the matched flag on `transactions`** (pollutes a core table with a Phase-16 concern and inverts the relationship — the occurrence is the thing being tracked). Two stated consequences: both tables are **empty until the user confirms something**, which is why Batch 5's confirm flow and Batch 7's empty states are in the same phase rather than deferred; and snapshotting `expected_amount` onto each occurrence means **editing an obligation does not rewrite past occurrences** — the intent, but it must be said in the UI or an amount edit will look like it silently failed. Full ADR + task breakdown in [PLAN16.md](PLAN16.md). |
| ADR-038 | Projection methodology: obligations **plus a residual discretionary rate, never double-counted**; inflows from **observed take-home** phased by the pay schedule; a stated horizon and floor; and honest, quantified degradation when coverage is thin | A daily balance projection is trivial to write and easy to write **wrong in a way that looks right**. The failure mode is not a crash — it is a plausible number that is quietly too low, which trains the household to ignore it. **(1) Outflows are the union of confirmed obligation occurrences and a residual discretionary rate** — obligations are dated and exact; everything else is spread as a flat daily rate. **(2) The discretionary rate is a RESIDUAL, and this is the phase's defining correctness rule.** Recurring obligations are **already inside** observed spend, so taking a total-spend run-rate **and** adding the mortgage on the 1st counts the mortgage twice and makes safe-to-spend badly, silently low. The rate is therefore `(trailing observed expense − expense attributable to confirmed obligations in the same window) ÷ days in window`, via `Money.div`, **clamped at zero**. Attribution uses the **occurrence match** (ADR-037 §6) — matched occurrences name the exact transactions to exclude, so the subtraction is exact rather than estimated; unmatched-but-confirmed obligations are excluded at their occurrence `expected_amount`. A dedicated invariant test (P16-16) asserts that projected outflow over a full month never exceeds observed monthly spend plus newly-added obligations. **(3) Inflows come from observed take-home phased by the pay schedule, never from gross** — amount from `observedNetIncome`'s trailing median per period (ADR-034 §1: the deposits that actually landed **are** take-home), dates from `occurrenceDatesBetween`. `income_sources.gross_per_period` is **not** a projection input; projecting gross into a checking account overstates every inflow by the entire withholding stack. `direction='inflow'` obligations cover the irregular receipts income sources do not model. **(4) The horizon is stated and user-settable, defaulting to 60 days** — long enough to contain a full pay cycle plus a monthly bill cycle plus the next one, which is the window a family can still **act** in; configurable 14–365, and always displayed with the number, because a low-water mark without its window is not a fact. **(5) Safe-to-spend = `min(closing balance across the horizon) − cash_floor`, clamped at zero** — clamped because a negative value is not "you may spend −$200", it is a **shortfall**, reported as one with its date; the floor is the user's own stated buffer and is always shown alongside so the figure is never mistaken for a raw balance. **(6) The projection covers operating cash only** — `checking` / `cash_management` per ADR-033 §1's subtype via the existing `classifyCashTiers`. Savings, CDs, and brokerage are excluded: money that will not be spent from an account must not mask a shortfall in the account the bills hit. Accounts with no subtype are **excluded and named**, never silently included and never silently dropped. **(7) Degradation is explicit and quantified at four levels** (ADR-021's precedent, generalized as ADR-034 §7 did for advice): no operating account classified → **no projection at all**, with a link to set subtypes; under 3 months of history → `insufficient_history`, no rate, obligations still on the calendar; zero confirmed obligations → a pure run-rate **labeled as such**, with the detection candidates surfaced as the fix; thin coverage → the number shown **with its coverage percentage**. In every case the missing input is **named and linked** (ADR-032's auditability contract). **(8) Every figure carries its inputs** — the projection surface reuses the `InputUsed` shape from [advice/types.ts](../../src/lib/advice/types.ts) rather than inventing a parallel audit trail: a user who disagrees must be able to find the wrong **input**, not conclude the feature is untrustworthy. | ✅ Locked 2026-08-23 | Round 10's own text names the double-count as "the correctness trap that defines this round," which is why the residual is an ADR clause and not an implementation detail. The methodology is arithmetic a user can follow line by line with every line on screen, it reuses four shipped and tested components (`observedNetIncome`, `classifyCashTiers`, `spendByMonth`, `InputUsed`), and it **improves automatically** as obligations are confirmed — visibly, as a rising coverage figure. CLAUDE.md §Money is unusually load-bearing here: the day walk is **the longest sequential money-arithmetic chain in the codebase**, larger than PLAN15's payoff simulator, and a float would not merely round but drift monotonically into a number the user makes a spending decision on — so every value is a `numeric` string through [Money](../../src/lib/money/money.ts)/`decimal.js`, with `Number()` only at the Recharts display edge. Rejected: **a total-spend run-rate plus dated obligations with no residual** (the double-count — it fails in the direction that makes the whole feature untrustworthy); **obligations only, no discretionary rate** (ignores groceries and gas, and errs optimistic, the more dangerous direction of the two); **projecting gross income into checking** (ADR-034 §1 already established observed-net as the honest figure); **including savings and brokerage in the running balance** (masks the exact shortfall the feature exists to surface); **per-category daily rates** (more machinery, no better answer at this horizon, more ways to double-count); **Monte Carlo or confidence bands** (ADR-022 stands, see ADR-036 §7); **a 12-month default horizon** (beyond ~90 days the residual rate dominates and the line stops being information). Stated limitations, documented rather than hidden in [docs/CASHFLOW.md](../../docs/CASHFLOW.md): a flat daily rate does not know spending clusters on weekends and after payday (a day-of-week model is deferred); variable-amount obligations are projected at their trailing median and will be wrong by the variance (`amount_mode='trailing_median'` narrows this, it does not close it); and the residual subtraction is only as exact as occurrence matching — which is why coverage is **displayed rather than buried**. Full ADR + task breakdown in [PLAN16.md](PLAN16.md). |

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
