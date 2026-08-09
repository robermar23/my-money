# PLAN — `netWorthSeries` set-based rewrite

**Type**: targeted library rewrite (not a phase). Spun out of
[PLAN13.md](PLAN13.md) §Open Items, found by **P13-20** (`pnpm perf:dashboard`).
**Blast radius**: one exported function, one production call site, three test files.

> ## ✅ Delivered
>
> All of NW-01 … NW-10 are implemented. Results against the P13-20 seeded book
> (12 accounts, 32 holdings, 1,096 snapshot days, ~36k price rows):
>
> | Acceptance criterion | Target | Actual |
> |---|---|---|
> | Zero numeric change | 0 mismatches | **0 over 1,096 points** (`pnpm parity:networth`) |
> | One query | 2 statements | **2.0**, identical for `1M` and `ALL` |
> | Unranged series | < 1,000 ms | **342 ms** (from 84,717 ms — **248×**) |
> | Ranges differ | 1M ≪ ALL | **`1M` 16 ms vs `ALL` 342 ms**; `loadDashboard` 108 ms vs 440 ms |
> | Suite green | all | **698 tests / 81 files**, `pnpm check` clean, Phase 13 E2E green |
> | Docs corrected | — | [docs/DASHBOARD.md](../../docs/DASHBOARD.md) §Performance rewritten |
>
> **No new index** (NW-06): `EXPLAIN (ANALYZE, BUFFERS)` shows both laterals as
> `Index Scan Backward` on the pre-existing primary keys —
> `account_snapshots_account_id_date_pk` (13,152 probes) and
> `prices_symbol_date_pk` (35,072 probes).
>
> Notes from the build, where reality differed from the plan, are in §11.

---

## 1. The problem, measured

