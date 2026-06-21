# PLAN — Phase 10 (Personal High-Value Assets: user-valued, tracked over time, with proof documents)

> Phases 1–9 built net worth from *financial* accounts (cash, credit, brokerage, IRA, mortgage) plus a single `property` type for the home. Round 4 ([IDEAS2.md](IDEAS2.md)) asks for the missing slice of net worth: **"A user should be able to create an asset that has value that they can change over time and track over time"** — vehicles, boats, jewelry, art/collectibles — that **counts toward net worth**, whose value the **user adjusts over time**, and to which the user can **attach a file as proof of authenticity**.
>
> The good news is that this is overwhelmingly *additive and reuses machinery we already have*. [computeNetWorth](../../src/lib/net-worth/compute.ts) already routes every non-loan account through a "most-recent `account_snapshots` row on or before `asOf`" lookup, and the existing **`property`** account type already implements exactly "a value the user records and adjusts over time" via [recordPropertyValueAction](../../src/app/accounts/[id]/actions.ts) writing to `account_snapshots`. A high-value asset is mechanically a `property`-shaped account with a category and optional proof documents. So Phase 10 introduces a new **`personal_asset` account type** (decision confirmed with the owner) and gets net-worth inclusion, the historical net-worth series, the snapshot-history UI, close/reopen/delete, and the dashboard chart **for free** — `compute.ts` and `netWorthSeries` need **zero changes**.
>
> Phase 10 closes the round in five moves: (1) **schema** — add the `personal_asset` account type, four nullable asset columns on `accounts` (category, description, acquired date, acquisition cost), and a new `asset_documents` table; (2) **asset lifecycle** — a create flow, a value-recording action (mirroring property), and queries; (3) **proof documents** — a hardened upload (size-cap + MIME whitelist + magic-byte sniff, reusing the import precedent), a secure download route, and delete; (4) **UI** — the asset entry forms, the asset detail panels (acquisition + simple gain/loss, value history, documents), a small value-over-time chart, and the accounts-list/labels; (5) **tests, docs, security/privacy pass, E2E**.
>
> **Hard boundary (CLAUDE.md §Domain Scope) — read before writing code.** This stays a *read-only personal tracker*. Phase 10 does **NOT** add: automated asset valuation (no KBB/Edmunds/auction-price API — that would both egress asset data and pull in a SaaS dependency), depreciation schedules, insurance/warranty management, OCR/parsing of the proof documents, document e-signing, or linking an asset to its financing loan. Value is **manually entered by the user**, full stop. Acquisition-cost vs. current-value is a **simple display gain/loss** (the same shape as the holdings gain/loss already shipped), never a tax or cap-gains figure. Any of those crossing-the-line features needs a FEATURE.md decision update first (P10-00 records the scope note).
>
> **Privacy (CLAUDE.md §Privacy & Data Sovereignty) — binding and, this phase, trivially satisfied.** Personal assets and their proof documents are **100% local**: manual value entry, no outbound fetch of any kind, file bytes stored in our own Postgres and captured by the existing `pg_dump` backup. **Nothing about an asset ever leaves the host.** Proof documents are the most sensitive new data class in the app (photos of jewelry, vehicle titles, appraisals); they are served only through an authenticated, attachment-only download route and never to a CDN. P10-00 + the Batch 5 privacy pass make this explicit.
>
> **Companion docs** — read for context, do not duplicate:
> - [PLAN9.md](PLAN9.md) — the **template for this phase's structure** (batch/ADR/scope-gate discipline, additive-schema posture, "what already exists" inventory, text+CHECK vs pgEnum reasoning).
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Money & Numeric Precision (asset value + acquisition cost are `NUMERIC(18,2)`; all arithmetic through `Money`/`decimal.js`; `Number()` only at the display edge), §Domain Scope (boundary above), §Privacy (boundary above), §Database & Drizzle Specifics ("Never `drop column` … without a paired backup"; `numeric` everywhere; `bytea` via the existing `customType`; one file per concept; UUID PKs), §Importers / file-upload security posture, §Testing Philosophy (value-snapshot idempotency + file-validation pure functions are "always-test" surfaces), §Backup Discipline (bytea rides the nightly encrypted `pg_dump`).
> - [IDEAS.md](IDEAS.md) §11 Decision Log (current max **ADR-022**; Phase 10 appends **ADR-023 → ADR-024**), and the existing `property`-type valuation pattern this generalizes.
> - [SKILLS.md](SKILLS.md) §Suggested Workflow — see §Skills Map below.

---

## What already exists (do not rebuild — extend these)

Phase 10 is almost entirely *reuse*. Inventory before writing code:

- **Account model + net worth**: [accounts.ts](../../src/db/schema/accounts.ts) (already carries *nullable, additive* columns — the Plaid trio — so adding nullable asset columns follows an established precedent), [accountTypeEnum](../../src/db/schema/enums.ts) (a `pgEnum` — `personal_asset` is a one-line `ADD VALUE`), [account_snapshots](../../src/db/schema/snapshots.ts) (the value-over-time store; PK `(account_id, date)`).
- **Net-worth compute — NO CHANGES NEEDED**: [computeNetWorth](../../src/lib/net-worth/compute.ts) handles every non-loan, non-`investment`/`crypto_ira` account through the "latest snapshot ≤ asOf" branch. A `personal_asset` account falls straight into it, including the existing rule that a pure-manual account with no snapshot is hidden until its first value is recorded. [netWorthSeries](../../src/lib/net-worth/compute.ts) keys off distinct `account_snapshots` dates, so the dashboard chart picks up assets automatically once valued.
- **Value-over-time precedent**: [recordPropertyValueAction](../../src/app/accounts/[id]/actions.ts) + [recordPropertyValueSchema](../../src/lib/schemas/account.ts) + [property-form.tsx](../../src/app/accounts/[id]/property-form.tsx) — exactly the "record/adjust a value on a date, UPSERT on `(account_id, date)`" flow Phase 10 reuses for asset valuations. The snapshot-history table at the bottom of [the account detail page](../../src/app/accounts/[id]/page.tsx) already renders that history.
- **File-upload security posture (the precedent for documents)**: [import-batches.ts](../../src/db/schema/import-batches.ts) stores uploaded bytes as Postgres **`bytea` via a `customType`** (so backup/restore re-derives everything from one `pg_dump`), and [upload-security.ts](../../src/lib/importers/upload-security.ts) does **size cap (env-overridable) + filename sanitization + magic-byte sniffing**. Phase 10's `asset_documents` reuses the `bytea` type (extract it to a shared module) and the upload-security helpers (extend with an image/PDF detector).
- **Account lifecycle UI**: [new-account-form.tsx](../../src/app/accounts/new/new-account-form.tsx) + [createAccountAction](../../src/app/accounts/new/actions.ts) (extended for the asset fields), [account detail page](../../src/app/accounts/[id]/page.tsx) (the conditional-by-type section layout Phase 10 adds an asset branch to), [account-admin.tsx](../../src/app/accounts/[id]/account-admin.tsx) (close/reopen/delete — works unchanged; FK cascade already covers child rows), [accounts list](../../src/app/accounts/page.tsx) (`TYPE_LABEL` map needs one entry).
- **Validation + money**: [account schemas](../../src/lib/schemas/account.ts) (`moneyAmountSchema`, `isoDateSchema` reused), [Money](../../src/lib/money/money.ts) + `decimal.js` (gain/loss via the existing [gainLoss](../../src/lib/investments/gain-loss.ts) helper).
- **Chart island pattern (ADR-005)**: [net-worth-chart.tsx](../../src/app/net-worth-chart.tsx) — `"use client"`, `ResponsiveContainer`, `Intl.NumberFormat`, `Number(value)` only at the display edge, dark-mode `currentColor`. The asset value-over-time chart copies this exactly.

---

## ADRs locked at plan time

Two decisions surface in Phase 10. Both are 🔲 **Proposed** — append to [IDEAS.md](IDEAS.md) §11 Decision Log (next free numbers **ADR-023 → ADR-024**; verified ADR-022 is current max) after this plan is approved (P10-00).

---

### ADR-023 — Personal high-value assets as a `personal_asset` account type (reuse the snapshot/net-worth machinery)

**Status**: 🔲 Proposed

**Context**: Round 4 wants user-valued, value-over-time assets (vehicles, boats, jewelry, collectibles) that count toward net worth. The app already has a `property` type that does precisely "a value the user records and adjusts over time" via `account_snapshots`, and `computeNetWorth` already aggregates every snapshot-based account uniformly. The question is *where* assets live in the data model: a new account type, or a separate first-class `assets` table.

**Decision**:
1. **New account type `personal_asset`** added to `accountTypeEnum` (one `ALTER TYPE … ADD VALUE`). Assets are accounts; they reuse `account_snapshots` for value-over-time, `computeNetWorth`/`netWorthSeries` for net-worth inclusion and the historical chart, and the existing close/reopen/delete lifecycle (FK cascade already covers child rows).
2. **Four nullable, additive columns on `accounts`** (mirrors the existing nullable Plaid-column precedent — non-asset rows leave them NULL):
   - `asset_category text` — CHECK constrains to `'vehicle' | 'watercraft' | 'jewelry' | 'collectible' | 'other'` (NULL allowed for non-asset accounts). **`text`+CHECK, not a `pgEnum`** — same posture as Phase 9's `asset_type` (ADR-020): categories may grow; dropping/extending a CHECK is lighter than an enum-add migration.
   - `description text` — free-text notes / make-model-year (the "modest set", confirmed with owner). Not parsed, display-only.
   - `acquired_at date` (`mode: 'string'`) — acquisition date (nullable; unknown for inherited items).
   - `acquisition_cost numeric(18,2)` — what the user paid (nullable). Drives a **simple display gain/loss** (`latest value − acquisition_cost`) via the existing `gainLoss` helper — *not* a tax figure.
