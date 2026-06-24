# my-money

A self-hosted, single-user personal finance tracker. Owns its own data, never phones home, never serves ads, never integrates third-party analytics.

See [plans/features/FEATURE.md](plans/features/FEATURE.md) for the why, [plans/features/IDEAS.md](plans/features/IDEAS.md) for the locked ADRs, and [CLAUDE.md](CLAUDE.md) for the guardrails enforced across the codebase.

---

## Status

**Phase 0 (bedrock) — complete.** Next.js 15 + TypeScript + Tailwind v4 + Postgres + Redis + Drizzle + BullMQ + auth (iron-session + argon2id) + Vitest + Playwright + Docker Compose. The app boots, the single-user flow works, the worker emits heartbeats.

**Phase 1 (manual entry + net-worth chart) — complete.** Manual accounts, balances, holdings, mortgage amortization, daily snapshot job, dashboard with Recharts net-worth line.

**Phase 2 (daily prices) — complete.** Yahoo Finance / CoinGecko / Alpha Vantage fetchers wired through a cache-on-write `prices` table; nightly cron at 01:30.

**Phase 3 (QFX / CSV import) — complete.** Drop a `.qfx` from your bank or credit card on the account page → preview → confirm. Re-importing is safe (deduped by FITID). Regex-based category rules at `/settings/categories`. See [docs/IMPORT.md](docs/IMPORT.md).

**Phase 4 (Plaid push) — complete.** Connect bank/credit-card institutions through Plaid Link at `/settings/connections`; transactions arrive within minutes of posting via signed webhooks. Reauth + disconnect flows handled; encrypted-at-rest access tokens; daily 03:00 safety-net sync. See [docs/PLAID.md](docs/PLAID.md) for setup, [docs/DEPLOY.md](docs/DEPLOY.md) for the Cloudflare Tunnel webhook ingress, [docs/RUNBOOK_PLAID.md](docs/RUNBOOK_PLAID.md) for troubleshooting, [docs/CRYPTO_ROTATION.md](docs/CRYPTO_ROTATION.md) for key rotation, and [docs/THREAT_MODEL_PLAID.md](docs/THREAT_MODEL_PLAID.md) for the STRIDE analysis.

**Phase 5 (investments) — complete.** Plaid Investments for Fidelity (holdings + investment transactions on a separate Item), manual quarterly entry for iTrust gold; positions, per-lot cost basis, gain/loss, asset-allocation donut, and dividend/interest income at `/investments`. See [docs/INVESTMENTS.md](docs/INVESTMENTS.md).

**Phase 6 (polish & longevity) — complete.** Runs unattended: nightly encrypted `pg_dump | age` backups, a plain-text Beancount mirror, deterministic anomaly alerts, a `/api/health` probe, ARM64/Pi builds, and a mobile-responsive UI. See the §Backups, §Alerts, and §Longevity sections below, plus [docs/DEPLOY.md](docs/DEPLOY.md) for the full unattended-operation runbook and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the whole-app STRIDE analysis.

**Phase 7 (data management / CRUD) — account management shipped (Batch 1).** Rename, retype, close (archive), and delete manual accounts from the account page (ADR-017); closing preserves all historical data. The remaining CRUD batches — transaction edit/delete, balance-snapshot delete, category-rule edit — are tracked in [plans/features/PLAN7.md](plans/features/PLAN7.md).

**Phase 8 (categorization, spending analytics & budgets) — complete.** Free-text categories replaced by a structured two-level taxonomy (`category_groups` + `categories`, each tagged `income` / `expense` / `transfer` so internal moves and card payments stay out of spend totals). Fast inline categorization (managed picker with create-and-rule), a bulk **Review uncategorized** queue, a spending-analysis surface at `/analysis` (income/expense/net/savings tiles, stacked spend-by-month + net line, category-breakdown donut, per-category drill-down), monthly per-category **budgets** with actual-vs-target progress bars, and a deterministic **trailing-average forecast** plus month-to-date run-rate projections. All first-party SQL — no third-party analytics, no LLM categorization. See [plans/features/PLAN8.md](plans/features/PLAN8.md) (ADR-018).

