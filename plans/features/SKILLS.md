# my-money — SKILLS

> Curated list of skills from `C:\Users\Robert\AppData\Roaming\Antigravity\skills\skills\` that apply to
> designing, building, testing, and securing my-money. Filtered against the locked ADRs in
> [IDEAS.md](IDEAS.md) and the guardrails in [../../CLAUDE.md](../../CLAUDE.md).
>
> Each skill is annotated with **why it fits this project** and **when to invoke it**.
> A skill is only useful if invoked at the right moment — see the §Suggested Workflow at the bottom.

---

## Already in use (do not re-invoke)

These shaped existing artifacts; their guidance is already encoded in the docs.

| Skill | Where it's already applied |
|---|---|
| `brainstorming` | IDEAS.md structure (Understanding Lock, alternatives, decision log) |
| `multi-agent-brainstorming` | Skeptic + Constraint Guardian passes embedded in IDEAS.md option matrices |
| `plan-writing` | Will drive PLAN.md format |
| `concise-planning` | Will drive PLAN.md task atomicity |
| `plaid-fintech` | Source of CRITICAL/ERROR rules in CLAUDE.md → §Plaid Safety Rules |
| `alpha-vantage` | Source of "cache nightly" pattern (still in use). AV itself was dropped 2026-05-27 — metals now use Yahoo. See IDEAS.md §5.3. |

---

## Tier 1 — Mandatory (exact stack matches)

1:1 fits with the ADR-003 stack. Each one owns a specific subsystem; invoke when working in that subsystem.

| Skill | Why mandatory | Invoke during |
|---|---|---|
| `drizzle-orm-expert` | Drizzle is our ORM (ADR-003). Schema files, relational queries, migrations. | Phase 0 schema scaffold + every schema change |
| `nextjs-app-router-patterns` | Next.js 15 App Router (ADR-003). Server vs. Client Components, route handlers, server actions. | Every UI / route work session |
| `postgres-best-practices` | Postgres-only (ADR-002). Schema design, indexing, money-precision conventions from Supabase. | Phase 1 schema; Phase 4 webhook table indexing |
| `bullmq-specialist` | Our job queue (ADR-003). Idempotency, retries, repeatable jobs. | Phase 1 (snapshot cron) + Phase 4 (Plaid sync jobs) + Phase 6 (backup job) |
| `zod-validation-expert` | CLAUDE.md mandates validation at boundaries. QFX uploads, server-action inputs, env vars, Plaid webhook bodies. | Every importer + every server action |
| `e2e-testing-patterns` | Playwright covers the 3 critical flows per CLAUDE.md §Testing Philosophy. | Phase 1 + Phase 3 + Phase 4 |

---

## Tier 2 — Strongly recommended (high leverage for our domain)

Not strictly required, but address known pain points or sharpen quality on the riskier surfaces of a financial app.

| Skill | Why it matters here | Invoke during |
|---|---|---|
| `architecture-decision-records` | We already have ADR-001/002/003 in IDEAS.md. Formalize the template so future ADRs (auth lib, chart lib, exposure model, etc.) stay consistent. | When a new significant decision arises |
| `threat-modeling-expert` | The app holds encrypted Plaid credentials for all your accounts. STRIDE/PASTA pass on the token store + webhook surface + self-hosted exposure is genuinely needed. | After Phase 0, before Phase 4 Plaid integration |
| `007` | Broader companion: STRIDE/PASTA + OWASP + infra security in one pass. Runs across the whole repo. | Pre-deploy, after Phase 5 is functional, before opening any tunnel |
| `secrets-management` | For `MONEY_ENCRYPTION_KEY` rotation policy, env-var hygiene, never-log-secrets discipline. *Adapt principles; ignore the Vault/AWS-Secrets-Manager specifics — we're self-hosted.* | Phase 0 (.env.example) + Phase 4 (Plaid token store) |
| `auth-implementation-patterns` | ADR-004 candidate: Lucia vs. Auth.js + password hashing + session cookies + CSRF. | Phase 0 auth scaffold |
| `test-driven-development` | The "always-test surfaces" in CLAUDE.md (money helpers, amortization, parsers, webhook verification) are pure functions with crisp inputs/outputs — TDD pays off. | Money helpers + amortization + QFX parser |
| `typescript-pro` | Money-as-string-not-number, branded types for `AccountId` vs `HoldingId`, discriminated unions for `asset_class` — finance rewards strong types. | Phase 1 schema + type derivation |
| `docker-expert` | Compose stack: app + worker + Postgres + Redis + Caddy. ARM64 build for Pi. Multi-stage Dockerfile. | Phase 0 (compose scaffold) + Phase 6 (deployment hardening) |
| `tailwind-patterns` | Phase 1+ UI work — design tokens, dark mode, responsive dashboard. | Phase 1 dashboard + Phase 6 mobile responsive |
| `systematic-debugging` | When (not if) Plaid webhooks misbehave or `account_snapshots` shows a wrong number, a disciplined protocol matters more than for a typical CRUD app. | Reactive — when something breaks |

---

## Tier 3 — Use as needed (situational)

| Skill | When to reach for it |
|---|---|
| `code-reviewer` | Self-review pass after each phase before declaring it done |
| `code-review-checklist` | Lighter-weight alternative to `code-reviewer` |
| `code-review-excellence` | When a phase touched many files and a structured pass is worth the time |
| `frontend-security-coder` | Phase 3 QFX upload UI + any form taking user-entered transaction names (XSS in our own data) |
| `backend-security-coder` | Phase 4 Plaid webhook handler hardening |
| `api-security-best-practices` | Only if/when we expose an external API (currently scoped out — single user) |
| `react-state-management` | If/when client-side state needs warrant Zustand (per CLAUDE.md, server components come first) |
| `postgresql-optimization` | When a specific query is measurably slow — premature otherwise |
| `database-migration` | When schema changes require non-trivial data movement (rare; one user) |
| `claude-d3js-skill` | Only if we pick Observable Plot (D3-based) over Recharts |
| `typescript-advanced-types` | For intricate Drizzle type derivations (`$inferSelect`, branded types) when stuck |
| `commit` | Standardize commit message format from Phase 0 onward |
| `using-git-worktrees` | If you want to spike Phase 5 (investments) in parallel with finishing Phase 4 (Plaid) |
| `architecture-patterns` | If importer / Plaid / snapshot subsystems start feeling tangled — Hexagonal makes sense here (institution adapters at the edge) |

---

## Skipped — looks relevant, doesn't fit our decisions

Explicitly *not* recommended, with the reason recorded so future sessions don't waste time re-evaluating.

| Skill | Why we skip |
|---|---|
| `prisma-expert` | We picked Drizzle, not Prisma (ADR-003) |
| `clerk-auth` | Third-party hosted auth = privacy violation per CLAUDE.md |
| `nextjs-supabase-auth` | Not using Supabase — we self-host Postgres |
| `neon-postgres` | Same — self-hosted, not Neon |
| `monorepo-architect` | Single Next.js app + worker as separate process; not a monorepo |
| `cloud-architect`, `hybrid-cloud-architect`, `kubernetes-architect`, `helm-chart-scaffolding`, `multi-cloud-architecture` | Plain Docker Compose to home server — no cloud, no K8s |
| `observability-engineer`, `grafana-dashboards`, `service-mesh-observability` | Single-user app; the app *is* the dashboard. App-internal Postgres logs are enough at this scale. |
| `event-sourcing-architect`, `saga-orchestration` | Overkill domain patterns for a single-user finance tracker |
| `api-design-principles`, `graphql-architect`, `api-patterns` | No external API surface (scoped out per CLAUDE.md §Domain Scope) |
| `database-migrations-migration-observability` | Premature — solo user, low migration cadence |
| `senior-architect` | The combined `architecture-decision-records` + `architecture-patterns` + Tier-1 stack skills cover what's needed; this one is broad and unfocused |
| `nextjs-best-practices` | Largely overlaps `nextjs-app-router-patterns` — pick the more specific one |
| `react-best-practices`, `react-patterns`, `react-nextjs-development` | Overlap with `nextjs-app-router-patterns` — only invoke if a specific React-side gap emerges |
| `typescript-expert` | `typescript-pro` covers the same ground at lower risk rating |
| `interactive-portfolio`, `crypto-bd-agent`, `emblemai-crypto-wallet`, `xvary-stock-research` | Adjacent topic, wrong shape — these are portfolio-display SaaS or wallet building, not a personal tracker |
| `odoo-*`, `laravel-*`, `django-*`, `solidity-*`, `swift-*`, `expo-*`, `android-*`, `ios-*`, `go-*`, `python-*` | Wrong stack (per ADR-003) |
| `posthog-automation`, any analytics SaaS skill | Privacy violation per CLAUDE.md §Privacy & Data Sovereignty |

---

## Suggested Workflow

Invoke skills at the moment they pay off — not preemptively. This map shows when each Tier-1/Tier-2 skill earns its keep:

### Phase 0 — Bedrock

- `architecture-decision-records` — formalize the ADR template that IDEAS.md is already using informally
- `docker-expert` — Compose stack with app + worker + Postgres + Redis
- `drizzle-orm-expert` — schema files + first migration scaffolding
- `nextjs-app-router-patterns` — App Router boilerplate
- `secrets-management` — `.env.example` design + encryption-key handling policy
- `auth-implementation-patterns` — resolve ADR-004 (Lucia vs. Auth.js) and scaffold session/password handling
- `bullmq-specialist` — worker container + first repeatable job stub

### Phase 1 — Manual entry + first net-worth chart

- `postgres-best-practices` — money column types, indexing strategy
- `zod-validation-expert` — server action input validation
- `typescript-pro` — branded ID types, discriminated `asset_class` union
- `test-driven-development` — write money helper tests first, then implement; same for mortgage amortization
- `tailwind-patterns` — first dashboard layout + design tokens

### Phase 2 — Market data

- `bullmq-specialist` — daily price-fetch job
- `zod-validation-expert` — parse responses from yahoo-finance2 (equities + metals) / CoinGecko at the boundary

### Phase 3 — QFX/CSV import

- `zod-validation-expert` — validate parsed OFX/CSV row shapes
- `frontend-security-coder` — file upload + transaction-name display (XSS surface)
- `test-driven-development` — QFX parser is pure-function territory; high TDD payoff

### Phase 4 — Plaid push (the big one)

- `plaid-fintech` *(already in CLAUDE.md)* — re-read before starting; it's the authoritative checklist
- `bullmq-specialist` — webhook → sync job, with idempotency
- `backend-security-coder` — harden webhook handler + Plaid token store
- `threat-modeling-expert` — STRIDE pass on the entire Plaid surface (link, exchange, store, sync, webhook, error recovery)
- `secrets-management` — confirm encryption-key flow is sound before storing first real token

### Phase 5 — Investment depth

- `drizzle-orm-expert` — schema additions for lots / cost basis
- `typescript-pro` — discriminated holding types (equity vs. crypto vs. physical_metal)

### Pre-deploy (between Phase 5 and Phase 6)

- `007` — full-repo security pass before opening any tunnel
- `code-reviewer` — comprehensive review of everything that hasn't been reviewed yet

### Phase 6 — Polish & longevity

- `e2e-testing-patterns` — lock in the 3 critical Playwright flows
- `tailwind-patterns` — mobile-responsive polish
- `docker-expert` — final deployment hardening (ARM64 build if Pi target, Caddy reverse proxy, Cloudflare Tunnel or Tailscale setup)
- `bullmq-specialist` — backup job + alert job
- `systematic-debugging` — reactive use as issues arise

### Anytime

- `commit` — keep commit messages consistent
- `systematic-debugging` — whenever something is unexpectedly broken
- `architecture-decision-records` — whenever a new significant decision arises

---

## Maintenance

- When a Tier-2 or Tier-3 skill gets invoked for real, note it in the relevant phase's PLAN.md task so future sessions know "this skill was the reference."
- When a "Skipped" skill is reconsidered (e.g., we ever add an external API and want `api-design-principles`), promote it explicitly — don't silently invoke it. The skip reason is a guardrail.
- If a new skill appears in the catalog that fits a Tier-1 slot better than the current pick, replace it via a brief note in IDEAS.md and update this doc.

---

*End of SKILLS.md*
