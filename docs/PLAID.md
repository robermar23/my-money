# Plaid setup

End-to-end setup for the Plaid integration: getting credentials, mapping
accounts, sandbox vs. production, and reauth. The deployment-side concerns
(Cloudflare Tunnel, webhook URL) live in [DEPLOY.md](DEPLOY.md); the
day-to-day failure modes live in [RUNBOOK_PLAID.md](RUNBOOK_PLAID.md).

> Per ADR-008: this project consents to the **Transactions** product only,
> against the **Sandbox** environment during development and **Production**
> once the public webhook tunnel is live. No Investments, no Auth, no
> Identity, no Liabilities. One Plaid Item per institution — two M&T accounts
> share a single Item; the credit card is its own.

## Before you start: production access is not guaranteed

Sandbox is open to anyone, but connecting **real** banks needs Plaid to approve
**your own** Plaid account for Production (ADR-053 §6). Plaid reviews each
application, and approval for an individual running a personal project is not
guaranteed. Approval is per operator and not transferable: nobody else's
approval covers your install, and the app cannot ship one.

Find out before you spend a weekend on setup. If you are not approved, every
feature still works from **QFX/CSV import** ([IMPORT.md](IMPORT.md)); you lose
only the automatic daily pull.

## 0. Prerequisites — run BOTH the dev server AND the worker

Plaid sync runs in BullMQ, which lives in a separate worker process. The
dev server alone won't process the initial sync — the job will queue but
never execute, and the connections progress page will sit "waiting for the
worker."

In two terminals:

```sh
# Terminal 1
pnpm dev

# Terminal 2
pnpm worker
```

Forgot the worker? You'll see an amber **"Waiting for the worker to pick up
the job…"** panel on the progress page that calls this out explicitly.

## 1. Get Plaid credentials

