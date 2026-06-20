# PLAN — Phase 7 (CRUD Completeness / Data Management)

> Phases 0–6 built a working, unattended tracker. But the UI grew create-first: you can *add* almost everything yet *edit/delete* very little. A real management surface was missing — you can create an account but never rename, retype, archive, or delete it; you can record a balance but not remove a mistyped one; the transaction delete function was even written but never wired to a button. Phase 7 closes those gaps so the owner can fully manage their own data.
>
> Phase 7 is **additive plumbing over shipped tables** — **no schema changes** (the one field we need, `accounts.closed_at`, already exists). The risk is concentrated in two places: **destructive deletes** (account delete cascades across half the schema) and **valuation correctness** (a deleted transaction/snapshot must trigger the same recompute the importer/sync already use). Both get Vitest coverage per CLAUDE.md §Testing Philosophy.
>
> **Companion docs** — read for context, do not duplicate here:
> - [../../CLAUDE.md](../../CLAUDE.md) — guardrails: §Money & Numeric Precision (never `Number()` on money), §Database & Drizzle Specifics ("Never `drop column` … without a paired data backup step" — applies to row deletes of historical data: confirm + cascade carefully), §Testing Philosophy (money/snapshot/cascade are always-test surfaces).
> - [PLAN4.md](PLAN4.md) — Plaid Item lifecycle (`disconnectItemAction`, `plaid_items.status`); account↔Item linkage and the `onDelete: 'set null'` rule that preserves account history when an Item is unlinked.
> - [PLAN5.md](PLAN5.md) — holdings/lots model, the investment sync's full-snapshot upsert+reconcile (why a manually-deleted Plaid holding re-appears).
> - [IDEAS.md](IDEAS.md) §6 Schema Invariants, §11 Decision Log (append ADR-017 below after approval).

---

## What already exists (do not rebuild — copy these patterns)

Inventory before writing code. Phase 7 mirrors conventions already in the repo:

