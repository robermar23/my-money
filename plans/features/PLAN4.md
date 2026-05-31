# PLAN — Phase 4 (Plaid Push Integration)

> Phase 4 is the riskiest phase in this project. We're handing Plaid the keys to the user's M&T checking, M&T savings, and credit card accounts; storing long-lived access tokens encrypted at rest; standing up a publicly-reachable webhook endpoint; and changing the daily transaction-flow from "user drags a QFX in once a month" to "transactions arrive within minutes of posting." Every other Phase, if broken, produces a wrong number on a dashboard. This one, if broken, leaks financial credentials.
>
> The goal of this plan is to take Phase 4 from "scary" to "boring." Every Plaid Safety Rule from [../../CLAUDE.md](../../CLAUDE.md) is mapped to a concrete task. Encryption, signature verification, idempotency, and reauth all get their own atomic, verifiable steps. The QFX importer from Phase 3 stays — it's now the fallback when Plaid is broken, not the primary path.
>
> **Companion docs** — read these for context, do not duplicate them here:
> - [FEATURE.md](FEATURE.md) — what we're building
> - [IDEAS.md](IDEAS.md) — locked ADRs (001-007) + §4.1, §4.5 institution tables + decision log
> - [SKILLS.md](SKILLS.md) — Phase 4 skills map (Suggested Workflow → Phase 4)
> - [PLAN0_1.md](PLAN0_1.md) — Phase 0/1 (auth, schema, snapshot job, dashboard)
> - [PLAN3.md](PLAN3.md) — Phase 3 (importer pipeline that Plaid plugs into)
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Plaid Safety Rules, §Secrets & Environment, §Background Jobs, §Schema Invariants

---

## What already exists (do not rebuild)

Phase 0/1/2/3 produced infrastructure Phase 4 *extends* rather than parallels. Before writing code, inventory:

- **Schema**: `accounts`, `holdings`, `account_snapshots`, `liabilities`, `prices`, `fx_rates`, `users`, `transactions`, `import_batches`, `category_rules` — all in [src/db/schema/](../../src/db/schema/). Phase 4 adds `plaid_items`, `webhook_log`, `plaid_sync_runs` and **extends** `accounts` with three nullable Plaid columns.
- **Transactions pipeline**: [src/lib/importers/persist.ts](../../src/lib/importers/persist.ts) already INSERTs into `transactions` with `ON CONFLICT (account_id, fitid) DO NOTHING`. Phase 4's sync worker reuses this dedup primitive — Plaid's `transaction_id` becomes the `fitid` for `source='plaid'` rows.
- **Categorizer**: [src/lib/categorization/match.ts](../../src/lib/categorization/match.ts) — regex rule engine runs over every imported transaction. Phase 4 routes Plaid rows through it unchanged. Plaid's `personal_finance_category` is captured into `raw` for later use as a categorization seed.
- **Snapshots**: [src/lib/importers/persist.ts](../../src/lib/importers/persist.ts) already upserts `account_snapshots` after each import. Phase 4's sync uses the same upsert path with `source='plaid'` as the trigger.
- **Reconciliation banner**: [src/app/accounts/[id]/reconciliation-banner.tsx](../../src/app/accounts/%5Bid%5D/reconciliation-banner.tsx) already shows "imported balance vs. computed-from-transactions" drift. After Phase 4 the banner anchors against Plaid's `/accounts/balance/get` cached balance.
- **BullMQ scaffolding**: [src/lib/queue/queues.ts](../../src/lib/queue/queues.ts) has a commented-out `SYNC_PLAID_ITEM` slot; [src/worker/index.ts](../../src/worker/index.ts) shows the pattern for adding new workers + repeatable jobs.
- **Auth & secrets**: [src/lib/auth/](../../src/lib/auth/) provides `requireUser()` for every protected route. The `MONEY_ENCRYPTION_KEY` env var slot already exists (per [PLAN0_1.md](PLAN0_1.md) P0-05). Phase 4 finally *uses* it.

---

## ADRs locked at plan time

Three decisions surface in Phase 4 that warrant ADRs. All three are ✅ locked below. After this plan is approved, append them to IDEAS.md §11 Decision Log.

---

### ADR-008 — Plaid environment & product scope: Sandbox → Production directly, Transactions only

**Status**: ✅ Locked 2026-05-31

**Context**:
IDEAS.md §4.1 cited "Plaid Development tier — free for first 100 Items." That tier was retired by Plaid in 2024–2025 in favor of a Sandbox / Production split: **Sandbox is free and unlimited** (test institutions only); **Production has the first 100 Live Items free**, then ~$0.30/connection/month for Transactions. The "Development" middle tier no longer exists. We must pick which environment and which products to enable.

We also need a per-product call. Plaid sells Transactions, Auth, Identity, Investments, Liabilities, Income, Assets, etc. Phase 4 IDEAS.md §9 already scopes the *accounts* — M&T checking, M&T savings, credit card — so the product question is "which Plaid products do these three connections need?"

**Decision**:

1. **Environment**: develop entirely against **Sandbox**. Move to **Production** (skipping the retired Development tier) only when we open a public webhook (P4-29 below). Sandbox has fake institutions, fake credentials, and webhook-fire-on-demand — perfect for the bulk of this phase.
2. **Products consented**: **`transactions` only**. Not Auth (we don't initiate ACH), not Identity (we don't KYC), not Investments (deferred to Phase 5 for Fidelity), not Liabilities (Sunwest mortgage is handled by amortization math, not Plaid).
3. **One Plaid Item per institution**, not per account. The two M&T accounts share a single Item. The credit card is its own Item. Two Items total at end of Phase 4 — well inside the 100-free ceiling.

**Consequences**:
- ✅ Zero recurring Plaid cost for the foreseeable future (two Items × $0 each on the free Production tier).
- ✅ Minimum-scope OAuth consent — the user grants exactly the data we read.
- ✅ Sandbox webhooks fire on-demand via `/sandbox/item/fire_webhook` — we can build the entire receiver/idempotency/sync loop without waiting for a real bank.
- ⚠️ Sandbox does not exercise every production failure mode (per CLAUDE.md §Plaid Safety Rules — sandbox does not reflect production complexity). Specifically: real `ITEM_LOGIN_REQUIRED` from a password change is hard to simulate; `INVALID_CREDENTIALS` is reproducible via sandbox username `user_login_required`. Mitigation: P4-22 (item-error handling) is exercised via the sandbox helpers; we expect to fix one or two production-only quirks after first live use.
- ⚠️ Migrating to Production requires regenerating client credentials and re-running Link for each Item — sandbox tokens are not portable. Plan for ~30 min of cutover work at deploy time.

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Stay in Sandbox forever | We'd never see real transactions — defeats the entire phase. |
| Add Investments product now | Fidelity is Phase 5; consenting now consumes a separate Plaid product line and complicates Link UX. |
| Add Liabilities product for the mortgage | IDEAS.md §4.4 already locked amortization math as the cheaper, exact approach. |
| Use a Plaid-alternative (SimpleFIN, MX, Finicity) | Already ruled out in IDEAS.md §4.1 — Plaid is cheaper at this scale and the TS SDK is best-in-class. |

