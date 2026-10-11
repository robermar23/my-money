import type { HelpEntry } from "../types.ts";

/**
 * Help for the Analysis pages (PLAN20).
 *
 * Placeholders from P20-04: a title and the one-line summary from
 * docs/FEATURES.md's question column. The sections are written in P20-10.
 */
export const ANALYSIS_HELP: readonly HelpEntry[] = [
  {
    route: "/analysis",
    title: "Analysis",
    summary: "Where does the money go, by category and by month?",
    sections: [],
  },
  {
    route: "/analysis/networth",
    title: "Net worth change",
    summary:
      "Why did my net worth change: saving, markets, debt paydown, or something unexplained?",
    sections: [],
  },
  {
    route: "/analysis/category/<id>",
    title: "Category detail",
    summary: "What has one category cost me over time?",
    sections: [],
  },
  {
    route: "/analysis/budgets",
    title: "Budgets",
    summary: "Am I on budget this month?",
    sections: [],
  },
  {
    route: "/analysis/review",
    title: "Review queue",
    summary: "Which transactions still need a category?",
    sections: [],
  },
];
