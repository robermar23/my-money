# PLAN — Phase 3 (QFX/CSV Import for Cash & Credit Accounts)

> Phase 3 makes the monthly ritual painless: **download a `.qfx` from M&T or your credit card, drop it on the account page, click confirm — done.** Cash-flow history materializes; the ending balance written to `account_snapshots` keeps the dashboard honest.
>
> This is the last manual-import phase before Plaid push (Phase 4). The importer infrastructure built here (`transactions` table, dedup by `fitid`, preview-then-confirm UX, reconciliation diff, BullMQ job for backfill) is what Phase 4 plugs into — Plaid sync writes to the same table, dedups by the same key, surfaces reconciliation in the same UI.
>
> **Companion docs** — read these for context, do not duplicate them here:
> - [FEATURE.md](FEATURE.md) — what we're building
> - [IDEAS.md](IDEAS.md) — locked ADRs + per-institution integration table (§4.1, §4.5) + schema sketch (§6)
> - [SKILLS.md](SKILLS.md) — Phase 3 skills map (Suggested Workflow → Phase 3)
> - [PLAN0_1.md](PLAN0_1.md) — what already exists (schema, accounts UI, snapshot job, dashboard)
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Money & Numeric Precision, §Importers, §Schema Invariants, §Background Jobs

---

## What already exists (do not rebuild)

Phase 0/1/2 built the foundation Phase 3 extends. Inventory before writing code:

- **Schema**: `accounts`, `holdings`, `account_snapshots`, `liabilities`, `prices`, `fx_rates`, `users` — all in [src/db/schema/](../../src/db/schema/). No `transactions`/`entries` table yet — Phase 3 adds it.
- **Money helpers**: [src/lib/money/money.ts](../../src/lib/money/money.ts) — `Money.fromString`, `add`, `sub`, `negate`, `sum`, `format`. **Use this for every arithmetic operation on imported amounts. Never `Number()` a transaction amount.**
- **Server actions pattern**: [src/app/accounts/[id]/actions.ts](../../src/app/accounts/[id]/actions.ts) — `'use server'`, `requireUser()` first, Zod `safeParse` on `FormData`, return `ActionResult`, `revalidatePath` after mutation. Phase 3 actions follow this exact shape.
- **BullMQ scaffolding**: [src/lib/queue/queues.ts](../../src/lib/queue/queues.ts) and [src/worker/](../../src/worker/) — adding `process-qfx-import` follows the same pattern as `compute-snapshots-daily` and `fetch-prices-daily`.
- **Account detail page**: [src/app/accounts/[id]/page.tsx](../../src/app/accounts/%5Bid%5D/page.tsx) — Phase 3 hangs the "Import file" CTA and a "Transactions" table off this page for `depository` and `credit_card` account types.
- **Net-worth computation**: [src/lib/net-worth/compute.ts](../../src/lib/net-worth/compute.ts) — already reads `account_snapshots`. Phase 3 writes an authoritative snapshot row per import using the QFX `<LEDGERBAL>`; no change to `computeNetWorth` is required for the import path to "just show up" on the dashboard.

---

## ADRs locked at plan time

Two decisions surface in Phase 3 that warrant ADRs. Both are ✅ locked below. After this plan is approved, append them to IDEAS.md §11 Decision Log.

---

### ADR-006 — QFX/OFX parsing strategy: roll our own minimal SGML reader

**Status**: ✅ Locked 2026-05-26

**Context**:
QFX is "OFX 1.x with a Quicken header." OFX 1.x is SGML, not XML — element-close tags are optional, attributes are rare, and the body is `<TAG>value` lines. OFX 2.x is XML. The format is small, stable (frozen since ~2006 for v1, ~2009 for v2), and well-documented. We need to parse:

- The header block (key:value lines above the SGML body)
- `<STMTTRN>` records inside `<BANKTRANLIST>` or `<CCSTMTTRNRS>` — each containing `<TRNTYPE>`, `<DTPOSTED>`, `<TRNAMT>`, `<FITID>`, `<NAME>`, `<MEMO>`
- `<LEDGERBAL>` and `<AVAILBAL>` for the ending-balance reconciliation
- `<DTSTART>`, `<DTEND>` for the statement period
- Currency from `<CURDEF>` (default USD if absent — common in US bank exports)

Candidates evaluated:

| Option | Verdict |
|---|---|
| `node-ofx-parser` (npm) | Last published 2017, no TS types, unmaintained. ❌ |
| `ofx-js` (npm) | Browser-oriented, returns weakly-typed objects, no `decimal.js` integration. ❌ |
| `ofx-data-extractor` (npm) | More recent, but a large surface area for the 6 fields we need. ⚠️ |
| **Roll our own** | OFX 1.x parser is ~120 LOC: tokenize the SGML body, walk the tag stack, normalize numeric/date fields. Full TS types. Returns `string` amounts so they flow straight into `Money.fromString`. Zero dependency risk. ✅ |