**Phase 9 (investment depth II — history, performance, asset intelligence, forward view) — complete.** Per-holding daily snapshots (`holding_snapshots`) power value-over-time slicing; securities are enriched weekly with sector / industry / region / asset-type / forward-dividend metadata (only ticker symbols egress). New sub-tabs: **Performance** (`/investments/performance` — TWR, XIRR, gain/loss, contributions-vs-market-growth, `^GSPC` benchmark) and **Forecast** (`/investments/forecast` — forward 12-month income, yield-on-cost, income-growth trend, and a clearly-labeled illustrative value projection with a goal marker), plus per-security drill-down pages with price history and allocation slicing by sector/region/account. Every figure is a read-only display metric — no tax lots, cap-gains, or 1099. See [docs/INVESTMENTS.md](docs/INVESTMENTS.md), [docs/THREAT_MODEL_MARKETDATA.md](docs/THREAT_MODEL_MARKETDATA.md), and [plans/features/PLAN9.md](plans/features/PLAN9.md) (ADR-019 → ADR-022).

**Phase 10 (personal high-value assets) — complete.** Track user-valued possessions — vehicles, boats, jewelry, art/collectibles — as a new `personal_asset` account type that counts toward net worth and charts its value over time, reusing the snapshot machinery. Value is **manually entered** (no automated valuation, no depreciation); acquisition cost drives a simple labeled *display* gain/loss (not a tax figure). Optionally attach **proof-of-authenticity documents** (image or PDF, ≤10 MB) — hardened upload (magic-byte sniff + whitelist, SVG excluded), stored as `bytea` in Postgres so they ride the encrypted backup, and served only via an authenticated, attachment-only download route. Nothing about an asset ever leaves the host. See [docs/ASSETS.md](docs/ASSETS.md) and [plans/features/PLAN10.md](plans/features/PLAN10.md) (ADR-023 → ADR-024).

**Phase 11 (watchlist & price targets) — complete.** Follow a symbol you **don't own** (stock / ETF / metal / crypto) at `/watchlist`, optionally "pretend" you bought it `(date, quantity, unit cost)` for a simple display gain/loss + price-history chart, and set **one-shot price targets** ("alert me when it crosses $X, up or down"). A watchlist item is **structurally excluded from net worth** — it is neither an account nor a holding. Targets are evaluated **once daily** after the nightly price fetch (not real-time; intraday deferred) and surfaced through the existing `/alerts` page + **content-free** email. Only the ticker string egresses — pretend qty/cost and thresholds stay 100% local. See [docs/WATCHLIST.md](docs/WATCHLIST.md) and [plans/features/PLAN11.md](plans/features/PLAN11.md) (ADR-025 → ADR-026).

---

## Prerequisites

- **Node.js ≥ 22** (we use `process.loadEnvFile` and `--import tsx`)
- **pnpm 11.x** (install via `npm install -g pnpm` or `corepack enable && corepack prepare pnpm@11.3.0 --activate`)
- **Docker Desktop** (for Postgres + Redis containers)
- **Git**

Verify:

```bash
node --version    # v22.x or higher
pnpm --version    # 11.x
docker --version  # any modern Docker
```

---

## First-time setup

```bash
# 1. Install dependencies
pnpm install

# 2. Create your local env file from the template, then edit it
cp .env.example .env.local
# Generate fresh secrets and paste them into .env.local:
node -e "console.log('SESSION_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log('MONEY_ENCRYPTION_KEY=' + require('node:crypto').randomBytes(32).toString('hex'))"

# 3. Start the data services (Postgres + Redis)
docker compose -f docker/compose.yaml up -d

# 4. Apply database migrations
pnpm db:migrate

# 5. Start the web app
pnpm dev   # → http://127.0.0.1:4000

# 6. (Separate terminal) Start the background worker
pnpm worker
```

