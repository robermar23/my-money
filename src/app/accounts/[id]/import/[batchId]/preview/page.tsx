import { db } from "@/db/client.ts";
import { importBatches } from "@/db/schema/index.ts";
import { getAccount } from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import type { NormalizedBatch } from "@/lib/importers/normalize.ts";
import { buildPreview, reconcile } from "@/lib/importers/persist.ts";
import { Money } from "@/lib/money/money.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ConfirmButton } from "./confirm-button.tsx";

interface PageProps {
  readonly params: Promise<{ id: string; batchId: string }>;
}

export default async function PreviewPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const { id, batchId } = await props.params;
  const accountId = toAccountId(id);
  const account = await getAccount(accountId);
  if (!account) notFound();

  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!batch || batch.accountId !== accountId) notFound();

  if (batch.status === "pending") {
    redirect(`/accounts/${accountId}/import/${batch.id}`);
  }
  if (batch.status === "confirmed") {
    redirect(`/accounts/${accountId}?imported=${batch.insertedCount}`);
  }
  if (batch.status === "failed") {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="font-semibold text-2xl">Import failed</h1>
        <p className="mt-2 text-red-700 text-sm dark:text-red-300">{batch.error}</p>
        <Link
          href={`/accounts/${accountId}/import`}
          className="mt-4 inline-block text-sm hover:underline"
        >
          ← Try a different file
        </Link>
      </main>
    );
  }

  const normalized = batch.parsedPayload as NormalizedBatch;
  const preview = await buildPreview(accountId, normalized);
  const recon = await reconcile(batch, normalized, account.currency, account.type);

  const driftStr = recon.diff?.toString() ?? "0.00";
  const driftAbs = Math.abs(Number.parseFloat(driftStr));

  return (
    <main className="mx-auto max-w-5xl p-6">
      <Link href={`/accounts/${accountId}`} className="text-sm text-zinc-500 hover:underline">
        ← {account.name}
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">Preview import</h1>
      <p className="mt-1 text-sm text-zinc-500">
        File: <span className="font-code">{batch.filename}</span> · Source: {batch.source}
        {batch.statementStart && batch.statementEnd && (
          <>
            {" "}
            · Period:{" "}
            <span className="font-mono">
              {batch.statementStart} → {batch.statementEnd}
            </span>
          </>
        )}
      </p>

      {/* Reconciliation banner */}
      <section
        data-tour="preview-reconciliation"
        className={`mt-6 rounded-lg border p-4 ${
          recon.status === "ok"
            ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
            : recon.status === "mismatch"
              ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950"
              : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
        }`}
      >
        {recon.status === "ok" && (
          <p className="text-sm">
            ✅ Statement balance reconciles to the cent. Ending balance:{" "}
            <span className="font-mono">{recon.endingBalance?.format()}</span>
          </p>
        )}
        {recon.status === "mismatch" && (
          <div className="text-sm">
            <p>
              ⚠️ Reconciliation mismatch: drift of{" "}
              <span className="font-mono">{recon.diff?.format()}</span>
            </p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              Anchor (prior snapshot): <span className="font-mono">{recon.anchor?.format()}</span> ·
              Sum of new transactions:{" "}
              <span className="font-mono">{recon.sumOfTransactions.format()}</span> · Ending
              balance: <span className="font-mono">{recon.endingBalance?.format()}</span>
            </p>
            <p className="mt-1 text-xs">
              {driftAbs > 0.005 ? "Some transactions may be missing from earlier statements." : ""}
            </p>
          </div>
        )}
        {recon.status === "no-anchor" && (
          <p className="text-sm">
            ℹ️ No prior snapshot to anchor against. Treating the file's ending balance (
            <span className="font-mono">{recon.endingBalance?.format()}</span>) as ground truth.
          </p>
        )}
        {recon.status === "no-balance" && (
          <p className="text-sm">
            ℹ️ This file does not include an ending balance — reconciliation skipped.
          </p>
        )}
      </section>

      {/*
        P17-33 — the credit-card sign advisory (ADR-042 §5). Deliberately its own
        banner rather than a reconciliation status: a card can be `no-anchor`
        *and* sign-suspect at once, and one message must not hide the other.

        It names the suspicion and shows the exact value that will be stored. It
        does NOT flip anything: the OFX LEDGERBAL sign for a card is
        institution-dependent, so an automatic flip would be confidently wrong
        for some banks. The Confirm button below is the authorization.
      */}
      {recon.cardSignSuspect && (
        <section className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <p className="text-sm">
            ⚠️ This card statement's ending balance is <strong>positive</strong>.
          </p>
          <p className="mt-1 text-xs text-zinc-700 dark:text-zinc-300">
            For a credit card this app stores what the balance contributes to your net worth, so an
            amount you owe is stored as a negative number. Confirming will store{" "}
            <span className="font-mono">{recon.endingBalance?.format()}</span> as of{" "}
            <span className="font-mono">{batch.statementEnd}</span>, which counts the card as
            something you <em>own</em>.
          </p>
          <p className="mt-1 text-xs text-zinc-700 dark:text-zinc-300">
            That is right if the card is overpaid. If instead your bank writes the amount you owe as
            a positive number, cancel this import and record the balance by hand on the account
            page, where the field asks for the amount owed. Nothing is stored until you confirm.
          </p>
        </section>
      )}

      {/* Counts */}
      <div data-tour="preview-counts" className="mt-6 grid grid-cols-3 gap-3">
        <CountCard label="New" value={preview.newTransactions.length} tone="positive" />
        <CountCard label="Duplicates (skipped)" value={preview.duplicates.length} tone="neutral" />
        <CountCard label="Invalid" value={preview.invalid.length} tone="negative" />
      </div>

      {/* New transactions */}
      <section className="mt-8">
        <h2 className="font-medium">New transactions</h2>
        {preview.newTransactions.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No new transactions to import.</p>
        ) : (
          <TransactionTable
            rows={preview.newTransactions}
            currency={account.currency}
            flipSign={account.type === "credit_card"}
          />
        )}
      </section>

      {/* Duplicates */}
      {preview.duplicates.length > 0 && (
        <section className="mt-8">
          <h2 className="font-medium">Duplicates</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Already present in your ledger (by FITID). These will be skipped on confirm.
          </p>
          <TransactionTable
            rows={preview.duplicates}
            currency={account.currency}
            flipSign={account.type === "credit_card"}
            dimmed
          />
        </section>
      )}

      {/* Invalid */}
      {preview.invalid.length > 0 && (
        <section className="mt-8">
          <h2 className="font-medium text-red-700 dark:text-red-300">Invalid rows</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {preview.invalid.map((row) => (
              <li key={`${row.fitid}-${row.reason}`} className="font-code text-xs">
                {row.fitid || "(no fitid)"} — {row.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Confirm */}
      <div
        data-tour="preview-confirm"
        className="mt-10 flex items-center justify-between border-zinc-200 border-t pt-6 dark:border-zinc-800"
      >
        <Link
          href={`/accounts/${accountId}/import`}
          className="text-sm text-zinc-500 hover:underline"
        >
          Cancel
        </Link>
        <ConfirmButton
          accountId={accountId}
          batchId={batch.id}
          disabled={false}
          insertCount={preview.newTransactions.length}
        />
      </div>
    </main>
  );
}

function CountCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "positive" | "neutral" | "negative";
}): React.JSX.Element {
  const toneClass =
    tone === "positive"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "negative" && value > 0
        ? "text-red-700 dark:text-red-300"
        : "text-zinc-700 dark:text-zinc-300";
  return (
    <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500 uppercase">{label}</div>
      <div className={`mt-1 font-mono text-2xl ${toneClass}`}>{value}</div>
    </div>
  );
}

function TransactionTable({
  rows,
  currency,
  flipSign,
  dimmed,
}: {
  rows: ReadonlyArray<{
    fitid: string;
    postedAt: string;
    amount: string;
    name: string;
    memo: string | null;
    category: string | null;
  }>;
  currency: string;
  flipSign: boolean;
  dimmed?: boolean;
}): React.JSX.Element {
  return (
    <table className={`mt-3 w-full text-sm ${dimmed ? "opacity-60" : ""}`}>
      <thead className="text-left text-xs text-zinc-500 uppercase">
        <tr>
          <th className="py-1.5">Date</th>
          <th className="py-1.5">Payee</th>
          <th className="py-1.5">Category</th>
          <th className="py-1.5 text-right">Amount</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {rows.map((r) => {
          const displayAmount = flipSign
            ? Money.fromString(r.amount, currency).negate()
            : Money.fromString(r.amount, currency);
          return (
            <tr key={r.fitid}>
              <td className="py-1.5 font-mono">{r.postedAt}</td>
              <td className="py-1.5">
                <div>{r.name}</div>
                {r.memo && <div className="text-xs text-zinc-500">{r.memo}</div>}
              </td>
              <td className="py-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                {r.category ?? "Uncategorized"}
              </td>
              <td
                className={`py-1.5 text-right font-mono ${
                  displayAmount.isNegative() ? "text-red-700 dark:text-red-300" : ""
                }`}
              >
                {displayAmount.format()}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
