"use client";

import { Button } from "@/components/ui/button.tsx";
import { useActionState, useState } from "react";
import { type CreateAccountResult, createAccountAction, createAssetAction } from "./actions.ts";

const initial: CreateAccountResult = {};

const TYPES = [
  { value: "depository", label: "Cash (checking / savings)" },
  { value: "credit_card", label: "Credit card" },
  { value: "investment", label: "Investment / brokerage / 401k" },
  { value: "crypto_ira", label: "Crypto or metals IRA" },
  { value: "loan", label: "Loan (mortgage)" },
  { value: "property", label: "Property (home)" },
  { value: "personal_asset", label: "Personal asset (vehicle, boat, jewelry…)" },
] as const;

/** Asset categories — labels mirror ASSET_CATEGORIES in schemas/account.ts. */
const ASSET_CATEGORY_OPTIONS = [
  { value: "vehicle", label: "Vehicle" },
  { value: "watercraft", label: "Boat & watercraft" },
  { value: "jewelry", label: "Jewelry & watches" },
  { value: "collectible", label: "Art & collectibles" },
  { value: "other", label: "Other" },
] as const;

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

/**
 * Account-creation form. A `personal_asset` selection (ADR-023) swaps the
 * Institution field for the asset metadata fields and routes the submit to
 * `createAssetAction` instead of `createAccountAction`; the institution sentinel
 * is set server-side, so the asset path never surfaces it.
 */
export function NewAccountForm(): React.JSX.Element {
  const [type, setType] = useState<string>("depository");
  // Both hooks are always called (Rules of Hooks); only the active one's state
  // and submit drive the rendered form for the current type selection.
  const [financialState, financialAction, financialPending] = useActionState(
    createAccountAction,
    initial,
  );
  const [assetState, assetAction, assetPending] = useActionState(createAssetAction, initial);

  const isAsset = type === "personal_asset";
  const state = isAsset ? assetState : financialState;
  const action = isAsset ? assetAction : financialAction;
  const pending = isAsset ? assetPending : financialPending;

  const typePicker = (
    <div>
      <label htmlFor="type" className="block font-medium text-sm">
        Type
      </label>
      <select
        id="type"
        name="type"
        required
        value={type}
        onChange={(e) => setType(e.target.value)}
        className={fieldClass}
      >
        {TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );

  const nameField = (placeholder: string) => (
    <div>
      <label htmlFor="name" className="block font-medium text-sm">
        Name
      </label>
      <input
        id="name"
        name="name"
        type="text"
        required
        maxLength={120}
        placeholder={placeholder}
        className={fieldClass}
      />
    </div>
  );

  const currencyField = (
    <div>
      <label htmlFor="currency" className="block font-medium text-sm">
        Currency
      </label>
      <input
        id="currency"
        name="currency"
        type="text"
        defaultValue="USD"
        maxLength={3}
        minLength={3}
        className={fieldClass}
      />
    </div>
  );

  const errorBox = state.error && (
    <p className="rounded-md bg-red-50 px-3 py-2 text-red-700 text-sm dark:bg-red-950 dark:text-red-300">
      {state.error}
    </p>
  );

  if (isAsset) {
    // Asset path: no Institution field (set server-side); reveal asset metadata.
    return (
      <form action={action} className="space-y-4">
        {nameField("2021 Toyota Tacoma")}
        {typePicker}
        <div>
          <label htmlFor="assetCategory" className="block font-medium text-sm">
            Category
          </label>
          <select id="assetCategory" name="assetCategory" required className={fieldClass}>
            {ASSET_CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="description" className="block font-medium text-sm">
            Description <span className="text-zinc-400">(optional)</span>
          </label>
          <input
            id="description"
            name="description"
            type="text"
            maxLength={2000}
            placeholder="Make, model, year, notes"
            className={fieldClass}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="acquiredAt" className="block font-medium text-sm">
              Acquired <span className="text-zinc-400">(optional)</span>
            </label>
            <input id="acquiredAt" name="acquiredAt" type="date" className={fieldClass} />
          </div>
          <div>
            <label htmlFor="acquisitionCost" className="block font-medium text-sm">
              Acquisition cost <span className="text-zinc-400">(optional)</span>
            </label>
            <input
              id="acquisitionCost"
              name="acquisitionCost"
              type="text"
              inputMode="decimal"
              placeholder="32000.00"
              className={`${fieldClass} font-mono`}
            />
          </div>
        </div>
        {currencyField}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="initialValueDate" className="block font-medium text-sm">
              Initial value date <span className="text-zinc-400">(optional)</span>
            </label>
            <input
              id="initialValueDate"
              name="initialValueDate"
              type="date"
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="initialValue" className="block font-medium text-sm">
              Initial value <span className="text-zinc-400">(optional)</span>
            </label>
            <input
              id="initialValue"
              name="initialValue"
              type="text"
              inputMode="decimal"
              placeholder="30000.00"
              className={`${fieldClass} font-mono`}
            />
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          Record a value now to include the asset in net worth immediately, or leave it blank and
          add one later.
        </p>
        {errorBox}
        <Button
          type="submit"
          variant="commit"
          size="md"
          className="w-full"
          pending={pending}
          pendingLabel="Creating…"
        >
          Create asset
        </Button>
      </form>
    );
  }

  // Financial-account path (unchanged behavior).
  return (
    <form action={action} className="space-y-4">
      {nameField("M&T Checking")}
      <div>
        <label htmlFor="institution" className="block font-medium text-sm">
          Institution
        </label>
        <input
          id="institution"
          name="institution"
          type="text"
          required
          maxLength={120}
          placeholder="M&T Bank"
          className={fieldClass}
        />
      </div>
      {typePicker}
      {currencyField}
      {errorBox}
      <Button
        type="submit"
        variant="commit"
        size="md"
        className="w-full"
        pending={pending}
        pendingLabel="Creating…"
      >
        Create account
      </Button>
    </form>
  );
}
