import type { HelpEntry } from "../types.ts";

/**
 * Help for the Overview pages (PLAN20).
 *
 * Placeholders from P20-04: a title and the one-line summary from
 * docs/FEATURES.md's question column. The sections are written in P20-10.
 */
export const OVERVIEW_HELP: readonly HelpEntry[] = [
  {
    route: "/",
    title: "Dashboard",
    summary: "Where do I stand right now: net worth, this month's spending, savings rate?",
    sections: [],
  },
  {
    route: "/alerts",
    title: "Alerts",
    summary: "Is anything wrong: a large charge, a stale account, a failed sync or backup?",
    sections: [],
  },
];
