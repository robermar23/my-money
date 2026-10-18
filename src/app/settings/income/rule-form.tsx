"use client";

import { Button } from "@/components/ui/button.tsx";
import { EMPLOYEE_BASIS_OPTIONS, MATCH_BASIS_OPTIONS } from "@/lib/schemas/income.ts";
import { useEffect, useState, useTransition } from "react";
import { type ContributionPreview, previewContributionAction } from "./actions.ts";
import type { HoldingView, RuleView } from "./view-models.ts";

/**
 * The 401k contribution rule editor (P14-14) with its live preview (P14-15).
 *
 * The preview is the point of this form. A contribution rule is the first thing
 * in the app that writes into the investment ledger on a schedule, so the user
 * should see the dollars — per period and annualized — *before* the job runs,
 * not discover them weeks later in their cost basis. It re-computes on a short
 * debounce as the fields change and is strictly read-only: the server action
 * behind it runs the same pure `computeContribution`/`savingsRate` the job and
 * the dashboard use, and writes nothing.
 */

const inputClass =
  "rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

const labelClass = "block font-medium text-xs text-zinc-600 dark:text-zinc-400";

/** How each match basis reads in the picker, and what its value column means. */
const MATCH_LABELS: Record<(typeof MATCH_BASIS_OPTIONS)[number], string> = {
  none: "No employer match",
  percent_of_gross: "% of gross pay",
  percent_of_contribution: "% of my contribution",
  amount: "Fixed amount per period",
};

const EMPLOYEE_LABELS: Record<(typeof EMPLOYEE_BASIS_OPTIONS)[number], string> = {
  percent: "% of gross pay",
  amount: "Fixed amount per period",
};

/** Debounce before asking the server to recompute — one keystroke is not a rule. */
const PREVIEW_DEBOUNCE_MS = 400;

interface Props {
  readonly sourceId: string;
  readonly rule: RuleView | null;
  readonly accounts: readonly { id: string; name: string; institution: string }[];
  readonly holdings: readonly HoldingView[];
  readonly disabled: boolean;
  readonly onSave: (formData: FormData) => void;
  readonly onCancel: () => void;
}

