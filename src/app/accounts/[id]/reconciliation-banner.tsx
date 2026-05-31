import { latestAccountReconciliation } from "@/lib/importers/reconcile.ts";
import { Money } from "@/lib/money/money.ts";

interface Props {
  readonly accountId: string;
  readonly currency: string;
}

/**
 * Server-rendered reconciliation banner.
 *
 * Compares the most-recent account snapshot (often written by an import) with
 * the sum of transactions to date. Non-zero drift = the early-warning signal
 * for "we're missing transactions before this snapshot."
 */
export async function ReconciliationBanner({
  accountId,
  currency,
}: Props): Promise<React.JSX.Element | null> {
  const recon = await latestAccountReconciliation(accountId, currency);
  if (!recon.asOf || recon.computedBalance === "0.00") return null;

  const driftMoney = Money.fromString(recon.drift, currency);
  const driftAbs = Math.abs(Number.parseFloat(recon.drift));
  const isOk = driftAbs <= 0.005;
  const imported = recon.importedBalance ? Money.fromString(recon.importedBalance, currency) : null;
  const computed = recon.computedBalance ? Money.fromString(recon.computedBalance, currency) : null;

  return (
    <div
      className={`mt-4 rounded-md border p-3 text-xs ${
        isOk
          ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
          : "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950"
      }`}
    >
      <span className="font-medium">{isOk ? "Reconciled" : "Reconciliation drift"}</span> — Latest
      snapshot <span className="font-mono">{imported?.format() ?? "—"}</span> as of{" "}
      <span className="font-mono">{recon.asOf}</span>; transactions sum to{" "}
      <span className="font-mono">{computed?.format() ?? "—"}</span>
      {!isOk && (
        <>
          {" "}
          (drift <span className="font-mono">{driftMoney.format()}</span>)
        </>
      )}
      .
    </div>
  );
}
