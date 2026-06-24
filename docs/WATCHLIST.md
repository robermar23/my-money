# Watchlist & price targets

> Follow a symbol you **don't own**, optionally "pretend" you bought it, and get a
> once-daily alert when it crosses a target price — up or down (Phase 11,
> **ADR-025 / ADR-026**). A watchlist item is **never** part of net worth.

## What it is

Three capabilities, all reached from **`/watchlist`**:

1. **Watch a symbol** — a stock / ETF, a metal (`XAU`, …), or a crypto coin
   (`BTC`, …) you want to track but do **not** hold. It gets a daily close and a
   price-history chart, exactly like a real holding — but it is **structurally
   excluded from net worth** (see below).
2. **A "pretend" / paper position** — an optional `(purchase date, quantity, unit
   cost)`. With it, the item shows a **simple display gain/loss** and a chart back
   to the hypothetical purchase date. This is a *display figure only* — there is
   **no realized P&L, no tax lots, no 1099** (CLAUDE.md §Domain Scope).
3. **Price-target alerts** — "tell me when SYMBOL reaches $X." Targets are
   **one-shot** and fire through the existing `/alerts` page + the **content-free**
   email doorbell (ADR-015).

## The net-worth-exclusion guarantee

Net worth is computed **exclusively** from `accounts` → (`account_snapshots` |
`holdings` → `holding_snapshots`). A watchlist item is **neither an account nor a
holding** — it lives in its own `watchlist_items` table. So it is invisible to
`computeNetWorth`, allocation, and performance **by construction**: there is no
"remember to filter the pretend ones out" flag that could regress. Deleting a
watch item, or adding a pretend position worth millions, changes net worth by
**exactly zero**.

A symbol can be both **held and watched** at once — the holding values net worth;
the watch row is a separate follow with its own (independent) pretend basis. The
nightly price fetch fetches such a symbol **once**.

## Pretend valuation

Computed **on read** from the shared `prices` series — there is no per-item
snapshot table (a watch row isn't net worth, and its history *is* the price
series). For a pretend position:

- **value** = `quantity × latest close`
- **cost basis** = `quantity × unit cost`
- **gain/loss** = value − cost basis (absolute + percent)

All arithmetic goes through `Money` / `decimal.js`; `Number()` appears only at the
chart/format display edge (CLAUDE.md §Money). A watch-only item (no pretend trio)
shows a price and chart but **no** gain/loss block.

## Price history & backfill (best-effort)

When you add a symbol, a one-shot `backfill-watchlist-symbol` job seeds `prices`
with daily closes from the **pretend purchase date** (or the last 24 months when
watch-only) up to today, via the same public Yahoo (equities/metals) / CoinGecko
(crypto) endpoints used for held symbols. From then on the nightly
`fetch-prices-daily` keeps it fresh.

Backfill is **best-effort**: a fetch failure, a delisted/foreign ticker, or an
obscure coin may yield partial or empty history. That surfaces as a **"limited
history"** note on the detail page — never an error — and the nightly fetch fills
it in over time.

## Price targets — one-shot semantics & re-arming

Each target has a **direction** and a **threshold**:

- **above** fires when the daily close is **≥** the threshold.
- **below** fires when the daily close is **≤** the threshold.

The boundary is **inclusive** — a close exactly equal to the threshold fires.

A target is **one-shot**: when it fires, an `alerts` row is written and the target
flips to **inactive** (`active = false`), stamped with `triggered_at` /
`triggered_price`. It does **not** re-arm itself — this avoids nightly nagging
while a symbol sits parked past its threshold. To watch again, **re-arm** it
(the Re-arm button, or edit) — which clears the trigger stamps so it can fire
afresh. You can also **pause** an armed target without deleting it.

Because `price_target` is one-shot, it is deliberately **excluded** from the
anomaly resolve-sweep (`RULE_ALERT_TYPES`), the same exemption as
`backup_failure` — see [docs/ALERTS.md](ALERTS.md).