On the very first visit to `http://127.0.0.1:4000`, you'll be redirected to `/login`. The form's submit button reads **"Set password"** because no user exists yet — whatever you type becomes the only password for this instance. After that, the same page shows **"Sign in"** and verifies. No email, no username, no minimum length, 1-year session. Forgot the password? `make db-reset` and revisit `/login`.

---

## Usage — Plaid auto-sync (Phase 4 default)

Once your bank and credit card are connected through Plaid Link, there is no
monthly ritual. Transactions arrive within minutes of posting via signed
webhooks; the dashboard reflects them on the next render. A daily 03:00
safety-net cron catches anything a webhook dropped.

Open `/settings/connections` to see every connected institution, the last
sync time, and the most recent sync runs. The same page is where you handle
exceptions:

- **Reconnect** (amber button) appears when Plaid sends `ITEM_LOGIN_REQUIRED`
  (usually a password change at the bank). Click it, complete Plaid Link in
  update mode, and sync resumes from the same cursor.
- **Force sync** triggers an immediate `/transactions/sync` against the Item
  without waiting for the next webhook or the 03:00 cron.
- **Disconnect** tears down the Item: Plaid is notified, the local linkage
  is severed, the dead access token is wiped — but every prior transaction
  and snapshot stays.

See [docs/PLAID.md](docs/PLAID.md) for first-time setup (Sandbox → Production
cutover, `cloudflared` tunnel, account mapping), and
[docs/RUNBOOK_PLAID.md](docs/RUNBOOK_PLAID.md) when something looks off.

## Investments — positions, cost basis, gain/loss (Phase 5)

The `/investments` page (linked from the dashboard) shows every holding across
your brokerage, IRA, and crypto/metals accounts: value, cost basis, gain/loss,
an asset-allocation donut, and dividend/interest income over time.

- **Brokerage (Fidelity)**: click **"Connect investment institution"** on
  `/settings/connections` — it consents to Plaid's `investments` product and
  syncs holdings + buys/sells/dividends. Cost-basis lots are built from buys.
- **iTrust gold + crypto, and 401k**: enter quantities manually on the account
  page (quarterly), and optionally record **cost-basis lots** for accurate
  gain/loss. Prices update overnight; you only type quantities.

Three sub-tabs sit at the top of the surface: **Overview** (this dashboard, with
allocation slicing by sector/region/account and a top-holdings concentration
table), **Performance** (value & return over time — TWR, XIRR, gain/loss,
contributions-vs-market-growth, and an S&P 500 benchmark), and **Forecast**
(forward 12-month dividend income, yield-on-cost, income-growth trend, and a
clearly-labeled illustrative value projection with a goal marker). Click any
position's symbol for a per-security detail page with price history.

Every figure is a display metric — `value − cost basis` for gain/loss; TWR/XIRR
and the value projection are read-only/illustrative. my-money does **not** do
tax-lot accounting, wash sales, or 1099/cap-gains reporting, and projections are
not financial advice. See [docs/INVESTMENTS.md](docs/INVESTMENTS.md) for the full
guide.

## Personal assets — vehicles, jewelry, collectibles (Phase 10)

Track the valuable things you own that aren't financial accounts. On
`/accounts/new`, pick **"Personal asset"**, choose a category (vehicle, boat,
jewelry, art/collectible, other), and optionally record an acquisition date and
cost. Then record a value whenever it changes — each dated entry counts toward
your net worth and charts over time, exactly like the home `property` type.

Value is **always yours to enter** — there's no automated valuation and no
depreciation. If you recorded an acquisition cost, the page shows a simple labeled
gain/loss (latest value − cost), a *display* figure, never a tax/cap-gains
calculation.

Optionally attach **proof of authenticity** — a title, receipt, appraisal, or
photo (JPEG/PNG/WebP/HEIC/PDF, up to 10 MB). Files are type-checked by content
(not extension), stored privately in Postgres so they're captured by the nightly
encrypted backup, and downloaded only as attachments. Nothing about an asset ever
leaves the host. See [docs/ASSETS.md](docs/ASSETS.md).

