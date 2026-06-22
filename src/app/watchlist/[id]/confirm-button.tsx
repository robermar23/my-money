"use client";

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
  readonly className?: string;
}

export function ConfirmButton({
  action,
  confirmMessage,
  label,
  className,
}: Props): React.JSX.Element {
  return (
    <form action={action}>
      <button
        type="submit"
        onClick={(e) => {
          if (!window.confirm(confirmMessage)) e.preventDefault();
        }}
        className={
          className ??
          "rounded-md border border-red-300 px-3 py-1.5 font-medium text-red-700 text-sm hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
        }
      >
        {label}
      </button>
    </form>
  );
}
