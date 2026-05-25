# my-money — Agent Rules

## Project Context

You are an expert TypeScript developer working on **my-money**, a self-hosted, single-user personal finance tracker. The user owns their data; the app never phones home, never serves ads, never integrates analytics SaaS, never sells anything.

**Stack (locked by ADRs in [plans/features/IDEAS.md](plans/features/IDEAS.md))**:

- **Language**: TypeScript end-to-end, strict mode
- **Framework**: Next.js 15 (App Router) — single app for UI + API routes + server actions
- **ORM**: Drizzle ORM with `drizzle-kit` migrations
- **Database**: Postgres (containerized alongside the app — never SQLite, never an external SaaS DB)
- **Background jobs**: BullMQ + Redis (containerized)
- **Styling**: Tailwind v4
- **Linting**: Biome (single tool — no ESLint + Prettier)
- **Package manager**: `pnpm` (commit `pnpm-lock.yaml`)
- **Tests**: Vitest for unit/integration; Playwright for the handful of critical user flows
- **Deployment**: Docker Compose, self-hosted on the user's home server/NAS/Pi (Linux, possibly ARM64)
- **Plaid**: official `plaid` Node SDK (the flagship of Plaid's SDKs)
- **Auth** (ADR-004): roll our own with `iron-session` + `@node-rs/argon2` (argon2id). Single user, one password, no OAuth, no email recovery (CLI re-bootstrap if lost). No external identity providers — ever.
- **Charts** (ADR-005): Recharts. Each chart is a `'use client'` island; server renders the wrapper. Sankey deferred to Phase 5 (may pull in `@nivo/sankey` at that point).

**Source-of-truth docs** (consult these before making non-trivial design choices):

1. [plans/features/FEATURE.md](plans/features/FEATURE.md) — what we're building and why
2. [plans/features/IDEAS.md](plans/features/IDEAS.md) — locked ADRs (001 build-from-scratch, 002 web+Postgres, 003 TS/Next/Drizzle, 004 auth, 005 charts), per-institution integration choices, schema sketch, decision log
3. [plans/features/SKILLS.md](plans/features/SKILLS.md) — curated skills catalog mapped to project phases
4. [plans/features/PLAN0_1.md](plans/features/PLAN0_1.md) — Phase 0 (bedrock) + Phase 1 (manual entry + net-worth chart) task breakdown. Future phases get their own `PLAN*.md` files.

**Reference architecture** (read-only inspiration, do NOT copy code from):

- `E:\AntiGravityCode\maybe` — Maybe Finance (Rails). Study its domain model, sync orchestration, and balance-snapshot pattern. Never copy Ruby into this project. Never assume "Maybe does X, so we should too" — Maybe made stack choices we explicitly rejected.

## Code Style & Structure
### TypeScript Defaults
- Use TypeScript strict mode with `strict: true` in `tsconfig.json` — enables `strictNullChecks`, `noImplicitAny`, and other safety checks.
- Use `const` by default; `let` only when reassignment is needed. Never use `var`.
- Use `interface` for object shapes that may be extended and `type` for unions, intersections, and mapped types.
- Prefer `unknown` over `any` — it forces type narrowing before use and catches bugs at compile time.
- Avoid `any` — use `unknown` with type guards when the type is truly unknown.
- Use discriminated unions for state management over boolean flags.
- Prefer small, focused functions under 30 lines. Extract helpers when logic grows.
- Use `readonly` for arrays and properties that should not be mutated.
- Prefer explicit return types on exported functions for documentation and faster type-checking.

### Node.js Modern Built-ins
- Use `--env-file` instead of `dotenv` for loading environment variables.
- Use `node:` prefix for all built-in modules (`node:fs`, `node:path`, `node:crypto`).
- Use `fs/promises` over callback-based `fs` APIs.
- Use `structuredClone()` instead of `JSON.parse(JSON.stringify())`.
- Use `crypto.randomUUID()` instead of `uuid` package.
- Use `AbortController` for cancellable operations.
- Use `node:util.parseArgs()` instead of `commander`/`yargs` for simple CLIs.
- Use `node:worker_threads` for CPU-intensive tasks.
- Use `node:stream/promises` pipeline for stream processing.
- Prefer top-level `await` in ESM modules.
- Use `--experimental-strip-types` (Node 22+) for direct TypeScript execution.

### Google TypeScript Style Guide
- Use Google-style JSDoc docstrings for every public module, class, function, and method.
- Annotate all functions, methods, class members, and variables with specific TypeScript types.
- Structure docstrings with Args, Returns, and Throws sections for parameters, return values, and exceptions.
- Use `interface` for object shapes and `type` for unions/aliases: `interface User { id: string; name: string }` vs `type Status = 'active' | 'inactive'`.
- Write `@param` and `@returns` JSDoc for all public APIs: `/** @param id - User identifier. @returns The user record or null if not found. */`.
- Annotate return types explicitly on public APIs: `async function fetchUser(id: string): Promise<User | null>` — never rely on inference for exported functions.
- Prefer `unknown` over `any`; narrow with type guards: `if (typeof val === 'string') { processString(val); }`.

## Linting & Formatting
### Biome
- Run `biome check --write .` for combined linting + formatting — configure `biome.json` to enable TypeScript-specific lint rules.
- Use Biome's `organizeImports` to auto-sort imports — it replaces separate import-sorting plugins.
- Run `biome ci .` in CI (strict mode, no auto-fix) and `biome check --write .` locally for development auto-fixes.
- Enable recommended rules: `"linter": { "rules": { "recommended": true } }`.
- Use `biome ci` in CI pipelines — it exits non-zero on any violation without auto-fixing.
- Use `biome.json` overrides for file-specific rule configuration (e.g., relaxed rules for test files).

## Styling
### Tailwind CSS
- Use `@apply` in component CSS only as a last resort — prefer utility classes in templates.
- Use the `cn()` (clsx + twMerge) utility for conditional class merging — it resolves Tailwind class conflicts correctly.
- Use `tailwind.config.ts` to define design tokens: colors, spacing, fonts, breakpoints.
- Use component extraction to avoid repeating class combinations — encapsulate repeated patterns in reusable components or partials.
- Use responsive prefixes (`sm:`, `md:`, `lg:`) for mobile-first responsive design.
- Use `dark:` variant for dark mode support. Use `group-*` and `peer-*` for conditional styling.

## Next.js
- Type page props with `{ params: Promise<{ slug: string }>, searchParams: Promise<Record<string, string>> }` — params are async in App Router.
- Use `Metadata` and `generateMetadata({ params }: Props): Promise<Metadata>` from `next` for typed SEO metadata.
- Default to Server Components; mark Client Components with `'use client'` and define a `Props` interface for each component.
- Type API route handlers with `NextRequest` and `NextResponse`: `export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse>>` — avoid `any` in route return types.
- Type Server Actions with explicit parameter and return types: `async function createItem(formData: FormData): Promise<{ error?: string }>`.
- Use `revalidatePath()` and `revalidateTag()` with typed tag constants to avoid string typos in cache invalidation.
- Define route params as a shared type when used across `page.tsx`, `layout.tsx`, and `generateMetadata` in the same segment.
- Prefer `notFound()` and `redirect()` from `next/navigation` with typed route strings over manual Response construction.

## Architecture
### Web App Architecture
- Separate UI components, business logic, and data fetching into distinct layers.
- Choose rendering strategy intentionally: SSR for SEO, CSR for interactivity, SSG for static content.
- Use server-side rendering (SSR) or static generation (SSG) for initial page loads — hydrate on the client for interactivity.
- Implement client-side routing with proper loading and error states for each route.
- Use a state management approach appropriate to complexity — local state first, global store when needed.

## Performance
### Performance Guidelines
- Profile before optimizing — measure, don't guess. Premature optimization wastes time and adds complexity.
- Optimize the critical path first. 90% of performance comes from 10% of the code.
- Cache expensive computations and database queries — use appropriate TTLs and invalidation strategies based on data freshness requirements.
- Cache expensive computations and API calls. Invalidate caches explicitly — stale data is a bug.
- Use lazy loading for non-critical resources and code paths.
- Debounce user-input-driven operations (search, resize, scroll).
- Prefer pagination or virtual scrolling for large data sets — never render 10,000 DOM nodes.

### TypeScript Performance
- Use `for` loops or `for...of` instead of `forEach` or `map` in hot code paths for better performance.
- Avoid unnecessary object allocations inside loops to reduce garbage collection pressure.
- Use `Map` and `Set` for frequent insertions, deletions, and keyed sideups instead of plain objects or arrays.
- Cache results of expensive computations manually or use memoization techniques.
- Avoid synchronous blocking I/O methods; always use async/await equivalents.
- Debounce or throttle high-frequency events to prevent CPU spikes.
- Use `structuredClone` for deep copying instead of `JSON.parse(JSON.stringify())`.

## Testing
### TypeScript Testing
- Write tests alongside source files (`*.test.ts`) or in a `__tests__/` directory.
- Use the Arrange-Act-Assert pattern: set up data, perform the action, verify the result.
- Mock external dependencies (APIs, databases) — test your logic, not the network.
- Use `describe` blocks to group related tests. Use `it` with descriptive names: `it("should return 404 when user not found")`.
- Use typed test fixtures and factories for consistent, type-safe test data.
- Use `beforeEach` for setup and `afterEach` for cleanup — avoid shared mutable state between tests.

### node:test Patterns
> ⚠️ **Not used in this project.** ADR-003 locks Vitest as the unit/integration runner. The `node:test` notes below are kept for reference only — do not introduce `node:test` into the my-money codebase.

- Use `node:test` as the built-in test runner with `describe`/`it` blocks and `node:assert/strict`.
- Use `--watch` flag with `node --test` for test-driven development.
- Use `node:test`'s built-in coverage with `--experimental-test-coverage`.

### React Testing Library
- For TypeScript: Structure tests with describe('ComponentName') and it('descriptive scenario') blocks.
- Render components via render(<ComponentName prop="value" />) and query elements using screen.getByRole('button') or screen.getByText('text').
- Simulate interactions with const user = userEvent.setup(); await user.click(screen.getByRole('button')).
- Assert presence or state with expect(screen.getByText('expected')).toBeInTheDocument().
- Create mock handler functions and verify calls with expect(mockFn).toHaveBeenCalledWith(expectedArgs).
- For TypeScript: Clear all mocks in beforeEach to ensure test isolation and consistent starting state.
- Handle async behavior with waitFor(() => expect(element).toBeInTheDocument()) for updates after interactions.
- Prefer accessible queries like getByRole over getByTestId to mimic real user behavior and improve test resilience.
- Render with required props or context to match real usage and avoid default prop issues.
- Combine multiple assertions in a single test for related user flows.

### Playwright
- Use Playwright for E2E, integration, and browser tests simulating user interactions.
- Write tests in TypeScript for type-safe selectors, actions, and assertions.
- Run tests via `npx playwright test` or npm scripts for local and CI execution.
- Test across Chromium, Firefox, and WebKit browsers for cross-browser reliability.
- Configure playwright.config.ts with baseURL, viewport sizes, and timeouts to match production environments and reduce flakiness.
- Leverage auto-waiting features and expect() assertions for robust, low-maintenance tests without manual sleeps.
- Enable tracing, screenshots, and video capture on failure for efficient debugging of intermittent issues.
- Use getByRole, getByText, or getByTestId locators prioritizing accessibility over fragile selectors.

### Vitest
> ✅ **Project default.** Vitest is the chosen unit/integration runner per ADR-003. Write Vitest tests for new business logic (importers, amortization math, money helpers, sync logic) without needing explicit permission — but keep them focused per the §Testing Philosophy rules below.

- Import core functions as `import { describe, it, expect } from 'vitest';`.
- Use jsdom environment for DOM-related tests and node for others.
- Write focused, isolated test cases.
- Configure Vitest coverage with exclusion patterns and multiple report formats.
- Mock modules with `vi.mock('../db', () => ({ query: vi.fn<[string], Promise<Row[]>>() }))` — use generic type parameters on `vi.fn<TArgs, TReturn>()` for type-safe mock functions.
- Use `vi.spyOn(obj, 'method').mockResolvedValue(result)` to patch individual methods with typed return values.
- Assert async results: `await expect(fetchUser('1')).resolves.toMatchObject({ id: '1', name: expect.any(String) })` and `await expect(fetchUser('')).rejects.toThrow('invalid id')`.
- Use `vi.useFakeTimers()` with `vi.advanceTimersByTime(ms)` to test debounced functions and polling intervals without real delays.
- Configure per-file environment: `// @vitest-environment jsdom` for DOM tests, `// @vitest-environment node` for server-side code.

## Libraries & Tools
### Drizzle ORM
- Define schema in TypeScript with Drizzle's table builders. Infer types with `typeof table.$inferSelect`.
- Use the query builder API for type-safe queries. Use `drizzle-kit` for migrations.
- Use `drizzle-kit push` for dev prototyping and `drizzle-kit generate` + `migrate` for production schema changes with migration files.
- Use relational queries (`.query.table.findMany({ with: { ... } })`) for eager loading related data.
- Use `drizzle-kit push` for rapid development, `drizzle-kit generate` + `migrate` for production.
- Use `.where()` with Drizzle operators (`eq`, `and`, `or`, `like`, `inArray`) for type-safe filtering.
- Keep schema definitions close to the domain — one schema file per module or feature.

### Zod
- Define schemas with `z.object({})` for validation — use `z.infer<typeof schema>` to derive TypeScript types from schemas.
- Validate at system boundaries: API inputs, form data, environment variables, config files — fail fast with descriptive error messages.
- Use `z.enum()` for string literals, `z.discriminatedUnion()` for tagged unions, `z.transform()` for parsing and coercion.
- Use `.parse()` to throw on invalid data, `.safeParse()` to get a Result-like `{ success, data, error }`.
- Compose schemas: use `.extend()`, `.merge()`, `.pick()`, `.omit()` to build variants from base schemas.
- Use `.transform()` for coercion and normalization (trimming strings, parsing dates).

### Zustand
> ⚠️ **Not the default in this project.** Per ADR-003, **server components handle most state**. URL/search params handle navigation/filter state. Only reach for Zustand when a piece of UI state genuinely needs to be shared across unrelated client components — and prefer adding it deliberately rather than scaffolding it on day one. The rules below apply *if and when* Zustand is introduced.

- Create stores with `create()`: define state and actions in a single function. Access with hooks.
- Keep stores small and focused — one store per domain concern, not one global store.
- Use selectors (`useStore(state => state.count)`) to subscribe to specific state slices — prevents unnecessary re-renders from unrelated changes.
- Use selectors to subscribe to specific state slices: `useStore((state) => state.count)` — avoid re-renders from unrelated state changes.
- Use `immer` middleware for immutable updates on deeply nested state.
- Define actions inside the store alongside state — colocate state and the logic that modifies it.
- Use `persist` middleware for localStorage/sessionStorage persistence.

### React Hook Form
- Use `useForm<FormValues>()` with a schema resolver for type-safe, schema-validated forms.
- Use `register()` for uncontrolled inputs, `Controller` for controlled components (Select, DatePicker).
- Use `useFormContext<FormData>()` in nested components with `FormProvider` — maintains full TypeScript types without prop drilling.
- Use `handleSubmit` wrapper — it validates before calling your submit handler.
- Use `formState.errors` for field-level error display. Show errors next to the relevant input.
- Use `watch()` sparingly — prefer `useWatch()` for isolated re-renders on specific fields.
- Use `defaultValues` to initialize forms. Use `reset()` to clear forms after successful submission.

---

## Project-Specific Guardrails (my-money)

These rules supersede the generic guidance above when they conflict. They encode decisions from FEATURE.md, IDEAS.md ADRs, and the `plaid-fintech` skill.

## Domain Scope (Hard Boundaries)

- **In scope**: tracking balances, holdings, transactions, net worth over time, for the single user. Cash accounts, credit cards, brokerage, retirement, crypto, physical metals (gold in IRA), home value, mortgage.
- **Explicitly OUT of scope** — refuse or push back if asked to add these without an explicit decision update to FEATURE.md:
  - Double-entry general ledger / accounting (we are **not** building Quicken or QuickBooks)
  - Tax forms, 1099 generation, capital-gains reporting beyond a simple gain/loss display
  - Bill pay, money movement, ACH initiation (read-only finance app)
  - Budgeting / envelope systems (Phase 6+ at earliest, never without explicit ask)
  - Multi-user, household sharing, permissions, RBAC, family/team modes (single user — `users` table will have exactly one row)
  - Any AI/chat assistant feature that ships user financial data to a third-party LLM API
- **YAGNI ruthlessly**: when in doubt, push back. The user has explicitly said "I am not trying to replace Quicken or Quickbooks."

## Privacy & Data Sovereignty (Non-Negotiable)

This app exists *specifically because* commercial alternatives sell user data. Violating these rules defeats the whole project.

- **No third-party analytics**: no Google Analytics, Posthog Cloud, Segment, Mixpanel, Amplitude, Sentry SaaS, LogRocket, Datadog, etc. Self-hosted observability is fine; SaaS is not.
- **No telemetry**: the app does not call home. No "anonymous usage stats." No "error reporting to vendor." Self-hosted error logs (file or DB) only.
- **No CDN-hosted user data**: fonts/icons can come from CDNs; financial data, account names, balances, never.
- **No third-party AI**: financial data is **never** sent to OpenAI, Anthropic API, Google Gemini, or any hosted LLM. If AI features are ever added, they must run against a locally-hosted model.
- **No marketing pixels, no embedded social, no chat widgets.**
- If you find yourself reaching for a SaaS integration, **stop and ask**.

## Money & Numeric Precision (CRITICAL)

JavaScript numbers are IEEE 754 floats. Money in floats silently loses pennies. This is the #1 way personal-finance projects produce wrong numbers.

- **Postgres**: all money columns are `NUMERIC(18,2)` (or wider scale for quantities like crypto `NUMERIC(28,8)` or troy ounces `NUMERIC(28,4)`). Never `real`, `double precision`, or `float`.
- **Drizzle**: use `numeric({ precision: 18, scale: 2 })` for money columns. Drizzle returns these as `string` by default — **keep them as strings end-to-end**, do not convert to `number` for arithmetic.
- **Arithmetic in TS**: use [`decimal.js`](https://mikemcl.github.io/decimal.js/) or [`big.js`](https://mikemcl.github.io/big.js/) — never native `+ - * /` on money values. A `Money` helper module is mandatory; raw numeric math on money strings is a code smell.
- **Display only**: convert to `Number` only at the final display step (e.g., `Intl.NumberFormat` formatting). Never round-trip through `Number` and back.
- **Currency**: every monetary value carries a currency code. Default `'USD'`. Store the user's base currency on the `families` row.
- **FX**: cross-currency arithmetic must go through the `fx_rates` table at the relevant date. Never hardcode rates.
- **Quantity vs. value**: a holding has *quantity* (shares, coins, troy oz) and a separately-computed *value* (quantity × price-on-date). Snapshot the value; don't recompute on every page load.

## Plaid Safety Rules (from the `plaid-fintech` skill)

These are CRITICAL/ERROR-severity rules — violating them is a security bug, not a style issue.

- **Plaid access tokens MUST be encrypted at rest.** Use `node:crypto` AES-GCM or `libsodium-wrappers` with a key from `process.env.MONEY_ENCRYPTION_KEY`. Never store raw tokens in the DB.
- **Plaid secret/client ID never reaches the browser.** No `NEXT_PUBLIC_PLAID_*` env vars. Plaid API calls happen only in route handlers, server actions, and BullMQ workers.
- **Webhooks MUST verify the `Plaid-Verification` JWT signature** before processing. Use the JWKS endpoint per the skill. Reject unsigned/invalid webhooks with `401`.
- **Webhook handlers MUST be idempotent.** Compute an idempotency hash of `(webhook_type, webhook_code, item_id, body)`, dedupe via a `webhook_log` table.
- **Use `/transactions/sync` with cursor persistence**, never `/transactions/get`. Store the cursor in `plaid_items` and resume on each sync.
- **Handle `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`** by restarting the sync from `null` cursor.
- **Handle item error states** (`ITEM_LOGIN_REQUIRED`, `PENDING_DISCONNECT`, `USER_PERMISSION_REVOKED`) — surface as a notification, drive user through Plaid Link update mode.
- **Use cached balance for display, real-time balance for payment decisions.** Since this is a read-only tracker, we use cached everywhere — but if that ever changes, the rule applies.
- **Link tokens are single-use** — never cache them; create fresh per session.
- **Sandbox does not reflect production complexity** — test webhook flows against Plaid sandbox, but expect production institutions to break in ways sandbox does not.

## Secrets & Environment

- All secrets via env vars loaded with `node --env-file=.env.local` (per the Node.js section above). Never check in `.env*` files; provide a `.env.example` with placeholder values.
- The encryption key (`MONEY_ENCRYPTION_KEY`) is regenerated only via documented rotation flow — losing it bricks all encrypted Plaid tokens.
- Database connection string lives in env; never logged.
- Postgres runs in a Docker network not exposed to the host — only the app and worker containers reach it.

## Background Jobs (BullMQ + Redis)

- **One job per logical unit of work.** Don't batch a nightly snapshot + price fetch + reconciliation into one job — they have different failure modes.
- **Idempotent by design.** A job that runs twice (because Redis hiccupped) must produce the same result as running once. Use `account_snapshots (account_id, date)` as a UNIQUE constraint; use `ON CONFLICT DO UPDATE`.
- **Scheduled jobs via BullMQ repeatable jobs**, not OS cron — keeps scheduling visible inside the app.
- **Standard jobs**:
  - `sync-plaid-item` (triggered by webhook or scheduled retry)
  - `fetch-prices-daily` (nightly, fetches all held symbols)
  - `compute-snapshots-daily` (nightly, after prices, writes `account_snapshots`)
  - `process-qfx-import` (triggered by user upload)
- Failures: retry with exponential backoff; after N attempts surface to a `failed_jobs` table the UI can show.

## Database & Drizzle Specifics

- Schema files in `src/db/schema/` — one file per domain concept (`accounts.ts`, `holdings.ts`, etc.), re-exported from `src/db/schema/index.ts`.
- Use `pgTable` from `drizzle-orm/pg-core` (never `sqliteTable` — we're Postgres-only).
- Timestamps: `timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()`. Store in UTC; convert for display.
- Dates without time (transaction posted date, statement date): `date('posted_at', { mode: 'string' })` — keep as ISO strings.
- Money columns: `numeric('amount', { precision: 18, scale: 2 }).notNull()`. Never `real`.
- `jsonb` for raw Plaid payloads — keep them around for debugging and re-derivation: `jsonb('raw_plaid').notNull()`.
- Every table has a UUID PK: `uuid('id').primaryKey().defaultRandom()`.
- Migrations: `drizzle-kit generate` + `drizzle-kit migrate` in production; `drizzle-kit push` only in local dev when iterating on schema before the first migration is locked.
- **Never `drop column` in a migration without a paired data backup step.** Historical financial data is the entire product.

## Schema Invariants (from IDEAS.md §6)

- `holdings.asset_class` is one of `'equity' | 'crypto' | 'physical_metal' | 'cash' | 'property'` — discriminated union, not a free-text string.
- `holdings.quantity_unit` is one of `'shares' | 'coin' | 'troy_oz' | 'usd'` etc.
- `transactions.fitid` is the OFX/QFX unique ID — used for QFX import deduplication. `(account_id, fitid)` is UNIQUE.
- `prices` has `PRIMARY KEY (symbol, date)` — a single closing price per symbol per date.
- `account_snapshots` has `PRIMARY KEY (account_id, date)` — exactly one snapshot per account per day.

## Importers (QFX/CSV)

- **Idempotency by `fitid`** (OFX) or by `(account_id, posted_at, amount, name)` hash (CSV with no IDs). Re-importing the same statement is a no-op.
- **Parse → preview → confirm** flow. Never silently mutate the DB from a file upload; show the user what will be added/modified/skipped and require a click.
- **Backfill is supported** (per ADR / Decision Log row 15): importers must handle multi-year statement batches without timing out — long imports run in a BullMQ job, not in the request handler.
- **Reconciliation diff**: after import, show `(imported_ending_balance) - (computed_from_transactions)`. A nonzero diff means missing transactions or a parser bug.

## Testing Philosophy (project-specific)

- **Always-test surfaces** (these get Vitest coverage without asking):
  - Money helpers (Decimal wrappers, currency math, FX conversion)
  - Mortgage amortization computation
  - QFX/CSV parsers and dedup logic
  - Plaid webhook signature verification and idempotency
  - `account_snapshots` computation
- **Sparingly-tested surfaces**: pure UI components, server actions that are mostly thin wrappers over Drizzle, layout/style work.
- **Critical Playwright flows** (and only these):
  - First-time setup → create a manual account → enter a balance → see it on the dashboard
  - Upload a QFX → preview → confirm → transactions appear
  - Plaid Link happy path (against Plaid sandbox)
- Don't test framework behavior. Don't test Drizzle itself. Don't write a test "just to have one."

## Repo Layout

```text
my-money/
├── plans/features/        # FEATURE.md, IDEAS.md, PLAN.md — source of truth for decisions
├── src/
│   ├── app/               # Next.js App Router pages, layouts, route handlers
│   ├── components/        # React components (server-first; 'use client' only when needed)
│   ├── db/
│   │   ├── schema/        # Drizzle table definitions, one file per domain concept
│   │   └── client.ts      # Postgres client + Drizzle instance
│   ├── lib/
│   │   ├── money/         # Decimal-based money helpers (mandatory wrapper module)
│   │   ├── plaid/         # Plaid SDK wrapper, encryption, webhook verification
│   │   ├── importers/     # QFX, OFX, CSV parsers
│   │   └── prices/        # Yahoo/CoinGecko/AlphaVantage fetchers, all cached to `prices` table
│   └── worker/            # BullMQ workers — separate entry point, same codebase
├── drizzle/               # generated migrations
├── docker/                # Dockerfile, compose.yaml
├── .env.example
└── CLAUDE.md
```

- The worker and the web app are **separate processes** in production (separate containers in `compose.yaml`) but share the `src/` codebase. No duplicated code.

## Backup Discipline

- Backups are not optional; the app's value is the historical data.
- `pg_dump` runs as a BullMQ scheduled job (or a sidecar container) nightly.
- Dumps are encrypted with `age` using a public key the user controls.
- Dumps land in a documented mount path; user is responsible for off-host replication (Backblaze B2, second disk, etc.).
- Restore runbook lives in `docs/RESTORE.md` and is tested at least quarterly. **An untested backup is not a backup.**

## When in Doubt

1. Re-read [plans/features/IDEAS.md](plans/features/IDEAS.md) §11 Decision Log.
2. If the question isn't covered there, **ask the user** — do not silently pick.
3. If the decision is significant enough to be a future regret, **propose adding it as a new ADR** to IDEAS.md before implementing.
