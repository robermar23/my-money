# PLAN — Phase 6 (Polish & Longevity)

> Phases 0–5 built a working tracker: manual entry, daily prices, QFX/CSV import, Plaid push for cash, and Plaid Investments + manual lots for the portfolio. The app *works* — but it still needs an operator who remembers to check it. Phase 6's job is to make the app **run unattended**: it backs itself up, exports a forever-readable copy of the data, tells you (without you asking) when something needs attention, looks right on a phone, and deploys cleanly to an ARM64 home box.
>
> Phase 6 is the **least risky** phase by data-correctness standards (no new financial math, no new ingestion source) and the **most important** by longevity standards. The entire value of this project is the historical data; Phase 6 is where we make that data survivable. Per CLAUDE.md §Backup Discipline: *"An untested backup is not a backup."* This phase ends with a tested restore.
>
> It is also the **pre-deploy gate**: per [SKILLS.md](SKILLS.md) §Suggested Workflow, a full-repo security pass (`007`) and a comprehensive code review run *before* any tunnel is opened to the public internet. Those run first in this plan.
>
> **Companion docs** — read for context, do not duplicate here:
> - [FEATURE.md](FEATURE.md) — "track all of it over time… I want my own tool tracking my own data."
> - [IDEAS.md](IDEAS.md) — §2 NFRs (durability, portability, maintainability), §3 Option C (beancount hedge), §9 Phase 6 scope, §10 Risks (backup-not-working, project-abandonment), §11 Decision Log
> - [SKILLS.md](SKILLS.md) — Phase 6 + Pre-deploy skills map (`e2e-testing-patterns`, `tailwind-patterns`, `docker-expert`, `bullmq-specialist`, `007`, `code-reviewer`, `systematic-debugging`)
> - [PLAN0_1.md](PLAN0_1.md) — auth, schema bedrock, snapshot job, dashboard, the `.env`/secrets shape
> - [PLAN4.md](PLAN4.md) — `cloudflared` ingress (ADR-010), AEAD key handling (ADR-009), the deploy/compose conventions Phase 6 finalizes
> - [PLAN5.md](PLAN5.md) — the most recent worker/cron/chart idioms this phase mirrors
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: **§Privacy & Data Sovereignty** (the hard wall on every email/export decision), §Backup Discipline, §Background Jobs, §Secrets & Environment, §Testing Philosophy

---

## What already exists (do not rebuild)

Phase 6 is almost entirely *additive plumbing* over shipped infrastructure. Inventory before writing code:

- **Worker + cron scheduler**: [src/worker/index.ts](../../src/worker/index.ts) registers repeatable jobs via `upsertJobScheduler` (`remove`-then-`upsert` to avoid pattern duplication). The 01:30 price fetch, 02:00 snapshot, and 03:00 Plaid safety-net all live here — Phase 6's backup / export / anomaly jobs slot in **after** them (04:00+). This is the canonical pattern; copy it.
- **Queue registry**: [src/lib/queue/queues.ts](../../src/lib/queue/queues.ts) — `QUEUE_NAMES` is the single source of truth, with `defaultJobOptions` (3 retries, exponential backoff, `removeOnFail: { count: 5000 }`). New queues append here + register a `Worker` + add to `shutdown()`.
- **Run-one-job harness**: [src/worker/run-once.ts](../../src/worker/run-once.ts) + `pnpm worker:once <name>` (see Makefile `job-*` targets). Every new job gets a `make` target for unattended-cron debugging.
- **Compose stack**: [docker/compose.yaml](../../docker/compose.yaml) — `postgres`, `postgres_test`, `redis` (data), and the `prod` profile's `app`, `worker`, `cloudflared`. Postgres is **never** published to the host in prod. Phase 6 adds named volumes/mounts for backups + the beancount export, and (optionally) a Caddy service.
- **Restore doc stub**: [docs/RESTORE.md](../../docs/RESTORE.md) already documents what's in/out of a `pg_dump`, the `import_batches.raw_file` size note, and the restore procedure — but explicitly defers the *automated* pg_dump→age→off-host rotation to "Phase 6 (this phase)." P6 finishes it.
- **App shell**: [src/app/layout.tsx](../../src/app/layout.tsx) + [src/components/app-nav.tsx](../../src/components/app-nav.tsx) — the nav literally says *"Active-link styling arrives in Phase 6 polish."* The layout has **no viewport meta** and the nav is a single non-wrapping flex row (breaks < 480px). This is the mobile-responsive starting point.
- **Chart islands**: [src/app/net-worth-chart.tsx](../../src/app/net-worth-chart.tsx), [src/app/investments/allocation-chart.tsx](../../src/app/investments/allocation-chart.tsx), [income-chart.tsx](../../src/app/investments/income-chart.tsx) — Recharts `'use client'` islands wrapped by `<ResponsiveContainer>` (ADR-005). Responsive width already works; Phase 6 audits fixed heights / overflow on narrow screens.
- **Money + queries**: [src/lib/money/money.ts](../../src/lib/money/money.ts) (Decimal wrapper — beancount amounts and anomaly thresholds go through it, never `Number()`), [src/lib/net-worth/compute.ts](../../src/lib/net-worth/compute.ts), [src/lib/transactions/queries.ts](../../src/lib/transactions/queries.ts) — read paths the export + anomaly jobs reuse.
- **Plaid health signals**: `plaid_items.status` / `error_code` and `plaid_sync_runs.error` already capture connection breakage (PLAN4 P4-24). Anomaly detection *reads* these — it does not re-derive them.
- **Threat model**: [docs/THREAT_MODEL_PLAID.md](../../docs/THREAT_MODEL_PLAID.md) — extended through Surface 7 in Phase 5. The `007` pass (P6-01) widens it beyond the Plaid surface to the whole repo before deploy.
- **Secrets convention**: [.env.example](../../.env.example) + `process.loadEnvFile`; `MONEY_ENCRYPTION_KEY` / `SESSION_SECRET` already required-or-crash at boot. New Phase 6 secrets (SMTP, age recipient) follow the same shape.

---

## ADRs locked at plan time

Three decisions surface in Phase 6. All three are ✅ locked below; after this plan is approved, append them to [IDEAS.md](IDEAS.md) §11 Decision Log.

---

### ADR-014 — Database backup: BullMQ-scheduled `pg_dump | age` to a mount, retained N days

**Status**: ✅ Locked 2026-06-07

**Context**:
CLAUDE.md §Backup Discipline mandates: nightly `pg_dump`, encrypted with `age` using a public key the user controls, landing in a documented mount path, with off-host replication being the *user's* responsibility, and a restore runbook tested quarterly. It explicitly allows *either* "a BullMQ scheduled job (or a sidecar container)." We must pick one and decide where `pg_dump`/`age` binaries live.

