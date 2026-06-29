# Backup + restore

> Runbook for the nightly encrypted backup (Phase 6, ADR-014) and for restoring
> from one. Backups are the entire point of the app — the historical data is the
> product — so **test a restore quarterly** (CLAUDE.md §Backup Discipline): an
> untested backup is not a backup.

## Automated nightly backup (ADR-014)

A BullMQ repeatable job (`backup-database-daily`, [src/worker/jobs/backup-database-daily.ts](../src/worker/jobs/backup-database-daily.ts))
runs in the worker at **04:00 local**, after the 03:00 Plaid safety-net sync so
the dump captures that day's transactions. It:

1. Runs `pg_dump --format=custom` and pipes the output **straight into `age`** —
   the plaintext dump never touches disk; only the encrypted blob is written.
2. Writes `BACKUP_DIR/money-<UTC-timestamp>.dump.age` (e.g.
   `money-20260607T040000Z.dump.age`).
3. Prunes local `*.dump.age` files older than `BACKUP_RETAIN_DAYS` (default 14)
   **after** a confirmed-good write. Off-host retention is your policy.

It is **opt-in**: with `BACKUP_AGE_RECIPIENT` unset the job logs "disabled" and
skips. A failed dump throws (BullMQ retries with backoff) and — once the Phase-6
`alerts` table lands — will raise a `backup_failure` alert.

### One-time setup: the age keypair

```bash
age-keygen -o money-backup.key
# Output:
#   Public key: age1qz...        ← this is BACKUP_AGE_RECIPIENT (safe to keep)
# The file money-backup.key contains the line AGE-SECRET-KEY-1...  ← the IDENTITY
```

- Put the **public key** in `.env.local` as `BACKUP_AGE_RECIPIENT` (it is not a
  secret — it can only *encrypt*).
- Keep `money-backup.key` (the **private identity**) **OFF this server** — a
  password manager, paper in a safe, or a second machine. Encryption is one-way
  on the box, so a server compromise cannot decrypt your backup history. **If you
  lose the identity, every `*.dump.age` is unrecoverable** — exactly like
  `MONEY_ENCRYPTION_KEY` (which is a *separate* key; see below).

### Where the files land

`BACKUP_DIR` (default `/backups`) is a docker volume mounted into the `worker`
service ([docker/compose.yaml](../docker/compose.yaml)). Replicate that volume
off-host yourself (Backblaze B2, `rsync` to a second disk, etc.) — the app does
not push backups anywhere (no SaaS, per CLAUDE.md §Privacy).

To run a backup on demand (inside the running stack, where `pg_dump`/`age`
exist): `docker compose --profile prod exec worker pnpm worker:once backup-database-daily`
(or `make job-backup` if the binaries are on your host PATH).

## What's in a backup

A `pg_dump` of the `money` database covers:

- Every row in `users`, `accounts`, `holdings`, `liabilities`, `account_snapshots`,
  `prices`, `fx_rates`, `transactions`, `import_batches`, `category_rules`.
- **`asset_documents`** (Phase 10) — personal-asset proof-of-authenticity files,
  bytes and all (`bytea`). They restore with the database; **no extra step, no
  separate mount to recover** (that single-backup property is exactly why the
  documents are stored in Postgres rather than on a filesystem — ADR-024).
- The Drizzle migrations table so `drizzle-kit migrate` is a no-op against a
  restored DB.

## What's NOT in a backup

- **Two keys, neither in the dump** — back both up off-host, separately:
  - `MONEY_ENCRYPTION_KEY` — decrypts the Plaid tokens *inside* the dump
    (Phase 4, ADR-009). Without it a restore is intact but every Plaid Item
    must be re-linked.
  - The **age identity** — decrypts the dump *itself* (ADR-014). Without it the
    `*.dump.age` files are noise.
  A dump is therefore double-encrypted at rest (age over AES-GCM) and useless to
  a thief who has the files but neither key.
- The Redis store (BullMQ queues). Redis state is ephemeral — losing it means
  any in-flight import or sync job is dropped on the floor, but no domain data
  is lost.

## `import_batches.raw_file` and backup size

Phase 3 stores the uploaded file bytes (`bytea`) in `import_batches.raw_file`
so the worker can re-parse a `pending` batch without filesystem state. This
makes the column the single largest contributor to backup size after
`transactions`.

Typical sizes:

- A single monthly QFX from a bank or credit card: 5–50 KB.
- A 5-year CSV backfill: 1–5 MB.

A user with 10 active accounts pulling monthly QFX for 10 years lands around
30 MB of accumulated `raw_file` data. Acceptable for daily `pg_dump`.

**If backup size becomes an issue**, the rows are safe to clear via:

```sql
UPDATE import_batches SET raw_file = NULL WHERE status = 'confirmed';
```

Confirmed batches don't need the bytes anymore — the transactions they
produced are already in `transactions`. Only `pending` and `previewed` rows
need the original file (so the worker can re-parse).

## Restore procedure

You need the encrypted dump (`money-<ts>.dump.age`) and the **age identity**
(`money-backup.key`) you stashed off-host.

1. Spin up a fresh Postgres **16** (the version that produced the dump):
   `createdb -U money money_new`.
2. **Decrypt and restore in one pipe** (plaintext never hits disk):

   ```bash
   age -d -i money-backup.key money-20260607T040000Z.dump.age \
     | pg_restore -U money -d money_new
   ```

   (Custom-format dumps go through `pg_restore`. The decrypted stream is exactly
   what `pg_dump -Fc` produced.)
3. Set `DATABASE_URL` in `.env.local` to point at the restored DB.
4. Run `pnpm db:migrate` — should be a no-op against a restored Drizzle DB
   (the migrations table is in the dump).
   - **`pg_trgm` extension (Phase 12, ADR-028):** search relies on the `pg_trgm`
     contrib extension, enabled by migration `0017`. A `pg_dump -Fc` of a DB that
     has it already emits the `CREATE EXTENSION`, so a normal restore recreates it.
     The only requirement is that the **target Postgres image ships the `pg_trgm`
     contrib module** — the official `postgres:16` image does. If you restore onto a
     stripped image that lacks contrib, the trigram GIN indexes (and search) will
     fail to build; install `postgresql-contrib` or use the official image.
5. `pnpm dev` and verify login works and a known net-worth figure looks right.
6. If you use Plaid, confirm `MONEY_ENCRYPTION_KEY` matches the one that was live
   when the tokens were stored; otherwise re-link each Item.
7. **Test restore quarterly per CLAUDE.md** — an untested backup is not a backup.

> **Verification status (P6-07):** the `pg_dump -Fc` → `pg_restore` round-trip was
> executed against the live PG16 dev database (16 tables recreated in a throwaway
> DB — 2026-06-07). `age` is a transparent encrypt/decrypt filter over that same
> byte stream; the end-to-end `age -d | pg_restore` step is verified by the
> operator inside the worker container (where `age` is installed), since `age`
> isn't on the Windows dev host. The job's argument-safety, filename, and
> retention logic are covered by [backup-database-daily.test.ts](../src/worker/jobs/backup-database-daily.test.ts).

## Re-deriving from `import_batches` alone

If for some reason `transactions` is corrupted but `import_batches` is intact:

```sql
DELETE FROM transactions WHERE import_batch_id IS NOT NULL;
UPDATE import_batches SET status = 'previewed' WHERE status = 'confirmed';
```

Then re-confirm each batch (UI or directly via `persistImportBatch(batchId)`).
Idempotency on `(account_id, fitid)` guarantees no duplicates even if the
worker re-parses everything.
