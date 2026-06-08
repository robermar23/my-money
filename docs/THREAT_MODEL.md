# my-money — Whole-App Threat Model (Pre-Deploy / STRIDE + PASTA)

> **Pre-deploy security gate (PLAN6 P6-01 / P6-02).** This is the full-repo
> security pass run *before* the Cloudflare Tunnel (ADR-010) exposes the app to
> the public internet. It widens the Plaid-only analysis in
> [THREAT_MODEL_PLAID.md](THREAT_MODEL_PLAID.md) to every other surface: auth,
> the server-action mutation layer, file import, outbound market-data fetches,
> secrets/env hygiene, web response headers, and the (forward-looking) Phase-6
> longevity surfaces (backup mount, beancount export, SMTP alerts, `/api/health`).
>
> Methodology follows the `007` 6-phase flow (Surface Map → STRIDE/PASTA →
> Checklist → Red Team → Blue Team → Verdict) and `threat-modeling-expert`
> STRIDE-per-component. The Plaid surfaces (Link, token store, webhook, sync,
> reauth, disconnect, investments) are **not** re-derived here — see
> [THREAT_MODEL_PLAID.md](THREAT_MODEL_PLAID.md) Surfaces 1–7.
>
> **Scope**: single-user, self-hosted my-money. Multi-user / multi-tenant
> threats (cross-user access, RBAC bypass, tenant isolation) are out of scope —
> the `users` table holds exactly one row by design (CLAUDE.md §Domain Scope).

---

## 1. System summary (what was analyzed)

Next.js 15 (App Router) single app + a separate BullMQ worker process, Postgres,
Redis, all on a self-hosted box behind a Cloudflare Tunnel that exposes the app
over HTTPS. Auth is roll-our-own (iron-session cookie + argon2id), one password,
one user (ADR-004). Financial data (balances, transactions, holdings, snapshots)
lives in Postgres on a private docker network. The only public ingress is
Cloudflare → `cloudflared` → `app:4000`; once that hostname is mapped, **the
entire app — including `/login` — is internet-reachable**, not just
`/api/plaid/webhook`.

This pass was run against the Phases 0–5 codebase. The Phase-6 surfaces (backup,
beancount, alerts, health) are analyzed at the design level so their mitigations
are baked in before implementation (P6-03+).

---

## 2. Attack-surface map & trust boundaries

```text
                         INTERNET
                            │  HTTPS
                            ▼
                  ┌──────────────────┐
                  │ Cloudflare edge  │  TLS terminates here; sees IP/SNI/timing,
                  │ (+ optional WAF) │  cannot decrypt the body
                  └────────┬─────────┘
                  outbound │ tunnel (no inbound port on the home router)
                           ▼
                  ┌──────────────────┐
                  │ cloudflared      │  docker sidecar
                  └────────┬─────────┘
                           │ HTTP (private money_net bridge)
                           ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ Next.js app:4000                                             │
   │  • /login (public once tunnel is up)  ── PUBLIC TRUST EDGE   │
   │  • server actions (requireUser-gated)                        │
   │  • /api/plaid/webhook (JWT-verified)  → see Plaid model      │
   │  • /api/health (Phase 6, no-auth, no detail)                 │
   │  • file import (QFX/CSV upload)                              │
   └───────┬───────────────────────────────────┬─────────────────┘
           │ TCP (private)                      │ outbound HTTPS
           ▼                                    ▼
   ┌──────────────┐   ┌──────────────┐   ┌─────────────────────────┐
   │ Postgres     │   │ Redis(BullMQ)│   │ Yahoo / CoinGecko / Plaid│
   │ (private)    │   │ (private)    │   │ (fixed hosts, TLS)       │
   └──────┬───────┘   └──────┬───────┘   └─────────────────────────┘
          │                  │
          │            ┌─────┴────────┐
          │            │ worker proc  │  nightly cron jobs:
          │            │ (no session) │  prices, snapshots, plaid sync,
          │            └─────┬────────┘  + Phase 6: backup, beancount, alerts
          ▼                  ▼
   ┌──────────────┐   ┌─────────────────────────────────────────┐
   │ pg_dump→age  │   │ BACKUP_DIR mount │ BEANCOUNT_DIR mount   │  (Phase 6)
   │ (Phase 6)    │   │ (encrypted)      │ (PLAINTEXT financial) │
   └──────────────┘   └─────────────────────────────────────────┘
```

