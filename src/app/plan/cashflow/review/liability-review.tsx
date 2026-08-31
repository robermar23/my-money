"use client";

import { type CategoryOption, CategoryPicker } from "@/components/category-picker.tsx";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { confirmLiabilityCandidateAction, dismissLiabilityCandidateAction } from "./actions.ts";
import type { LiabilityCandidateView } from "./view-models.ts";

/**
 * Schedules proposed from stated loan terms (CF-A5, ADR-047).
 *
 * Rendered ABOVE the detector's suggestions, under its own heading, and the
 * separation is the design rather than a ranking tweak. A detected series is a
 * guess with a confidence grade; this is a fact the household already typed into
 * the app. Mixing them would ask the user to grade a fact as if it were a
 * heuristic — so there is no confidence badge here, because nothing was guessed.
 *
 * ── What each row has to say before it asks for an answer ──────────────────
 *   - **Both amounts, side by side.** The proposal, and the computed
 *     principal-and-interest beside it. The gap between them IS the household's
 *     escrow, and it is worth seeing once.
 *   - **The escrow caveat, in words**, whenever the figure is P&I alone. A
 *     mortgage figure that is quietly a few hundred dollars light is worse than
 *     no figure, because it looks right.
 *   - **A collision warning** when the detector has *also* proposed something
 *     that looks like this payment. Confirming both would put the same money on
 *     the calendar twice, and nothing structural can stop that — they are two
 *     legitimately different rows — so it is stated plainly instead.
 *   - **An account selector** whenever the app cannot tell which account pays
 *     it. Attaching the largest bill in the month to the wrong balance moves the
 *     low-water date, which is the number this whole surface exists to state.
 *
 * Money arrives pre-formatted from the server (CLAUDE.md §Money). The only
 * amount this component handles as a value is the editable field, which
 * round-trips as an unparsed string.
 */

interface Props {
  readonly candidates: readonly LiabilityCandidateView[];
  readonly categories: readonly CategoryOption[];
}

const inputClass =
  "rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export function LiabilityReview({ candidates, categories }: Props): React.JSX.Element | null {
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const visible = candidates.filter((candidate) => !settled.has(candidate.liabilityId));

  // Absent rather than empty: a household with no loan on file should not be
  // told about a feature that has nothing to say to them.
  if (visible.length === 0) return null;

  return (
    <section aria-labelledby="loan-schedules-heading" className="mt-8">
      <h2 id="loan-schedules-heading" className="font-medium text-lg">
        From your loan terms
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        You have already told this app what these loans cost. Adding one to the calendar puts the
        payment on its real date instead of leaving it spread across the month — it does not change
        what you spend.
      </p>

      <ul className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-900">
        {visible.map((candidate) => (
          <LiabilityRow
            key={candidate.liabilityId}
            candidate={candidate}
            categories={categories}
            onSettled={() => setSettled((prev) => new Set(prev).add(candidate.liabilityId))}
          />
        ))}
      </ul>
    </section>
  );
}

function LiabilityRow({
  candidate,
  categories,
  onSettled,
}: {
  readonly candidate: LiabilityCandidateView;
  readonly categories: readonly CategoryOption[];
  readonly onSettled: () => void;
}): React.JSX.Element {
  const fieldId = useId();
  const [label, setLabel] = useState(candidate.label);
  const [amount, setAmount] = useState(candidate.expectedAmount);
  const [accountId, setAccountId] = useState<string>(
    candidate.accountId ?? candidate.accountOptions[0]?.id ?? "",
  );
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const evidenceId = `${fieldId}-evidence`;
  const errorId = `${fieldId}-error`;
  const noAccounts = candidate.accountOptions.length === 0;

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

  function confirmForm(): FormData {
    const form = new FormData();
    form.set("liabilityId", candidate.liabilityId);
    form.set("accountId", accountId);
    form.set("categoryId", categoryId ?? "");
    form.set("label", label);
    form.set("expectedAmount", amount);
    return form;
  }

  function dismissForm(snoozeDays: string): FormData {
    const form = new FormData();
    form.set("liabilityId", candidate.liabilityId);
    form.set("snoozeDays", snoozeDays);
    return form;
  }

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-sm">{candidate.label}</span>
        <span className="text-xs text-zinc-500">
          From your loan terms · monthly
          {candidate.sampleName === null ? "" : ` · ${candidate.sampleName}`}
        </span>
      </div>

      <p className="mt-1 text-xs text-zinc-500">
        {candidate.observedDisplay === null ? (
          <>
            {candidate.expectedDisplay} a month in principal and interest, from the rate and term
            you recorded.
          </>
        ) : (
          <>
            {candidate.observedDisplay} a month across {candidate.observedCount} payments ·{" "}
            {candidate.scheduledDisplay} of that is principal and interest
            {candidate.spreadDisplay === null
              ? ""
              : `, and it varies by about ${candidate.spreadDisplay}`}
            .
          </>
        )}
      </p>

      {candidate.escrowCaveat && (
        <p className="mt-2 max-w-2xl text-amber-700 text-xs dark:text-amber-400">
          This is principal and interest only — property tax, insurance and PMI are not in it, so
          your real payment is probably higher. Once a few payments are imported the calendar uses
          what actually left your account; until then, correct the amount here if you know it.
        </p>
      )}

      {candidate.collision !== null && (
        <p className="mt-2 max-w-2xl text-amber-700 text-xs dark:text-amber-400">
          {candidate.collision}
        </p>
      )}

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
          <span>Paid from</span>
          <select
            id={`${fieldId}-account`}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className={inputClass}
            disabled={noAccounts}
          >
            {candidate.accountOptions.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
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

      {noAccounts && (
        <p className="mt-2 max-w-2xl text-xs text-zinc-500">
          No account is marked as checking or cash management yet, so there is nowhere to pay this
          from. Classify one and this can go on the calendar.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || noAccounts}
          onClick={() => run(() => confirmLiabilityCandidateAction({}, confirmForm()))}
          className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {pending ? "Saving…" : "Add to calendar"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => dismissLiabilityCandidateAction({}, dismissForm("")))}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
        >
          I do not pay this from here
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => dismissLiabilityCandidateAction({}, dismissForm("90")))}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
        >
          Ask me in 90 days
        </button>
        {candidate.evidence.length > 0 && (
          <button
            type="button"
            onClick={() => setShowEvidence((open) => !open)}
            aria-expanded={showEvidence}
            aria-controls={evidenceId}
            className="rounded-md px-2 py-1.5 text-sm text-zinc-500 underline"
          >
            {showEvidence ? "Hide the payments" : "Show the payments"}
          </button>
        )}
      </div>

      {error && (
        <p id={errorId} role="alert" className="mt-2 text-red-600 text-sm dark:text-red-400">
          {error}
        </p>
      )}

      {showEvidence && (
        <ul id={evidenceId} className="mt-3 space-y-1 text-xs text-zinc-500">
          {candidate.evidence.map((payment) => (
            <li key={`${payment.date}-${payment.amountDisplay}`}>
              {payment.date} · {payment.amountDisplay}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
