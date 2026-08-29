"use client";

import { type CategoryOption, CategoryPicker } from "@/components/category-picker.tsx";
import { OBLIGATION_CADENCES } from "@/lib/schedule/cadence.ts";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { confirmCandidateAction, dismissCandidateAction } from "./actions.ts";
import type { CandidateView } from "./view-models.ts";

/**
 * Candidate review (P16-24, ADR-036 §2).
 *
 * **Preview → confirm, never a silent bulk write.** Every row shows what the
 * detector saw — the cadence it inferred, how much the amount moved, and the
 * actual dated occurrences behind the proposal — before it asks for an answer.
 * The evidence is not decoration: an obligation the user cannot check is one
 * they will either trust blindly or ignore entirely, and both are worse than a
 * short list they understood.
 *
 * "Confirm all high-confidence" is the one bulk affordance, and it is still a
 * click per candidate under the hood rather than a server-side sweep — so a
 * failure part-way through leaves the successful ones confirmed and says which
 * failed, instead of an all-or-nothing rollback the user cannot interpret.
 *
 * Money arrives pre-formatted from the server (CLAUDE.md §Money). The only
 * amount this component handles as a value is the editable field, which
 * round-trips as an unparsed string.
 */

interface Props {
  readonly candidates: readonly CandidateView[];
  readonly categories: readonly CategoryOption[];
}

const CONFIDENCE_LABEL: Record<CandidateView["confidence"], string> = {
  high: "Strong match",
  medium: "Likely",
  low: "Possible",
};

const inputClass =
  "rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export function CandidateReview({ candidates, categories }: Props): React.JSX.Element {
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkPending, startBulk] = useTransition();
  const router = useRouter();

  const visible = candidates.filter((c) => !settled.has(key(c)));
  const highConfidence = visible.filter((c) => c.confidence === "high");

  function settle(candidate: CandidateView): void {
    setSettled((prev) => new Set(prev).add(key(candidate)));
  }

  function confirmAllHighConfidence(): void {
    setBulkError(null);
    startBulk(async () => {
      const failed: string[] = [];
      for (const candidate of highConfidence) {
        const result = await confirmCandidateAction({}, formDataFor(candidate));
        if (result.error) failed.push(candidate.label);
        else settle(candidate);
      }
      if (failed.length > 0) {
        setBulkError(`Could not confirm: ${failed.join(", ")}. The rest were added.`);
      }
      router.refresh();
    });
  }

  if (visible.length === 0) {
    return (
      <p className="mt-3 text-sm text-zinc-500">
        No new suggestions. New ones appear as your transaction history grows — a series needs
        several occurrences before it can be told apart from a coincidence.
      </p>
    );
  }

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="text-sm text-zinc-500">
          {visible.length} suggestion{visible.length === 1 ? "" : "s"} from your history. Nothing is
          added until you confirm it.
        </p>
        {highConfidence.length > 0 && (
          <button
            type="button"
            onClick={confirmAllHighConfidence}
            disabled={bulkPending}
            className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-sm disabled:opacity-50 dark:border-zinc-700"
          >
            {bulkPending
              ? "Confirming…"
              : `Confirm ${highConfidence.length} strong match${highConfidence.length === 1 ? "" : "es"}`}
          </button>
        )}
      </div>
      {bulkError && (
        <p role="alert" className="mt-2 text-red-600 text-sm dark:text-red-400">
          {bulkError}
        </p>
      )}

      <ul className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-900">
        {visible.map((candidate) => (
          <CandidateRow
            key={key(candidate)}
            candidate={candidate}
            categories={categories}
            onSettled={() => settle(candidate)}
          />
        ))}
      </ul>
    </>
  );
}

