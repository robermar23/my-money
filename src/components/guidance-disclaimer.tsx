/**
 * The mandatory guidance disclaimer (Phase 15, P15-33, ADR-032 §5).
 *
 * **Unconditional.** It renders on every advice surface, in every state — a
 * fully-funded household sees it, a household with no data sees it, and there is
 * no prop that turns it off. That is the whole point of the word "mandatory" in
 * ADR-032 §5, which asks for a banner *stronger* than ADR-022's projection
 * notice: the forecast page shows a number the user knows is a guess, while this
 * page uses the imperative mood, and a sentence that starts "pay down" needs to
 * be bounded more firmly than one that starts "projected".
 *
 * It lives in `src/components/` rather than beside the page so the two guidance
 * surfaces (`/plan` and the dashboard card) share one copy and cannot drift
 * apart, and so deleting the banner is a visible deletion in review rather than
 * an edited string.
 *
 * The second sentence is not filler. ADR-032 §4 draws the product boundary —
 * structures and amounts, never a security, fund, institution or product — and
 * saying so out loud sets the user's expectation correctly before they wonder
 * why the app will not tell them which fund to buy.
 */

interface Props {
  /** `full` for the page banner; `compact` for the dashboard card footnote. */
  readonly variant?: "full" | "compact";
}

export function GuidanceDisclaimer({ variant = "full" }: Props): React.JSX.Element {
  if (variant === "compact") {
    return (
      <p className="mt-3 text-xs text-zinc-400">
        General guidance from your own data — not financial advice.
      </p>
    );
  }

  return (
    <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 text-sm dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
      This is general guidance computed from your own data using conventional rules of thumb — it is{" "}
      <strong>not financial advice</strong>, and it does not know your taxes, your job security,
      your health, or anything you have not recorded here. It suggests structures and amounts only:
      it will never name a security, a fund, or an institution. Check anything consequential with a
      professional who can see your whole situation.
    </p>
  );
}