export function RuleForm({
  sourceId,
  rule,
  accounts,
  holdings,
  disabled,
  onSave,
  onCancel,
}: Props): React.JSX.Element {
  const [accountId, setAccountId] = useState(rule?.accountId ?? accounts[0]?.id ?? "");
  const [holdingId, setHoldingId] = useState(rule?.holdingId ?? "");
  const [employeeBasis, setEmployeeBasis] = useState<string>(rule?.employeeBasis ?? "percent");
  const [employeeValue, setEmployeeValue] = useState(rule?.employeeValue ?? "6");
  const [pretax, setPretax] = useState(rule?.pretax ?? true);
  const [matchBasis, setMatchBasis] = useState<string>(rule?.matchBasis ?? "none");
  const [matchValue, setMatchValue] = useState(rule?.matchValue ?? "0");
  const [matchCapPercent, setMatchCapPercent] = useState(rule?.matchCapPercent ?? "");
  const [active, setActive] = useState(rule?.active ?? true);

  const [preview, setPreview] = useState<ContributionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [, startPreview] = useTransition();

  const accountHoldings = holdings.filter((h) => h.accountId === accountId);
  const selectedHolding = accountHoldings.find((h) => h.id === holdingId) ?? null;

  // Recompute the preview whenever a math field settles. Only the math fields
  // are dependencies — switching the target account cannot change the dollars.
  useEffect(() => {
    const timer = setTimeout(() => {
      const fd = new FormData();
      fd.set("incomeSourceId", sourceId);
      fd.set("employeeBasis", employeeBasis);
      fd.set("employeeValue", employeeValue);
      fd.set("matchBasis", matchBasis);
      fd.set("matchValue", matchValue);
      fd.set("matchCapPercent", matchCapPercent);
      startPreview(async () => {
        const result = await previewContributionAction({}, fd);
        setPreviewError(result.error ?? null);
        setPreview(result.preview ?? null);
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sourceId, employeeBasis, employeeValue, matchBasis, matchValue, matchCapPercent]);

  function submit(): void {
    const fd = new FormData();
    fd.set("incomeSourceId", sourceId);
    if (rule) fd.set("id", rule.id);
    fd.set("accountId", accountId);
    fd.set("holdingId", holdingId);
    fd.set("employeeBasis", employeeBasis);
    fd.set("employeeValue", employeeValue);
    if (pretax) fd.set("pretax", "on");
    fd.set("matchBasis", matchBasis);
    fd.set("matchValue", matchValue);
    fd.set("matchCapPercent", matchCapPercent);
    if (active) fd.set("active", "on");
    onSave(fd);
  }

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h4 className="font-medium text-sm">
        {rule ? "Edit contribution rule" : "Add a 401k contribution rule"}
      </h4>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor={`account-${sourceId}`}>
            Retirement account
          </label>
          <select
            id={`account-${sourceId}`}
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setHoldingId(""); // a holding belongs to exactly one account
            }}
            className={`mt-1 w-full ${inputClass}`}
          >
            {accounts.length === 0 && <option value="">No investment accounts yet</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.institution}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor={`holding-${sourceId}`}>
            Holding to buy <span className="font-normal text-zinc-400">(optional)</span>
          </label>
          <select
            id={`holding-${sourceId}`}
            value={holdingId}
            onChange={(e) => setHoldingId(e.target.value)}
            className={`mt-1 w-full ${inputClass}`}
          >
            <option value="">Track dollars only (no share count)</option>
            {accountHoldings.map((h) => (
              <option key={h.id} value={h.id}>
                {h.symbol}
                {h.hasPlaidLots ? " (also synced)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor={`employee-basis-${sourceId}`}>
            My contribution
          </label>
          <div className="mt-1 flex gap-2">
            <input
              aria-label="My contribution value"
              value={employeeValue}
              onChange={(e) => setEmployeeValue(e.target.value)}
              inputMode="decimal"
              className={`w-24 ${inputClass}`}
            />
            <select
              id={`employee-basis-${sourceId}`}
              value={employeeBasis}
              onChange={(e) => setEmployeeBasis(e.target.value)}
              className={`flex-1 ${inputClass}`}
            >
              {EMPLOYEE_BASIS_OPTIONS.map((basis) => (
                <option key={basis} value={basis}>
                  {EMPLOYEE_LABELS[basis]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor={`match-basis-${sourceId}`}>
            Employer match
          </label>
          <div className="mt-1 flex gap-2">
            <input
              aria-label="Employer match value"
              value={matchValue}
              onChange={(e) => setMatchValue(e.target.value)}
              disabled={matchBasis === "none"}
              inputMode="decimal"
              className={`w-24 ${inputClass} disabled:opacity-40`}
            />
            <select
              id={`match-basis-${sourceId}`}
              value={matchBasis}
              onChange={(e) => setMatchBasis(e.target.value)}
              className={`flex-1 ${inputClass}`}
            >
              {MATCH_BASIS_OPTIONS.map((basis) => (
                <option key={basis} value={basis}>
                  {MATCH_LABELS[basis]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor={`cap-${sourceId}`}>
            Match cap <span className="font-normal text-zinc-400">(% of gross, optional)</span>
          </label>
          <input
            id={`cap-${sourceId}`}
            value={matchCapPercent}
            onChange={(e) => setMatchCapPercent(e.target.value)}
            disabled={matchBasis === "none"}
            placeholder="e.g. 4"
            inputMode="decimal"
            className={`mt-1 w-24 ${inputClass} disabled:opacity-40`}
          />
        </div>

        <div className="flex items-end gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={pretax} onChange={(e) => setPretax(e.target.checked)} />
            Pre-tax
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
        </div>
      </div>

      <p className="mt-2 text-xs text-zinc-500">
        “Pre-tax” is a label only — it drives no tax math. This app tracks contributions and cost
        basis, not withholding.
      </p>

      {selectedHolding?.hasPlaidLots && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-amber-900 text-xs dark:bg-amber-950 dark:text-amber-200">
          <strong>Double-count risk.</strong> {selectedHolding.symbol} already has cost-basis lots
          synced from your bank. Contributions add their own lots, so this position’s basis would
          count the same dollars twice. Prefer a holding this rule alone funds, or track dollars
          only.
        </p>
      )}

      {holdingId === "" && (
        <p className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
          Without a holding, contributions record <strong>cost basis in dollars</strong> but no
          share count — the right choice for a plan fund with no public price. Quantity stays
          whatever you enter manually.
        </p>
      )}

      <PreviewPanel preview={preview} error={previewError} />

      <div className="mt-4 flex gap-2">
        <Button
          type="button"
          onClick={submit}
          disabled={disabled || accountId === ""}
          variant="commit"
        >
          {rule ? "Save rule" : "Add rule"}
        </Button>
        <Button type="button" onClick={onCancel} variant="secondary">
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Read-only "what this rule would do" panel (P14-15). */
function PreviewPanel({
  preview,
  error,
}: {
  readonly preview: ContributionPreview | null;
  readonly error: string | null;
}): React.JSX.Element {
  if (error) {
    return (
      <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
        {error}
      </p>
    );
  }
  if (!preview) {
    return (
      <p className="mt-3 text-xs text-zinc-500">Enter a contribution to preview the amounts.</p>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <h5 className="font-medium text-xs text-zinc-600 uppercase dark:text-zinc-400">
        Preview — nothing is saved yet
      </h5>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <Row label={`Per period (${preview.cadence})`} value={preview.totalPerPeriod} />
        <Row label="Gross per period" value={preview.grossPerPeriod} />
        <Row label="My contribution" value={preview.employeePerPeriod} />
        <Row label="Employer match" value={preview.employerPerPeriod} />
        <Row
          label={`Annual (× ${preview.periodsPerYear})`}
          value={preview.annualEmployee}
          hint="mine"
        />
        <Row label="Annual employer" value={preview.annualEmployer} />
      </dl>
      <p className="mt-2 text-sm">
        Projected savings rate:{" "}
        <strong>{preview.ratePct === null ? "—" : `${preview.ratePct}%`}</strong>{" "}
        <span className="text-xs text-zinc-500">
          (my contributions ÷ {preview.annualGross} annualized gross across active sources)
        </span>
      </p>
      {preview.employeeClamped && (
        <p className="mt-2 text-amber-700 text-xs dark:text-amber-300">
          Your fixed contribution is larger than a period’s gross pay, so it was capped at gross.
        </p>
      )}
      {preview.matchCapped && (
        <p className="mt-2 text-xs text-zinc-500">
          The employer match shown is reduced by your cap.
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}): React.JSX.Element {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-zinc-500">
        {label}
        {hint ? <span className="text-zinc-400"> ({hint})</span> : null}
      </dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}
