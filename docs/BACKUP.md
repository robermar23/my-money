# Backups

> How the nightly encrypted database backup works, how to turn it on, and how to
> keep the dumps safe off-host (Phase 6, **ADR-014**). This is the *configuration
> and operation* reference; the **recovery** procedure lives in
> [RESTORE.md](RESTORE.md), and the deploy-time wiring in [DEPLOY.md](DEPLOY.md) §6.

Backups are the entire point of the app — the historical data is the product. An
untested backup is not a backup, so **test a restore quarterly** (CLAUDE.md
§Backup Discipline) and record it on `/settings/instance` when you do
([RESTORE.md](RESTORE.md#record-the-drill)).

## How it works

A BullMQ repeatable job — `backup-database-daily`
([src/worker/jobs/backup-database-daily.ts](../src/worker/jobs/backup-database-daily.ts)) —
runs in the **worker** process at **04:00 in your time zone** (`MONEY_TZ`, UTC
when unset; [DEPLOY.md §Time zone](DEPLOY.md#time-zone)), after the 03:00 UTC Plaid
safety-net sync so the dump captures that day's transactions. It is a BullMQ job,
not OS cron, so the schedule lives inside the app (CLAUDE.md §Background Jobs).

1. Runs `pg_dump --format=custom` and pipes the bytes **straight into `age`** —
   the plaintext dump never touches disk; only the encrypted blob is written.
   Both binaries are invoked via an args-array (no shell string), so a password
   or path can never be re-split or injected.
2. Writes `BACKUP_DIR/money-<UTC-timestamp>.dump.age`
   (e.g. `money-20260607T040000Z.dump.age`).
3. **After** a confirmed-good write, prunes local `*.dump.age` files older than
   `BACKUP_RETAIN_DAYS`. Off-host retention is your own policy.

On failure the job throws (BullMQ retries with exponential backoff) and raises a
`backup_failure` alert (see [ALERTS.md](ALERTS.md)) that clears automatically on
the next successful run.

The job is **opt-in**: with `BACKUP_AGE_RECIPIENT` unset it logs "disabled" and
skips. Nothing is ever sent anywhere by the app — replication off-host is yours.

## You will be warned while it is off

A skipped backup never *fails*, so `backup_failure` cannot fire for it. Instead,
each night the job skips it raises a **`backup_not_configured`** alert
(Phase 19, ADR-052), which appears on [`/alerts`](ALERTS.md) like any other.

- **What it means:** nothing is being backed up. Every transaction, balance and
  snapshot this instance holds exists only in its Postgres volume.
- **Severity `warning`, not `critical`:** a brand-new install has no backup yet,
  and that is normal on day one. It is not normal on day ninety.
- **It does not nag.** There is only ever one open, however many nights pass. If
  you dismiss it without configuring backups, it comes back once the next month.
- **It clears itself** on the first successful backup after you finish the steps
  below. You do not need to dismiss it.

**Settings → Instance** (`/settings/instance`) shows the same fact, plus when the
last successful backup finished and when you last practised a restore
([RESTORE.md](RESTORE.md#record-the-drill)).

## Enable it

### 1. Generate an `age` keypair — off this server

Do this on your laptop or a machine that is **not** the home server, and **not
inside your my-money checkout**:

```bash
mkdir -p ~/keys && age-keygen -o ~/keys/money-backup.key
# Output:
#   Public key: age1qz...        ← this is BACKUP_AGE_RECIPIENT (safe to keep)
# The file money-backup.key holds the line  AGE-SECRET-KEY-1...  ← the IDENTITY
```

> **Why not in the repo directory.** `age-keygen -o money-backup.key` writes to
> wherever you are standing, and in a checkout that is the repository root. The
> `*.key` line in `.gitignore` keeps it out of commits, but that is all it does:
> `git clean -fdx`, deleting the checkout to re-clone it, or a fresh clone on a
> new laptop all lose an ignored file without a word, and with it every backup
> you have ever taken. If yours is already there, move it out now (and then to
> one of the places in step 3):
>
> ```bash
> mv money-backup.key ~/keys/    # from the checkout root
> ```

### 2. Put **only the public key** on the server

```ini
# .env.local
BACKUP_AGE_RECIPIENT=age1qz...
BACKUP_DIR=/backups          # already set on the worker by compose
BACKUP_RETAIN_DAYS=14        # local retention; off-host retention is your policy
```

The recipient (public key) is **not a secret** — it can only *encrypt*. Commit it
to your private `.env.local`, paste it in compose, whatever; a leak is harmless.

### 3. Keep the identity OFF the box — forever

Store `money-backup.key` (the private identity) in a password manager, on paper
in a safe, or on a second machine. **It must never live on the server.** Encryption
is one-way on the box, so a full server compromise still cannot decrypt your
backup history. This asymmetry is the whole point of recipient-only `age`.

> ⚠️ **Lose the identity and every `*.dump.age` is unrecoverable.** Treat it with
> the same care as `MONEY_ENCRYPTION_KEY`.

## Two keys, two jobs — don't conflate them

A dump is **double-encrypted at rest** (age over the AES-GCM that already protects
Plaid tokens). Two independent keys, neither stored in the dump, both backed up
off-host *separately*:

| Key | Decrypts | Lose it and… |
|-----|----------|--------------|
| **age identity** (`money-backup.key`, ADR-014) | the `*.dump.age` file *itself* | the backups are noise |
| **`MONEY_ENCRYPTION_KEY`** (ADR-009) | the Plaid access tokens *inside* the dump | restore is intact, but re-link every Plaid Item |

Keeping them separate means a leak of one never compromises the other.

## Where the files land + off-host replication

`BACKUP_DIR` (default `/backups`) is a Docker volume mounted into the `worker`
service ([docker/compose.yaml](../docker/compose.yaml)). The volume survives
container restarts but **not a dead disk** — replicate it off-host yourself.
Because the dumps are already encrypted, a third-party object store is fine:

```bash
# Resolve the host path of the volume, then sync it anywhere.
docker volume inspect my-money_backups -f '{{ .Mountpoint }}'
rclone sync /var/lib/docker/volumes/my-money_backups/_data b2:my-money-backups
# or: rsync -a … /mnt/second-disk/my-money-backups/   |   restic backup …
```

## Run one on demand

The worker image carries `pg_dump`/`age`. Use `run --rm` (not `exec`): a fresh
one-off container re-evaluates `--env-file` at launch, so a `BACKUP_AGE_RECIPIENT`
you just added is picked up immediately. `exec` reuses the **running** worker's
environment — frozen when that container was created — so a var added afterward is
invisible and the job logs `disabled: BACKUP_AGE_RECIPIENT not set; skipping` until
the worker is recreated.

Both invocations need the `register.mjs` loader: it stubs Next's `server-only`
marker (not a real installed package), without which `run-once.ts` aborts with
`ERR_MODULE_NOT_FOUND: Cannot find package 'server-only'` before the backup runs.
The flags mirror the worker's compose `command`.

```bash
docker compose -f docker/compose.yaml --profile prod run --rm --no-deps worker \
  node --experimental-strip-types --import tsx --import ./scripts/loaders/register.mjs \
  src/worker/run-once.ts backup-database-daily
docker compose -f docker/compose.yaml --profile prod exec worker ls -lh /backups
# → money-YYYYMMDDTHHMMSSZ.dump.age
```

(`make job-backup` is the host-PATH shortcut if you have the binaries locally.)

## What's in / not in a dump

See [RESTORE.md](RESTORE.md) for the full table — in short: every domain table +
the Drizzle migrations table are in; the two keys above and the ephemeral Redis
queue state are not. The largest contributors to dump size are the two `bytea`
columns — `import_batches.raw_file` (stored upload bytes) and
`asset_documents.bytes` (personal-asset proof documents, ≤10 MB each, Phase 10) —
both captured by the dump with **no extra restore step**; RESTORE.md documents how
to clear confirmed import rows if size ever becomes a concern.

## Recovery

→ [RESTORE.md](RESTORE.md): `age -d -i ~/keys/money-backup.key … | pg_restore`, plus the
quarterly restore-test discipline.