**Decision**: Write a minimal QFX/OFX parser in `src/lib/importers/qfx/parse.ts`. Support OFX 1.x SGML and OFX 2.x XML (a `<` after the header → XML branch; otherwise SGML). Reject anything that isn't one of those.

**Consequences**:
- ✅ Zero npm dependency added for a security-sensitive code path (file upload).
- ✅ Output type is project-shaped, not adapted from a third-party shape.
- ✅ All amounts are returned as **strings** straight from the file — they never round-trip through `Number`. Critical per CLAUDE.md §Money & Numeric Precision.
- ✅ Vitest test fixtures (real anonymized QFX samples from M&T and a credit card) lock parser behavior. We can fuzz it with `fast-check` if the surface grows.
- ⚠️ One-time write cost: ~half a day of focused work + tests. Worth it to remove a long-tail dep.
- ⚠️ If we hit an exotic OFX dialect we'd have caught with a library, we'll add the missing handler — but the test fixtures act as a regression net so it can't silently break old imports.

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Adopt `ofx-data-extractor` | Adds a maintained dep, but pulls in indirect deps and a typing layer we'd wrap anyway. Net code we own only shrinks marginally. |
| Convert QFX→JSON via an external CLI (`ofxstatement`) | Adds a Python/Perl runtime to the container. Defeats the "single Node image" deployment shape. |

---

### ADR-007 — Categorization: regex-rule engine with manual override, deferred ML

**Status**: ✅ Locked 2026-05-26

**Context**:
Imported transactions have a `name` field (the merchant/payee). The user wants categories ("Groceries", "Utilities", "Restaurant", ...) but explicitly does **not** want budgeting/envelope features (CLAUDE.md §Domain Scope — out). Categories here are descriptive (for filtering and charts), not prescriptive.

Three approaches:

1. **No categorization** — leave `category` null; user lives with raw payee names.
2. **Regex rule engine** — table of `(pattern, category, priority)`; first match wins. User edits rules in a settings page; can override a single transaction's category inline.
3. **External LLM categorization** — ship transactions to OpenAI/Anthropic for classification.

Option 3 is a non-starter — CLAUDE.md §Privacy & Data Sovereignty: financial data is **never** sent to a third-party LLM. Option 1 is too poor: the dashboard's main use is "where is the money going." Option 2 is the sweet spot.

**Decision**: Rule engine. A `category_rules` table holds user-defined regex patterns matched against `transactions.name` (and optionally `memo`). Rules are evaluated in priority order on insert/preview; first match wins. If no rule matches, `category` is left `null` (renders as "Uncategorized"). Each transaction has an inline editable category on the transactions table — overrides write `category` directly and set a `category_overridden_at` timestamp so re-running rules later can skip overridden rows.

**Consequences**:
- ✅ Privacy-preserving (matching is local).
- ✅ Cheap, deterministic, debuggable — `EXPLAIN`-style "which rule matched" is just a regex test.
- ✅ Bootstrap value: ship with a small seed file of ~20 generic rules (`/AMAZON/i → Shopping`, `/UBER|LYFT/i → Transport`, ...) the user can edit/delete.
- ⚠️ Regex authoring is a tax. Mitigation: keep the rules page simple (one regex column, one category column, "test against existing transactions" button).
- ⚠️ Reclassification: when the user adds a rule, only **new** imports get it by default. A "re-categorize all" button re-evaluates rules over historical transactions (skipping overridden ones). Phase 3 ships this button.

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| Plaid PFC categories (Phase 4) | They cover Plaid-sourced txns only; CSV/QFX rows would still need a path. Better to have one categorization layer than two. Plaid categories can still seed rules in Phase 4. |
| Local ML (TF.js, a fine-tuned BERT) | Massive overkill for a single-user app. Same value as a tight regex set. |
| Free-text category, no rules at all | Forces manual category entry on every transaction. The whole point of the importer is automation. |

---

## Phase 3 — Goal

After Phase 3 ships, the monthly ritual is:

1. Log into M&T → download a `.qfx` for the statement period.
2. Open the my-money account page → drag the file onto the upload zone.
3. Preview page shows: N new transactions, M duplicates (skipped), 0 invalid rows, reconciliation diff = $0.00.
4. Click "Import N transactions" → the data lands; the dashboard reflects it.

Plus the rest:

