# Market-Data Threat Model (Phase 9 / STRIDE)

A STRIDE analysis of the **public market-data egress surface** introduced in
Phase 9: the security-enrichment fetch (sector / industry / region / forward
dividend metadata) and the benchmark-price fetch (`^GSPC`). It complements
[THREAT_MODEL_PLAID.md](THREAT_MODEL_PLAID.md) (the credential-bearing surface)
and [THREAT_MODEL.md](THREAT_MODEL.md) (whole-app). Every mitigation points at a
specific PLAN9 task, or is marked **accepted** (residual risk acknowledged) or
**open** (work beyond this phase).

> **Why this is a *low*-sensitivity surface.** Unlike Plaid (which carries
> credentials and a long-lived `access_token`), market data adds **no
> secret-bearing asset**. The only thing that leaves the host is a **ticker
> symbol** sent to an unauthenticated public endpoint — the exact data category
> and trust boundary the Phase 2/5 price fetch already crosses. The enriched
> columns (`sector`, `industry`, `dividend_rate`, …) are public facts about a
> security, not user data.

> Scope: single-user, self-hosted my-money. Multi-user threats are out of scope —
> the `users` table holds exactly one row by design.

## Trust boundary

```text
┌──────────────────────┐      ┌──────────────────────┐
│   BullMQ worker      │      │  Yahoo public market │
│  refresh-fundamentals│─────►│  endpoints           │
│  -weekly /           │ TLS  │  /v8/finance/chart,  │
│  fetch-prices-daily  │ GET  │  /v10 quoteSummary   │
│  (docker network)    │◄─────│  (no auth, no key)   │
└──────────┬───────────┘ only │                      │
           │ symbol  string   └──────────────────────┘
           ▼
┌──────────────────────┐
│  Postgres (private)  │
│  securities, prices  │
└──────────────────────┘
```

- **worker ↔ Yahoo**: outbound HTTPS GET only; **request body carries only the
  ticker symbol** in the URL path/query. No credential is presented (the
  endpoints are unauthenticated) and **no user data is attached**.
- The fetch happens **only** in worker/server code
  ([yahoo-fundamentals.ts](../src/lib/prices/yahoo-fundamentals.ts),
  [yahoo-chart.ts](../src/lib/prices/yahoo-chart.ts), invoked from
  [refresh-fundamentals-weekly.ts](../src/worker/jobs/refresh-fundamentals-weekly.ts)
  and [fetch-prices-daily.ts](../src/worker/jobs/fetch-prices-daily.ts)). It is
  never reachable from a `'use client'` component or the browser.

## Assets

| Asset | Sensitivity | Location |
|---|---|---|
| Ticker symbol (egressed) | None — public identifier | URL of the outbound GET |
| Enrichment metadata (sector/industry/dividend_rate/…) | Low — public security facts | `securities.*` columns |
| Benchmark closes (`^GSPC`) | Low — public index prices | `prices` (symbol `^GSPC`) |
| Held quantities / balances / account names | High — never transmitted | DB only; **must not** reach this surface |

---

