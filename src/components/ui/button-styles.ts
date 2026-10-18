/**
 * Button tiers, ranked by what a click does rather than where the button sits.
 *
 * - `commit`: writes to the household's financial record (save a balance,
 *   record an expense, confirm an import). The only solid ink button, and the
 *   only one with a pressed, key-like feel, so it reads as consequential.
 * - `secondary`: navigates, filters, refreshes or cancels. Outlined.
 * - `quiet`: a text-style action that changes nothing much ("Clear", "Edit").
 * - `danger` / `danger-quiet`: removes or disconnects something.
 *
 * Ink navy is deliberately not the gain green: green and red already mean "up"
 * and "down" on every figure, so a green Save would read like a gain.
 *
 * This module has no React or client code, so server components (a `<Link>`
 * styled as a button) can use {@link buttonClass} directly.
 */

/** What a click on the button does to the household's data. */
export type ButtonVariant = "commit" | "secondary" | "quiet" | "danger" | "danger-quiet";

/** Padding and type size. Ignored by the text-style variants. */
export type ButtonSize = "xs" | "sm" | "md";

/** Options for {@link buttonClass}. */
export interface ButtonClassOptions {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Extra classes (layout only: margins, width), appended last. */
  readonly className?: string;
}

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md select-none transition-[background-color,border-color,box-shadow,transform] duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-500 disabled:cursor-not-allowed disabled:opacity-50 aria-busy:disabled:cursor-progress aria-busy:disabled:opacity-100";

/** Boxed buttons drop a pixel when pressed, like a key going down. */
const PRESS = "whitespace-nowrap font-medium not-disabled:active:translate-y-px";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  commit: `${PRESS} border border-ink-900 bg-ink-800 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(17_27_46/0.3)] not-disabled:hover:bg-ink-700 not-disabled:active:bg-ink-900 not-disabled:active:shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)] dark:border-ink-800 dark:bg-ink-600 dark:not-disabled:hover:bg-ink-500 dark:not-disabled:active:bg-ink-700`,
  secondary: `${PRESS} border border-zinc-300 bg-white text-zinc-800 shadow-[0_1px_1px_rgb(0_0_0/0.05)] not-disabled:hover:border-zinc-400 not-disabled:hover:bg-zinc-50 not-disabled:active:bg-zinc-100 not-disabled:active:shadow-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:not-disabled:hover:border-zinc-600 dark:not-disabled:hover:bg-zinc-800 dark:not-disabled:active:bg-zinc-950`,
  quiet:
    "text-zinc-600 underline-offset-2 not-disabled:hover:text-zinc-900 not-disabled:hover:underline dark:text-zinc-400 dark:not-disabled:hover:text-zinc-100",
  danger: `${PRESS} border border-red-800 bg-red-700 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(69_10_10/0.3)] not-disabled:hover:bg-red-600 not-disabled:active:bg-red-800 not-disabled:active:shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)]`,
  "danger-quiet": "text-red-700 underline-offset-2 not-disabled:hover:underline dark:text-red-400",
};

const SIZES: Readonly<Record<ButtonSize, string>> = {
  xs: "px-2 py-0.5 text-xs",
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2 text-sm",
};

const TEXT_SIZES: Readonly<Record<ButtonSize, string>> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-sm",
};

/**
 * Builds the class string for a button, or for a link that looks like one.
 *
 * Args:
 *   options: The tier, the size and any layout classes.
 *
 * Returns:
 *   The Tailwind classes.
 */
export function buttonClass({
  variant = "secondary",
  size = "sm",
  className,
}: ButtonClassOptions = {}): string {
  const textOnly = variant === "quiet" || variant === "danger-quiet";
  const sizing = textOnly ? TEXT_SIZES[size] : SIZES[size];
  return [BASE, VARIANTS[variant], sizing, className].filter(Boolean).join(" ");
}
