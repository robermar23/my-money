# Plaid runbook — when things look off

Day-to-day failure modes and how to diagnose them. Setup lives in
[PLAID.md](PLAID.md); deployment lives in [DEPLOY.md](DEPLOY.md); the threat
model lives in [THREAT_MODEL_PLAID.md](THREAT_MODEL_PLAID.md).

> Single-user, self-hosted app. There is no on-call rotation, only future-you
> at 11pm wondering why no transactions arrived today. Be kind to that
> person — start at the top of each section and stop the moment something
> works.

## "Transactions stopped syncing"

### Symptoms

- The dashboard hasn't moved in > 24h.
- The Item's `last_synced_at` on `/settings/connections` is stale.
- A transaction you can see at the bank's website isn't in my-money.

### Triage

1. **Check the Item's status badge** on `/settings/connections`.
   - **Active** + stale `last_synced_at` → webhook delivery problem. Jump to
     "Webhook 401s" or "Webhook never arrives" below.
   - **Reconnect needed** (amber) → password change at the bank. Click
     Reconnect; see PLAID.md §7.
   - **Pending disconnect** (amber) → Plaid says the user will revoke soon
     (usually a 7-day warning from the bank). Reconnect proactively.
   - **Revoked** (red) → the user revoked access at the bank. Disconnect and
     re-Link from scratch.
2. **Force a sync.** Click **Force sync** on the Item. The `plaid_sync_runs`
   table at the bottom of the connections page should show a new row within
   seconds, and its `+ ~ −` counters should be non-zero.
3. **If Force sync errors:**
   - Open the latest `plaid_sync_runs.error` field. Plaid error codes are
     `ITEM_LOGIN_REQUIRED` / `INVALID_CREDENTIALS` / `INTERNAL_SERVER_ERROR`
     / `RATE_LIMIT_EXCEEDED` / etc.
   - For `RATE_LIMIT_EXCEEDED`: wait 5 min, retry. If recurring, you've
     exceeded Plaid's free-tier per-minute call rate; the 03:00 cron also
     hits per-Item limits — check that you don't have many Items in
     `status='active'` (each one gets its own cron run).
4. **The 03:00 safety net.** If nothing else worked, the cron run at 03:00
   local re-tries every active Item. Wait until tomorrow morning and check
   again before doing anything destructive.

### Root causes seen in practice

| Cause | Fix |
|---|---|
| Cloudflare Tunnel down | `docker compose -f docker/compose.yaml logs cloudflared`. Restart with `docker compose ... restart cloudflared`. |
| Plaid Production outage | Check <https://status.plaid.com>. Wait it out; the cron + webhook retry catch up. |
| Webhook URL wrong on the Item | Plaid dashboard → Item → Webhooks. Re-run `scripts/plaid-set-webhook-url.ts`. |
| Worker crashed silently | `docker compose ... logs worker`. Restart. The cursor is committed per sync run, so a restart resumes safely. |

## "Webhook 401s"

### Symptoms

- Plaid dashboard → Item → Webhooks tab shows delivery attempts returning 401.
- `docker compose logs app` shows `401` responses from `/api/plaid/webhook`.

### Triage

1. **Is the Cloudflare Tunnel actually reaching the app?**

   ```sh
   curl -X POST https://money.your-domain.com/api/plaid/webhook \
     -H 'content-type: application/json' -d '{}'
   ```

   401 = good (the signature check fired). 404 = tunnel routing is wrong
   (re-check Public Hostname → `app:4000` in the Cloudflare dashboard). 502
   = the app container is not running.

2. **Is Plaid's signing key fetchable?** The webhook verifier calls
   `/webhook_verification_key/get` on cache miss; if that call fails, every
   webhook 401s. Run `scripts/plaid-ping.ts` to confirm general API
   reachability.

3. **Algorithm or `kid` mismatch.** Plaid signs with ES256 against a `kid`
   that rotates infrequently. The 24h in-memory cache holds the key; if your
   app restarted and the cache is cold, the first webhook triggers a key
   fetch. That fetch should succeed silently — if it errors, you'll see it
   in the app logs.

4. **Clock skew.** The verifier rejects JWTs outside a 5-minute freshness
   window. If the home server's clock is off by more than that, every
   webhook 401s. `timedatectl status` on Linux; sync via NTP if drifted.

### Root causes seen in practice

| Cause | Fix |
|---|---|
| Tunnel up but pointing at wrong upstream | Cloudflare dashboard → tunnel → Public Hostname → URL must be `app:4000`. |
| App container restarted with wrong `PLAID_ENV` | Webhooks signed by Sandbox keys won't verify in Production and vice versa. Check `docker compose exec app printenv PLAID_ENV`. |
| Server clock drifted | NTP. Restart `chrony`/`systemd-timesyncd`. |

## "Webhook never arrives"

### Symptoms

- Plaid dashboard → Item → Webhooks tab shows zero delivery attempts.
- The bank has cleared transactions but the dashboard is stale.

### Triage