**Trust boundaries that matter for this model:**

- **Internet ↔ app** — the new public edge. `/login` is the front door; the
  webhook is JWT-gated (Plaid model). Everything else is `requireUser`-gated.
- **app/worker ↔ Postgres/Redis** — private docker bridge, never published to
  the host in prod (compose.yaml).
- **app/worker ↔ external APIs** — outbound TLS to fixed hosts.
- **worker ↔ backup/export mounts** — plaintext financial data crosses into the
  beancount mount; the pg_dump crosses out `age`-encrypted (one-way).

### Assets (non-Plaid; Plaid token assets are in the Plaid model)

| Asset | Sensitivity | Location |
|---|---|---|
| `SESSION_SECRET` | Critical — forges any session | env var |
| Argon2id password hash | High — the single auth gate | `users.password_hash` |
| Session cookie (`money_session`) | High — bearer of authN | browser + signed by `SESSION_SECRET` |
| Financial data (balances, txns, holdings, snapshots) | High — the whole product | Postgres tables |
| `age` backup identity (private key) | Critical — decrypts every dump | **off-host only, never on the server** (ADR-014) |
| `BEANCOUNT_DIR` contents | High — plaintext financial mirror | worker mount (ADR-016) |
| `MONEY_ENCRYPTION_KEY`, `PLAID_*`, `CLOUDFLARED_TOKEN` | Critical/High | env (see Plaid model) |

---

## 3. Surface A — Authentication, session & first-run bootstrap

`loginOrBootstrap` ([src/app/login/actions.ts](../src/app/login/actions.ts)):
first submission sets THE password (argon2id), later submissions verify. Session
is an iron-session cookie ([src/lib/auth/session.ts](../src/lib/auth/session.ts)),
1-year `maxAge`, `httpOnly`, `sameSite=lax`, `secure` in production.
`requireUser` ([src/lib/auth/require-user.ts](../src/lib/auth/require-user.ts))
gates every protected component/action and fails closed (redirects to `/login`).

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing | Forge a session cookie to impersonate the user | iron-session AEAD-seals the cookie with `SESSION_SECRET` (≥32 chars, validated at boot — process refuses to start otherwise). Forgery requires the secret. | ✅ session.ts |
| **S**poofing — bootstrap hijack | App is exposed *before* the owner sets a password; an attacker reaches `/login` first and claims the instance | **Operational mitigation (primary):** the deploy runbook (P6-23) mandates setting the password **before** opening the tunnel. The login throttle (below) caps an automated race. Documented design (README): "whatever you type becomes the only password." | ⚠️ Accepted w/ runbook — P6-23 |
| **T**ampering | Mutate the cookie to change `userId` | Any edit breaks the iron-session seal → treated as no session → redirect to `/login`. | ✅ session.ts |
| **R**epudiation | "Did someone log in?" | No per-login audit row today. Single-user, low value; the `stale`/anomaly alerts (P6-12) surface *effects* of misuse. Logged as residual. | ⚠️ Residual — §Open Items |
| **I**nformation disclosure | Password / hash leaks via logs or error text | `verifyPassword` returns a boolean; the hash is never logged; login errors are generic ("Wrong password"). No `console.*` in the auth path (grep-verified). | ✅ login/actions.ts |
| **D**enial of service — **online brute-force / argon2 CPU-exhaustion** | Attacker floods `/login` to guess the password and/or pin CPU with many argon2id verifications | **FIXED in this pass (P6-01/02):** per-IP token-bucket throttle — 10 attempts/min/IP — consumed **before** any parse or argon2 work ([src/lib/auth/login-throttle.ts](../src/lib/auth/login-throttle.ts)), keyed off `cf-connecting-ip`/`x-forwarded-for`. argon2id is itself a per-guess cost. | ✅ P6-01/02 |
| **E**levation of privilege | A non-session request reaches protected data | `requireUser` fails closed (redirect) and re-checks the user row still exists; every server action calls it (verified — §Surface B). | ✅ require-user.ts |

