# Encryption-key rotation (`MONEY_ENCRYPTION_KEY`)

This is the runbook for rotating the AES-256-GCM key that protects every
`plaid_items.access_token_ciphertext` at rest. The cipher and on-disk envelope
are defined by ADR-009; the rotation mechanism is defined here.

> **When to rotate**: on suspected key compromise; on operator handoff; on a
> documented yearly hygiene cycle. **NOT routinely** — rotation is a managed,
> human-driven event because losing the new key on the way bricks every token.

## Before you begin — risk profile

| Risk | What you lose if it materializes |
|---|---|
| Lose `MONEY_ENCRYPTION_KEY_NEW` mid-rotation | Nothing — old key still works, rotation hasn't committed yet. |
| Lose `MONEY_ENCRYPTION_KEY_NEW` AFTER committing rotation | **Every Plaid Item is unreadable.** Recovery: disconnect every Item from `/settings/connections`, then re-Link each one. Historical transactions stay; the cursor resets to NULL and the next sync pulls fresh. |
| Lose `MONEY_ENCRYPTION_KEY` (the original) BEFORE rotating | **Every Plaid Item is unreadable.** Same recovery as above — there is no decrypt path without the key. |
| Rotation transaction fails mid-way | Nothing — `rotateEncryption()` runs in a single DB transaction. Either every row rotated, or none did. The DB stays internally consistent under whichever key the rows are currently under. |

The non-mid-rotation losses are catastrophic. **Make a backup before
proceeding** (per [RESTORE.md](RESTORE.md)).

## The rotation flow

There are five steps. Each maps to a single shell command or a one-line edit
in `.env.local`.

### 1. Back up the database

```sh
docker compose -f docker/compose.yaml exec -T postgres \
  pg_dump -U money -d money | age -r <your-age-pubkey> > backup-pre-rotate-$(date +%F).sql.age
```

The encrypted dump is your fail-safe: if the rotation goes wrong, restore this
dump and the original `MONEY_ENCRYPTION_KEY` still decrypts every row.

### 2. Generate the new key

```sh
openssl rand -base64 32
```

Copy the output. **Do not paste it into your shell history** — paste it
directly into `.env.local`.

### 3. Add the new key alongside the existing one

Edit `.env.local` so it has *both* keys, side by side:

```ini
# Existing key — leave it in place until rotation completes.
MONEY_ENCRYPTION_KEY=<your existing key>

# New key — present only during rotation.
MONEY_ENCRYPTION_KEY_NEW=<the base64 from step 2>
```

### 4. Dry run, then commit

The rotation script reads both keys, walks every `plaid_items` row, decrypts
under the old key, re-encrypts under the new key, and writes back — all in a
single DB transaction.

Run it dry first to verify the old key still decrypts every row:

```sh
pnpm plaid:rotate-key -- --dry-run
```

Expected output ends with `Dry run done. rows=N decryptable=N failed=0.`

If `failed > 0`, **stop**. The old key is wrong, or some rows were already
re-encrypted under a different key, or the ciphertext bytes are corrupted.
None of those are recoverable by re-running the rotation — investigate
([THREAT_MODEL_PLAID.md](THREAT_MODEL_PLAID.md) Surface 2 covers ciphertext
authentication failures).

If the dry run is clean, commit:

```sh
pnpm plaid:rotate-key
```

Expected output ends with `✓ Rotation complete. rotated=N skipped=M.` The
`skipped` count is tombstoned Items (status='removed') whose ciphertext was
already wiped by the disconnect flow (P4-26) — these don't need rotation.

### 5. Promote the new key, restart, smoke-test

```sh
# Swap the env so the new key becomes the live key.
sed -i 's/^MONEY_ENCRYPTION_KEY=.*/MONEY_ENCRYPTION_KEY=<the new key>/' .env.local
sed -i '/^MONEY_ENCRYPTION_KEY_NEW=/d' .env.local

# Bounce the containers so they re-read .env.local.
docker compose -f docker/compose.yaml --profile prod restart app worker

# Verify: open /settings/connections, click Force sync on one Item.
# If the sync run completes (added/modified/removed counters update), the
# new key is reading the rotated ciphertext correctly.
```

That's it. The old key can now be erased — securely shred any plaintext copy
that was on disk.

## Failure modes and recovery

| What happened | What to do |
|---|---|
| Dry run reports `failed > 0` | Stop. Do NOT commit. Investigate which rows failed and why. Most likely: a row's ciphertext was hand-edited or written under a third key. |
| Commit succeeds, but app fails after env swap | Check that `MONEY_ENCRYPTION_KEY` in `.env.local` now matches what was `MONEY_ENCRYPTION_KEY_NEW`. The app will throw `CryptoConfigError` at boot if the key is wrong shape, or `CryptoDecryptError` on first sync attempt if the key shape is right but the value is wrong. Restore from the step-1 backup if the env got mangled. |
| Lost the new key after committing | Restore the step-1 backup (which is still under the old key) and re-rotate with a fresh new key. If the backup is gone too: disconnect every Item from `/settings/connections`, then re-Link each one. Historical transactions stay. |
| Force-sync smoke test fails with `CryptoDecryptError` | The env swap didn't take. Check `docker compose exec app printenv MONEY_ENCRYPTION_KEY` matches the new value byte-for-byte. Restart again. |

## What the script does NOT do

- It does not generate the new key for you. (Generate it yourself with
  `openssl rand -base64 32` — keeping key generation in your hands keeps the
  key out of any agent/automation logs.)
- It does not swap `.env.local` for you. (Step 5 is a manual edit so you can
  visually confirm the value before it goes live.)
- It does not back up the database for you. (Step 1 is the operator's
  responsibility — backups should already be running per
  [RESTORE.md](RESTORE.md).)
- It does not log the keys or the decrypted token bytes. The result is
  counts only.

## Tested?

Yes. `src/lib/plaid/tokens.test.ts` includes four rotateEncryption tests:

- key-shape validation (16-byte input rejected),
- round-trip rotation (two rows → re-encryption under a new key → originals
  recovered under the new key, old key no longer authenticates),
- tombstone skip (status='removed' rows are counted in `rowsSkipped`),
- failure rollback (passing a wrong old key fails the whole transaction; the
  original row stays decryptable under the real env key).

The dry-run path in the CLI is exercised manually — it only reads, so the
risk surface is small.
