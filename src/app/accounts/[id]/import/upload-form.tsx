"use client";

import { useState } from "react";
import { useActionState } from "react";
import { type ImportUploadResult, uploadImportAction } from "./actions.ts";

const initial: ImportUploadResult = {};

interface Props {
  readonly accountId: string;
  readonly accountType: "depository" | "credit_card";
}

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

/**
 * Bank presets — saves the user from hand-writing the column mapping JSON.
 * Each preset is a complete CsvColumnMapping; the user can switch to "Custom"
 * to edit it inline.
 */
const PRESETS: Record<string, { label: string; mapping: Record<string, unknown> }> = {
  mt_bank: {
    label: "M&T Bank (headerless, 6 columns)",
    mapping: {
      hasHeader: false,
      date: "1",
      name: "2",
      debit: "3",
      credit: "4",
      amount: "",
      dateFormat: "MM/DD/YYYY",
    },
  },
  generic_signed: {
    label: "Generic — header row, single signed Amount column",
    mapping: {
      date: "Posted Date",
      amount: "Amount",
      name: "Description",
      memo: "Memo",
      dateFormat: "MM/DD/YYYY",
    },
  },
  generic_debit_credit: {
    label: "Generic — header row, separate Debit/Credit columns",
    mapping: {
      date: "Date",
      name: "Description",
      debit: "Debit",
      credit: "Credit",
      amount: "",
      dateFormat: "MM/DD/YYYY",
    },
  },
};

export function UploadForm({ accountId, accountType }: Props): React.JSX.Element {
  const bound = uploadImportAction.bind(null, accountId);
  const [state, action, pending] = useActionState(bound, initial);
  const [showCsvMapping, setShowCsvMapping] = useState(false);
  const [presetKey, setPresetKey] = useState<keyof typeof PRESETS | "custom">("mt_bank");
  const [mappingJson, setMappingJson] = useState(JSON.stringify(PRESETS.mt_bank?.mapping, null, 2));

  function onPresetChange(next: string): void {
    if (next === "custom") {
      setPresetKey("custom");
      return;
    }
    const preset = PRESETS[next];
    if (!preset) return;
    setPresetKey(next as keyof typeof PRESETS);
    setMappingJson(JSON.stringify(preset.mapping, null, 2));
  }

  return (
    <form action={action} className="space-y-4" encType="multipart/form-data">
      <div data-tour="import-file">
        <label htmlFor="file" className="block font-medium text-xs">
          QFX, OFX, or CSV file
        </label>
        <input
          id="file"
          name="file"
          type="file"
          accept=".qfx,.ofx,.csv,application/x-ofx,text/csv"
          required
          className={`${fieldClass} cursor-pointer`}
          onChange={(e) => {
            const name = e.target.files?.[0]?.name?.toLowerCase() ?? "";
            setShowCsvMapping(name.endsWith(".csv"));
          }}
        />
        <p className="mt-1 text-xs text-zinc-500">
          Download a {accountType === "credit_card" ? "credit-card" : "bank"} statement export and
          drop it here. Re-importing the same file is safe — duplicates are skipped automatically.
        </p>
      </div>

      {showCsvMapping && (
        <>
          <div>
            <label htmlFor="csvPreset" className="block font-medium text-xs">
              CSV format
            </label>
            <select
              id="csvPreset"
              value={presetKey}
              onChange={(e) => onPresetChange(e.target.value)}
              className={fieldClass}
            >
              {Object.entries(PRESETS).map(([k, p]) => (
                <option key={k} value={k}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom — edit the JSON below</option>
            </select>
          </div>

          <div>
            <label htmlFor="csvMapping" className="block font-medium text-xs">
              Column mapping (JSON)
            </label>
            <textarea
              id="csvMapping"
              name="csvMapping"
              rows={9}
              value={mappingJson}
              onChange={(e) => {
                setMappingJson(e.target.value);
                setPresetKey("custom");
              }}
              className={`${fieldClass} font-mono text-xs`}
            />
            <p className="mt-1 text-xs text-zinc-500">
              For headerless CSVs (like M&amp;T) set <code>hasHeader: false</code> and reference
              columns by 0-based index ("0", "1", …). Otherwise use the header names from your file.
            </p>
          </div>
        </>
      )}

      {state.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        data-tour="import-upload"
        disabled={pending}
        className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? "Uploading…" : "Upload & preview"}
      </button>
    </form>
  );
}
