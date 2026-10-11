import type { HelpEntry } from "../types.ts";

/**
 * Help for the Settings pages (PLAN20 P20-10).
 *
 * Sources: `src/app/settings/**`; docs/SPENDING.md, docs/GUIDANCE.md
 * §How observed net income is derived, docs/PLAID.md, docs/INCOME.md,
 * docs/CASHFLOW.md §The two settings, and the instance page's own sections.
 */
export const SETTINGS_HELP: readonly HelpEntry[] = [
  {
    route: "/settings/categories",
    title: "Categories",
    summary: "How are transactions categorized, and how do I change the rules?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Each category belongs to a group and has a kind: income, expense or transfer. Transfers count toward no total, which is how card payments and moves between your own accounts stay out of spending.",
          },
          {
            kind: "paragraph",
            text: "Expense categories also have a necessity. Essential spending sizes your emergency fund and the needs-and-wants split in guidance; the banner says what share is still unclassified. Income categories can be excluded from take-home, for money such as reimbursements that you cannot plan on.",
          },
          {
            kind: "paragraph",
            text: "Rules match a pattern against a transaction's payee name or memo. The lowest priority number is tried first, and the first match wins.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "steps",
            items: [
              "Add, rename, regroup, archive or merge categories, and add groups.",
              "Classify many expense categories at once, then Apply.",
              "Add a rule, after testing its pattern against existing transactions.",
              "Re-categorize existing transactions to apply changed rules to the past.",
            ],
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "A category you set by hand is never overwritten when rules re-run. A rule catching the wrong payees is usually too broad a pattern; test it first. Payees no rule matches wait in the review queue.",
          },
        ],
      },
    ],
    terms: ["rule", "kind", "necessity", "take-home"],
    relatedRoutes: ["/analysis/review", "/plan"],
  },
  {
    route: "/settings/connections",
    title: "Connections",
    summary: "Are my bank connections working, and which need signing in again?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Each institution linked through Plaid shows its status, the accounts mapped to it, and when it last synced. The sync history beneath lists recent runs, what started each one, and whether it failed.",
          },
          {
            kind: "definition",
            term: "Active",
            text: "Syncing normally: when the bank signals new transactions, and once a night regardless.",
          },
          {
            kind: "definition",
            term: "Reconnect needed",
            text: "The bank wants you to sign in again, usually after a password change or a routine security check. Those accounts stop updating until you do.",
          },
          {
            kind: "definition",
            term: "Revoked, Removed",
            text: "Access was withdrawn at the bank, or you disconnected it here.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Connect new institution links a bank or card; Connect investment institution links a brokerage, as its own connection. Reconnect repairs a sign-in. Force sync pulls now. Disconnect ends the link and keeps every transaction and balance already recorded.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "No accounts mapped yet means setup was not finished: follow finish setup. If bank connections are off on this installation (Settings → Instance says), import statement files on each account instead; everything else works the same.",
          },
        ],
      },
    ],
    terms: ["connection"],
    relatedRoutes: ["/accounts", "/settings/instance", "/alerts"],
  },
  {
    route: "/settings/connections/<id>/map",
    title: "Map accounts",
    summary:
      "Which of the bank's accounts should become new accounts here, and which match ones I already have?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Every account the bank shared appears once, with one choice to make for each:",
          },
          {
            kind: "definition",
            term: "Link to an existing account",
            text: "For an account you already track by hand. Its balances and history are kept, and synced transactions land on it from now on.",
          },
          {
            kind: "definition",
            term: "Create a new my-money account",
            text: "For one the app does not have yet. It is created from the bank's name and type.",
          },
          {
            kind: "definition",
            term: "Skip",
            text: "Don't track this account. Nothing is pulled from it.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Choose for every row, then Confirm mapping and start initial sync. The first sync can bring in up to two years of history, and a progress page follows it.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Two of the bank's accounts cannot both link to the same account here; the page refuses before saving anything.",
          },
          {
            kind: "paragraph",
            text: "Couldn't load accounts from Plaid right after connecting is often the bank still preparing its data, especially for investment accounts. Wait a moment and Retry. If it persists, reconnect the institution from Connections.",
          },
        ],
      },
    ],
    terms: ["connection"],
    relatedRoutes: ["/settings/connections", "/accounts"],
  },
  {
    route: "/settings/connections/<id>/progress",
    title: "Syncing",
    summary: "Is the first sync from this bank still running, and did it finish?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "The first sync from a newly connected bank pulls up to two years of history, so it can take a while. This page checks every few seconds and shows how many transactions have arrived so far.",
          },
          {
            kind: "paragraph",
            text: "Added, Modified and Removed count what the latest run changed: banks revise pending transactions after they post, so modified and removed rows are normal. Pages fetched shows how many batches it took.",
          },
          {
            kind: "paragraph",
            text: "When the sync finishes, the page says so and takes you to the dashboard.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Wait, or leave: the sync runs in the background either way. The accounts you mapped already exist, so you can open them on the accounts page while it runs.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Waiting for the worker to pick up the job means the app's background worker is not running, so nothing will sync until it is. Settings → Instance shows when the worker last reported.",
          },
          {
            kind: "paragraph",
            text: "Reconnect needed means the bank stopped the sync and wants you to sign in again; do that from Connections. An error under the counts is the bank's own message for the failed run.",
          },
        ],
      },
    ],
    terms: ["connection"],
    relatedRoutes: ["/settings/connections", "/settings/instance"],
  },
  {
    route: "/settings/household",
    title: "Household",
    summary: "Who is in the household, and what does the guidance assume about us?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Everything here is optional. A blank field uses the conventional default shown in it, and guidance says when it is relying on one.",
          },
          {
            kind: "definition",
            term: "Your preferences",
            text: "How many months of essential expenses your emergency fund should cover, a target retirement age, the savings yield you could get elsewhere, where high-interest debt starts, and your needs, wants and savings split.",
          },
          {
            kind: "definition",
            term: "Who lives here",
            text: "A name or label and a birth year for each person, and whether they depend on this income. A dependant raises the emergency-fund default.",
          },
          {
            kind: "definition",
            term: "Cash-flow projection",
            text: "The cash cushion to keep, and how many days ahead to project. Nothing but safe to spend reads them.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Fill in what you know and save each form; the two save separately. Add, edit or remove household members.",
          },
          {
            kind: "callout",
            tone: "note",
            text: "These details stay in your own database. Names are not searchable and never appear in alert email.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "The yield is your own number; the app never looks up market rates. Projecting much past 90 days lets the everyday-spending average dominate the line, so a long window looks more precise than it is.",
          },
        ],
      },
    ],
    terms: ["emergency-fund", "cash-cushion"],
    relatedRoutes: ["/plan", "/plan/cashflow"],
  },
  {
    route: "/settings/income",
    title: "Income",
    summary: "What do I earn, and what goes into my 401(k) from each paycheck?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Each paycheck is a source: gross pay per period, how often it comes, and one real payday that sets the rhythm. Take-home is optional and is what the cash-flow projection uses for paydays.",
          },
          {
            kind: "paragraph",
            text: "A contribution rule on a source says what goes into a workplace plan: your share as a percent of gross or a fixed amount, any employer match and its cap, and optionally which holding it buys. The preview shows each period's amounts and the yearly savings rate before you save.",
          },
          {
            kind: "paragraph",
            text: "Each night, every payday becomes a contribution on the investment account, which is what gives a workplace plan its cost basis.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Add a source and its rule, edit them, or Pause either. Use a take-home figure suggested from matching deposits. Backfill history creates every past contribution now, paused sources included.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Nothing materialized yet usually means the nightly job has not run since you added the source; Backfill history does it now. For a job change, end the old source the day before the new one starts, or the shared payday counts twice.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Double-count risk appears when a rule buys a holding that bank sync already records purchases for. Choose one source for that holding's cost.",
          },
        ],
      },
    ],
    terms: ["take-home", "savings-rate", "cost-basis"],
    relatedRoutes: ["/", "/investments", "/plan/cashflow"],
  },
  {
    route: "/settings/instance",
    title: "Instance",
    summary:
      "Is this installation healthy: backups, worker, schema, optional features? How do I change the password?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "How this installation is set up. It shows configuration and dates only, never balances or names, so it is safe to share in a request for help.",
          },
          {
            kind: "definition",
            term: "Background worker",
            text: "Runs bank syncs, prices, daily balances, alerts and backups. Running is good; anything else means those have stopped.",
          },
          {
            kind: "definition",
            term: "Backups",
            text: "Whether the nightly encrypted backup is set up, when it last succeeded, and the last time a restore was practised.",
          },
          {
            kind: "definition",
            term: "Optional features",
            text: "Bank connections, alert email and the plain-text ledger copy, each on or off.",
          },
          {
            kind: "definition",
            term: "Retirement contribution limits",
            text: "The years whose limits the app knows. Guidance skips a year it lacks rather than guessing.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Record a restore drill once you have practised restoring a backup, and change the password. Everything else is set in the server's configuration by whoever runs it.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "callout",
            tone: "warning",
            text: "Nightly backup Not configured means nothing is being backed up. An untested backup is not a backup either, so practise a restore at least every quarter.",
          },
          {
            kind: "paragraph",
            text: "Changing the password signs out every other browser. There is no reset link: if it is forgotten, whoever runs the server can clear it so a new one can be set at sign-in, and your data is kept.",
          },
        ],
      },
    ],
    relatedRoutes: ["/alerts", "/settings/connections"],
  },
];