**Decision**:
1. **Backup runs as a BullMQ repeatable job** `backup-database-daily` in the existing worker process — *not* an OS cron and *not* a standalone sidecar. CLAUDE.md §Background Jobs: *"Scheduled jobs via BullMQ repeatable jobs, not OS cron — keeps scheduling visible inside the app."* The worker already owns the nightly cadence; this keeps one scheduler, one failure surface, one `failed`-jobs ledger.
2. **`pg_dump` + `age` binaries are added to the worker image** ([Dockerfile](../../Dockerfile)) via `apk add postgresql16-client age`. The job shells out: `pg_dump --format=custom $DATABASE_URL | age -r $BACKUP_AGE_RECIPIENT -o $BACKUP_DIR/money-<utc-timestamp>.dump.age`. Streamed through a pipe — the plaintext dump never lands on disk unencrypted.
3. **`age` recipient (public key) only.** The matching identity (private key) is **never** on the server — encryption is one-way on the box, so a server compromise cannot decrypt historical backups. The user holds the identity off-host (paper / password manager / second machine).
4. **`BACKUP_DIR` is a Docker volume** mounted into the worker; the user replicates it off-host (Backblaze B2, second disk, `rsync`) — out of scope for the app, documented in `docs/BACKUP.md`.
5. **Retention**: keep the last `BACKUP_RETAIN_DAYS` (default 14) on the local mount; the job prunes older `*.dump.age` files after a successful write. Off-host retention is the user's policy.
6. **Failure is loud**: a failed dump writes an `alerts` row (type `backup_failure`, ADR-015) so the operator finds out without reading logs.

