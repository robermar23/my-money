# Deploying my-money

This is the home-server bring-up: Postgres, Redis, the Next.js app, the BullMQ
worker, and a Cloudflare Tunnel for Plaid webhooks. Self-hosted, single-user,
never phones home.

The compose stack assumes you've already followed the Phase 0/3 docs and have
`.env` populated. This document focuses on the **production** profile and
the **Cloudflare Tunnel** that exposes Plaid webhooks to the internet without
opening a single port on your home router.

> See also: [RESTORE.md](RESTORE.md) for backup/restore, [PLAID.md](PLAID.md) for
> Plaid Link + reauth troubleshooting, [CRYPTO_ROTATION.md](CRYPTO_ROTATION.md)
> for the encryption-key rotation runbook (P4-37).
>
> **On Unraid?** Read [Running on Unraid (homelab)](#running-on-unraid-homelab)
> first for the platform-specific glue (Compose Manager plugin, cache-pool data
> placement, LAN access), then follow §1–§8 below with the override file it adds.

## Prerequisites

- Docker Engine ≥ 24 + the `compose` plugin.
- Network access to Docker Hub to pull the prebuilt image `robermar2/my-money`
  (public — no registry login). **No build toolchain, Node, pnpm, or git checkout
  is needed on the server** — just the `docker/compose.yaml` file and a `.env`.
- A Cloudflare account (free is fine).
- A domain pointed at Cloudflare for nameservers, OR willing use of a
  `*.trycloudflare.com` quick tunnel (dev-only — the URL changes per session).
- `.env` filled in from [.env.example](../.env.example). (The bare `docker
  compose` commands below auto-load `.env` from the project dir — not `.env.local`,
  which is the dev convenience the `make` targets pass via `--env-file`.)

## Deploy at a glance

This is the **dependency order** — each step needs the previous one. The numbered
sections (§0–§8) below follow it exactly; read them in order.

0. **Configure `.env`** — set `POSTGRES_PASSWORD` + the two secrets. You do *not*
   write `DATABASE_URL`/`REDIS_URL` (compose builds them from `POSTGRES_*`). Leave
   `CLOUDFLARED_TOKEN` **empty** for now. ([§0](#0-configure-your-env))
1. **Pull the image; start Postgres + Redis; run migrations.** ([§1](#1-pull-images--bring-up-data-services))
2. **Start the app + worker.** The app is now live on `127.0.0.1:4000`; nothing is
   public yet. ([§2](#2-bring-up-app--worker))
3. **Stand up the Cloudflare tunnel** — create it in the dashboard, paste its token
   into `.env`, start `cloudflared`, add the route. This is the **only** step that
   needs the token, and the dashboard hands it to you right here. ([§3](#3-stand-up-the-cloudflare-tunnel-p4-29))
4. **Point Plaid at the webhook URL** and smoke-test it. ([§4](#4-point-plaid-items-at-the-new-url-p4-30)–[§5](#5-smoke-test-the-live-path))
5. **Turn on backups + alerts.** ([§6](#6-backups--exports-off-host-replication)–[§7](#7-alert-notifications-smtp-optional))

> **Not on Unraid?** Skip the next section and start at
> [§0](#0-configure-your-env). The Unraid section is platform-specific glue
> (Compose Manager plugin, cache-pool data placement, LAN access) layered *on top
> of* the same §0–§8 flow.

## Running on Unraid (homelab)

> Unraid only. Everyone else: jump to [§0](#0-configure-your-env).

Unraid runs the **exact same compose stack** — only three things differ: how you
launch compose, where the persistent data lives, and how you reach the web UI on
your LAN. The **Cloudflare Tunnel (§3) is unchanged and ideal here**: it dials
*outbound* to Cloudflare, so you never port-forward on your router or expose
Unraid to the internet.

> Do U.1–U.4 first, then follow **§1–§8** as written — passing the extra override
> file from U.3 on every `docker compose` command.

### U.1 — Install the Docker Compose Manager plugin

Unraid's built-in Docker tab manages single containers, not compose stacks. Add
the community plugin:

- **Apps** (Community Applications) → search **"Docker Compose Manager"** →
  **Install**. A **Compose** panel appears at the bottom of the **Docker** tab.
- **Add New Stack** → name it `my-money` → **Edit Stack** to paste/point at the
  repo's `docker/compose.yaml`. The plugin keeps each stack's files under
  `/boot/config/plugins/compose.manager/projects/my-money/` (including its
  `.env`), and gives you one-click **build / up / down / update**.

Everything below also works verbatim from the **Unraid terminal** with the same
`docker compose -f …` commands used elsewhere in this doc — use whichever you
prefer.

### U.2 — Get the compose file + secrets onto the box

The app image is **pulled** from Docker Hub (`robermar2/my-money`), so there's no
clone and no build on the server. You only need two files in the stack directory:
`compose.yaml` and a `.env`. Grab the compose files (and the env template) — e.g.
fetch the raw files, or copy them over:

```sh
# Unraid terminal:
mkdir -p /mnt/user/appdata/my-money/repo/docker && cd /mnt/user/appdata/my-money/repo
# Fetch the two compose files + the env template from your fork (raw URLs):
curl -fsSL <raw-url>/docker/compose.yaml          -o docker/compose.yaml
curl -fsSL <raw-url>/docker/unraid.override.yaml  -o docker/unraid.override.yaml  # from U.3
curl -fsSL <raw-url>/.env.example                 -o .env.example
```

Create the env file. Compose auto-loads a file named **`.env`** (not `.env.local`)
from the project directory — or set it in the Compose Manager stack's env field:

```sh
cp .env.example .env
# Generate the two required secrets and paste them in:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"  # SESSION_SECRET
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"  # MONEY_ENCRYPTION_KEY
nano .env   # also set POSTGRES_PASSWORD, and CLOUDFLARED_TOKEN once you have it (§3)
```

> No build toolchain, Node, or git checkout is needed on the box — `docker
> compose pull` fetches the prebuilt image (a few hundred MB). Pin a specific
> build with `MONEY_IMAGE_TAG=<git-sha>` in `.env`; it defaults to `latest`.

### U.3 — Put the data on a cache pool, not the array

Postgres and Redis must **not** live on spinning array disks — it's slow and
keeps the disks spinning 24/7. Point their volumes (and the backup/export dirs)
at an **SSD cache pool**. Save this as `docker/unraid.override.yaml`:

```yaml
# docker/unraid.override.yaml — homelab data placement + local timezone.
# Adjust the device paths to your cache-pool appdata share, and TZ to yours.
volumes:
  postgres_data:
    driver: local
    driver_opts: { type: none, o: bind, device: /mnt/user/appdata/my-money/postgres }
  redis_data:
    driver: local
    driver_opts: { type: none, o: bind, device: /mnt/user/appdata/my-money/redis }
  backups:
    driver: local
    driver_opts: { type: none, o: bind, device: /mnt/user/appdata/my-money/backups }
  exports:
    driver: local
    driver_opts: { type: none, o: bind, device: /mnt/user/appdata/my-money/exports }

services:
  app:
    environment:
      TZ: America/New_York     # so display timestamps use your local time
  worker:
    environment:
      TZ: America/New_York     # so the nightly jobs (§8) fire at your local time
```

Create the bind directories first — Postgres only initializes into an **empty**
data dir:

```sh
mkdir -p /mnt/user/appdata/my-money/{postgres,redis,backups,exports}
```

> Set the share holding `my-money` to **Cache: Only** (or a dedicated SSD pool)
> in Unraid so the DB never spills onto the array. If you already ran an `up`
> once with the default named volumes, remove them
> (`docker compose … down -v`) before applying this override so the bind
> definitions take effect.

Then pass the override on **every** compose command (§1, §2, §3, updates):

```sh
docker compose -f docker/compose.yaml -f docker/unraid.override.yaml --profile prod up -d
```

### U.4 — Reach the web UI from your LAN

The base compose binds the app to `127.0.0.1:4000` — reachable only from the
Unraid box itself. For a homelab you almost certainly want it on your LAN. Edit
`app.ports` in **`docker/compose.yaml`** (edit the base file, not the override —
compose *concatenates* `ports`, so an override would leave both bindings fighting
over host 4000):

```yaml
    ports:
      - "4000:4000"     # was "127.0.0.1:4000:4000" → now http://<unraid-ip>:4000
```

The app's single-password auth protects the UI on your trusted LAN. For **remote**
access without opening a port, route the UI through the tunnel and put Cloudflare
Access in front (U.6).

### U.5 — The Cloudflare Tunnel is unchanged

All of **§3 (Stand up the Cloudflare Tunnel)** applies verbatim on Unraid — the
`cloudflared` sidecar is already in the stack, dials outbound to Cloudflare's
edge, and needs **no router port-forward** and **no Unraid Docker port mapping**.
Set `CLOUDFLARED_TOKEN` in `.env`, point the tunnel's public hostname at
`app:4000`, and bring it up. That outbound-only model is exactly why the tunnel
suits Unraid: your router stays closed and Plaid still reaches
`/api/plaid/webhook`.

### U.6 — (Optional) Remote UI access via the tunnel + Cloudflare Access

Plaid only needs `/api/plaid/webhook` exposed (§3.3 scopes the **Path** to it). If
you also want the **UI** reachable from outside the LAN:

1. In the tunnel's **Public Hostnames**, add a hostname → `app:4000` with the
   **Path** left blank (forward everything).
2. In **Cloudflare → Zero Trust → Access → Applications**, add an application for
   that hostname with a policy (e.g. one-time-PIN to your email). Cloudflare's
   auth then sits in front of the app so it isn't world-reachable — defense in
   depth on top of the app's own password.

### U.7 — Backups, the Unraid way

With U.3 applied, the nightly `age`-encrypted dumps (§6) land in
`/mnt/user/appdata/my-money/backups`. Two Unraid-specific notes:

- **Off-host replication (§6.3) still applies** — a cache pool is still one
  machine. Use the **Appdata Backup** plugin (CA) to sweep
  `/mnt/user/appdata/my-money` onto the array, *and* push the `backups` dir
  off-site (rclone/B2). The dumps are already encrypted, so any destination is
  safe.
- **Don't rely on an Appdata-Backup copy of the live `postgres/` dir for DB
  recovery** — copying a running Postgres data directory isn't crash-consistent.
  The `age`-encrypted `pg_dump` ([RESTORE.md](RESTORE.md)) is the real backup; the
  appdata copy is just bytes.

---

The rest of this doc (§1–§8) is platform-agnostic; the notes above are the only
Unraid-specific deltas.

## 0. Configure your `.env`

For the **prod stack you do not hand-write `DATABASE_URL` or `REDIS_URL`.** Compose
assembles them inside the `app`/`worker` containers from the Postgres vars and the
internal service names (`postgres:5432`, `redis:6379` on the private `money_net`):

```yaml
DATABASE_URL: postgres://${POSTGRES_USER:-money}:${POSTGRES_PASSWORD:-…}@postgres:5432/${POSTGRES_DB:-money}
REDIS_URL:    redis://redis:6379
```

The `DATABASE_URL` / `REDIS_URL` / `TEST_DATABASE_URL` lines in `.env.example`
point at `127.0.0.1:5433`/`6380` — those are **dev-only** (for `pnpm dev` against
host-published ports) and are **ignored** by the prod containers. Leave or delete
them; they have no effect on the stack.

What you actually set in `.env` for prod:

- **`POSTGRES_PASSWORD`** (required) — the one DB credential. Feeds both the
  Postgres container *and* the assembled `DATABASE_URL`, so they always match.
  **Set a strong value before the first `up`** (footgun below).
- **`POSTGRES_USER` / `POSTGRES_DB`** (optional) — default to `money`/`money`;
  override only to rename.
- **`SESSION_SECRET`** (required) — 32+ random bytes; the `app` refuses to start
  without it.
- **`MONEY_ENCRYPTION_KEY`** (required) — 32 bytes base64; encrypts Plaid tokens
  at rest (losing it bricks them).
- **`SESSION_COOKIE_SECURE`** (default `false`) — leave **off** for LAN access
  over plain HTTP (`http://<host>:4000`); a `Secure` cookie is dropped by
  browsers over HTTP and login silently re-prompts on every page. Set `true`
  only if you reach the app exclusively over HTTPS (e.g. via the tunnel).
- **`PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV`** (for Plaid) — empty is fine
  for a manual-only deploy; required once you use Plaid.
- **`PLAID_WEBHOOK_URL`** — set after the tunnel is up (§4).
- **`CLOUDFLARED_TOKEN`** — set in §3.

Generate the two random secrets:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"  # SESSION_SECRET
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"  # MONEY_ENCRYPTION_KEY
```

> **Redis has no password — by design.** It's never published to the host in the
> prod profile (only `app`/`worker` reach it over `money_net`), so there's no auth
> to set. If you ever expose Redis, add a password and update `REDIS_URL` yourself.
>
> **Footgun — set `POSTGRES_PASSWORD` before the first `up`.** Postgres reads it
> only when initializing an **empty** data dir. Bring the DB up once on the default,
> change the password later, and the assembled `DATABASE_URL` will use the *new*
> password against a DB that still has the *old* one → `password authentication
> failed`. If that bites you, restore the old value, or wipe the volume
> (`docker compose … down -v`, **destroys data**) and re-init.

## 1. Pull images + bring up data services

```sh
# From the directory holding docker/compose.yaml (+ your .env).
docker compose -f docker/compose.yaml --profile prod pull   # fetch robermar2/my-money
docker compose -f docker/compose.yaml up -d postgres redis
```

Wait for the `(healthy)` status on both, then apply migrations **inside a one-off
app container** — no Node/pnpm/repo needed on the host. The image carries
`drizzle-kit`, the migration files, and `drizzle.config.ts`; `DATABASE_URL` comes
from the compose env:

```sh
docker compose -f docker/compose.yaml --profile prod run --rm app \
  node_modules/.bin/drizzle-kit migrate
```

(`make db-reset` is for dev only — it drops all data.)

### 1.1 — Architecture (Raspberry Pi / ARM NAS)

`docker compose pull` automatically fetches the image variant matching the host's
architecture — nothing special to do on an arm64 box **if** that arch is published
to the registry. The Dockerfile builds clean for both `linux/amd64` and
`linux/arm64`: every native dependency has a glibc arm64 prebuild
(`@node-rs/argon2`, Next's SWC, Tailwind's `lightningcss`), and the runtime-stage
`pg_dump` (PGDG apt) + `age` (bookworm main) both ship arm64. The base is **Debian
bookworm-slim (glibc)**, not alpine, which is what makes those `-gnu` prebuilds the
right ones.

Publishing is done from a dev machine, not the server, via the Makefile targets
(tag = git SHA + `latest`, pushed to `IMAGE_REPO`, default `robermar2/my-money`):

```sh
make buildx-init                               # one-time: buildx builder
make image-push                                # amd64 + arm64 → registry
make image-push PLATFORMS=linux/amd64          # single-arch (e.g. amd64 only)
```

> **arm64 via emulation is unreliable on some hosts.** Cross-building arm64 from
> an amd64 machine uses QEMU, which can crash `pnpm install` under load
> (`uv__io_poll` assertion). If `make image-push` fails on the arm64 leg, build
> arm64 **natively on the Pi** (`make image-push PLATFORMS=linux/arm64` there) and
> let `buildx` merge it into the same multi-arch tag, or run the Pi as a remote
> buildx node.

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

> **No chicken-and-egg — the token is the key.** Creating the tunnel hands you the
> token *immediately* (it's in the displayed `docker run … --token eyJhI…` command),
> before anything connects. That token **is your identity**: it embeds your
> Cloudflare account + tunnel ID + a secret, and `cloudflared` presents it when it
> dials **out** to Cloudflare's edge — that's how Cloudflare knows the connector is
> yours. No inbound port, no login on the box.
>
> So your app stack doesn't need the token at all — only the `cloudflared` sidecar
> does. The sequence: bring up Postgres/Redis/app/worker first (§1–§2, with
> `CLOUDFLARED_TOKEN` still empty) → create the tunnel and copy the token → paste
> it into `.env` and start `cloudflared` (§3.2) → *then* add the route (§3.3). The
> wizard's **Continue** button stays greyed out ("No connection detected yet") only
> until that sidecar dials in — it's waiting for cloudflared to *use* the token you
> already have, not to give you anything.
>
> ⚠️ Bring app/worker up **by name** (`up -d app worker`), not the whole
> `--profile prod`, until the token is set — otherwise compose also starts
> `cloudflared`, which crash-loops on the empty token.

### 3.1 — Create the tunnel + copy the token

1. <https://one.dash.cloudflare.com> → **Networks** → **Tunnels** → **Create a
   tunnel**.
2. Connector: **Cloudflared**. Name it `my-money-prd` (the name is just a label).
3. **Operating System: Docker.** The wizard shows a
   `docker run cloudflare/cloudflared:latest tunnel … --token eyJhI…` command and
   then sits on **"Waiting for your Tunnel to connect… No connection detected
   yet"** with **Continue** disabled. **Don't run that displayed command** — we
   run the connector through compose instead. Just copy the **token**: the long
   `eyJhI…` string after `--token`.

> ⚠️ The tunnel token is the production credential for accepting traffic
> destined to your app. Treat it like any other secret. If leaked, rotate via
> the same dashboard ("Refresh token").

### 3.2 — Bring the connector up (so the wizard unblocks)

Wire the token into your `.env` and start the `cloudflared` sidecar — this is what
makes the dashboard's **Connection Status** flip to connected:

```sh
# Append to your .env
echo 'CLOUDFLARED_TOKEN=eyJhI…the_long_string_from_the_dashboard…' >> .env

docker compose -f docker/compose.yaml --profile prod up -d cloudflared
docker compose -f docker/compose.yaml logs -f cloudflared
```

You should see lines containing:

```text
Connection <uuid> registered connIndex=0 location=...
Connection <uuid> registered connIndex=1 location=...
```

— that's the tunnel up (four connections is normal — edge redundancy). Back in
the dashboard, the **Connection Status** panel now shows your connector and the
**Continue** button enables. Click it to reach the routing step.

### 3.3 — Add the public hostname route

Now on the wizard's **Route Traffic** / **Public Hostnames** step (or the tunnel's
**Public Hostnames** tab afterwards):

| Field        | Value                                                                |
|--------------|----------------------------------------------------------------------|
| Subdomain    | e.g. `money` (whatever you want)                                     |
| Domain       | one of your Cloudflare-managed zones                                 |
| Path         | `/api/plaid/webhook` (optional scope; leave blank to forward all)    |
| Service Type | `HTTP`                                                               |
| URL          | `app:4000`                                                           |

Cloudflare will auto-create the DNS record (CNAME → tunnel UUID).

The "Service URL" uses the docker network hostname `app`. cloudflared resolves
this because it shares the `money_net` network with the app container — so `app`
must be up (§2) for traffic to land, though the connector itself connects
regardless.

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

First bake the URL into your **`.env`** so the containers (and freshly-minted
link tokens) carry it:

```ini
PLAID_WEBHOOK_URL=https://money.your-domain.com/api/plaid/webhook
```

Recreate the prod services so they pick it up, then run the updater **inside a
one-off container** (the maintenance scripts are baked into the image; the Plaid
creds come from the compose env):

```sh
docker compose -f docker/compose.yaml --profile prod up -d app worker

# Dry run first — prints what would change, no Plaid calls.
docker compose -f docker/compose.yaml --profile prod run --rm app \
  node --import tsx --import ./scripts/loaders/register.mjs \
  scripts/plaid-set-webhook-url.ts --dry-run

# Commit (drop --dry-run).
docker compose -f docker/compose.yaml --profile prod run --rm app \
  node --import tsx --import ./scripts/loaders/register.mjs \
  scripts/plaid-set-webhook-url.ts
```

Override the URL per-run with `--url https://other.example.com/api/plaid/webhook`
(appended after the script path) without touching `.env`.

Verify in the Plaid dashboard → Items → each Item's "Webhook" field.

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

2. Put **only the public key** in `.env`:

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
   # optional immediate run instead of waiting for 04:00 (recreate above means
   # `exec` now has the new env; the register.mjs loader stubs `server-only`,
   # without which run-once.ts fails with ERR_MODULE_NOT_FOUND):
   docker compose -f docker/compose.yaml --profile prod exec worker \
     node --experimental-strip-types --import tsx --import ./scripts/loaders/register.mjs \
     src/worker/run-once.ts backup-database-daily
   docker compose -f docker/compose.yaml --profile prod exec worker ls -lh /backups
   # → money-YYYYMMDDTHHMMSSZ.dump.age
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
# .env — leave SMTP_URL empty to use only the in-app /alerts page.
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
# `run --rm` re-reads --env-file at launch (so newly-added vars are seen) and the
# register.mjs loader stubs Next's `server-only` marker (else ERR_MODULE_NOT_FOUND):
docker compose -f docker/compose.yaml --profile prod run --rm --no-deps worker \
  node --experimental-strip-types --import tsx --import ./scripts/loaders/register.mjs \
  src/worker/run-once.ts detect-anomalies-daily
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

# If the release includes schema changes, apply migrations (idempotent — a no-op
# when already current):
docker compose -f docker/compose.yaml --profile prod run --rm app \
  node_modules/.bin/drizzle-kit migrate
```

By default `pull` tracks `latest`. To deploy a **specific** build, set
`MONEY_IMAGE_TAG=<git-sha>` in `.env` (the SHA `make image-push` stamped on the
image) and re-run the two commands — this also lets you roll back by pinning the
previous SHA.

`cloudflared` updates take a connection-cycle (~10s). Plaid retries any
webhook that misses delivery for 24h, so a brief tunnel restart is safe.

## Tearing down the tunnel

The Cloudflare side: dashboard → Tunnel → **Delete tunnel**.
The local side: `docker compose -f docker/compose.yaml stop cloudflared` then
remove `CLOUDFLARED_TOKEN` from `.env`. The app keeps running locally;
webhooks just stop arriving (the daily 03:00 safety-net cron — P4-27 — picks
up the slack).
