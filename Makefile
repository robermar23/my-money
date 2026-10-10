# my-money -- common operations
#
# Run `make` or `make help` to see all targets.
# Works on Windows (cmd.exe via native make) and Unix (bash/sh).

.DEFAULT_GOAL := help

# Always run docker compose with the same compose file + env file.
# `--env-file .env.local` loads dev settings (DB creds, etc.); prod-only vars
# like CLOUDFLARED_TOKEN default to empty in compose.yaml so data/dev commands
# never require them (the prod profile fails loudly at runtime if the token is
# missing).
COMPOSE := docker compose -f docker/compose.yaml --env-file .env.local

# ---------------------------------------------------------------------------
# Container image publishing (Docker Hub: robermar2/my-money)
# ---------------------------------------------------------------------------
# IMAGE_REPO  — the Docker Hub repository the multi-arch image is pushed to.
# GIT_REV     — short git SHA, used as the immutable image tag. `$(shell ...)`
#               runs on both cmd.exe (native make) and bash, since `git` is git.
# PLATFORMS   — buildx target platforms; arm64 covers the Pi (IDEAS.md §1).
# BUILDER     — dedicated buildx builder so we don't disturb the default one.
IMAGE_REPO ?= robermar2/my-money
GIT_REV    := $(shell git rev-parse --short HEAD)
# VERSION — package.json's semver (PLAN19 P19-19, ADR-054 §2). Read with node so
#           the same line works under cmd.exe and bash.
VERSION    := $(shell node -p "require('./package.json').version")
PLATFORMS  ?= linux/amd64
BUILDER    ?= my-money-builder

# Domain tables for `db-reset` — a DEV convenience that wipes rows, keeping the
# schema. CASCADE handles children: holdings → holding_lots; accounts →
# transactions, import_batches, investment_transactions. Listed explicitly
# (not reached by cascading accounts): `securities` (holdings.security_id is ON
# DELETE SET NULL) and the Plaid connection tables.
#
# Plaid Items ARE wiped: db-reset means "clean slate," and on a dev box the
# same DB is shared with the test suite, which seeds Items carrying FAKE access
# tokens — preserving those breaks the connections/map flow (INVALID_ACCESS_
# TOKEN). Re-linking against Plaid sandbox is quick. Only `category_rules` is
# preserved (it holds seeded defaults the app relies on).
# `income_sources` cascades to retirement_contributions → income_contributions
# (Phase 14). Listed explicitly because nothing else reaches it: a contribution
# rule hangs off an account, but the paycheck that defines it does not.
# Same reason for the three Phase-15 tables: `credit_lines` DOES cascade from
# accounts, but `household_profile`, `household_members` and
# `recommendation_dismissals` have no FK at all — deliberately (see
# src/db/schema/household.ts). Without them here a "clean slate" would silently
# keep the previous household's members and every dismissed recommendation.
# `planned_expenses`, `category_budgets` and `watchlist_items` likewise hang off
# nothing that is truncated here (PLAN19 P19-32 found the first two surviving a
# reset, which left `make seed-demo` refusing a book that looked empty). With
# them listed, every table `seed-demo` counts as the household's own records
# (src/lib/demo/seed.ts BOOK_TABLES) is reached, directly or by CASCADE.
DOMAIN_TABLES := users, accounts, holdings, securities, plaid_items, plaid_sync_runs, webhook_log, account_snapshots, liabilities, prices, alerts, income_sources, household_profile, household_members, recommendation_dismissals, planned_expenses, category_budgets, watchlist_items

# ---------------------------------------------------------------------------
# Help (cross-platform; plain @echo lines so cmd.exe + bash both render OK).
# No parentheses, <, >, |, & or ; in the text: cmd.exe tolerates them, but sh
# reads them as syntax and `make help` (the default goal) fails on Linux.
# ---------------------------------------------------------------------------

