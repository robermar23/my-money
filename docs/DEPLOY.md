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
- **An app image, from one of two co-equal paths** (below).
- **Only for Plaid webhooks:** a Cloudflare account (free is fine), and a
  domain pointed at Cloudflare for nameservers, OR willing use of a
  `*.trycloudflare.com` quick tunnel (dev-only — the URL changes per session).
  A LAN-only install skips §3 and §4 entirely; Plaid still syncs nightly
  ([PLAID.md §5](PLAID.md#running-lan-only-no-tunnel)).
- A US household: my-money supports **US dollars only**, with no currency
  conversion (ADR-051; [README §Scope](../README.md#scope-us-households-us-dollars)).
- `.env` filled in from [.env.example](../.env.example). (The bare `docker
  compose` commands below auto-load `.env` from the project dir — not `.env.local`,
  which is the dev convenience the `make` targets pass via `--env-file`.)

### Choosing your image: pull it, or build it yourself

The `app` and `worker` services run the same image. You can get it either way,
and the rest of this document is identical for both.

**Path A — pull the published image.** `docker compose pull` fetches
`robermar2/my-money` from Docker Hub (public, no registry login). **No build
toolchain, Node, pnpm, or git checkout is needed on the server**, just the
`docker/compose.yaml` file and a `.env`. This is the default; you set nothing.

**Path B — build it from this source.** This path exists for a plain reason:
my-money will hold your whole financial life, and you should not have to run a
stranger's prebuilt binary over it, or reverse-engineer the Makefile to avoid
doing so. Building needs Docker and a checkout of the repository at the version
you want, and nothing else: no Node or pnpm on the host, because the
[Dockerfile](../Dockerfile) installs and builds everything inside the image. It
is multi-stage, glibc-based, and builds for `linux/amd64` and `linux/arm64`
(§1.1). On the machine that will run the stack:

```sh
git clone <your fork or this repository> my-money && cd my-money
git checkout <the commit or tag you reviewed>
docker build -f Dockerfile -t my-money:local .
```

Then tell compose to use it, in `.env`:

```sh
MONEY_IMAGE_REPO=my-money
MONEY_IMAGE_TAG=local
```

Both `app` and `worker` read these two variables, so one setting switches both.
**Skip `docker compose pull`** in §1 and in [Updates](#updates): it tries to
fetch `my-money:local` from Docker Hub and fails, because that image exists
only on your machine. To upgrade, check out the new version, rebuild, and run
the migration step as usual.

Building on a different machine and pushing to a registry you control works the
same way: `make buildx-init` once, then `make image-push IMAGE_REPO=<you>/my-money`
(§1.1), and set `MONEY_IMAGE_REPO=<you>/my-money` in `.env`. Path A's `pull`
then works against your registry. (`make image-build` is a **verification-only**
build. Its result stays in the buildx builder and never reaches the local image
list, so use `docker build` or `image-push` to get an image compose can run.)

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

> Do U.1–U.4 first, then follow **§1–§8** as written — using the `dc` command from
> U.3 (the override file plus `--project-directory`) in place of every
> `docker compose -f docker/compose.yaml …`.

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

Create the env file in `repo/` (next to `docker/`, not inside it). Compose
auto-loads a file named **`.env`** (not `.env.local`) from the **project
directory** — which is why every command in U.3 passes `--project-directory`.
Without it, Compose may look in `repo/docker/` instead and fail with
`required variable MONEY_ENCRYPTION_KEY is missing a value`:

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

### U.3 — Put the data on the cache pool, not the array

Postgres must **not** live on spinning array disks (slow, and it keeps the disks
spinning 24/7), and it should not live only inside `docker.img` either: a common
Unraid fix for a broken `docker.img` is to delete and recreate it, which takes
every named volume — your database — with it. The repo ships
[docker/unraid.override.yaml](../docker/unraid.override.yaml):

```yaml
services:
  postgres:
    volumes:
      - /mnt/cache/appdata/my-money/pgdata:/var/lib/postgresql/data
  worker:
    volumes:
      - /mnt/user/appdata/my-money/backups:/backups
      - /mnt/user/appdata/my-money/exports:/exports
```

Three things about it are deliberate:

- **It overrides mounts per service, never the top-level `volumes:`.** Compose
  merges a service's mounts by their path *inside* the container, so these
  replace the base file's named-volume mounts and leave the named volumes
  themselves untouched. An override that **redefines** a named volume (e.g.
  `postgres_data: { driver_opts: { type: none, o: bind, … } }`, which an earlier
  version of this doc showed) makes Compose ask
  *"Volume my-money_postgres_data exists but doesn't match configuration…
  Recreate (data will be lost)?"* on any install that already has data.
  **If you ever see that prompt, answer N and stop.**
- **Postgres uses `/mnt/cache/...` directly**, not `/mnt/user/...`. Postgres over
  Unraid's FUSE user-share layer is unreliable. If your pool is not called
  `cache`, run `ls /mnt` and change the path.
- **Redis stays in its named volume.** It holds the job queue only — no financial
  data — and the worker re-registers its schedules when it starts.

Set the `appdata` share's **Primary storage** to the cache pool with **Secondary
storage: None** (Shares → appdata). With an array as secondary storage, the
mover could try to move the live database onto the array.

**Every compose command** then uses the override and `--project-directory`.
Define this once per terminal session (or put it in a script):

```sh
D=/mnt/user/appdata/my-money/repo
dc() { docker compose --project-directory "$D" -f "$D/docker/compose.yaml" -f "$D/docker/unraid.override.yaml" --profile prod "$@"; }
```

**New install** — create the directories, then follow §1 with `dc`:

```sh
mkdir -p /mnt/cache/appdata/my-money/pgdata /mnt/user/appdata/my-money/{backups,exports}
```

Postgres initializes into the empty `pgdata` directory on first start.

**Existing install running on named volumes** — do **not** start it with this
override yet: Postgres would find an empty `pgdata` and initialize a brand-new,
empty database. Move the data first with U.3a.

### U.3a — Moving an existing database onto the cache pool

For an install that has been running with Postgres in the `my-money_postgres_data`
named volume. The data is **copied**, never moved, so the old volume stays
intact as the rollback until you delete it.

Check first that this is your situation. Expect a path under
`/var/lib/docker/volumes/` and `map[]` (a plain named volume):

```sh
docker volume inspect my-money_postgres_data --format '{{.Mountpoint}} {{.Options}}'
```

1. **Take a dump and record row counts**, while the stack still runs on the old
   setup (no override, so `old` here):

   ```sh
   D=/mnt/user/appdata/my-money/repo
   old() { docker compose --project-directory "$D" -f "$D/docker/compose.yaml" --profile prod "$@"; }

   F=/mnt/user/appdata/my-money/pre-move-$(date +%F).sql
   old exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$F"
   grep -c 'dump complete' "$F"    # must print 1
   ls -lh "$F"                     # must be well above zero bytes

   COUNTS='select (select count(*) from accounts), (select count(*) from transactions), (select count(*) from account_snapshots)'
   old exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc '$COUNTS'" | tee /mnt/user/appdata/my-money/pre-move-counts.txt
   ```

2. **Stop the stack** (`stop`, not `down` — and never `down -v`, which deletes
   the volumes):

   ```sh
   old stop
   docker ps --filter name=my-money    # must list nothing
   ```

3. **Copy the data directory**, preserving ownership and permissions:

   ```sh
   mkdir -p /mnt/cache/appdata/my-money/pgdata
   cp -a /var/lib/docker/volumes/my-money_postgres_data/_data/. /mnt/cache/appdata/my-money/pgdata/
   ```

   Then compare the two. Owner and mode must match, and the mode must be `700`
   (or `750`) or Postgres refuses to start. Sizes should be about the same:

   ```sh
   stat -c '%u:%g %a %n' /var/lib/docker/volumes/my-money_postgres_data/_data /mnt/cache/appdata/my-money/pgdata
   du -sh /var/lib/docker/volumes/my-money_postgres_data/_data /mnt/cache/appdata/my-money/pgdata
   ```

   If the mode differs: `chmod 700 /mnt/cache/appdata/my-money/pgdata`. If the
   owner differs: `chown -R <uid>:<gid> /mnt/cache/appdata/my-money/pgdata` using
   the old volume's values.

4. **Copy any existing backups and exports** onto the share, then make sure the
   override file on the server is the current one from the repo:

   ```sh
   mkdir -p /mnt/user/appdata/my-money/{backups,exports}
   cp -a /var/lib/docker/volumes/my-money_backups/_data/. /mnt/user/appdata/my-money/backups/ 2>/dev/null
   cp -a /var/lib/docker/volumes/my-money_exports/_data/. /mnt/user/appdata/my-money/exports/ 2>/dev/null
   cat "$D/docker/unraid.override.yaml"   # must contain "services:" and NO top-level "volumes:"
   ```

5. **Start on the new location** with the `dc` command from U.3:

   ```sh
   dc() { docker compose --project-directory "$D" -f "$D/docker/compose.yaml" -f "$D/docker/unraid.override.yaml" --profile prod "$@"; }
   dc up -d
   ```

   It should start without asking anything. A "Recreate (data will be lost)?"
   prompt means the override file is the old kind: answer **N** and fix step 4.

6. **Verify.** The mount must show the cache path, the logs must show a normal
   startup (not "initializing database"), and the counts must match step 1:

   ```sh
   docker inspect my-money-postgres-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
   dc logs postgres | tail -20
   dc exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc '$COUNTS'"
   cat /mnt/user/appdata/my-money/pre-move-counts.txt
   ```

   Then log in and check the dashboard and an account or two.

**Rollback** (before you delete anything): `dc stop`, then `old up -d`. That puts
you back on the untouched named volume. Anything written after the switch exists
only in the new copy.

**Clean up after a week** of normal running — and after a nightly backup has
landed in `/mnt/user/appdata/my-money/backups`:

```sh
docker volume rm my-money_postgres_data my-money_backups my-money_exports
rmdir /mnt/user/appdata/my-money/postgres /mnt/user/appdata/my-money/redis 2>/dev/null  # empty leftovers from the old override
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
`/mnt/user/appdata/my-money/backups` and the beancount mirror in `.../exports`.

- **Backups are off until you turn them on.** The job skips itself unless
  `BACKUP_AGE_RECIPIENT` is set in `.env` (§6.1). Check:
  `grep BACKUP_AGE_RECIPIENT "$D/.env"` — an empty value means no backups exist.
  After setting it, force one run (§6.1 step 4, using `dc`) and confirm a
  `money-*.dump.age` file appears in the share.
- **Off-host replication (§6.3) still applies** — a cache pool is still one
  machine. Add `/mnt/user/appdata/my-money/backups` (and `exports`, which is
  plaintext) to your off-host backup tool — Duplicacy, rclone to B2, etc. The
  dumps are already encrypted, so any destination is safe for them.
- **Don't rely on a file copy of the live `pgdata/` dir for recovery** (Appdata
  Backup, Duplicacy, …) — copying a running Postgres data directory isn't
  crash-consistent. The `age`-encrypted `pg_dump` ([RESTORE.md](RESTORE.md)) is
  the real backup; exclude `pgdata/` from file-level tools or treat that copy as
  bytes only.

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
- **`MONEY_TZ`** (optional, default UTC) — your IANA time zone, such as
  `America/New_York`. Moves the nightly backup and Beancount export into your
  night; changes no date or figure. See [§8 Time zone](#time-zone).

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
docker compose -f docker/compose.yaml --profile prod pull   # fetch robermar2/my-money (Path A only)
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

### 2.0 — (Optional) Try it on demo data first

Before you hand the app your own finances, you can fill an **empty** instance
with a fictional household: a year of transactions across checking, savings and
a card, a brokerage with two holdings, a mortgage, a home, one planned expense,
one recurring bill and two budgets. Every name and figure is made up.

```sh
docker compose -f docker/compose.yaml --profile prod run --rm --no-deps   -e SEED_DEMO_CONFIRM=yes worker   node --import tsx --import ./scripts/loaders/register.mjs scripts/seed-demo.ts
```

It **refuses, and writes nothing**, if the database holds any record of its
own: an account, a transaction, a planned expense, and so on. It never
overwrites or merges, so it cannot damage a real book. The image runs with
`NODE_ENV=production`, which is why `SEED_DEMO_CONFIRM=yes` has to be passed by
name. The two demo tickers do not exist, so the nightly price fetch logs a
failure for each and the demo keeps its last seeded price.

**Seed a stack you will throw away.** There is no "remove the demo" command for
a production stack: when you are ready for real data, delete the stack's volumes
(`docker compose -f docker/compose.yaml --profile prod down -v`, which
**destroys everything in it**) and start again from step 1. In a dev checkout,
`make seed-demo` does the same and `make db-reset` clears it.

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
   manager host), and outside the my-money checkout
   ([BACKUP.md](BACKUP.md#1-generate-an-age-keypair--off-this-server) says why):

   ```sh
   mkdir -p ~/keys && age-keygen -o ~/keys/money-backup.key
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

4. Recreate the worker so the nightly job sees the new env, then force one run
   now instead of waiting for 04:00:

   ```sh
   sh scripts/prod.sh restart
   sh scripts/prod.sh backup
   # → lists /backups, including money-YYYYMMDDTHHMMSSZ.dump.age
   ```

   The `backup_not_configured` alert on `/alerts` clears on that first success.

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
schedule lives inside the app and is visible to the worker on boot. Each job
names its clock in [src/worker/schedule.ts](../src/worker/schedule.ts): most
run on **UTC**, and the backup and Beancount export run in **your** time zone
when you set one (see [Time zone](#time-zone) below; with none set, that is UTC
too).

| Time  | Clock | Job                          | Why this order                                  |
|-------|-------|------------------------------|-------------------------------------------------|
| 01:30 | UTC   | `fetch-prices-daily`         | after the US close; prices land before valuing  |
| 01:45 | UTC   | `materialize-contributions`  | after 01:30's prices, before 02:00's snapshots  |
| 02:00 | UTC   | `compute-snapshots-daily`    | values holdings using 01:30's prices            |
| 03:00 | UTC   | `enqueue-plaid-syncs-daily`  | safety-net Plaid sync (webhooks are primary)    |
| 04:00 | yours | `backup-database-daily`      | dump captures the day's synced transactions     |
| 04:30 | yours | `export-beancount-daily`     | mirror reflects the same data as the 04:00 dump |
| 05:00 | UTC   | `detect-anomalies-daily`     | after the 04:00 backup, while your zone is UTC  |

Two more jobs run **chained off 02:00** rather than on their own cron, because
both read `account_snapshots` and a cron that fired first would evaluate
yesterday's balances: `evaluate-advice` (Phase 15) and `project-cashflow-daily`
(Phase 16 — materializes obligation occurrences, matches them against posted
transactions, and raises or resolves cash-flow alerts). Chaining is why neither
appears in the table: they have no time of their own.

One job is **weekly**: `detect-obligations-weekly` at **Sundays 06:30**, which
re-runs recurring-obligation detection over 24 months of history and refreshes
the candidate list at `/plan/cashflow/review`. It shares the day with the 06:00
`refresh-fundamentals-weekly` and is deliberately half an hour behind it — see
[CASHFLOW.md](CASHFLOW.md).

A 60-second `heartbeat` also ticks continuously to confirm worker plumbing.
Each tick also reports the worker's configuration (on or off, never a value), which
is how **Settings → Instance** knows the worker is alive and whether backups,
the Beancount mirror and alert email are configured on it.
Each job is idempotent (CLAUDE.md §Background Jobs), so a missed or double run is
safe; BullMQ retries failures with exponential backoff.

### Time zone

Set `MONEY_TZ` in `.env` to your IANA zone name, for example
`America/New_York` or `Australia/Sydney`, then `scripts/prod.sh restart`.
Compose passes it to `app` and `worker` as `TZ`. It is read from `MONEY_TZ`
rather than `TZ` so a `TZ` exported in the host's shell cannot leak in through
compose. If you already set `TZ` on the containers another way, such as an
Unraid template or an override file, it still works (it is the same variable
inside the container), but move it to `MONEY_TZ` so both containers get it
from one place.

**What it changes: when the backup and the Beancount export run.** They move to
04:00 and 04:30 in your zone, so "nightly" means your night rather than the
middle of a Sydney afternoon. The worker re-registers both schedules at start,
in place, so changing the zone never runs a job twice. A zone the runtime does
not recognize is ignored: the worker logs it, those two jobs stay on UTC, and
Settings → Instance shows a warning.

**What it does not change: anything the app computes.** Two things are easy to
conflate here, and the difference is the whole design:

- **When a job runs.** Only the backup and the export follow your zone. The
  price fetch, contributions, snapshots, the Plaid safety-net sync and anomaly
  detection stay at their UTC times, because the price fetch stores Yahoo's
  *latest* price under the date it runs on. At 01:30 UTC that is the previous
  US session's close. At 01:30 in Sydney (14:30 or 15:30 UTC) the US market is open, and
  every stored "close" would really be a mid-session price, permanently.
- **What date a job computes against.** my-money dates its days in UTC,
  everywhere: the snapshot written each night, the date a price is stored
  under, and the date the forms fill in as "today". Setting `MONEY_TZ` changes
  none of that. A test (`src/lib/schedule/utc-discipline.test.ts`) keeps
  local-clock date math out of the code, so the zone cannot reach a figure.

**The day boundary, and what it means for you.** Because days are UTC dates,
your day and the app's day are not the same day unless you live on UTC. In
Sydney (UTC+10/+11) the app's new day starts at 10:00 or 11:00 local time, so
the date the balance form suggests before then is still yesterday's, and the
snapshot labelled with a date was taken during your afternoon. In New York
(UTC-5/-4) the app's day starts at 19:00 or 20:00 the evening before. Dates
you type in and dates your bank supplies on transactions are stored exactly as
given and never shift. Settings → Instance shows where the UTC day starts in
your zone. A local-midnight day boundary is not offered: it would move the
anchor under every figure the app has already computed, and it is an open
design question, not a setting.

One ordering trade-off: with `MONEY_TZ` set, the 05:00 UTC anomaly check no
longer runs an hour after the backup. A failed backup still writes its
`backup_failure` alert immediately, but its email can wait for the next
05:00 UTC run.

## Updates

Every upgrade is the same five steps, and **the backup is one of them**, not a
suggestion next to them (ADR-054 §4). [scripts/prod.sh](../scripts/prod.sh)
runs each step with the right flags, from any directory:

```sh
P=/path/to/my-money/scripts/prod.sh    # your checkout, e.g. /mnt/user/appdata/my-money/repo

sh $P pull       # 1. fetch the new image
                 # 2. read the new CHANGELOG.md entry, especially its Migrations: line
sh $P backup     # 3. back up — refuses if backups are not configured
sh $P migrate    # 4. apply pending migrations — a no-op when already current
sh $P restart    # 5. recreate app + worker on the new image
```

1. **Pull.** If you pin a version (below), change `MONEY_IMAGE_TAG` in `.env`
   first. Built the image yourself ([Path B](#choosing-your-image-pull-it-or-build-it-yourself))?
   Replace this step with `git checkout <new version>` and `docker build -f
   Dockerfile -t my-money:local .`.
2. **Read the release's entry in [CHANGELOG.md](../CHANGELOG.md).** Its
   `Migrations:` line names the newest migration the release needs. If
   **Settings → Instance** shows an older one under *Database schema*, this
   upgrade changes your schema, and step 3 is what lets you undo it.
3. **Back up.** `backup` runs the nightly encrypted backup now, so the dump is
   minutes old rather than up to a day. It **refuses** when
   `BACKUP_AGE_RECIPIENT` is not set, rather than "succeeding" with nothing
   written. Without encrypted backups, take a plain dump yourself, and keep it
   somewhere private, because it is your unencrypted financial history:

   ```sh
   docker compose -f docker/compose.yaml --profile prod exec -T postgres \
     sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > pre-upgrade-$(date +%F).sql
   grep -c 'dump complete' pre-upgrade-*.sql    # must print 1
   ```

4. **Migrate before restarting.** Migrations are additive, so the running app
   keeps working against the migrated schema for the few seconds before step 5.
   The reverse order would start new code against a schema it expects but does
   not have yet. Drizzle applies every pending migration in **one
   transaction**: if one fails, none is applied and the old app keeps running.
5. **Restart.** If compose asks to recreate a **volume**, answer **N** and
   stop: that means the compose files changed how your data is mounted.

Once you have read the changelog, steps 3–5 chain safely, because `&&` stops at
the first failure, so a failed backup or migration never restarts the app:
`sh $P backup && sh $P migrate && sh $P restart`.

**On Unraid with the U.3 bind-mount override**, export
`MONEY_COMPOSE_OVERRIDE=/mnt/user/appdata/my-money/repo/docker/unraid.override.yaml`
before running the script. Only do that if your stack was **created** with the
override. Adding it to a stack that runs on named volumes is how compose ends up
offering to recreate the Postgres volume (U.3 explains why).

The same script runs one-off jobs (`sh $P job backfill-categories`; the names
are listed in [src/worker/run-once.ts](../src/worker/run-once.ts)). It always
uses a fresh `run --rm` container, never `exec`. `exec` reuses the running
worker, whose environment was frozen when it was created, so a variable you
added to `.env` since then is invisible to it. A backup forced that way logs
`disabled … skipping` despite a correct `.env`.

**Rolling back.** Set `MONEY_IMAGE_TAG` back to the previous version and
`sh $P restart`. Because migrations only add, an older image normally runs on
a newer schema, and **Settings → Instance** will say *"the database is newer
than this image"*. If it does not run, restore the dump from step 3
([RESTORE.md](RESTORE.md)).

### Automatic migration (off by default)

`MONEY_AUTO_MIGRATE=true` in `.env` makes the app apply pending migrations every
time it starts ([scripts/app-start.sh](../scripts/app-start.sh)). It is **off by
default and not recommended**, and the reasons are specific:

- It changes the schema of your financial database **unattended**, and it
  **takes no backup first**, which is step 3 above removed.
- A failed migration rolls back, but the app then exits, Docker restarts it, it
  fails again, and **the app stays down** until you step in.

If you turn it on anyway, only the app migrates (never the worker, so two
containers cannot race), and **Settings → Instance** shows a warning for as long
as it is on.

### Pin a version (recommended)

By default `pull` tracks `latest`, which means whatever was pushed most recently,
including a release whose migrations you have not read yet. **Pin a version
instead:** set `MONEY_IMAGE_TAG` in `.env` to a release number from
[CHANGELOG.md](../CHANGELOG.md), for example `MONEY_IMAGE_TAG=0.19.0`. An upgrade
then happens only when you change that line, after reading what the new entry
says, and a rollback is the previous number. Every release image is also tagged
with its git SHA, if you would rather pin a commit.

`latest` keeps working and stays the default, so an existing install is
unaffected. **Settings → Instance** shows the version and image you are running.

`cloudflared` updates take a connection-cycle (~10s). Plaid retries any
webhook that misses delivery for 24h, so a brief tunnel restart is safe.

### The test database (installs from before 0.19.0)

Before 0.19.0, `--profile prod` also started `postgres_test`, the database the
developer test suite uses. The app never used it. It now starts only with
`--profile dev`, but compose does not remove a container that is already
running, so an older install keeps it until you remove it:

```sh
docker stop my-money-postgres_test-1 && docker rm my-money-postgres_test-1
docker volume rm my-money_postgres_test_data   # holds only test fixtures
```

Neither command touches the `postgres` service that holds your data.

## Forgotten password

There is no reset email and no recovery question (ADR-004). While you are signed
in, change the password under **Settings → Instance**; that also signs every
other browser out. If you have forgotten it, delete the user row. **Your
financial data is kept**, and the next visit to `/login` sets a new password:

```sh
docker compose -f docker/compose.yaml --profile prod exec -T postgres   sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM users;"'
```

Do this promptly, because until a new password is set, anyone who can reach
`/login` can set it. In a dev checkout the same thing is `make db-reset-password`.

## Tearing down the tunnel

The Cloudflare side: dashboard → Tunnel → **Delete tunnel**.
The local side: `docker compose -f docker/compose.yaml stop cloudflared` then
remove `CLOUDFLARED_TOKEN` from `.env`. The app keeps running locally;
webhooks just stop arriving (the daily 03:00 safety-net cron — P4-27 — picks
up the slack).