---

### ADR-009 — Token encryption: AES-256-GCM via `node:crypto` (zero deps)

**Status**: ✅ Locked 2026-05-31

**Context**:
CLAUDE.md §Plaid Safety Rules: "Plaid access tokens MUST be encrypted at rest. Use `node:crypto` AES-GCM or `libsodium-wrappers` with a key from `process.env.MONEY_ENCRYPTION_KEY`."

Two viable choices:

| Option | Cipher | Verdict |
|---|---|---|
| `libsodium-wrappers` | XChaCha20-Poly1305 | Modern AEAD, 192-bit nonce → no nonce-collision worry, but adds 200 KB of WASM and an async init. ⚠️ |
| **`node:crypto` AES-256-GCM** | AES-256-GCM | Built into Node 22; 96-bit nonce (safe with a random nonce per encrypt — collision probability negligible at our write rate); FIPS-aligned. ✅ |

Both are AEADs and both are cryptographically appropriate. The discriminator is the dependency cost: at a write rate of "a handful of tokens, ever," AES-256-GCM is the cleaner pick.

**Decision**: Implement `src/lib/crypto/aead.ts` exporting `encrypt(plaintext: Buffer): Buffer` and `decrypt(ciphertext: Buffer): Buffer`. Format on disk:

```
[version: 1 byte = 0x01][nonce: 12 bytes][ciphertext: variable][auth tag: 16 bytes]
```

Key source: `process.env.MONEY_ENCRYPTION_KEY` (32 raw bytes, base64-encoded in the env var). Validated at module load — missing/short key crashes the process at boot, not at first encrypt.

**Consequences**:
- ✅ Zero new npm dependency on a security-critical code path.
- ✅ Versioned format → future migration to XChaCha or larger keys is a `if (version === 0x02) ...` branch.
- ✅ The on-disk blob is self-describing — `decrypt` doesn't need out-of-band parameters.
- ⚠️ AES-GCM nonce-reuse with the same key is catastrophic. We generate a fresh 12-byte random nonce per encryption via `crypto.randomBytes(12)`. At our throughput (≤ ~10 encryptions per token lifecycle) collision probability is < 2⁻⁶⁰ — irrelevant.
- ⚠️ Losing `MONEY_ENCRYPTION_KEY` bricks every encrypted token. The README's restore section already calls this out (per [PLAN0_1.md](PLAN0_1.md) P0-15); we add a "rotation" runbook in P4-32.

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| libsodium-wrappers (XChaCha20-Poly1305) | WASM init friction, larger surface, no security upside at our scale. |
| `pg_crypto` server-side encryption | Key lives in the DB → backup of the DB also contains the key. AES at the app layer keeps key + ciphertext separable. |
| Encrypt with the user's password-derived key | Loses tokens on every login change; password isn't always loaded server-side at sync time (the worker has no session). |

---

### ADR-010 — Webhook public exposure: Cloudflare Tunnel (no open ports)

**Status**: ✅ Locked 2026-05-31

**Context**:
Plaid webhook delivery requires an internet-reachable HTTPS endpoint. IDEAS.md Decision-Log row 13 deferred this choice; Phase 4 forces it.

| Option | Setup | Trade-off |
|---|---|---|
| **Cloudflare Tunnel** (cloudflared sidecar) | Free, requires a Cloudflare-managed domain or a `*.trycloudflare.com` quick tunnel for dev. | Zero open ports on the home box. TLS terminated at Cloudflare. ✅ |
| Tailscale Funnel | Tailscale-managed reverse proxy. Generous free tier. | TLS on `*.ts.net`. Works, but Plaid's webhook delivery from Tailscale-Funnel domains has occasional reachability hiccups reported in community channels. ⚠️ |
| `ngrok` paid plan | Battle-tested, fast setup, requires a paid plan for a stable URL. | Recurring monthly cost — defeats the "free hosting" line in IDEAS.md §8. |
| Port-forward home router → Caddy | Free, but exposes the home box's WAN IP and requires opening port 443. | Largest attack surface; explicitly avoided in IDEAS.md ADR-002. ❌ |

**Decision**: **Cloudflare Tunnel** as the production webhook delivery path. Local development uses `cloudflared tunnel --url http://localhost:3000` against a quick tunnel (fresh URL per session is fine because Plaid Sandbox webhook URLs are mutable via `/item/webhook/update`).

**Consequences**:
- ✅ No open inbound ports on the user's home network.
- ✅ Cloudflare's edge absorbs DDoS and provides automatic TLS.
- ✅ The user already owns or can register a `$10/year` domain to point at the tunnel — this is the only realistic Phase-4 dollar cost.
- ⚠️ Cloudflare is a third party in the path. They see TLS-encrypted bytes (cannot decrypt) and metadata (IP, hostname, timing). Acceptable per CLAUDE.md §Privacy: nothing decrypted leaves our server, only encrypted transit metadata.
- ⚠️ Webhook reachability is now dependent on Cloudflare's edge being up. If it isn't, Plaid retries for 24h; our daily safety-net cron (P4-17) catches anything missed.

**Alternatives considered** — see table above. None of the rejected options were close.

**Implementation note**: The Tunnel itself is *not* part of the my-money codebase; it's a `cloudflared` container in [docker/compose.yaml](../../docker/compose.yaml) plus a Cloudflare account configuration documented in `docs/DEPLOY.md` (P4-33). The app simply binds to `0.0.0.0:3000` inside its private network and trusts that `cloudflared` is what's in front of it.

---

## Phase 4 — Goal

After Phase 4 ships, the M&T checking/savings and credit card accounts auto-sync. Concretely:

1. The user opens `/settings/connections`, clicks **"Connect M&T Bank"**, completes Plaid Link in a popup, and sees both M&T checking and M&T savings appear linked to existing manually-created accounts (or auto-created ones if the user chose).
2. Within minutes of a transaction posting at M&T, a `TRANSACTIONS / SYNC_UPDATES_AVAILABLE` webhook arrives, is verified, deduped, enqueued, and processed by the `sync-plaid-item` worker. The new transaction lands in `transactions` with `source='plaid'`; the dashboard reflects it on next render.
3. The initial sync pulls up to 24 months of history per Item — populating `transactions` and triggering `account_snapshots` upserts for every day in that window.
4. If a connection breaks (password change → `ITEM_LOGIN_REQUIRED`), the connections page shows an amber banner with a **"Reconnect"** button that opens Plaid Link in update mode. After the user re-enters credentials, sync resumes from the same cursor.
5. The QFX importer from Phase 3 remains; the import-batches UI now shows `source='qfx'` for old imports and `source='plaid'` for the new flow. Reconciliation banner anchors against Plaid's cached balance via `/accounts/balance/get`.
6. A daily 03:00 safety-net cron triggers `sync-plaid-item` for every active Item in case a webhook was dropped.