## Fallback — QFX/CSV import (Phase 3)

The import path remains for institutions Plaid doesn't cover, or for backfill
when starting from a fresh install:

1. Log into the bank's online portal.
2. Download the statement export — `.qfx`, `.ofx`, or `.csv`.
3. Open the my-money account page → click **Import file**.
4. Drag the file onto the upload form, click **Upload & preview**.
5. Skim the preview (counts + reconciliation banner), click **Confirm**.

Re-importing the same file is always safe (deduped by FITID). See [docs/IMPORT.md](docs/IMPORT.md) for CSV column mapping and reconciliation troubleshooting. Manage category rules at **/settings/categories**.

## Spending analysis & budgets (Phase 8)

Transactions are organized by a structured taxonomy — leaf **categories** grouped
into **groups**, each tagged `income`, `expense`, or `transfer` so internal moves
and credit-card payments never count as spending. Categorize fast from a
transaction's picker (inline "+ new category" with an optional auto-rule), or
clear the backlog in bulk at **/analysis/review**.

**/analysis** is the spending surface: income / expense / net / savings-rate
tiles, a stacked spend-by-month chart with a net line, a category-breakdown
donut, and per-category drill-downs — all filterable by date range and account
(state lives in the URL). The chart extends one **projected** month (dashed,
dimmed) from a trailing 3-month average.

**/analysis/budgets** sets a monthly target per category with actual-vs-target
progress bars (over = red), a month switcher, group rollups, and a
**projected end-of-month** marker from the current month's run-rate.

Every figure is first-party SQL over your local Postgres — no third-party
analytics, no LLM categorization (CLAUDE.md §Privacy). Manage categories, groups,
and regex rules at **/settings/categories**; after editing rules en masse, run the
one-shot category backfill (see §Backfill category assignment logic below).

---

## Backups (Phase 6)

A nightly BullMQ job dumps the database with `pg_dump`, pipes it straight into
`age` (the plaintext never hits disk), and writes an encrypted
`money-<timestamp>.dump.age` to the `backups` volume at **04:00**. It's **opt-in**:
set `BACKUP_AGE_RECIPIENT` to an `age` **public** key and the job turns on.

The private `age` identity that decrypts your backups **never lives on the
server** — keep it in a password manager or on a second machine. A server
compromise then still can't read your backup history. Replicate the `backups`
volume off-host yourself (the dumps are already encrypted, so any object store is
fine). A failed backup raises a `backup_failure` alert that clears on the next
success.

→ [docs/BACKUP.md](docs/BACKUP.md) to configure it, [docs/RESTORE.md](docs/RESTORE.md)
for the `age -d | pg_restore` recovery drill (test it quarterly).

## Alerts (Phase 6)

A nightly job at **05:00** runs deterministic rules over your data — large
transactions, balance drops, broken Plaid connections, stale snapshots/prices,
sync/backup failures — and surfaces them at **/alerts**. Thresholds are tunable
(`ALERT_LARGE_TXN_USD`, `ALERT_BALANCE_DROP_PCT`, `ALERT_STALE_DAYS`).

Email is **optional and content-free**: configure `SMTP_URL` + `ALERT_EMAIL_TO`
and you get a doorbell — *"2 new alerts"* plus a sign-in link, and **zero
financial data**. Every figure lives only on the authenticated `/alerts` page;
the transport is your own SMTP server, never a SaaS relay (CLAUDE.md §Privacy).

→ [docs/ALERTS.md](docs/ALERTS.md) for the full rule catalog + setup.

## Longevity (Phase 6)

