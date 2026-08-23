# my-money — SKILLS

> Curated list of skills from `C:\Users\Robert\AppData\Roaming\Antigravity\skills\skills\` that apply to
> designing, building, testing, and securing my-money. Filtered against the locked ADRs in
> [IDEAS.md](IDEAS.md) and the guardrails in [../../CLAUDE.md](../../CLAUDE.md).
>
> Each skill is annotated with **why it fits this project** and **when to invoke it**.
> A skill is only useful if invoked at the right moment — see the §Suggested Workflow at the bottom.
>
> **Last catalog review: 2026-08-23** — 1,936 skills scanned. Every Tier-1/Tier-2 pick from the
> original pass was re-verified as still present in the catalog; none were renamed or removed.
> New entries from this pass are marked 🆕. The review was aimed at the next chapter of this app:
> **deeper automation and genuinely helpful family/personal money management.**

---

## Already in use (do not re-invoke)

These shaped existing artifacts; their guidance is already encoded in the docs.

| Skill | Where it's already applied |
|---|---|
| `brainstorming` | IDEAS.md structure (Understanding Lock, alternatives, decision log) |
| `multi-agent-brainstorming` | Skeptic + Constraint Guardian passes embedded in IDEAS.md option matrices |
| `plan-writing` | Drives the PLAN*.md format (now PLAN0_1 → PLAN15) |
| `concise-planning` | Drives PLAN*.md task atomicity |
| `plaid-fintech` | Source of CRITICAL/ERROR rules in CLAUDE.md → §Plaid Safety Rules |
| `alpha-vantage` | Source of "cache nightly" pattern (still in use). AV itself was dropped 2026-05-27 — metals now use Yahoo. See IDEAS.md §5.3. |

---

## Tier 1 — Mandatory (exact stack matches)

1:1 fits with the ADR-003 stack. Each one owns a specific subsystem; invoke when working in that subsystem.

| Skill | Why mandatory | Invoke during |
|---|---|---|
| `drizzle-orm-expert` | Drizzle is our ORM (ADR-003). Schema files, relational queries, migrations. | Every schema change |
| `nextjs-app-router-patterns` | Next.js 15 App Router (ADR-003). Server vs. Client Components, route handlers, server actions. | Every UI / route work session |
| `postgres-best-practices` | Postgres-only (ADR-002). Schema design, indexing, money-precision conventions. | Any new table; any index decision |
| `bullmq-specialist` | Our job queue (ADR-003). Idempotency, retries, repeatable jobs. | Every new worker job |
| `zod-validation-expert` | CLAUDE.md mandates validation at boundaries. Uploads, server-action inputs, env vars, Plaid webhook bodies. | Every importer + every server action |
| `e2e-testing-patterns` | Playwright covers the critical flows per CLAUDE.md §Testing Philosophy. | Whenever a critical flow changes |
| 🆕 `vitest-skill` | **Gap in the original pass.** ADR-003 locks Vitest as *the* unit/integration runner and the repo now has ~100 `*.test.ts` files, but no Vitest-specific skill was listed — only the generic `test-driven-development`. This one covers `vi.mock` factories, typed `vi.fn<TArgs, TReturn>()`, fake timers, and per-file environment pragmas, which is exactly the surface CLAUDE.md §Vitest prescribes. | Writing or repairing any test; especially mocking `@/db/client.ts` and the price fetchers |
| 🆕 `drizzle-migration-conflict` | Exact-tool match, and now load-bearing: migrations are locked, work happens on feature branches merged via PRs, and two branches generating migrations independently corrupts the `drizzle/meta/_journal.json` + snapshot pair. Diagnoses and repairs exactly that. | Any time a branch merge touches `drizzle/`, or `db:generate` produces a surprising diff |

---

## Tier 2 — Strongly recommended (high leverage for our domain)

Not strictly required, but address known pain points or sharpen quality on the riskier surfaces of a financial app.

| Skill | Why it matters here | Invoke during |
|---|---|---|
| `architecture-decision-records` | We're at ADR-035 and counting. Keeps new ADRs consistent with the locked ones. | When a new significant decision arises |
| `threat-modeling-expert` | The app holds encrypted Plaid credentials for all accounts, plus household member data. STRIDE/PASTA on the token store + webhook surface + self-hosted exposure. | Before any new external integration |
| `007` | Broader companion: STRIDE/PASTA + OWASP + infra security in one pass. Runs across the whole repo. | Pre-deploy; before opening any tunnel |
| `secrets-management` | `MONEY_ENCRYPTION_KEY` rotation policy, env-var hygiene, never-log-secrets discipline. *Adapt principles; ignore the Vault/AWS-Secrets-Manager specifics — we're self-hosted.* | Key rotation work (`plaid:rotate-key`) |
| `auth-implementation-patterns` | ADR-004 is locked (iron-session + argon2id), but session/cookie/CSRF hygiene still needs review as new routes appear. | New authenticated surfaces |
| `test-driven-development` | The "always-test surfaces" in CLAUDE.md (money helpers, amortization, parsers, webhook verification, forecast math) are pure functions with crisp inputs/outputs. | New pure-function modules — pair with 🆕 `vitest-skill` above |
| `typescript-pro` | Money-as-string-not-number, branded types for `AccountId` vs `HoldingId`, discriminated unions for `asset_class`. | Type derivation work |
| `docker-expert` | Compose stack: app + worker + Postgres + Redis + Caddy. ARM64 build for Pi. Multi-stage Dockerfile. | Deployment work |
| `tailwind-patterns` | Design tokens, dark mode, responsive dashboard. | UI work |
| `systematic-debugging` | When Plaid webhooks misbehave or `account_snapshots` shows a wrong number, a disciplined protocol matters more than for a typical CRUD app. | Reactive — when something breaks |

---

## 🆕 Tier 2A — The automation & family-management push (added 2026-08-23)

The app has outgrown the original Phase 0–6 framing. It now carries `src/lib/advice`, `alerts`,
`analytics/forecast`, `budgets`, `categorization`, `household`, `export`, `search`, and `watchlist`.
The next chapter — more automation, more genuinely useful family money management — opens four
surfaces the original SKILLS.md pass didn't cover. These are the skills that own them.

### A. On-device intelligence (categorization, advice, forecasting)

> ⚠️ **Gate before any of these.** CLAUDE.md §Privacy is unambiguous: financial data is **never** sent
> to OpenAI, Anthropic, Gemini, or any hosted LLM. If AI features are ever added they must run against
> a **locally-hosted** model. Per CLAUDE.md §When in Doubt, that's significant enough to be a future
> regret — so **propose a new ADR in IDEAS.md before writing code**, not after. The existing
> rules-based `src/lib/categorization` and deterministic `src/lib/advice` remain the default; these
> skills are for the case where a decision is made to go further.

| Skill | Why it fits | Invoke during | Caveats |
|---|---|---|---|
| `transformers-js` | **The best-fit option, and the one to try first.** Runs ONNX models directly in Node/TS — in-process, no server, no egress at all. A small text-classification model over payee strings would extend `src/lib/categorization` past what regex rules reach, while keeping the egress budget at literally zero (the same property `src/lib/household` already asserts). No new container, no new daemon, no ADR-scale infra change. | Auto-categorization beyond `rule-from-payee.ts`; payee normalization/clustering | Model weights must be vendored or pinned locally — no runtime download from a CDN onto the user's box |
| `local-llm-expert` | The **gatekeeper skill** for any true LLM feature: Ollama / llama.cpp / vLLM / LM Studio, model selection, VRAM budgeting, GGUF quantization. This is the *only* sanctioned path to AI in this codebase, and it's the skill that answers "will this even run on a NAS/Pi?" — which is the question that decides the ADR. | Evaluating whether a local model is viable *before* proposing the ADR | Answer the hardware question honestly. A model that needs a GPU the user doesn't have is a "no", not a "later" |
| `llm-structured-output` | If a local model does ship, its output must be a typed object validated by Zod, never free text — schema-constrained/grammar-constrained decoding is how you get that reliably. | Designing the model→Zod boundary | **Its examples target OpenAI/Anthropic/Google APIs — those are forbidden here.** Take only the schema-constraint and grammar techniques; apply them to the local runtime |

### B. Family-facing surfaces (the "family" in family money management)

| Skill | Why it fits | Invoke during |
|---|---|---|
| `progressive-web-app` | Family money management happens on phones, standing in a store — not at a desk. Installability, a web app manifest, service-worker caching, and an offline read path for the dashboard turn this from "a site on the NAS" into something reachable. Pairs naturally with the existing Tailscale/tunnel deployment story. | A dedicated mobile-reach phase |
| `fixing-accessibility` | Concrete and remediation-focused: ARIA labels, keyboard navigation, focus management, colour contrast, form errors. The moment a second person in the household uses the app, "works for the developer" stops being the bar. | New interactive controls, dialogs, and forms |
| `kpi-dashboard-design` | The dashboard *is* the product. Patterns for which numbers earn a tile, how to frame trend vs. target, and how to avoid a wall of digits nobody reads — directly applicable to `src/components/dashboard` and the advice/plan surfaces. | Dashboard and `/plan` layout revisions |
| `ui-a11y` / `wcag-audit-patterns` | Audit-shaped companions to `fixing-accessibility`. Use one, not all three — `fixing-accessibility` for fixing, `wcag-audit-patterns` for a formal WCAG 2.2 pass. | A deliberate a11y sweep |

### C. Wider ingestion (more accounts on autopilot)

| Skill | Why it fits | Invoke during |
|---|---|---|
| `pdf-official` | The honest limit of QFX/CSV import is that plenty of institutions — 401(k) providers, HSAs, pensions, some credit unions — only ever hand you a **PDF statement**. This skill covers PDF text and table extraction, which is the missing ingestion path. Feeds the existing parse → preview → confirm flow and the `fitid`-style dedup discipline from CLAUDE.md §Importers. | A PDF-statement importer in `src/lib/importers` |
| `xlsx-official` | Brokerage, 401(k), and payroll exports arrive as `.xlsx` at least as often as CSV. Same importer contract, different parser. | An XLSX importer |
| `data-quality-frameworks` | The concept that matters is the **data contract** — an explicit, versioned assertion about what "valid" means for a row, checked at ingest. That's precisely the reconciliation-diff discipline CLAUDE.md already mandates (`imported_ending_balance − computed_from_transactions`), generalized to snapshots, prices, and holdings. *Adapt the concepts; skip the tooling — Great Expectations and dbt are Python/warehouse tools we're not adding.* Express the expectations as Vitest cases and SQL constraints. | Designing invariant checks for snapshots, prices, and import reconciliation |
| `cron-doctor` | Our nightly chain (`fetch-prices-daily` → `compute-snapshots-daily` → backup) runs on BullMQ **repeatable jobs with cron expressions**. This catches the specific silent failures — expressions that never fire, OR-semantics firing too often, midnight spikes stacking jobs on top of each other. | Any change to a repeatable job's schedule |

### D. Reliability & privacy under automation

More automation means more code running unattended at 3 a.m. with nobody watching.

| Skill | Why it fits | Invoke during |
|---|---|---|
| `error-handling-patterns` | Unattended jobs fail differently than request handlers: partial writes, poisoned retries, errors nobody reads. This covers resilience strategy and — importantly for a single-user app with no SaaS observability — making failures *debuggable later*. Feeds the `failed_jobs` table and `src/lib/alerts`. | Worker job authoring; failure-path review |
| `privacy-by-design` | Turns the CLAUDE.md §Privacy stance from a prose rule into a repeatable review: data minimization, retention, encryption-at-rest, purpose limitation. Newly relevant because `household` rows describe **people**, not money, and every automation added is a new potential egress. The existing `src/lib/search/privacy-egress.test.ts` is this idea in miniature — this skill generalizes it. | Before shipping any feature that touches household data or adds an outbound call |
| `container-security-hardening` | Non-root users, minimal base images, CVE scanning, SBOM. The app is self-hosted and increasingly reachable from outside the LAN; the container is the actual security boundary. *Take the Docker/runtime half; ignore the Kubernetes pod-security half — no K8s here (see §Skipped).* | Dockerfile review; pre-deploy hardening |
| `dependency-management-deps-audit` | For a privacy-first app a compromised transitive dependency **is** a data-egress event — it's the one realistic path by which financial data leaves the box despite every other rule. Vulnerability scanning plus license/supply-chain review of `pnpm-lock.yaml`. | Periodic; and before any dependency bump batch |

---

## Tier 3 — Use as needed (situational)

| Skill | When to reach for it |
|---|---|
| `code-reviewer` | Self-review pass after each phase before declaring it done |
| `code-review-checklist` | Lighter-weight alternative to `code-reviewer` |
| `code-review-excellence` | When a phase touched many files and a structured pass is worth the time |
| `frontend-security-coder` | Upload UI + any form taking user-entered transaction names (XSS in our own data) |
| `backend-security-coder` | Plaid webhook handler hardening |
| `api-security-best-practices` | Only if/when we expose an external API (currently scoped out — single user) |
| `react-state-management` | If/when client-side state needs warrant Zustand (per CLAUDE.md, server components come first) |
| `postgresql-optimization` | When a specific query is measurably slow — premature otherwise |
| `database-migration` | When schema changes require non-trivial data movement (rare; one user) |
| `claude-d3js-skill` | Only if we ever move off Recharts (ADR-005) |
| `typescript-advanced-types` | For intricate Drizzle type derivations (`$inferSelect`, branded types) when stuck |
| `commit` | Standardize commit message format |
| `using-git-worktrees` | Parallel spikes across phases |
| `architecture-patterns` | If importer / Plaid / snapshot subsystems start feeling tangled — Hexagonal makes sense here (institution adapters at the edge) |
| 🆕 `sql-optimization-patterns` | Query-plan analysis and indexing. More concrete than `postgresql-optimization`; reach for it when `perf:dashboard` shows a regression |
| 🆕 `database-optimizer` | Broader companion to the above — use only if `sql-optimization-patterns` doesn't cover the case |
| 🆕 `react-component-performance` | Diagnosing slow client islands — the Recharts wrappers are the likely candidates |
| 🆕 `react-ui-patterns` | Loading/error/empty-state patterns for async UI. Useful as the app gains more streamed and job-backed surfaces |
| 🆕 `redis-cli` | Inspecting and debugging BullMQ queues directly — stuck jobs, orphaned repeatable-job keys, backlog inspection |
| 🆕 `database-migrations-sql-migrations` | Rollback plans and safe column changes. Directly reinforces CLAUDE.md's "never `drop column` without a paired data backup step" |
| 🆕 `codebase-audit-pre-push` | Occasional deep sweep for junk files, dead code, and stray secrets before a push. Heavier than `code-reviewer` — use sparingly |
| 🆕 `privacy-mask` | Redacts balances, account numbers, and PII from **screenshots** via OCR. The right tool before pasting a UI screenshot into any bug report, issue, or forum post. Note `plans/features/checking-transactions.png` already lives in the repo |
| 🆕 `performance-profiling` | Measurement discipline before optimizing — CLAUDE.md §Performance opens with "profile before optimizing" |
| 🆕 `personal-tool-builder` | Framing, not implementation: scratch-your-own-itch scope discipline. Genuinely useful as a counterweight when the automation push starts inventing features nobody asked for |
| 🆕 `data-storytelling` | Narrative framing for the `advice` and `plan` surfaces — turning computed numbers into a sentence a family member acts on. Copy/UX only; the math stays deterministic |
| 🆕 `shadcn` | **Only if** a component library is ever adopted. The UI is hand-rolled Tailwind today and that's working; this would be an ADR-scale change, not a drive-by |

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
| `interactive-portfolio`, `crypto-bd-agent`, `emblemai-crypto-wallet`, `xvary-stock-research` | Adjacent topic, wrong shape — portfolio-display SaaS or wallet building, not a personal tracker |
| `odoo-*`, `laravel-*`, `django-*`, `solidity-*`, `swift-*`, `expo-*`, `android-*`, `ios-*`, `go-*`, `python-*` | Wrong stack (per ADR-003) |
| `posthog-automation`, any analytics SaaS skill | Privacy violation per CLAUDE.md §Privacy & Data Sovereignty |

### 🆕 Name traps — checked in the 2026-08-23 pass, deliberately rejected

These *sound* like they belong in a finance app. They don't. Recorded so nobody chases them twice.

| Skill | Why we skip |
|---|---|
| `monte-carlo-*` (10 skills: `monte-carlo-asset-health`, `-monitoring-advisor`, `-remediation`, …) | **The single biggest name trap in the catalog.** These are for *Monte Carlo Data*, the SaaS data-observability vendor — nothing to do with Monte Carlo *simulation* for retirement projections. They're also hosted SaaS, so doubly disqualified per CLAUDE.md §Privacy. If we ever do probabilistic retirement projections, that's ours to write in `src/lib/analytics` |
| `atlas-ledger`, `time-ledger` | "Ledger" collision. `atlas-ledger` logs agent behavioural drift; `time-ledger` is time tracking. Neither is financial. (And we're not building a general ledger anyway — CLAUDE.md §Domain Scope) |
| `trading-ledger` | A trading *journal* (thesis, emotion, decision grading) that **writes to a third-party Notion database**. Third-party egress of financial data — hard no per CLAUDE.md §Privacy |
| `payment-integration` | Stripe/PayPal checkout and subscriptions. Money movement is explicitly out of scope — this is a read-only tracker |
| `pci-compliance` | We never touch a card PAN. Plaid tokens are covered by CLAUDE.md §Plaid Safety Rules + `secrets-management` |
| `gdpr-data-handling` | Single user holding their own data on their own hardware. No controller/processor relationship exists to comply with |
| `billing-automation`, `startup-financial-modeling`, `startup-business-analyst-financial-projections` | Business/SaaS finance (revenue, ARR, runway). Wrong domain — this is a household tracker |
| `longbridge-market-data` | Third-party HK/US/A-share market SaaS. We use `yahoo-finance2` + CoinGecko cached to the `prices` table (IDEAS.md §5.3) |
| `email-systems`, `gmail-automation`, `mailchimp-automation`, `brevo-automation`, `convertkit-automation` | All **marketing** email. Our `nodemailer` use is transactional self-hosted alerting — a different problem with none of the same concerns |
| `rag-engineer`, `rag-implementation`, `vector-database-engineer`, `embedding-strategies`, `similarity-search-patterns`, `hybrid-search-implementation` | **Deferred, not rejected.** `src/lib/search` uses Postgres full-text/trigram and that is the right call at this data volume. Revisit *only* if semantic search over transaction history becomes a real need — and then only with pgvector + locally-computed embeddings, never a hosted embedding API |
| `data-engineering-data-pipeline`, `ml-engineer`, `machine-learning-ops-ml-pipeline`, `data-engineer` | Warehouse/enterprise scale — Spark, Airflow, feature stores. One user's transaction history fits in a single Postgres table |
| `tanstack-query-expert` | Same reasoning as Zustand in CLAUDE.md: server components handle most state, URL params handle the rest. Only reconsider if a genuinely client-heavy surface appears |
| `security-auditor`, `security-and-hardening`, `security-audit` | Substantial overlap with `007` + `threat-modeling-expert` + the two `*-security-coder` picks already listed. Adding more security skills spreads attention rather than deepening it |
| `i18n-localization` | Single user, USD base currency on the `families` row. FX is a *data* problem (`fx_rates` table), not a localization one |
| `agent-memory`, `agent-*` orchestration skills | About building agent systems, not about this app |
| `radix-ui-design-system` | Same call as `shadcn` — hand-rolled Tailwind is working. Would need an ADR |
| `progressive-estimation` | Name-adjacent to `progressive-web-app`; unrelated (an estimation technique) |

---

## Suggested Workflow

Invoke skills at the moment they pay off — not preemptively.

### Historical phase map (Phases 0–15 — shipped)

Kept compressed for reference. These were the skills that earned their keep on the way here:

- **Phase 0 (bedrock)** — `architecture-decision-records`, `docker-expert`, `drizzle-orm-expert`, `nextjs-app-router-patterns`, `secrets-management`, `auth-implementation-patterns`, `bullmq-specialist`
- **Phase 1 (manual entry + net worth)** — `postgres-best-practices`, `zod-validation-expert`, `typescript-pro`, `test-driven-development`, `tailwind-patterns`
- **Phase 2 (market data)** — `bullmq-specialist`, `zod-validation-expert`
- **Phase 3 (QFX/CSV import)** — `zod-validation-expert`, `frontend-security-coder`, `test-driven-development`
- **Phase 4 (Plaid)** — `plaid-fintech`, `bullmq-specialist`, `backend-security-coder`, `threat-modeling-expert`, `secrets-management`
- **Phase 5 (investment depth)** — `drizzle-orm-expert`, `typescript-pro`
- **Phase 6+ (polish, longevity, and everything through Phase 15)** — `e2e-testing-patterns`, `tailwind-patterns`, `docker-expert`, `bullmq-specialist`, `systematic-debugging`

### 🆕 Current era — automation & family money management (post-Phase-15)

The work ahead is less "add a subsystem" and more "make the existing subsystems act on their own,
and make the result useful to a family." Four tracks, each with its entry skill:

**Track 1 — Smarter categorization & advice**

1. `personal-tool-builder` — sanity-check the feature is actually wanted before building it
2. `transformers-js` — try in-process ONNX classification first; zero egress, no new infra
3. `local-llm-expert` — *only if* step 2 is insufficient; answer the hardware question, then **propose an ADR**
4. `llm-structured-output` + `zod-validation-expert` — constrain output to a typed, validated object
5. `vitest-skill` — a classifier without a fixture-based regression suite is a liability

**Track 2 — Reaching the family**

1. `kpi-dashboard-design` — decide what actually earns a tile before styling it
2. `progressive-web-app` — installable, offline-capable, phone-first
3. `fixing-accessibility` — then `wcag-audit-patterns` for a formal pass
4. `data-storytelling` — narrative copy for `advice` / `plan`
5. `e2e-testing-patterns` — lock the flows a second household member will actually use

**Track 3 — More accounts on autopilot**

1. `pdf-official` / `xlsx-official` — the ingestion formats QFX/CSV can't reach
2. `data-quality-frameworks` — data contracts for reconciliation, expressed as Vitest + SQL constraints
3. `bullmq-specialist` + `cron-doctor` — long imports as jobs; validate every cron expression
4. `zod-validation-expert` — parse at the boundary, as always

**Track 4 — Keeping it trustworthy while it runs unattended**

1. `error-handling-patterns` — failure paths for jobs nobody is watching
2. `privacy-by-design` — run before *any* feature touching household data or adding an outbound call
3. `dependency-management-deps-audit` — the realistic egress path
4. `container-security-hardening` — the container is the security boundary
5. `007` — periodic full-repo pass; still the pre-deploy gate

### Anytime

- `commit` — keep commit messages consistent
- `systematic-debugging` — whenever something is unexpectedly broken
- `architecture-decision-records` — whenever a new significant decision arises
- `drizzle-migration-conflict` — the moment a branch merge touches `drizzle/`
- `privacy-mask` — before any screenshot leaves the machine

---

## Maintenance

- When a Tier-2 or Tier-3 skill gets invoked for real, note it in the relevant PLAN.md task so future sessions know "this skill was the reference."
- When a "Skipped" skill is reconsidered, promote it explicitly — don't silently invoke it. The skip reason is a guardrail. The §Name traps table especially: those were checked, not overlooked.
- If a new skill appears in the catalog that fits a Tier-1 slot better than the current pick, replace it via a brief note in IDEAS.md and update this doc.
- **Anything in §Tier 2A/A (on-device intelligence) requires a new ADR in IDEAS.md before implementation.** That gate is not optional — it's CLAUDE.md §Privacy plus §When in Doubt.

---

*End of SKILLS.md*
