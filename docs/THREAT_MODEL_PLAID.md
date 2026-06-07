# Plaid Integration Threat Model (Phase 4 + Phase 5 / STRIDE)

A row-per-STRIDE-category analysis of the Plaid integration surface, with
every mitigation pointing at a specific PLAN task (or marked **accepted**
when the residual risk is acknowledged, or **open** when work is required
beyond the current phase).

> Phase 5 (investments) extends this surface: Surface 7 below covers the
> `sync-investments-item` worker and the `/investments/holdings/get` +
> `/investments/transactions/get` calls. It adds **no new secret-bearing
> asset** — `securities`, `holding_lots`, and `investment_transactions` hold
> only public security metadata, quantities, and prices, never credentials.
> The investments path reuses the existing Item, encrypted-token store, webhook
> receiver, and sync-run ledger unchanged.

> Scope: single-user, self-hosted my-money. Multi-user / multi-tenant threats
> (cross-user data access, RBAC bypass, tenant isolation) are out of scope —
> the `users` table holds exactly one row by design.

## Trust boundaries

```text
┌──────────────┐      ┌──────────────┐      ┌──────────────────────┐
│   browser    │◄────►│ Cloudflare   │◄────►│ cloudflared sidecar  │
│ (Plaid Link  │ TLS  │   edge       │ tun  │  (docker network)    │
│  iframe +    │      │              │      │                      │
│  my-money UI)│      └──────────────┘      └──────────┬───────────┘
└──────────────┘                                       │ HTTP (private net)
                                                       ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────────────┐
│  Plaid API   │◄────►│   Next.js    │◄────►│   Postgres (private) │
│ (sandbox or  │ TLS  │ app:4000     │ TCP  │   plaid_items, ...   │
│  production) │      │  (server)    │      │                      │
└──────┬───────┘      └──────┬───────┘      └──────────────────────┘
       │ webhook POST        │                          ▲
       │ (signed JWT)        ▼                          │
       │              ┌──────────────┐                  │
       └─────────────►│  webhook     │                  │
                      │  route       │                  │
                      └──────┬───────┘                  │
                             ▼                          │
                      ┌──────────────┐      ┌───────────┴──────────┐
                      │   Redis      │◄────►│    BullMQ worker     │
                      │  (BullMQ)    │      │  sync-plaid-item     │
                      └──────────────┘      └──────────────────────┘
```

The boundaries that matter for Phase 4:

- **Browser ↔ Cloudflare**: TLS terminates at Cloudflare. Cloudflare sees IPs,
  hostnames, and timing; it cannot decrypt the body.
- **Cloudflare ↔ cloudflared**: outbound-dialed tunnel, no inbound port on the
  home router (ADR-010).
- **cloudflared ↔ app**: docker bridge network, no host port published.
- **app ↔ Plaid**: TLS, mTLS-flavored via `PLAID-CLIENT-ID` + `PLAID-SECRET`
  HTTP headers ([src/lib/plaid/client.ts](../src/lib/plaid/client.ts)).
- **Plaid ↔ webhook receiver**: signed via ES256 JWT in the
  `Plaid-Verification` header
  ([src/lib/plaid/webhook-verify.ts](../src/lib/plaid/webhook-verify.ts)).
- **app ↔ Postgres**: docker network only; access tokens are AEAD-encrypted
  at rest ([src/lib/crypto/aead.ts](../src/lib/crypto/aead.ts)).

## Assets

| Asset | Sensitivity | Location |
|---|---|---|
| Plaid `access_token` (per Item) | Critical — reads transactions | `plaid_items.access_token_ciphertext` (encrypted) + `MONEY_ENCRYPTION_KEY` (env) |
| `MONEY_ENCRYPTION_KEY` | Critical — decrypts every token | env var, not on disk |
| `PLAID_CLIENT_ID` + `PLAID_SECRET` | Critical — mints Link/Items | env var |
| `CLOUDFLARED_TOKEN` | High — controls webhook ingress | env var |
| `SESSION_SECRET` | High — forges sessions | env var |
| Argon2id password hash | Medium — gates UI | `users.password_hash` |
| Transactions, balances, snapshots | High — financial history | DB tables |
| Plaid item_id, account_id, mask | Low — not secret by themselves | DB + webhook bodies |

