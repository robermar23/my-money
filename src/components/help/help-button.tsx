"use client";

import { openHelp } from "@/lib/help/events.ts";

/**
 * The `?` button in the chrome (PLAN20 P20-06).
 *
 * It only dispatches the open event; the single mounted {@link HelpPanel} owns
 * the dialog and the `?` key, so the desktop icon and the mobile menu row can
 * both exist without two panels.
 */

interface Props {
  /** `icon` sits in the desktop bar; `row` is a line in the mobile menu. */
  readonly variant: "icon" | "row";
  /** Runs before the panel opens, e.g. to close the mobile menu. */
  readonly onOpen?: () => void;
}

export function HelpButton({ variant, onOpen }: Props): React.JSX.Element {
  const open = (): void => {
    onOpen?.();
    openHelp();
  };

  if (variant === "row") {
    return (
      <button
        type="button"
        onClick={open}
        aria-label="Help for this page"
        className="flex items-center gap-1.5 py-2.5 text-left text-zinc-600 dark:text-zinc-400"
      >
        <span
          aria-hidden="true"
          className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px]"
        >
          ?
        </span>
        Help
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      aria-label="Help for this page"
      aria-keyshortcuts="?"
      data-help-button=""
      title="Help for this page (?)"
      className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 text-xs text-zinc-500 hover:text-zinc-900 dark:border-zinc-700 dark:hover:text-zinc-50"
    >
      <span aria-hidden="true">?</span>
    </button>
  );
}