**Red-team scenario (brute-force):** *Persona: bot abusivo.* Pre-fix, an attacker
scripting `/login` POSTs could attempt unlimited guesses, each forcing a ~100 ms
argon2 verification → both a guessing channel and a CPU-DoS. Post-fix, the 11th
attempt in a minute is rejected before argon2 runs; at 10 guesses/min an online
attack on any non-trivial password is infeasible, and the CPU floor is capped.

---

## 4. Surface B — Server-action mutation layer

Eight `"use server"` modules. Every mutation routes through `requireUser()`
(directly or via a `loadAccount()` helper that calls it first), then validates
input with a zod schema before touching the DB. `login/actions.ts` is the sole
intentionally-unauthenticated action (it *is* the auth).

**Audit result (P6-02):** all server actions verified gated —
`accounts/new`, `accounts/[id]` (all 8 actions via `loadAccount`/`requireUser`),
`accounts/[id]/import` (3), `settings/categories` (6), `settings/connections`
(all, incl. `finalizeReauth`/`forceSync`/`disconnect`), `map-actions`,
`progress-actions`. No ungated mutation found.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing | Invoke an action without auth (server actions are POST endpoints) | `requireUser()` at the top of every action; Next 15 also enforces same-origin (Origin/Host) on server-action POSTs → CSRF-resistant. `sameSite=lax` cookie is defense-in-depth. | ✅ require-user.ts |
| **T**ampering — injection | Malicious `formData` (SQLi, type confusion) | All inputs parsed by zod schemas ([src/lib/schemas/account.ts](../src/lib/schemas/account.ts)) before use; Drizzle parameterizes every query (no string-built SQL anywhere — grep clean). UUID params regex-checked before lookups (e.g. lot/transaction ids). | ✅ |
| **T**ampering — money precision | A crafted amount loses pennies via float math | Money values stay strings end-to-end through `Money`/Decimal; the only non-test `Number()` on a money path is the `Intl.NumberFormat` display boundary (money.ts) — confirmed (grep). | ✅ CLAUDE.md §Money |
| **R**epudiation | Untraceable data change | Mutations stamp `updated_at` / `*_overridden_at` watermarks; imports + plaid syncs keep audit rows (`import_batches`, `plaid_sync_runs`). | ✅ |
| **I**nformation disclosure | An action returns more than intended (e.g. the ciphertext column) | `access_token_ciphertext` is read only in `src/lib/plaid/tokens.ts`, enforced by the [hardening-audit.test.ts](../src/lib/plaid/hardening-audit.test.ts) grep regression (re-run green this pass after the rate-limit relocation). Other actions return narrow result objects. | ✅ |
| **D**enial of service | Expensive action spammed | `requireUser`-gated (only the one user reaches them); single-user volume. | ✅ Accepted (single-user) |
| **E**levation of privilege — IDOR | Pass another account's id to act on data you don't own | N/A single-user — one owner. Actions still scope writes by `(id, account_id)` and verify holding-on-account ownership (defense-in-depth for the day multi-user is ever considered). | ✅ Accepted (single-user) |

---

## 5. Surface C — File import (QFX / CSV upload)