- A backlog import of 5 years of historical statements drops in via the same UI and runs in a BullMQ job (request returns immediately with a "watch progress" link).
- Transactions are categorized automatically using the rule engine; the user can override any one inline; the user can edit rules in `/settings/categories`.
- A reconciliation banner on the account page surfaces "imported balance vs. computed-from-transactions" drift — a non-zero diff means missing transactions or a parser bug, and is the early warning system before Phase 4 Plaid pushes start flowing.

---

## Phase 3 — Schema (new tables and columns)

All new tables follow CLAUDE.md §Database & Drizzle Specifics: UUID PKs, `numeric` for money, `timestamp({ withTimezone: true })`, `jsonb` for raw payloads, one schema file per concept under `src/db/schema/`.

```text
src/db/schema/
├── transactions.ts         (NEW)
├── import-batches.ts       (NEW)
├── category-rules.ts       (NEW)
└── index.ts                (UPDATED: re-export the three above)
```

### `transactions` (one row per movement)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `defaultRandom()` |
| `account_id` | `uuid` FK→accounts | `onDelete: 'cascade'` |
| `posted_at` | `date` (`mode: 'string'`) | OFX `<DTPOSTED>` truncated to day; CSV per row |
| `amount` | `numeric(18,2)` | Positive = credit/inflow, negative = debit/outflow — mirrors OFX `<TRNAMT>` sign convention. For credit cards, a "purchase" is negative (money out of the available-credit pool); we keep the same convention for consistency, and the UI flips the sign for credit-card displays only. |
| `name` | `text` | Payee/description. Required. |
| `memo` | `text` | Secondary description. Nullable. |
| `category` | `text` | Nullable; assigned by rule engine or manual override. |
| `category_overridden_at` | `timestamptz` | Null = rule-derived; set = user override. Used by "re-categorize all" to skip overridden rows. |
| `fitid` | `text` | OFX `<FITID>` (unique per institution per account) for QFX; synthetic SHA-256 hex of `(posted_at \| amount \| name)` for CSV. **Always non-null.** |
| `source` | `text` | `'qfx' \| 'csv' \| 'manual' \| 'plaid'` — Phase 3 ships first three; Phase 4 adds `'plaid'`. |
| `import_batch_id` | `uuid` FK→import_batches | Nullable (`'manual'` source has no batch). `onDelete: 'set null'` so deleting a batch doesn't lose the transactions. |
| `raw` | `jsonb` | Original record as parsed (for debugging + Phase 4 re-derivation). |
| `created_at` | `timestamptz` | `defaultNow()` |

**Unique constraint** — per CLAUDE.md §Schema Invariants:

```sql
UNIQUE (account_id, fitid)
```

**Indexes**:

```sql
CREATE INDEX transactions_account_posted_at_idx ON transactions (account_id, posted_at DESC);
CREATE INDEX transactions_category_idx ON transactions (category) WHERE category IS NOT NULL;
```

The first index covers the per-account paginated list (the dominant read pattern); the second is a partial index for category filtering and aggregation.

