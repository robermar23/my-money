"use client";

import {
  DEFAULT_HIGH_INTEREST_THRESHOLD_APR,
  DEFAULT_RESERVE_MONTHS,
  DEFAULT_SPLIT,
  ELEVATED_RESERVE_MONTHS,
} from "@/lib/advice/constants.ts";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import {
  type HouseholdActionResult,
  createHouseholdMemberAction,
  deleteHouseholdMemberAction,
  saveHouseholdProfileAction,
  updateHouseholdMemberAction,
} from "./actions.ts";

/**
 * P15-32 — the household settings island: profile overrides + member CRUD.
 *
 * ── Every field here is an OVERRIDE, and blank is the normal state ─────────
 * The defaults live in `src/lib/advice/constants.ts` where they are reviewable
 * and testable. This form shows each one as a PLACEHOLDER, never as a
 * pre-filled value: pre-filling would silently convert "I have no opinion" into
 * a stored opinion the first time the user saved anything, and that household
 * would stop tracking the constant forever without ever choosing to.
 *
 * The placeholders exist because a blank box labelled "reserve months" tells the
 * user nothing about what happens if they leave it blank. Showing "3 or 6,
 * chosen from your household" is the difference between an empty field that
 * looks broken and one that reads as a deliberate default.
 */

const initial: HouseholdActionResult = {};

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

const inputClass =
  "rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export interface ProfileView {
  readonly reserveMonthsOverride: string;
  readonly retirementTargetAge: string;
  readonly benchmarkSavingsApy: string;
  readonly needsPct: string;
  readonly wantsPct: string;
  readonly savingsPct: string;
  readonly highInterestThresholdApr: string;
}

export interface MemberView {
  readonly id: string;
  readonly label: string;
  readonly birthYear: string;
  readonly isDependent: boolean;
}

interface Props {
  readonly profile: ProfileView | null;
  readonly members: readonly MemberView[];
}

export function HouseholdManager({ profile, members }: Props): React.JSX.Element {
  return (
    <>
      <ProfileForm profile={profile} />
      <MembersSection members={members} />
    </>
  );
}

function ProfileForm({ profile }: { readonly profile: ProfileView | null }): React.JSX.Element {
  const [state, action, pending] = useActionState(saveHouseholdProfileAction, initial);

  return (
    <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-medium">Your preferences</h2>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        All optional. Leave a field blank to use the conventional default shown in it — the app
        tracks those defaults for you, so blank is not an unfinished setting.
      </p>

      <form action={action} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="hh-reserve" className="block font-medium text-xs">
            Emergency fund (months of essential expenses)
          </label>
          <input
            id="hh-reserve"
            name="reserveMonthsOverride"
            type="text"
            inputMode="numeric"
            defaultValue={profile?.reserveMonthsOverride ?? ""}
            placeholder={`${DEFAULT_RESERVE_MONTHS} or ${ELEVATED_RESERVE_MONTHS}, chosen for you`}
            className={`${fieldClass} font-mono`}
          />
          <p className="mt-1 text-xs text-zinc-500">
            Left blank, {ELEVATED_RESERVE_MONTHS} months is used when you have dependents or a
            single income source, {DEFAULT_RESERVE_MONTHS} otherwise.
          </p>
        </div>

        <div>
          <label htmlFor="hh-retire" className="block font-medium text-xs">
            Target retirement age
          </label>
          <input
            id="hh-retire"
            name="retirementTargetAge"
            type="text"
            inputMode="numeric"
            defaultValue={profile?.retirementTargetAge ?? ""}
            placeholder="65"
            className={`${fieldClass} font-mono`}
          />
          <p className="mt-1 text-xs text-zinc-500">
            Used for framing and catch-up eligibility only. Nothing here projects a retirement
            balance.
          </p>
        </div>

        <div>
          <label htmlFor="hh-apy" className="block font-medium text-xs">
            Savings yield you could get (%)
          </label>
          <input
            id="hh-apy"
            name="benchmarkSavingsApy"
            type="text"
            inputMode="decimal"
            defaultValue={profile?.benchmarkSavingsApy ?? ""}
            placeholder="4.5 for 4.5%"
            className={`${fieldClass} font-mono`}
          />
          <p className="mt-1 text-xs text-zinc-500">
            Your number, not a fetched market rate — the app never calls out to check one. Set it
            and idle cash can be shown against the yield it is missing.
          </p>
        </div>

        <div>
          <label htmlFor="hh-threshold" className="block font-medium text-xs">
            Where "high-interest debt" starts
          </label>
          <input
            id="hh-threshold"
            name="highInterestThresholdApr"
            type="text"
            inputMode="decimal"
            defaultValue={profile?.highInterestThresholdApr ?? ""}
            placeholder={`${DEFAULT_HIGH_INTEREST_THRESHOLD_APR} for 7%`}
            className={`${fieldClass} font-mono`}
          />
          <p className="mt-1 text-xs text-zinc-500">
            A decimal fraction. This line decides whether a debt gets paid down before you invest
            the same dollar — a judgement call, so it is yours to move.
          </p>
        </div>

        <fieldset className="col-span-full">
          <legend className="font-medium text-xs">Needs / wants / savings target (%)</legend>
          <p className="mt-1 max-w-3xl text-xs text-zinc-500">
            Defaults to {DEFAULT_SPLIT.needs.replace(".00", "")}/
            {DEFAULT_SPLIT.wants.replace(".00", "")}/{DEFAULT_SPLIT.savings.replace(".00", "")}.
            That split assumes a cost of living it does not measure, so change it if it does not
            describe where you live. Set all three or none; they must add up to 100.
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            <label className="text-xs">
              Needs
              <input
                name="needsPct"
                type="text"
                inputMode="decimal"
                defaultValue={profile?.needsPct ?? ""}
                placeholder={DEFAULT_SPLIT.needs.replace(".00", "")}
                className={`${fieldClass} w-24 font-mono`}
              />
            </label>
            <label className="text-xs">
              Wants
              <input
                name="wantsPct"
                type="text"
                inputMode="decimal"
                defaultValue={profile?.wantsPct ?? ""}
                placeholder={DEFAULT_SPLIT.wants.replace(".00", "")}
                className={`${fieldClass} w-24 font-mono`}
              />
            </label>
            <label className="text-xs">
              Savings
              <input
                name="savingsPct"
                type="text"
                inputMode="decimal"
                defaultValue={profile?.savingsPct ?? ""}
                placeholder={DEFAULT_SPLIT.savings.replace(".00", "")}
                className={`${fieldClass} w-24 font-mono`}
              />
            </label>
          </div>
        </fieldset>

        {state.error && (
          <p className="col-span-full rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
            {state.error}
          </p>
        )}
        {state.ok && (
          <p className="col-span-full rounded-md bg-emerald-50 px-3 py-2 text-emerald-700 text-xs dark:bg-emerald-950 dark:text-emerald-300">
            Saved.
          </p>
        )}
        <div className="col-span-full">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {pending ? "Saving…" : "Save preferences"}
          </button>
        </div>
      </form>
    </section>
  );
}