.PHONY: help
help:
	@echo my-money -- run "make <target>". Available targets:
	@echo ----------------------------------------------------------
	@echo SETUP
	@echo   install         Install dependencies [pnpm install]
	@echo   setup           First-time: install + up + migrate
	@echo ----------------------------------------------------------
	@echo DOCKER STACK [data only -- dev + test Postgres + Redis]
	@echo   up              Start dev + test Postgres + Redis in background
	@echo   down            Stop containers [data preserved]
	@echo   nuke            Stop + WIPE volumes [destroys all DB data]
	@echo   restart         Stop and restart data containers
	@echo   ps              Show container status
	@echo   logs            Tail Postgres + Redis logs
	@echo   psql            Open psql shell in dev Postgres
	@echo   psql-test       Open psql shell in test Postgres
	@echo   redis-cli       Open redis-cli in Redis container
	@echo ----------------------------------------------------------
	@echo DOCKER STACK [full prod-style -- adds app + worker]
	@echo   prod-pull       Pull the published app + worker image [robermar2/my-money]
	@echo   prod-up         Start the full stack from images
	@echo   prod-down       Stop the full stack
	@echo   prod-logs       Tail app + worker logs
	@echo   -- on the server, via scripts/prod.sh -- reads .env, see docs/DEPLOY.md
	@echo   prod-backup     Encrypted backup now -- refuses if BACKUP_AGE_RECIPIENT is unset
	@echo   prod-migrate    Apply pending migrations in a one-off app container
	@echo   prod-restart    Recreate app + worker
	@echo   prod-job        Run one worker job once: make prod-job JOB=backfill-categories
	@echo   prod-backfill-categories  Same as prod-job JOB=backfill-categories
	@echo ----------------------------------------------------------
	@echo PUBLISH [Docker Hub robermar2/my-money, multi-arch]
	@echo   buildx-init     Create/bootstrap the buildx builder [one-time]
	@echo   image-build     Build amd64+arm64 image locally [no push]
	@echo   image-push      Build amd64+arm64 and push, tagged with git SHA + latest
	@echo   image-release   Same, plus the version tag -- only from the commit tagged vVERSION
	@echo ----------------------------------------------------------
	@echo APP [local dev]
	@echo   dev             Next.js dev server [http://127.0.0.1:4000]
	@echo   worker          BullMQ worker [heartbeat + cron jobs]
	@echo   build           Production Next.js build
	@echo   start           Run the production build
	@echo ----------------------------------------------------------
	@echo TESTS
	@echo   test            Vitest unit + integration
	@echo   test-watch      Vitest in watch mode
	@echo   e2e             Playwright E2E specs
	@echo   e2e-headed      Playwright with visible browser
	@echo   e2e-ui          Playwright interactive UI mode
	@echo ----------------------------------------------------------
	@echo CODE QUALITY
	@echo   check           Biome + tsc --noEmit
	@echo   lint            Biome lint [no fix]
	@echo   format          Biome auto-fix + format
	@echo   typecheck       tsc --noEmit only
	@echo ----------------------------------------------------------
	@echo DATABASE [Drizzle]
	@echo   db-generate     Generate SQL migration from schema
	@echo   db-migrate      Apply pending migrations
	@echo   db-push         Push schema directly [dev iteration]
	@echo   db-studio       Drizzle Studio [visual DB browser]
	@echo   db-reset        Truncate domain tables [keep schema]
	@echo   db-reset-password  Delete users row -- next /login sets a new password
	@echo   db-reset-plaid  Delete Plaid Items -- re-link via Plaid Link [keeps accounts]
	@echo   seed-demo       Fill an EMPTY dev book with a fictional household -- refuses otherwise
	@echo ----------------------------------------------------------
	@echo WORKERS [run one job once -- no scheduling]
	@echo   job-snapshots   Run compute-snapshots-daily once
	@echo   job-prices      Run fetch-prices-daily once [real APIs!]
	@echo   job-heartbeat   Run heartbeat once [smoke test]
	@echo   job-backup      Run backup-database-daily once [needs pg_dump + age]
	@echo   job-beancount   Run export-beancount-daily once [needs BEANCOUNT_DIR set]
	@echo   job-anomalies   Run detect-anomalies-daily once [writes to alerts]

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

.PHONY: install
install:
	pnpm install

# .env.local existence check is done via node so it works on both cmd and bash.
.PHONY: setup
setup:
	@node -e "if (!require('fs').existsSync('.env.local')) { console.error('ERROR: copy .env.example to .env.local first, then fill in secrets.'); process.exit(1) }"
	$(MAKE) install
	$(MAKE) up
	$(MAKE) db-migrate
	@echo Setup complete.
	@echo   Start the app:    make dev
	@echo   Start the worker: make worker  (in a separate terminal)

# ---------------------------------------------------------------------------
# Docker stack -- data services only
# ---------------------------------------------------------------------------

.PHONY: up
up:
	$(COMPOSE) up -d
	@echo Dev Postgres on 127.0.0.1:5433, test Postgres on 127.0.0.1:5434, Redis on 127.0.0.1:6380.

.PHONY: down
down:
	$(COMPOSE) down

.PHONY: nuke
nuke:
	@echo About to WIPE all Postgres + Redis data. Ctrl-C within 3 seconds to abort.
	@node -e "setTimeout(() => {}, 3000)"
	$(COMPOSE) down -v

.PHONY: restart
restart:
	$(MAKE) down
	$(MAKE) up

.PHONY: ps
ps:
	$(COMPOSE) ps

.PHONY: logs
logs:
	$(COMPOSE) logs -f postgres redis

.PHONY: psql
psql:
	$(COMPOSE) exec postgres psql -U money -d money

.PHONY: psql-test
psql-test:
	$(COMPOSE) exec postgres_test psql -U money -d money_test

.PHONY: redis-cli
redis-cli:
	$(COMPOSE) exec redis redis-cli

# ---------------------------------------------------------------------------
# Docker stack -- full prod-style
# ---------------------------------------------------------------------------

.PHONY: prod-pull
prod-pull:
	$(COMPOSE) --profile prod pull

.PHONY: prod-up
prod-up:
	$(COMPOSE) --profile prod up -d

.PHONY: prod-down
prod-down:
	$(COMPOSE) --profile prod down

.PHONY: prod-logs
prod-logs:
	$(COMPOSE) --profile prod logs -f app worker

# The server-side operator commands (PLAN19 P19-22). scripts/prod.sh is the real
# interface — Unraid and most NAS hosts ship `sh` but not `make` — and these
# targets only call it. It reads .env (falling back to .env.local) and takes
# MONEY_REPO_DIR / MONEY_ENV_FILE / MONEY_COMPOSE_OVERRIDE from the environment.
.PHONY: prod-backup
prod-backup:
	sh scripts/prod.sh backup

.PHONY: prod-migrate
prod-migrate:
	sh scripts/prod.sh migrate

.PHONY: prod-restart
prod-restart:
	sh scripts/prod.sh restart

.PHONY: prod-job
prod-job:
	sh scripts/prod.sh job $(JOB)

.PHONY: prod-backfill-categories
prod-backfill-categories:
	sh scripts/prod.sh job backfill-categories

# ---------------------------------------------------------------------------
# Publish multi-arch image to Docker Hub (robermar2/my-money)
# ---------------------------------------------------------------------------
# A multi-arch (amd64+arm64) image can't be loaded into the local docker engine
# in one go, so `image-push` builds + pushes in a single buildx invocation (the
# manifest list lands in the registry directly). `image-build` is a local
# verification build (--load only works single-arch, so it stays multi-arch and
# just discards the result). Tags: the immutable short git SHA plus `latest`.
#
# Prereqs: `docker login` (push access to robermar2/*) and a buildx builder —
# run `make buildx-init` once. Override the repo/platforms if needed:
#   make image-push IMAGE_REPO=myuser/my-money PLATFORMS=linux/arm64

# Create the buildx builder if it doesn't already exist, then bootstrap it.
# Idempotent: the `inspect || create` guard makes re-running a no-op.
.PHONY: buildx-init
buildx-init:
	docker buildx inspect $(BUILDER) >/dev/null 2>&1 || docker buildx create --name $(BUILDER) --driver docker-container
	docker buildx inspect $(BUILDER) --bootstrap

# Build for both platforms without pushing (verification only — result discarded).
.PHONY: image-build
image-build:
	docker buildx build --builder $(BUILDER) --platform $(PLATFORMS) -f Dockerfile -t $(IMAGE_REPO):$(GIT_REV) .

# Build both platforms and push the manifest list, tagged with the git SHA + latest.
.PHONY: image-push
image-push:
	@echo Pushing $(IMAGE_REPO):$(GIT_REV) for $(PLATFORMS)
	docker buildx build --builder $(BUILDER) --platform $(PLATFORMS) -f Dockerfile -t $(IMAGE_REPO):$(GIT_REV) -t $(IMAGE_REPO):latest --push .

# A release image (ADR-054 §2): the version tag, the git SHA and latest. Refuses
# unless HEAD is exactly the tag v$(VERSION), so a version tag on the registry
# always names the commit its CHANGELOG entry describes, never a work-in-progress
# build that happened to carry the same package.json version.
.PHONY: image-release
image-release:
	@node -e "const {execSync}=require('node:child_process');let t='';try{t=execSync('git describe --exact-match --tags HEAD',{stdio:['ignore','pipe','ignore']}).toString().trim()}catch{}if(t!=='v$(VERSION)'){console.error('ERROR: HEAD is not tagged v$(VERSION). Tag the release commit first (see CONTRIBUTING.md).');process.exit(1)}"
	@echo Pushing $(IMAGE_REPO):$(VERSION) + $(GIT_REV) + latest for $(PLATFORMS)
	docker buildx build --builder $(BUILDER) --platform $(PLATFORMS) -f Dockerfile -t $(IMAGE_REPO):$(VERSION) -t $(IMAGE_REPO):$(GIT_REV) -t $(IMAGE_REPO):latest --push .

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

.PHONY: dev
dev:
	pnpm dev

.PHONY: worker
worker:
	pnpm worker

.PHONY: build
build:
	pnpm build

.PHONY: start
start:
	pnpm start

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

.PHONY: test
test:
	pnpm test

.PHONY: test-watch
test-watch:
	pnpm test:watch

.PHONY: e2e
e2e:
	pnpm test:e2e

.PHONY: e2e-headed
e2e-headed:
	pnpm exec playwright test --headed

.PHONY: e2e-ui
e2e-ui:
	pnpm exec playwright test --ui

# ---------------------------------------------------------------------------
# Code quality
# ---------------------------------------------------------------------------

.PHONY: check
check:
	pnpm check

.PHONY: lint
lint:
	pnpm exec biome check

.PHONY: format
format:
	pnpm format

.PHONY: typecheck
typecheck:
	pnpm exec tsc --noEmit

# ---------------------------------------------------------------------------
# Database (Drizzle)
# ---------------------------------------------------------------------------

.PHONY: db-generate
db-generate:
	pnpm db:generate

.PHONY: db-migrate
db-migrate:
	pnpm db:migrate

.PHONY: db-push
db-push:
	pnpm db:push

.PHONY: db-studio
db-studio:
	pnpm db:studio

.PHONY: db-reset
db-reset:
	@echo Truncating: $(DOMAIN_TABLES)
	$(COMPOSE) exec -T postgres psql -U money -d money -c "TRUNCATE $(DOMAIN_TABLES) CASCADE;"

# Forgot the dev password? Delete the single users row. The next /login
# submission re-bootstraps a new password (login/actions.ts). All other domain
# data (accounts, transactions, categories) is preserved.
.PHONY: db-reset-password
db-reset-password:
	@echo Deleting users row -- next /login sets a new password.
	$(COMPOSE) exec -T postgres psql -U money -d money -c "DELETE FROM users;"

# A fictional household for evaluating the app (PLAN19 P19-32). Refuses, and
# writes nothing, unless the book is empty; refuses under NODE_ENV=production
# unless SEED_DEMO_CONFIRM=yes. Clear it again with `make db-reset`.
.PHONY: seed-demo
seed-demo:
	pnpm seed:demo

# Stale Plaid Items (INVALID_ACCESS_TOKEN on the map-accounts step) happen when
# an Item carries a fake/seeded token or was encrypted under a since-rotated
# MONEY_ENCRYPTION_KEY. Deleting them lets you re-link cleanly. Safe for data:
# accounts.plaid_item_id is ON DELETE SET NULL (accounts + transactions survive,
# just unlinked); plaid_sync_runs cascade away. Re-link via Plaid Link after.
.PHONY: db-reset-plaid
db-reset-plaid:
	@echo Deleting all plaid_items -- re-link via Plaid Link afterward.
	$(COMPOSE) exec -T postgres psql -U money -d money -c "DELETE FROM plaid_items;"

# ---------------------------------------------------------------------------
# Workers -- run one job once
# ---------------------------------------------------------------------------

.PHONY: job-snapshots
job-snapshots:
	pnpm worker:once compute-snapshots-daily

.PHONY: job-prices
job-prices:
	pnpm worker:once fetch-prices-daily

.PHONY: job-heartbeat
job-heartbeat:
	pnpm worker:once heartbeat

# Requires pg_dump + age on PATH and BACKUP_AGE_RECIPIENT set in .env.local.
# In production this runs inside the worker container where both binaries live.
.PHONY: job-backup
job-backup:
	pnpm worker:once backup-database-daily

# Requires BEANCOUNT_DIR set in .env.local (the job skips when it's unset).
.PHONY: job-beancount
job-beancount:
	pnpm worker:once export-beancount-daily

.PHONY: job-anomalies
job-anomalies:
	pnpm worker:once detect-anomalies-daily