1. **Is `PLAID_WEBHOOK_URL` set on the Item?** Plaid only sends webhooks if
   the Item has a webhook URL configured. New Items inherit `PLAID_WEBHOOK_URL`
   from `link_token`, but legacy Items created before the env var was set
   have `webhook = null`.

   Fix: `scripts/plaid-set-webhook-url.ts` (described in [PLAID.md](PLAID.md) §6).
2. **Is the Item still in production?** If you re-Linked in Sandbox during
   debugging, the production Item is gone and the webhook URL never gets a
   recipient.
3. **Is Plaid retrying?** Plaid retries failed webhooks for 24h. If the
   tunnel was down for 3 hours and is now back up, you should see the missed
   webhooks land within minutes.

## "Reauth loop"

### Symptoms

- Click **Reconnect**, complete Plaid Link, status flips to `'active'`.
- Within minutes, status flips back to `login_required`.

### Triage

1. **Did Plaid Link actually succeed?** The reconnect flow in update mode
   doesn't return a `public_token` on success — only an `onSuccess` event.
   If the bank's MFA challenge timed out or you closed the iframe early,
   the access_token is still invalid even though the UI looked fine.

   Click Reconnect again, complete the entire flow, watch for the green
   "success" banner in Plaid Link.

2. **Is the bank itself rate-limiting you?** Some banks lock the account
   after 3-5 failed logins. Wait 30 minutes; try again.

3. **Wrong sandbox username.** In Sandbox, only `user_good`/`pass_good`
   succeeds. The `user_login_required` username intentionally triggers
   `ITEM_LOGIN_REQUIRED` on every sync — useful for testing reauth, fatal
   if you forget to switch back.

4. **Stale link_token.** Link tokens are single-use; closing and re-opening
   the iframe should mint a fresh one. If the connections page's amber
   button reused a cached token (it should not — `createLinkTokenAction`
   mints every time), reload the page first.

### Recovery if reauth keeps failing

Disconnect the Item from `/settings/connections` and re-Link from scratch
("Connect new institution"). Historical transactions stay; only the access
token / cursor / Item row are recreated. The next sync will dedupe against
the surviving FITID-keyed rows.

## "Encryption key lost"

### Scenario A — lost the old key, never rotated

The encryption key (`MONEY_ENCRYPTION_KEY`) is in `.env.local` and **nowhere
else** in this codebase. If `.env.local` is gone and you don't have a backup
of it, every encrypted access token is unrecoverable.

This is **not catastrophic for your financial history.** Transactions and
snapshots are stored in plaintext (it's a single-user self-hosted app); only
the Plaid live link is bricked. Recovery:

1. Generate a fresh `MONEY_ENCRYPTION_KEY` and put it in `.env.local`.
2. Open `/settings/connections`. Every Item will fail to **Force sync** with
   `CryptoDecryptError`.
3. Disconnect each Item from the UI.
4. Re-Link each one from scratch. Historical transactions survive (they're
   keyed by `fitid`, not by access token). The new sync starts fresh and
   dedupes against existing rows.

### Scenario B — lost the new key during rotation

If rotation committed but the new key was lost before you could swap
`.env.local`, the database is now under the lost key and the original key in
the env doesn't decrypt anything.

If you took the pre-rotation backup recommended in
[CRYPTO_ROTATION.md](CRYPTO_ROTATION.md) §1, restore it; the original key
decrypts the restored data.

If the backup is also gone, follow Scenario A's recovery.

### Scenario C — suspected key compromise

Don't just rotate — the attacker may also have the old DB snapshot. Order
matters:

1. Disconnect every Item via `/settings/connections`. This calls Plaid
   `/item/remove`, invalidating the access token Plaid-side.
2. Rotate `MONEY_ENCRYPTION_KEY` per [CRYPTO_ROTATION.md](CRYPTO_ROTATION.md).
3. Re-Link every Item — fresh tokens under the new key.
4. (Optional) Rotate `PLAID_SECRET` from the Plaid dashboard if you suspect
   the env file leaked.

## Useful queries

```sql
-- All Items + last sync + last webhook.
SELECT institution_name, status, last_synced_at, last_webhook_at, error_code
FROM plaid_items
WHERE status <> 'removed'
ORDER BY last_synced_at DESC NULLS LAST;

-- Recent sync runs across every Item.
SELECT pi.institution_name, psr.trigger, psr.started_at, psr.finished_at,
       psr.added_count, psr.modified_count, psr.removed_count, psr.error
FROM plaid_sync_runs psr
JOIN plaid_items pi ON pi.id = psr.plaid_item_id
ORDER BY psr.started_at DESC
LIMIT 20;

-- Webhook activity in the last 24h.
SELECT webhook_type, webhook_code, plaid_item_id, status, received_at, processed_at
FROM webhook_log
WHERE received_at > NOW() - INTERVAL '24 hours'
ORDER BY received_at DESC;

-- Failed jobs (BullMQ side — only queryable via Redis, not Postgres).
docker compose -f docker/compose.yaml exec redis redis-cli LLEN bull:sync-plaid-item:failed
```

## When to ask for help

This is a single-user app — there is no "help" beyond your own future
diagnosis. But: if a failure pattern looks like it belongs in this runbook
and isn't yet, add it. Future-you will thank you.
