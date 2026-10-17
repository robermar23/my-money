# my-money

A self-hosted, single-user personal finance tracker. It records your accounts,
transactions, investments and net worth on your own server, and nothing leaves
it: no telemetry, no analytics, no ads, no third-party AI.

- **One household per installation.** One password, no user accounts.
- **Your data stays local.** The only outbound calls are ones you switch on:
  bank sync through Plaid, daily closing prices for symbols you hold or watch,
  and an optional alert email through your own SMTP server.
- **Exact money arithmetic.** Amounts are `NUMERIC` in Postgres and decimal in
  code; nothing is computed in floating point.

## Features

- **Accounts and transactions.** Checking, savings, credit cards, brokerage and
  retirement, crypto, physical metals, a home, a mortgage, and personal assets
  such as a car. Sync through Plaid, or import QFX/OFX/CSV statements;
  re-importing the same file is a no-op.
- **Net worth over time.** A daily snapshot of every account, a dashboard, and
  a breakdown of *why* net worth changed: saving, contributions, debt paydown,
  market return, revaluation, and what is left unexplained.
- **Investments.** Positions, cost-basis lots, gain/loss, allocation, time- and
  money-weighted returns against the S&P 500, and forward dividend income.
- **Spending and budgets.** Categories with rules, spending by category and
  month, and monthly budgets.
- **Planning.** A savings-priority checklist (emergency fund, employer match,
  debt, retirement accounts), a 60-day cash-flow projection with a
  safe-to-spend figure, recurring-bill detection, and sinking funds for
  irregular costs.
- **Help on every page.** Press `?` on any page for what it is for, how to read
  it, and why it might look wrong, with a short guided tour on the busiest
  pages and a getting-started checklist on the dashboard. It is written into
  the app, so it works offline and never reads your data.
- **Operations.** Encrypted nightly backups, a plain-text Beancount export,
  rule-based alerts, ⌘K search, and a Settings → Instance page that shows how
  the installation is configured.

[docs/FEATURES.md](docs/FEATURES.md) lists every page and the question it
answers.

## Scope: US households, US dollars

my-money supports **US dollars only**, with no currency conversion. Some
features are US-specific:

- The planning checklist uses US retirement accounts (401(k), 403(b), 457, IRA,
  HSA) and IRS contribution limits, which are added for each new year in
  [src/lib/advice/constants.ts](src/lib/advice/constants.ts)
  ([docs/GUIDANCE.md](docs/GUIDANCE.md)).
- The performance benchmark is the S&P 500.
- CSV import expects US number and date formats.
- Plaid needs your own production approval, which is not guaranteed for a
  personal project ([docs/PLAID.md](docs/PLAID.md)). File import always works.

It does **not** move money, pay bills, prepare taxes, keep double-entry books,
or support more than one household per installation.

## Quick start

Requirements: Docker Engine 24 or later with the `compose` plugin, on Linux
amd64 or arm64 (a Raspberry Pi works).

```sh
git clone <repository-url> my-money && cd my-money
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, SESSION_SECRET and MONEY_ENCRYPTION_KEY.
# Generate each secret with: openssl rand -base64 32

docker compose -f docker/compose.yaml --profile prod pull
docker compose -f docker/compose.yaml up -d postgres redis
docker compose -f docker/compose.yaml --profile prod run --rm app node_modules/.bin/drizzle-kit migrate
docker compose -f docker/compose.yaml --profile prod up -d app worker
```

Open <http://127.0.0.1:4000>. The first password you enter becomes the
password; change it later under Settings → Instance.

Then:

- **Back up.** Backups are off until you set `BACKUP_AGE_RECIPIENT`
  ([docs/BACKUP.md](docs/BACKUP.md)); until then the app shows a warning.