`uploadImportAction` ([src/app/accounts/[id]/import/actions.ts](../src/app/accounts/%5Bid%5D/import/actions.ts))
takes a user file → [upload-security.ts](../src/lib/importers/upload-security.ts)
enforces size + magic-byte + filename sanitization → parsed in a BullMQ job →
preview → explicit confirm. Parsers are hand-rolled, dependency-free (ADR-006).

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing | Upload disguised as a statement | `requireUser`-gated; magic-byte sniff (`OFXHEADER`/`<OFX`/`<?xml`; CSV must be comma-bearing ASCII) overrides the extension. | ✅ P3-28 |
| **T**ampering — path traversal | Filename `../../etc/passwd` writes outside the dir | Filename never used as a filesystem path — bytes go into `import_batches.raw_file` (bytea). `sanitizeFilename` still strips `/ \ NUL` + NFKC-normalizes + length-caps, for display only. | ✅ upload-security.ts |
| **T**ampering — **stored XSS** | A crafted transaction `name`/`memo` (`<script>…`) renders in the UI | React escapes all interpolated text by default; **no `dangerouslySetInnerHTML` / `innerHTML` anywhere** (grep-verified across `src/`). Transaction names render as text, not HTML. | ✅ (no dangerous sink) |
| **R**epudiation | "Where did this transaction come from?" | Every imported row carries `source` + `import_batch_id` + `fitid`; the batch retains the original bytes for re-derivation. | ✅ |
| **I**nformation disclosure | Parser error leaks file contents into logs | Errors surface counts + a generic message to the preview UI; raw rows aren't logged. | ✅ |
| **D**enial of service — zip/billion-laughs/huge file | Multi-GB upload or pathological OFX exhausts memory | Size cap (default 10 MB, env-tunable) checked before processing; parsing runs in the worker (BullMQ), not the request; hand-rolled parser has no entity-expansion (it's not a full XML engine). | ✅ ADR-006, P3-28 |
| **E**levation of privilege | Import writes to an account the user can't access | `loadAccount` → `requireUser`; writes scoped to the target `account_id`; dedup on `(account_id, fitid)`. | ✅ |

---

## 6. Surface D — Outbound market-data fetch (worker)

Nightly jobs call Yahoo Finance + CoinGecko over TLS to fixed hosts
([src/lib/prices/](../src/lib/prices/)). Symbols (user-entered holding symbols)
become query params.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing / **T**ampering — MITM | Upstream returns forged prices | TLS to fixed hostnames. Prices are non-authoritative (display + snapshot inputs), not payment decisions (CLAUDE.md). A bad price is a visible wrong number, self-correcting next fetch. | ✅ Accepted |
| **T**ampering — **SSRF** via symbol | A malicious symbol redirects the fetch to an internal host | Host is a hardcoded constant; the symbol is only ever a URL-**encoded query param/path value** — it cannot change the host or scheme. Symbols are also constrained at the holding-entry zod boundary. | ✅ |
| **I**nformation disclosure | The fetch reveals holdings to a third party | Only ticker **symbols** leave (e.g. `AAPL`, `BTC`) — never balances, quantities, account names, or identity. CoinGecko/Yahoo are public price APIs, no key, no account linkage. Acceptable per CLAUDE.md §Privacy (symbols are not financial *positions*). | ⚠️ Accepted — documented |
| **D**enial of service — upstream down/rate-limit | A flaky API stalls the nightly run | Cache-on-write `prices` table means the dashboard never calls the API live; a failed fetch just stops *updating* (history intact). Phase 6 `stale_price` alert (P6-12) surfaces a persistently dead feed. | ✅ |
| **E**levation of privilege | n/a (no inbound trust from these calls) | — | — |

---

## 7. Surface E — Phase 6 longevity surfaces (design-level, pre-implementation)

These don't exist yet (P6-03+); their mitigations are locked here so they ship
secure-by-default.

| Surface | Top threat | Mitigation (baked into the ADR) | Status |
|---|---|---|---|
| **Backup job** (`pg_dump \| age`, ADR-014) | Shell injection via `DATABASE_URL`; decryptable dump on the box | `spawn` with an **args array** (never a shell string) — enforced by P6-04's test; **recipient-only `age`** so the private identity is never on the server (a server compromise can't decrypt past backups). Double-wrapped: AES-GCM token column inside the age dump. | ⚠️ Design — P6-04 |
| **Backup mount** | Someone reads decrypted dumps | Nobody can — only ciphertext lands on the mount. The mount is worker-only; off-host replication is the user's job (docs/BACKUP.md). | ⚠️ Design — P6-06 |
| **Beancount export** (ADR-016) | **Plaintext financial data on disk** in `BEANCOUNT_DIR` | This is the one plaintext financial asset on the box. Mitigation: documented file-permission + same off-host-handling discipline as backups; it's a *mirror* of data already in Postgres (no new secret). Threat-model row to revisit if the mount is ever network-shared. | ⚠️ Design — P6-09, residual logged |
| **SMTP alert** (ADR-015) | Financial data leaks to a third-party mail relay | **Notification-only**: body is a count + a sign-in link, **zero amounts/account names/merchants** — enforced by a regression test (P6-14). Even a third-party relay sees nothing financial. Transport is user-controlled SMTP (no SaaS default). | ⚠️ Design — P6-14 |
| **`/api/health`** (P6-22) | Unauthenticated endpoint leaks version/internal detail or becomes a DoS amplifier | Returns only `{status:'ok'}` / 503 — no version, no stack, no dependency detail (P6-01 requirement). Cheap `SELECT 1` + Redis ping; behind Cloudflare. | ⚠️ Design — P6-22 |

