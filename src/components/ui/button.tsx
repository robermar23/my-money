"use client";

import { useEffect, useRef, useState } from "react";
import { type ButtonSize, type ButtonVariant, buttonClass } from "./button-styles.ts";

/** How long the "Saved" confirmation stays on the button, in milliseconds. */
const SUCCESS_MS = 1600;

interface Props extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  /** What a click does; see `button-styles.ts`. Defaults to `secondary`. */
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Layout classes only (margins, width). */
  readonly className?: string;
  /** True while the action runs. Disables the button and shows `pendingLabel`. */
  readonly pending?: boolean;
  /** The label while pending, such as "Saving…". */
  readonly pendingLabel?: string;
  /**
   * Whether the action worked, read at the moment `pending` turns false. When
   * true the button shows a check and `successLabel` briefly. Leave it unset
   * for actions with no success signal (a refresh, a navigation).
   */
  readonly succeeded?: boolean;
  /** The label after a successful action. Defaults to "Saved". */
  readonly successLabel?: string;
}

/**
 * The app's button. Every label it can show (idle, pending, saved) sits in the
 * same grid cell, so the button keeps the width of its longest label and never
 * jumps while it works.
 *
 * Args:
 *   props: The tier, the states and the usual button attributes. `type`
 *     defaults to "button", so a submit button must say `type="submit"`.
 *
 * Returns:
 *   The button element.
 */
export function Button({
  variant = "secondary",
  size = "sm",
  className,
  pending = false,
  pendingLabel,
  succeeded,
  successLabel = "Saved",
  disabled,
  type = "button",
  children,
  ...rest
}: Props): React.JSX.Element {
  const flashing = useSuccessFlash(pending, succeeded === true);
  const showing = pending && pendingLabel ? "pending" : flashing ? "done" : "idle";

  return (
    <button
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={buttonClass({ variant, size, className })}
      {...rest}
    >
      <span className="inline-grid">
        <Cell visible={showing === "idle"}>{children}</Cell>
        {pendingLabel && (
          <Cell visible={showing === "pending"}>
            <Spinner />
            {pendingLabel}
          </Cell>
        )}
        {succeeded !== undefined && (
          <Cell visible={showing === "done"}>
            <Check />
            {successLabel}
          </Cell>
        )}
      </span>
    </button>
  );
}

/**
 * True for a moment after `pending` goes from true to false with `succeeded`
 * set, which is when an action has just finished and worked.
 */
function useSuccessFlash(pending: boolean, succeeded: boolean): boolean {
  const [flashing, setFlashing] = useState(false);
  const wasPending = useRef(pending);

  useEffect(() => {
    if (wasPending.current && !pending && succeeded) setFlashing(true);
    if (pending) setFlashing(false);
    wasPending.current = pending;
  }, [pending, succeeded]);

  useEffect(() => {
    if (!flashing) return;
    const timer = setTimeout(() => setFlashing(false), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [flashing]);

  return flashing;
}

/** One label in the shared grid cell. A hidden label still holds its width. */
function Cell({
  visible,
  children,
}: {
  readonly visible: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 ${
        visible ? "" : "invisible"
      }`}
    >
      {children}
    </span>
  );
}

function Spinner(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 animate-spin motion-reduce:hidden"
      fill="none"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Check(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
