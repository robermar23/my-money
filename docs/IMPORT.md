# Importing transactions

Phase 3 ships the import path for cash and credit-card accounts. The monthly
ritual is:

1. Log into your bank's online portal → download a `.qfx`, `.ofx`, or `.csv`
   export for the statement period.
2. Open the my-money account page → click **Import file**.
3. Drop the file on the upload form. For CSV uploads only, you'll also paste
   in a JSON column mapping (see below).
4. The next page shows a preview: how many transactions are new, how many are
   duplicates (already in your ledger by FITID), and any invalid rows. A
   reconciliation banner at the top compares the file's ending balance against
   the running total computed from your existing snapshots + the new
   transactions.
5. Click **Confirm import of N transactions**. The data lands; the dashboard
   updates.

Re-importing the same file is always safe. The dedup key is `(account_id,
fitid)` for QFX/OFX and `SHA-256(date | amount | name | memo)` for CSV.

## Supported file types

- **OFX 1.x (SGML)** — `.qfx` and `.ofx`. The flavor exported by every major US
  bank's "Download to Quicken" button.
- **OFX 2.x (XML)** — `.qfx` and `.ofx`. AMEX and some newer issuers.
- **CSV** — generic comma-separated values. Requires a column mapping per
  account.

## CSV column mapping

CSV exports differ by bank, so you tell the importer which column means what.
The upload form ships **presets** for common shapes — pick one from the
dropdown and the JSON below auto-fills. Edit it inline if your bank does
something unusual.

### Preset 1 — Generic, header row + signed Amount column

```json
{
  "date": "Posted Date",
  "amount": "Amount",
  "name": "Description",
  "memo": "Memo",
  "dateFormat": "MM/DD/YYYY"
}
```

### Preset 2 — Generic, header row + separate Debit / Credit columns

```json
{
  "date": "Date",
  "name": "Merchant",
  "debit": "Debit",
  "credit": "Credit",
  "dateFormat": "YYYY-MM-DD"
}
```

### Preset 3 — M&T Bank (headerless, 6 columns)

M&T's online CSV export has **no header row** and the column order is
`row_number, date, description, debit, credit, running_balance`. Set
`hasHeader: false` and reference columns by 0-based index string:

```json
{
  "hasHeader": false,
  "date": "1",
  "name": "2",
  "debit": "3",
  "credit": "4",
  "dateFormat": "MM/DD/YYYY"
}
```

(The `amount` field is left empty — the importer uses `debit`/`credit`
when both are populated. The running-balance column is captured into the
transaction's `raw` jsonb as `col_5` for forensic use, but isn't read by
the importer itself.)

`dateFormat` is optional — the parser auto-detects `YYYY-MM-DD`, `MM/DD/YYYY`,
and `MM-DD-YYYY` if you leave it off.

## Reconciliation mismatch — what to do

The preview banner is your early-warning system. After confirm, the account
page renders a permanent reconciliation banner comparing the most-recent
snapshot to the sum of transactions to date.

A non-zero drift means one of:

1. **Missing transactions in an earlier statement** — most common. Import the
   missing month and the drift collapses.
2. **A duplicate transaction was deleted manually** — the banner will go amber
   until you re-import the source file (which will skip everything except the
   missing row).
3. **Parser bug** — if the math is wrong on a freshly-imported single file,
   open an issue with an anonymized copy of the QFX. The unit tests under
   `src/lib/importers/qfx/__fixtures__/` are the regression net.

## Categorization

Imported transactions are auto-categorized via a regex rule engine
([src/lib/categorization/](../src/lib/categorization/)). On first import a small
set of generic defaults is seeded (Amazon → Shopping, Starbucks → Coffee, etc.).

- Edit the rules at **/settings/categories**.
- Click any category cell in the transactions table to override that single
  transaction. Overrides are remembered: re-running the rules over the whole
  ledger skips overridden rows.
- After adding or editing rules, click **Re-categorize existing transactions**
  to apply them retroactively.

## Backfilling years of history

Large CSV/QFX files (>1 MB) are processed in the BullMQ worker rather than
inline in the request. You'll land on a polling page that auto-refreshes every
2 seconds and redirects to the preview once parsing finishes. There is no
practical upper bound aside from the configurable `IMPORT_MAX_FILE_BYTES`
(default 10 MB).