- **Try it first** on a fictional household, before entering real data
  ([docs/DEPLOY.md §2.0](docs/DEPLOY.md#20--optional-try-it-on-demo-data-first)).
- **Build the image yourself** instead of pulling it, Unraid, Plaid webhooks
  through a Cloudflare Tunnel, and alert email: [docs/DEPLOY.md](docs/DEPLOY.md).

## Configuration

All settings are environment variables in `.env`;
[.env.example](.env.example) documents each one.

| Variable | Required | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | yes | Database password |
| `SESSION_SECRET` | yes | Signs the session cookie |
| `MONEY_ENCRYPTION_KEY` | yes | Encrypts Plaid access tokens at rest. Losing it means reconnecting every bank ([docs/CRYPTO_ROTATION.md](docs/CRYPTO_ROTATION.md)) |
| `BACKUP_AGE_RECIPIENT` | recommended | `age` public key; turns on nightly encrypted backups |
| `MONEY_TZ` | no | Time zone for the backup and export schedule (default UTC) |
| `MONEY_IMAGE_TAG` | no | Image version to run (default `latest`; pin it, e.g. `0.19.0`) |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | no | Bank sync ([docs/PLAID.md](docs/PLAID.md)) |
| `SMTP_URL`, `ALERT_EMAIL_TO` | no | Alert email, which says only how many alerts are new ([docs/ALERTS.md](docs/ALERTS.md)) |
| `BEANCOUNT_DIR` | no | Turns on the nightly plain-text export ([docs/BEANCOUNT.md](docs/BEANCOUNT.md)) |

## Upgrading

Read the new version's entry in [CHANGELOG.md](CHANGELOG.md); its
`Migrations:` line says whether the database changes. Then, from the checkout:

```sh
sh scripts/prod.sh pull      # fetch the image MONEY_IMAGE_TAG names
sh scripts/prod.sh backup    # take a backup first
sh scripts/prod.sh migrate   # apply pending migrations
sh scripts/prod.sh restart   # recreate app and worker
```

Rollback and the Unraid specifics: [docs/DEPLOY.md §Updates](docs/DEPLOY.md#updates).

## Documentation

| Topic | Document |
| --- | --- |
| Installing and running | [DEPLOY.md](docs/DEPLOY.md) |
| Backups and restoring | [BACKUP.md](docs/BACKUP.md), [RESTORE.md](docs/RESTORE.md) |
| Bank sync | [PLAID.md](docs/PLAID.md), [RUNBOOK_PLAID.md](docs/RUNBOOK_PLAID.md) |
| File import | [IMPORT.md](docs/IMPORT.md) |
| Every page, by question | [FEATURES.md](docs/FEATURES.md) |
| Spending and budgets | [SPENDING.md](docs/SPENDING.md) |
| Investments, assets, watchlist | [INVESTMENTS.md](docs/INVESTMENTS.md), [ASSETS.md](docs/ASSETS.md), [WATCHLIST.md](docs/WATCHLIST.md) |
| Planning | [GUIDANCE.md](docs/GUIDANCE.md), [CASHFLOW.md](docs/CASHFLOW.md), [SINKING.md](docs/SINKING.md), [INCOME.md](docs/INCOME.md) |
| Dashboard, net-worth changes, search | [DASHBOARD.md](docs/DASHBOARD.md), [ATTRIBUTION.md](docs/ATTRIBUTION.md), [SEARCH.md](docs/SEARCH.md) |
| Alerts and the Beancount export | [ALERTS.md](docs/ALERTS.md), [BEANCOUNT.md](docs/BEANCOUNT.md) |
| Security | [SECURITY.md](SECURITY.md), [THREAT_MODEL.md](docs/THREAT_MODEL.md) |
| Writing in-app help for a page | [HELP.md](docs/HELP.md) |

## Development

Requires Node.js 22+, pnpm 11 and Docker.

```sh
pnpm install
cp .env.example .env.local   # then set SESSION_SECRET and MONEY_ENCRYPTION_KEY
make up                      # Postgres, the test Postgres, Redis
pnpm db:migrate
pnpm dev                     # http://127.0.0.1:4000
pnpm worker                  # second terminal
```

`pnpm check` (Biome and `tsc`) and `pnpm test` (Vitest) must pass.
[CONTRIBUTING.md](CONTRIBUTING.md) covers the test database, Playwright, the
project's guardrails and how releases are cut. Built with Next.js, TypeScript,
Drizzle, Postgres, BullMQ and Redis.

## Contributing

Contributions are welcome if they keep the project single-user and free of
telemetry; read [CONTRIBUTING.md](CONTRIBUTING.md) first. Report security
issues privately, as described in [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-or-later](LICENSE). Third-party licenses are listed in
[docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).