---

## Phase 4 — Schema (new tables + accounts extensions)

All new tables follow CLAUDE.md §Database & Drizzle Specifics: UUID PKs, `numeric` for money (n/a here — no money columns in Phase 4 schema), `timestamp({ withTimezone: true })`, `jsonb` for raw payloads, one schema file per concept under `src/db/schema/`.

```text
src/db/schema/
├── plaid-items.ts          (NEW)
├── webhook-log.ts          (NEW)
├── plaid-sync-runs.ts      (NEW)
├── accounts.ts             (UPDATED: 3 nullable Plaid columns)
└── index.ts                (UPDATED: re-export the three new)
```

### `plaid_items` (one row per Plaid Item — one per institution)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `defaultRandom()` |
| `plaid_item_id` | `text` UNIQUE NOT NULL | Plaid's `item_id`, returned by `/item/public_token/exchange`. Used by webhook handlers to look up our row. |
| `institution_id` | `text` NOT NULL | Plaid's `ins_xxxx` ID, returned by `/item/get`. |
| `institution_name` | `text` NOT NULL | Display name, e.g., `'M&T Bank'`. |
| `access_token_ciphertext` | `bytea` NOT NULL | AES-256-GCM blob per ADR-009. **Never logged. Never returned from server actions.** |
| `transactions_cursor` | `text` | Plaid `/transactions/sync` cursor. NULL = initial sync needed. |
| `products_consented` | `text[]` NOT NULL | E.g. `{'transactions'}`. Tracked separately from what we *actually call* so we can audit scope drift. |
| `status` | `text` NOT NULL DEFAULT `'active'` | `'active' \| 'login_required' \| 'pending_disconnect' \| 'revoked' \| 'removed'`. Drives the connections-page UI. |
| `error_code` | `text` | Plaid error code from the last failure (e.g. `'ITEM_LOGIN_REQUIRED'`). |
| `error_message` | `text` | Human-readable error from Plaid. |
| `last_synced_at` | `timestamptz` | Timestamp of the last successful sync run. |
| `last_webhook_at` | `timestamptz` | Timestamp of the last webhook received for this Item. |
| `created_at` / `updated_at` | `timestamptz` | |

**Indexes**:

```sql
CREATE UNIQUE INDEX plaid_items_plaid_item_id_unique ON plaid_items (plaid_item_id);
CREATE INDEX plaid_items_status_idx ON plaid_items (status) WHERE status != 'removed';
```

**CHECK constraint**:

```sql
ALTER TABLE plaid_items ADD CONSTRAINT plaid_items_status_check
  CHECK (status IN ('active', 'login_required', 'pending_disconnect', 'revoked', 'removed'));
```

### `webhook_log` (idempotency table for Plaid webhooks)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `idempotency_hash` | `text` UNIQUE NOT NULL | SHA-256 of `(webhook_type \| webhook_code \| item_id \| canonical-JSON-body)`. **Primary dedup key** per CLAUDE.md §Plaid Safety Rules. |
| `webhook_type` | `text` NOT NULL | E.g. `'TRANSACTIONS'`, `'ITEM'`. |
| `webhook_code` | `text` NOT NULL | E.g. `'SYNC_UPDATES_AVAILABLE'`, `'ERROR'`. |
| `plaid_item_id` | `text` | Plaid's item_id from the body; nullable for the few webhook types that don't carry one. |
| `body` | `jsonb` NOT NULL | Full webhook body, captured verbatim for debugging. |
| `received_at` | `timestamptz` NOT NULL `defaultNow()` | |
| `processed_at` | `timestamptz` | NULL until the enqueued job completes. |
| `status` | `text` NOT NULL DEFAULT `'queued'` | `'queued' \| 'processed' \| 'duplicate' \| 'failed'`. |
| `error` | `text` | On `'failed'`, the exception message. |

**Indexes**:

```sql
CREATE UNIQUE INDEX webhook_log_idempotency_hash_unique ON webhook_log (idempotency_hash);
CREATE INDEX webhook_log_plaid_item_id_received_at_idx ON webhook_log (plaid_item_id, received_at DESC);
```

**Why a row even for duplicates**: when a duplicate hash arrives, we still INSERT (or attempt to) — the UNIQUE conflict tells us it's a dupe and we record `status='duplicate'` via a separate non-conflict path. Audit trail > silent drop.

### `plaid_sync_runs` (one row per `/transactions/sync` invocation)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `plaid_item_id` | `uuid` FK → plaid_items NOT NULL | `onDelete: cascade` — when an Item is fully removed, its sync history goes too. |
| `started_at` | `timestamptz` NOT NULL `defaultNow()` | |
| `finished_at` | `timestamptz` | NULL while in flight. |
| `cursor_before` | `text` | NULL on initial sync. |
| `cursor_after` | `text` | The cursor advanced to. NULL on failure. |
| `added_count` | `integer` NOT NULL DEFAULT 0 | |
| `modified_count` | `integer` NOT NULL DEFAULT 0 | |
| `removed_count` | `integer` NOT NULL DEFAULT 0 | |
| `pagination_count` | `integer` NOT NULL DEFAULT 1 | How many `/transactions/sync` calls this run made. |
| `trigger` | `text` NOT NULL | `'webhook' \| 'manual' \| 'cron' \| 'initial'`. |
| `error` | `text` | Plaid error code or local exception message on failure. |

**Index**:

```sql
CREATE INDEX plaid_sync_runs_item_started_at_idx ON plaid_sync_runs (plaid_item_id, started_at DESC);
```

### `accounts` extensions

Add **three nullable columns** to the existing `accounts` table — keeping Phase 4 backwards-compatible with manual accounts:

| Column | Type | Notes |
|---|---|---|
| `plaid_item_id` | `uuid` FK → plaid_items | `onDelete: set null` — disconnecting an item must NOT cascade-delete the account or its history. |
| `plaid_account_id` | `text` UNIQUE | Plaid's `account_id` (from `/accounts/get`). UNIQUE because a given Plaid account maps to exactly one of our accounts. |
| `plaid_mask` | `text` | Last-4-digits (or whatever Plaid returns). Display-only. |

**No new column** for `plaid_official_name` or `plaid_subtype` — those live in the `raw` jsonb of the most-recent sync run if we ever need them. YAGNI.

**Migration order**: ALTER `accounts` BEFORE creating `plaid_items` is impossible (the FK points the wrong way), so the migration script:

