# Changelog

What changed in each release of my-money, newest first, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape. Versions follow
[semantic versioning](https://semver.org/); before 1.0 a minor version is a
phase and may change anything.

**Every entry has a `Migrations:` line.** It names the newest file in
[drizzle/](drizzle/) the release needs, which answers *"do I need to migrate
before this runs?"* without reading a diff. Compare it with **Settings →
Instance → Database schema** on your own install; if yours is older, the
upgrade changes your schema, so back up first. The upgrade itself is
[docs/DEPLOY.md §Updates](docs/DEPLOY.md#updates): pull, read this file, back
up, migrate, restart. Apart from `0002`, which dropped the unused `users.email`
column in Phase 0 before any financial data existed, every migration so far
only adds tables or columns, widens a check, or relaxes a `NOT NULL`. None has
rewritten existing rows.

0.19.0 is the first versioned release. The entries below it are the phases that
came before, one per phase, summarized from the README's history. They were
never tagged, and their dates are when each phase finished.

## [0.19.0] - Unreleased

Phase 19, *the second operator*: no new money feature. It makes my-money
something a homelab that is not the author's can deploy, trust and maintain.
[PLAN19.md](plans/features/PLAN19.md), ADR-050 → ADR-054.

**Migrations:** `0027_jazzy_matthew_murdock`. `0026` widens the `alerts.type`
check to allow `backup_not_configured`; `0027` adds the nullable column
`household_profile.restore_drill_at`. Both only add.

### Added

- `LICENSE`: **AGPL-3.0-or-later**, with the matching SPDX id in
  `package.json`. [SECURITY.md](SECURITY.md) (private reporting, and what never
  to paste into an issue), [CONTRIBUTING.md](CONTRIBUTING.md), and
  [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md) (dependency licenses, checked).
- **Build-your-own image path**, co-equal with pulling the published one
  ([docs/DEPLOY.md](docs/DEPLOY.md) §Prerequisites). `MONEY_IMAGE_REPO` selects
  the image for both `app` and `worker`.
- **A `backup_not_configured` alert** while `BACKUP_AGE_RECIPIENT` is unset. One
  open alert at most; it clears on the first successful backup and never hides
  `backup_failure`.
- **Settings → Instance** (`/settings/instance`): version and image, whether the
  database schema matches the image, worker liveness, backup state and the last
  successful backup, a self-reported restore-drill date, which optional features
  are on, and which years of retirement-contribution limits are configured.
  Configuration and dates only, so it is safe to screenshot.
- **CI** on every push and pull request: `pnpm check`, `pnpm test` against a
  throwaway Postgres, and `pnpm build`. Playwright runs separately, by hand.
- **A real version** (this one), and `make image-release`, which tags the image
  `:<version>` as well as `:<git sha>` and `:latest`, from the tagged commit only.
- **[scripts/prod.sh](scripts/prod.sh)**: `pull`, `backup`, `migrate`,
  `restart` and `job <name>` for the production stack, from any directory. It
  replaces the README's hardcoded `/mnt/user/appdata/...` commands.
- **`MONEY_AUTO_MIGRATE`**, off by default and not recommended: applies pending
  migrations when the app starts, unattended and with no backup step. Settings →
  Instance warns while it is on.

### Changed

- The worker's once-a-minute heartbeat now reports which optional features it
  has configured (on or off, never a value), which is how the instance page
  sees settings that only the worker container has.
- The `app` service now starts through `scripts/app-start.sh`, which is
  `exec node server.js` unless `MONEY_AUTO_MIGRATE=true`.
- [docs/DEPLOY.md §Updates](docs/DEPLOY.md#updates) is now a five-step upgrade
  with the backup inside it, and recommends pinning `MONEY_IMAGE_TAG` to a
  version. `latest` still works and is still the default.

### Upgrade notes

- **Update `docker/compose.yaml` and the image together.** The new compose file
  starts `app` with `scripts/app-start.sh`, which exists only in images from
  this release on.

## Before 0.19.0

### Per-source take-home (ADR-049) - 2026-10-08

**Migrations:** `0025_charming_invaders`.

Take-home pay is defined per income source and suggested from the deposits that
actually landed, so a household with two paychecks is projected correctly.

### Phase 18: Sinking funds - 2026-10-05

**Migrations:** `0024_burly_wither`.

The annual, semiannual and irregular costs a monthly budget cannot represent:
a `planned_expenses` table for one-off dated costs, the accrual math that sizes
what should already be set aside, and one sentence on whether the reserve above
the emergency fund covers it. Computes a requirement; never moves or holds
money. [docs/SINKING.md](docs/SINKING.md).

### Cash-flow gaps (Phase 16 amendment) - 2026-08-30

**Migrations:** `0023_pink_demogoblin`.

A loan with stated terms becomes a first-class recurring obligation (the
mortgage appears on the cash-flow line because the app knows the loan, not
because it recognized the bank text), and a projected shortfall that savings
can cover says so instead of only listing the gap.

### Phase 17: Why net worth moved - 2026-08-30

**Migrations:** `0022_overrated_starfox` (no new migration).

`/analysis/networth` decomposes a change in net worth into five rungs (saved,
payroll retirement contributions, debt principal, market return, revaluation)
plus `unexplained`, reported at full size with named causes. Credit-card
balances are now entered as an amount owed, with one helper owning the sign.
[docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).

### Phase 16: The calendar dimension - 2026-08-29

**Migrations:** `0022_overrated_starfox`.

Recurring bills and paychecks are detected, confirmed by the user, materialized
into a dated calendar and matched against what posted. A deterministic daily
projection of operating cash gives the lowest projected balance and
safe-to-spend on the dashboard. [docs/CASHFLOW.md](docs/CASHFLOW.md).

### Navigation redesign - 2026-08-23

**Migrations:** `0020_melted_omega_sentinel` (no new migration).

A grouped top bar, a per-section strip, and one manifest that feeds the
sidebar, the section strips and the ⌘K palette (ADR-035).

### Phase 15: Household money guidance - 2026-08-23

**Migrations:** `0020_melted_omega_sentinel`.

`/plan`: a deterministic savings waterfall and ranked recommendations (emergency
fund, employer match, debt order, idle cash, contribution pace), each naming
its heuristic and inputs. Year-keyed statutory limits that suppress a rung
rather than guess. New account, category, credit-line and household-profile
inputs. [docs/GUIDANCE.md](docs/GUIDANCE.md).

### Phase 14: Income and retirement contributions - 2026-08-09

**Migrations:** `0018_gray_sleepwalker`.

Paychecks and 401(k) rules at `/settings/income` become real contribution
transactions and cost-basis lots each payday, with a backfill for past years
and a savings-rate card. Not payroll: no tax math. [docs/INCOME.md](docs/INCOME.md).

### Phase 13: The dashboard - 2026-08-09

**Migrations:** `0017_fuzzy_morg` (no new migration).

A net-worth hero and a curated grid (allocation, performance, spending vs.
budget, forward income, alerts, watchlist movers) under one `?range=` toggle.
Includes the set-based rewrite of the net-worth series (248× faster, zero
numeric change). [docs/DASHBOARD.md](docs/DASHBOARD.md).

### Phase 12: Search everywhere - 2026-06-23

**Migrations:** `0017_fuzzy_morg`.

A ⌘K command palette across accounts, categories, securities, watchlist items
and transactions, a cross-account `/transactions` view, and URL-param filters,
on Postgres `pg_trgm`. [docs/SEARCH.md](docs/SEARCH.md).

### Phase 11: Watchlist and price targets - 2026-06-23

**Migrations:** `0016_robust_tony_stark`.

Follow symbols you do not own, with an optional pretend purchase and one-shot
price targets evaluated daily. Excluded from net worth. [docs/WATCHLIST.md](docs/WATCHLIST.md).

### Phase 10: Personal high-value assets - 2026-06-20

**Migrations:** `0015_right_cerebro`.

Vehicles, jewelry, art and collectibles as a `personal_asset` account type with
manually entered values and optional proof-of-authenticity documents stored in
Postgres. [docs/ASSETS.md](docs/ASSETS.md).

### Phase 9: Investment depth II - 2026-06-20

**Migrations:** `0014_fat_vertigo`.

Per-holding daily snapshots, weekly security enrichment, a Performance tab (TWR,
XIRR, `^GSPC` benchmark), a Forecast tab, and per-security pages.
[docs/INVESTMENTS.md](docs/INVESTMENTS.md).

### Phase 8: Categories, spending analysis and budgets - 2026-06-19

**Migrations:** `0012_pale_shen`.

A two-level category taxonomy, a review queue for uncategorized transactions,
`/analysis`, monthly per-category budgets and a trailing-average forecast.

### Phase 7: Account management - 2026-06-18

**Migrations:** `0010_steady_lilith` (no new migration).

Rename, retype, close and delete manual accounts (ADR-017). The rest of the
planned CRUD is tracked in [PLAN7.md](plans/features/PLAN7.md).

### Phase 6: Polish and longevity - 2026-06-07

**Migrations:** `0010_steady_lilith`.

Nightly encrypted `pg_dump | age` backups, the Beancount mirror, anomaly alerts
with optional content-free email, `/api/health`, ARM64 builds and a mobile
layout. [docs/BACKUP.md](docs/BACKUP.md), [docs/ALERTS.md](docs/ALERTS.md).

### Phase 5: Investments - 2026-06-07

**Migrations:** `0009_purple_tenebrous`.

Plaid Investments holdings and transactions, per-lot cost basis, gain/loss,
allocation and dividend income at `/investments`.

### Phase 4: Plaid - 2026-06-06

**Migrations:** `0008_mean_black_cat`.

Plaid Link, signed and idempotent webhooks, `/transactions/sync` with cursors,
encrypted access tokens, reauth and disconnect, and a 03:00 safety-net sync.
[docs/PLAID.md](docs/PLAID.md).

### Phase 3: QFX and CSV import - 2026-05-31

**Migrations:** `0003_panoramic_iceman`.

Upload, preview and confirm, deduplicated by FITID, with regex category rules.
[docs/IMPORT.md](docs/IMPORT.md).

### Phases 0–2: Bedrock, manual entry, daily prices - 2026-05-27

**Migrations:** `0002_smart_bug`.

The stack, single-password auth, manual accounts, balances and holdings,
mortgage amortization, daily snapshots, the net-worth chart, and nightly price
fetching.
