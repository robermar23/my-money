"use client";

import { Button } from "@/components/ui/button.tsx";
import { useState, useTransition } from "react";
import { mapAccountsAction } from "../../map-actions.ts";

interface CandidateAccount {
  id: string;
  name: string;
  type: string;
  institution: string;
}

interface PlaidAccountRow {
  plaidAccountId: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  mappedType: "depository" | "credit_card" | "investment" | "loan" | null;
  eligibleExisting: CandidateAccount[];
}

interface Props {
  plaidItemPk: string;
  rows: PlaidAccountRow[];
}

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

export function MapAccountsForm({ plaidItemPk, rows }: Props): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Default each row: link to first eligible existing if any, else create.
  const initialActions = Object.fromEntries(
    rows.map((r) => [
      r.plaidAccountId,
      r.eligibleExisting.length > 0
        ? `link:${r.eligibleExisting[0]?.id}`
        : r.mappedType
          ? "create"
          : "skip",
    ]),
  );
  const [actions, setActions] = useState<Record<string, string>>(initialActions);

  const onSubmit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await mapAccountsAction(plaidItemPk, formData);
      if (result?.error) setError(result.error);
    });
  };

  return (
    <form action={onSubmit} className="space-y-6">
      {rows.map((r) => {
        const choice = actions[r.plaidAccountId] ?? "skip";
        return (
          <div
            key={r.plaidAccountId}
            className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">
                  {r.name}
                  {r.mask && (
                    <span className="ml-2 font-mono text-xs text-zinc-500">····{r.mask}</span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  Plaid type: {r.type}
                  {r.subtype && ` · ${r.subtype}`}
                  {r.mappedType
                    ? ` → my-money "${r.mappedType}"`
                    : " · no my-money equivalent (skip or create manually)"}
                </div>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <label className="block text-sm">
                <input
                  type="radio"
                  name={`action_${r.plaidAccountId}`}
                  value="skip"
                  checked={choice === "skip"}
                  onChange={(e) => setActions({ ...actions, [r.plaidAccountId]: e.target.value })}
                />{" "}
                <span className="ml-1">Skip — don't track this account</span>
              </label>

              {r.mappedType && (
                <label className="block text-sm">
                  <input
                    type="radio"
                    name={`action_${r.plaidAccountId}`}
                    value="create"
                    checked={choice === "create"}
                    onChange={(e) => setActions({ ...actions, [r.plaidAccountId]: e.target.value })}
                  />{" "}
                  <span className="ml-1">Create a new my-money account</span>
                  {choice === "create" && (
                    <div className="mt-2 pl-6">
                      <label
                        htmlFor={`create_name_${r.plaidAccountId}`}
                        className="block text-xs text-zinc-500"
                      >
                        Name (defaults to Plaid's name)
                      </label>
                      <input
                        id={`create_name_${r.plaidAccountId}`}
                        name={`create_name_${r.plaidAccountId}`}
                        type="text"
                        placeholder={r.name}
                        defaultValue={r.name}
                        className={fieldClass}
                      />
                    </div>
                  )}
                </label>
              )}

              {r.eligibleExisting.length > 0 && (
                <label className="block text-sm">
                  <input
                    type="radio"
                    name={`action_${r.plaidAccountId}`}
                    value={
                      choice.startsWith("link:") ? choice : `link:${r.eligibleExisting[0]?.id}`
                    }
                    checked={choice.startsWith("link:")}
                    onChange={(e) => setActions({ ...actions, [r.plaidAccountId]: e.target.value })}
                  />{" "}
                  <span className="ml-1">Link to an existing account</span>
                  {choice.startsWith("link:") && (
                    <div className="mt-2 pl-6">
                      <select
                        className={fieldClass}
                        value={choice}
                        onChange={(e) =>
                          setActions({ ...actions, [r.plaidAccountId]: e.target.value })
                        }
                      >
                        {r.eligibleExisting.map((c) => (
                          <option key={c.id} value={`link:${c.id}`}>
                            {c.name} ({c.institution})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </label>
              )}
            </div>
          </div>
        );
      })}

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-red-700 text-sm dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <Button
        type="submit"
        variant="commit"
        size="md"
        className="w-full"
        pending={pending}
        pendingLabel="Mapping…"
      >
        Confirm mapping and start initial sync
      </Button>
    </form>
  );
}