## Cadence: once-daily, not real-time

The evaluator (`evaluate-price-targets`) runs **once daily**, chained off the end
of the nightly `fetch-prices-daily` so it always sees the freshest close with no
race. **It is not real-time.** A target that is hit intraday and retraces before
the nightly fetch will **not** fire that day. This is a deliberate trade-off for a
long-horizon personal tracker: continuous intraday polling means more egress and
rate-limit complexity for marginal value to a single self-hosted user.

**Deferred (Open Item):** an env-gated higher-frequency poll during market hours
is the documented future path if real-time alerting is ever wanted. It is not
shipped.

## Notifications stay content-free

The price-target email is the Phase-6 **doorbell**: a **count + a sign-in link**,
nothing else. **No symbol, no threshold, no price, no pretend P&L** ever leaves
the box. Those figures live only in the authenticated `/alerts` and `/watchlist`
pages (in the alert's `detail`, never its title). Leave SMTP unset and `/alerts`
is simply the only channel. See [docs/ALERTS.md](ALERTS.md) for SMTP setup.

A privacy-regression test
([privacy-egress.test.ts](../src/lib/watchlist/privacy-egress.test.ts)) **fails**
if any symbol/threshold/price/amount appears in the rendered email, and audits the
series fetchers to prove only the ticker egresses.

## Security & privacy checklist (P11-22)

Verified for the Phase 11 surface; re-check on any change:

- [x] **No new egress class.** Watched symbols are fetched from the **same** public
      Yahoo / CoinGecko endpoints as held symbols; only the **ticker string** (and
      a date range) egresses. No quantity, cost, target, balance, or account name
      leaves the host. Static audit in `privacy-egress.test.ts`.
- [x] **Pretend figures & thresholds are 100% local** — stored in Postgres, ride
      the nightly `age`-encrypted `pg_dump`, never emailed.
- [x] **Content-free notification.** Alert titles carry symbol + direction only,
      **no figures**; the email carries a count + link only. Behavioral regression
      test asserts the body leaks nothing financial.
- [x] **All `/watchlist` routes are `requireUser`-gated** — every page calls
      `requireUser()`; every server action calls `requireUser()` first and
      validates UUID params before touching the DB.
- [x] **Inputs validated with Zod at the action boundary** — symbol uppercased,
      `asset_class` restricted to the fetchable subset (`equity` / `crypto` /
      `physical_metal`), the pretend trio enforced all-or-nothing (DB CHECK is the
      backstop), threshold validated as a decimal string.
- [x] **User-entered text (symbol / label / notes) is rendered as React text** —
      escaped by default, **no `dangerouslySetInnerHTML`** anywhere in the
      watchlist UI (XSS-safe even though the data is the user's own).
- [x] **No `NEXT_PUBLIC_*` leakage** and **no new outbound host** beyond the Yahoo
      / CoinGecko endpoints the price pipeline already uses.
- [x] **The price-target item id is bound server-side** for target creation (not a
      client-supplied field), and target/delete actions are scoped by
      `(target_id, watchlist_item_id)`.

## Files

- Schema: [`watchlist-items.ts`](../src/db/schema/watchlist-items.ts),
  [`price-targets.ts`](../src/db/schema/price-targets.ts)
- Valuation (pure): [`valuation.ts`](../src/lib/watchlist/valuation.ts)
- Queries: [`queries.ts`](../src/lib/watchlist/queries.ts)
- Server actions + Zod: [`actions.ts`](../src/app/watchlist/actions.ts),
  [`watchlist.ts`](../src/lib/schemas/watchlist.ts)
- Alert rule (pure): `priceTargetAlerts` in [`rules.ts`](../src/lib/alerts/rules.ts)
- Jobs: [`backfill-watchlist-symbol.ts`](../src/worker/jobs/backfill-watchlist-symbol.ts),
  [`evaluate-price-targets.ts`](../src/worker/jobs/evaluate-price-targets.ts)
- UI: [`/watchlist`](../src/app/watchlist/)