### `import_batches` (one row per uploaded file)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `account_id` | `uuid` FK→accounts | |
| `source` | `text` | `'qfx' \| 'csv'` |
| `filename` | `text` | Original filename, sanitized (strip path components). |
| `uploaded_at` | `timestamptz` | `defaultNow()` |
| `status` | `text` | `'pending' \| 'previewed' \| 'confirmed' \| 'failed'`. Default `'pending'`. |
| `parsed_payload` | `jsonb` | Normalized rows (the importer's output) — read by the preview page and the confirm action. |
| `parser_metadata` | `jsonb` | Header info: institution, OFX version, currency, etc. For debugging. |
| `statement_start` | `date` | Nullable for CSV. From `<DTSTART>`. |
| `statement_end` | `date` | Nullable for CSV. From `<DTEND>`. |
| `statement_ending_balance` | `numeric(18,2)` | From `<LEDGERBAL>`. Nullable for CSV. **This is the reconciliation anchor.** |
| `inserted_count` | `integer` | Filled at confirm. Default 0. |
| `duplicate_count` | `integer` | Filled at preview. Default 0. |
| `invalid_count` | `integer` | Filled at preview. Default 0. |
| `error` | `text` | Nullable. Populated on `status='failed'`. |
| `confirmed_at` | `timestamptz` | Nullable. Set when status moves to `'confirmed'`. |

**Indexes**:

```sql
CREATE INDEX import_batches_account_uploaded_at_idx ON import_batches (account_id, uploaded_at DESC);
```

**Why store `parsed_payload` in the row instead of re-parsing on confirm**: the preview page sees exactly what the confirm action will write. There's no "the file changed between preview and confirm" race. Trade-off: a 5-year backfill might be a few MB of JSONB per batch. Acceptable at single-user scale; if it ever isn't, the parser is deterministic enough to re-parse from the original (we'd need to also store the file blob — Phase 4 may add this for audit).

### `category_rules` (regex → category)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `pattern` | `text` | JavaScript regex source (no flags here — flags column below). Validated at write time by attempting `new RegExp(pattern, flags)`. |
| `flags` | `text` | E.g. `'i'`. Default `'i'`. |
| `field` | `text` | `'name' \| 'memo'`. Default `'name'`. |
| `category` | `text` | Free text. |
| `priority` | `integer` | Lower = higher priority. Default 100. |
| `enabled` | `boolean` | Default `true`. |
| `created_at` / `updated_at` | `timestamptz` | |

**Index**:

```sql
CREATE INDEX category_rules_priority_idx ON category_rules (priority) WHERE enabled = true;
```

The matcher loads all enabled rules into memory once per import batch — at hundreds of rules it's negligible.

### No new enums

Keep `source` and `status` as plain `text` columns. They evolve more often than enum-suitable columns (Phase 4 adds `'plaid'` to `source`; we may add `'reverted'` to `status`); a Postgres enum-add migration is heavier than a `CHECK` constraint we can drop later. If they prove stable through Phase 5, promote then.

**CHECK constraints** at table-create time:

```sql
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IN ('qfx', 'csv', 'manual', 'plaid'));
ALTER TABLE import_batches ADD CONSTRAINT import_batches_status_check
  CHECK (status IN ('pending', 'previewed', 'confirmed', 'failed'));
ALTER TABLE import_batches ADD CONSTRAINT import_batches_source_check
  CHECK (source IN ('qfx', 'csv'));
ALTER TABLE category_rules ADD CONSTRAINT category_rules_field_check
  CHECK (field IN ('name', 'memo'));
```

---

## Phase 3 — Tasks

Each task is shippable in isolation, has explicit verification, and follows the conventions in CLAUDE.md.

### Schema + parsers (no UI yet)

- [ ] **P3-01** — Add `transactions` schema. Create [src/db/schema/transactions.ts](../../src/db/schema/transactions.ts) per the spec above (columns, FKs, unique on `(account_id, fitid)`, two indexes, CHECK on `source`). Add a `transactionsRelations` block. Re-export from [src/db/schema/index.ts](../../src/db/schema/index.ts). Run `pnpm db:generate` and review the SQL. → **Verify**: migration applies cleanly; `\d transactions` in psql shows the unique constraint and both indexes; `typeof transactions.$inferSelect` types as expected (try in a scratch file).
- [ ] **P3-02** — Add `import_batches` schema. Same drill. JSONB columns for `parsed_payload` and `parser_metadata`. CHECK constraints on `status` and `source`. Index on `(account_id, uploaded_at DESC)`. Re-export. Generate + review SQL. → **Verify**: psql `\d import_batches` matches the spec; inserting a row with `status='bogus'` is rejected by the CHECK.
- [ ] **P3-03** — Add `category_rules` schema. Generate + review SQL. → **Verify**: psql `\d category_rules` confirms partial index on `enabled = true`; inserting `field='other'` is rejected.
- [ ] **P3-04** — Apply all three migrations (`pnpm db:migrate`) and commit them as a single migration step. The migration file lands under `drizzle/0003_*.sql`. → **Verify**: `pnpm exec drizzle-kit check` passes; `psql` shows all three tables.
- [ ] **P3-05** — Add the QFX/OFX parser per ADR-006. Create [src/lib/importers/qfx/](../../src/lib/importers/qfx/) with:
  - `parse.ts` — exports `parseQfx(buffer: Buffer): ParsedQfx` and the `ParsedQfx` type.
  - `types.ts` — types: `ParsedQfx`, `ParsedQfxTransaction`, `ParsedQfxStatement`, `ParsedQfxBalance`.
  - `sgml.ts` — minimal SGML reader (tokenize → tag stack). Pure function, no I/O.
  - `xml.ts` — minimal OFX-2.x XML reader (use Node's built-in `DOMParser` polyfill via `linkedom` if needed, else regex-based for the handful of tags we read). **Decision at implementation time**: prefer regex-based if it handles the test fixtures; pull `linkedom` only if XML namespacing trips it up.
  - **All amounts in `ParsedQfxTransaction.amount` are `string`.** Same for the ending balance. Dates are ISO `YYYY-MM-DD` strings.
  - Throws `QfxParseError` with a precise location ("missing `<FITID>` in STMTTRN at offset 12345") on malformed input.
  → **Verify**: Vitest fixtures in [src/lib/importers/qfx/__fixtures__/](../../src/lib/importers/qfx/__fixtures__/): anonymized `mt-checking.qfx`, `mt-savings.qfx`, `chase-credit-card.qfx`, `amex.qfx` (real banks the user uses; anonymize account numbers + names). Tests cover: parse-roundtrip equality on amounts (no float drift), `<LEDGERBAL>` extraction, sign convention on credit-card debits, OFX 1.x SGML missing-close-tags tolerance, OFX 2.x XML, malformed-file rejection.
- [ ] **P3-06** — Add the CSV parser. Create [src/lib/importers/csv/parse.ts](../../src/lib/importers/csv/parse.ts) with:
  - `parseCsv(buffer: Buffer, mapping: CsvColumnMapping): ParsedCsv` — column mapping is `{ date: 'Posted Date', amount: 'Amount', name: 'Description', memo?: 'Memo' }`.
  - Use the standard-library-only approach: split on lines, handle quoted commas, no `papaparse` dep needed for these shapes. If quoting gets gnarly, add the smallest mature CSV reader (decision at impl time).
  - Synthetic `fitid` via SHA-256 of `${posted_at}|${amount}|${name}|${memo ?? ''}` — collision risk is essentially zero for honest data, and `(account_id, fitid)` UNIQUE forces it to be unique even if two real transactions happen to hash the same (the user gets an error pointing at the row and can edit the name/memo to disambiguate, or we extend the hash input).
  → **Verify**: Fixture CSVs for M&T and a generic credit card. Tests cover: dedup hash stable across re-parses, quoted-field handling, header-row detection, currency stripping (`$1,234.56` → `1234.56`), and `(date, amount, name)` collision → error.

### Importer orchestration + dedup

- [ ] **P3-07** — Define the importer normalizer. Create [src/lib/importers/normalize.ts](../../src/lib/importers/normalize.ts) exporting `NormalizedTransaction` (the shape that lands in the DB) and pure functions `qfxToNormalized(parsed, accountId)` and `csvToNormalized(parsed, accountId)`. The normalizer is the **single insertion point** to `transactions` — every source funnels through it. → **Verify**: unit tests confirm that the same QFX file produces identical normalized rows on repeat parse (determinism), and that signs are preserved end-to-end.
- [ ] **P3-08** — Implement the dedup + insert step. Create [src/lib/importers/persist.ts](../../src/lib/importers/persist.ts) with `persistImportBatch(batchId): Promise<PersistResult>`. It reads the batch's `parsed_payload`, runs the category rules engine, then INSERT ... ON CONFLICT (account_id, fitid) DO NOTHING for each row. Tracks `inserted_count` and `duplicate_count`. Wraps the insert + the batch-status update in a single Drizzle transaction. → **Verify**: integration test against a real Postgres container — first run inserts N rows, second run inserts 0 (returns N duplicates), partial-failure rolls back cleanly.
- [ ] **P3-09** — Implement reconciliation. Create [src/lib/importers/reconcile.ts](../../src/lib/importers/reconcile.ts) with `reconcile(batch, account): ReconciliationResult`. Computes: `(statement_ending_balance) - (sum of transactions in this batch + balance carried forward from the most-recent snapshot ≤ statement_start)`. Returns a `Money` diff and a status (`'ok' | 'mismatch' | 'no-anchor'`). **Anchors** to a snapshot row dated `statement_start - 1 day` if present; otherwise treats this as the first import and uses `statement_ending_balance - sum_of_txns_in_batch` as the implicit starting balance. → **Verify**: unit tests on three scenarios: clean import (`ok`), one transaction missing (`mismatch` with the right $ diff), no prior snapshot (`no-anchor` and we use the QFX ending balance as ground truth).
- [ ] **P3-10** — Write an authoritative snapshot per import. After a successful `persistImportBatch`, upsert into `account_snapshots` for `statement_end` (or each in-batch `posted_at` for richer history — decision below) with the running balance. **Decision**: write one row at `statement_end` per import (the most defensible number, matched to the bank's reckoning); also write one row per distinct `posted_at` in the batch using running-sum-from-anchor. Both via `ON CONFLICT (account_id, date) DO UPDATE` so manual entries get overwritten by import data (the import is more authoritative). → **Verify**: after importing a one-month QFX, `account_snapshots` has rows for every transaction date plus the statement-end row; `computeNetWorth(statement_end)` matches `statement_ending_balance` to the cent.
- [ ] **P3-11** — Implement the category rule engine. Create [src/lib/categorization/match.ts](../../src/lib/categorization/match.ts) with `matchCategory(name: string, memo: string | null, rules: CategoryRule[]): string | null`. Rules are sorted by `(priority, created_at)` and the first match wins. Compile each regex once via a cache keyed by `(pattern, flags)`. Validates pattern on insert via `new RegExp` (throws → reject). → **Verify**: unit tests on seed rules: `AMAZON.COM*PURCHASE` → `Shopping`, `STARBUCKS` → `Restaurant`, no-match → `null`. Test the cache by mutating a rule and confirming a fresh load picks up the change.
- [ ] **P3-12** — Seed default category rules. Create [src/lib/categorization/seed.ts](../../src/lib/categorization/seed.ts) exporting a `DEFAULT_RULES: NewCategoryRule[]` list of ~20 generic patterns (Amazon, Uber/Lyft, Starbucks, common utilities, common grocers — keep US-centric since the user is). Add a one-shot Vitest-driven seeder (no separate CLI; the seeder is a function called from the first-import path if `category_rules` is empty). → **Verify**: starting from an empty `category_rules`, the first import auto-seeds the defaults and uses them.

### Upload + preview + confirm UI

- [ ] **P3-13** — Build the upload component. Create [src/app/accounts/[id]/import/](../../src/app/accounts/%5Bid%5D/import/) with `page.tsx` (server component, gated by `requireUser()` and a check that account type is `depository` or `credit_card`) and `upload-form.tsx` (`'use client'` for the drag-and-drop + progress UI). Server action `uploadImportAction(accountId, formData)`:
  - Validates file extension (`.qfx` | `.ofx` | `.csv`) and size cap (default 10 MB; configurable in env).
  - Validates MIME type as a defense-in-depth check.
  - For files ≤ 1 MB: parse inline, write the batch row with `status='previewed'`, redirect to `/accounts/[id]/import/[batchId]/preview`.
  - For larger files: write the batch row with `status='pending'`, enqueue `process-qfx-import` BullMQ job, redirect to `/accounts/[id]/import/[batchId]` which polls until the parser finishes. (The user's typical 5-year backfill is small enough this rarely fires for QFX, but a CSV backlog can be big.)
  → **Verify**: in a browser, upload a real M&T QFX → land on the preview page with the right counts. Upload a file with `.exe` extension → rejected with a clear error.
- [ ] **P3-14** — Build the preview page. `[batchId]/preview/page.tsx` renders the parsed payload split into three sections: **New** (will insert), **Duplicates** (already present — show the existing transaction inline), **Invalid** (parser warnings). Top-of-page banner: reconciliation result (✅ Matches statement balance to the cent / ⚠️ $X off / ℹ️ No prior snapshot to anchor against). Bottom: "Confirm import of N transactions" button → invokes `confirmImportAction(batchId)`. → **Verify**: preview shows what's about to happen; the confirmed counts match.
- [ ] **P3-15** — Build the confirm action + post-import redirect. Server action `confirmImportAction(batchId)`:
  - Loads the batch, asserts `status='previewed'`.
  - Calls `persistImportBatch(batchId)` (P3-08).
  - Writes the post-import snapshot(s) (P3-10).
  - Updates batch row: `status='confirmed'`, `confirmed_at=now()`, `inserted_count`, `duplicate_count`.
  - `revalidatePath('/')` and `revalidatePath('/accounts/[id]', 'page')` and redirects to `/accounts/[id]?imported=N`.
  → **Verify**: end-to-end the flow above produces the right DB state in a single transaction; the dashboard updates without a hard refresh.
- [ ] **P3-16** — Extend the account detail page with a Transactions table. On [src/app/accounts/[id]/page.tsx](../../src/app/accounts/%5Bid%5D/page.tsx), for `depository`/`credit_card`/`investment` accounts, render a paginated table of `transactions`: date, payee, category (inline-editable), amount (sign-aware). Pagination via URL search params (`?page=2&pageSize=50`). Top-of-table CTA: "Import file". Bonus row at the top showing `(running balance)` if cheap to compute. → **Verify**: 1000 transactions paginate without N+1 queries; sorting/filtering work as advertised.
- [ ] **P3-17** — Inline category override. The category cell is a small dropdown sourced from `DISTINCT category FROM transactions` plus a "+ new" option. Changing it calls server action `setCategoryAction(transactionId, category)` which updates `category` and sets `category_overridden_at = now()`. → **Verify**: editing a cell persists; `category_overridden_at` is non-null; re-running rules over this txn doesn't change its category.
- [ ] **P3-18** — Reconciliation banner on the account page. Always render: "Latest imported balance: $X.XX as of YYYY-MM-DD. Computed from transactions: $Y.YY. Drift: $Z.ZZ." If drift > $0.005 (i.e. real cents, not rounding), color the banner amber and link to the relevant batch. → **Verify**: introduce a deliberate drift (manually `DELETE` a transaction row) and the banner flips amber with the right delta.

### Category-rules settings page

- [ ] **P3-19** — Build `/settings/categories` page. Table of rules (pattern, flags, field, category, priority, enabled, actions). New-rule form at the bottom. Validation: invalid regex → server action returns `{ error: 'Bad regex: ...' }` (test pattern via `new RegExp`). → **Verify**: add a `/COSTCO/i → Groceries` rule; subsequent imports route Costco to Groceries; broken regex submission rejected with a useful error.
- [ ] **P3-20** — "Re-categorize existing transactions" button. Server action `recategorizeAllAction()` enqueues a BullMQ job (or runs inline if total rows < 10k) that re-evaluates rules over all non-overridden transactions. Updates `category` in batches of 500. → **Verify**: add a rule, click the button, table reflects new categories; `category_overridden_at` rows are untouched.
- [ ] **P3-21** — Optional: "test rule against existing transactions" panel. Shows up to 20 sample matches as the user types the regex. Pure read; debounced 300ms. → **Verify**: typing `STARBUCKS` shows the matching transactions; typing `(invalid` shows no crash, just empty.

### Background job for big imports

- [ ] **P3-22** — Add the `process-qfx-import` queue. In [src/lib/queue/queues.ts](../../src/lib/queue/queues.ts), uncomment the `PROCESS_QFX_IMPORT` queue name and export the `processQfxImportQueue`. Update `QUEUE_NAMES` description to clarify it covers both QFX and CSV. → **Verify**: `pnpm worker` registers the new queue at startup without error.
- [ ] **P3-23** — Implement the worker job. Create [src/worker/jobs/process-qfx-import.ts](../../src/worker/jobs/process-qfx-import.ts):
  - Job payload: `{ batchId: string }`.
  - Loads the batch (status must be `'pending'`), reads the uploaded file buffer (decision below on storage).
  - Calls the appropriate parser, writes `parsed_payload` and `parser_metadata`, moves status to `'previewed'`.
  - On parser error: sets `status='failed'`, populates `error`.
  - Per CLAUDE.md §Background Jobs: idempotent on `batchId` — re-running on an already-`'previewed'` batch is a no-op return; same on `'confirmed'`. Retries with exponential backoff via the queue defaults.
  - **File storage decision**: keep the uploaded bytes in a `raw_file` `bytea` column on `import_batches` (added to schema in P3-02 — adjust before migration), since they're typically <100 KB for QFX and <few MB for a 5-year CSV. Postgres handles `bytea` up to ~1 GB; we're nowhere near. Avoids needing a filesystem mount for the import path.
  → **Verify**: enqueue a job manually via `pnpm worker:once process-qfx-import`; status transitions through `pending → previewed`; re-running on a `confirmed` batch is a no-op; throwing inside the parser surfaces in BullMQ retries and finally lands in `failed`.
- [ ] **P3-24** — Job progress in the UI. The `[batchId]` polling page (P3-13) checks `status` every 2s. When `'previewed'`, redirects to the preview page; on `'failed'`, shows the error and a "delete batch" button. → **Verify**: a deliberately-malformed file shows the failure path with the right error message.

### Tests + E2E

- [ ] **P3-25** — Vitest unit tests at every layer (already partially covered by P3-05/06/07/08/09/11). Add the gaps: importer end-to-end test (real fixture in → real Postgres rows out → reconciliation diff = $0.00), and an idempotency test (run import → run again with same file → 0 new inserts, 0 changes to existing rows). → **Verify**: `pnpm test` covers all importer modules with meaningful (not vacuous) assertions.
- [ ] **P3-26** — Playwright E2E: `e2e/phase3.spec.ts`. Flow: login → open the M&T checking account page → click "Import file" → drop the fixture QFX → preview page renders with N new / 0 dupes / reconcile OK → click "Confirm" → land back on account page → transactions table shows N rows → dashboard net-worth value updates to match the QFX `<LEDGERBAL>`. → **Verify**: `pnpm exec playwright test e2e/phase3.spec.ts` is green against a freshly-reset DB.
- [ ] **P3-27** — Playwright E2E: idempotent re-import. Same fixture imported twice in a row → second preview shows 0 new, N duplicates, "Confirm" disabled. → **Verify**: passes.

### Hardening

- [ ] **P3-28** — File-upload security pass. Per SKILLS.md Tier 3 → `frontend-security-coder` and `backend-security-coder`. Checklist:
  - File size cap enforced server-side (the client check is UX only).
  - File extension cap enforced server-side AND a magic-byte sniff (`.qfx` starts with `OFXHEADER:` or `<?xml`).
  - Filename sanitized before storing (strip path separators, normalize unicode).
  - `parsed_payload` rendered in the preview page is JSX-escaped (Next handles this by default — verify nothing uses `dangerouslySetInnerHTML`).
  - Category override + rule editor: regex from user input is fed only to `new RegExp` (no `eval`-shaped surface).
  - The settings page rate-limits the "test rule" preview to once per second per session to bound the regex-DOS risk on a pathological pattern (single-user app, but cheap insurance).
  → **Verify**: try to upload a 100 MB file → rejected with 413 / clear error; upload a `.exe` renamed to `.qfx` → rejected by the magic-byte check; paste `((((((((((((((((` as a rule pattern → rejected at validation, not at match time.
- [ ] **P3-29** — Backup-impact note in `docs/RESTORE.md`. The `import_batches.raw_file` column makes pg_dump bigger. Document the typical sizes and that restoring an `import_batches` row is enough to re-derive the transactions (drop and re-run the worker). No code change. → **Verify**: file updated.
- [ ] **P3-30** — README + project docs. Update [README.md](../../README.md) §Usage with: "Monthly ritual: log into bank → download QFX → drop on account page → confirm." Add `docs/IMPORT.md` (small) with the column-mapping reference for CSV and a troubleshooting section ("reconciliation mismatch — what to do"). → **Verify**: a fresh reader can follow the docs and import without asking.

---

## Phase 3 Done When

- [ ] All three new tables exist (`transactions`, `import_batches`, `category_rules`) with the constraints in the spec
- [ ] `pnpm test` (Vitest) covers QFX parser, CSV parser, dedup, reconciliation, and rule engine with meaningful assertions
- [ ] `pnpm exec playwright test e2e/phase3.spec.ts` and `e2e/phase3-reimport.spec.ts` green
- [ ] Real anonymized fixtures from the user's actual institutions (M&T, the user's credit card) live in `src/lib/importers/qfx/__fixtures__/`
- [ ] Uploading a QFX in the browser produces a preview page; confirm imports the rows; dashboard reflects the new balance
- [ ] Re-importing the same file is a no-op (0 inserts, 0 duplicates-into-the-DB)
- [ ] Backfill works: a multi-year statement batch goes through the BullMQ job path (verified by uploading a >1 MB CSV fixture and watching status `pending → previewed → confirmed`)
- [ ] Category rules table has ~20 seeded defaults; first import auto-categorizes the obvious payees
- [ ] Reconciliation banner on the account page shows a $0.00 drift after a clean import and the right delta after a manually-deleted transaction
- [ ] `pnpm check` clean (Biome + tsc)
- [ ] ADR-006 and ADR-007 appended to [IDEAS.md](IDEAS.md) §11 Decision Log

---

## Skills Map (per task cluster)

Per [SKILLS.md](SKILLS.md) §Suggested Workflow → Phase 3. Don't load them all upfront; invoke when the cluster opens.

| Task cluster | Primary skill(s) |
|---|---|
| P3-01 → P3-04 (schema + migration) | `drizzle-orm-expert`, `postgres-best-practices` |
| P3-05 → P3-07 (QFX/CSV parsers + normalizer) | `test-driven-development`, `typescript-pro`, `zod-validation-expert` |
| P3-08 → P3-10 (persist + reconcile + snapshot upsert) | `test-driven-development`, `postgres-best-practices`, `drizzle-orm-expert` |
| P3-11 → P3-12 (category rule engine + seeds) | `typescript-pro`, `test-driven-development` |
| P3-13 → P3-18 (upload, preview, confirm, txns table, banner) | `nextjs-app-router-patterns`, `tailwind-patterns`, `zod-validation-expert`, `frontend-security-coder` |
| P3-19 → P3-21 (categories settings) | `nextjs-app-router-patterns`, `react-hook-form` (only if forms get gnarly) |
| P3-22 → P3-24 (BullMQ job) | `bullmq-specialist` |
| P3-25 → P3-27 (Vitest + Playwright) | `e2e-testing-patterns`, `test-driven-development` |
| P3-28 (security pass) | `frontend-security-coder`, `backend-security-coder` |

---

## Open Items (out of scope for this plan)

- **Plaid push (Phase 4)** — will write to the same `transactions` table with `source='plaid'`, using Plaid's `transaction_id` as `fitid` (Plaid IDs are already globally unique per item). The reconciliation banner and category rule engine carry over unchanged.
- **Transfer detection** — recognizing that "M&T checking → credit card payment" is a transfer, not two unrelated transactions. Phase 5 or later.
- **Tag/split transactions** — splitting one transaction across multiple categories. Out of scope (CLAUDE.md §Domain Scope flags GL accounting as out).
- **Search/filter UI for transactions** — beyond simple pagination, defer to Phase 5 once we have enough rows to make it worth the design effort.
- **Import-history page (`/settings/imports`)** — listing all `import_batches` across all accounts with status + counts. Light Phase 3 stretch goal if time permits; otherwise Phase 6 polish.

---

*End of PLAN3.md*
