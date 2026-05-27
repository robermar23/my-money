# PLAN — Phase 0 (Bedrock) + Phase 1 (Manual Entry + Net-Worth Chart)

> Phase 0 establishes the working stack. Phase 1 ships the first slice of real value:
> the user can enter their accounts manually and see a real net-worth chart.
>
> **Companion docs** — read these for context, do not duplicate them here:
> - [FEATURE.md](FEATURE.md) — what we're building
> - [IDEAS.md](IDEAS.md) — locked ADR-001/002/003 + decision log
> - [SKILLS.md](SKILLS.md) — which skills to invoke per task
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails (money precision, privacy, Plaid safety)

---

## ADRs locked at plan time

Two decisions deferred in IDEAS.md (rows 11 and 12 of the Decision Log) were resolved on 2026-05-25 as ADR-004 and ADR-005 below. Both are ✅ locked. IDEAS.md Decision Log was updated accordingly.

---

### ADR-004 — Auth library: roll our own with `iron-session` + `argon2id`

**Status**: ✅ Locked 2026-05-25 — **UX revised same day** (see "UX revision" below)

**Context**:
my-money is single-user (per FEATURE.md and CLAUDE.md §Domain Scope). The `users` table will have exactly one row. We need: a password login form, a server-side session cookie, CSRF protection, password hashing. We do NOT need: OAuth providers, magic links, multi-tenant org modeling, RBAC, account recovery flows, email verification, social login.

The two community-standard auth libraries each have a problem for our use case:
- **Lucia** — was the modern TS-native choice, but the maintainer sunset the project in March 2025. New users are told to copy its patterns rather than depend on the package.
- **Auth.js (NextAuth v5)** — robust, but built around the OAuth-provider model. Heavy configuration for a single local password login.
- **Better Auth** — modern TS-native, actively maintained, but designed around features (organizations, 2FA, magic links, social) we explicitly don't want.

For one user with one password, "roll our own" is genuinely ~80 lines of code: `iron-session` for encrypted-cookie session storage, `@node-rs/argon2` for password hashing, a `login()` server action, a `requireUser()` helper used by every server component and route handler.

**Decision**: Roll our own auth using `iron-session` (encrypted cookie session) + `@node-rs/argon2` (password hashing — argon2id variant, current OWASP recommendation). One user, one password, no recovery flow. Password is bootstrapped via a one-time setup wizard on first run.

