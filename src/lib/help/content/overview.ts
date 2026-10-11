import type { HelpEntry } from "../types.ts";

/**
 * Help for the Overview pages (PLAN20 P20-10).
 *
 * Sources: docs/DASHBOARD.md and the dashboard cards under
 * `src/components/dashboard/`; docs/ALERTS.md and `src/app/alerts/page.tsx`.
 */
export const OVERVIEW_HELP: readonly HelpEntry[] = [
  {
    route: "/",
    title: "Dashboard",
    summary: "Where do I stand right now: net worth, this month's spending, savings rate?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: [
              "The large figure is your ",
              { strong: "net worth" },
              " on the date beside it, with how much it changed over the range you picked. The range buttons change the history chart and the Performance card, and nothing else.",
            ],
          },
          {
            kind: "paragraph",
            text: "Each card summarises a deeper page and links to it. A card and its page always agree, because they read the same records; the dashboard computes nothing of its own.",
          },
          {
            kind: "definition",
            term: "Fixed windows",
            text: "Spending is always this calendar month. Savings rate is always the last 12 months. Allocation, forward income, alerts and movers are as of today.",
          },
          {
            kind: "definition",
            term: "Labelled estimates",
            text: "Forward income and savings rate are estimates and say so. Watchlist movers are pretend positions, never counted in net worth. Safe to spend always shows its window and your cushion.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Pick a range, then follow any card to the page that owns its number. The accounts list at the bottom opens each account. Nothing on this page changes your data.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "A card that asks for something, such as defining your income or setting budgets, is naming a missing input, not failing. A figure that is wrong here is wrong on its own page too, so fix it there.",
          },
          {
            kind: "callout",
            tone: "note",
            text: "Performance says it has insufficient history until the range holds at least two days of investment records. Pick a longer range, or wait a night or two after adding holdings.",
          },
        ],
      },
    ],
    terms: ["net-worth", "savings-rate", "safe-to-spend"],
    relatedRoutes: ["/analysis/networth", "/alerts"],
  },
  {
    route: "/alerts",
    title: "Alerts",
    summary: "Is anything wrong: a large charge, a stale account, a failed sync or backup?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Checks run every night and open an alert when something looks off. The lines under each title are the figures behind it. They appear only on this page and are never emailed.",
          },
          {
            kind: "definition",
            term: "Severity",
            text: [
              { strong: "Critical" },
              " needs action now, such as a failed backup or a balance projected below zero. ",
              { strong: "Warning" },
              " is worth a look soon. ",
              { strong: "Info" },
              " is worth knowing.",
            ],
          },
          {
            kind: "paragraph",
            text: "What gets checked: a single large transaction, a sharp balance drop, an account whose balances stopped updating, prices that stopped, a bank that needs you to sign in again, a failed sync or backup, backups not set up, a change in guidance, a projected cash shortfall, a bill that did not arrive or changed amount, and a watchlist price target reached.",
          },
          {
            kind: "paragraph",
            text: "A standing problem is reported once, not every night. Most alerts move to Resolved on their own once the cause clears.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Fix the cause on the page that owns it: Settings → Connections for a bank sign-in, Planning → Cash flow for a shortfall. Dismiss an alert you have dealt with or do not need, and it moves to Resolved.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "callout",
            tone: "warning",
            text: "Dismissing does not fix anything. A backup that keeps failing, or was never set up, raises its alert again, and a dismissed bill alert is not a paid bill.",
          },
          {
            kind: "paragraph",
            text: "If your installation sends alert email, it carries only a count and a link here, never a figure or a name.",
          },
        ],
      },
    ],
    relatedRoutes: ["/settings/connections", "/plan/cashflow", "/settings/instance"],
  },
];