---

## Surface 1 — Link flow (browser → Plaid → app)

The Plaid Link iframe runs in the browser, the user authenticates at the bank,
Plaid returns a single-use `public_token` to the browser, which posts it to
our `exchangePublicTokenAction` ([actions.ts](../src/app/settings/connections/actions.ts)).
The server then calls `/item/public_token/exchange` to receive the long-lived
`access_token` and `item_id`.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing | Attacker injects a public_token from a different bank/user to attach an unintended Item to our account | Plaid Link is opened with a server-minted `link_token` carrying our `client_user_id`; Plaid binds the public_token to that link_token; the exchange action is authenticated via `requireUser()` ([actions.ts:50](../src/app/settings/connections/actions.ts#L50)). Single-user app — only the password holder can reach `/settings/connections`. | ✅ P4-10, P4-12 |
| **T**ampering | MITM tampers with the public_token in flight to the server | TLS end-to-end (browser → Cloudflare → cloudflared → app). public_tokens are short-lived (~30 min) and single-use — Plaid's exchange API rejects a re-use. | ✅ P4-10, ADR-010 |
| **R**epudiation | User claims a Plaid Item was attached without consent | Plaid's own consent screen is the witness; `plaid_items.created_at` + `productsConsented` (frozen at exchange time) plus the audit row in `plaid_sync_runs` (trigger='initial') provide a local trail. | ✅ P4-03, P4-12, P4-22 |
| **I**nformation disclosure | public_token captured by a malicious browser extension or page script | public_tokens are single-use and expire in ~30 min — a captured token is useful for one exchange. After that, the `access_token` lives only server-side, encrypted. | ⚠️ Accepted — browser-extension compromise is broader than Phase 4 can mitigate. |
| **D**enial of service | Attacker floods `createLinkTokenAction` to exhaust Plaid quota or our budget | Behind `requireUser()` — only the authenticated user can reach it. Plaid's own per-app rate limits absorb misuse. | ✅ Accepted (single-user) |
| **E**levation of privilege | Forged public_token bypasses exchange → gains write access to Items | Exchange call is `requireUser()`-gated; the action lives in [actions.ts](../src/app/settings/connections/actions.ts) and the row insert + token encryption happen in one DB transaction ([actions.ts:148-159](../src/app/settings/connections/actions.ts#L148-L159)) — no half-stored Item can exist. | ✅ P4-12 |

---

## Surface 2 — Token storage at rest

`access_token`s for every connected Item live in
`plaid_items.access_token_ciphertext` (bytea). Format: versioned AEAD envelope
`0x01 || nonce(12) || ct || tag(16)` from
[src/lib/crypto/aead.ts](../src/lib/crypto/aead.ts). Decryption goes through
`loadAccessToken` in [src/lib/plaid/tokens.ts](../src/lib/plaid/tokens.ts) —
the single allowed reader of the column.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing | Attacker substitutes a ciphertext blob to point an Item at their own token | AEAD authenticates the entire envelope; tampering flips the GCM auth tag and `decrypt` throws `CryptoDecryptError` ([aead.ts:142-149](../src/lib/crypto/aead.ts#L142-L149)). Substituting a *valid* envelope requires possession of `MONEY_ENCRYPTION_KEY` (covered below). | ✅ P4-02 |
| **T**ampering | DB attacker flips a byte in `ct` or `tag` to corrupt the stored token | GCM tag verification detects single-bit tamper; `loadAccessToken` propagates `CryptoDecryptError` to the caller; sync worker surfaces this as a job failure rather than silently mis-decrypting. | ✅ P4-02 |
| **R**epudiation | An app developer (or future-self) silently rewrites a token without leaving a trail | Token rewrites happen only via `storeAccessToken` ([tokens.ts:91](../src/lib/plaid/tokens.ts#L91)) or `createPlaidItem` ([tokens.ts:55](../src/lib/plaid/tokens.ts#L55)), both of which stamp `updated_at`. P4-37 rotation runbook documents key rotations explicitly. | ✅ P4-09, P4-37 |
| **I**nformation disclosure — ciphertext only | Attacker exfils `plaid_items.access_token_ciphertext` rows via DB snapshot/backup theft, but not the encryption key | Without `MONEY_ENCRYPTION_KEY`, the ciphertext is AES-256-GCM with a random nonce — practically unrecoverable. **Accepted residual risk** per ADR-009. Backups remain encrypted via `age` (P0-13 spec); the AEAD layer is additional defense in depth. | ⚠️ Accepted — documented in ADR-009 |
| **I**nformation disclosure — ciphertext + key | Attacker exfils both the DB and `MONEY_ENCRYPTION_KEY` | **Catastrophic.** Every access_token reads as plaintext → attacker can pull transaction history from Plaid for as long as the tokens stay valid. Mitigations: (a) the key never lands on disk in production (env var only); (b) docker compose runs the key only inside the app/worker containers, not in cloudflared or postgres; (c) the key-rotation runbook (P4-37) is the recovery path — rotate immediately on suspected compromise, revoke Items via `/item/remove` for every connected institution. | ⚠️ P4-37 + ops |
| **I**nformation disclosure — insider read | An app developer SELECTs `access_token_ciphertext` from an unrelated module, then exfils the bytes | The column is read-allowlisted: only [tokens.ts](../src/lib/plaid/tokens.ts) is permitted. Enforced by a grep-based visibility regression test in [tokens.test.ts](../src/lib/plaid/tokens.test.ts) that fails CI if the column literal appears outside the allowlist files. P4-36 audit re-runs the grep as a hardening checkpoint. | ✅ P4-09, P4-36 |
| **D**enial of service | Attacker corrupts the ciphertext to permanently brick token decrypt → all Plaid sync stops | Token rewrite paths are tx-wrapped; corruption beyond that requires DB write access, which is a broader compromise. Per-Item failure is recoverable via reauth (P4-25) or reconnect — never silently catastrophic. | ✅ P4-12 |
| **E**levation of privilege | Malicious code path in `src/lib/plaid/` learns to call decrypt without going through `loadAccessToken` | The crypto module is dependency-free (`node:crypto` only); adding a wrapper that bypasses the single-reader invariant would have to be reviewed in P4-36's audit. **Open**: no static enforcement beyond the visibility grep — a `decrypt(buf)` call inside `src/lib/plaid/` is allowed today. | ⚠️ Open — `decrypt()` callsites outside `tokens.ts` would slip past the grep. Logged below. |

---

## Surface 3 — Webhook receiver

Plaid POSTs webhooks to `/api/plaid/webhook`
([src/app/api/plaid/webhook/route.ts](../src/app/api/plaid/webhook/route.ts)).
Each request must carry a `Plaid-Verification` JWT (ES256). The route reads
the raw body, verifies the JWT, computes an idempotency hash, INSERTs an audit
row, then enqueues a `sync-plaid-item` job (or directly updates ITEM status).

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing — forged webhook | Attacker posts a fake `SYNC_UPDATES_AVAILABLE` to trick the worker into spinning | Every webhook must include a valid `Plaid-Verification` JWT signed by Plaid's ES256 key, fetched from `/webhook_verification_key/get` and cached for 24h ([webhook-verify.ts](../src/lib/plaid/webhook-verify.ts)). Algorithm pinned to ES256 *before* key lookup to defend against HS256 substitution. Missing/invalid → 401 with no body (no oracle). | ✅ P4-14, P4-15 |
| **T**ampering — body tampering | Attacker mutates a captured webhook body in flight | JWT carries `request_body_sha256`; receiver recomputes over the raw bytes (not the parsed JSON) and rejects if they differ. The P4-31 contract test asserts raw bytes are preserved — round-tripping through JSON would canonicalize whitespace and break the hash. | ✅ P4-14, P4-31 |
| **R**epudiation — was-this-webhook-real? | Future debugging: did Plaid actually send this, or did we fabricate the row? | `webhook_log.body` retains the full verbatim payload; `idempotency_hash` ties the row to a unique `(type \| code \| item_id \| body)`. The signed JWT is verified before insert, so any logged row was provably Plaid-signed. | ✅ P4-15 |
| **I**nformation disclosure — log leakage | Application logs include `Plaid-Verification` or access tokens | Route handler never logs the header or any decrypted token. P4-36 hardening pass re-greps `src/` for `Plaid-Verification` / `access_token` in `console.log` callsites. | ✅ P4-16, P4-36 |
| **D**enial of service — request flood | Attacker discovers the public URL and floods POSTs | 100 req/min per source IP via in-memory token bucket ([rate-limit.ts](../src/lib/plaid/rate-limit.ts)); body cap at 1 MB ([route.ts:31](../src/app/api/plaid/webhook/route.ts#L31)); 8 s handler timeout. Source IP read from `cf-connecting-ip` → `x-forwarded-for[0]` → `x-real-ip` → 'local'. Cloudflare's edge absorbs the worst of any flood before it reaches our bucket. | ✅ P4-16 |
| **D**enial of service — JWT-bomb / huge bodies | Attacker sends a 100 MB body or a JWT with a 1 GB header to exhaust memory | Content-length parsed before `req.text()`; bodies > 1 MB → 413 immediately ([route.ts:53-58](../src/app/api/plaid/webhook/route.ts#L53-L58)). | ✅ P4-16 |
| **D**enial of service — JWKS poisoning | Attacker convinces Plaid's edge to return a key Plaid wouldn't actually sign with | The key cache stores Plaid's response keyed by `kid`; we do not accept arbitrary JWKS URLs. Compromise of Plaid's own signing keys is a Plaid-level incident, out of our trust boundary. | ⚠️ Accepted — depends on Plaid |
| **E**levation of privilege — webhook → job-with-wrong-data | Attacker enqueues a `sync-plaid-item` job for an Item they don't own | Worker re-validates `plaidItemPk` against `plaid_items` and loads the access_token via the encrypted store — there is no way to influence which token gets used short of compromising `plaid_items` rows directly. Single-user app: there is one "owner". | ✅ P4-15, P4-18 |
| **E**levation of privilege — JWT algorithm confusion | Attacker submits an `alg: HS256` JWT with the secret = Plaid's published public key | Verifier asserts `alg === 'ES256'` **before** loading the public key (jose configuration). | ✅ P4-14 |
| **E**levation of privilege — replay older webhook | Attacker captures a valid webhook and re-POSTs to retrigger downstream effects | `idempotency_hash` UNIQUE constraint on `webhook_log` — second POST inserts no row, returns `{ duplicate: true }`, no job enqueued ([route.ts:103-115](../src/app/api/plaid/webhook/route.ts#L103-L115)). The JWT also carries `iat`; verifier rejects timestamps outside a freshness window (5 min). | ✅ P4-14, P4-15 |

---

## Surface 4 — Sync worker (`sync-plaid-item`)

[src/worker/jobs/sync-plaid-item.ts](../src/worker/jobs/sync-plaid-item.ts)
loads an Item, drains `/transactions/sync` (cursor-paginated), and applies the
diff in one DB transaction.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing | Worker enqueued for a fake Item PK | Processor `SELECT`s `plaid_items` by PK; missing row → soft-exit, mark webhook_log processed. No way to forge a downstream side effect on an Item that doesn't exist. | ✅ P4-18 |
| **T**ampering — cursor corruption | DB write or partial commit leaves `transactions_cursor` mid-stream → next sync diverges from Plaid | Cursor advances only inside the DB transaction that applies the diff — partial pagination state is discarded ([sync-plaid-item.ts](../src/worker/jobs/sync-plaid-item.ts) commit step). On crash mid-pagination, the next run resumes from the last-committed cursor; Plaid resends the un-acked pages. | ✅ P4-18 |
| **T**ampering — concurrent webhook + cron + manual | Three triggers race on the same Item; later writes overwrite earlier ones, or cursors leapfrog | BullMQ queue concurrency is **1** for `sync-plaid-item` ([worker/index.ts:81](../src/worker/index.ts#L81)). Jobs queue and drain in series. The job_id pinning further collapses same-day cron + a coincident webhook into a single enqueue per (Item, day). | ✅ P4-18, P4-27 |
| **R**epudiation | "Did the worker really apply these transactions?" Hard to answer later | Every run writes a `plaid_sync_runs` row with `started_at`, `finished_at`, counts, trigger, cursor before/after. The connections page surfaces the last 10 (P4-28). | ✅ P4-18, P4-28 |
| **I**nformation disclosure | Worker logs leak transaction amounts, account names, or access tokens to stdout/stderr | Worker logs only job ids and counts; never the access token or raw Plaid payload. P4-36 hardening pass spies on `console.log` and asserts no sensitive substrings. | ✅ P4-18, P4-36 |
| **D**enial of service — Plaid quota | A flapping Item generates thousands of webhooks → worker hammers Plaid until our app gets rate-limited | Concurrency=1 + per-Item jobId pinning for cron (P4-27); webhook handler does not enqueue when Item status is `login_required`/`revoked`. The same webhook arriving twice dedupes to a single job. | ✅ P4-16, P4-18, P4-27 |
| **D**enial of service — runaway pagination | Plaid returns `has_more=true` forever → worker spins infinitely | The mutation-during-pagination handler restarts at most twice; a deeper loop is bounded by Plaid's own cursor mechanics (each page advances `next_cursor`). **Open**: no explicit page-count ceiling — log row 1 below. | ⚠️ Open (item-bounded; queueable failure) |
| **E**levation of privilege — sync writes to an Item the user doesn't own | N/A in single-user app | Future multi-user: every Item write would need a user-ownership join. Not applicable to Phase 4. | ✅ Accepted (single-user) |
| **E**levation of privilege — TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION exploit | Attacker forces the worker into an infinite restart by toggling Plaid-side state | The handler restarts at most once on mutation-mid-pagination; a second mutation rethrows and the job retries via BullMQ's exponential backoff (max 3 attempts). | ✅ P4-18 |

---

## Surface 5 — Reauth flow (Plaid Link in update mode)

When an Item hits `ITEM_LOGIN_REQUIRED`, the connections page surfaces an amber
Reconnect button (P4-25). Clicking mints an update-mode `link_token` carrying
the existing `access_token`; on Link success, `finalizeReauthAction` flips
status back to `active` and enqueues a sync.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing — forged update link_token | Attacker mints an update-mode link_token for another Item, swaps the bank account behind ours | The link_token in update mode is bound to the access_token Plaid receives — Plaid will only accept an access_token that we hold. The attacker would need to first steal `MONEY_ENCRYPTION_KEY` to read the token (Surface 2). | ✅ P4-25 |
| **T**ampering | Reauth completes with mismatched institution | Plaid enforces same-institution constraint on update mode; we additionally re-check `plaid_items.id` exists before the status flip ([actions.ts:227-239](../src/app/settings/connections/actions.ts#L227-L239)). | ✅ P4-25 |
| **R**epudiation | "Did reauth happen, or did the status flip happen for some other reason?" | `finalizeReauthAction` only flips status to `active` + clears errors; the audit trail is the `plaid_sync_runs` row that follows (trigger='manual') and the `webhook_log` row that landed before (the original ITEM_LOGIN_REQUIRED). | ✅ P4-15, P4-25 |
| **I**nformation disclosure — UI leaks token | Reconnect button accidentally renders the access_token to the DOM | Token never reaches the browser — `loadAccessToken` is called server-side in `createLinkTokenAction`, the result is passed *into* the Plaid SDK request, and only the Plaid-issued `link_token` returns to the client. | ✅ P4-25 |
| **D**enial of service | Repeated Reconnect clicks queue many redundant jobs | `finalizeReauthAction` uses Date.now-suffixed jobIds; worker concurrency=1 drains them serially. Plaid's own /link/token/create rate limits apply. | ✅ P4-25 |
| **E**levation of privilege — hijacked update mode | An attacker who gains UI access (via stolen session) reconnects a different bank | Session compromise is a broader threat. Session cookie protected by `SESSION_SECRET`. Update mode requires user to re-authenticate at the bank's own site — a session-only compromise (no bank credential) yields no new access. | ⚠️ Accepted (session security is iron-session's domain) |

---

## Surface 6 — Disconnect flow

Disconnect calls Plaid `/item/remove`, marks `plaid_items.status='removed'`,
NULLs the linked-account Plaid columns, and wipes the now-dead ciphertext
([actions.ts](../src/app/settings/connections/actions.ts) `disconnectItemAction`).

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing — request a disconnect for an unrelated Item | The UI button targets a specific PK; the action validates the UUID; `requireUser()` gates the call. Single-user → only the owner can reach the button. | ✅ P4-26 |
| **T**ampering — partial disconnect leaves orphan rows | `accounts.plaid_item_id` is set NULL, but `transactions` retain their `account_id`. The Item row is tombstoned (`status='removed'`), not deleted, so existing FKs do not break. | The Item tombstone update + the accounts-clear update happen in one `db.transaction`; ciphertext clear happens after (idempotent — see disconnect comment in [actions.ts:307-329](../src/app/settings/connections/actions.ts#L307-L329)). A row-update mid-transaction failure rolls back, but a later `clearAccessToken` failure leaves the row tombstoned without a token — acceptable, since the token is dead either way. | ✅ P4-26 |
| **R**epudiation — "did this Item get disconnected?" | Tombstone row (`status='removed'`) survives forever; the historic `plaid_item_id` on `transactions.raw` is preserved. Future webhooks for the removed Plaid `item_id` are logged in `webhook_log` and processed as no-ops (unknownItem branch). | ✅ P4-26 |
| **I**nformation disclosure | Plaid `/item/remove` error message includes sensitive Plaid metadata in logs | The catch block in `disconnectItemAction` logs `(err as Error).message` only — Plaid SDK errors of this shape contain `error_code` + `error_message` at most. Access token is not in scope of the SDK's error envelope. | ✅ P4-26 |
| **D**enial of service | Repeated Disconnect clicks while one is in flight | The native confirm() guard + the `useTransition()` disabled-button pattern prevent double-submit from the UI. Server-side: `disconnectItemAction` is idempotent — a second call on a `removed` Item is a no-op (loadAccessToken throws, swallowed; accounts FK update affects 0 rows). | ✅ P4-26 |
| **E**levation of privilege — disconnect cascades a delete of history | The action intentionally avoids `CASCADE` on `accounts.plaid_item_id` — that FK uses `ON DELETE SET NULL`. Transactions and snapshots are never deleted. The P4-34 Playwright spec asserts this invariant by seeding a transaction pre-disconnect and asserting it survives. | ✅ P4-26, P4-34 |

---

## Surface 7 — Investments sync (`sync-investments-item`)

[src/worker/jobs/sync-investments-item.ts](../src/worker/jobs/sync-investments-item.ts)
loads an Item, calls `/investments/holdings/get` (full-snapshot) and
`/investments/transactions/get` (offset-paginated), and upserts
`securities` / `holdings` / `investment_transactions` / `holding_lots` in one
DB transaction. Webhooks (`HOLDINGS`, `INVESTMENTS_TRANSACTIONS`) route here via
the products-based dispatch in the existing receiver (P5-15). It reuses
`loadAccessToken`, `plaid_sync_runs`, and `webhook_log` — none re-derived.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing — wrong-product sync | A `TRANSACTIONS` webhook is routed to the investments worker (or vice-versa), calling an endpoint the Item never consented to | `syncTargetFor` routes by `webhook_type` + the Item's `products_consented`; the worker additionally **guards on `productsConsented.includes('investments')`** and no-ops otherwise ([sync-investments-item.ts](../src/worker/jobs/sync-investments-item.ts)). An investments-only Item never hits `/transactions/sync` and a transactions Item never hits `/investments/*`. | ✅ P5-15, P5-16 |
| **T**ampering — manual data clobbered by sync | A holdings sync overwrites a user-entered cost basis, or deletes a manually-tracked position | Holdings UPSERT preserves cost basis when `cost_basis_overridden_at IS NOT NULL` (SQL `CASE`); reconcile-missing deletes only `source='plaid'` rows, never `source='manual'`. Both behaviors are Vitest-asserted (P5-16). | ✅ P5-16 |
| **T**ampering — partial write on a multi-page sync | A crash between holdings and transactions leaves the Item half-synced | All holdings + securities + transactions + lots writes happen inside a single `db.transaction`; a crash rolls the whole run back. No cursor to corrupt (holdings are full-snapshot; transactions dedup by unique index), so a re-run is idempotent. | ✅ P5-16 |
| **R**epudiation — "did this sync run?" | Hard to tell later whether holdings changed | Each run opens a `plaid_sync_runs` row (trigger), closing it with counts (added=txns, modified=holdings, removed=sold-out) — surfaced on the connections page (P4-28). | ✅ P5-16 |
| **I**nformation disclosure — worker log leakage | The investments worker logs a security name, quantity, amount, or the access token | The worker has **no `console.*` callsites** — failures propagate via `throw` (BullMQ records them). The P5-27 hardening audit was widened to scan **all** of `src/worker/jobs/` (not just `sync-plaid-item.ts`), so any future secret-logging in this worker fails CI. | ✅ P5-27 |
| **I**nformation disclosure — new tables hold secrets | An attacker exfils `securities` / `holding_lots` / `investment_transactions` | None of these columns hold a credential — only public security metadata (ticker, cusip, name), quantities, prices, and dollar amounts. Sensitivity is the same as the existing `holdings`/`transactions` tables (High — financial history), not Critical. No new key-bearing asset. | ✅ ADR-012 |
| **D**enial of service — runaway transaction pagination | Plaid returns `investment_transactions` forever → the worker spins | The offset loop is bounded by `total_investment_transactions` and breaks on an empty page. **Open**: like Surface 4, no explicit page-count ceiling — logged below. | ⚠️ Open (provider-bounded) |
| **D**enial of service — synthetic-price write amplification | A huge holdings response writes a `prices` row per non-tickered security | Bounded by the Item's holding count (a handful); each is a single idempotent UPSERT on `(symbol, date)`. | ✅ Accepted (single-user) |
| **E**levation of privilege — investments token used for transactions | A compromised path reuses an investments access_token against `/transactions/sync` | Tokens are per-Item and product-scoped at Plaid; our worker only ever calls the investments endpoints. Cross-product use would require code that bypasses the worker — caught in review + the SDK-callsite audit (Audit 1/2). | ✅ P5-15, P5-16 |

---

## Cross-cutting controls

The following protections apply to multiple surfaces and are listed once:

- **Authentication gate**: every server action and protected route calls
  `requireUser()` ([src/lib/auth/require-user.ts](../src/lib/auth/require-user.ts)).
  Bypass would require forging an iron-session cookie, which requires
  `SESSION_SECRET`.
- **TLS everywhere**: browser↔Cloudflare, Cloudflare↔cloudflared, app↔Plaid
  API. cloudflared↔app is HTTP over a private docker bridge that is not
  reachable from outside the host.
- **Secret hygiene**: no `NEXT_PUBLIC_PLAID_*` env vars exist; client.ts is
  `import "server-only"` so any client-bundle import errors at build time.
- **Defense-in-depth on the encryption key**: env-only, not on disk;
  documented rotation runbook (P4-37); audit alert if it ever lands in a log
  file (P4-36).
- **Backups**: `pg_dump` cycles encrypted with `age` (per CLAUDE.md §Backup
  Discipline). A stolen backup is ciphertext-on-ciphertext: AEAD inside an
  age-encrypted dump.

---

## Open Items

These are residual or out-of-scope concerns surfaced by the analysis. None
block Phase 4 ship; tracked here so future work has a starting point.

1. **No static enforcement on `decrypt()` callsites within `src/lib/plaid/`** —
   Surface 2 / Elevation. The visibility grep covers the column literal; it
   does not block a future `decrypt(otherBuf)` call from anywhere in the
   allowlist directory. A custom lint rule (Biome plugin) would tighten this;
   P4-36 audit should at least re-grep `decrypt(` callsites and confirm the
   only one outside `aead.ts` itself is in `tokens.ts`.
2. **No explicit page-count ceiling on `/transactions/sync` pagination** —
   Surface 4 / DoS. Plaid's cursor mechanics bound it in practice, but a
   pathological Item could in theory spin the worker. Add a `MAX_PAGES`
   guard (e.g. 1000) in `drainSync` with a clear error if hit.
3. **JWT freshness window is 5 minutes** — Surface 3 / Elevation. Plaid's
   delivery latency is typically < 30 s; a 5-minute window allows replay
   within that window if the JWT is captured before the `webhook_log`
   idempotency row lands. The idempotency hash catches the replay even within
   the window, so the residual risk is negligible — log it here for future
   tightening to 60 s if metrics ever show < 5 s p99 delivery.
4. **Plaid signing-key compromise** — Surface 3 / Spoofing. If Plaid's ES256
   signing key were stolen and revoked, our 24h key cache could continue
   accepting webhooks signed with the compromised key until expiry. Add a
   manual cache-flush admin endpoint in a future hardening pass.
5. **No structured audit log** — Cross-cutting. `console.error` to container
   logs is the only audit channel for failures. A `failed_jobs` UI surface
   (referenced in CLAUDE.md §Background Jobs but not yet built) would be the
   structured complement. Deferred to a future Phase.
6. **Cloudflare's view of metadata** — Surface 1 / Information disclosure.
   Cloudflare sees TLS-encrypted bytes (cannot decrypt) plus IPs, hostnames,
   and timing. Acceptable per ADR-010 and CLAUDE.md §Privacy — no decrypted
   financial data ever leaves our server. Documented here for future-self
   transparency.
7. **No page-count ceiling on `/investments/transactions/get` pagination** —
   Surface 7 / DoS. Mirrors Open Item 2 for the transactions sync. Bounded by
   Plaid's `total_investment_transactions` + an empty-page break, but a
   pathological Item could in theory spin the worker. Add a `MAX_PAGES` guard
   alongside the one proposed for `drainSync`.

---

## How to use this document

When changing any code in `src/lib/plaid/`, `src/app/api/plaid/`,
`src/app/settings/connections/`, `src/worker/jobs/sync-plaid-item.ts`, or
`src/worker/jobs/sync-investments-item.ts`:

1. Identify which surface(s) you're touching.
2. Re-read the corresponding table.
3. If your change weakens a mitigation, the change is a regression — restore
   it or open a follow-up Open Item with rationale.
4. If your change introduces a new threat not listed, add a row.

The P4-36 backend security hardening pass (next task) is the first execution
of this document: every row marked ✅ should have a corresponding grep or
test confirming the mitigation is still in place.
