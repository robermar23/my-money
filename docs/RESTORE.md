# Backup + restore

> This doc is the runbook for restoring my-money from a `pg_dump` backup.
> The full pg_dump → age-encrypt → off-host rotation lives in [docker/](../docker/)
> (Phase 6); this page covers what to do when you actually have to restore.

## What's in a backup

A `pg_dump` of the `money` database covers:

- Every row in `users`, `accounts`, `holdings`, `liabilities`, `account_snapshots`,
  `prices`, `fx_rates`, `transactions`, `import_batches`, `category_rules`.
- The Drizzle migrations table so `drizzle-kit migrate` is a no-op against a
  restored DB.

## What's NOT in a backup

- The `MONEY_ENCRYPTION_KEY` for Plaid tokens (Phase 4). Back this up
  separately, ideally on paper in a safe.
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

1. Spin up a fresh Postgres container at the version that produced the dump.
2. `pg_restore -d money_new dump.tar` (or `psql money_new < dump.sql` for plain
   text dumps).
3. Set `DATABASE_URL` in `.env.local` to point at the restored DB.
4. Run `pnpm db:migrate` — should be a no-op against a restored Drizzle DB.
5. `pnpm dev` and verify login works.
6. **Test restore quarterly per CLAUDE.md** — an untested backup is not a backup.

## Re-deriving from `import_batches` alone

If for some reason `transactions` is corrupted but `import_batches` is intact:

```sql
DELETE FROM transactions WHERE import_batch_id IS NOT NULL;
UPDATE import_batches SET status = 'previewed' WHERE status = 'confirmed';
```

Then re-confirm each batch (UI or directly via `persistImportBatch(batchId)`).
Idempotency on `(account_id, fitid)` guarantees no duplicates even if the
worker re-parses everything.
