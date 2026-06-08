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

### 1.1 — ARM64 (Raspberry Pi / ARM NAS) builds

The image builds clean for both `linux/amd64` and `linux/arm64` — every native
dependency has a glibc arm64 prebuild (`@node-rs/argon2`, Next's SWC, Tailwind's
`lightningcss`) and the runtime-stage `pg_dump` (PGDG apt) + `age` (bookworm
main) both ship arm64. The base is **Debian bookworm-slim (glibc)**, not alpine,
which is what makes those `-gnu` prebuilds the right ones.

If you build **on the Pi itself**, the plain `docker compose build` above is
already native arm64 — nothing extra to do. To cross-build from an amd64 machine
and push a multi-arch image (or just produce an arm64 image via emulation):

```sh
# One-time: enable QEMU emulation + a buildx builder.
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx create --use --name money-builder   # once

# Build both arches. Add --push to send to a registry, or --load for a single
# arch into the local daemon (--load can't hold a multi-arch manifest).
docker buildx build --platform linux/amd64,linux/arm64 -t my-money:latest .
```

Emulated arm64 builds are slow but correct; building on the Pi is faster if you
can spare the time there.

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

### 2.1 — Verify the health probe (P6-22)

The `app` service has a Docker healthcheck that hits its own `/api/health`
endpoint, which confirms Postgres + Redis are reachable. Confirm it from the
host:

```sh
curl localhost:4000/api/health
# → {"status":"ok"}   (HTTP 200)

docker compose -f docker/compose.yaml ps
# → the `app` row shows (healthy) once the start_period elapses (~20s)
```

The endpoint is intentionally unauthenticated and **content-free** — it returns
only `{"status":"ok"}` or `{"status":"error"}` (503), never a version, hostname,
or dependency error. Stop Postgres and it flips to 503; the body still leaks
nothing. The granular failure reason goes to the `app` container log only.

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
pnpm plaid:set-webhook-url -- --dry-run

# Commit.
pnpm plaid:set-webhook-url
```

You can override the URL per-run with `-- --url https://other.example.com/api/plaid/webhook`
without touching `.env.local`. (The leading `--` is the pnpm convention for
"pass the rest to the script.")

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

## 6. Backups + exports (off-host replication)

The worker runs two longevity jobs nightly (both **opt-in** via env):

| Job                      | When  | Writes to         | What it is                                  |
|--------------------------|-------|-------------------|---------------------------------------------|
| `backup-database-daily`  | 04:00 | `/backups` volume | `pg_dump` piped to `age` — encrypted dump   |
| `export-beancount-daily` | 04:30 | `/exports` volume | plain-text beancount mirror (one-way hedge) |

### 6.1 — Enable encrypted backups (ADR-014)

1. Generate an `age` keypair **off this server** (your laptop / a password
   manager host):

   ```sh
   age-keygen -o money-backup.key
   # prints:  Public key: age1qz...   ← the RECIPIENT
   ```

2. Put **only the public key** in `.env.local`:

   ```ini
   BACKUP_AGE_RECIPIENT=age1qz...
   BACKUP_RETAIN_DAYS=14
   ```

   `BACKUP_DIR=/backups` is already set on the worker by compose. The job stays
   disabled until a recipient is present.

3. **Keep the private key (`AGE-SECRET-KEY-...`) OFF the server** — password
   manager, paper, a second machine. A compromise of this box must not be able
   to read your backup history. This is the whole point of asymmetric backup
   encryption; see [RESTORE.md](RESTORE.md) for the decrypt/restore drill.

4. Recreate the worker to pick up the env, then force one run to verify:

   ```sh
   docker compose -f docker/compose.yaml --profile prod up -d worker
   # optional immediate run instead of waiting for 04:00:
   docker compose -f docker/compose.yaml exec worker \
     node --import tsx src/worker/run-once.ts backup-database-daily
   docker compose -f docker/compose.yaml exec worker ls -lh /backups
   # → money-YYYY-MM-DD-HHMMSS.dump.age
   ```

### 6.2 — Enable the beancount export (ADR-016)

`BEANCOUNT_DIR=/exports` is already set on the worker by compose, so this one is
on by default in prod. It's a one-way, plain-text copy of data already in
Postgres — not a secret, but it **is** plaintext financial data, so treat the
directory as private.

### 6.3 — Off-host replication (your responsibility)

The `backups` and `exports` Docker volumes survive container restarts but **not**
a dead disk. Replicate them off-host on your own schedule — e.g. a host-side
cron:

```sh
# Resolve the volume mountpoints on the host:
docker volume inspect my-money_backups -f '{{ .Mountpoint }}'
docker volume inspect my-money_exports -f '{{ .Mountpoint }}'

# Then rsync / restic / rclone them to a second disk or Backblaze B2, etc.
rclone sync /var/lib/docker/volumes/my-money_backups/_data b2:my-money-backups
```

The dumps are already encrypted, so a third-party object store (B2, S3) is fine
for them. The beancount export is plaintext — send it only somewhere you trust,
or encrypt it in transit/at rest yourself.

## 7. Alert notifications (SMTP, optional)

Anomaly detection (05:00) always writes to the `alerts` table surfaced at
`/alerts`. Email is **optional and notification-only**: it carries a count and a
sign-in link and **zero financial data** — no amounts, accounts, or merchants.
Those live only behind auth on `/alerts`. We ship no default mail relay; the
transport is your own SMTP server.

```ini
# .env.local — leave SMTP_URL empty to use only the in-app /alerts page.
SMTP_URL=smtp://user:pass@mail.example.com:587
ALERT_EMAIL_TO=you@example.com
# ALERT_EMAIL_FROM=        # defaults to ALERT_EMAIL_TO
APP_BASE_URL=https://money.your-domain.com   # builds the /alerts link

# Thresholds (optional — defaults shown):
ALERT_LARGE_TXN_USD=2000
ALERT_BALANCE_DROP_PCT=25
ALERT_STALE_DAYS=3
```

Add these env vars to the `worker` service if you set them (the compose file
passes the backup/export vars through; mirror those entries for the SMTP/alert
vars when you enable email). Verify with a forced run:

```sh
docker compose -f docker/compose.yaml exec worker \
  node --import tsx src/worker/run-once.ts detect-anomalies-daily
```

## 8. What runs when (nightly timeline)

All jobs are BullMQ repeatable jobs scheduled in
[src/worker/index.ts](../src/worker/index.ts) — **not OS cron** — so the
schedule lives inside the app and is visible to the worker on boot. Times are
the worker container's local time; set the host/container `TZ` accordingly.

| Time  | Job                          | Why this order                                  |
|-------|------------------------------|-------------------------------------------------|
| 01:30 | `fetch-prices-daily`         | prices land before holdings are valued          |
| 02:00 | `compute-snapshots-daily`    | values holdings using 01:30's prices            |
| 03:00 | `enqueue-plaid-syncs-daily`  | safety-net Plaid sync (webhooks are primary)    |
| 04:00 | `backup-database-daily`      | dump captures the day's synced transactions     |
| 04:30 | `export-beancount-daily`     | mirror reflects the same data as the 04:00 dump |
| 05:00 | `detect-anomalies-daily`     | runs last so a failed 04:00 backup is alertable |

A 60-second `heartbeat` also ticks continuously to confirm worker plumbing.
Each job is idempotent (CLAUDE.md §Background Jobs), so a missed or double run is
safe; BullMQ retries failures with exponential backoff.

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
