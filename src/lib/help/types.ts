import type { Route } from "next";
import type { HelpRoute } from "./routes.ts";

/**
 * The in-app help content model (ADR-058, ADR-059, PLAN20 P20-01).
 *
 * Help is **typed data, not markup**. Every string here is rendered as a React
 * text node, so an entry can never inject HTML, and emphasis is a typed span
 * rather than a tag. Help is also **static**: no field holds a value computed
 * from the household's data (PLAN20 Hard boundary #1).
 *
 * Like the nav manifest, this module imports **neither React nor
 * `next/navigation`**, so a server component, a client island, and a Vitest
 * file can all import it.
 */

/** A run of bold text inside a line of help. */
export interface StrongSpan {
  readonly strong: string;
}

/** One piece of a line: plain text, or a bold span. */
export type InlineSpan = string | StrongSpan;

/** A line of help text: a plain string, or a sequence of spans. */
export type HelpText = string | readonly InlineSpan[];

/** A paragraph of prose. */
export interface ParagraphBlock {
  readonly kind: "paragraph";
  readonly text: HelpText;
}

/** A numbered list of things to do, in order. */
export interface StepsBlock {
  readonly kind: "steps";
  readonly items: readonly HelpText[];
}

/** A word the page uses, and what it means on this page. */
export interface DefinitionBlock {
  readonly kind: "definition";
  readonly term: string;
  readonly text: HelpText;
}

/** A set-apart note: a tip, or a warning about a common mistake. */
export interface CalloutBlock {
  readonly kind: "callout";
  readonly tone: "note" | "warning";
  readonly text: HelpText;
}

/** One block of help body text. The panel switches on `kind`. */
export type HelpBlock = ParagraphBlock | StepsBlock | DefinitionBlock | CalloutBlock;

/** A headed section of a help entry, such as "How to read it". */
export interface HelpSection {
  readonly heading: string;
  readonly blocks: readonly HelpBlock[];
}

/**
 * The identifier of a glossary term. A plain string until the glossary lands
 * (P20-09), which narrows it to the glossary's keys.
 */
export type GlossaryTermId = string;

/**
 * Every `data-tour` anchor a tour may point at. Empty until the tours are
 * written (Batch 5). Each tour adds its anchors here, so a step that names an
 * anchor not in this list does not compile, and the anchor guard (P20-17)
 * checks each one against the page markup.
 */
export const TOUR_ANCHORS = [] as const;

/** A `data-tour` attribute value that some tour step may target. */
export type TourAnchor = (typeof TOUR_ANCHORS)[number];

/** One stop on a tour: the element to highlight, and what to say about it. */
export interface TourStep {
  readonly anchor: TourAnchor;
  readonly title: string;
  readonly body: string;
  /** Where the step card sits relative to the anchor. The engine flips it at viewport edges. */
  readonly placement?: "top" | "bottom" | "left" | "right";
}

/**
 * A page's guided walkthrough. Bumping `version` offers the tour again to
 * devices that have already seen it (ADR-060 §1).
 */
export interface TourDefinition {
  readonly id: string;
  readonly version: number;
  readonly steps: readonly TourStep[];
}

/** Everything the help panel knows about one page. */
export interface HelpEntry {
  /** The route pattern this entry explains, with each dynamic segment written `<id>`. */
  readonly route: HelpRoute;
  readonly title: string;
  /** One sentence: the question this page answers. */
  readonly summary: string;
  readonly sections: readonly HelpSection[];
  /** Glossary terms worth defining alongside this page. */
  readonly terms?: readonly GlossaryTermId[];
  /** Other pages the reader is likely to want next. Typed routes, so a dead link does not compile. */
  readonly relatedRoutes?: readonly Route[];
  readonly tour?: TourDefinition;
}