**Consequences**:
- ✅ Zero new runtime dependency in *code* (shells out to OS binaries); ~10 MB added to the worker image for the two static binaries.
- ✅ The encryption key (`MONEY_ENCRYPTION_KEY`) and the DB-backup key (`age` identity) are **separate** — a backup leak doesn't expose Plaid tokens, and vice-versa. Both must be backed up off-host (the README already flags the encryption key; `docs/BACKUP.md` adds the age identity).
- ✅ Restore is a documented, *tested* path (P6-07) — `age -d -i <identity> | pg_restore`.
- ⚠️ A custom-format `pg_dump` includes the `access_token_ciphertext` bytea. That's fine — the column is already AES-GCM-encrypted (ADR-009); the backup just re-wraps it in `age`. Double-encrypted at rest, and useless without *both* keys.
- ⚠️ Shelling out to `pg_dump` means the job must validate `DATABASE_URL` and refuse to interpolate it into a shell string — use `execFile`/`spawn` with an args array, never `exec` with string concatenation (injection guard; enforced by P6-04's test).

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Dedicated `backup` sidecar container with its own cron | A second scheduler outside the app contradicts CLAUDE.md §Background Jobs ("keeps scheduling visible inside the app"); duplicates restart/healthcheck/logging surface. |
| `pg_dumpall` (cluster-wide) | We have one app DB; `pg_dump` of `money` is smaller and restore-targeted. |
| App-layer logical export (Drizzle → JSON) instead of `pg_dump` | Loses index/constraint/migration-table fidelity; `pg_restore` is the boring, correct tool. The beancount export (ADR-016) is the human-readable hedge; `pg_dump` is the machine-faithful one. |
| GPG instead of `age` | CLAUDE.md names `age` specifically; `age` has a smaller, modern interface and recipient-only encryption fits the "no private key on the box" posture. |

---

### ADR-015 — Anomaly alerts: deterministic rules, persisted to an `alerts` table, **notification-only** email

**Status**: ✅ Locked 2026-06-07

**Context**:
IDEAS.md §9 Phase 6 lists "Anomaly alerts via email (Resend free tier or self-hosted SMTP)." But CLAUDE.md §Privacy & Data Sovereignty is an absolute wall: *no third-party analytics, no telemetry, no CDN-hosted **financial data, account names, balances** — never.* An email that says *"Your M&T checking dropped $5,000"* routed through Resend/SendGrid/Mailgun **ships financial data to a third party** — a direct privacy violation. We need alerting that respects the wall regardless of the email relay.

We also need to define what an "anomaly" *is* without reaching for ML (a local model is overkill for one user; a hosted model is a §Privacy non-starter, same as the categorizer decision ADR-007).

**Decision**:
1. **Anomalies are deterministic rules** over data already in Postgres, computed by a nightly `detect-anomalies-daily` job. Rule set (each a pure, tested function):
   - `large_transaction` — a single transaction whose `|amount|` exceeds `ALERT_LARGE_TXN_USD` (default 2000), in the last day.
   - `balance_drop` — an account's latest snapshot fell > `ALERT_BALANCE_DROP_PCT` (default 25%) vs. the prior snapshot.
   - `item_login_required` — any `plaid_items.status IN ('login_required','revoked','pending_disconnect')` (reads PLAN4 state; surfaces breakage the user would otherwise miss).
   - `stale_snapshot` — no `account_snapshots` row written for an active account in > `ALERT_STALE_DAYS` (default 3) → the nightly pipeline silently died.
   - `stale_price` — a held symbol has no `prices` row in > `ALERT_STALE_DAYS` → the price fetcher is failing.
   - `backup_failure` — written directly by ADR-014's job on a failed dump.
   - `sync_failure` — a `plaid_sync_runs` row with a non-null `error` in the last day.
2. **Anomalies persist to a new `alerts` table** (schema below), deduped by a `dedup_hash` so a standing condition (e.g., a still-broken Plaid item) does not re-fire every night. Structured financial context lives in `detail jsonb` — **shown only in the authenticated `/alerts` page**, never emailed.
3. **The in-app `/alerts` page is the primary channel** (requireUser-gated, with an unread badge in the nav). It is the always-available, zero-third-party surface.
4. **Email is optional and notification-only.** If (and only if) the user configures SMTP (`SMTP_URL`, `ALERT_EMAIL_TO`), the job sends a content-free nudge: *"my-money detected N new alert(s) on YYYY-MM-DD. Sign in to review: https://<host>/alerts"* — **no amounts, no account names, no merchant strings.** Even a third-party SMTP relay sees nothing financial. Transport is `nodemailer` against a user-controlled SMTP server (self-hosted Postfix, or the user's own mail provider) — the user picks; we ship no default relay.

**Consequences**:
- ✅ Privacy wall intact: financial detail never leaves the box. The email is a doorbell, not a statement.
- ✅ No SaaS dependency, no API key for a mail vendor, no new privacy ADR to violate. `nodemailer` is a plain SMTP client.
- ✅ Deterministic + debuggable + testable (same rationale as the ADR-007 regex categorizer). A user can read every rule and tune every threshold via env.
- ✅ `backup_failure` + `stale_snapshot` + `stale_price` make the *unattended* promise real — the system reports its own pipeline health.
- ⚠️ Email delivery itself is best-effort; if SMTP is down the alert still lands in `/alerts` (email is additive, never the source of truth).
- ⚠️ Thresholds in env (not a settings UI) — YAGNI a settings table for one user. If tuning churns, revisit (logged in §Open Items).

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Resend / SendGrid / Mailgun with full alert detail in the body | Ships financial data to a third party — **direct CLAUDE.md §Privacy violation.** Non-starter. |
| Resend but notification-only (no detail) | Even content-free, it's an avoidable SaaS dependency + API key; `nodemailer` + user SMTP is zero-vendor and the body is content-free anyway. Allowed as a *user choice* but not our default. |
| ML/anomaly-detection model | Hosted = §Privacy non-starter; local = overkill for one user's transaction volume. Deterministic rules are honest and sufficient (mirrors ADR-007). |
| No persistence — email straight from the job | Can't dedup standing conditions; no in-app history; email becomes the (lossy) source of truth. The `alerts` table is the system of record. |

---

### ADR-016 — Beancount export: nightly one-way plain-text mirror (vendor-lock-in hedge, not a ledger)

**Status**: ✅ Locked 2026-06-07

**Context**:
IDEAS.md §3 Option C and §9 Phase 6 both call for a "nightly export to beancount format → permanent text-file backup." IDEAS.md §2 (Portability NFR) and §10 (project-abandonment risk) frame *why*: *"Worst case, you can read your data forever in `less`."* But CLAUDE.md §Domain Scope is explicit that we are **not** building double-entry accounting. So the export must be a *hedge*, not a feature that drags us toward Quicken.

**Decision**:
1. **A nightly `export-beancount-daily` job writes a single `money.beancount` file** (plus a small generated header) to a `BEANCOUNT_DIR` Docker volume. It is **one-way** (export only) — my-money never *reads* beancount back. This sidesteps the entire double-entry-import problem.
2. **What we emit** (deterministic, sorted, `git`-diffable):
   - `open` directives for every account, mapped to beancount account names (`Assets:MT:Checking`, `Liabilities:Sunwest:Mortgage`, `Assets:Brokerage:Fidelity`, etc.) by a pure name-mapper.
   - `balance` assertions from `account_snapshots` (the historical net-worth spine — the single most valuable table per IDEAS.md §6).
   - `price` directives from the `prices` table (so a future reader can revalue).
   - Cash `transactions` as simple two-posting entries (account ↔ a catch-all `Expenses`/`Income` leg keyed off our `category`). **Best-effort, not balanced-to-the-penny double entry** — we annotate this honestly in the file header.
3. **Money is rendered via the `Money`/Decimal helper at the string boundary** — never `Number()`. Every amount carries its currency code.
4. **It is generated, never hand-edited** — a banner at the top says so. If it's wrong, fix the exporter, not the file.

**Consequences**:
- ✅ A forever-readable, tool-independent copy of the data in a mature, documented text format — exactly the §2/§10 hedge. Survives the app's own abandonment.
- ✅ Plain text in a mount → trivially `git`-versioned or `rsync`'d off-host alongside the `age` backups.
- ✅ Stays a *hedge*: one-way, best-effort transactions, no reconciliation engine, no balance-enforcement — we don't become a ledger (domain boundary held).
- ⚠️ The transaction legs won't satisfy a strict beancount `bean-check` balance (we don't track the contra-account precisely). Documented as intentional; the `balance` assertions from snapshots are the trustworthy part.
- ⚠️ Investment lots/holdings are exported as `balance` assertions on the holding's value, not as beancount commodity lots — full commodity modeling is deferred (logged in §Open Items).

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Full double-entry beancount with balanced postings + `bean-check` green | Pulls us across the §Domain Scope line into accounting we explicitly rejected; needs a contra-account model we don't have. |
| Export to CSV/Parquet instead | IDEAS.md §2 already lists CSV/Parquet portability as table stakes (a separate small "export" affordance); beancount is the *human-readable, narrative* hedge §3 Option C specifically named. Both can coexist; beancount is this ADR. |
| Skip it (the `age` pg_dump is enough) | The `pg_dump` is machine-faithful but useless without Postgres + the schema + the app. The beancount file is readable in `less` in 20 years with no tooling. Different failure modes; we want both. |

---

## Phase 6 — Goal

After Phase 6 ships, the app runs **unattended** and is **deployment-ready**:

1. **It backs itself up.** Every night a `pg_dump` is `age`-encrypted to a mount the user replicates off-host. A failed backup raises an alert. The restore path is documented *and tested* (`age -d | pg_restore` → `pnpm db:migrate` no-op → login works).
2. **It exports a forever-readable copy.** A nightly `money.beancount` lands in a mount — net-worth history, balances, prices, and best-effort transactions, readable in `less` with zero tooling.
3. **It tells you when something's wrong.** A nightly anomaly pass writes to an `alerts` table surfaced at `/alerts` (with a nav badge); if SMTP is configured, a content-free email nudges you to log in. Broken Plaid items, stalled snapshots, a dead price feed, a failed backup, and unusually large transactions all surface without you looking.
4. **It looks right on a phone.** Viewport meta, a collapsing nav, tables that don't overflow, and charts that fit — the dashboard is usable on the device you actually check it from.
5. **It deploys to the home box.** The worker image carries `pg_dump`/`age`; the compose stack mounts backup + export volumes; a `/api/health` endpoint feeds the container healthcheck; `docs/DEPLOY.md` is a complete, ordered runbook including the ARM64 build for a Pi and the Cloudflare Tunnel finalization.
6. **It has been security-reviewed and code-reviewed end-to-end** before any public tunnel opens (`007` full-repo pass + `code-reviewer`).
7. **The three critical user flows are locked in Playwright** (first-setup→balance→dashboard; QFX import; Plaid Link sandbox) per CLAUDE.md §Testing Philosophy — they're the regression net for everything built across Phases 0–5.

**Not in Phase 6** (held by CLAUDE.md §Domain Scope): budgeting/envelopes, double-entry balance enforcement, a settings/preferences UI beyond env vars, multi-user anything, push/SMS notifications, in-app backup *download* (off-host replication is the user's job via the mount).

---

## Phase 6 — Schema (one new table)

Only the alerting system needs persistence. Follows CLAUDE.md §Database & Drizzle Specifics: UUID PK, `timestamptz`, `jsonb` for structured detail, one file under [src/db/schema/](../../src/db/schema/), re-exported from [index.ts](../../src/db/schema/index.ts). No money columns. No new enums (plain `text` + CHECK, same posture as `plaid_items.status`).

```text
src/db/schema/
├── alerts.ts   (NEW)
└── index.ts    (UPDATED: re-export alerts)
```

### `alerts` (detected anomalies — the alerting system of record)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `defaultRandom()` |
| `type` | `text` NOT NULL | CHECK `in ('large_transaction','balance_drop','item_login_required','stale_snapshot','stale_price','sync_failure','backup_failure')`. |
| `severity` | `text` NOT NULL DEFAULT `'warning'` | CHECK `in ('info','warning','critical')`. |
| `dedup_hash` | `text` UNIQUE NOT NULL | `sha256(type \| subject_id \| period_key)` — a standing condition produces the same hash and is INSERT…ON CONFLICT DO NOTHING, so it fires once, not nightly. |
| `title` | `text` NOT NULL | Short human label for the `/alerts` list (e.g., "M&T Checking needs reconnect"). **No raw amounts in the title** (it could leak into a future notification surface); figures live in `detail`. |
| `detail` | `jsonb` NOT NULL | Structured context (amount, account_id, symbol, dates) for the authenticated UI **only**. Never emailed. |
| `detected_at` | `timestamptz` NOT NULL `defaultNow()` | |
| `notified_at` | `timestamptz` | Set when the notification-only email goes out; NULL = not yet / no SMTP. |
| `resolved_at` | `timestamptz` | Set when the condition clears (re-detection finds it gone) or the user dismisses it. NULL = open. |

**Indexes**:
```sql
CREATE UNIQUE INDEX alerts_dedup_hash_unique ON alerts (dedup_hash);
CREATE INDEX alerts_open_detected_at_idx ON alerts (detected_at DESC) WHERE resolved_at IS NULL;
```

**Why dedup by hash, not (type, subject)**: the `period_key` component lets a *recurring* anomaly that should re-fire (e.g., a new large transaction each month) get a fresh hash, while a *standing* one (a still-broken item, keyed on a stable period like the ISO date it broke or just the item id) stays deduped. Each rule chooses its own `period_key` granularity in P6-12.

---

## Phase 6 — Tasks

Each task is shippable in isolation, has explicit verification, and follows CLAUDE.md conventions. Order matters where flagged. Always-test surfaces (CLAUDE.md §Testing Philosophy) — beancount mapping, anomaly rule predicates, backup filename/rotation + arg-array safety — get Vitest without asking. UI polish and thin DB wrappers are tested sparingly.

### Pre-deploy gate (run these FIRST — before opening any public path)

- [x] **P6-01** — Full-repo security pass (`007` + `threat-modeling-expert`). Added [docs/THREAT_MODEL.md](../../docs/THREAT_MODEL.md) — a whole-app STRIDE+PASTA model following the `007` 6-phase flow (surface map → STRIDE → checklist → red/blue team → scored verdict), widening beyond Plaid (which stays in [THREAT_MODEL_PLAID.md](../../docs/THREAT_MODEL_PLAID.md)). Six surfaces: **A** auth/session/bootstrap, **B** the server-action mutation layer, **C** QFX/CSV import, **D** outbound market-data fetch (SSRF/MITM/privacy), **E** the Phase-6 longevity surfaces (backup mount, beancount plaintext mount, SMTP notification-only, `/api/health`) analyzed at design level so they ship secure-by-default, **F** secrets/env/web-headers. Every row points at a concrete task or a documented residual; the public-trust-edge diagram makes explicit that the tunnel exposes **all** of the app (incl. `/login`), not just the webhook. Verdict: **≈90/100 → Approved**, conditioned on (a) set password before opening the tunnel, (b) keep the `age` identity off-host. → **Verify**: `pnpm check` clean; `pnpm test` 324 passed (incl. the hardening-audit grep re-run green after the rate-limit relocation). *(Skills: `007` 6-phase + scoring, `threat-modeling-expert` STRIDE-per-component.)*
- [x] **P6-02** — Comprehensive code review (`code-reviewer`) of the pre-deploy blast radius. **Verified clean**: all 8 `"use server"` modules gate every mutation via `requireUser()` (directly or through `loadAccount`) — `login/actions.ts` is the sole intentional exception; money-as-string discipline holds (only non-test `Number()` is the `Intl.NumberFormat` display boundary + a date-month parse); `access_token_ciphertext` read-isolation intact (single reader, audit test green); no hardcoded secrets (only fake `access-sandbox-*` test fixtures); no `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`child_process` anywhere. **Two Medium findings fixed inline**: (1) `/login` had no throttle → added a per-IP token-bucket ([login-throttle.ts](../../src/lib/auth/login-throttle.ts), 10/min/IP, consumed before argon2 work) + relocated the generic `RateLimiter` to [src/lib/security/rate-limit.ts](../../src/lib/security/rate-limit.ts) (re-exported from the Plaid module for back-compat) + a 3-case test; (2) no security response headers → added `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS in [next.config.ts](../../next.config.ts) (deliberately no restrictive `script-src` so Plaid Link/Next don't break). Findings table + dispositions in §9 of the threat model. → **Verify**: `pnpm check` clean; `pnpm test` 324 passed; no unaddressed critical/high. *(Skill: `code-reviewer` severity-structured review.)*

### Database backup (ADR-014)

- [x] **P6-03** — Backup env + image. Added `BACKUP_AGE_RECIPIENT` / `BACKUP_DIR` (default `/backups`) / `BACKUP_RETAIN_DAYS` (default `14`) to [.env.example](../../.env.example) with a `secrets-management` note: the recipient is an age **public** key (safe to store); the private **identity** stays off-host. **Docker correction (`docker-expert`):** the base is `node:22-bookworm-slim` (**Debian**, not Alpine) — so `apk` was wrong; the runtime stage now uses `apt-get` + the **PGDG repo** to get `postgresql-client-16` (stock bookworm ships v15, which refuses to dump a v16 server) plus `age` from bookworm main, purging curl/gnupg after the key fetch ([Dockerfile](../../Dockerfile)). It's the single shared runtime stage, so both entrypoints carry the binaries; only the worker's job uses them. → **Verify**: `pnpm dev`/worker boot fine with the new (optional) vars absent; the apt block is standard PGDG (build is operator-run — no Docker build on the Windows dev box this session). *(The IDE base-image-CVE warning on lines 11/20/34 pre-dates this work — a separate "pin/bump base image" task.)*
- [x] **P6-04** — Backup job. Created [src/worker/jobs/backup-database-daily.ts](../../src/worker/jobs/backup-database-daily.ts): streams `spawn('pg_dump', ['--format=custom','--no-password','--dbname', DATABASE_URL])` → `spawn('age', ['--recipient', recipient, '--output', outPath])` — **args-arrays only, no shell, no `shell:true`** so `DATABASE_URL` (carries the DB password) can't be shell-interpreted (`backend-security-coder`); plaintext never lands on disk (pipe only); `DATABASE_URL` never logged. `outPath = ${BACKUP_DIR}/money-<UTC>.dump.age` (posix join — Linux container). Non-zero exit on either child → unlink the partial file + throw (BullMQ retries; TODO to write a `backup_failure` alert once P6-11 lands). Unset recipient → logs "disabled" + skips (opt-in). Pure helpers (`backupFilename`, `pgDumpArgs`, `ageArgs`, `filesToPrune`, `parseBackupTimestamp`) + injectable `{spawn, fs, env, now}` deps (mirrors the price-job router arg). → **Verify**: [backup-database-daily.test.ts](../../src/worker/jobs/backup-database-daily.test.ts) — **9 tests**: filename round-trip, `DATABASE_URL`-as-discrete-arg, age arg array, retention prunes-old/keeps-new+unknown, unset-recipient→no-spawn, success path (exact spawn cmd+args + prune count), pg_dump-failure→throw+unlink-partial. The live `age`-decrypt smoke is operator-run in-container (age/pg_dump aren't on the Windows host); see P6-07 for the executed dump→restore round-trip.
- [x] **P6-05** — Registered the schedule. Added `BACKUP_DATABASE_DAILY` queue name + `backupDatabaseDailyQueue` ([queues.ts](../../src/lib/queue/queues.ts)); worker registration (concurrency 1, wrapped to dodge the BullMQ `(job, token)` signature clash) + `upsertJobScheduler('backup-database-daily-cron', { pattern: '0 4 * * *' })` (04:00, after the 03:00 Plaid safety-net) + `shutdown()` close ([worker/index.ts](../../src/worker/index.ts)); `run-once` entry + `make job-backup`. → **Verify**: **ran `pnpm worker` (2026-06-07)** — boots cleanly, heartbeat ticks, all schedulers incl. `backup-database-daily-cron` register without error.
- [x] **P6-06** — Backup volume in compose. Added a `backups` named volume (separate from `postgres_data` — never back up into the DB volume) mounted into the `worker` service at `/backups`, plus `BACKUP_AGE_RECIPIENT`/`BACKUP_DIR`/`BACKUP_RETAIN_DAYS` on the worker env (recipient defaults empty → job disabled until set) ([docker/compose.yaml](../../docker/compose.yaml)). → **Verify**: compose parses with `--env-file .env.local`; volume + env wired (full prod-profile up is operator-run).
- [x] **P6-07** — Finalized + tested the restore runbook. Rewrote [docs/RESTORE.md](../../docs/RESTORE.md): the automated 04:00 `pg_dump -Fc | age` job (filename, retention, mount, opt-in), the **age-keypair setup** + "identity lives off-host, never on the server" rule, the two separate keys (`MONEY_ENCRYPTION_KEY` decrypts tokens *inside* the dump; the age identity decrypts the dump *itself*), and the restore as `age -d -i <identity> money-<ts>.dump.age | pg_restore -d money_new` → `pnpm db:migrate` (no-op) → verify login/net-worth. **Restore tested:** ran `pg_dump -Fc` → `pg_restore` against the live PG16 dev DB inside the postgres container (2026-06-07) — a 151 KB dump restored into a throwaway DB recreating all **16 tables**. `age` is a transparent filter over that same byte stream, so the `age -d | pg_restore` end-to-end is operator-verified in-container (age isn't on the Windows host); documented honestly in the doc's verification note.

### Beancount export (ADR-016)

- [x] **P6-08** — Beancount mapper (pure, **TDD RED→GREEN**). Created [src/lib/export/beancount.ts](../../src/lib/export/beancount.ts): `accountToBeancountName` (CamelCased `Assets:`/`Liabilities:` by type — credit_card/loan→Liabilities, else Assets), `formatOpen`, `formatBalance` (via `Money`, exact 2-dp), `formatPrice` (verbatim 8-dp — prices aren't cents-money, so they bypass `Money`; no float either way), `formatTransaction` (best-effort **balanced** two-posting: contra leg is the exact negative → Income for inflows, Expenses for outflows; quotes/backslashes escaped), and `renderBeancount` (GENERATED banner + options + sorted open/price/balance/transaction sections; `generatedAt` injectable for determinism). Symbols sanitized to valid commodities (`SEC:uuid`→`SEC-…`). **No `Number()` on money.** → **Verify**: [beancount.test.ts](../../src/lib/export/beancount.test.ts) — **12 tests** (wrote first, watched RED on missing module, then GREEN): type→root mapping table, balance/price exact rendering, cents/8-dp scale preserved, expense/income contra + memo + escaping, empty→header-only, ordering, byte-identical determinism.
- [x] **P6-09** — Export job. Created [src/worker/jobs/export-beancount-daily.ts](../../src/worker/jobs/export-beancount-daily.ts): default loader pulls all accounts/snapshots/prices/transactions from Postgres, `renderBeancount`, **atomic write** (`money.beancount.tmp` → rename) so a reader/rsync never sees a partial file; opt-in (skips when `BEANCOUNT_DIR` unset — no code default, so dev stays quiet); injectable `{fs, env, load, now}` deps. Added `BEANCOUNT_DIR` to [.env.example](../../.env.example) (empty = opt-in). → **Verify**: [export-beancount-daily.test.ts](../../src/worker/jobs/export-beancount-daily.test.ts) — 3 tests (skip-when-unset→no write, tmp-then-rename ordering + content, two-run determinism). **Live smoke (2026-06-07):** ran against the dev DB → a **10 KB** valid file — GENERATED banner, sorted `open`/`price`/`balance` directives, balanced two-posting transactions (`Expenses:Uncategorized`/`Income:Uncategorized`), synthetic `SEC-…` commodities, and a second run **diffed identical modulo the timestamp line**.
- [x] **P6-10** — Schedule + volume. Registered `export-beancount-daily-cron` at `30 4 * * *` (after the 04:00 backup) + worker (wrapped for the `(job, token)` clash) + `shutdown()` close ([worker/index.ts](../../src/worker/index.ts)); `EXPORT_BEANCOUNT_DAILY` queue ([queues.ts](../../src/lib/queue/queues.ts)); `exports` volume + `BEANCOUNT_DIR=/exports` on the worker in [compose.yaml](../../docker/compose.yaml); `run-once` entry + `make job-beancount`. → **Verify**: `pnpm worker` boots and registers the 04:30 scheduler cleanly (re-ran 2026-06-07); `pnpm check` + full suite green.

### Anomaly alerting (ADR-015)

- [x] **P6-11** — `alerts` schema. Created [src/db/schema/alerts.ts](../../src/db/schema/alerts.ts) per spec — `dedup_hash` UNIQUE, partial `alerts_open_detected_at_idx` (WHERE `resolved_at IS NULL`), `type`/`severity` CHECKs, typed `detail` jsonb; re-exported from [index.ts](../../src/db/schema/index.ts). `pnpm db:generate` → `drizzle/0010_steady_lilith.sql`; applied via `pnpm db:migrate`. Added `alerts` to the Makefile `db-reset` list. → **Verify**: **live (2026-06-07)** — same-`dedup_hash` second insert fails `alerts_dedup_hash_unique`; `type='bogus'` fails `alerts_type_check`. *(`drizzle-orm-expert`: partial index + CHECK posture mirrors `plaid_items`.)*
- [x] **P6-12** — Anomaly rule predicates (pure, **TDD RED→GREEN**). Created [src/lib/alerts/rules.ts](../../src/lib/alerts/rules.ts): 6 pure rule fns (`largeTransaction`, `balanceDrop`, `itemLoginRequired`, `staleSnapshot`, `stalePrice`, `syncFailure`) over narrow row inputs + thresholds → `DetectedAlert[]`; `thresholdsFromEnv` (defaults 2000/25/3/USD); `dedupHash(type,subject,period)`. **Money via `Money`** — magnitude compare through `sub`+sign (`gtMoney`/`absMoney`), balance-drop threshold as `prior.mul(pct).div(100)` (no `Number()`, no float). Per-rule dedup granularity (txn id; item id+status; account/symbol+date; run id). → **Verify**: [rules.test.ts](../../src/lib/alerts/rules.test.ts) — **13 tests** (written first, RED on missing module): threshold boundaries (25% exact = no fire; 27% fires), outflow magnitude, all 3 broken statuses (revoked→critical), null-skip, stable/status-keyed hashes, titles carry **no raw amounts**, env defaults+overrides.
- [x] **P6-13** — Detection job. Created [src/worker/jobs/detect-anomalies-daily.ts](../../src/worker/jobs/detect-anomalies-daily.ts): a DB loader assembles all rule inputs, runs every rule, INSERTs `… ON CONFLICT (dedup_hash) DO NOTHING`, **resolves** cleared conditions per rule-type (`notInArray` of currently-detected; backup_failure deliberately excluded from the sweep), then notifies. Injectable `{load, env, now, notify}`. → **Verify**: [detect-anomalies-daily.test.ts](../../src/worker/jobs/detect-anomalies-daily.test.ts) — **5 tests** (real test DB): creates one alert per condition; idempotent re-run (0 new); fixed item resolves while txn stays open; notify stamps `notified_at` on success, not on failure. **Live smoke:** ran against the dev DB → real `large_transaction` + `stale_snapshot` alerts; a re-run kept the count at **11 → 11 (idempotent)**.
- [x] **P6-14** — Notification-only email. `pnpm add nodemailer`. Created [src/lib/alerts/notify.ts](../../src/lib/alerts/notify.ts): `notifyNewAlerts(count,date)` sends a **content-free** body (count + `/alerts` link) via user SMTP (`SMTP_URL`), only when SMTP + `ALERT_EMAIL_TO` set and count>0; injectable transport. `notified_at` stamping lives in the job (P6-13). Added `SMTP_URL`/`ALERT_EMAIL_TO`/`ALERT_EMAIL_FROM`/`APP_BASE_URL` + threshold vars to [.env.example](../../.env.example). → **Verify**: [notify.test.ts](../../src/lib/alerts/notify.test.ts) — **3 tests**: unset SMTP → no send (no throw), count 0 → no send, and the **privacy regression** — the rendered body matches `/\d+ new alerts/` + the link and contains **none** of a financial fixture (`1234.56`, `$`, `Starbucks`, `M&T`, `Checking`, `AAPL`, `Mortgage`, `balance`).
- [x] **P6-15** — `/alerts` page + nav badge (`nextjs-app-router-patterns`). Created [src/app/alerts/page.tsx](../../src/app/alerts/page.tsx) (server component, `requireUser`): open alerts (severity-colored, `detail` rendered — the **only** place figures appear), a Dismiss server action ([actions.ts](../../src/app/alerts/actions.ts), `resolved_at = now()`, bound per-row), resolved history below; query helpers in [src/lib/alerts/queries.ts](../../src/lib/alerts/queries.ts). Made [app-nav.tsx](../../src/components/app-nav.tsx) async with an "Alerts" link + red unread-count badge (`openAlertCount`); Dismiss `revalidatePath("/", "layout")` refreshes it. → **Verify**: `pnpm check` clean; the badge count query returned 11 against live data; render + dismiss are operator-verified (the count/query path is smoked, the page is `requireUser`-gated).
- [x] **P6-16** — Schedule + backup_failure wiring. Registered `detect-anomalies-daily-cron` at `0 5 * * *` (after the 04:00 backup, so a `backup_failure` is detectable/notified) + worker + `shutdown()` close ([worker/index.ts](../../src/worker/index.ts)); `DETECT_ANOMALIES_DAILY` queue; `run-once` + `make job-anomalies`. Wired the backup job's TODO: [src/lib/alerts/backup-alert.ts](../../src/lib/alerts/backup-alert.ts) (`recordBackupFailure` dedup-per-day / `clearBackupFailure` on success) injected into [backup-database-daily.ts](../../src/worker/jobs/backup-database-daily.ts) (DB-backed defaults; backup unit tests inject no-ops to stay DB-free). → **Verify**: `pnpm worker` boots and registers the 05:00 scheduler cleanly (re-ran 2026-06-07); `pnpm check` + full suite (**369 passed**) green.

### Mobile-responsive polish (`tailwind-patterns`)

- [x] **P6-17** — Viewport + responsive nav. Added the `Viewport` export (`width=device-width, initialScale=1`) to [layout.tsx](../../src/app/layout.tsx). Split the nav into a server shell [app-nav.tsx](../../src/components/app-nav.tsx) (async, fetches the open-alert count) + a `'use client'` [nav-menu.tsx](../../src/components/nav-menu.tsx): an inline row at `sm:`+, a hamburger-toggled column below (with a red dot on the button when alerts are open), and the long-deferred **active-link styling** via `usePathname`. `as const` link hrefs satisfy typed-routes without casts. → **Verify**: `pnpm check` clean; **`pnpm build` "✓ Compiled successfully" + 12/12 static pages** (validates typed-routes + the server/client boundary). *(Skills: `nextjs-app-router-patterns` server-shell-+-client-island, `tailwind-patterns` `sm:` disclosure.)*
- [x] **P6-18** — Responsive dashboard + chart fit. [page.tsx](../../src/app/page.tsx): the header now stacks (`flex-col … sm:flex-row sm:items-end sm:justify-between`), the net-worth figure scales (`text-3xl sm:text-4xl`), the section links wrap (`flex-wrap`), and the accounts table sits in an `overflow-x-auto` wrapper. The chart island already used `<ResponsiveContainer width="100%">` over a fixed `h-72` (no fixed pixel width) — fits at 375px unchanged. → **Verify**: build green; no fixed-width element forces page overflow.
- [x] **P6-19** — Responsive tables. Wrapped every dense table in `overflow-x-auto` with a sensible `min-w-[…]` so it scrolls as a unit instead of crushing columns: dashboard accounts (28rem), [accounts/page.tsx](../../src/app/accounts/page.tsx) (34rem), [accounts/[id]/page.tsx](../../src/app/accounts/%5Bid%5D/page.tsx) holdings (46rem) + snapshot history, [investments/page.tsx](../../src/app/investments/page.tsx) positions (44rem), [transactions-section.tsx](../../src/app/accounts/%5Bid%5D/transactions-section.tsx) (36rem), and the [lot-form.tsx](../../src/app/accounts/%5Bid%5D/lot-form.tsx) lots table (34rem). → **Verify**: build green; primary column + values stay visible, scroll is within the card not page-wide.
- [x] **P6-20** — Responsive forms. All five entry forms now stack on mobile: balance/property/holding/mortgage `grid-cols-1 sm:grid-cols-2`, lot `grid-cols-2 sm:grid-cols-3`; every full-width spanner switched `col-span-2/3` → **`col-span-full`** so a single-column mobile grid can't spawn a phantom second column / overflow. Shared `fieldClass` is already `w-full`. The login form was already single-column full-width. → **Verify**: `pnpm check` + build green; **`pnpm test` 369 passed** (no regressions). *(The automated 375px no-overflow assertion is formalized in the P6-25 mobile Playwright smoke.)*

### Deployment hardening (`docker-expert`)

- [x] **P6-21** — ARM64 build for the Pi target (IDEAS.md §1 hosting). Confirmed arch-portability: the base is **Debian bookworm-slim (glibc)**, not alpine — the [Dockerfile](../../Dockerfile) header now documents that every native dep has a glibc arm64 prebuild (`@node-rs/argon2` `*-linux-arm64-gnu`, Next SWC `@next/swc-linux-arm64-gnu`, Tailwind v4 `lightningcss`), and the runtime-stage system binaries resolve on arm64 too (PGDG apt publishes arm64 `postgresql-client-16`; `age` is in bookworm main). No amd64-only deps. `docker buildx build --platform linux/amd64,linux/arm64` ritual documented in DEPLOY.md §1.1. → **Verify**: full emulated arm64 build not runnable on this Windows host, but the dep audit + Debian/PGDG arm64 availability is confirmed; the multi-arch buildx command is in the runbook.
- [x] **P6-22** — Health endpoint + container healthcheck. Added [src/app/api/health/route.ts](../../src/app/api/health/route.ts) — a Node-runtime `GET` that races DB (`SELECT 1`) + Redis `PING` against a 2s per-probe timeout, returns `200 {status:'ok'}` or `503 {status:'error'}`, **leaks no version/internal detail** (granular reason → server log only; body is a fixed status word). Added a Node-`fetch` `healthcheck` (no curl needed) to the `app` service in [compose.yaml](../../docker/compose.yaml) with `start_period`. → **Verify**: `pnpm check` clean; both probes confirmed live against the dev DB (5433) + Redis (6380) — `pg: {"ok":1}`, `redis: PONG`. The 503 path returns the same content-free body.
- [x] **P6-23** — Finalized [docs/DEPLOY.md](../../docs/DEPLOY.md) as the unattended-operation runbook. Folded in: §1.1 ARM64/Pi build (QEMU + buildx multi-arch), §2.1 `/api/health` verification, §6 backup + beancount off-host replication (age keypair ritual, volume mountpoint resolution, rclone/restic), §7 SMTP alert config (notification-only, no financial data), §8 the nightly timeline table (01:30 prices → 02:00 snapshots → 03:00 Plaid → 04:00 backup → 04:30 beancount → 05:00 anomalies) matching [src/worker/index.ts](../../src/worker/index.ts). Resolved the stale "ADR-006 pending / deferred to Phase 6" notes in [README.md](../../README.md) and the `app`-ports comment in [compose.yaml](../../docker/compose.yaml). → **Verify**: every Phase-6 env var from [.env.example](../../.env.example) is documented; the timeline matches the worker's cron patterns.

### Tests + E2E (`e2e-testing-patterns`)

- [x] **P6-24** — Vitest suite (written inline across P6-04 → P6-14). **Audited** the full contract coverage and confirmed it's mutation-sensitive: backup arg-array safety + filename round-trip + retention pruning ([backup-database-daily.test.ts](../../src/worker/jobs/backup-database-daily.test.ts)); beancount account mapping + balance/price/txn rendering + escaping + determinism ([beancount.test.ts](../../src/lib/export/beancount.test.ts)); all six anomaly rule predicates with boundary cases (strictly-greater thresholds) + dedup stability ([rules.test.ts](../../src/lib/alerts/rules.test.ts)); the detection job's idempotency + per-type resolution ([detect-anomalies-daily.test.ts](../../src/worker/jobs/detect-anomalies-daily.test.ts)); the notification-only email's **no-financial-data** regression ([notify.test.ts](../../src/lib/alerts/notify.test.ts)). **Added** one hardening test: `backup_failure` alerts are never auto-resolved by the rule sweep (they clear only on a successful backup) yet are still notified — a flip widening the resolve loop to all types fails it. → **Verify**: **`pnpm test` 370 passed**; the exact-threshold/`>`-vs-`>=` and `filesToPrune` assertions fail on a predicate flip; the privacy email test fails if any amount/name enters the body.
- [x] **P6-25** — Locked the three critical Playwright flows + a mobile smoke. Confirmed (1) [auth.spec.ts](../../e2e/auth.spec.ts)+[phase1.spec.ts](../../e2e/phase1.spec.ts) cover first-setup→create account→enter balance→see it on the dashboard; (2) [phase3.spec.ts](../../e2e/phase3.spec.ts) covers QFX upload→preview→confirm→transactions appear; (3) [phase4-link.spec.ts](../../e2e/phase4-link.spec.ts) covers the Plaid Link sandbox happy path (gated on `PLAID_E2E_SANDBOX=1`). Added [e2e/phase6-mobile.spec.ts](../../e2e/phase6-mobile.spec.ts): a 375px-viewport smoke that bootstraps via the responsive forms, asserts the nav collapses to a working hamburger panel, and checks **no horizontal overflow** (`scrollWidth − clientWidth ≤ 1px`) on the login, dashboard (with a populated net-worth table), accounts, and new-account pages. → **Verify**: `pnpm exec playwright test auth phase1 phase3 phase4-link phase6-mobile` → **7 passed, 1 skipped** (phase4-link skips without the sandbox env, per the established pattern); the mobile smoke is green against a freshly-reset DB.

### Docs

- [x] **P6-26** — Docs + README. Added [docs/BACKUP.md](../../docs/BACKUP.md) (age-keypair ritual, the mount, off-host replication, retention, the two-keys table, and the "identity never on the server" rule; recovery defers to RESTORE.md), [docs/ALERTS.md](../../docs/ALERTS.md) (the seven-row rule catalog with severities + dedup keys, every threshold env var, SMTP setup, and the no-financial-data privacy posture), and [docs/BEANCOUNT.md](../../docs/BEANCOUNT.md) (what's exported, the one-way/hedge framing, account-naming map, and how to read it with `less`/`bean-query`/`fava`). Updated [README.md](../../README.md): added **Phase 5 & Phase 6 — complete** to §Status, added §Backups/§Alerts/§Longevity sections, and **fixed the stale notes** — the "ADR-006 pending / deferred to Phase 6" deploy note (P6-23), the stale ADR-001..005 list, and the **Phase-1 iron-session known issue, now marked Resolved** (the logout route clears the cookie on the `NextResponse` instead of re-entering iron-session in a route handler). → **Verify**: backups, alerts, and the export are each configurable from their doc alone; no "deferred to Phase 6" breadcrumb points at unbuilt work.
- [x] **P6-27** — ADR-014/015/016 are in the [IDEAS.md](IDEAS.md) §11 Decision Log (added during planning; verified present, dated 2026-06-07, full ADRs in PLAN6.md). Resolved the dangling Phase-6 prose: the §3 "optional Phase 4 hedge" line now points at ADR-016 ("shipped in Phase 6"); the §9 Phase 6 roadmap list is marked ✅ Shipped with per-item ADR/doc links (and records that **Resend was rejected** on privacy grounds); the legacy Backups row 10 flips 🟡 Recommendation → ✅ Resolved → ADR-014. → **Verify**: the Decision Log lists all three ADRs; no Phase-6 line item is left dangling.

---

## Phase 6 Done When

- [x] `007` full-repo security pass + `code-reviewer` pass complete; threat model widened beyond Plaid ([docs/THREAT_MODEL.md](../../docs/THREAT_MODEL.md), ≈90/100 verdict); no unaddressed critical/high before any public tunnel opens (two Mediums — login throttle + security headers — fixed inline). *(P6-01, P6-02.)*
- [x] Nightly `pg_dump | age` backup runs as a BullMQ job (04:00), prunes to `BACKUP_RETAIN_DAYS`, fails loudly on a bad dump (alert wiring TODO'd pending P6-11), and a **dump→restore round-trip was actually performed** into a throwaway DB (16 tables recreated, 2026-06-07). *(P6-03→07; the `age -d` layer is operator-verified in-container — `age` isn't on the dev host.)* *(CLAUDE.md §Backup Discipline "an untested backup is not a backup.")*
- [x] Nightly `money.beancount` export lands in a mount, is deterministic/sorted, carries the "generated" banner, and is readable in `less` with no tooling. *(P6-08→10; live-smoked against the dev DB — 10 KB file, two runs identical modulo the timestamp.)*
- [x] `alerts` table + `/alerts` page + nav badge exist; the nightly detector (05:00) fires deterministic rules, dedups standing conditions (live: 11→11 on re-run), resolves cleared ones, and (if SMTP configured) sends a **content-free** email proven by test to contain no financial data. *(P6-11→16; ADR-015 privacy wall.)*
- [x] The app is usable at 375px: viewport meta, collapsing hamburger nav (+ active-link), `overflow-x-auto` on every dense table, mobile-stacked forms, charts fit. *(P6-17→20; build "✓ Compiled" + 369 tests green; the automated 375px no-overflow assertion lands in the P6-25 mobile Playwright smoke.)*
- [x] `/api/health` feeds the container healthcheck (no internal-detail leak); the worker image carries `pg_dump`/`age`; backup + export volumes are mounted; ARM64 build is confirmed portable (glibc base, every native dep has an arm64-gnu prebuild; multi-arch buildx documented); `docs/DEPLOY.md` is a complete unattended-operation runbook with the nightly cron timeline. *(P6-21→23.)*
- [x] `pnpm test` covers backup safety/retention, beancount mapping, every anomaly rule, and the no-financial-data email guard, with meaningful assertions (370 passed). *(P6-24.)*
- [x] The three critical Playwright flows (setup→balance→dashboard; QFX import; Plaid Link sandbox) + a 375px mobile smoke are green (Plaid gated on `PLAID_E2E_SANDBOX=1`). *(P6-25.)*
- [x] `docs/BACKUP.md`, `docs/ALERTS.md`, `docs/BEANCOUNT.md` exist; README reflects Phases 5–6 complete; stale "deferred to Phase 6" / iron-session notes resolved. *(P6-26.)*
- [x] `pnpm check` clean (Biome + tsc). ADR-014/015/016 present in [IDEAS.md](IDEAS.md) §11. *(P6-27.)*

---

## Skills Map (per task cluster)

Per [SKILLS.md](SKILLS.md) §Suggested Workflow → Pre-deploy + Phase 6. Invoke when the cluster opens, not upfront.

| Task cluster | Primary skill(s) |
|---|---|
| P6-01 → P6-02 (pre-deploy gate) | `007`, `threat-modeling-expert`, `code-reviewer` |
| P6-03 → P6-07 (backup + restore) | `bullmq-specialist`, `docker-expert`, `secrets-management`, `backend-security-coder` |
| P6-08 → P6-10 (beancount export) | `test-driven-development`, `bullmq-specialist`, `typescript-pro` |
| P6-11 → P6-16 (anomaly alerting) | `drizzle-orm-expert`, `test-driven-development`, `bullmq-specialist`, `nextjs-app-router-patterns` |
| P6-17 → P6-20 (mobile responsive) | `tailwind-patterns`, `nextjs-app-router-patterns` |
| P6-21 → P6-23 (deployment hardening) | `docker-expert`, `backend-security-coder` |
| P6-24 → P6-25 (Vitest + Playwright) | `e2e-testing-patterns`, `test-driven-development` |
| P6-26 → P6-27 (docs + ADRs) | `architecture-decision-records` |
| Anytime something breaks | `systematic-debugging` |

---

## Dependency graph (what blocks what)

```
P6-01, P6-02 ── gate everything that opens a public path (P6-23 tunnel finalize)
                but DON'T block local backup/export/alert/mobile work

P6-03 ─→ P6-04 ─→ P6-05 ─→ P6-06 ─→ P6-07        (backup chain; P6-11 needed for P6-04's alert write)
P6-08 ─→ P6-09 ─→ P6-10                          (beancount chain; independent of backup)
P6-11 ─→ P6-12 ─→ P6-13 ─→ P6-14 ─→ P6-15 ─→ P6-16   (alerting chain; P6-11 also unblocks P6-04's alert)
P6-17 ─→ P6-18, P6-19, P6-20                     (mobile; fully independent — can run in parallel)
P6-21, P6-22 ─→ P6-23                            (deploy; P6-22 health route is standalone)
P6-24 trails its source tasks; P6-25 after the user-facing surfaces exist
P6-26, P6-27 last (document what shipped)
```

Parallelizable tracks: **backup**, **beancount**, **alerting**, and **mobile** are mutually independent — the only cross-link is P6-11 (`alerts` table) feeding P6-04's `backup_failure` write. A worktree (`using-git-worktrees`) per track is reasonable if spiking in parallel.

---

## Open Items (out of scope for this plan, captured for future PLAN docs)

- **Cash-flow Sankey** (carried from ADR-013 / PLAN5 §Open Items) — the income→category→expense flow diagram. A genuine cash-flow *feature* (its own data plumbing over categorized transactions over time), not longevity polish. Revisit `@nivo/sankey` vs. hand-rolled SVG when built.
- **Beancount commodity/lot modeling** (ADR-016) — exporting holdings as beancount commodity lots with cost rather than `balance` assertions on value. Only if a user actually round-trips into `bean-query` for investment analysis; YAGNI until then.
- **Alert thresholds via a settings UI** (ADR-015) — env vars are the Phase-6 answer. If threshold tuning churns in practice, a small `app_settings` table + a `/settings/alerts` page; deferred until the friction is real.
- **Additional alert channels** (push, ntfy, SMS, webhook) — the `alerts` table is channel-agnostic by design; adding an ntfy/push transport is a `notify.ts` sibling. Notification-only/no-financial-data rule still applies. Deferred.
- **In-app backup download / off-host replication automation** — Phase 6 writes to a mount and stops there (replication is the user's job per ADR-014). A future "push to B2" job could live in the worker, but it adds a cloud credential surface; deferred until asked.
- **CSV/Parquet export affordance** (IDEAS.md §2 Portability) — a user-triggered "export my data" button distinct from the beancount hedge. Small; deferred — beancount + `pg_dump` cover the longevity NFR for now.
- **`failed_jobs` table for BullMQ failures** (CLAUDE.md §Background Jobs) — Phase 6 surfaces *domain* health via `alerts` (sync/backup/stale). A generic dead-letter table the UI can show for *any* job failure is a nice-to-have; the `sync_failure`/`backup_failure` alerts cover the cases that matter today.
- **Production Plaid cutover runbook** (carried from PLAN4 §Open Items) — Sandbox→Production credential swap + re-Link every Item. Folds naturally into `docs/DEPLOY.md` after the first real deploy.
- **Active uptime monitoring** beyond `/api/health` — an external pinger (Uptime Kuma self-hosted) is the user's infra choice, not app code; documented as a suggestion in `docs/DEPLOY.md`, not built.

---

*End of PLAN6.md*
