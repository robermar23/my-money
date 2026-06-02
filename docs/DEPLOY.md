# Deploying my-money

This is the home-server bring-up: Postgres, Redis, the Next.js app, the BullMQ
worker, and a Cloudflare Tunnel for Plaid webhooks. Self-hosted, single-user,
never phones home.

The compose stack assumes you've already followed the Phase 0/3 docs and have
`.env.local` populated. This document focuses on the **production** profile and
the **Cloudflare Tunnel** that exposes Plaid webhooks to the internet without
opening a single port on your home router.

> See also: [RESTORE.md](RESTORE.md) for backup/restore, [PLAID.md](PLAID.md) for
> Plaid Link + reauth troubleshooting, [CRYPTO_ROTATION.md](CRYPTO_ROTATION.md)
> for the encryption-key rotation runbook (P4-37).

## Prerequisites

- Docker Engine ≥ 24 + the `compose` plugin.
- A Cloudflare account (free is fine).
- A domain pointed at Cloudflare for nameservers, OR willing use of a
  `*.trycloudflare.com` quick tunnel (dev-only — the URL changes per session).
- `.env.local` filled in from [.env.example](../.env.example).

## 1. Build images + bring up data services

```sh
# From the repo root.
docker compose -f docker/compose.yaml --profile prod build
docker compose -f docker/compose.yaml up -d postgres redis
```

Wait for the `(healthy)` status on both, then run the migration:

```sh
DATABASE_URL=<your prod url> pnpm db:migrate
```

(`make db-reset` is for dev only — it drops all data.)

## 2. Bring up app + worker

```sh
docker compose -f docker/compose.yaml --profile prod up -d app worker
```

The app binds to `127.0.0.1:4000` on the host (not the public internet) and to
`app:4000` on the `money_net` Docker network. The worker is headless — no
exposed ports. Both read `MONEY_ENCRYPTION_KEY` and `SESSION_SECRET` from the
compose env.

At this point `https://localhost:4000` is reachable from the host. Plaid is
**not** yet reachable — that's the next step.

## 3. Stand up the Cloudflare Tunnel (P4-29)

Per ADR-010, we use Cloudflare Tunnel as the public webhook ingress. The
`cloudflared` sidecar in the compose file dials OUT to Cloudflare's edge — no
inbound port on the home router, no exposed app, TLS terminated at Cloudflare.

### 3.1 — Create the tunnel in the Cloudflare dashboard

1. <https://one.dash.cloudflare.com> → **Networks** → **Tunnels** → **Create a
   tunnel**.
2. Connector: **Cloudflared**. Name it `my-money` (the name is just a label).
3. Save. Cloudflare shows you a one-time-display **tunnel token** — a long
   `eyJhI…` string. Copy it.

> ⚠️ The tunnel token is the production credential for accepting traffic
> destined to your app. Treat it like any other secret. If leaked, rotate via
> the same dashboard ("Refresh token").

### 3.2 — Add the public hostname route

In the same dashboard, on the tunnel's **Public Hostnames** tab:

| Field        | Value                                                                |
|--------------|----------------------------------------------------------------------|
| Subdomain    | e.g. `money` (whatever you want)                                     |
| Domain       | one of your Cloudflare-managed zones                                 |
| Path         | `/api/plaid/webhook` (optional scope; leave blank to forward all)    |
| Service Type | `HTTP`                                                               |
| URL          | `app:4000`                                                           |

Cloudflare will auto-create the DNS record (CNAME → tunnel UUID).

The "Service URL" uses the docker network hostname `app`. cloudflared resolves
this because it shares the `money_net` network with the app container.

### 3.3 — Wire the token into compose

```sh
# Append to your .env.local
echo 'CLOUDFLARED_TOKEN=eyJhI…the_long_string_from_the_dashboard…' >> .env.local
```

Then bring the tunnel up:

```sh
docker compose -f docker/compose.yaml --profile prod up -d cloudflared
```

Watch logs:

```sh
docker compose -f docker/compose.yaml logs -f cloudflared
```

You should see lines containing:

```text
Connection <uuid> registered connIndex=0 location=...
Connection <uuid> registered connIndex=1 location=...
```

— that's the tunnel up. Four connections is normal (edge redundancy).

### 3.4 — Verify

From any internet-connected machine:

```sh
curl -X POST https://money.your-domain.com/api/plaid/webhook \
  -H 'content-type: application/json' \
  -d '{}'
# → HTTP/2 401   (Plaid-Verification header missing → signature check fails)
```

A 401 confirms the path: Plaid's edge → Cloudflare → cloudflared → app → the
webhook route's signature verifier rejected the unsigned body. If you get a
404, the public-hostname route is misconfigured. If you get connection-refused,
the tunnel isn't up.

## 4. Point Plaid Items at the new URL (P4-30)

Existing Plaid Items still have the old `PLAID_WEBHOOK_URL` (or none — Items
created during local dev typically have no webhook URL). Update them in one
shot:

First, set `PLAID_WEBHOOK_URL` in `.env.local` (or export it inline). Then:

```sh
# Dry run first — prints what would change, no Plaid calls.
node --env-file=.env.local --import tsx \
  --import ./scripts/loaders/register.mjs \
  scripts/plaid-set-webhook-url.ts --dry-run

# Commit.
node --env-file=.env.local --import tsx \
  --import ./scripts/loaders/register.mjs \
  scripts/plaid-set-webhook-url.ts
```

You can override the URL per-run with `--url https://other.example.com/api/plaid/webhook`
without touching `.env.local`.

Verify in the Plaid dashboard → Items → each Item's "Webhook" field.

Also bake the URL into `.env.local`:

```ini
PLAID_WEBHOOK_URL=https://money.your-domain.com/api/plaid/webhook
```

so future `link/token/create` calls mint tokens carrying this URL by default.

## 5. Smoke test the live path

In the Plaid dashboard → an Item → **Webhooks** tab → **Send sample**. Pick
`TRANSACTIONS / SYNC_UPDATES_AVAILABLE`. Within seconds you should see:

- A row in `webhook_log` with `status='queued'` then `'processed'`.
- A row in `plaid_sync_runs` for that Item.
- `last_webhook_at` advanced on the `plaid_items` row.

If you don't: tail `docker compose logs app worker cloudflared` and check the
runbook in [PLAID.md](PLAID.md) — the most common failure modes (401, 404,
unknown_item) all have specific diagnoses there.

## Updates

```sh
# Pull new images, recreate.
docker compose -f docker/compose.yaml --profile prod pull
docker compose -f docker/compose.yaml --profile prod up -d
```

`cloudflared` updates take a connection-cycle (~10s). Plaid retries any
webhook that misses delivery for 24h, so a brief tunnel restart is safe.

## Tearing down the tunnel

The Cloudflare side: dashboard → Tunnel → **Delete tunnel**.
The local side: `docker compose -f docker/compose.yaml stop cloudflared` then
remove `CLOUDFLARED_TOKEN` from `.env.local`. The app keeps running locally;
webhooks just stop arriving (the daily 03:00 safety-net cron — P4-27 — picks
up the slack).
