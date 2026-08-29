# Anomaly alerts

> Deterministic nightly checks that surface "something looks off" — a large
> transaction, a balance drop, a dead price feed, a broken Plaid connection
> (Phase 6, **ADR-015**). The in-app `/alerts` page is the source of truth; email
> is an **optional, content-free doorbell**.

## How it works

A BullMQ repeatable job — `detect-anomalies-daily`
([src/worker/jobs/detect-anomalies-daily.ts](../src/worker/jobs/detect-anomalies-daily.ts)) —
runs in the worker at **05:00 local**, last in the nightly chain so a failed
04:00 backup is already alertable. Each pass:

1. Loads rule inputs from Postgres and runs the **pure, deterministic rules**
   ([src/lib/alerts/rules.ts](../src/lib/alerts/rules.ts)) — no ML, mirroring the
   ADR-007 regex categorizer. Hosted LLMs are a CLAUDE.md §Privacy non-starter;
   local ML is overkill for one user.
2. Persists results to the `alerts` table, **idempotent** on a `dedup_hash`
   (`INSERT … ON CONFLICT DO NOTHING`), so a standing condition fires exactly
   once rather than every night.
3. **Resolves** open alerts whose condition has cleared (e.g. you reconnected a
   Plaid Item), stamping `resolved_at`.
4. Sends one **notification-only** email for whatever is still open and
   un-notified, then stamps `notified_at`.

View everything at **`/alerts`** (severity-colored; dismiss to resolve manually).

## Rule catalog

| Type | Severity | Fires when | Threshold env | Dedup key (re-fire trigger) |
|------|----------|-----------|---------------|------------------------------|
| `large_transaction` | warning | a single transaction's **magnitude** exceeds the limit (in/outflow both count) | `ALERT_LARGE_TXN_USD` (2000) | txn id + posted date |
| `balance_drop` | warning | an account's latest snapshot fell **more than** N % vs. the prior, from a positive baseline | `ALERT_BALANCE_DROP_PCT` (25) | account + latest date |
| `item_login_required` | warning (**critical** if revoked) | a Plaid Item is `login_required` / `revoked` / `pending_disconnect` | — | item + status (a status change re-fires) |
| `stale_snapshot` | warning | an active account's newest snapshot is older than N days | `ALERT_STALE_DAYS` (3) | account + latest snapshot date |
| `stale_price` | info | a held symbol's newest price is older than N days (feed dying) | `ALERT_STALE_DAYS` (3) | symbol + latest price date |
| `sync_failure` | warning | a Plaid sync run recorded an error in the last day | — | sync-run id + started date |
| `backup_failure` | critical | the nightly backup job threw | — | per day; **cleared only by a successful backup**, never by this job |
| `advice` | inherits the recommendation's (critical/warning only) | household guidance changes state — see [GUIDANCE.md](GUIDANCE.md) | `household_profile.high_interest_threshold_apr` and the other tunables | rule + subject + `severity\|status`, **deliberately excluding the amount** |
| `projected_shortfall` | **critical** if the balance goes negative, else warning | the daily cash-flow projection dips below your cash floor inside the horizon — see [CASHFLOW.md](CASHFLOW.md) | `household_profile.cash_floor` / `projection_horizon_days` | the low-water **date** (so a moving shortfall re-fires, a standing one does not) |
| `obligation_missed` | warning | a confirmed obligation's match window closed with nothing found. Fires for receipts too — an expected payment that never arrived leaves the projection wrong in the optimistic direction | ±5 days (`DEFAULT_MATCH_TOLERANCE`) | occurrence + due date, so it fires exactly once |
| `obligation_amount_changed` | warning | a matched bill posted for more than **5% or $5** off its expectation, whichever is larger. `trailing_median` obligations never fire — varying is what that mode means | `AMOUNT_CHANGE_THRESHOLD` | occurrence + due date |