**Consequences**:
- ✅ Zero dependency on an auth library that might be deprecated/refocused
- ✅ Total visibility into what's happening (no library magic to debug)
- ✅ Aligns with CLAUDE.md §Minimize Dependencies (paraphrasing Maybe's convention 1)
- ✅ No OAuth = no third-party identity providers = stronger privacy posture
- ⚠️ Responsibility for getting hashing parameters right, session rotation, CSRF, and cookie flags is ours
- ⚠️ No "forgot password" — if the user forgets the password, recovery means re-bootstrapping via a CLI command that resets it from the host (acceptable for single-user self-hosted)

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Lucia | Maintainer sunset the project (March 2025). Not safe to adopt new. |
| Auth.js (NextAuth v5) | Heavy, OAuth-centric. Overkill for one password. |
| Better Auth | Modern and good, but its value is the feature set (orgs, 2FA, magic links) we explicitly don't want. |
| Clerk / Auth0 / Supabase Auth | Third-party hosted = privacy violation per CLAUDE.md |

#### UX revision (same day as initial lock)

The library choice stayed, but the UX I initially shipped (email field + `.email()` validation + 12-char minimum password + `/setup` wizard separate from `/login` + 30-day rolling session) was reflexive generic-SaaS pattern. The actual app is single-user, self-hosted, behind Tailscale, never publicly registered. Every one of those defaults adds friction with zero security gain.

**Replaced with**:

- Single `/login` page (the `/setup` route was deleted).
- One password field. No email. No username.
- No minimum length policy. The argon2id hash carries the security weight; a single user on their own hardware can pick whatever password they want.
- First submission with an empty `users` table sets the password (first-run bootstrap). Subsequent submissions verify.
- Session lasts **1 year**, no rolling expiry. You log in once a year, max.
- `users` table dropped the `email` column entirely — there's no second field, and nothing is ever emailed.

**Forgot password recovery**: `make db-reset` (wipes domain rows including the user) → revisit `/login` → first-run flow re-triggers.

**Schema migration applied**: `drizzle/0002_smart_bug.sql` drops `users.email`.

---

### ADR-005 — Chart library: Recharts

**Status**: ✅ Locked 2026-05-25

**Context**:
Phase 1 ships a net-worth dashboard with at minimum: a time-series line chart (net worth over time) and a breakdown table (per account). Phase 5 will add an asset-allocation pie/sankey chart. We need a charting library that works with React Server Components (or degrades cleanly to a Client Component island), has good TypeScript types, and renders crisp, accessible SVG charts without a heavy runtime.

Candidates:
- **Recharts** — React-native, composable component API, mature, huge community. Excellent for standard finance charts (line, bar, area, pie). Lighter footprint than D3-based options.
- **Observable Plot** — Mike Bostock's modern declarative grammar built on D3. Beautiful, terse code, but client-only and the API rewards data-viz fluency we don't need.
- **Chart.js (react-chartjs-2)** — Canvas-based, fast at large data sizes. Less idiomatic in React; canvas charts are harder to make accessible.
- **Visx** (Airbnb) — Low-level D3 primitives wrapped for React. Powerful, but more code per chart.

**Decision**: Recharts.

**Consequences**:
- ✅ Idiomatic React; charts are JSX components composed of `<LineChart>`, `<XAxis>`, `<Tooltip>` etc.
- ✅ SVG output → accessible, copyable, printable
- ✅ Quick to ship Phase 1's net-worth chart; quick to ship Phase 5's allocation chart
- ✅ Client Component island (`'use client'`) — server renders the wrapper, client renders the SVG. Standard pattern.
- ⚠️ For Phase 5's sankey diagram, Recharts is weaker — we may pull in a focused library (`@nivo/sankey` or roll one with D3) at that point. Not a blocker for Phase 1.
- ⚠️ Bundle size is ~95 KB gzipped — fine for a self-hosted single-user app, would matter more for public SaaS

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Observable Plot | Beautiful but client-only and the declarative grammar is overkill for our small chart count |
| Chart.js | Canvas accessibility is worse; less React-idiomatic |
| Visx | More code per chart; better suited if we had 20+ unique visualizations |
| D3 direct | Too much manual work for standard chart types |

---

## Phase 0 — Bedrock

### Goal

A working, authenticated, empty Next.js 15 app with Postgres + Redis running in Docker Compose, Drizzle migrations wired up, Biome configured, and `pnpm dev` launching at `localhost:3000` with a login screen.

### Tasks

- [ ] **P0-01** — Initialize repo skeleton. Run `pnpm init`, add `package.json` with `"type": "module"`, set Node engine to `>=22`. Commit `.gitignore` (node_modules, .env*, .next, dist, drizzle/*.sql.tmp). → Verify: `pnpm -v` and `node -v` both work; `git status` shows clean state after first commit.
- [ ] **P0-02** — Add Next.js 15 + TypeScript + Tailwind v4. Run `pnpm create next-app@latest . --typescript --tailwind --app --src-dir --use-pnpm --no-eslint --no-import-alias` and reconcile with existing files (keep our `package.json` `"type": "module"`). → Verify: `pnpm dev` shows the default Next.js page at `localhost:3000`.
- [ ] **P0-03** — Replace ESLint setup with Biome. Run `pnpm add -D @biomejs/biome`, create `biome.json` enabling recommended rules + `organizeImports`, add `pnpm format` and `pnpm check` scripts. Delete any `.eslintrc*` files Next created. → Verify: `pnpm check` runs and reports zero errors on the scaffolded code.
- [ ] **P0-04** — Configure strict TypeScript per CLAUDE.md. Edit `tsconfig.json` to ensure `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noImplicitOverride": true`. → Verify: `pnpm exec tsc --noEmit` passes.
- [ ] **P0-05** — Add Docker Compose with Postgres + Redis. Create `docker/compose.yaml` defining `postgres:16-alpine` (port internal only, named volume), `redis:7-alpine` (port internal only). Create `.env.example` with `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `MONEY_ENCRYPTION_KEY` placeholders. → Verify: `docker compose -f docker/compose.yaml up -d` brings both healthy; `docker compose ps` shows both `(healthy)`.
- [ ] **P0-06** — Wire Drizzle ORM + Postgres client. `pnpm add drizzle-orm postgres`, `pnpm add -D drizzle-kit`. Create `src/db/client.ts` exporting a `db` Drizzle instance. Create `drizzle.config.ts` pointing at `./src/db/schema/*` and `./drizzle/migrations`. Create empty `src/db/schema/index.ts`. → Verify: `pnpm exec drizzle-kit check` runs without error.
- [ ] **P0-07** — Add a smoke `users` table + first migration. Create `src/db/schema/users.ts` with `users` table (id uuid PK, email text unique, password_hash text, created_at timestamptz). Re-export from `src/db/schema/index.ts`. Run `pnpm exec drizzle-kit generate` and commit the SQL. → Verify: `pnpm exec drizzle-kit migrate` runs against the dev Postgres container without error and the `users` table exists (`docker compose exec postgres psql -U postgres -d money -c '\d users'`).
- [ ] **P0-08** — Build the auth module per ADR-004. `pnpm add iron-session @node-rs/argon2`. Create `src/lib/auth/session.ts` (iron-session config), `src/lib/auth/password.ts` (argon2id hash + verify), `src/lib/auth/require-user.ts` (server-component helper that redirects to `/login` if no session). → Verify: unit tests in `src/lib/auth/password.test.ts` confirm hash/verify roundtrip.
- [ ] **P0-09** — Build the first-run setup wizard. Create `src/app/setup/page.tsx` (server component) that detects "no users exist" and renders a form; create a `bootstrapUser(formData)` server action that creates the single user record. If a user already exists, redirect to `/login`. → Verify: starting with an empty DB, visiting `/` redirects to `/setup`; submitting the form creates a row in `users`; subsequent visits to `/setup` redirect to `/login`.
- [ ] **P0-10** — Build login + logout. Create `src/app/login/page.tsx` with a form, `loginAction(formData)` server action that verifies password and sets session, `src/app/logout/route.ts` POST handler that destroys session. → Verify: full flow login → see authenticated index → logout works in a browser.
- [ ] **P0-11** — Add Vitest + write the first business-logic test. `pnpm add -D vitest @vitest/coverage-v8 jsdom`. Create `vitest.config.ts` with separate node + jsdom environments. Add `pnpm test` script. → Verify: `pnpm test` runs the password test from P0-08 green.
- [ ] **P0-12** — Add Playwright + write the first E2E (setup → login). `pnpm add -D @playwright/test && pnpm exec playwright install chromium`. Create `playwright.config.ts` and `e2e/auth.spec.ts` that walks the setup → login → see authenticated page flow. → Verify: `pnpm exec playwright test` passes against a freshly-reset DB.
- [ ] **P0-13** — Add BullMQ worker scaffolding. `pnpm add bullmq ioredis`. Create `src/worker/index.ts` (entry point with one no-op repeatable job logged every 60s) and `src/lib/queue/queues.ts` (queue definitions). Add `pnpm worker` script (`node --env-file=.env.local --experimental-strip-types src/worker/index.ts`). → Verify: running `pnpm worker` connects to Redis and logs the heartbeat at least twice.
- [ ] **P0-14** — Build the Dockerfile. Multi-stage Dockerfile producing two entrypoints (web and worker) from the same image. Add `app` and `worker` services to `docker/compose.yaml`. → Verify: `docker compose -f docker/compose.yaml --profile prod build` produces both images; `docker compose --profile prod up` runs all four services healthy.
- [ ] **P0-15** — Write `README.md` covering: prerequisites, `.env.local` setup, dev workflow (`pnpm dev` + `pnpm worker`), test commands, deployment-via-compose note (no public-exposure config yet — that's Phase 6). → Verify: a fresh checkout following only the README steps reaches a working `localhost:3000`.

### Phase 0 Done When

- [ ] `pnpm dev` launches the app; an unauthenticated visit to `/` redirects to `/login` (or `/setup` if no user exists)
- [ ] `pnpm worker` runs the BullMQ worker against Redis
- [ ] `pnpm test` runs Vitest unit tests; `pnpm exec playwright test` runs the auth E2E
- [ ] `pnpm check` runs Biome + `tsc --noEmit`, both clean
- [ ] `docker compose --profile prod up` runs the full four-service stack from images
- [ ] README walks a new machine through to a working dev env

---

## Phase 1 — Manual Entry + First Net-Worth Chart

### Goal

The user can create every account from FEATURE.md (M&T checking/savings, credit card, Fidelity, iTrust, Sunwest mortgage, Home), enter balances/holdings/mortgage parameters manually, and see a real-time net-worth value plus a daily-snapshot line chart.

### Tasks

- [ ] **P1-01** — Create money helper module. Create `src/lib/money/money.ts` wrapping `decimal.js` (`pnpm add decimal.js`). Export `Money` class with `add`, `sub`, `mul`, `div`, `format(locale, currency)`, `fromString`, `toString`. All money math goes through this; no native `+ - * /` on money values. → Verify: `src/lib/money/money.test.ts` covers roundtrip, locale-aware formatting, and known float-precision pitfalls (0.1 + 0.2 = 0.3 exactly).
- [ ] **P1-02** — Create mortgage amortization helper. Create `src/lib/mortgage/amortization.ts` exporting `monthlyPayment(principal, annualRate, termMonths)` and `balanceAtMonth(principal, annualRate, termMonths, monthsElapsed)`. All math uses `Money`/`Decimal`. → Verify: `src/lib/mortgage/amortization.test.ts` matches known reference values (e.g., $200,000 @ 6% / 360 months → $1,199.10/mo, balance at month 60 ≈ $186,108).
- [ ] **P1-03** — Define core schema. Create schema files in `src/db/schema/` per CLAUDE.md §Schema Invariants and IDEAS.md §6: `accounts.ts`, `holdings.ts`, `securities.ts`, `entries.ts` (transactions), `prices.ts`, `account_snapshots.ts`, `liabilities.ts`, `fx_rates.ts`. Use `pgTable`; money columns are `numeric({precision:18, scale:2})`; quantities are `numeric({precision:28, scale:8})`; UUID PKs; `timestamp({withTimezone:true})`. Add `asset_class` enum: `'equity' | 'crypto' | 'physical_metal' | 'cash' | 'property'`. → Verify: `pnpm exec drizzle-kit generate` produces a clean migration; `pnpm exec drizzle-kit migrate` applies it; `\dt` in psql lists all tables.
- [ ] **P1-04** — Create branded ID types and shared Zod schemas. Create `src/lib/types/ids.ts` with branded `AccountId`, `HoldingId`, etc. Create `src/lib/schemas/account.ts` with Zod schemas for create/update account inputs. → Verify: TS compile catches a deliberate misuse (e.g., passing a `HoldingId` where `AccountId` is expected).
- [ ] **P1-05** — Build the Accounts list + create page. `src/app/accounts/page.tsx` (server component, lists all accounts in a table) + `src/app/accounts/new/page.tsx` (form: name, institution, type, currency). Server action `createAccount(formData)` validates with Zod and inserts via Drizzle. → Verify: in a browser, create an "M&T Checking" account; it appears in the list; refresh persists.
- [ ] **P1-06** — Build the Balance entry flow. On the account detail page (`src/app/accounts/[id]/page.tsx`), show current balance and a "Record balance" form. Submitting writes a row to `account_snapshots` for today's date with the entered amount. → Verify: enter a balance for an account; reload page shows it; psql `SELECT * FROM account_snapshots` confirms the row.
- [ ] **P1-07** — Build the Holdings entry flow (with `physical_metal` support). On account detail pages of type `investment` or `crypto_ira`, show a "Add holding" form with fields: symbol, quantity, quantity_unit (dropdown: shares/coin/troy_oz), asset_class, cost_basis (optional). For iTrust gold: symbol=`XAU`, asset_class=`physical_metal`, quantity_unit=`troy_oz`. → Verify: add 5 troy oz of XAU to a manually-created iTrust account; row exists in `holdings`.
- [ ] **P1-08** — Build the Mortgage setup flow. Mortgage is a special account type. Form fields: principal at origination, annual rate, term months, start date. Stored in `liabilities`. Account detail page computes current balance via `balanceAtMonth(...)` based on months elapsed since `start_date`. → Verify: enter Sunwest mortgage as $X @ Y% / Z months started date W; computed balance matches a manual amortization calculator.
- [ ] **P1-09** — Build the Home value flow. Home is a `property` account type. Form: current estimated value + valuation date. Stored as the most recent `account_snapshots` row. → Verify: enter a home value; dashboard reflects it.
- [ ] **P1-10** — Implement `computeNetWorth(asOf: Date)` server function. Sum the most-recent `account_snapshots.balance` per account on or before `asOf`. Subtract liability balances. Return a `Money` object. → Verify: `src/lib/net-worth/compute.test.ts` covers: no accounts → $0; one positive + one liability → correct delta; missing snapshot for an account → uses last known.
- [ ] **P1-11** — Add the nightly snapshot job. In `src/worker/jobs/compute-snapshots-daily.ts`: BullMQ repeatable job running at 02:00 local. For each account: write today's snapshot (for cash/property: copy most-recent manual entry; for holdings-based: sum `holding.quantity × latest_price` from `prices` table — prices will be empty in Phase 1, so fall back to most-recent manual balance entry). Idempotent via `ON CONFLICT (account_id, date) DO UPDATE`. → Verify: run the job manually (`pnpm worker --run-once compute-snapshots-daily`); `account_snapshots` has one row per account for today; running again does not duplicate.
- [ ] **P1-12** — Build the dashboard page. `src/app/page.tsx` (server component, behind `requireUser()`). Renders: (a) current net-worth number large, (b) a Recharts `<LineChart>` of net worth over the last 90/365/all days (selectable via URL search param), (c) a table of accounts grouped by type with current balances. Per ADR-005 the chart is a `'use client'` island. → Verify: enter manual snapshots for 5 days; chart shows 5 data points trending correctly; toggling 90/365/all updates the chart.
- [ ] **P1-13** — Wire navigation + layout. `src/app/layout.tsx` has authenticated header with: app name, dashboard link, accounts link, logout. Apply Tailwind design tokens consistently. → Verify: browser nav works; logout returns to login.
- [ ] **P1-14** — Write Phase 1 E2E test. `e2e/phase1.spec.ts`: setup → login → create checking account → enter $5,000 balance → create mortgage → see net worth on dashboard. → Verify: `pnpm exec playwright test e2e/phase1.spec.ts` passes.

### Phase 1 Done When

- [ ] All seven real account types from FEATURE.md can be created and have balances/holdings/mortgage params entered manually
- [ ] Dashboard shows a single, correct net-worth number (assets minus liabilities)
- [ ] Dashboard line chart renders historical snapshots from `account_snapshots`
- [ ] Nightly snapshot job runs idempotently and produces one row per account per day
- [ ] Mortgage balance updates automatically each month via amortization math (no manual entry needed after setup)
- [ ] `pnpm test` (Vitest) and `pnpm exec playwright test` both green
- [ ] Schema diagram in `docs/schema.md` matches the actual Drizzle schema (auto-generate if practical, manual otherwise)

---

## Skills Map (per task cluster)

Per [SKILLS.md](SKILLS.md), invoke these skills at the moments below. Don't load them all upfront.

| Task cluster | Primary skill(s) |
|---|---|
| P0-01 → P0-02 (repo + Next.js) | `nextjs-app-router-patterns` |
| P0-03 → P0-04 (Biome + tsconfig) | `typescript-pro` |
| P0-05 (Docker Compose) | `docker-expert` |
| P0-06 → P0-07 (Drizzle + first migration) | `drizzle-orm-expert`, `postgres-best-practices` |
| P0-08 → P0-10 (auth) | `auth-implementation-patterns`, `secrets-management` |
| P0-11 → P0-12 (test runners) | `test-driven-development`, `e2e-testing-patterns` |
| P0-13 (BullMQ worker) | `bullmq-specialist` |
| P0-14 → P0-15 (Dockerfile + README) | `docker-expert` |
| P1-01 → P1-02 (money + amortization) | `test-driven-development`, `typescript-pro` |
| P1-03 → P1-04 (schema + branded types) | `drizzle-orm-expert`, `postgres-best-practices`, `typescript-pro` |
| P1-05 → P1-09 (CRUD UIs) | `nextjs-app-router-patterns`, `zod-validation-expert`, `tailwind-patterns` |
| P1-10 → P1-11 (net-worth + snapshot job) | `bullmq-specialist`, `test-driven-development` |
| P1-12 → P1-13 (dashboard + chart) | `nextjs-app-router-patterns`, `tailwind-patterns` |
| P1-14 (E2E) | `e2e-testing-patterns` |

---

## Open Items (out of scope for this plan, captured for future PLAN docs)

- **Phase 2** (market data): `src/worker/jobs/fetch-prices-daily.ts` + `prices` table population from yahoo-finance2 (equities + metals via `GC=F` etc.) / CoinGecko. Will update `computeNetWorth` to use prices for holdings.
- **Phase 3** (QFX/CSV import): file upload UI + parser + dedupe via `(account_id, fitid)` + import-preview UI.
- **Phase 4** (Plaid push): the big one. Link flow, encrypted token store, webhook handler, sync jobs. Re-read `plaid-fintech` skill and the CLAUDE.md §Plaid Safety Rules before starting. Trigger `threat-modeling-expert` STRIDE pass before exposing webhook publicly.
- **Phase 5** (investments depth): lot-level cost basis, dividend tracking, allocation chart.
- **Phase 6** (polish + deploy): mobile responsive, beancount export, public exposure (Cloudflare Tunnel or Tailscale — ADR-006 needed at that time), pg_dump backup job with age encryption.

---

## Decision-Log Updates (completed 2026-05-25)

ADR-004 and ADR-005 were appended to IDEAS.md §11 Decision Log; rows 11 and 12 of the original Decision Log were marked resolved (pointing at ADR-004 and ADR-005 respectively). No further action required.

---

*End of PLAN0_1.md*