[`netWorthSeries`](../../src/lib/net-worth/compute.ts#L163) walks every distinct
snapshot date and calls `computeNetWorth` once per date. `computeNetWorth` in turn
queries **once per account** (snapshot lookup or liability lookup) and, for
investment/`crypto_ira` accounts, **once per holding** (latest close). That is:

```
O(days × (accounts + holdings)) round-trips
```

Measured on the P13-20 seeded book — 12 accounts, 32 holdings, 1,096 snapshot
days, ~36k price rows:

| Read | Time | Queries |
|---|---:|---:|
| `netWorthSeries` | **84,717 ms** | **98,089** |
| the other nine dashboard reads, combined | ~335 ms | ~240 |

It is **99% of the dashboard's load time**, it grows by one `computeNetWorth`
call every night the snapshot job runs, and because the loader calls it
**unranged** and filters in JS, `?range=1M` pays the identical full-history cost
(1M 85.1 s vs ALL 86.7 s).

Two aggravating facts: it sits on the **landing page**, so it is the first thing
that runs after login; and the `<Suspense>` boundary (P13-15) hides it behind a
skeleton, which means the page is never blank but is also never *done*.

**Target**: one query, sub-second on the same book. See §8 for the acceptance bar.

---

## 2. Scope

### In scope

- Replace the date-loop with a **set-based SQL query**, aggregated per date.
- Add an **optional date window** so `?range=1M` reads a month, not a decade.
- Prove the rewrite is **numerically identical** to today's implementation.
- Re-measure and update the perf record in [docs/DASHBOARD.md](../../docs/DASHBOARD.md).

### Explicitly NOT in scope

- **Changing any number the app displays.** This is a performance rewrite. If the
  new series differs from the old one by a single cent on any date, that is a bug
  in the rewrite, not an improvement — §5 exists to catch exactly that.
- **Fixing the "historical value uses today's quantity" wart** (§4.4). It is real,
  it is arguably wrong, and it is a *semantic* change that needs its own ADR. It
  is recorded in §10 as a follow-up, deliberately not bundled here — mixing a
  correctness change into a perf rewrite makes the parity test meaningless, which
  throws away the only tool that proves the rewrite works.
- `computeNetWorth` itself. It stays as-is: 109 ms / ~45 queries, called **once**
  per page, and it is the only thing that produces the `items[]` the accounts table
  renders. Optional follow-up in §10.
- The snapshot job, `valueHolding`, `valueAccountHoldings`, and every other caller
  of the holdings-valuation path. Untouched.

---

## 3. The contract to reproduce, exactly

This is the highest-value section of the plan: the rewrite is only correct if it
reproduces every one of these rules. Derived line-by-line from
[compute.ts](../../src/lib/net-worth/compute.ts) as it stands today.

For each distinct date **D** in `account_snapshots`, net worth at D is:

| # | Rule | Source |
|---|---|---|
| R1 | Only accounts **open at D** participate: `closed_at IS NULL OR closed_at > D`, where D is midnight **UTC** | `compute.ts:58` |
| R2 | `type = 'loan'` → remaining principal from `balanceAtMonth(principal, rate, term, monthsBetween(start, D))`, **negated**. A loan with no `liabilities` row contributes **nothing** (not zero — it is skipped) | `compute.ts:63-83` |
| R3 | A loan **never reads `account_snapshots`**, even though the nightly job writes rows for it | `compute.ts:63` (branch order) |
| R4 | `type IN ('investment','crypto_ira')` → **live** value = Σ over the account's holdings | `compute.ts:89-90` |
| R5 | …where a holding with `asset_class IN ('cash','property')` is worth its `quantity` at **face, unrounded** | `value.ts:35-41` |
| R6 | …and any other holding is worth `round₂(quantity × close)` where `close` is the latest `prices` row **on or before D**, **rounded per holding to 2dp before summing** | `value.ts:43-54` |
| R7 | …and a holding with **no price row at or before D** contributes **exactly 0** | `value.ts:44-46` |
| R8 | If that live total is **exactly zero**, fall through to the snapshot path (covers "no holdings yet" and "no prices yet") | `compute.ts:91-101` |
| R9 | Every other type (`depository`, `credit_card`, `property`, `personal_asset`) → the **most recent** `account_snapshots.balance` with `date <= D` | `compute.ts:104-109` |
| R10 | No snapshot at all → contributes nothing, **except** a Plaid-linked account which contributes an explicit `0.00` line | `compute.ts:115-126` |
| R11 | Accounts whose `currency` ≠ `baseCurrency` are **dropped from the total** (they still appear in `items[]`, which the series does not use) | `compute.ts:140-144` |
| R12 | The total is rounded to 2dp **once, at the end**, half-even | `Money.toString()` → `toFixed(2)` |
| R13 | Output is one point per distinct date, **ascending**, `value` as a 2dp string | `compute.ts:170-175` |

Two of these are free wins for the rewrite:

- **R10** only affects `items[]`; a `0.00` line changes no total. The series can
  ignore the Plaid distinction entirely.
- **R11** collapses to a `WHERE accounts.currency = $base` predicate.

---

## 4. The four traps

Each of these silently breaks parity and none of them is obvious.

### 4.1 Rounding mode — half-even vs half-away-from-zero

[money.ts:6](../../src/lib/money/money.ts#L6) configures decimal.js globally with
`ROUND_HALF_EVEN` (banker's rounding). `valueHolding`'s `product.toFixed(2)`
inherits it. **Postgres `round(numeric, 2)` is half-away-from-zero.** They differ
on exact half-cent ties, and ties are *reachable in ordinary data*:

```
0.5 shares × $100.01  =  50.005
  decimal.js half-even → 50.00      Postgres round()  → 50.01
```

Fractional crypto/ETF quantities (`0.5`, `0.25`, `1.5`) against odd-cent closes
hit this. Mitigation: **NW-01** — an explicit half-even SQL fragment plus a
parity test over a table of tie cases.

### 4.2 Round-then-sum ordering

R6 rounds **per holding**, then sums. `SUM(quantity * close)` rounded once at the
end is a *different number*. The fragment must be applied inside the `SUM`, and —
per R5 — **must not** be applied to `cash`/`property` holdings, which go in at
full precision and are only collapsed by R12 at the very end.

Corollary: the grand total must stay **unrounded numeric** all the way out of
Postgres, because loans (R2) are added in TypeScript afterwards and R12's single
rounding happens last.

### 4.3 `date` → `timestamptz` uses the session timezone

R1 compares `closed_at` (timestamptz) against `new Date(D + "T00:00:00Z")`.
In SQL, `'2026-05-01'::timestamptz` is midnight **in the server's `TimeZone`
setting**, not UTC. On any non-UTC container this shifts the boundary by hours and
silently includes or excludes an account for one day.

Always write it explicitly:

```sql
(s.d::timestamp AT TIME ZONE 'UTC')
```

### 4.4 Historical points use *today's* quantity

R4/R6 value historical dates with the holding's **current** `quantity` and a
historical price. Buy 100 shares today and last year's chart retroactively shows
you owning them. `holding_snapshots` records the true historical quantity and
value, so the data to fix this exists.

**This plan preserves the wart.** Changing it is §10's follow-up. It is called out
here so nobody "fixes" it mid-rewrite and destroys the parity signal.

---

## 5. Target design

A **SQL/TS split along the money boundary**: SQL does the *set* work (the
per-date, per-account latest-value lookups); TypeScript does the *money* work
(loan amortization, the final sum, the single rounding). This honors CLAUDE.md
§Money — decimal.js owns the arithmetic — while still collapsing 98k round-trips
into one.

### 5.1 Query shape

One statement. Two lateral index-probes per (date, account) / (date, holding),
both landing on existing primary keys — `account_snapshots (account_id, date)`
and `prices (symbol, date)` — so no new index is expected (verify in **NW-06**).

```sql
WITH spine AS (                                    -- R13: the date axis
  SELECT DISTINCT date AS d
  FROM account_snapshots
  WHERE (${from}::date IS NULL OR date >= ${from}::date)
    AND (${to}::date   IS NULL OR date <= ${to}::date)
),
open_acct AS (                                     -- R1 + R11; loans excluded (R2/R3 → TS)
  SELECT s.d, a.id, a.type
  FROM spine s
  JOIN accounts a
    ON a.currency = ${baseCurrency}
   AND a.type <> 'loan'
   AND (a.closed_at IS NULL OR a.closed_at > (s.d::timestamp AT TIME ZONE 'UTC'))
),
priced AS (                                        -- R4-R7, pre-rounding
  SELECT o.d, o.id, h.asset_class,
         CASE WHEN h.asset_class IN ('cash','property')
              THEN h.quantity                      -- R5: face, unrounded
              ELSE h.quantity * p.close            -- NULL when unpriced → R7
         END AS raw
  FROM open_acct o
  JOIN holdings h ON h.account_id = o.id
  LEFT JOIN LATERAL (
    SELECT pr.close FROM prices pr
    WHERE pr.symbol = h.symbol AND pr.date <= o.d
    ORDER BY pr.date DESC
    LIMIT 1
  ) p ON TRUE
  WHERE o.type IN ('investment','crypto_ira')
),
live AS (                                          -- R6: round PER HOLDING, then sum
  SELECT d, id,
         SUM(CASE WHEN asset_class IN ('cash','property') THEN raw
                  WHEN raw IS NULL THEN 0
                  ELSE <HALF_EVEN(raw)>            -- §4.1 fragment
             END) AS value
  FROM priced GROUP BY d, id
),
snap AS (                                          -- R9
  SELECT o.d, o.id, s.balance
  FROM open_acct o
  LEFT JOIN LATERAL (
    SELECT sn.balance FROM account_snapshots sn
    WHERE sn.account_id = o.id AND sn.date <= o.d
    ORDER BY sn.date DESC
    LIMIT 1
  ) s ON TRUE
)
SELECT sp.d AS date,
       COALESCE(SUM(
         CASE WHEN o.type IN ('investment','crypto_ira')
              THEN COALESCE(NULLIF(l.value, 0), sn.balance, 0)   -- R8 fall-through
              ELSE COALESCE(sn.balance, 0)                       -- R10 → 0
         END
       ), 0)::text AS subtotal                     -- unrounded; R12 happens in TS
FROM spine sp
LEFT JOIN open_acct o ON o.d = sp.d
LEFT JOIN live      l ON l.d = o.d AND l.id = o.id
LEFT JOIN snap     sn ON sn.d = o.d AND sn.id = o.id
GROUP BY sp.d
ORDER BY sp.d;
```

Why each `COALESCE`/`NULLIF` is load-bearing:

- `NULLIF(l.value, 0)` — R8. Also covers "account has no holdings at all", where
  the `JOIN holdings` drops the row and `l.value` arrives `NULL`.
- `sn.balance, 0` — R10: no snapshot contributes zero.
- outer `COALESCE(SUM(...), 0)` — a date where **every** account contributes
  nothing must still emit a point with `0.00`, matching `Money.sum([])`.

### 5.2 The half-even fragment (NW-01)

New `src/lib/net-worth/round.ts`, exporting a single `sql` template so the
expression exists once, is unit-tested, and is versioned with the code:

```ts
/** Banker's rounding to cents in SQL — parity with decimal.js ROUND_HALF_EVEN. */
export const halfEvenCents = (x: SQL) => sql`
  (CASE
     WHEN abs(${x} * 100 - trunc(${x} * 100)) = 0.5
       THEN trunc(${x} * 100)
            + CASE WHEN trunc(${x} * 100) % 2 = 0 THEN 0 ELSE sign(${x}) END
     ELSE round(${x} * 100)
   END) / 100`;
```

Negatives check out: `-50.005` → `trunc(-5000.5) = -5000`, even → `-50.00`
(decimal.js agrees); `-50.015` → `trunc = -5001`, `-5001 % 2 = -1` (Postgres `%`
keeps the dividend's sign) → odd → `-5001 + sign(-1) = -5002` → `-50.02`
(decimal.js agrees). Non-ties fall to `round()`, which matches half-even whenever
there is no tie.

*Alternative considered*: an `IMMUTABLE` SQL function added by migration
(`money_round_half_even(numeric)`). Reads better at the call site but splits money
semantics across the TS/DB line and needs a migration to change. Rejected — the
inline fragment keeps the rule in one auditable, unit-tested place.

### 5.3 Signature

Additive and backward-compatible, so the perf script and existing tests keep
compiling unchanged:

```ts
export interface NetWorthSeriesWindow {
  /** Inclusive lower bound, `YYYY-MM-DD`. Omit for "from the beginning". */
  readonly from?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. Omit for "through the end". */
  readonly to?: string;
}

export async function netWorthSeries(
  baseCurrency = "USD",
  window?: NetWorthSeriesWindow,
): Promise<NetWorthPoint[]>;
```

Location: stays in `compute.ts` (it grows ~180 → ~270 lines, still readable) so
**no import anywhere changes** — including `loader.test.ts`'s `vi.mock` of
`@/lib/net-worth/compute.ts`. Only the rounding fragment gets its own module.

### 5.4 Loader wiring

[loader.ts:231](../../src/lib/dashboard/loader.ts#L231) and the JS filter at
:245. The windowing is provably equivalent:

- `netWorth.series` is already `series.filter(p => p.date >= window.from && p.date <= window.to)`.
- `rangeDelta(series, range, …)` re-derives the **same** `rangeWindow(range, now)`
  and filters to it internally ([delta.ts:61-64](../../src/lib/dashboard/delta.ts#L61)),
  so it never reads a point outside the window.

⇒ passing a pre-windowed series changes nothing. Replace the filter with the
direct call and a comment recording the equivalence (a filter that can never
match is worse than no filter — it reads as a safety net that isn't one).

`ALL` resolves `from = "0001-01-01"`, a valid Postgres date, so the same code path
serves every range with no special case.

---

## 6. Task breakdown

| ID | Task | Verify |
|---|---|---|
| **NW-00** | **Decision gate.** Owner confirms: numbers must not change; the §4.4 quantity wart is preserved; §10's follow-ups stay deferred | Recorded in this file; no code before it |
| **NW-01** | `src/lib/net-worth/round.ts` — the half-even fragment | `round.test.ts` (integration, needs a DB): a table of ~20 values incl. `50.005`, `-50.005`, `50.015`, `-50.015`, `0.005`, `2.675`, plus large magnitudes — SQL result **string-equals** `new Decimal(x).toFixed(2)` for every one |
| **NW-02** | Rewrite `netWorthSeries` per §5.1: one `db.execute`, one `SELECT * FROM liabilities`, loans folded in with `Money`, `.toString()` once at the end | `tsc --noEmit`; the existing `compute.test.ts` "one point per distinct snapshot date" case still passes untouched |
| **NW-03** | Window parameter + loader wiring (§5.3, §5.4) | New `compute.test.ts` cases: window clips the point list; a point's **value** is unchanged by windowing (the lateral still reaches back before `from`); `ALL` ≡ unranged |
| **NW-04** | **Fixture parity test** — `src/lib/net-worth/series-parity.test.ts` (§7) | New series deep-equals the reference across a book that exercises R1-R13 |
| **NW-05** | **Property-based parity test** — same file, `fast-check` (already a devDep, precedent: `aead.test.ts`) | 25 randomized small books; every point equal |
| **NW-06** | `EXPLAIN (ANALYZE, BUFFERS)` on the perf DB. Confirm both laterals are index scans on the existing PKs. Add an index **only if** measurement says so (CLAUDE.md §Performance — profile before optimizing) | Plan pasted into docs; index decision recorded either way |
| **NW-07** | Read-only parity check against the **real** dev database — `scripts/networth-parity.ts`, no writes, prints counts + mismatched **dates** only (`--verbose` for amounts) | `0 mismatches over N points` |
| **NW-08** | Re-run `pnpm perf:dashboard --no-seed`; extend the harness to time the **ranged** call so 1M vs ALL finally differ | Fresh table in [docs/DASHBOARD.md](../../docs/DASHBOARD.md) §Performance replacing the ❌ verdict; PLAN13 §Open Items entry updated to "fixed, see this plan" |
| **NW-09** | Full gate: `pnpm test` (685+ green), `pnpm check`, `pnpm test:e2e` for `phase13-dashboard.spec.ts` **against the test DB** (see §9 note) | All green; dev DB row counts unchanged before/after |
| **NW-10** | Docs: JSDoc on `netWorthSeries` stating the R1-R13 contract in prose; a §Performance note in `docs/DASHBOARD.md` linking here | — |

NW-01 → NW-02 → NW-03 are strictly sequential. NW-04/NW-05 gate everything after.

---

## 7. The parity test — the centerpiece

A rewrite of financial math is only trustworthy if the old implementation and the
new one are run **side by side on the same data** and produce identical output.
That is cheap here because `computeNetWorth` stays exported and unchanged, so the
reference is twelve lines **inside the test file** — no dead code in `src/`:

```ts
/** The pre-rewrite implementation, kept here (and only here) as the oracle. */
async function referenceSeries(baseCurrency = "USD"): Promise<NetWorthPoint[]> {
  const dates = await db.select({ date: accountSnapshots.date })
    .from(accountSnapshots).groupBy(accountSnapshots.date)
    .orderBy(sql`${accountSnapshots.date} asc`);
  const points: NetWorthPoint[] = [];
  for (const { date } of dates) {
    const snap = await computeNetWorth(new Date(`${date}T00:00:00Z`), baseCurrency);
    points.push({ date, value: snap.total.toString() });
  }
  return points;
}
```

### NW-04 fixture — one book, every branch

| Seeded thing | Rule it pins |
|---|---|
| `depository` with snapshots on 3 of 6 dates | R9 carry-back across gaps |
| `credit_card` with a negative balance | sign handling |
| `investment`, 2 priced holdings, prices **missing on some dates** | R4, R6, lateral reach-back |
| …one holding with `0.5 × 100.01` | §4.1 tie |
| …one `cash` asset-class holding with an 8dp quantity | R5 unrounded face value |
| `investment` with holdings but **no prices at all** | R7 + R8 fall-through to snapshot |
| `investment` with **no holdings** and a snapshot | R8 (`live` row absent entirely) |
| `crypto_ira` with a `physical_metal` holding | R4 covers both types |
| `loan` **with** a liability row | R2 negation + R3 (also give it snapshot rows and assert they're ignored) |
| `loan` **without** a liability row | R2 skip-not-zero |
| `property` + `personal_asset` | R9 for the valuation types |
| account `closed_at` mid-history | R1, including the UTC boundary day |
| account in `EUR` with a big balance | R11 exclusion |
| account with a `plaid_item_id` and no snapshot | R10 (must not shift the total) |
| a date where **no** account has any value yet | `0.00`, not a missing point |

Assertion: `expect(await netWorthSeries()).toEqual(await referenceSeries())` — a
whole-array deep equal, so both the dates and the strings must match.

### NW-05 property test — the cases nobody thought of

`fast-check`, `numRuns: 25`, bounded generators (≤4 accounts, ≤6 dates, ≤3
holdings, quantities/prices drawn from a pool that includes half-cent producers).
Truncate → seed → compare both implementations → assert equality. Keeps the
reference's O(n²) cost trivial while sweeping combinations a hand-written fixture
never reaches.

> Runtime note: these specs `TRUNCATE` shared tables, which is why
> `vitest.config.ts` already pins `pool: forks` / `singleFork` /
> `fileParallelism: false`. Follow the `resetDomain()` + `beforeEach` pattern from
> [compute.test.ts](../../src/lib/net-worth/compute.test.ts).

---

## 8. Acceptance criteria

1. **Zero numeric change.** NW-04 and NW-05 pass; NW-07 reports 0 mismatches
   against the real dev database.
2. **One query.** `netWorthSeries` issues exactly **2** statements (the series
   query + the liabilities read), independent of days/accounts/holdings — asserted
   by the perf harness's query counter, not by eyeball.
3. **< 1,000 ms** for `netWorthSeries("USD")` unranged on the P13-20 seeded book
   (from 84,717 ms — a ≥85× floor; the realistic figure is a few hundred ms).
4. **Ranges now differ.** `loadDashboard("1M")` is measurably faster than
   `loadDashboard("ALL")`. Both well under a second.
5. **Whole suite green**: `pnpm test`, `pnpm check`, and the Phase 13 E2E.
6. **Docs corrected**: `docs/DASHBOARD.md` §Performance's ❌ verdict replaced with
   the new numbers; PLAN13 §Open Items points here.

---

## 9. Risks, and what catches each

| Risk | Catch |
|---|---|
| Half-cent rounding divergence (§4.1) | NW-01 tie table + the `0.5 × 100.01` fixture row |
| Timezone-shifted `closed_at` boundary (§4.3) | Explicit `AT TIME ZONE 'UTC'` + the closed-account fixture row, seeded to close *on* a snapshot date |
| Round-then-sum inverted (§4.2) | Multi-holding fixture where per-holding vs total rounding differ |
| `NUMERIC` arriving as a JS `number` and losing pennies | Cast `::text` in SQL; assert `typeof subtotal === "string"` in NW-04 |
| Untyped `db.execute` rows | Narrow through an explicit `interface SeriesRow` at the boundary, exactly as `backfill.ts` does |
| SUM over zero rows → `NULL` | Outer `COALESCE(…, 0)`; the "no account has value yet" fixture date |
| Silent behavior change nobody notices for months | The parity test is a permanent regression, not a one-off script |
| **Wiping the user's dev data via E2E** | `e2e/global-setup.ts` truncates `DATABASE_URL`, which **defaults to the dev DB on :5433**. Run NW-09's E2E with `DATABASE_URL` pointed at `money_test` on :5434, and capture dev row counts before/after (the Batch 6 procedure) |

**Rollback**: one function body plus one call site. `git revert` restores the loop
implementation with no schema, no migration, and no data change — nothing in this
plan writes to the database.

---

## 10. Deferred follow-ups (record, don't build)

- **Historical quantity semantics (§4.4).** Value historical dates from
  `holding_snapshots` (true quantity *and* value on that date) instead of today's
  quantity × that day's price. More correct; **changes displayed history**; needs
  an ADR in [IDEAS.md](IDEAS.md) §11 and a decision about dates predating the
  Phase 9 snapshot backfill. Do it *after* this rewrite lands, so the parity test
  can be flipped from "must match" to "must differ in exactly this way".
- **`computeNetWorth`'s own per-account loop.** ~45 queries / 109 ms, called once
  per page — not currently a problem. The same lateral pattern would collapse it,
  but it must keep returning `items[]` for the accounts table, so it is a
  different (larger) refactor for a much smaller prize. Measure before touching.
- **Snapshot-job N+1** (`compute-snapshots-daily`, one query per holding). It runs
  nightly in a worker where nobody is waiting; leave it.
- **`e2e/global-setup.ts` default DB.** A bare `pnpm test:e2e` truncates the *dev*
  database. Independent of this plan, worth its own small task, touches all 14
  specs.

---

## 11. Notes from the build — where reality differed from the plan

Recorded because each of these was a way the rewrite could have shipped wrong
while every test stayed green.

### 11.1 decimal.js's half-even mode is a side effect of an import

`money.ts` calls `Decimal.set({ rounding: ROUND_HALF_EVEN })` at module scope.
The first version of NW-01's test imported `decimal.js` directly and compared the
SQL fragment against `new Decimal(x).toFixed(2)` — which, without `money.ts`
loaded, is the library **default of half-*up***. The test failed claiming the
correct SQL was wrong. The oracle is now `Money.toString()`, which is both right
and the exact call the production path makes.

### 11.2 Postgres has no negative zero (bounded, documented)

`new Decimal("-0.004").toFixed(2)` is the string `"-0.00"`; the SQL fragment
yields `0.00`. This is representational only — the string is transient, handed
straight back to `Money.fromString`, and `Money.toString()` renders any exact zero
as `"0.00"`. Asserted rather than papered over, in `round.test.ts`.

### 11.3 The §7 fixture could not catch a stray `round()` on cash holdings

Rounding to cents is idempotent under adding exact-cent values: `round₂(q + c)`
and `round₂(round₂(q) + c)` always agree for a **single** over-precise holding.
Two are required, with tails that sum across a cent (`100.006 + 100.006 = 200.012
→ 200.01`, versus `100.01 + 100.01 = 200.02`). The big fixture also cannot make
this call, because the loan's amortization contributes its own sub-cent tail that
can mask the gap — so R5 gets its own isolated test.

### 11.4 The property test needed deliberate weighting to be worth anything

With uniform draws over seven account types, five asset classes, and a sparse
price table, 25 runs never assembled the interesting shape: a live-valued account
holding a *priced* position at a half-cent tie. Swapping the half-even fragment
for a plain `round()` **survived the whole property test**. The generator now
leans toward `investment`/`crypto_ira`, toward priced asset classes, and
guarantees a baseline price per symbol.

Every test in this plan was validated by mutation — five deliberate breakages
(naive `round()`, sum-then-round, rounding cash face value, letting loans read
snapshots, dropping the R8 fall-through), each confirmed to fail the suite before
being reverted. Two of them initially did **not** fail, which is how 11.3 and 11.4
were found.

### 11.5 `pg_stat_database` is the wrong instrument for a sub-second read

Acceptance criterion 2 ("exactly 2 statements") could not be measured the way §8
assumed. Postgres backends buffer statistics and flush at most about once a
second, so the harness's counter reported **9.3** statements per call (the
previous reads' backlog charged to the measured window) or **0.1** (a window that
closed before anything flushed) depending on how it was run. Neither was real.

`pg_stat_statements` exists in the catalog but is not in `shared_preload_libraries`,
so it is unusable without changing the container. The harness now uses a discarded
drain phase plus windows sized in **seconds** rather than repetitions — which
reports a stable **2.0** for both `1M` and `ALL`.

### 11.6 Two harness/test assumptions had to be recalibrated

- **The parallel-fan-out verdict.** It asserted wall time tracks the *slowest*
  read, which was true only because `netWorthSeries` dominated everything. With no
  dominant read the ten now contend, and wall time legitimately lands between the
  slowest and the sum. It accepts either shape; serialized execution satisfies
  neither.
- **`loader.test.ts` pinned the JS filter.** It asserted the loader drops
  out-of-window points. That is now the query's job, so the test asserts the new
  contract instead: the loader **passes the window down** and uses the result
  untouched.

### 11.7 NW-07 against the dev database is vacuous here

The dev DB holds 2 accounts and **zero** `account_snapshots` rows, so the
comparison is over 0 points — agreeing on nothing proves nothing, and the script
now says so out loud instead of printing a green tick. The meaningful real-data
run was the same script pointed at the seeded 3-year book: **0 mismatches over
1,096 points, 228× faster**. Worth re-running (`pnpm parity:networth`) once the
dev database has real history.

---

*End of PLAN_NETWORTH_SERIES.md*
