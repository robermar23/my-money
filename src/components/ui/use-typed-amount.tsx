"use client";

import { useState } from "react";
import { formatTypedAmount } from "./typed-amount.ts";

/** What {@link useTypedAmount} hands back to a form. */
export interface TypedAmount {
  /** Put on the amount input. */
  readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** Put on the form, so the label clears when React resets it after a save. */
  readonly onReset: () => void;
  /** " · $1,234.56" for the button label, or null while the amount is not valid. */
  readonly suffix: React.ReactNode;
}

/**
 * Follows an amount input so the commit button can name the amount it is about
 * to write: "Save balance · $1,234.56".
 *
 * Args:
 *   currency: The account's ISO 4217 code.
 *
 * Returns:
 *   The input and form handlers, and the label suffix.
 */
export function useTypedAmount(currency: string): TypedAmount {
  const [raw, setRaw] = useState("");
  const formatted = formatTypedAmount(raw, currency);
  return {
    onChange: (event) => setRaw(event.target.value),
    onReset: () => setRaw(""),
    suffix: formatted && (
      <>
        <span aria-hidden="true">·</span>
        <span className="font-mono">{formatted}</span>
      </>
    ),
  };
}
