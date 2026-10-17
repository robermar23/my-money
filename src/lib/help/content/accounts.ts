import type { HelpEntry } from "../types.ts";

/**
 * Help for the Accounts pages (PLAN20 P20-10).
 *
 * Sources: `src/app/accounts/**` (the pages, the account forms, the
 * reconciliation banner and the import flow); docs/IMPORT.md, docs/ASSETS.md,
 * docs/SEARCH.md, and docs/ATTRIBUTION.md §Balance sign convention. Titles of
 * the flow-step pages are the pages' own headings.
 */
export const ACCOUNTS_HELP: readonly HelpEntry[] = [
  {
    route: "/accounts",
    title: "All accounts",
    summary: "What accounts do I have, and is each one up to date?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: [
              "Each row is one account with its type and its ",
              { strong: "latest balance" },
              ": the newest balance recorded for it, from a bank sync, an import, or your own entry, with the day it is for. Cards and loans show as negative, because that is what they add to your net worth.",
            ],
          },
          {
            kind: "paragraph",
            text: "A dash means no balance has been recorded yet, and the account stays out of net worth until one is. For a personal asset, the institution column shows its category instead.",
          },
          {
            kind: "paragraph",
            text: "Closed accounts are hidden. Show closed lists them, greyed out, with a button to reopen each one.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Add account, filter by name or institution, or open an account to record a balance, import a statement or read its history. Accounts linked to a bank update on their own; Settings → Connections links one.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "An old as-of date on a bank-linked account usually means its connection needs attention; on a manual account it means you have not recorded a balance since. Alerts tells you when a linked account's balances stop updating.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "A credit card showing a positive balance counts as money you own. Unless the card really is overpaid, record the amount owed on the card's page, which handles the sign for you.",
          },
        ],
      },
    ],
    terms: ["net-worth", "snapshot"],
    relatedRoutes: ["/settings/connections", "/alerts"],
    tour: {
      id: "accounts",
      version: 1,
      steps: [
        {
          anchor: "accounts-add",
          title: "Add an account",
          body: "Start here for anything you want counted: a bank, a card, a brokerage, a loan, a home. Accounts linked under Connections appear here on their own.",
        },
        {
          anchor: "accounts-filter",
          title: "Find one",
          body: "Type part of a name or institution to narrow the list. Closed accounts stay hidden until you choose Show closed.",
        },
        {
          anchor: "accounts-name",
          title: "Open an account",
          body: "Each name opens that account's own page, with its balance history, transactions and details.",
        },
        {
          anchor: "accounts-latest-balance",
          title: "Is it up to date?",
          body: "Each balance shows the day it was recorded. An old date means nothing new has arrived since, so check Connections or record a balance on the account.",
        },
      ],
    },
  },
  {
    route: "/accounts/new",
    title: "Add account",
    summary: "How do I add an account by hand, including a house, car, or collectible?",
    sections: [
      {
        heading: "How to fill it in",
        blocks: [
          {
            kind: "paragraph",
            text: "Pick the type that matches the real account. The type decides what its page lets you record:",
          },
          {
            kind: "definition",
            term: "Cash, Credit card",
            text: "Balances you enter or import from statements, plus their transactions.",
          },
          {
            kind: "definition",
            term: "Investment, Crypto or metals IRA",
            text: "Holdings. You enter quantities; the value is quantity times the latest price, updated nightly.",
          },
          {
            kind: "definition",
            term: "Loan (mortgage)",
            text: "The loan's terms. Its balance is then worked out from the repayment schedule, with no monthly entry.",
          },
          {
            kind: "definition",
            term: "Property, Personal asset",
            text: "A value you record yourself, whenever it changes. A personal asset takes a category, and optionally when you bought it and what it cost.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Create the account, then record its first balance or value on its page. For a bank that Plaid can reach, Settings → Connections is the better start: it can create accounts or attach to ones you already made by hand.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "A new account counts toward net worth only once it has a balance or value. Type and currency can be changed later only while the account holds no data.",
          },
          {
            kind: "callout",
            tone: "note",
            text: "Values for property and personal assets are always yours. The app never looks them up anywhere, and never depreciates them on its own.",
          },
        ],
      },
    ],
    terms: ["net-worth"],
    relatedRoutes: ["/accounts", "/settings/connections"],
  },
  {
    route: "/accounts/<id>",
    title: "Account",
    summary: "What is in one account: balance history, transactions, holdings, loan or card terms?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: [
              { strong: "Latest" },
              " is the account's current figure: the value of its holdings for an investment, the balance worked out from the schedule for a mortgage, otherwise the newest balance recorded. Snapshot history lists every day a balance was recorded.",
            ],
          },
          {
            kind: "paragraph",
            text: "Cash and card accounts show a banner comparing the latest balance with the sum of the transactions: Reconciled when they agree, drift when they do not.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "What appears depends on the account's type:",
          },
          {
            kind: "steps",
            items: [
              "Cash and cards: record a balance (a card asks for the amount owed), import a statement, filter transactions, and click a category to change it.",
              "Account details and card terms: the subtype, interest rate, limit and minimum payment that guidance and cash flow read. Blank fields are reported as missing, never assumed.",
              "Investments: add or update a holding, and record cost-basis lots under it.",
              "Mortgage, property and personal assets: the loan's parameters, or a dated value. An asset can also keep proof documents.",
            ],
          },
          {
            kind: "paragraph",
            text: "Edit account, Close account (hidden but kept) and Delete account (permanent) sit under the header.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Drift usually means a statement is missing; import it and the gap closes. A gain or loss shown as a dash means no cost was recorded. A checking account missing from cash flow needs its subtype set here.",
          },
        ],
      },
    ],
    terms: ["snapshot", "reconciliation-drift", "account-subtype", "cost-basis-lot"],
    relatedRoutes: ["/transactions", "/accounts"],
    tour: {
      id: "account",
      version: 1,
      steps: [
        {
          anchor: "account-latest",
          title: "Latest",
          body: "The account's value now, from its newest balance or its holdings. A mortgage's is worked out from its terms instead.",
        },
        {
          anchor: "account-record-balance",
          title: "Record a balance",
          body: "Enter the end-of-day figure from a statement or the bank's site. Each one becomes a point in this account's history.",
        },
        {
          anchor: "account-holdings",
          title: "Holdings",
          body: "Add or update what the account holds: the symbol, how many, and what you paid. Their value follows nightly prices, so it moves on its own.",
        },
        {
          anchor: "account-mortgage",
          title: "Mortgage parameters",
          body: "Enter the loan's terms once. The balance is then worked out from the payment schedule, with nothing to enter each month.",
        },
        {
          anchor: "account-transactions",
          title: "Transactions",
          body: "Import a statement file here, and click any category below to change it. Tick “and make a rule for this payee” to categorize its future transactions too.",
        },
        {
          anchor: "account-snapshots",
          title: "Snapshot history",
          body: "One balance a day, the record your net worth is built from. An old last date here is why a figure looks stale.",
        },
      ],
    },
  },
  {
    route: "/accounts/<id>/import",
    title: "Import transactions",
    summary: "How do I load a bank's QFX or CSV export, and did it reconcile?",
    sections: [
      {
        heading: "How it works",
        blocks: [
          {
            kind: "steps",
            items: [
              "On your bank's website, download the statement as QFX or OFX (often labelled “Download to Quicken”), or as CSV.",
              "Choose the file here. For a CSV, pick the preset that matches your bank's columns, or edit the mapping shown.",
              "Press Upload & preview. Nothing is saved yet: the next page shows exactly what would be added, and waits for you to confirm.",
            ],
          },
          {
            kind: "definition",
            term: "QFX and OFX",
            text: "Carry the bank's own transaction IDs and usually an ending balance, so the preview can check the import reconciles. Prefer them when your bank offers both.",
          },
          {
            kind: "definition",
            term: "CSV",
            text: "Needs a mapping that says which column is the date, the amount and the payee. Dates are read month first, US style.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Import as many statements as you like, in any order. Transactions already in the account are skipped as duplicates, so an overlapping or repeated file is always safe. A large file is read in the background, and the preview opens by itself when it is ready.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Only cash and credit-card accounts take imports; holdings are entered on an investment account's page. A CSV with day-first dates or European number formats is read wrongly, so re-export it with year-first dates and check the preview before confirming.",
          },
        ],
      },
    ],
    terms: ["duplicate"],
    tour: {
      id: "import",
      version: 1,
      steps: [
        {
          anchor: "import-intro",
          title: "Nothing is saved yet",
          body: "Uploading only reads the file. The next page shows what it found, and nothing is written until you confirm there.",
        },
        {
          anchor: "import-file",
          title: "Choose the file",
          body: "Download a QFX, OFX or CSV export from your bank and pick it here. A CSV also asks which format it is in.",
        },
        {
          anchor: "import-upload",
          title: "Upload & preview",
          body: "Re-importing the same file is safe: transactions already here are skipped.",
        },
      ],
    },
  },
  {
    route: "/accounts/<id>/import/<id>",
    title: "Processing import",
    summary:
      "A large statement is being read in the background; the preview opens when it is ready.",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Large files are read by the app's background worker rather than while you wait at the upload form. This page checks again every two seconds, and moves on to the preview the moment the file has been read.",
          },
          {
            kind: "paragraph",
            text: [
              "Nothing has been saved to the account at this point. ",
              { strong: "Only confirming on the preview" },
              " writes transactions, so waiting here, or abandoning the import, changes nothing.",
            ],
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Leave the page open; it refreshes itself. The link at the top takes you back to the account.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Import failed shows the reason in red. The usual causes are a file that is not really QFX, OFX or CSV, a CSV whose columns do not match the mapping you chose, or a file over the size limit. Delete batch & try again clears it so you can upload a corrected file.",
          },
          {
            kind: "callout",
            tone: "note",
            text: "If the status stays pending for minutes, the background worker may not be running. Settings → Instance shows when it last reported.",
          },
        ],
      },
    ],
    relatedRoutes: ["/settings/instance"],
  },
  {
    route: "/accounts/<id>/import/<id>/preview",
    title: "Preview import",
    summary:
      "What will this import add, change, or skip, and does it reconcile with the statement balance?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "The banner at the top checks the file against what the account already holds:",
          },
          {
            kind: "definition",
            term: "Reconciles to the cent",
            text: "The previous balance plus these new transactions equals the statement's ending balance. Safe to confirm.",
          },
          {
            kind: "definition",
            term: "Reconciliation mismatch",
            text: "They do not meet, and the drift is the gap. Usually transactions are missing from an earlier statement.",
          },
          {
            kind: "definition",
            term: "No prior snapshot, or no ending balance",
            text: "A first import takes the file's balance as the starting truth; a file without one, common for CSV, cannot be checked.",
          },
          {
            kind: "paragraph",
            text: "New, Duplicates (skipped) and Invalid count the rows, and each is listed below. Categories come from your rules; Uncategorized means none matched.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Confirm the import to write the new transactions, or Cancel to write nothing.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "callout",
            tone: "warning",
            text: "A credit-card statement with a positive ending balance would count the card as money you own. Confirm only if the card is overpaid; otherwise cancel and record the balance on the card's page, which asks for the amount owed.",
          },
        ],
      },
    ],
    terms: ["reconciliation-drift", "duplicate", "rule"],
    tour: {
      id: "import-preview",
      version: 1,
      steps: [
        {
          anchor: "preview-reconciliation",
          title: "Does it add up?",
          body: "The file's ending balance is checked against your last recorded balance plus these new transactions. A mismatch usually means a statement in between is missing.",
        },
        {
          anchor: "preview-counts",
          title: "New, duplicates, invalid",
          body: "New rows will be added, and duplicates are already here, so they are skipped. Invalid rows could not be read and are listed below.",
        },
        {
          anchor: "preview-confirm",
          title: "Confirm or cancel",
          body: "Confirm writes the new transactions and the statement's ending balance. Cancel leaves the account exactly as it was.",
        },
      ],
    },
  },
  {
    route: "/transactions",
    title: "Transactions",
    summary: "Which transactions match a payee, amount, date or category, across every account?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Every transaction in every account, newest first, with the account it belongs to. Amounts show their stored sign: money in is positive, money out negative. A card purchase is negative here, even though the card's own page shows it as a charge.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "steps",
            items: [
              "Search payee or memo text; any part of a word matches, from two characters.",
              "Narrow by amount, date range, category (including Uncategorized) or account.",
              "Page with Newer and Older, and click an account's name to open it.",
            ],
          },
          {
            kind: "paragraph",
            text: "Filters live in the page address, so a filtered view can be bookmarked or reopened from history. To change a category, open the account or use the review queue.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "callout",
            tone: "note",
            text: "The amount range uses the stored sign. For spending between ten and five hundred, set the minimum to −500 and the maximum to −10.",
          },
          {
            kind: "paragraph",
            text: "A transaction you expect may be in an account not yet imported or synced that far back, or excluded by a filter you forgot was set.",
          },
        ],
      },
    ],
    terms: ["uncategorized"],
    relatedRoutes: ["/analysis/review", "/accounts"],
    tour: {
      id: "transactions",
      version: 1,
      steps: [
        {
          anchor: "transactions-search",
          title: "Search",
          body: "Type part of a payee or memo; two characters is enough.",
        },
        {
          anchor: "transactions-category-filter",
          title: "What still needs a category",
          body: "Choose Uncategorized to list them. The review queue fixes them a payee at a time.",
        },
        {
          anchor: "transactions-apply",
          title: "Apply filters",
          body: "Filters take effect when you apply them. They live in the page address, so a filtered view can be bookmarked.",
        },
        {
          anchor: "transactions-account-column",
          title: "Changing a category",
          body: "Categories are not changed on this page. Click an account's name to change them there.",
        },
      ],
    },
  },
];