3. **Value entry reuses the property pattern**: a `recordAssetValueAction` (sibling to `recordPropertyValueAction`, gated to `type === 'personal_asset'`) UPSERTs `account_snapshots` on `(account_id, date)`. Same `recordPropertyValueSchema` shape (`date` + `value`). No new valuation table.
4. **`institution` is set server-side for assets.** `accounts.institution` is `NOT NULL`; an asset has no institution, so the asset create flow does **not** surface that field and the server action defaults it to the literal `"Personal asset"`. The asset detail header shows the **category** in the slot where financial accounts show institution. (Keeps `institution` `NOT NULL` — making it nullable would ripple across the app for no benefit.)
5. **No automated valuation, ever.** Value is manual. We do **not** call any vehicle/auction/appraisal pricing API — it would egress asset data and add a SaaS dependency (CLAUDE.md §Privacy + §Domain Scope).

**Consequences**:
- ✅ Net worth, the historical net-worth series, the dashboard chart, snapshot-history UI, and account lifecycle all work with **zero changes** to `compute.ts`/`netWorthSeries`.
- ✅ Schema change is minimal and entirely additive — one enum value, four nullable columns, one CHECK.
- ✅ The "hide a manual account with no snapshot" rule means a freshly-created asset stays off the dashboard until its first value is recorded — correct behavior, free.
- ⚠️ Assets share the `/accounts` surface rather than getting a bespoke "Assets" section. Acceptable for a single-user app; a dedicated nav grouping is a later cosmetic add if it earns it (Open Item).
- ⚠️ `institution = "Personal asset"` is a sentinel; the accounts-list and detail UIs special-case `personal_asset` to show the category instead. Documented in P10-09/P10-10.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Dedicated `assets` + `asset_valuations` tables | Would force changes to `computeNetWorth`/`netWorthSeries`, a parallel snapshot machinery, and a whole new list/detail/chart UI — significantly more code and risk for no functional gain over reusing accounts. (Owner confirmed reuse.) |
| Reuse the existing `property` type with a sub-category | Semantically "property" = real estate; overloading it for jewelry muddies labels and the home-specific copy ("Zillow/Redfin/county assessor"). A distinct type keeps each flow's UX honest. |
| Model an asset as a `holding` (`asset_class = 'property'`) inside an investment account | Holdings are priced by symbol×quantity and live under investment/crypto accounts; a one-off vehicle has no symbol and no quantity. Wrong abstraction. |
| Auto-depreciate vehicles on a schedule | Speculative and out of scope; the owner asked for *user-adjustable* value. Manual only. |

---

### ADR-024 — Proof-of-authenticity documents stored as Postgres `bytea`, hardened upload + attachment-only download

**Status**: 🔲 Proposed

**Context**: Round 4: "A user should be able to upload a file associated with the asset for proof of authenticity." This is the app's first user-facing *document* store (the existing `import_batches.rawFile` bytea is an internal re-parse cache, never served back to the browser). Proof documents (titles, appraisals, receipts, photos) are the **most sensitive new data class** in the app, so storage and serving both need a decision.

**Decision**:
1. **New `asset_documents` table** storing file **bytes as Postgres `bytea`** (reusing the `customType` from `import-batches.ts`, extracted to a shared `src/db/schema/_bytea.ts`). Columns: `id uuid pk`, `account_id uuid` FK → accounts `onDelete: cascade` (documents die with the asset), `filename text` (sanitized), `mime_type text`, `size_bytes integer`, `bytes bytea`, `description text` (optional label, e.g. "2024 appraisal"), `uploaded_at timestamptz default now()`. Index `(account_id, uploaded_at desc)`.
2. **`bytea` over filesystem** (confirmed with owner): keeps the **single-backup property** — the nightly `age`-encrypted `pg_dump` (CLAUDE.md §Backup Discipline) captures documents with everything else; restore re-derives them with no separate mount to back up. Filesystem storage would require a parallel backup story + a RESTORE.md change. Trade-off accepted: modest DB/dump growth, bounded by the size cap.
3. **Hardened upload** reuses [upload-security.ts](../../src/lib/importers/upload-security.ts) (`checkSize`, `sanitizeFilename`) and **extends it with a document detector**: a **MIME whitelist** (`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf`) enforced by **magic-byte sniffing** (`%PDF`, JPEG `FF D8 FF`, PNG `89 50 4E 47`, RIFF/WEBP, HEIC `ftyp`), not by extension or the client-supplied `Content-Type`. Size cap reuses `IMPORT_MAX_FILE_BYTES` semantics via a dedicated `ASSET_DOC_MAX_FILE_BYTES` (default 10 MB).
4. **Attachment-only, authenticated download route** `GET /accounts/[id]/documents/[docId]` — `requireUser`-gated, scoped to the account, streams bytes with `Content-Disposition: attachment; filename="<sanitized>"` and the stored `mime_type`, plus `X-Content-Type-Options: nosniff`. **Never inline** (defends against stored-XSS via a crafted SVG/HTML masquerading as an image — and SVG is *not* in the whitelist for that reason). No CDN, no public URL.
5. **Optional, capped, deletable**: upload is never required to create or value an asset (answering the owner's "you think that is too much?" — it's optional and low-cost). Multiple documents per asset allowed; each deletable via `deleteAssetDocumentAction`.