1. `CREATE TABLE plaid_items` (no FK back to accounts — by design).
2. `ALTER TABLE accounts ADD COLUMN plaid_item_id uuid REFERENCES plaid_items(id) ON DELETE SET NULL`.
3. `ALTER TABLE accounts ADD COLUMN plaid_account_id text UNIQUE`.
4. `ALTER TABLE accounts ADD COLUMN plaid_mask text`.
5. `CREATE TABLE webhook_log`, `CREATE TABLE plaid_sync_runs`.

### No new enums

Same posture as PLAN3.md §category-rules: `plaid_items.status` is plain `text` + a CHECK constraint. We anticipate adding `'historical_update_pending'` between Phase 4 and Phase 5; enum-add migrations are heavier than dropping a CHECK.

### `transactions.source` extension

`source='plaid'` is **already** allowed by the CHECK constraint shipped in PLAN3.md ([src/db/schema/transactions.ts:87](../../src/db/schema/transactions.ts#L87)). No migration needed.

---

## Phase 4 — Tasks

Each task is shippable in isolation, has explicit verification, and follows the conventions in CLAUDE.md. Order matters where one task gates another — flagged in-line.

### Pre-flight & secrets

- [ ] **P4-01** — Add Plaid env vars to [.env.example](../../.env.example): `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox` for now, `production` later), `PLAID_WEBHOOK_URL` (the public URL Plaid will POST to — set later via P4-29), and confirm `MONEY_ENCRYPTION_KEY` is already present from Phase 0. Document in the file header how to generate the key (`openssl rand -base64 32`). → **Verify**: `pnpm dev` boots when `.env.local` has placeholder values; missing `MONEY_ENCRYPTION_KEY` crashes at boot with a clear error (this lives in P4-02, but lockstep).
- [ ] **P4-02** — Build the AEAD module per ADR-009. Create [src/lib/crypto/aead.ts](../../src/lib/crypto/aead.ts) exporting:
  - `encrypt(plaintext: Buffer): Buffer` and `decrypt(ciphertext: Buffer): Buffer`
  - `loadKey()` (idempotent, throws if `MONEY_ENCRYPTION_KEY` is missing/short)
  - Versioned format: `0x01 || nonce(12) || ct || tag(16)`
  - Pure `node:crypto` (`createCipheriv('aes-256-gcm', ...)`)
  → **Verify**: [src/lib/crypto/aead.test.ts](../../src/lib/crypto/aead.test.ts) covers roundtrip, tamper detection (flip a byte → `decrypt` throws), wrong-key rejection, version-byte mismatch rejection, key-missing crash. **Property test** (via `fast-check`): for random plaintexts of length 1..1024, `decrypt(encrypt(x)) === x`.

### Schema + migrations

- [ ] **P4-03** — Add `plaid_items` schema. Create [src/db/schema/plaid-items.ts](../../src/db/schema/plaid-items.ts) per the spec above. `accessTokenCiphertext` uses the same `customType<Buffer>` pattern as [src/db/schema/import-batches.ts:23](../../src/db/schema/import-batches.ts#L23). Re-export from [src/db/schema/index.ts](../../src/db/schema/index.ts). Run `pnpm db:generate`. → **Verify**: migration applies cleanly; `\d plaid_items` shows the UNIQUE on `plaid_item_id`, the partial status index, and the CHECK constraint.
- [ ] **P4-04** — Extend `accounts` with three nullable Plaid columns. Edit [src/db/schema/accounts.ts](../../src/db/schema/accounts.ts) (this is fine; an additive schema change). Generate the migration; verify it produces a `ADD COLUMN`-only diff (no destructive changes). → **Verify**: existing rows are unaffected; `plaid_item_id` and `plaid_account_id` default to NULL on all existing rows.
- [ ] **P4-05** — Add `webhook_log` schema. → **Verify**: `\d webhook_log` shows the UNIQUE on `idempotency_hash`; inserting two rows with the same hash fails with a UNIQUE-violation error (caught + handled in P4-12).
- [ ] **P4-06** — Add `plaid_sync_runs` schema. → **Verify**: cascade-delete works — deleting a `plaid_items` row via SQL deletes its sync-run rows.
- [ ] **P4-07** — Apply all schema migrations as a single ordered set (`drizzle/0004_*.sql`). → **Verify**: `pnpm exec drizzle-kit check` passes; full `make db-reset && pnpm db:migrate` is green; psql lists `plaid_items`, `webhook_log`, `plaid_sync_runs` and the new columns on `accounts`.

### Plaid SDK wrapper

- [ ] **P4-08** — Add the Plaid SDK. `pnpm add plaid`. Create [src/lib/plaid/client.ts](../../src/lib/plaid/client.ts) wrapping `PlaidApi` with configuration from env. **Never exposes credentials beyond this module.** Exports a single `plaidClient` instance. → **Verify**: a one-shot smoke test (`pnpm exec node --experimental-strip-types scripts/plaid-ping.ts` or a Vitest) calls `/sandbox/public_token/create` against Plaid Sandbox and returns a valid public_token.
- [ ] **P4-09** — Add the encrypted-token helpers. Create [src/lib/plaid/tokens.ts](../../src/lib/plaid/tokens.ts) exporting `storeAccessToken(plaidItemId, accessToken)`, `loadAccessToken(plaidItemId)`, and `rotateEncryption(oldKey, newKey)` (used only by the rotation runbook in P4-32 — leave as a stub if needed). Tokens are encrypted via P4-02. `loadAccessToken` is the ONLY allowed reader; nothing else may decrypt. → **Verify**: unit test confirms a roundtrip; a deliberate `console.log` of an `accounts.accessTokenCiphertext` field in a non-helper module fails Biome lint via a custom rule (or a regression test that greps `src/` for the column name and confirms it appears only inside `src/lib/plaid/`).

### Link flow (frontend + backend)

- [ ] **P4-10** — Build the Link-token server action. Create [src/app/settings/connections/actions.ts](../../src/app/settings/connections/actions.ts) with `createLinkTokenAction({ accessTokenForUpdate?: string })`. Calls `/link/token/create` with `products: ['transactions']`, the user's family ID as `client_user_id`, `webhook` = `PLAID_WEBHOOK_URL` (if set). Returns the single-use `link_token`. **Never caches the token.** → **Verify**: action returns a token in dev; calling it twice returns two distinct tokens.
- [ ] **P4-11** — Build the Link UI. Create [src/app/settings/connections/page.tsx](../../src/app/settings/connections/page.tsx) (server component, gated by `requireUser()`) listing all `plaid_items` and rendering a **"Connect new institution"** CTA. Create [src/app/settings/connections/link-button.tsx](../../src/app/settings/connections/link-button.tsx) (`'use client'`) that lazily loads `react-plaid-link` (`pnpm add react-plaid-link`) and opens Plaid Link with the token from P4-10. On success → invokes server action `exchangePublicTokenAction(publicToken)`. → **Verify**: in Sandbox, clicking the button opens Plaid Link → "First Platypus Bank" → success returns a public_token. (Confirmation of the exchange step lives in the next task.)
- [ ] **P4-12** — Build the public-token exchange action. `exchangePublicTokenAction(publicToken)` in the same actions.ts:
  - Calls `/item/public_token/exchange` → gets `access_token` + `item_id`.
  - Calls `/item/get` → gets `institution_id`.
  - Calls `/institutions/get_by_id` → gets `institution_name`.
  - Calls `/accounts/get` → gets the list of Plaid accounts under this Item.
  - Persists `plaid_items` row (with encrypted access_token), then redirects to `/settings/connections/[plaidItemId]/map` for account mapping.
  - **Wraps token storage + Item row + (no accounts yet) in a single DB transaction** so a half-stored Item can't exist.
  → **Verify**: Sandbox flow lands a row in `plaid_items`; the access_token round-trips through encrypt/decrypt and matches the value the Plaid client receives back.
- [ ] **P4-13** — Build the account-mapping UI. [src/app/settings/connections/[plaidItemId]/map/page.tsx](../../src/app/settings/connections/%5BplaidItemId%5D/map/page.tsx): for each Plaid account, the user picks one of:
  - **Link to an existing my-money account** (dropdown of currently-unlinked manual accounts of matching `type`).
  - **Create a new account** (uses Plaid's name + subtype to pre-fill).
  - **Skip** (don't pull this account at all — e.g., the user already has an unused M&T money-market and doesn't want it tracked).
  Server action `mapAccountsAction(plaidItemId, mappings)` writes `accounts.plaid_account_id` + `plaid_item_id` + `plaid_mask` for each mapping, creates new accounts where requested, and **enqueues an initial sync job** (P4-15) on commit. → **Verify**: mapping a Plaid checking account to an existing manual "M&T Checking" account leaves the manual account's existing snapshots intact; mapping to "Create new" creates an account with `type='depository'`.

### Webhook receiver

- [ ] **P4-14** — Build the webhook signature verifier. Create [src/lib/plaid/webhook-verify.ts](../../src/lib/plaid/webhook-verify.ts) exporting `verifyWebhook(headers: Headers, rawBody: string): Promise<VerifiedWebhook | null>`:
  - Reads the `Plaid-Verification` JWT from headers.
  - Fetches the corresponding `key_id` from Plaid via `/webhook_verification_key/get` (cached in-memory with a 24h TTL, refresh on cache-miss key).
  - Verifies the JWT signature (ES256) using `jose` (`pnpm add jose`).
  - Confirms the JWT's `request_body_sha256` matches `sha256(rawBody)`.
  - Returns `null` on any failure — caller responds 401.
  → **Verify**: unit tests cover: valid signature → returns body; tampered body → returns null; expired JWT → returns null; unknown `key_id` → fetched then verified.
- [ ] **P4-15** — Build the webhook route handler. Create [src/app/api/plaid/webhook/route.ts](../../src/app/api/plaid/webhook/route.ts) — a `POST` handler:
  1. Reads the raw body as text (no JSON parsing yet — signature is over the raw bytes).
  2. Calls `verifyWebhook(headers, rawBody)`. On null → 401.
  3. Parses body as JSON. Computes `idempotencyHash = sha256(webhook_type | webhook_code | item_id | canonicalJSON(body))`.
  4. Attempts to `INSERT INTO webhook_log ... ON CONFLICT (idempotency_hash) DO NOTHING RETURNING id`. If RETURNING is empty → dupe → return 200 immediately.
  5. Looks up `plaid_items` by `plaid_item_id`. If absent → log + return 200 (don't NACK — Plaid would retry forever).
  6. Enqueues a `sync-plaid-item` BullMQ job with `{ plaidItemId, webhookLogId, webhookCode }`.
  7. Updates `plaid_items.last_webhook_at = now()`.
  8. Returns 200 in **< 5 seconds** — all heavy work is in the queue, not in the request.
  → **Verify**: integration test runs against a fixture webhook body + a known JWT — verifies the full happy path inserts a row, enqueues a job, returns 200. Tampered body → 401. Duplicate hash → status `'duplicate'` and a *new* webhook_log row is NOT inserted (this is the ON CONFLICT DO NOTHING behavior; we only mark `status='duplicate'` on the path that branches before the insert, see body for P4-15).
- [ ] **P4-16** — Per CLAUDE.md §Plaid Safety Rules, the webhook handler MUST be hardened. Apply these in P4-15's implementation:
  - **No logging of `Plaid-Verification` header** or the raw access token. Audit log greps `git diff` for `access_token` / `Plaid-Verification` in `console.log` calls.
  - **Rate-limit** the route: max 100 req/min per source IP via an in-memory token bucket (`@upstash/ratelimit` would be overkill — a 20-line LRU is enough; single-user app, attacker volume is low).
  - **Strict timeout**: the entire handler must return within 8 seconds (Plaid's delivery timeout is 30s but we want to surface latency issues early).
  → **Verify**: a malformed signature returns 401 with no body details; a 100/min flood returns 429 after the threshold.

### Sync worker job

- [ ] **P4-17** — Add the `sync-plaid-item` queue. In [src/lib/queue/queues.ts](../../src/lib/queue/queues.ts), uncomment `SYNC_PLAID_ITEM` (currently a `//` comment line at the bottom of the `QUEUE_NAMES` block) and export the queue. → **Verify**: `pnpm worker` registers the new queue without error.
- [ ] **P4-18** — Implement the sync worker. Create [src/worker/jobs/sync-plaid-item.ts](../../src/worker/jobs/sync-plaid-item.ts) exporting `syncPlaidItemProcessor(job)`:
  - Job payload: `{ plaidItemId: string, trigger: 'webhook' | 'manual' | 'cron' | 'initial', webhookLogId?: string }`.
  - Loads the Item, decrypts the access token via P4-09.
  - Inserts a `plaid_sync_runs` row, status in-flight.
  - Calls `/transactions/sync` with `cursor = plaid_items.transactions_cursor` (NULL on initial). Paginates until `has_more = false`, accumulating `added`, `modified`, `removed`.
  - **Mutation handling** per CLAUDE.md §Plaid Safety Rules: if the API returns `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, discard accumulated results and restart from `cursor=null`. (Plaid documents this; it's rare but real.)
  - **Apply changes** in a single DB transaction:
    - For each `added` and `modified`: map to `NewTransaction` via P4-19's mapper, INSERT ... ON CONFLICT (account_id, fitid) DO UPDATE SET amount/name/memo/category/raw — modified rows update in place.
    - For each `removed`: DELETE from `transactions` WHERE `account_id = ? AND fitid = ?`. (Plaid removes transactions when the institution retracts them — rare, e.g., a pending charge dropped before posting.)
    - Update `plaid_items.transactions_cursor = next_cursor`, `last_synced_at = now()`, clear error fields.
    - UPSERT `account_snapshots` for affected dates using the same path as the QFX importer (reuse [src/lib/importers/persist.ts](../../src/lib/importers/persist.ts) helper, factored out in P4-21).
  - Mark `plaid_sync_runs` finished with counts.
  - If `webhookLogId` was provided, UPDATE `webhook_log` SET `processed_at = now()`, `status = 'processed'`.
  - **Idempotency**: on retry the cursor doesn't advance until the DB transaction commits, so re-running from the same cursor is safe.
  → **Verify**: integration test against Plaid Sandbox — call `/sandbox/item/fire_webhook` with `SYNC_UPDATES_AVAILABLE`, observe transactions land. **Idempotency test**: run the job twice manually with the same cursor → second run inserts 0 rows.
- [ ] **P4-19** — Build the Plaid → `NormalizedTransaction` mapper. Create [src/lib/plaid/map.ts](../../src/lib/plaid/map.ts) exporting `plaidToTransaction(plaidTxn, accountId)`:
  - `fitid = plaidTxn.transaction_id` (already globally unique per Item).
  - `posted_at = plaidTxn.authorized_date ?? plaidTxn.date` (prefer authorized — closer to "when it actually happened").
  - **Sign convention**: Plaid: positive = debit/outflow. OFX (our DB): positive = credit/inflow. **Flip**: `amount = (-plaidTxn.amount).toFixed(2)` — done with string math via `Money`, never `Number()`.
  - `name = plaidTxn.merchant_name ?? plaidTxn.name`.
  - `memo = plaidTxn.payment_meta?.payee ?? null`.
  - `category = null` (rule engine fills it in via P4-20).
  - `raw = plaidTxn` — full payload retained for Phase 5 use of `personal_finance_category`, cost basis, etc.
  → **Verify**: unit tests cover sign flip, fitid stability, `authorized_date` preference, missing-merchant-name fallback.
- [ ] **P4-20** — Wire the categorizer into the sync path. The mapper in P4-19 leaves `category` null; the sync job then runs each new/modified row through `matchCategory(name, memo, rules)` (already exists at [src/lib/categorization/match.ts](../../src/lib/categorization/match.ts)) before insert. Modified rows whose `category_overridden_at IS NOT NULL` skip categorization (override is sticky). → **Verify**: in a sync containing a "STARBUCKS" transaction, the row lands with `category='Restaurant'` per the default seed rules.
- [ ] **P4-21** — Factor out the snapshot-upsert helper from [src/lib/importers/persist.ts](../../src/lib/importers/persist.ts) into [src/lib/snapshots/upsert.ts](../../src/lib/snapshots/upsert.ts) so the sync job can reuse it without importing the QFX-specific module. The QFX importer continues to use it; no behavior change there. → **Verify**: Vitest test confirms the extracted helper produces byte-identical rows to the old in-line code on a known input.

### Initial backfill & history

- [ ] **P4-22** — Initial sync path. When `mapAccountsAction` (P4-13) commits, enqueue `sync-plaid-item` with `trigger='initial'`. The sync logic in P4-18 handles initial vs. incremental identically — it's the absent cursor that triggers Plaid to return historical data. **Plaid pulls up to 24 months of history on the initial `/transactions/sync` call**; the worker just keeps paginating. → **Verify**: a fresh Sandbox Item produces a multi-page sync; `plaid_sync_runs.pagination_count > 1` on the first run.
- [ ] **P4-23** — Initial-sync progress UI. The mapping page (P4-13) redirects to a progress page that polls `plaid_items` every 3 seconds. Status shows `'syncing'` (computed from `EXISTS(plaid_sync_runs WHERE plaid_item_id = ? AND finished_at IS NULL)`) → `'active'` when complete. → **Verify**: in a browser, mapping accounts → progress page shows a counter ticking up → "X transactions synced" → redirect to the dashboard.

### Item-error handling + reauth

- [ ] **P4-24** — Map Plaid error codes to `plaid_items.status`. In the sync worker (P4-18), when `/transactions/sync` returns an error, classify per CLAUDE.md §Plaid Safety Rules:
  - `ITEM_LOGIN_REQUIRED` → `status='login_required'`
  - `PENDING_DISCONNECT`, `PENDING_EXPIRATION` → `status='pending_disconnect'`
  - `USER_PERMISSION_REVOKED`, `USER_ACCOUNT_REVOKED` → `status='revoked'`
  - Anything else → leave `status='active'`, populate `error_code` + `error_message`, fail the job (BullMQ retries it).
  Webhook codes from `WEBHOOK_TYPE='ITEM'` write the same statuses synchronously (we don't need to wait for the next sync attempt to learn the item is broken). → **Verify**: in Sandbox, force `ITEM_LOGIN_REQUIRED` via the `user_login_required` test username; the connections page shows `'Reconnect needed'` within seconds of the resulting webhook.
- [ ] **P4-25** — Reauth UI (Plaid Link in update mode). On the connections page, items with `status='login_required'` show an amber "Reconnect" button. Clicking it invokes `createLinkTokenAction({ accessTokenForUpdate: <decrypted token> })` — the Plaid SDK accepts an existing access token in `/link/token/create` to put Link in update mode. On Link success → no `public_token` exchange (the existing access_token is kept). The worker enqueues `sync-plaid-item` immediately to confirm recovery. → **Verify**: in Sandbox, trigger `ITEM_LOGIN_REQUIRED`, click Reconnect, complete update Link → status flips back to `'active'`; pending transactions sync.
- [ ] **P4-26** — Disconnect flow. On the connections page, a "Disconnect" button on each Item invokes `disconnectItemAction(plaidItemId)`:
  - Calls Plaid `/item/remove` (best-effort — if Plaid errors, log + continue; the local state is what matters).
  - UPDATE `plaid_items` SET `status='removed'`, clear `access_token_ciphertext` to NULL (the token is dead after `/item/remove`).
  - Set `accounts.plaid_item_id = NULL`, `plaid_account_id = NULL`, `plaid_mask = NULL` for every account linked to this Item — **but leave all `transactions` and `account_snapshots` in place** (preserving history is the entire product).
  → **Verify**: disconnecting an Item leaves prior transactions visible on the account page; subsequent webhooks for the removed `item_id` are logged as `'duplicate'`-no-op style entries (status `'queued'` then immediately processed to a no-op).

### Daily safety net

- [ ] **P4-27** — Add a daily sync-everything cron. In [src/worker/index.ts](../../src/worker/index.ts), upsert a job scheduler at `03:00` (after the snapshot job's 02:00 slot) that enqueues `sync-plaid-item` (trigger=`'cron'`) for every Item with `status='active'`. Catches missed webhooks; idempotent at our scale. → **Verify**: pause webhook delivery for a day (or simulate by skipping the webhook path), confirm transactions still arrive after the 03:00 run.

### Connections-page polish

- [ ] **P4-28** — Connections page detail. The settings page shows per-Item: institution name, masked accounts, status badge, `last_synced_at`, `last_webhook_at`, button row (Reconnect / Disconnect / Force sync). Adds a "Force sync now" action that enqueues `sync-plaid-item` immediately (`trigger='manual'`). Also adds a per-Item sync-runs panel showing the last 10 `plaid_sync_runs` rows with added/modified/removed counts. → **Verify**: "Force sync now" enqueues a job; the panel renders with real counts post-sync.

### Deployment — public webhook (the bridge to Production)

- [ ] **P4-29** — Add `cloudflared` to Docker Compose. Edit [docker/compose.yaml](../../docker/compose.yaml) to add a `cloudflared` service (image `cloudflare/cloudflared:latest`) running `tunnel run --token $CLOUDFLARED_TOKEN`. The service is in the `web` network and routes `https://<your-domain>/api/plaid/webhook` → `app:3000/api/plaid/webhook`. Document tunnel-token generation in `docs/DEPLOY.md`. → **Verify**: `docker compose up cloudflared` brings the service to `Connected` state; `curl https://<your-domain>/api/plaid/webhook -X POST` reaches Next.js (returns 401 because the body isn't a real signed webhook — confirming the path).
- [ ] **P4-30** — Update Plaid Item webhook URLs. For each `plaid_items` row, call `/item/webhook/update` to point at the new public URL. Implement once as a one-shot CLI script ([scripts/plaid-set-webhook-url.ts](../../scripts/plaid-set-webhook-url.ts)). → **Verify**: in Plaid dashboard, each Item shows the correct webhook URL.

### Tests + E2E

- [ ] **P4-31** — Vitest unit + integration tests (most already specified inline). The contract-style test suite for Phase 4:
  - `aead.test.ts` (P4-02) — roundtrip, tamper, wrong-key, version-byte.
  - `plaid/tokens.test.ts` (P4-09) — encrypt + DB roundtrip + visibility lint.
  - `plaid/webhook-verify.test.ts` (P4-14) — valid signature, tampered body, expired JWT, unknown key_id.
  - `plaid/map.test.ts` (P4-19) — sign flip, fitid stability, authorized_date preference.
  - `worker/jobs/sync-plaid-item.test.ts` (P4-18) — happy path against a stubbed Plaid client, mutation-during-pagination retry, idempotent re-run, removed-transaction handling.
  - `app/api/plaid/webhook.route.test.ts` (P4-15) — 401 on bad sig, 200 on dupe, 200 + enqueued on first valid receipt, body parsed as raw text not JSON.
  → **Verify**: `pnpm test` passes with meaningful (non-vacuous) assertions for every file above; coverage of `src/lib/plaid/` and `src/worker/jobs/sync-plaid-item.ts` is high enough that a deliberate logic flip in any guard clause fails a test.
- [ ] **P4-32** — Playwright E2E: `e2e/phase4-link.spec.ts`. Flow: login → `/settings/connections` → "Connect new institution" → opens Plaid Link in Sandbox → completes with `user_good`/`pass_good` against First Platypus Bank → account mapping page → maps a Plaid checking account to a pre-existing manual "Sandbox Checking" → initial sync progress page → dashboard shows the new transactions. Uses Plaid Sandbox `/sandbox/public_token/create` to bypass the popup in CI (Link's iframe is famously hard to drive headless; the test simulates the post-Link callback directly when running in CI). → **Verify**: `pnpm exec playwright test e2e/phase4-link.spec.ts` is green against a freshly-reset DB + the Sandbox client.
- [ ] **P4-33** — Playwright E2E: `e2e/phase4-reauth.spec.ts`. Drives the `ITEM_LOGIN_REQUIRED` recovery flow end-to-end using `/sandbox/item/reset_login` to break an Item, then walks the user through reauth. → **Verify**: green.
- [ ] **P4-34** — Playwright E2E: `e2e/phase4-disconnect.spec.ts`. Disconnect an Item → confirm transactions remain visible → confirm the account row shows "Disconnected" badge → confirm subsequent webhooks for the removed item are processed as no-ops. → **Verify**: green.

### Threat model + security hardening pass

- [ ] **P4-35** — STRIDE threat model (per SKILLS.md Tier 2 → `threat-modeling-expert`). Document in `docs/THREAT_MODEL_PLAID.md`. Cover the surfaces:
  - **Link flow** (browser → Plaid → app): public_token theft, replay; mitigation = single-use tokens, server-side exchange.
  - **Token storage**: theft of `access_token_ciphertext` without the key (acceptable risk); theft of both (catastrophic — rotation runbook P4-37); insider read by an app developer (mitigation: P4-09's read-isolation).
  - **Webhook receiver**: forged webhooks, replay, body tampering, signature key compromise, rate-flood, body-size DOS.
  - **Sync worker**: cursor corruption, race between webhook and cron, mutation-during-pagination recovery.
  - **Reauth flow**: hijacked reauth via a forged update-mode link_token.
  - **Disconnect**: rogue disconnect leaving orphan plaid_account_id rows (caught by P4-26).
  → **Verify**: the document exists and has a row per (Spoofing/Tampering/Repudiation/Info-disclosure/DoS/Elevation) per surface, with the mitigation pointing at a specific PLAN4.md task. Anything without a mitigation is an open item — log it in §Open Items.
- [ ] **P4-36** — Backend security hardening (per SKILLS.md Tier 3 → `backend-security-coder`). Checklist:
  - Webhook route is rate-limited (P4-16).
  - All Plaid SDK calls run only in server actions, route handlers, and BullMQ workers — never in `'use client'` files. Audit via grep.
  - `process.env.PLAID_*` are read only in `src/lib/plaid/` modules — audit via grep.
  - `access_token_ciphertext` column is never SELECTed in any module outside `src/lib/plaid/tokens.ts`. Add a Drizzle pattern (`db.select({...without ciphertext})`) used in the connections-page query; codify with an ESLint-style custom rule or a regression test that greps `accessTokenCiphertext` outside the allowed file.
  - Webhook body size cap at 1 MB (Plaid bodies are typically < 10 KB; cap defends against deliberate body-bomb).
  - Logs in `src/lib/plaid/` and `src/worker/jobs/sync-plaid-item.ts` redact: access tokens, JWT verification headers, raw account numbers, masks. Audit via a Vitest that runs the modules with a `console.log` spy and confirms no sensitive substrings appear.
  → **Verify**: each checklist item has a corresponding test or grep-based audit; CI runs them.
- [ ] **P4-37** — Encryption-key rotation runbook in `docs/CRYPTO_ROTATION.md`. Steps: generate new key → set `MONEY_ENCRYPTION_KEY_NEW=...` alongside `MONEY_ENCRYPTION_KEY` → run `pnpm exec node --experimental-strip-types scripts/rotate-encryption.ts` (re-encrypts each `plaid_items` row in a transaction, swapping the version byte to `0x01` always but with the new key) → swap env var → delete `MONEY_ENCRYPTION_KEY_NEW`. No code change for now — leave the script as a stub if writing it ships the runbook. → **Verify**: a dry-run on a Sandbox DB succeeds; tokens decrypt with the new key only.

### Documentation

- [ ] **P4-38** — Update [README.md](../../README.md) §Usage with the new ritual: "Plaid auto-syncs M&T and the credit card; check the connections page if anything looks off." Add `docs/PLAID.md` covering: Sandbox vs. Production setup, getting client_id/secret, deploying `cloudflared`, mapping accounts, reauth troubleshooting. Add a `docs/RUNBOOK_PLAID.md` covering: "transactions stopped syncing" / "webhook 401s" / "reauth loop" / "encryption key lost." → **Verify**: a fresh reader (or a future-self in a year) can follow the docs end-to-end.

---

## Phase 4 Done When

- [ ] All four new database objects exist (`plaid_items`, `webhook_log`, `plaid_sync_runs`, and three nullable columns on `accounts`) with constraints per spec.
- [ ] `pnpm test` covers AEAD, token storage, webhook verification, Plaid→transaction mapper, and the sync worker with meaningful assertions (not vacuous round-trips).
- [ ] `pnpm exec playwright test e2e/phase4-link.spec.ts`, `e2e/phase4-reauth.spec.ts`, `e2e/phase4-disconnect.spec.ts` all green against Plaid Sandbox.
- [ ] In a browser, against Sandbox: completing Plaid Link for First Platypus Bank → mapping its accounts → initial sync ticks to completion → transactions appear on the account page and the dashboard.
- [ ] Forcing `ITEM_LOGIN_REQUIRED` via the `user_login_required` Sandbox path flips the connections page to an amber banner; clicking Reconnect resolves it.
- [ ] Re-receiving the same webhook body produces zero side effects (idempotency holds).
- [ ] The 03:00 safety-net cron triggers `sync-plaid-item` for every active Item; pausing webhooks for a day still produces eventual sync.
- [ ] Disconnecting an Item preserves all prior transactions and account_snapshots; subsequent webhooks for that Item are no-ops.
- [ ] STRIDE doc `docs/THREAT_MODEL_PLAID.md` exists and every row has a mitigation pointing at a Phase 4 task (or an explicit "accepted risk" note).
- [ ] `pnpm check` clean (Biome + tsc).
- [ ] ADR-008, ADR-009, ADR-010 appended to [IDEAS.md](IDEAS.md) §11 Decision Log; the deferred row 13 is marked resolved by ADR-010.

---

## Skills Map (per task cluster)

Per [SKILLS.md](SKILLS.md) §Suggested Workflow → Phase 4. Don't load them all upfront; invoke when the cluster opens.

| Task cluster | Primary skill(s) |
|---|---|
| P4-01 (env vars + secrets shape) | `secrets-management` |
| P4-02 (AEAD module) | `test-driven-development`, `secrets-management`, `typescript-pro` |
| P4-03 → P4-07 (schema + migrations) | `drizzle-orm-expert`, `postgres-best-practices` |
| P4-08 → P4-09 (Plaid client wrapper + token store) | `plaid-fintech`, `secrets-management`, `backend-security-coder` |
| P4-10 → P4-13 (Link flow + mapping UI) | `nextjs-app-router-patterns`, `zod-validation-expert`, `plaid-fintech` |
| P4-14 → P4-16 (webhook receiver) | `plaid-fintech`, `backend-security-coder`, `zod-validation-expert` |
| P4-17 → P4-21 (sync worker + mapper + categorizer wiring + snapshot helper) | `bullmq-specialist`, `plaid-fintech`, `test-driven-development`, `drizzle-orm-expert` |
| P4-22 → P4-23 (initial sync + progress UI) | `bullmq-specialist`, `nextjs-app-router-patterns` |
| P4-24 → P4-26 (item-error + reauth + disconnect) | `plaid-fintech`, `nextjs-app-router-patterns` |
| P4-27 (safety-net cron) | `bullmq-specialist` |
| P4-28 (connections UI polish) | `nextjs-app-router-patterns`, `tailwind-patterns` |
| P4-29 → P4-30 (cloudflared + webhook URL update) | `docker-expert` |
| P4-31 → P4-34 (Vitest + Playwright) | `e2e-testing-patterns`, `test-driven-development` |
| P4-35 (STRIDE) | `threat-modeling-expert`, `007` |
| P4-36 (backend security pass) | `backend-security-coder`, `007` |
| P4-37 (key rotation runbook) | `secrets-management` |
| P4-38 (docs) | — |

---

## Open Items (out of scope for this plan, captured for future PLAN docs)

- **Plaid Investments product (Phase 5)** — Fidelity brokerage holdings + cost basis. Requires consenting the `investments` product and adding a separate sync path against `/investments/holdings/get` and `/investments/transactions/get`. Reuses the `plaid_items` and `webhook_log` infrastructure built here.
- **Transfer detection across Plaid accounts** — recognizing "M&T checking → credit card payment" as a single transfer event rather than two unrelated transactions. Deferred to Phase 5 (also flagged in PLAN3.md §Open Items).
- **Plaid `personal_finance_category` as a categorizer seed** — Phase 4 captures the field into `raw` but does not feed it into the rule engine. A future small change can seed `category_rules` from the most-common PFC pairings, but it's polish not blocker.
- **Production-tier migration runbook** — beyond P4-29's deploy steps, document the Plaid dashboard configuration ("which products are enabled", "which webhook URL"), and the cutover from Sandbox to Production credentials (regenerate `PLAID_SECRET`, re-Link every Item). Lives in `docs/DEPLOY.md` after the first real run.
- **Webhook replay capability** — when debugging, being able to re-process a `webhook_log` row would be useful. Trivial to add but YAGNI until needed. (Just `UPDATE webhook_log SET status='queued'` + re-enqueue would suffice; one server action + a button on a debug-only admin page.)
- **`/accounts/balance/get` daily fetch** — Plaid's cached balance updates faster than transactions. The reconciliation banner could anchor against it explicitly. Phase 4 leaves the banner using the existing computed-from-transactions logic; this is a Phase 5+ polish.
- **Selective product upgrades per Item** — e.g., adding Liabilities to the M&T mortgage Item later. Add an `enable_product` server action and a UI for it when we ever need it.

---

*End of PLAN4.md*