So your data outlives the app itself: a nightly job at **04:30** writes a one-way,
plain-text [Beancount](https://beancount.github.io/) mirror (`money.beancount`) to
the `exports` volume — readable forever in `less`, or with `bean-query`/`fava`.
It's a vendor-lock-in hedge, not an accounting ledger: generated, never
re-imported. Opt in by setting `BEANCOUNT_DIR`.

→ [docs/BEANCOUNT.md](docs/BEANCOUNT.md) for what's exported and how to read it.

---

## Development commands

| Command                | What it does                                                          |
| ---------------------- | --------------------------------------------------------------------- |
| `pnpm dev`             | Run Next.js dev server on `127.0.0.1:4000`                            |
| `pnpm worker`          | Run the BullMQ worker process (heartbeat in Phase 0)                  |
| `pnpm check`           | Run Biome linter + `tsc --noEmit` strict type check                   |
| `pnpm format`          | Auto-fix lint + formatting via Biome                                  |
| `pnpm test`            | Run Vitest unit/integration tests                                     |
| `pnpm test:watch`      | Vitest in watch mode                                                  |
| `pnpm test:e2e`        | Run Playwright E2E suite (starts `pnpm dev` automatically)            |
| `pnpm db:generate`     | Generate new SQL migration from current Drizzle schema                |
| `pnpm db:migrate`      | Apply pending migrations to the dev database                          |
| `pnpm db:push`         | Prototype-only: push schema directly without a migration file         |
| `pnpm db:studio`       | Drizzle Studio: visual DB browser at `https://local.drizzle.studio/`  |
| `pnpm build`           | Production Next.js build (standalone output)                          |
| `pnpm start`           | Run the production build                                              |

---

## Notes on this machine's environment

- **Port 4000** (not 3000): the Windows dev box reserves the 2496-3169 TCP range (Hyper-V / WSL2). The Next.js dev server and the compose `app` service both run on 4000.
- **Postgres host port 5433** (not 5432) and **Redis host port 6380** (not 6379): to avoid collisions with any pre-existing host Postgres/Redis. Inside the docker network the services still listen on the standard 5432/6379.
- **`--hostname 127.0.0.1`** is required on the Next.js dev script — binding to `0.0.0.0` on Windows needs admin.

---

## Running the full stack from images (prod profile)

The `prod` profile in `docker/compose.yaml` adds `app` and `worker` services. This is what runs on the home server (per ADR-002).

```bash
# Build images
docker compose -f docker/compose.yaml --profile prod build

# Run all four services (postgres + redis + app + worker)
docker compose -f docker/compose.yaml --env-file .env.local --profile prod up -d

# Tail logs
docker compose -f docker/compose.yaml logs -f app worker
```

**Production deployment** is documented end-to-end in [docs/DEPLOY.md](docs/DEPLOY.md): the prod compose bring-up, the ARM64 (Raspberry Pi) build, public webhook exposure via a Cloudflare Tunnel (ADR-010 — no inbound port on your router), the `/api/health` container probe, off-host backup/export replication, SMTP for alert notifications, and the nightly job timeline. The compose file binds `app` to `127.0.0.1:4000`, so nothing is reachable from the LAN until the tunnel explicitly forwards the webhook path.

---

## Project layout

```text
my-money/
├── plans/features/          # FEATURE.md, IDEAS.md, SKILLS.md, PLAN*.md — source of truth
├── src/
│   ├── app/                 # Next.js App Router (pages, layouts, route handlers, server actions)
│   │   ├── setup/           # First-run user bootstrap wizard
│   │   ├── login/           # Login page + server action
│   │   └── logout/          # POST → clear cookie + 303 to /login
│   ├── db/
│   │   ├── client.ts        # Postgres client + Drizzle instance
│   │   └── schema/          # One file per domain concept
│   ├── lib/
│   │   ├── auth/            # iron-session, argon2id, requireUser
│   │   └── queue/           # BullMQ shared Redis connection + queue defs
│   └── worker/              # BullMQ worker entrypoint (separate process)
├── drizzle/                 # Generated migration SQL
├── e2e/                     # Playwright specs
├── docker/                  # compose.yaml
├── Dockerfile               # Multi-stage build for web + worker
└── CLAUDE.md                # Agent guardrails (privacy, money precision, Plaid safety)
```

---

## Resetting the dev database

```bash
# Wipe Postgres + Redis volumes and start fresh
docker compose -f docker/compose.yaml down -v
docker compose -f docker/compose.yaml up -d
pnpm db:migrate
```

For an E2E run from a clean state, the `users` table can be truncated without dropping the DB:

```bash
docker compose -f docker/compose.yaml exec -T postgres psql -U money -d money -c "TRUNCATE users;"
```

---

## Known issues

No open known issues.

**Resolved** — *iron-session 8.0.4 + Next.js 15.1 dev-mode signout* (was: signout → re-login within the same dev-server lifetime tripped a `cookies() outside request scope` error). Fixed by having [src/app/logout/route.ts](src/app/logout/route.ts) clear the session cookie directly on the `NextResponse` (maxAge 0) instead of re-entering iron-session's cookie API inside the route handler, which is where dev-mode async-cookies tracking mis-fired. Both the setup→login and signout paths are exercised by `e2e/auth.spec.ts`.

---

## Source-of-truth docs

In order of precedence when a question arises:

1. [CLAUDE.md](CLAUDE.md) — guardrails (privacy, money precision, Plaid safety, repo conventions)
2. [plans/features/IDEAS.md](plans/features/IDEAS.md) — locked ADRs 001–024 + the §11 Decision Log (build-from-scratch, web+Postgres, TS/Next/Drizzle, auth, charts, QFX parser, categorization, Plaid scope/encryption/exposure, investments, backups, alerts, beancount, account management, structured categories/analytics/budgets, investment depth II, personal assets + proof documents)
3. [plans/features/PLAN0_1.md](plans/features/PLAN0_1.md) … [PLAN10.md](plans/features/PLAN10.md) — per-phase task breakdowns (Phase 0/1 through Phase 10)
4. [plans/features/SKILLS.md](plans/features/SKILLS.md) — curated skills catalog mapped to phases
5. [plans/features/FEATURE.md](plans/features/FEATURE.md) — original "what & why"

## PRD Commands

### Restart App

```sh
docker compose -f /mnt/user/appdata/my-money/repo/docker/compose.yaml   --env-file /mnt/user/appdata/my-money/repo/.env --profile prod up -d --force-recreate app worker
```

### Pull Latest

```sh
docker compose -f /mnt/user/appdata/my-money/repo/docker/compose.yaml   --env-file /mnt/user/appdata/my-money/repo/.env --profile prod pull
```

### Make backup

Uses `run --rm` (not `exec`) so the one-off container re-reads `.env` at launch —
`exec` reuses the **running** worker's environment, which was frozen at container
creation, so a `BACKUP_AGE_RECIPIENT` you added *after* the worker started won't be
seen and the job logs `disabled … skipping`. The `register.mjs` loader stubs Next's
`server-only` marker; without it `run-once.ts` fails with `ERR_MODULE_NOT_FOUND:
Cannot find package 'server-only'`. Requires `BACKUP_AGE_RECIPIENT` set in `.env`.

```sh
docker compose -f /mnt/user/appdata/my-money/repo/docker/compose.yaml \
  --env-file /mnt/user/appdata/my-money/repo/.env --profile prod run --rm --no-deps worker \
  node --experimental-strip-types --import tsx --import ./scripts/loaders/register.mjs \
  src/worker/run-once.ts backup-database-daily

docker compose -f /mnt/user/appdata/my-money/repo/docker/compose.yaml --env-file /mnt/user/appdata/my-money/repo/.env --profile prod exec worker ls -lh /backups
# → money-YYYYMMDDTHHMMSSZ.dump.age
```

### Apply Migration for update

```sh
docker compose -f /mnt/user/appdata/my-money/repo/docker/compose.yaml --env-file /mnt/user/appdata/my-money/repo/.env --profile prod run --rm app node_modules/.bin/drizzle-kit migrate
```

## Backfill category assignment logic

```sh
docker compose -f /mnt/user/appdata/my-money/repo/docker/compose.yaml --env-file /mnt/user/appdata/my-money/repo/.env --profile prod run --rm worker node --experimental-strip-types --import tsx --import ./scripts/loaders/register.mjs \
  src/worker/run-once.ts backfill-categories
```