**Consequences**:
- ✅ One backup covers documents; restore is unchanged.
- ✅ Reuses the vetted upload-security posture; the only new surface is the image/PDF magic-byte detector and the download route — both small, both tested.
- ✅ Attachment-only + `nosniff` + SVG-excluded neutralizes the classic "upload an HTML/SVG, serve it same-origin" stored-XSS path.
- ⚠️ Large image-heavy libraries bloat the DB and every dump. Mitigated by the 10 MB cap and single-user scale (a handful of assets × a few docs). If it ever becomes a problem, a filesystem migration is a documented future option (Open Item).
- ⚠️ `bytea` round-trips through the Node driver as a Buffer; large reads load fully into memory. Fine at the 10 MB cap; noted so no one streams a 1 GB file through it later.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Filesystem volume (`/data/attachments`) + path in DB | Breaks the single-`pg_dump` backup; needs a separate encrypted backup of the mount + RESTORE.md changes. Owner chose bytea. |
| Object storage (S3/B2/MinIO) | A SaaS/extra-service dependency for one user's handful of documents; financial/personal data to a third party violates §Privacy unless self-hosted, and MinIO is more infra than this warrants. |
| Serve documents inline / allow SVG | Inline same-origin user-uploaded markup is a stored-XSS vector; attachment-only + whitelist (no SVG) closes it. |
| Trust client `Content-Type` / file extension | Trivially spoofable; magic-byte sniff is the only honest check (same reasoning as the existing QFX/CSV detector). |

---

## Phase 10 — Schema (one enum value + four nullable `accounts` columns + one new table)

All follow CLAUDE.md §Database & Drizzle Specifics: UUID PKs, `numeric` for money (never float), `date(mode:'string')` for dates, `timestamp({ withTimezone:true })`, `bytea` via `customType`, one file per concept under [src/db/schema/](../../src/db/schema/), re-exported from [index.ts](../../src/db/schema/index.ts). **No column dropped; no destructive change.**

```text
src/db/schema/
├── enums.ts            (UPDATED: accountTypeEnum += 'personal_asset')
├── accounts.ts         (UPDATED: asset_category, description, acquired_at, acquisition_cost
│                                  + asset_category CHECK; + assetDocuments relation)
├── _bytea.ts           (NEW: shared bytea customType, extracted from import-batches.ts)
├── import-batches.ts   (UPDATED: import the shared bytea instead of the inline copy)
├── asset-documents.ts  (NEW: proof-of-authenticity files)
└── index.ts            (UPDATED: re-export asset-documents)
```

### `accounts` extensions (UPDATED — all nullable, additive)

| Column | Type | Notes |
|---|---|---|
| `asset_category` | `text` | CHECK `IN ('vehicle','watercraft','jewelry','collectible','other')` OR NULL. NULL for non-asset accounts. |
| `description` | `text` | Free-text notes / make-model-year. Display-only, not parsed. |
| `acquired_at` | `date` (`mode:'string'`) | Acquisition date. Nullable. |
| `acquisition_cost` | `numeric(18,2)` | Purchase price. Nullable. Drives simple display gain/loss. |

### `asset_documents` (NEW — proof-of-authenticity files)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK default random | |
| `account_id` | `uuid` FK → accounts `onDelete: cascade` NOT NULL | Documents die with the asset. |
| `filename` | `text` NOT NULL | Sanitized at upload (`sanitizeFilename`). |
| `mime_type` | `text` NOT NULL | From the magic-byte detector, **not** the client header. |
| `size_bytes` | `integer` NOT NULL | For display + a defense-in-depth re-check. |
| `bytes` | `bytea` NOT NULL | File content. |
| `description` | `text` | Optional label (e.g. "Title", "2024 appraisal"). |
| `uploaded_at` | `timestamptz` NOT NULL default now() | |

