"use client";
import { type ButtonSize, buttonClass } from "@/components/ui/button-styles.ts";

/**
 * P11-18/19 — a submit button that guards a (void) server action behind a native
 * confirm. The action is bound server-side and passed in as the form `action`;
 * cancelling the confirm prevents submission. Used for destructive controls
 * (delete target, delete watchlist item).
 */
interface Props {
  readonly action: () => Promise<void>;
  readonly confirmMessage: string;
  readonly label: string;
  readonly size?: ButtonSize;
}

export function ConfirmButton({
  action,
  confirmMessage,
  label,
  size = "sm",
}: Props): React.JSX.Element {
  return (
    <form action={action}>
      <button
        type="submit"
        onClick={(e) => {
          if (!window.confirm(confirmMessage)) e.preventDefault();
        }}
        className={buttonClass({ variant: "danger", size })}
      >
        {label}
      </button>
    </form>
  );
}
