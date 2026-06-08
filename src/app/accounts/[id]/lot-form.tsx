"use client";

import { useRouter } from "next/navigation";
import { useActionState, useTransition } from "react";
import { type ActionResult, addLotAction, deleteLotAction } from "./actions.ts";

/**
 * P5-18 — Per-holding cost-basis lot editor.
 *
 * Lists existing lots with a delete control and an "Add lot" form. Adding or
 * removing lots drives the resolved cost basis (sum of lots) shown in the
 * holdings table; the server action stamps the holding so a Plaid sync won't
 * clobber the user's basis.
 */

const initial: ActionResult = {};

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

export interface LotView {
  readonly id: string;
  readonly acquiredAt: string | null;
  readonly quantity: string;
  readonly costBasisTotal: string;
  readonly perUnit: string;
  readonly source: string;
}

interface Props {
  readonly accountId: string;
  readonly holdingId: string;
  readonly symbol: string;
  readonly currency: string;
  readonly lots: readonly LotView[];
  /** "Lots cover N of M shares" when lots disagree with the position; else null. */
  readonly coverageNote: string | null;
}

export function LotsEditor({
  accountId,
  holdingId,
  symbol,
  currency,
  lots,
  coverageNote,
}: Props): React.JSX.Element {
  const router = useRouter();
  const bound = addLotAction.bind(null, accountId, holdingId);
  const [state, action, pending] = useActionState(bound, initial);
  const [deleting, startDelete] = useTransition();

  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });

  const onDelete = (lotId: string) => {
    startDelete(async () => {
      await deleteLotAction(accountId, holdingId, lotId);
      router.refresh();
    });
  };

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
        <span className="font-mono">{symbol}</span> — {lots.length} lot
        {lots.length === 1 ? "" : "s"}
        {coverageNote && (
          <span className="ml-2 text-amber-600 dark:text-amber-400">{coverageNote}</span>
        )}
      </summary>

      <div className="mt-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        {lots.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="text-left text-xs text-zinc-500 uppercase">
                <tr>
                  <th className="py-1">Acquired</th>
                  <th className="py-1 text-right">Quantity</th>
                  <th className="py-1 text-right">Cost basis</th>
                  <th className="py-1 text-right">Per unit</th>
                  <th className="py-1">Source</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {lots.map((lot) => (
                  <tr key={lot.id}>
                    <td className="py-1 font-mono">{lot.acquiredAt ?? "—"}</td>
                    <td className="py-1 text-right font-mono">{lot.quantity}</td>
                    <td className="py-1 text-right font-mono">
                      {fmt.format(Number(lot.costBasisTotal))}
                    </td>
                    <td className="py-1 text-right font-mono">{fmt.format(Number(lot.perUnit))}</td>
                    <td className="py-1 text-zinc-500">{lot.source}</td>
                    <td className="py-1 text-right">
                      <button
                        type="button"
                        onClick={() => onDelete(lot.id)}
                        disabled={deleting}
                        className="text-red-600 text-xs hover:underline disabled:opacity-50 dark:text-red-400"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form action={action} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div>
            <label htmlFor={`acquiredAt-${holdingId}`} className="block font-medium text-xs">
              Acquired (optional)
            </label>
            <input
              id={`acquiredAt-${holdingId}`}
              name="acquiredAt"
              type="date"
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor={`quantity-${holdingId}`} className="block font-medium text-xs">
              Quantity
            </label>
            <input
              id={`quantity-${holdingId}`}
              name="quantity"
              type="text"
              inputMode="decimal"
              required
              placeholder="10"
              className={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <label htmlFor={`costBasisTotal-${holdingId}`} className="block font-medium text-xs">
              Cost basis ($)
            </label>
            <input
              id={`costBasisTotal-${holdingId}`}
              name="costBasisTotal"
              type="text"
              inputMode="decimal"
              required
              placeholder="1000.00"
              className={`${fieldClass} font-mono`}
            />
          </div>
          {state.error && (
            <p className="col-span-full rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
              {state.error}
            </p>
          )}
          <div className="col-span-full">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {pending ? "Adding…" : "Add lot"}
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}