Notes:
- Thresholds are **strictly greater-than** — a transaction of exactly
  `ALERT_LARGE_TXN_USD`, or a drop of exactly `ALERT_BALANCE_DROP_PCT`%, does
  **not** fire. All money comparisons go through `Money`/Decimal, never floats
  (CLAUDE.md §Money).
- Accounts/symbols that were **never** snapshotted or priced (NULL) are skipped,
  so a freshly-added holding doesn't immediately alert.
- `backup_failure` is written **directly** by the backup job, not by a rule. The
  resolve sweep only touches rule-managed types, so a standing backup failure
  stays open until a backup actually succeeds.
- `advice` is likewise **exempt from the resolve sweep**. A guidance rule can go
  quiet for two very different reasons — the household fixed the problem, or an
  input it depended on went missing — and auto-resolving would treat those
  identically, announcing good news the app has no evidence for. Its dedup key
  omits the dollar figure on purpose: folding in the amount would make every cent
  of balance drift a fresh "material change," which is the nightly nag in
  disguise. Titles carry no figures (ADR-015); they live in `detail`.
- The three **cash-flow** types are written by `project-cashflow-daily` and
  swept by that same job, **not** by `detect-anomalies-daily`. Each job
  resolve-sweeps only the types it detects; adding one to the anomaly job's
  list would resolve a shortfall raised at 02:00 by 05:00 the same night,
  before anyone read it. `projected_shortfall` is a standing condition that
  genuinely clears when the projection recovers; `obligation_missed` and
  `obligation_amount_changed` are one-shot events and never auto-resolve.
  Their titles name the **obligation label** but never an amount — Phase 16
  is the first phase whose titles carry user-authored text, and the
  content-free email carries neither.

## Threshold configuration

All optional — defaults shown. Set in `.env.local` (and on the `worker` service
in compose if you override them):

```ini
ALERT_LARGE_TXN_USD=2000     # flag any single transaction larger than this
ALERT_BALANCE_DROP_PCT=25    # flag a balance dropping more than this %
ALERT_STALE_DAYS=3           # flag snapshots/prices that stop updating for N days
# ALERT_CURRENCY=USD         # base currency for threshold comparisons
```

## Email notifications (optional)

Email is **off** until you configure SMTP. When on, it is a doorbell, not a
report:

```ini
SMTP_URL=smtp://user:pass@mail.example.com:587   # YOUR mail server — no SaaS default
ALERT_EMAIL_TO=you@example.com
# ALERT_EMAIL_FROM=        # defaults to ALERT_EMAIL_TO
APP_BASE_URL=https://money.your-domain.com        # builds the /alerts sign-in link
```

The body is exactly a **count + a sign-in link** — e.g. *"2 new alerts —
https://…/alerts"*. Verify on demand:

```bash
# `run --rm` re-reads --env-file at launch (so newly-added SMTP/alert vars are
# seen) and the register.mjs loader stubs Next's `server-only` marker (else
# run-once.ts fails with ERR_MODULE_NOT_FOUND: Cannot find package 'server-only'):
docker compose -f docker/compose.yaml --profile prod run --rm --no-deps worker \
  node --experimental-strip-types --import tsx --import ./scripts/loaders/register.mjs \
  src/worker/run-once.ts detect-anomalies-daily
```

## Privacy posture (non-negotiable)

This is why we wrote our own instead of reaching for Resend or a hosted alerting
SaaS (CLAUDE.md §Privacy):

- **No financial data ever leaves the box in a notification.** Alert *titles*
  carry no raw amounts; every figure (amount, balance, account name, symbol)
  lives only in the `detail` column, rendered only on the authenticated
  `/alerts` page. A regression test
  ([notify.test.ts](../src/lib/alerts/notify.test.ts)) **fails** if any amount or
  name appears in the email body.
- **Transport is your own SMTP server.** We ship no default relay. Emailing
  balances through a third-party would defeat the entire reason this app exists.
- **Leave SMTP unset** and `/alerts` is simply the only channel — fully
  functional, zero outbound mail.
