# Beancount export

> A nightly, one-way, plain-text mirror of your data in
> [Beancount](https://beancount.github.io/) format (Phase 6, **ADR-016**). It
> exists so that — even if this app is abandoned, unbuildable, or you simply walk
> away — you can still read your entire financial history forever in `less`.

## Why it exists: a longevity hedge, not a ledger

The IDEAS.md §2/§10 "data layer" idea: the most expensive failure mode for a
personal finance app is *abandonment*. The encrypted `pg_dump`
([BACKUP.md](BACKUP.md)) is the machine-faithful copy, but it needs Postgres 16
and a key to read. This export is the **human-readable** copy — a text file that
survives the app itself.

It is deliberately a **hedge, not an accounting system**:

- **One-way.** Generated nightly, never hand-edited, **never re-imported.** The
  database is always the source of truth; the `.beancount` file is a projection.
- **Best-effort transactions.** Each transaction renders as a balanced
  two-posting entry with a generic `Income:`/`Expenses:` contra leg — enough to
  read and run reports against, but it is **not** double-entry bookkeeping with
  enforced balances.
- **Stays inside the domain boundary.** Per CLAUDE.md §Domain Scope we are *not*
  building Quicken/QuickBooks. No balance enforcement, no tax lots — just a
  faithful, readable dump.

## Enable it

The export is **opt-in** via one env var (the prod compose sets it on the worker
by default):

```ini
BEANCOUNT_DIR=/exports     # a Docker volume; leave empty in dev to skip the job
```

A BullMQ repeatable job — `export-beancount-daily`
([src/worker/jobs/export-beancount-daily.ts](../src/worker/jobs/export-beancount-daily.ts)) —
runs in the worker at **04:30 in your time zone** (`MONEY_TZ`, UTC when unset), right after the 04:00 backup so the
encrypted dump and the plain-text mirror reflect the same day's data. It writes
`BEANCOUNT_DIR/money.beancount` **atomically** (temp file → rename), so a reader
never sees a half-written file. Output is **deterministic**: identical data
produces a byte-identical file.

## What's in the file

In order ([src/lib/export/beancount.ts](../src/lib/export/beancount.ts)):

1. A `GENERATED` banner + an `option "operating_currency" "USD"` header.
2. **`open` directives** — one per account, dated on/before its earliest
   activity.
3. **`price` directives** — every `(symbol, date, close)` from the `prices`
   table, preserving full 8-dp precision.
4. **`balance` assertions** — from `account_snapshots`, in the account's
   currency, cents preserved exactly (no float drift).
5. **Transactions** — best-effort balanced two-posting entries.

### Account naming

Account type maps to the Beancount root, and institution/name are CamelCased into
the path:

| my-money account type | Beancount account |
|-----------------------|-------------------|
| depository, investment, crypto_ira, property | `Assets:<Institution>:<Name>` |
| credit_card, loan | `Liabilities:<Institution>:<Name>` |

e.g. an M&T checking account becomes `Assets:MTBank:Checking`; an Amex card
becomes `Liabilities:Amex:GoldCard`. Names that sanitize to empty get a
placeholder component so the path is always valid.

## How to read it

The whole point is that you need *nothing but a text editor*:

```bash
less /var/lib/docker/volumes/my-money_exports/_data/money.beancount
```

For richer use, the standard Beancount toolchain reads it directly — install
`beancount` and:

```bash
bean-check money.beancount          # validate
bean-query money.beancount "SELECT account, sum(position) GROUP BY account"
fava money.beancount                # a local web UI for browsing/charts
```

## Privacy + replication

The file is **not a secret** (no keys, no tokens) — but it **is plaintext
financial data**: account names, balances, transactions. So:

- Keep the `exports` volume / host directory **private**.
- Replicate it off-host like the backups ([BACKUP.md](BACKUP.md)), but unlike the
  encrypted dumps, send it only somewhere you trust — or encrypt it yourself in
  transit/at rest. The app never pushes it anywhere (CLAUDE.md §Privacy).
