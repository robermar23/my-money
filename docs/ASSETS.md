# Personal high-value assets

> User-valued possessions — vehicles, boats, jewelry & watches, art &
> collectibles — tracked over time and counted toward net worth, with optional
> proof-of-authenticity documents (Phase 10, **ADR-023 / ADR-024**). This is the
> *what it is and how to use it* guide; the schema/decision rationale lives in
> [plans/features/PLAN10.md](../plans/features/PLAN10.md) and
> [plans/features/IDEAS.md](../plans/features/IDEAS.md) §11.

## What a personal asset is

A **personal asset** is anything valuable you own that isn't already covered by a
financial account — your truck, a boat, a watch, an art piece. In my-money it's a
new account `type` (`personal_asset`) that reuses the same value-over-time and
net-worth machinery the home `property` type already uses: you record a value on a
date, that value flows into your net worth, and the history is charted.

You pick a **category** (Vehicle / Boat & watercraft / Jewelry & watches / Art &
collectibles / Other) and optionally record an acquisition date and acquisition
cost. The category shows wherever a financial account would show its institution.

## The model: manual value, over time

The value of a personal asset is **always entered by you**, full stop. There is no
automated valuation:

- **No** KBB / Edmunds / auction / appraisal-price lookups. Pulling a vehicle's
  "market value" from an external service would both egress your asset data and
  add a SaaS dependency — out of scope by design (CLAUDE.md §Privacy + §Domain
  Scope, ADR-023).
- **No** depreciation schedules. The value doesn't auto-decline; you adjust it
  whenever it changes (a new appraisal, a market shift, damage).

Each value you record is a dated snapshot (`account_snapshots`, one row per day,
re-recording the same date overwrites). Once an asset has its first value it
appears in net worth and on the dashboard net-worth chart; before that — like any
pure-manual account with no snapshot — it stays hidden. The detail page shows a
**value-over-time chart** once there are at least two valuations.

### Gain / loss is a display figure, not a tax figure

If you recorded an acquisition cost, the detail page shows a simple **gain/loss =
latest value − acquisition cost** (the same shape as the holdings gain/loss). It
is a labeled *display* number computed through the `Money`/`decimal.js` helpers —
**not** a capital-gains, cost-basis-lot, or 1099 calculation. my-money does not do
tax-lot accounting for assets any more than it does for investments.

## Proof-of-authenticity documents

Each asset can have **optional** proof documents attached — a vehicle title, a
purchase receipt, an appraisal, a photo. Upload is never required to create or
value an asset; it's there if you want it.

- **Accepted types**: JPEG, PNG, WebP, HEIC images and PDF. The type is decided by
  **magic-byte sniffing** of the file contents, never the filename extension or
  the browser-supplied `Content-Type` (both trivially spoofable). **SVG is
  deliberately excluded** — it's XML that can carry inline `<script>`, a
  stored-XSS foot-gun even when served as a download.
- **Size cap**: 10 MB per file by default (override with `ASSET_DOC_MAX_FILE_BYTES`).
- **Multiple per asset**, each with an optional label (e.g. "Title", "2024
  appraisal"), each individually deletable.
- **Storage**: file bytes live in Postgres (`asset_documents.bytes`, a `bytea`
  column) — not on a filesystem mount, not in object storage, never on a CDN.
- **Download**: only through the authenticated, account-scoped route
  `GET /accounts/[id]/documents/[docId]`, which serves the bytes
  **attachment-only** (`Content-Disposition: attachment` + `X-Content-Type-Options:
  nosniff`, `Cache-Control: private, no-store`). The browser downloads the file;
  it is never rendered inline. This is the only path that serves document bytes.

### Documents ride the encrypted backup

`asset_documents.bytes` is an ordinary Postgres column, so the nightly
`age`-encrypted `pg_dump` ([BACKUP.md](BACKUP.md)) captures your proof documents
along with everything else. **Restore needs no extra step** — they come back with
the database ([RESTORE.md](RESTORE.md)). Like `import_batches.raw_file`, the bytes
contribute to dump size; the 10 MB cap and a single user's handful of assets keep
that bounded.

## Privacy

Personal assets and their documents are **100% local**. Value entry is manual, no
part of the asset feature makes an outbound network call of any kind, and proof
documents — the most sensitive new data class in the app (titles, appraisals,
photos of valuables) — are served only to the authenticated owner as attachments
and stored only in your own Postgres. **Nothing about an asset ever leaves the
host.** See [THREAT_MODEL.md](THREAT_MODEL.md) §Surface G for the STRIDE analysis.

## How to use it

1. **Create** — `/accounts/new` → choose type **"Personal asset (vehicle, boat,
   jewelry…)"**. The Institution field disappears; pick a category and (optionally)
   a description, acquired date, acquisition cost, and an initial value + date.
   Recording an initial value makes the asset count toward net worth immediately;
   leave it blank and add a value later.
2. **Record value** — on the asset's page, the **Record value** section dates each
   entry. Re-recording the same date overwrites it. Two or more entries draw the
   value-over-time chart.
3. **Attach proof** (optional) — the **Proof of authenticity** section takes an
   image or PDF up to 10 MB with an optional label. Uploaded files list with a
   **Download** link (attachment) and a **Delete** button.
4. **See it in net worth** — once valued, the asset appears on `/accounts`, in the
   net-worth total, and on the dashboard net-worth chart at `/`.

## What's out of scope

Reaffirmed for Phase 10 (would each need a FEATURE.md decision first):

- Automated valuation (KBB/Edmunds/auction/appraisal APIs).
- Depreciation schedules.
- Document OCR / parsing / e-signing.
- Insurance & warranty tracking.
- Linking an asset to its financing loan (today a financed vehicle and its loan
  are separate accounts — the asset positive, the loan negative — so net worth is
  already correct, just not visually paired).
