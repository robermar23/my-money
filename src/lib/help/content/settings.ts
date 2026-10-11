import type { HelpEntry } from "../types.ts";

/**
 * Help for the Settings pages (PLAN20).
 *
 * Placeholders from P20-04: a title and the one-line summary from
 * docs/FEATURES.md's question column. The sections are written in P20-10.
 */
export const SETTINGS_HELP: readonly HelpEntry[] = [
  {
    route: "/settings/categories",
    title: "Categories",
    summary: "How are transactions categorized, and how do I change the rules?",
    sections: [],
  },
  {
    route: "/settings/connections",
    title: "Connections",
    summary: "Are my bank connections working, and which need signing in again?",
    sections: [],
  },
  {
    route: "/settings/connections/<id>/map",
    title: "Map accounts",
    summary:
      "Which of the bank's accounts should become new accounts here, and which match ones I already have?",
    sections: [],
  },
  {
    route: "/settings/connections/<id>/progress",
    title: "Syncing",
    summary: "Is the first sync from this bank still running, and did it finish?",
    sections: [],
  },
  {
    route: "/settings/household",
    title: "Household",
    summary: "Who is in the household, and what does the guidance assume about us?",
    sections: [],
  },
  {
    route: "/settings/income",
    title: "Income",
    summary: "What do I earn, and what goes into my 401(k) from each paycheck?",
    sections: [],
  },
  {
    route: "/settings/instance",
    title: "Instance",
    summary:
      "Is this installation healthy: backups, worker, schema, optional features? How do I change the password?",
    sections: [],
  },
];