1. Sign up at <https://dashboard.plaid.com>. The free Production tier covers
   the first 100 Live Items (we'll use two), so there's no recurring cost.
2. **Team Settings → Keys**. Copy:
   - `client_id` (one per account)
   - `sandbox` secret (use first)
   - `production` secret (use after Sandbox cutover)
3. Paste into `.env.local`:

   ```ini
   PLAID_CLIENT_ID=<your client id>
   PLAID_SECRET=<sandbox secret to start>
   PLAID_ENV=sandbox
   ```

   `PLAID_WEBHOOK_URL` stays empty until you stand up the Cloudflare Tunnel
   ([DEPLOY.md](DEPLOY.md) step 3).

## 2. Smoke-test the credentials

```sh
pnpm plaid:ping
```

Expected: `✓ Sandbox is reachable. public_token prefix='public-sandbox-', …`

A clear error here means `PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV` are
mismatched — the script tells you which.

## 3. Connect your first institution (Sandbox)

1. Open `http://127.0.0.1:4000/settings/connections`.
2. Click **Connect new institution**. Plaid Link opens.
3. **Pick any sandbox institution Plaid shows you.** The lineup changes over
   time — recent sandbox cohorts include `Tartan Bank`, `First Gingham
   Credit Union`, `First Platypus Bank`, and `Houndstooth Bank`. Any of them
   work; the underlying data shape is the same. Click the institution row
   to select it, then **Confirm**.
4. **Sandbox consent screen** — Plaid shows a card reading "my-money is
   building something new / You're helping them test by sharing your account
   data." Click **Share data**.
5. Plaid Link closes and you land back on `/settings/connections` — the new
   Item appears with a green **Active** badge and a yellow **No accounts
   mapped yet — finish setup** prompt. Click **finish setup** to continue.

**Why no credentials prompt?** Sandbox auto-authenticates with `user_good` /
`pass_good` behind the scenes — no real bank to log into. In production,
step 5 would instead show the bank's credentials form, an MFA challenge if
the institution requires one, and then a scope-approval screen
(`Transactions`). For Phase 4 the sandbox shortcut is correct; the
production flow is documented in §6 (Sandbox → Production cutover).

**Force a credentials prompt in sandbox** (for testing failure paths): use
username `user_login_required` or `user_bad` instead of `user_good`. You'll
need to override the Link config to disable auto-login — see
<https://plaid.com/docs/sandbox/> for the per-test username trick. For the
happy path, the auto-flow you saw is the expected behavior.

**If you see a "Select accounts" screen with institution rows BEFORE the
credentials prompt** (per the screenshot in this doc's git history), that
is Plaid's account-selection step. Tap the row of the institution you
want, then **Confirm** — that progresses to the credentials prompt above.
The grey **Confirm** button means nothing is selected yet.

**Other sandbox usernames** (useful for testing failure paths):

- `user_login_required` — forces `ITEM_LOGIN_REQUIRED` on the next sync
  (used by P4-33 reauth spec).
- `user_bad` — credentials rejected at the Link step.

Stick with `user_good` for the happy path; pick the others deliberately.

## 4. Map accounts

The mapping page lists every account Plaid found behind those credentials and
asks one question per row:

- **Link to existing my-money account** — pick this when you already created
  a manual account (P1 flow) and want the Plaid transactions to land on the
  same row. Existing balances, snapshots, and history are preserved (this is
  why we map instead of recreate).
- **Create a new my-money account** — pre-fills the form from Plaid's name,
  type, and currency. Used when there's no manual counterpart.
- **Skip** — Plaid will not pull this account at all (e.g., an M&T money
  market you don't actively track).

Constraint: two Plaid accounts cannot link to the same my-money account. The
mapping action rejects this and surfaces a clear error before any DB write.

After **Confirm mapping**, you're redirected to a polling progress page that
shows the initial sync ticking up. Plaid pulls **up to 24 months of history**
on first sync; the worker paginates through everything and writes
`account_snapshots` for every affected date.

## 5. Wire up webhooks (Cloudflare Tunnel)

> **Optional for local dev.** Webhooks deliver to a public HTTPS URL — if
> you only want to test Link, mapping, and manual **Force sync** on your
> laptop, skip this section. The daily 03:00 cron (P4-27) catches anything
> webhooks would have delivered. Come back here when you're ready for
> "transactions arrive within minutes" UX.

### Running LAN-only (no tunnel)

A supported configuration, not a degraded one (ADR-002, ADR-053 §5). Webhooks
are a **latency optimization**: the nightly safety-net sync (03:00 UTC, P4-27)
pulls every active Item whether or not a webhook arrived. Without a tunnel:

- Leave `PLAID_WEBHOOK_URL` and `CLOUDFLARED_TOKEN` empty, and start only
  `app worker` by name ([DEPLOY.md §2](DEPLOY.md#2-bring-up-app--worker)); skip
  DEPLOY.md §3 and §4.
- Transactions arrive **within a day** instead of within minutes. **Force sync**
  on `/settings/connections` pulls on demand.
- A broken Item (`ITEM_LOGIN_REQUIRED`) surfaces at the next sync rather than
  the moment Plaid notices.
- Remote access, if you want it, can come from any VPN you already run, such as
  Tailscale or WireGuard. Plaid never needs to reach the app.

### With a tunnel

Per ADR-010, public ingress runs through **Cloudflare Tunnel** — a
`cloudflared` container dials OUT to Cloudflare's edge, so no inbound port
opens on your home router. There are two flavors:

### Option A — Quick tunnel (fastest path for local dev)

Zero configuration, zero account setup, fresh URL per session. Good enough
to verify the full webhook pipeline against Sandbox; not for production.

1. Install cloudflared on the host (one-time):

   ```sh
   # macOS
   brew install cloudflared
   # Linux (amd64; adapt arch for Pi/ARM)
   wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O cloudflared
   chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
   # Windows
   winget install --id Cloudflare.cloudflared
   ```

2. Start a quick tunnel pointed at the dev server (terminal 3):

   ```sh
   cloudflared tunnel --url http://127.0.0.1:4000
   ```

   The output prints a URL like
   `https://random-words-1234.trycloudflare.com`. **Copy it.**

3. Set the webhook URL in `.env.local` and restart `pnpm dev` so it picks
   up the env change:

   ```ini
   PLAID_WEBHOOK_URL=https://random-words-1234.trycloudflare.com/api/plaid/webhook
   ```

4. Update any existing Plaid Item to use the new URL:

   ```sh
   pnpm plaid:set-webhook-url
   ```

5. **Verify** from any other machine (or your phone's data connection):

   ```sh
   curl -X POST https://random-words-1234.trycloudflare.com/api/plaid/webhook -d '{}'
   # → 401 (signature missing — good; the path reached Next.js)
   ```

Quick tunnels die when `cloudflared` exits and the URL changes on next
start. That's fine for dev; for production use Option B.

### Option B — Named tunnel (production)

Full walkthrough lives in [DEPLOY.md §3](DEPLOY.md). The summary: create
a tunnel in the Cloudflare dashboard → copy the token → add the
`cloudflared` service from `docker/compose.yaml` (already in the prod
profile) → wire `CLOUDFLARED_TOKEN` in `.env.local` → bring it up with
`docker compose --profile prod up -d cloudflared`. The public hostname
maps to `app:4000` over the docker bridge; nothing is exposed on the host.

### Fire a test webhook from Plaid Sandbox

Once your URL is live and `PLAID_WEBHOOK_URL` is set:

1. Plaid dashboard → Items → click your Item.
2. **Webhooks** tab → **Send sample**.
3. Pick `TRANSACTIONS / SYNC_UPDATES_AVAILABLE`.

The webhook lands at `/api/plaid/webhook`, gets verified (ES256 JWT
signature + raw-body hash), deduped (idempotency hash on
`(type | code | item_id | body)`), logged to `webhook_log`, and enqueued
for the sync worker. Within seconds you should see a new `plaid_sync_runs`
row and `last_webhook_at` advance on `/settings/connections`.

If the test webhook 401s or never arrives, see
[RUNBOOK_PLAID.md](RUNBOOK_PLAID.md) "Webhook 401s" / "Webhook never
arrives".

## 6. Sandbox → Production cutover

When the home server is up, the Cloudflare Tunnel is reachable, and you're
ready to point at real banks:

1. Update `.env.local`:

   ```ini
   PLAID_ENV=production
   PLAID_SECRET=<your production secret>
   PLAID_WEBHOOK_URL=https://money.your-domain.com/api/plaid/webhook
   ```

2. **Re-Link every Item.** Sandbox tokens do not work against Production.
   This means going through `/settings/connections` → **Connect new
   institution** for each real bank, completing the Link flow.
3. Update the webhook URL on every Item (one-shot CLI):

   ```sh
   pnpm plaid:set-webhook-url -- --dry-run
   # then without --dry-run when you're satisfied:
   pnpm plaid:set-webhook-url
   ```

   Verify in the Plaid dashboard that each Item's webhook URL is correct.
4. Trigger a `TRANSACTIONS / SYNC_UPDATES_AVAILABLE` from the dashboard's
   **Send sample** for each Item — confirms end-to-end delivery before you
   wait on a real bank.

## 7. Reauth (when an Item breaks)

Plaid surfaces `ITEM_LOGIN_REQUIRED` when the bank invalidates the access
token — typically after a password change or a periodic MFA challenge. The
connections page picks this up two ways:

- **Synchronously via webhook**: Plaid POSTs `ITEM / ERROR` with
  `error_code: 'ITEM_LOGIN_REQUIRED'`. The route handler flips the local
  status to `login_required` before the next sync attempt and **skips the
  worker enqueue** (it would only re-fail). The connections page shows an
  amber **Reconnect** button.
- **Asynchronously via sync error**: if the webhook is missed but a manual
  or cron-triggered sync runs, the worker classifies the Plaid error code
  and writes the same `login_required` status.

To recover:

1. Click **Reconnect**. Plaid Link opens in **update mode** — same iframe,
   different state machine. Re-enter the bank credentials.
2. On success Plaid emits an `ITEM / LOGIN_REPAIRED` webhook. The route
   handler flips status back to `'active'` and enqueues a sync to catch up
   missed transactions. (The client-side action also calls
   `finalizeReauthAction`, which performs the same flip — redundant on
   purpose; whichever lands first wins.)

If reauth loops (status keeps flipping back to `login_required` within
minutes), see [RUNBOOK_PLAID.md](RUNBOOK_PLAID.md) "reauth loop".

## 8. Disconnect

Click **Disconnect** on a connected Item to tear it down:

1. The action calls Plaid `/item/remove` (best-effort — a Plaid-side error
   doesn't block the local cleanup).
2. `plaid_items.status` becomes `'removed'` and the dead access token
   ciphertext is wiped.
3. Every account linked to the Item has its `plaid_item_id`,
   `plaid_account_id`, and `plaid_mask` set to NULL.
4. **All historical transactions and snapshots remain.** This is the entire
   product value (CLAUDE.md §Domain Scope).

The Item row is kept as a tombstone (`status='removed'`) so future webhooks
for the removed Plaid item_id are processed as no-ops rather than reaching
the worker.

## 9. Security model — quick reference

The full STRIDE analysis is in [THREAT_MODEL_PLAID.md](THREAT_MODEL_PLAID.md).
The five things you should never have to think about because the codebase
already does:

| Concern | What we do |
|---|---|
| Access token at rest | AES-256-GCM with `MONEY_ENCRYPTION_KEY`. Single reader (`loadAccessToken`); column visibility enforced by a regression grep test. |
| Webhook spoofing | ES256 JWT verification with Plaid's published key (24h cache); algorithm pinned before key lookup; raw-body hash check. |
| Webhook replay | Idempotency hash on `(type \| code \| item_id \| body)` with a UNIQUE constraint on `webhook_log`. |
| Webhook DoS | 100/min per source IP token bucket + 1 MB body cap + 8 s handler timeout. |
| Credential exposure | `PLAID_CLIENT_ID/SECRET` read only inside `src/lib/plaid/` (audit grep in CI); `server-only` import on every Plaid client module. |

Key rotation runbook: [CRYPTO_ROTATION.md](CRYPTO_ROTATION.md).