## Surface 8 — Security-enrichment + benchmark fetch

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S**poofing — impersonated endpoint | A MITM or DNS-poisoned host returns forged fundamentals | TLS validates the Yahoo host certificate on every GET; no plaintext fallback. A forged response can at worst write *wrong public metadata* (low impact — see Tampering); it cannot reach a credential or user data because none is sent. | ✅ Accepted (TLS) |
| **T**ampering — response injection | A malicious/garbled response injects unexpected fields, huge strings, or wrong types to corrupt the DB or crash the parser | `parseFundamentals` validates a **narrow Zod slice** of the response and unwraps `{raw}`; anything off-shape is dropped. `fetchFundamentals` **never throws** — any parse/network failure returns `null`, leaving the prior (or null) value intact. Numbers land in `numeric` columns; the `asset_type` CHECK rejects unknown enum values. | ✅ P9-06 |
| **R**epudiation — "where did this metadata come from?" | Later doubt about whether a value was fetched or fabricated | `securities.raw` retains the provider payload for re-derivation; `fundamentals_refreshed_at` stamps each successful refresh, making provenance and staleness visible. | ✅ P9-05, P9-07 |
| **I**nformation disclosure — **user-data exfil via the outbound fetch** | The fetcher is extended to attach a holding, quantity, balance, account name, or cost basis to the request — leaking financial data to a third party | **The fetch carries only the ticker symbol.** Enforced by a static egress audit ([fundamentals-egress.test.ts](../src/lib/investments/fundamentals-egress.test.ts), P9-08): the fetcher source (comments stripped) must reference **no** holdings/account/quantity/balance/cost-basis identifier, import **no** `@/db/*`, and build the request URL from `encodeURIComponent(symbol)` **alone**. The test fails CI the moment a user-data identifier appears in the fetch path. | ✅ P9-08 |
| **I**nformation disclosure — which tickers you hold | The list of symbols fetched reveals what you own to the provider/network | This is the **same residual** as the existing Phase 2/5 price fetch (held symbols are already fetched nightly) — no *new* disclosure beyond what prices already imply. Synthetic `SEC:` symbols and crypto/metals short-circuit (no fundamentals call), so non-public holdings are never even named upstream. Accepted, consistent with ADR-020. | ⚠️ Accepted (same as price fetch) |
| **I**nformation disclosure — client-side leak | A fundamentals/benchmark call is moved into a Client Component and runs in the browser, exposing the egress (and any future params) to page scripts/extensions | The fetchers live in `src/lib/prices/` and are imported only by worker jobs — a grep over `src/app/**` shows **no** client-side fundamentals or chart-fetch import. The P9-24 pass re-runs that grep. | ✅ P9-24 |
| **D**enial of service — provider rate-limit / ban | Aggressive refreshing gets the host rate-limited or IP-banned, breaking prices too | Fundamentals refresh is **weekly**, not daily, and touches only securities whose watermark is null or > 7 days old; both fetchers reuse `withRateLimitRetry` (bounded exponential backoff). One job, idempotent. | ✅ P9-06, P9-07 |
| **D**enial of service — oversized/slow response | A pathological response stalls or memory-bombs the worker | Fetch uses the shared raw-fetch posture (HTTPS GET, bounded retry); a parse failure yields `null` rather than retaining a giant blob. **Open**: no explicit response-size cap on the fundamentals GET — mirrors the price-fetch posture; logged below. | ⚠️ Open (provider-bounded) |
| **E**levation of privilege — enrichment writes beyond its lane | The enrichment store overwrites prices, holdings, or `securities.raw` | `upsertFundamentals` writes only the enrichment columns + watermark and **leaves `securities.raw` untouched**; it has no path to `holdings`/`prices`. The weekly job selects and updates `securities` only. | ✅ P9-07 |

---

## Cross-cutting controls

- **Server-only egress**: the fetchers are invoked exclusively from worker jobs;
  no `NEXT_PUBLIC_*` market-data var exists and no client component imports them.
- **Fail-closed parsing**: every provider response passes a narrow Zod boundary;
  malformed input becomes `null`, never a thrown crash or a half-written row.
- **No new secret**: this surface presents no credential and stores none; a full
  compromise of the enrichment path leaks at most *public* security metadata.
- **Idempotent, watermarked jobs**: re-running the weekly refresh or the nightly
  price+benchmark fetch converges to the same state (`ON CONFLICT DO UPDATE`).

---

## Open Items

1. **No explicit response-size ceiling on the fundamentals GET** — Surface 8 /
   DoS. Provider-bounded in practice; a `maxContentLength`-style guard on the
   raw fetch would tighten it. Mirrors the existing price-fetch posture.
2. **Provider-trust for metadata integrity** — Surface 8 / Tampering. We accept
   Yahoo's public data as-is; a second source for cross-checking sector/dividend
   values is out of scope (YAGNI for one user). `raw` retention makes a later
   re-derivation possible if a value is ever disputed.

---

## How to use this document

When changing any code in `src/lib/prices/yahoo-fundamentals.ts`,
`src/lib/prices/yahoo-chart.ts`, `src/lib/investments/fundamentals.ts`,
`src/worker/jobs/refresh-fundamentals-weekly.ts`, or the benchmark branch of
`src/worker/jobs/fetch-prices-daily.ts`:

1. Confirm the change adds **nothing** but the ticker symbol to the outbound
   request — the P9-08 egress audit must stay green.
2. Confirm the fetch stays in worker/server code (no client import).
3. If your change weakens a mitigation, restore it or open an Open Item.