- **Account-scoped server actions**: [src/app/accounts/[id]/actions.ts](../../src/app/accounts/[id]/actions.ts) — `"use server"`, the `ActionResult { error?; ok? }` shape, the `loadAccount(accountIdRaw)` helper (does `requireUser()` + `getAccount` + 404), `assertHoldingOnAccount(holdingId, accountId)` ownership guard, `LOT_UUID_RE`, and `revalidatePath(...)` on success. Recently added `deleteHoldingAction` (transaction-deletes lots then the holding) is the **template for every new delete action** here.
- **Per-row client delete control**: [src/app/accounts/[id]/delete-holding-button.tsx](../../src/app/accounts/[id]/delete-holding-button.tsx) — `"use client"`, `useTransition` + `useState` for error, `window.confirm`, `router.refresh()`. Copy for transaction/snapshot delete buttons.
- **Inline editor with add+delete**: [src/app/accounts/[id]/lot-form.tsx](../../src/app/accounts/[id]/lot-form.tsx) — `<details>` disclosure, `useActionState` for the add form, `useTransition` for delete. Template for the account-edit and rule-edit forms.
- **Create form pattern**: [src/app/accounts/new/new-account-form.tsx](../../src/app/accounts/new/new-account-form.tsx) + [src/app/accounts/new/actions.ts](../../src/app/accounts/new/actions.ts) — the field set the edit form reuses (name, institution, type, currency).
- **Zod schemas**: [src/lib/schemas/account.ts](../../src/lib/schemas/account.ts) — `upsertHoldingSchema`, `recordBalanceSchema`, etc. New `updateAccountSchema` / `updateTransactionSchema` / `updateRuleSchema` go here.
- **Read paths that must respect `closed_at`**: [src/lib/net-worth/compute.ts](../../src/lib/net-worth/compute.ts) (`computeNetWorth`, `netWorthSeries` — both `db.select().from(accounts)` with **no `closed_at` filter today**), [src/app/accounts/page.tsx](../../src/app/accounts/page.tsx) (the accounts list), [src/lib/accounts/queries.ts](../../src/lib/accounts/queries.ts) (`getAccount`, list helpers).
- **Transaction read/write**: [src/lib/transactions/queries.ts](../../src/lib/transactions/queries.ts) — **`deleteTransaction(...)` already exists but is wired to nothing**; `setCategory` is wired via [category-cell.tsx](../../src/app/accounts/[id]/category-cell.tsx). The transactions table renders in [src/app/accounts/[id]/transactions-section.tsx](../../src/app/accounts/[id]/transactions-section.tsx).
- **Snapshot recompute on mutation**: the Plaid sync ([sync-plaid-item.ts](../../src/worker/jobs/sync-plaid-item.ts)) and the importer ([src/lib/importers/persist.ts](../../src/lib/importers/persist.ts)) already recompute `account_snapshots` for affected dates after changing transactions. Deleting/editing a transaction must reuse that logic (extract a shared helper rather than duplicate).
- **Category rules**: [src/app/settings/categories/actions.ts](../../src/app/settings/categories/actions.ts) — has `createRuleAction`, `toggleRuleAction`, `deleteRuleAction`, but **no `updateRuleAction`**. The rules page renders the list.
- **Account delete cascade targets** (verify each FK's `onDelete` in schema; cascade explicitly in a tx where the FK is `set null`/`restrict`): `transactions`, `holdings` → `holding_lots`, `investment_transactions`, `account_snapshots`, `liabilities`, `import_batches`. `securities` is **not** account-scoped (`holdings.security_id` is `set null`) — leave it. `plaid_items` is **not** owned by the account (the FK is the other direction with `onDelete: 'set null'`).

---

## ADR-017 — Manual data management: edit/close/delete with guardrails

**Status**: ✅ Locked 2026-06-15 — appended to [IDEAS.md](IDEAS.md) §11. Kickoff decisions: typed-name delete confirm; type/currency lock once data exists; closed accounts drop from current net worth but keep historical chart points. Batch 1 shipped 2026-06-15.

**Context**: The single owner needs to correct their own data (rename a misnamed account, remove a mistyped balance, delete a junk holding/transaction). The risk is destroying historical financial data — the entire value of the app — or corrupting valuation by changing a typed field after data exists.

**Decision**:
1. **Soft vs hard.** Accounts get a **soft "close/archive"** (`closed_at`, already in schema) *and* a **hard delete**. Closing is the safe default we steer users toward; delete is the escape hatch with a typed-name confirmation.
2. **Field-edit guards.** Account **name + institution** are always editable. **Type + currency** are editable **only when the account has zero transactions, holdings, and snapshots** — changing them after data exists corrupts valuation/aggregation. Locked fields show a hint ("clear this account's data to change its type").
3. **Plaid-linked accounts cannot be hard-deleted** while their Item is connected (`plaid_item_id IS NOT NULL`) — direct the user to **Disconnect** the connection first (existing `disconnectItemAction`). Rename/close are still allowed. Rationale: deleting one account out from under a live Item orphans it and the next sync can't reconcile it.
4. **Deletes recompute, never silently drift.** Deleting/editing a transaction or snapshot re-runs the affected-date snapshot recompute (shared helper extracted from the sync/importer). Deleting an account cascades all child rows in **one DB transaction**.
5. **Plaid-sourced rows re-appear by design.** Deleting a Plaid transaction/holding is allowed but the UI notes it returns on the next sync (the sync is a full-snapshot reconcile). Manual/imported rows delete permanently. Plaid rows are **not** field-editable (the sync would overwrite); only `category` stays user-editable (already sticky via `category_overridden_at`).
6. **Every mutating action**: `requireUser()` → ownership check → mutate → `revalidatePath()` for every affected route (`/accounts/[id]`, `/accounts`, `/`, `/investments` where relevant).

**Consequences**: No schema change. One new shared snapshot-recompute helper. Net-worth/list read paths must start filtering `closed_at` (a behavior change: closed accounts drop out of net worth — intended).

---

## Task breakdown

> Batches are independent and individually shippable (commit + amd64 image push + deploy + verify). Recommended order 1 → 2 → 3 → 4; batch 3+4 may share one push. Task IDs follow the `P7-xx` convention.

### Batch 1 — Account management (edit / close / delete)

**P7-01 — `updateAccountAction`** (`src/app/accounts/[id]/actions.ts`)
- Signature: `updateAccountAction(accountIdRaw, _prev, formData) => ActionResult`.
- New `updateAccountSchema` in [schemas/account.ts](../../src/lib/schemas/account.ts): `{ name, institution, type, currency }` (reuse the enum + currency validation from the create schema).
- Guard: load the account; compute `hasData = (count transactions ∪ holdings ∪ snapshots) > 0`. If `hasData`, **ignore** submitted `type`/`currency` (keep existing) and surface a note; always apply `name`/`institution`.
- `revalidatePath('/accounts/'+id)`, `/accounts`, `/`.

**P7-02 — `closeAccountAction` / `reopenAccountAction`**
- Toggle `accounts.closed_at` (`new Date()` / `null`). Ownership-checked.
- Revalidate `/accounts/[id]`, `/accounts`, `/`.

**P7-03 — `deleteAccountAction`**
- Guard: reject if `plaid_item_id IS NOT NULL` → `{ error: "Disconnect this account's connection first." }`.
- One `db.transaction`: delete `holding_lots` (by holding), `holdings`, `investment_transactions`, `transactions`, `account_snapshots`, `liabilities`, `import_batches` for the account, then the `accounts` row. (Verify FK `onDelete` first — drop the explicit child delete for any FK already `cascade`.)
- After commit: `redirect('/accounts')`. Revalidate `/`, `/investments`.

**P7-04 — Net-worth + lists respect `closed_at`**
- [compute.ts](../../src/lib/net-worth/compute.ts): `computeNetWorth` and `netWorthSeries` exclude `closed_at IS NOT NULL` accounts (a closed account contributes $0 going forward; historical snapshots remain in the table but the account is dropped from the as-of aggregation). **Decide**: keep historical chart points (closed account's past value stays in old points) vs zero it — recommend **drop from current** only, leave history intact.
- [accounts/page.tsx](../../src/app/accounts/page.tsx): hide closed by default + a "Show closed" toggle (URL param). Closed rows render muted with a "Closed" badge + Reopen.

**P7-05 — Account header UI** (`src/app/accounts/[id]/page.tsx` + new `account-admin.tsx` client island)
- An **Edit** disclosure (name/institution always; type/currency disabled when `hasData`, with hint).
- **Close/Reopen** button.
- **Delete** button → typed-name confirm modal (type the account name to enable), disabled for Plaid-linked with a "Disconnect first" note linking to `/settings/connections`.

**P7-06 — Tests** (`actions` integration, real test DB): update applies name/institution; type/currency locked when data exists; delete cascades all child tables and is blocked for Plaid-linked; close removes the account from `computeNetWorth`.

### Batch 2 — Transaction management (delete / edit) — ✅ Implemented 2026-06-19

**P7-07 — Shared snapshot-recompute helper**
- Extract the affected-date recompute used by [sync-plaid-item.ts](../../src/worker/jobs/sync-plaid-item.ts) / [importers/persist.ts](../../src/lib/importers/persist.ts) into e.g. `src/lib/snapshots/recompute.ts` (`recomputeAccountSnapshotsForDates(tx, accountId, dates)`), and call it from both the existing writers and the new transaction mutations. Keep behavior identical (verify against existing tests).

**P7-08 — `deleteTransactionAction`** (`src/app/accounts/[id]/actions.ts`)
- Wire the existing `deleteTransaction` ([transactions/queries.ts](../../src/lib/transactions/queries.ts)). Ownership-checked (txn belongs to account). In a tx: capture the row's `posted_at`, delete, then recompute snapshots for that date via P7-07.
- Revalidate `/accounts/[id]`, `/accounts`, `/`.

**P7-09 — `updateTransactionAction`**
- New `updateTransactionSchema`: `{ postedAt, name, memo, amount }` (money via `Money`, never `Number`).
- Guard: **manual/imported only** (`source != 'plaid'`); reject edits to Plaid rows with a note (category stays editable elsewhere). Recompute snapshots for old + new `posted_at`.
- Revalidate as above.

**P7-10 — Transaction row UI** (`transactions-section.tsx`)
- Per-row **Edit** (inline form: date/payee/memo/amount) + **Delete** (confirm). Edit hidden/disabled for `source==='plaid'` (tooltip: "synced from your bank"). Delete shows "re-appears on next sync" hint for Plaid rows.

**P7-11 — Tests**: delete recomputes snapshot to correct balance; edit guarded off for Plaid rows; amount edit goes through `Money` and re-snapshots both dates.

### Batch 3 — Balance-snapshot delete — ✅ Implemented 2026-06-19

**P7-12 — `deleteSnapshotAction(accountIdRaw, dateRaw)`**
- Validate `date` is `YYYY-MM-DD`; ownership-checked. Delete the `(account_id, date)` row. No recompute needed (snapshots are the source for balance-only accounts). Revalidate `/accounts/[id]`, `/accounts`, `/`.

**P7-13 — Snapshot-history UI** (account page "Snapshot history" table)
- Add a **Delete** control per row (mirror `delete-holding-button.tsx`). Confirm. Useful for removing a wrong-dated manual balance (overwrite only fixes same-date mistakes).

**P7-14 — Tests**: delete removes the row + updates the account's current/latest value where that row was newest.

### Batch 4 — Category-rule edit — ✅ Implemented 2026-06-19

> Note: `updateRuleAction` + `updateRuleSchema` (P7-15) had already landed under PLAN8's P8-10. Batch 4 here added the missing inline rule-edit UI (P7-16, `rule-row.tsx`) and the update-then-recategorize test (P7-17, `rule-update.test.ts`).

**P7-15 — `updateRuleAction`** (`src/app/settings/categories/actions.ts`)
- New `updateRuleSchema`: `{ pattern, field, category, priority }` (+ keep `flags`/`enabled`). Validate the regex compiles (reuse the create-action validation). Revalidate the categories page.

**P7-16 — Rule-edit UI**
- Inline **Edit** form per rule on the categories page (mirror lot-form's add/edit disclosure). Currently delete-and-recreate only.

**P7-17 — Tests**: update changes the rule and a subsequent `recategorize-all` reflects it.

### Batch 5 — Loose ends (small / optional)

- `deleteLiabilityAction`: covered by P7-03's cascade; expose a standalone "remove mortgage terms" only if a loan account should keep existing without amortization (low priority).
- Cost-basis **lot edit**: skip — delete + re-add (both exist) already covers it.
- Holding **edit**: already covered (`upsertHoldingAction` re-saves by symbol).

---

## Testing (per CLAUDE.md §Testing Philosophy)

Always-test surfaces this phase touches: **account delete cascade**, **snapshot recompute after transaction delete/edit**, **money arithmetic on transaction-amount edit**, **closed-account exclusion from net worth**. Vitest integration tests against the test Postgres (the existing `actions.test.ts` / `sync-*.test.ts` style). UI components stay sparingly tested (per the rules) — cover the actions, not the buttons.

## Sequencing & shipping

1. Ship **Batch 1**, deploy, verify (rename, close, delete an empty test account; confirm Plaid-linked is blocked).
2. **Batch 2** (depends on P7-07 helper extraction — run the full sync/importer suites after extracting to prove no regression).
3. **Batches 3 + 4** can share one image push (both small).
4. Each batch: amd64 `make image-push PLATFORMS=linux/amd64`, then `docker compose … up -d --force-recreate app` (worker unchanged unless P7-07 touches worker code — then recreate `worker` too).

## Decisions to confirm at kickoff

1. **Account delete confirmation UX**: typed-name confirm (recommended) vs plain "Are you sure?".
2. **Type/currency edit**: lock once the account has data (recommended) vs allow with a warning.
3. **Closed-account history**: drop only from *current* net worth, keep old chart points (recommended) vs also zero historical contribution.
4. **Shipping cadence**: one image per batch (incremental verify) vs build all and push once.
