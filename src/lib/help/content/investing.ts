import type { HelpEntry } from "../types.ts";

/**
 * Help for the Investing pages (PLAN20).
 *
 * Placeholders from P20-04: a title and the one-line summary from
 * docs/FEATURES.md's question column. The sections are written in P20-10.
 */
export const INVESTING_HELP: readonly HelpEntry[] = [
  {
    route: "/investments",
    title: "Portfolio",
    summary: "What do I hold, what did it cost, and what is it worth?",
    sections: [],
  },
  {
    route: "/investments/performance",
    title: "Performance",
    summary: "How has the portfolio performed against the S&P 500?",
    sections: [],
  },
  {
    route: "/investments/forecast",
    title: "Forecast",
    summary: "What will the portfolio pay out next year, and where could it be at a return I pick?",
    sections: [],
  },
  {
    route: "/investments/security/<id>",
    title: "Security",
    summary: "What has one holding done, and what did I pay for each lot?",
    sections: [],
  },
  {
    route: "/watchlist",
    title: "Watchlist",
    summary: "What am I watching, and has anything hit my price target?",
    sections: [],
  },
  {
    route: "/watchlist/new",
    title: "Add to watchlist",
    summary: "Which symbol do I want to watch, and at what price should it alert me?",
    sections: [],
  },
  {
    route: "/watchlist/<id>",
    title: "Watchlist item",
    summary: "How has a symbol I am watching moved, and how close is it to my target?",
    sections: [],
  },
  {
    route: "/watchlist/<id>/edit",
    title: "Edit watchlist item",
    summary: "How do I change a watched symbol's label, target, or alert direction?",
    sections: [],
  },
];