function CandidateRow({
  candidate,
  categories,
  onSettled,
}: {
  readonly candidate: CandidateView;
  readonly categories: readonly CategoryOption[];
  readonly onSettled: () => void;
}): React.JSX.Element {
  const fieldId = useId();
  const [label, setLabel] = useState(candidate.label);
  const [amount, setAmount] = useState(candidate.expectedAmount);
  const [cadence, setCadence] = useState<string>(candidate.cadence);
  const [categoryId, setCategoryId] = useState<string | null>(candidate.categoryId);
  const [showEvidence, setShowEvidence] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function run(action: () => Promise<{ error?: string }>): void {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setError(result.error);
        return;
      }
      onSettled();
      router.refresh();
    });
  }

  const evidenceId = `${fieldId}-evidence`;
  const errorId = `${fieldId}-error`;

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-sm">{candidate.sampleName}</span>
        <span className="text-xs text-zinc-500">
          {candidate.accountName} · {CONFIDENCE_LABEL[candidate.confidence]} ·{" "}
          {candidate.direction === "outflow" ? "payment" : "receipt"}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {candidate.evidence.length} occurrences, {candidate.cadence}, {candidate.expectedDisplay}{" "}
        each
        {candidate.amountMode === "trailing_median"
          ? ` (varies by about ${candidate.spreadDisplay})`
          : ""}
        . Last seen {candidate.lastSeen}.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          <span>Name</span>
          <input
            id={`${fieldId}-label`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={inputClass}
            aria-invalid={error !== null || undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          <span>Amount</span>
          <input
            id={`${fieldId}-amount`}
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            className={`${inputClass} w-28`}
            aria-describedby={error ? errorId : undefined}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          <span>Repeats</span>
          <select
            id={`${fieldId}-cadence`}
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            className={inputClass}
          >
            {OBLIGATION_CADENCES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-xs text-zinc-500">
          <span id={`${fieldId}-category-label`}>Category</span>
          <CategoryPicker
            categories={categories}
            value={categoryId}
            onChange={setCategoryId}
            disabled={pending}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(() =>
              confirmCandidateAction(
                {},
                formDataFor({ ...candidate, label, expectedAmount: amount, categoryId }, cadence),
              ),
            )
          }
          className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {pending ? "Saving…" : "Confirm"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => dismissCandidateAction({}, dismissFormData(candidate, "")))}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
        >
          Not a bill
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => dismissCandidateAction({}, dismissFormData(candidate, "90")))}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
        >
          Ask me in 90 days
        </button>
        <button
          type="button"
          onClick={() => setShowEvidence((open) => !open)}
          aria-expanded={showEvidence}
          aria-controls={evidenceId}
          className="rounded-md px-2 py-1.5 text-sm text-zinc-500 underline"
        >
          {showEvidence ? "Hide the charges" : "Show the charges"}
        </button>
      </div>

      {error && (
        <p id={errorId} role="alert" className="mt-2 text-red-600 text-sm dark:text-red-400">
          {error}
        </p>
      )}

      {showEvidence && (
        <ul id={evidenceId} className="mt-3 space-y-1 text-xs text-zinc-500">
          {candidate.evidence.map((occurrence) => (
            <li key={`${occurrence.date}-${occurrence.amountDisplay}`}>
              {occurrence.date} · {occurrence.amountDisplay}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The identity of a candidate — the same pair a dismissal is stored under. */
function key(candidate: CandidateView): string {
  return `${candidate.accountId} ${candidate.detectionKey}`;
}

/** Build the confirm payload. `confidence` is deliberately absent (see actions.ts). */
function formDataFor(candidate: CandidateView, cadence?: string): FormData {
  const form = new FormData();
  form.set("accountId", candidate.accountId);
  form.set("detectionKey", candidate.detectionKey);
  form.set("categoryId", candidate.categoryId ?? "");
  form.set("label", candidate.label);
  form.set("expectedAmount", candidate.expectedAmount);
  form.set("direction", candidate.direction);
  form.set("cadence", cadence ?? candidate.cadence);
  form.set("anchorDate", candidate.anchorDate);
  form.set("startDate", candidate.startDate);
  form.set("amountMode", candidate.amountMode);
  return form;
}

function dismissFormData(candidate: CandidateView, snoozeDays: string): FormData {
  const form = new FormData();
  form.set("accountId", candidate.accountId);
  form.set("detectionKey", candidate.detectionKey);
  form.set("snoozeDays", snoozeDays);
  return form;
}