---

## 8. Surface F — Secrets, env & web headers (cross-cutting)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **I**nformation disclosure — hardcoded secrets | A secret committed to the repo | Grep scan this pass: **no hardcoded secrets** — the only matches are fake `access-sandbox-*` test fixtures. All real secrets are env-only (validated-or-crash at boot for `SESSION_SECRET`, `MONEY_ENCRYPTION_KEY`). | ✅ |
| **I**nformation disclosure — client bundle leak | A `PLAID_*` / DB secret ships to the browser | No `NEXT_PUBLIC_*` secret exists; `src/lib/plaid/client.ts` is `import "server-only"`; session/crypto modules are `server-only` (build-time error if imported client-side). | ✅ |
| **I**nformation disclosure — sensitive logging | Tokens / headers / amounts in logs | Only `console.log` in the codebase: the harmless `heartbeat` tick + a `SESSION_SECRET` *error-message string* (no runtime secret). Plaid paths are grep-guarded by hardening-audit.test.ts. | ✅ |
| **T**ampering — **clickjacking** | The app is framed by a malicious page to trick clicks | **FIXED this pass:** `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` in [next.config.ts](../next.config.ts). (Plaid Link is framed *by* us, so this doesn't break it.) | ✅ P6-01/02 |
| **T**ampering — MIME sniffing / referrer leak | Content-type confusion; referrer exposes URLs to third parties | **FIXED this pass:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` denying camera/mic/geo, `Strict-Transport-Security` (defense-in-depth atop Cloudflare). | ✅ P6-01/02 |
| **I**nformation disclosure — full CSP | XSS via injected script | A restrictive `script-src` CSP is **deferred** (risks breaking Plaid Link + Next inline runtime); the safe subset (`frame-ancestors`/`base-uri`/`form-action 'self'`) ships now. Residual: stored-XSS is already mitigated by React escaping + no dangerous sinks. | ⚠️ Residual — §Open Items |

---

## 9. Code-review findings (P6-02) — triage

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | **Medium** | `/login` had no rate limit → online brute-force + argon2 CPU-DoS, made reachable by the public tunnel | **Fixed** — per-IP throttle ([login-throttle.ts](../src/lib/auth/login-throttle.ts)) + test |
| 2 | **Medium** | No security response headers (clickjacking, MIME-sniff, referrer) on a financial app about to be public | **Fixed** — header set in [next.config.ts](../next.config.ts) |
| 3 | **Low** | First-run bootstrap lets the first visitor set the password (exposure-before-setup race) | **Accepted + runbook** — P6-23 mandates "set password before opening the tunnel"; throttle caps the race |
| 4 | **Low** | No per-login / per-mutation audit trail (repudiation) | **Accepted** — single-user; effects surface via Phase-6 anomaly alerts; logged in §Open Items |
| 5 | **Low** | No restrictive `script-src` CSP | **Deferred** — would risk Plaid Link/Next; safe CSP subset shipped; React escaping + no dangerous sinks mitigate XSS today |
| 6 | **Info** | Holding symbols leave the box to public price APIs | **Accepted** — symbols ≠ positions; no balances/identity; CLAUDE.md §Privacy-compatible |
| — | — | Auth gating on all 8 server-action modules | **Verified clean** — no ungated mutation |
| — | — | Money-as-string discipline | **Verified clean** — only display-boundary `Number()` |
| — | — | Hardcoded secrets | **Verified clean** — test fixtures only |
| — | — | `access_token_ciphertext` read-isolation | **Verified clean** — single reader, audit test green |

No **Critical** or **High** findings. The two Mediums are fixed in this pass.

---

## 10. Verdict (007 Phase 6)

| Domain | Weight | Score | Notes |
|---|---|---:|---|
| Secrets & credentials | 20% | 95 | Env-only, validated-at-boot, server-only modules, AEAD token store, no hardcoded secrets. age-identity off-host (Phase 6). |
| Input validation | 15% | 95 | zod at every boundary; parameterized SQL; magic-byte upload sniff; UUID regex checks. |
| AuthN & AuthZ | 15% | 88 | Single-gate argon2id + sealed session, fail-closed `requireUser`, now throttled. Bootstrap-race + no audit log are the residuals. |
| Data protection | 15% | 90 | TLS in/out, private DB net, money-precision, encrypted backups. Beancount plaintext mount is the noted residual. |
| Resilience | 10% | 90 | Idempotent jobs, retries/backoff, cache-on-write prices, restore runbook (tested in P6-07). |
| Monitoring | 10% | 75 | Phase-6 anomaly alerts (P6-12) + `stale_*`/`backup_failure` close most of this; no structured audit log yet. |
| Supply chain | 10% | 85 | Few deps, pnpm lockfile, hand-rolled parser/crypto avoid risky packages; `pnpm audit` not yet in CI (recommend). |
| Compliance / headers | 5% | 90 | Security headers now set; privacy posture strong; full CSP deferred. |

**Weighted score ≈ 90 / 100 → ✅ Approved for production deploy**, conditioned on
the two operational items: (a) **set the password before opening the tunnel**
(P6-23 runbook), and (b) keep the `age` backup identity off the server (ADR-014).
The residuals (audit log, full CSP, `pnpm audit` in CI) are Low/Info and tracked
below — none block the tunnel.

---

## 11. Open Items (residual / future hardening)

1. **No structured audit log** — login events + critical mutations have no
   append-only trail (Surface A/B Repudiation). Single-user lowers the value;
   the Phase-6 `alerts` table surfaces *effects*. Revisit if a `failed_jobs` /
   audit surface is built (also noted in the Plaid model Open Item 5).
2. **First-run bootstrap race** — operationally mitigated by P6-23. A stronger
   fix (a one-time `BOOTSTRAP_TOKEN` env gate for the very first password set)
   is possible but adds setup friction; deferred unless the box is ever exposed
   before setup by design.
3. **Full `script-src` CSP** — deferred to avoid breaking Plaid Link / Next.
   Revisit with a nonce-based CSP + a Plaid `cdn.plaid.com` allowlist if/when
   the XSS surface grows.
4. **`pnpm audit` in CI** — dependency-CVE scanning isn't yet a gate. Add it to
   the `check` pipeline before/at deploy; low effort, good supply-chain signal.
5. **Beancount plaintext mount** — the one on-disk plaintext financial asset
   (ADR-016). Fine on a single-owner box; becomes a finding if that mount is
   ever network-shared. File-permission guidance lives in docs/BEANCOUNT.md (P6-26).

---

## 12. How to use this document

When you change auth, a server action, the import path, the price fetchers, the
web headers, or any Phase-6 backup/export/alert/health code:

1. Identify the surface above and re-read its table.
2. If your change weakens a ✅ mitigation, that's a regression — restore it or
   convert the row to a documented residual with rationale.
3. New threat not listed → add a row.
4. The Plaid surfaces live in [THREAT_MODEL_PLAID.md](THREAT_MODEL_PLAID.md);
   keep the two documents in sync at their shared edges (session gate, webhook
   ingress, secret hygiene).
