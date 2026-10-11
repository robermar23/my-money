import type { GlossaryEntry } from "@/lib/help/glossary.ts";
import type { HelpBlock, HelpEntry, HelpText } from "@/lib/help/types.ts";
import { allDestinations } from "@/lib/nav/resolve.ts";
import type { Route } from "next";
import Link from "next/link";

/**
 * Renders one help entry's body (PLAN20 P20-05, ADR-059 §3).
 *
 * Every string becomes a React text node and emphasis is a typed
 * `{ strong }` span, so there is no markup to inject: nothing under
 * `src/components/help/` uses `dangerouslySetInnerHTML`. The content is
 * static and never reordered, which is why array indices are safe keys here.
 */

/** A run of text with optional bold spans. */
function Text({ text }: { readonly text: HelpText }): React.JSX.Element {
  if (typeof text === "string") return <>{text}</>;
  return (
    <>
      {text.map((span, i) =>
        typeof span === "string" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static content, never reordered.
          <span key={i}>{span}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static content, never reordered.
          <strong key={i} className="font-semibold text-zinc-900 dark:text-zinc-50">
            {span.strong}
          </strong>
        ),
      )}
    </>
  );
}

/** Styles for each callout tone. */
const CALLOUT_TONE = {
  note: {
    label: "Note",
    className: "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50",
  },
  warning: {
    label: "Watch out",
    className: "border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/40",
  },
} as const;

/** One block of help body text. */
function Block({ block }: { readonly block: HelpBlock }): React.JSX.Element {
  switch (block.kind) {
    case "paragraph":
      return (
        <p>
          <Text text={block.text} />
        </p>
      );
    case "steps":
      return (
        <ol className="list-decimal space-y-1 pl-5">
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static content, never reordered.
            <li key={i}>
              <Text text={item} />
            </li>
          ))}
        </ol>
      );
    case "definition":
      return (
        <dl>
          <dt className="font-medium text-zinc-900 dark:text-zinc-50">{block.term}</dt>
          <dd className="mt-0.5">
            <Text text={block.text} />
          </dd>
        </dl>
      );
    case "callout": {
      const tone = CALLOUT_TONE[block.tone];
      return (
        <div role="note" className={`rounded-md border-l-4 px-3 py-2 ${tone.className}`}>
          <span className="font-medium">{tone.label}: </span>
          <Text text={block.text} />
        </div>
      );
    }
    default: {
      const unreachable: never = block;
      return unreachable;
    }
  }
}

/**
 * A nav destination's name as the menus show it: "Planning → Cash flow". A
 * bare item label such as "Overview" is ambiguous on its own.
 */
const NAV_LABEL: ReadonlyMap<string, string> = new Map(
  allDestinations().map((d) => [
    d.href,
    d.groupId === "utilities" || d.label === d.groupLabel
      ? d.label
      : `${d.groupLabel} → ${d.label}`,
  ]),
);

/**
 * The label for a related page. Every related route is a nav destination
 * (copy.test.ts checks), so the fallback is never reached in practice.
 *
 * @param route - A related route.
 * @returns Its menu label.
 */
export function relatedLabel(route: Route): string {
  return NAV_LABEL.get(route) ?? route;
}

/** The words this page uses with a precise meaning. */
function Terms({ terms }: { readonly terms: readonly GlossaryEntry[] }): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">Words on this page</h3>
      <dl className="space-y-3">
        {terms.map((t) => (
          <div key={t.term}>
            <dt className="font-medium text-zinc-900 dark:text-zinc-50">{t.term}</dt>
            <dd className="mt-0.5">{t.means}</dd>
            <dd className="mt-0.5">{t.tellsYou}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Links to the pages the reader is likely to want next. */
function Related({ routes }: { readonly routes: readonly Route[] }): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">See also</h3>
      <ul className="space-y-1">
        {routes.map((route) => (
          <li key={route}>
            <Link
              href={route}
              className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-50"
            >
              {relatedLabel(route)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The summary, sections, terms and related pages of one entry. The panel owns
 * the `<h2>` title, so section headings are `<h3>` and the outline stays in order.
 *
 * @param entry - The entry to render.
 * @param terms - The glossary definitions `entry.terms` names, already loaded.
 */
export function HelpContent({
  entry,
  terms = [],
}: {
  readonly entry: HelpEntry;
  readonly terms?: readonly GlossaryEntry[];
}): React.JSX.Element {
  const related = entry.relatedRoutes ?? [];
  return (
    <div className="space-y-5 text-sm text-zinc-600 leading-relaxed dark:text-zinc-300">
      <p className="text-base text-zinc-800 dark:text-zinc-100">{entry.summary}</p>
      {entry.sections.map((section) => (
        <section key={section.heading} className="space-y-2">
          <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">{section.heading}</h3>
          {section.blocks.map((block, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static content, never reordered.
            <Block key={i} block={block} />
          ))}
        </section>
      ))}
      {terms.length > 0 && <Terms terms={terms} />}
      {related.length > 0 && <Related routes={related} />}
    </div>
  );
}
