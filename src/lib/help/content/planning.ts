import type { HelpEntry } from "../types.ts";

/**
 * Help for the Planning pages (PLAN20).
 *
 * Placeholders from P20-04: a title and the one-line summary from
 * docs/FEATURES.md's question column. The sections are written in P20-10.
 */
export const PLANNING_HELP: readonly HelpEntry[] = [
  {
    route: "/plan",
    title: "Guidance",
    summary: "What should I do next with my money: emergency fund, match, debt, retirement?",
    sections: [],
  },
  {
    route: "/plan/cashflow",
    title: "Cash flow",
    summary: "Will my cash cover the bills ahead, and how much is safe to spend?",
    sections: [],
  },
  {
    route: "/plan/cashflow/review",
    title: "Recurring bills",
    summary: "Which recurring bills does the app expect, and are they right?",
    sections: [],
  },
  {
    route: "/plan/sinking",
    title: "Sinking funds",
    summary: "How much should I be holding now for irregular costs like insurance or a car?",
    sections: [],
  },
];