**Index**: `asset_documents_account_uploaded_at_idx ON (account_id, uploaded_at DESC)` — list a single asset's docs newest-first.

### Migration (one Drizzle migration, `drizzle-kit generate` → `migrate`)

1. `ALTER TYPE account_type ADD VALUE 'personal_asset';` — **note:** a new enum value cannot be *used* in the same transaction it's added in (Postgres). drizzle-kit emits this as its own statement; the columns/table below don't reference the value, so a single migration is fine. (If `drizzle-kit` complains, split the `ADD VALUE` into its own migration file ahead of the rest.)
2. `ALTER TABLE accounts ADD COLUMN …` ×4 (all nullable) + the `asset_category` CHECK.
3. `CREATE TABLE asset_documents` (+ FK, + the `(account_id, uploaded_at desc)` index).

Take a `pg_dump` (existing backup job, [docs/BACKUP.md](../../docs/BACKUP.md)) before applying, per §Database (we touch `accounts`).

---

## Task breakdown

> Batches are dependency-ordered: **0 → 1 → {2, 3} → 4 → 5**. Batch 1 (schema) gates everything. Batch 2 (asset lifecycle/value) and Batch 3 (documents) are independent and can run in parallel. Batch 4 (UI) needs 2 + 3. Task IDs follow `P10-xx`. Invoke the cited skill at the start of each batch (§Skills Map). Always-test surfaces (value-snapshot idempotency, file-validation pure functions) get Vitest without asking (CLAUDE.md §Testing Philosophy).

### Batch 0 — Scope gate + ADRs (docs only, no code)

**P10-00 — Record scope + privacy notes; append ADRs.** Append **ADR-023 → ADR-024** to [IDEAS.md](IDEAS.md) §11 Decision Log (verified next free numbers after ADR-022): `personal_asset` account type reusing the snapshot/net-worth machinery, and `bytea`-stored proof documents with a hardened upload + attachment-only download. Add a 2026-06-20 scope note to [FEATURE.md](FEATURE.md) §Scope: Phase 10 adds **user-valued personal assets (manual value over time, counting toward net worth) + optional proof documents**, **reaffirming** that automated valuation, depreciation, document OCR/parsing, insurance/warranty tracking, and asset↔loan linking stay **out of scope**, the acquisition-cost gain/loss is a labeled *display* figure, and **no asset data egresses the host**. *Skill: `architecture-decision-records`.* No deploy.

### Batch 1 — Schema + migration

*Skills: `drizzle-orm-expert`, `postgres-best-practices`, `typescript-pro`.*

