import { Money } from "@/lib/money/money.ts";
import { loadAttribution } from "@/lib/net-worth/attribution-loader.ts";
import { summarySentence } from "@/lib/net-worth/summary.ts";
import Link from "next/link";

/**
 * The one-sentence net-worth pointer on `/analysis` (P17-23, ADR-039 §6).
 *
 * This is where Round 11 expected the feature to live, and it is how a user
 * finds it at all: `/analysis` answers "where did the money go", and "why did
 * our net worth change" is the question standing right behind it.
 *
 * ── One sentence, one link, no second computation path ─────────────────────
 * It calls `loadAttribution` — the same loader `/analysis/networth` calls — and
 * uses the same `summarySentence` decision. No chart, no rung table, and above
 * all no separate "quick" derivation: a cheaper approximation here would be a
 * second number with equal apparent authority that could disagree with the page
 * it links to, which is exactly the failure ADR-039 §1 rejects for the
 * endpoints themselves.
 *
 * ── Its own component so it can stream ─────────────────────────────────────
 * A full decomposition is ~10 reads plus two `computeNetWorth` calls, and
 * `/analysis` is a spending page that was fast before this landed. Rendered as
 * its own async component inside a `<Suspense>`, it cannot delay the tiles and
 * charts a user actually came for — it appears when it is ready.
 *
 * ── Degrading is silence, not an empty box ─────────────────────────────────
 * With no recorded balances there is no sentence to write, so nothing renders.
 * `/analysis/networth` is where that gap is explained and linked, and repeating
 * it here would put a second "you have not set this up" panel on a page that
 * already has its own.
 */

const CURRENCY = "USD";

interface Props {
  /** The resolved window from `resolveRange` — the same one the page charts. */
  readonly from: string;
  readonly to: string;
}

export async function NetWorthSentence({ from, to }: Props): Promise<React.JSX.Element | null> {
  const result = await loadAttribution({ from, to });
  if (result.status === "no_snapshots") return null;

  const summary = summarySentence(result, CURRENCY);
  const magnitude = Money.fromString(summary.magnitude, CURRENCY).format();
  const lead =
    summary.direction === "flat"
      ? "Your net worth finished this window where it started"
      : `Your net worth ${summary.direction === "up" ? "rose" : "fell"} ${magnitude} over this window`;

  return (
    <Link
      href="/analysis/networth"
      className="mt-6 block rounded-lg border border-zinc-200 p-4 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
    >
      <p className="text-sm">
        <span className="font-medium">{lead}</span>
        {summary.residual !== null && (
          <span className="text-amber-700 dark:text-amber-400">
            {" "}
            — {Money.fromString(summary.residual.amount, CURRENCY).format()} of it is not yet
            accounted for
          </span>
        )}
        . <span className="underline">See what drove it →</span>
      </p>
    </Link>
  );
}
