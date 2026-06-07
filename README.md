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

Gain/loss is a display figure — `value − cost basis`. my-money does **not** do
tax-lot accounting, wash sales, or 1099/cap-gains reporting. See
[docs/INVESTMENTS.md](docs/INVESTMENTS.md) for the full guide.

## Fallback — QFX/CSV import (Phase 3)

The import path remains for institutions Plaid doesn't cover, or for backfill
when starting from a fresh install:

1. Log into the bank's online portal.
2. Download the statement export — `.qfx`, `.ofx`, or `.csv`.
3. Open the my-money account page → click **Import file**.
4. Drag the file onto the upload form, click **Upload & preview**.
5. Skim the preview (counts + reconciliation banner), click **Confirm**.

Re-importing the same file is always safe (deduped by FITID). See [docs/IMPORT.md](docs/IMPORT.md) for CSV column mapping and reconciliation troubleshooting. Manage category rules at **/settings/categories**.

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

**Production deployment** (public exposure via Cloudflare Tunnel or Tailscale) is deferred to Phase 6 (see ADR-006, pending). The compose file binds `app` to `127.0.0.1:4000` so no port is reachable from the LAN until you explicitly front it with Caddy + a tunnel.

---

## Project layout

```text
my-money/
├── plans/features/          # FEATURE.md, IDEAS.md, SKILLS.md, PLAN0_1.md — source of truth
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

## Known issues to address in early Phase 1

- **iron-session 8.0.4 + Next.js 15.1 dev mode**: signout → re-login within the same dev-server lifetime trips a `cookies() outside request scope` error. The setup-and-first-login path is fully verified by `e2e/auth.spec.ts`. The signout flow itself works in production builds; only dev-mode async-cookies tracking trips. Will be resolved by pinning a known-good iron-session release or rolling a tiny custom helper.

---

## Source-of-truth docs

In order of precedence when a question arises:

1. [CLAUDE.md](CLAUDE.md) — guardrails (privacy, money precision, Plaid safety, repo conventions)
2. [plans/features/IDEAS.md](plans/features/IDEAS.md) — locked ADRs (001 build-from-scratch, 002 web+Postgres, 003 TS/Next/Drizzle, 004 auth, 005 charts)
3. [plans/features/PLAN0_1.md](plans/features/PLAN0_1.md) — Phase 0 + Phase 1 task breakdown
4. [plans/features/SKILLS.md](plans/features/SKILLS.md) — curated skills catalog mapped to phases
5. [plans/features/FEATURE.md](plans/features/FEATURE.md) — original "what & why"