**P10-01 — Add the `personal_asset` enum value + asset columns on `accounts`.** Extend [enums.ts](../../src/db/schema/enums.ts) `accountTypeEnum` with `'personal_asset'` (+ update the doc comment's discriminated-behavior list). Add the four nullable columns + `asset_category` CHECK to [accounts.ts](../../src/db/schema/accounts.ts). Update the `Account` type comment. → **Verify**: `tsc --noEmit` clean; `Account.$inferSelect` exposes the new fields as nullable.

**P10-02 — Extract shared `bytea` + create `asset_documents` schema.** Create [src/db/schema/_bytea.ts](../../src/db/schema/_bytea.ts) with the `customType` lifted verbatim from [import-batches.ts](../../src/db/schema/import-batches.ts); update import-batches to import it (no behavior change). Create [src/db/schema/asset-documents.ts](../../src/db/schema/asset-documents.ts) per spec (FK `onDelete: cascade`, the `(account_id, uploaded_at desc)` index, `AssetDocument`/`NewAssetDocument` exports), re-export from [index.ts](../../src/db/schema/index.ts), and add the `assetDocuments: many(...)` relation on [accounts.ts](../../src/db/schema/accounts.ts). → **Verify**: `tsc` clean; the shared bytea round-trips a Buffer in a quick unit check.

**P10-03 — Generate + apply the migration.** `pnpm db:generate` → review the SQL (enum `ADD VALUE`, 4 `ADD COLUMN`, CHECK, `CREATE TABLE` + index) → `pnpm db:migrate`. If drizzle-kit emits the `ADD VALUE` in the same transaction as a usage, split it (see Migration note). → **Verify**: migration file present + applied; `\d accounts` shows the new columns + CHECK; `\d asset_documents` shows the FK + index; existing rows unaffected (all new columns NULL).

### Batch 2 — Asset lifecycle + valuation

*Skills: `zod-validation-expert`, `nextjs-app-router-patterns`, `typescript-pro`.*

**P10-04 — Asset create schema + action.** Add `createAssetSchema` to [schemas/account.ts](../../src/lib/schemas/account.ts): `name` (required), `assetCategory` (enum of the 5 values), `description` (optional), `acquiredAt` (optional `isoDateSchema`), `acquisitionCost` (optional `moneyAmountSchema`), `currency` (default USD), and an optional `initialValue` + `initialValueDate` so the asset can be born with a value (and therefore appear in net worth immediately). Add `createAssetAction` (or branch `createAccountAction`) that inserts an `accounts` row with `type='personal_asset'`, `institution='Personal asset'`, the asset columns, and — when `initialValue` is given — an `account_snapshots` row. *Server-side `institution` default per ADR-023.* → **Verify**: Vitest on the schema (valid/invalid category, optional fields, money/date formats); action creates the row + optional snapshot.

**P10-05 — Asset value-recording action.** Add `recordAssetValueAction` to [accounts/[id]/actions.ts](../../src/app/accounts/[id]/actions.ts), gated to `type === 'personal_asset'`, UPSERTing `account_snapshots` on `(account_id, date)` (reuse `recordPropertyValueSchema`). Revalidate `/accounts/[id]`, `/accounts`, `/`. → **Verify**: Vitest — first call inserts, second on the same date overwrites (idempotent), wrong account type rejected.

**P10-06 — Asset edit action (metadata).** Extend the account-edit path so an asset's `description`, `asset_category`, `acquired_at`, `acquisition_cost` are editable (name already is). Reuse the existing `accountHasData` guard only for `type`/`currency` (unchanged); asset metadata is always editable. → **Verify**: Vitest — metadata update persists; `type` still locked once data exists.

**P10-07 — Asset queries + net-worth confirmation.** Add `getAssetDocuments(accountId)` and any asset-detail helpers to [lib/accounts/queries.ts](../../src/lib/accounts/queries.ts). **Confirm (do not modify)** that `computeNetWorth`/`netWorthSeries` include a valued `personal_asset` and exclude an unvalued one. → **Verify**: integration test against the test DB — create asset, record value, assert it appears in `computeNetWorth().items` with the right balance and in the total; unvalued asset absent.

### Batch 3 — Proof-of-authenticity documents

*Skills: `frontend-security-coder`, `backend-security-coder`, `zod-validation-expert`.*

**P10-08 — Document detector (magic-byte + MIME whitelist).** Extend [upload-security.ts](../../src/lib/importers/upload-security.ts) (or a sibling `asset-doc-security.ts`) with `detectDocumentType(filename, buf): { mime } | null` — magic-byte sniff for PDF/JPEG/PNG/WEBP/HEIC against the whitelist, returning the canonical MIME or null (reject), plus `assetDocMaxBytes()` (env `ASSET_DOC_MAX_FILE_BYTES`, default 10 MB). **SVG deliberately excluded.** → **Verify**: Vitest — each accepted type's magic bytes pass; spoofed extension with wrong bytes rejected; SVG/HTML rejected; oversize rejected; filename sanitized. *(High-TDD pure-function surface.)*

**P10-09 — Upload + delete actions.** Add `uploadAssetDocumentAction(accountId, formData)` to the account actions: `requireUser`, account-scope + `type==='personal_asset'` check, `checkSize` → `detectDocumentType` → `sanitizeFilename`, insert `asset_documents` (bytes, detected mime, size, optional description). Add `deleteAssetDocumentAction(accountId, docId)` (UUID-validated, account-scoped delete). Revalidate `/accounts/[id]`. → **Verify**: Vitest — valid PDF/JPEG inserts a row with the *detected* mime (not the client header); disallowed type returns an error, no row; delete removes only the scoped doc.

**P10-10 — Secure download route.** Add `GET` handler [src/app/accounts/[id]/documents/[docId]/route.ts](../../src/app/accounts/[id]/documents/[docId]/route.ts): `requireUser`, load the doc scoped to the account (404 otherwise), respond with the bytes, `Content-Type: <stored mime>`, `Content-Disposition: attachment; filename="<sanitized>"`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. **Never inline.** → **Verify**: route returns the bytes + attachment headers for the owner; unauth → redirect/401; cross-account docId → 404; an HTML payload is downloaded, never rendered.

### Batch 4 — UI

*Skills: `nextjs-app-router-patterns`, `tailwind-patterns`, `frontend-security-coder` (display of user-entered names).*

**P10-11 — Create-asset UI.** Add `personal_asset` to the type picker in [new-account-form.tsx](../../src/app/accounts/new/new-account-form.tsx) (label "Personal asset (vehicle, boat, jewelry…)"); when selected, **hide the Institution field** and reveal category `<select>` (Vehicle / Boat & watercraft / Jewelry & watches / Art & collectibles / Other), description, acquired date, acquisition cost, and optional initial value + date. Wire to `createAssetAction`. (A `'use client'` conditional render keyed off the selected type; keep it minimal.) → **Verify**: `tsc`/biome clean; selecting the type swaps the fields; submit creates the asset and redirects to its detail page.

**P10-12 — Asset detail page branch.** In [accounts/[id]/page.tsx](../../src/app/accounts/[id]/page.tsx) add a `personal_asset` branch: header shows **category** (+ description) instead of the `"Personal asset"` sentinel institution; an **Acquisition** panel (acquired date, acquisition cost, and a simple **gain/loss** = latest value − cost via the existing [gainLoss](../../src/lib/investments/gain-loss.ts), clearly a display figure); a **"Record value"** section (new `AssetValueForm`, a thin copy of [property-form.tsx](../../src/app/accounts/[id]/property-form.tsx) bound to `recordAssetValueAction`); and the existing snapshot-history table (value over time) renders unchanged. Add `personal_asset` to both `TYPE_LABEL` maps ([detail](../../src/app/accounts/[id]/page.tsx) + [list](../../src/app/accounts/page.tsx)) → "Asset". → **Verify**: `tsc`/biome clean; the page renders for an asset with and without acquisition cost (gain/loss "—" when cost unknown).

**P10-13 — Documents UI.** On the asset detail page, a **"Proof of authenticity"** section: an upload form (`'use client'`, file input + optional description, bound to `uploadAssetDocumentAction`, accept attribute limited to the whitelist) and a list of existing docs (filename, size, uploaded date, **Download** link → the Batch-3 route, **Delete** button). Render user-supplied filenames/descriptions as text (no `dangerouslySetInnerHTML`). Copy answers the owner's "too much?": "Optional — attach a title, receipt, or appraisal (image or PDF, up to 10 MB)." → **Verify**: `tsc`/biome clean; upload → appears in the list; download pulls the file; delete removes it.

**P10-14 — Asset value-over-time chart (island).** Add a small `AssetValueChart` `'use client'` island (copy the [net-worth-chart.tsx](../../src/app/net-worth-chart.tsx) pattern) fed by the asset's `account_snapshots`, shown on the detail page above/with the history table. `Number()` only at the display edge. *(Modest, skippable if time-boxed — the history table already covers the requirement; the chart is the nice-to-have.)* → **Verify**: `tsc`/biome clean; chart renders with ≥2 snapshots, gracefully empty with <2.

### Batch 5 — Tests, docs, security/privacy pass, E2E

*Skills: `e2e-testing-patterns`, `frontend-security-coder`, `backend-security-coder`, `code-reviewer`.*

**P10-15 — Test sweep.** Confirm the always-test surfaces are green and add any gaps: `createAssetSchema` validation, `recordAssetValueAction` idempotency, `detectDocumentType` whitelist/magic-byte/sanitization, upload/delete actions, and the net-worth-inclusion integration test (P10-07). → **Verify**: `pnpm test` green; no native float on any money path (gain/loss via `Money`).

**P10-16 — Docs.** New [docs/ASSETS.md](../../docs/ASSETS.md): what a personal asset is, the manual-value-over-time model, the boundary (no auto-valuation/depreciation/OCR/advice), the proof-document feature (types, 10 MB cap, attachment-only download, **and that documents ride the encrypted `pg_dump` backup**), and the privacy note (nothing egresses). Update [README.md](../../README.md) §features + add a Phase 10 status line; add a pointer from [docs/BACKUP.md](../../docs/BACKUP.md)/[docs/RESTORE.md](../../docs/RESTORE.md) noting that `asset_documents` bytes are included in the dump (no extra restore step). → **Verify**: doc walks create → value → document → backup; boundary + privacy stated.

**P10-17 — Security/privacy pass.** Extend [docs/THREAT_MODEL.md](../../docs/THREAT_MODEL.md) with the asset-document surface: STRIDE rows for **stored-XSS via uploaded file** (mitigated: whitelist excludes SVG/HTML, attachment-only + `nosniff`), **path traversal in filename** (sanitized), **content-type spoof** (magic-byte sniff, not client header), **cross-account document access** (account-scoped query + UUID validation in the route), **DoS via large upload** (size cap), and **sensitive-data-at-rest** (bytea inside the same encrypted backup; no CDN; no egress). Grep-confirm the download route is the only path that serves `asset_documents.bytes` and that no asset code makes an outbound fetch. → **Verify**: grep shows no external fetch in asset/document code; route headers asserted; `tsc`/biome clean. *Skills: `backend-security-coder`, `frontend-security-coder`.*

**P10-18 — E2E (manual path, ungated).** New `e2e/phase10-assets.spec.ts`: bootstrap → create a `personal_asset` ("2021 Tacoma", Vehicle, acquisition cost) → record a value → assert it shows on `/accounts/[id]`, in the snapshot history, and contributes to net worth on `/`; upload a small PDF fixture → assert it appears in the documents list and the download link resolves; record a higher value → assert the gain/loss display updates. → **Verify**: `tsc`/biome clean; full Vitest suite green. Live `playwright test` pending a running app+DB (same posture as the Phase 5/9 manual specs).

---

## Testing (per CLAUDE.md §Testing Philosophy)

**Always-test surfaces this phase adds** (Vitest; test Postgres where DB is involved):
- **`recordAssetValueAction` idempotency** (P10-05) — value-over-time is the product; UPSERT-on-`(account_id, date)` must overwrite, not duplicate.
- **`detectDocumentType`** (P10-08) — magic-byte/whitelist/sanitization is the security boundary; pure function, highest TDD payoff. SVG/HTML/spoof rejection explicitly asserted.
- **`createAssetSchema`** validation (P10-04) and the **upload/delete actions** (P10-09).
- **Net-worth inclusion** of a valued asset / exclusion of an unvalued one (P10-07) — integration.

**Sparingly tested** (cover the math/actions, not the buttons): the asset detail page, create form, documents UI, and the value chart island.

**Playwright**: one ungated manual flow (P10-18). No flaky flow added just to have one.

---

## Migration & data safety

- **One Drizzle migration** for all Batch-1 schema (1 enum value + 4 nullable columns + CHECK + 1 table + index). `generate` → review → `migrate`. Watch the enum-`ADD VALUE`-in-transaction caveat (split if needed).
- **No column dropped.** Phase 10 is purely additive; nothing in the existing schema changes shape (the `_bytea` extraction is a pure refactor — same column type).
- **Documents ride the existing backup.** `asset_documents.bytes` is captured by the nightly encrypted `pg_dump` ([docs/BACKUP.md](../../docs/BACKUP.md)); restore needs **no** new step. Take a `pg_dump` before applying the migration (we touch `accounts`).

---

## Sequencing & shipping

1. **P10-00** (docs/ADR) — no deploy.
2. **Batch 1** — migrate; deploy app. Gates everything.
3. **Batch 2** (lifecycle/value) + **Batch 3** (documents) — independent; can share an image push.
4. **Batch 4** (UI) — after 2 + 3.
5. **Batch 5** — tests/docs/security/E2E; bundle with the last app push.
- The **worker is untouched** this phase (no new jobs — assets are manual, documents are local). App-only deploys: `make image-push PLATFORMS=linux/amd64` then `docker compose … up -d --force-recreate app`.

---

## Skills Map (per task cluster)

Per [SKILLS.md](SKILLS.md) §Suggested Workflow. Invoke when the cluster opens, not upfront.

| Task cluster | Primary skill(s) |
|---|---|
| P10-00 (scope gate + ADRs) | `architecture-decision-records` |
| P10-01 → P10-03 (schema + migration) | `drizzle-orm-expert`, `postgres-best-practices`, `typescript-pro` |
| P10-04 → P10-07 (asset lifecycle + value + queries) | `zod-validation-expert`, `nextjs-app-router-patterns`, `typescript-pro` |
| P10-08 → P10-10 (document detector + actions + download route) | `backend-security-coder`, `frontend-security-coder`, `zod-validation-expert` |
| P10-11 → P10-14 (create/detail/documents/chart UI) | `nextjs-app-router-patterns`, `tailwind-patterns`, `frontend-security-coder` |
| P10-15 → P10-18 (tests, docs, security pass, E2E) | `e2e-testing-patterns`, `code-reviewer`, `backend-security-coder` |

---

## Open Items (out of scope for this plan, captured for future PLAN docs)

- **Automated valuation** (KBB/Edmunds/auction/appraisal APIs) — egresses asset data + SaaS dependency; explicitly out per ADR-023/CLAUDE.md §Privacy. Manual value only.
- **Depreciation schedules** — auto-decline a vehicle's value over time; the owner asked for *user-adjustable* value, so deferred.
- **Asset ↔ financing-loan linking** — net a financed vehicle's value against its `loan` account as a single "equity" line. Useful later; today they're separate accounts (asset positive, loan negative — net worth is already correct, just not visually paired).
- **Dedicated "Assets" nav section / grouping** on `/accounts` — cosmetic; assets currently live in the unified accounts list. Promote if the list gets crowded.
- **Document OCR / parsing / e-sign / insurance & warranty tracking** — document-management features beyond "store + serve proof"; out of scope.
- **Filesystem/object-storage migration for documents** — if the bytea store ever bloats the DB/dump past comfort, migrate to a mounted volume with a paired backup story (ADR-024 rejected-alternative, revisit when it earns it).
- **Image thumbnails / inline preview** — would require an inline-serving path (stored-XSS risk we deliberately avoided); only with a sandboxed renderer if ever.

---

*End of PLAN10.md*