function MembersSection({
  members,
}: {
  readonly members: readonly MemberView[];
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [addState, addAction, addPending] = useActionState(createHouseholdMemberAction, initial);

  function run(fn: () => Promise<HouseholdActionResult>): void {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-medium">Who lives here ({members.length})</h2>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        Only one thing here changes a number: whether anyone depends on this income, which raises
        the emergency-fund target from {DEFAULT_RESERVE_MONTHS} months to {ELEVATED_RESERVE_MONTHS}.
        The name is so you can tell the rows apart, and the year — not a full date — is all any
        age-based guidance needs.
      </p>

      {error && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {members.length > 0 && (
        <ul className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-900">
          {members.map((member) => (
            <MemberRow key={member.id} member={member} disabled={pending} onRun={run} />
          ))}
        </ul>
      )}

      <form action={addAction} className="mt-5 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="hh-label" className="block font-medium text-xs">
            Name or label
          </label>
          <input
            id="hh-label"
            name="label"
            type="text"
            required
            maxLength={80}
            placeholder="Me"
            className={`mt-1 ${inputClass}`}
          />
        </div>
        <div>
          <label htmlFor="hh-birth" className="block font-medium text-xs">
            Birth year
          </label>
          <input
            id="hh-birth"
            name="birthYear"
            type="text"
            inputMode="numeric"
            placeholder="1985"
            className={`mt-1 w-24 font-mono ${inputClass}`}
          />
        </div>
        <label className="flex items-center gap-1.5 pb-1.5 text-xs">
          <input type="checkbox" name="isDependent" />
          Depends on this income
        </label>
        <button
          type="submit"
          disabled={addPending}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
        >
          {addPending ? "Adding…" : "Add person"}
        </button>
        {addState.error && (
          <p className="w-full text-red-600 text-xs dark:text-red-400">{addState.error}</p>
        )}
      </form>
    </section>
  );
}

function MemberRow({
  member,
  disabled,
  onRun,
}: {
  readonly member: MemberView;
  readonly disabled: boolean;
  readonly onRun: (fn: () => Promise<HouseholdActionResult>) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(member.label);
  const [birthYear, setBirthYear] = useState(member.birthYear);
  const [isDependent, setIsDependent] = useState(member.isDependent);

  function save(): void {
    onRun(async () => {
      const res = await updateHouseholdMemberAction(member.id, { label, birthYear, isDependent });
      if (!res.error) setEditing(false);
      return res;
    });
  }

  if (editing) {
    return (
      <li className="flex flex-wrap items-center gap-2 py-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-label="Name or label"
          className={inputClass}
        />
        <input
          value={birthYear}
          onChange={(e) => setBirthYear(e.target.value)}
          aria-label="Birth year"
          inputMode="numeric"
          className={`w-24 font-mono ${inputClass}`}
        />
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={isDependent}
            onChange={(e) => setIsDependent(e.target.checked)}
          />
          Depends on this income
        </label>
        <div className="ml-auto flex gap-1.5">
          <button
            type="button"
            disabled={disabled}
            onClick={save}
            className="rounded bg-zinc-900 px-2 py-0.5 text-white text-xs disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700"
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <span>{member.label}</span>
      <span className="text-xs text-zinc-500">
        {member.birthYear ? `born ${member.birthYear}` : "birth year not recorded"}
        {member.isDependent && " · dependent"}
      </span>
      <div className="ml-auto flex gap-1.5">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700"
        >
          Edit
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRun(() => deleteHouseholdMemberAction(member.id))}
          className="rounded border border-red-300 px-2 py-0.5 text-red-700 text-xs disabled:opacity-50 dark:border-red-800 dark:text-red-300"
        >
          Remove
        </button>
      </div>
    </li>
  );
}
