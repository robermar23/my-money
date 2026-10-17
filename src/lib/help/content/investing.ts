import type { HelpEntry } from "../types.ts";

/**
 * Help for the Investing pages (PLAN20 P20-10).
 *
 * Sources: `src/app/investments/**` and `src/app/watchlist/**`;
 * docs/INVESTMENTS.md and docs/WATCHLIST.md.
 */
export const INVESTING_HELP: readonly HelpEntry[] = [
  {
    route: "/investments",
    title: "Portfolio",
    summary: "What do I hold, what did it cost, and what is it worth?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "The total is every holding in your investment and crypto or metals accounts, valued at quantity times the latest price. Beneath it are the total cost basis and the gain or loss, counting only holdings whose cost is known.",
          },
          {
            kind: "paragraph",
            text: "Allocation splits the portfolio by asset class, sector, region or account. Top holdings shows each name's share of the whole portfolio, so concentration in one position stands out.",
          },
          {
            kind: "paragraph",
            text: "Each account then lists its holdings. A † marks a cost basis built from your payroll contributions. Dividend & interest income shows what was actually paid, by month, quarter or year.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Refresh prices, filter holdings by symbol or name (totals and allocation stay whole), switch the allocation view, or click a symbol for its own page. Holdings are added and edited on each investment account's page.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "definition",
            term: "A value shown as a dash",
            text: "No price yet. Prices arrive overnight; check the symbol is a real ticker.",
          },
          {
            kind: "definition",
            term: "A gain or loss shown as a dash",
            text: "No cost recorded. Add cost-basis lots on the account page.",
          },
          {
            kind: "definition",
            term: "An Unclassified slice",
            text: "Holdings with no published sector or region, such as crypto, metals and many workplace-plan funds.",
          },
        ],
      },
    ],
    terms: ["allocation", "cost-basis"],
    relatedRoutes: ["/investments/performance", "/investments/forecast"],
    tour: {
      id: "investments",
      version: 1,
      steps: [
        {
          anchor: "investments-total",
          title: "The total",
          body: "What everything here is worth today, beside what you paid for it. The gain or loss counts only holdings whose cost is known.",
        },
        {
          anchor: "investments-refresh",
          title: "Refresh prices",
          body: "Prices update every night on their own. This fetches them now.",
        },
        {
          anchor: "investments-allocation",
          title: "Allocation",
          body: "How the portfolio splits by asset class, sector, region or account. Top holdings shows how much rests on a few positions.",
        },
        {
          anchor: "investments-cost-basis",
          title: "Cost basis",
          body: "What you paid for each holding, so a dash means gain or loss is unknown, not zero. A † marks a cost tracked from payroll contributions.",
        },
        {
          anchor: "investments-income",
          title: "Dividend & interest income",
          body: "What your holdings paid out, by month, quarter or year.",
        },
      ],
    },
  },
  {
    route: "/investments/performance",
    title: "Performance",
    summary: "How has the portfolio performed against the S&P 500?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Pick a date range, and optionally one account. Four figures cover that window:",
          },
          {
            kind: "definition",
            term: "Time-weighted and money-weighted return",
            text: "The first is how the investments did; the second is how you did, counting when you added money. A gap between them is your timing.",
          },
          {
            kind: "definition",
            term: "Gain / loss",
            text: "Value minus cost basis at the end of the window.",
          },
          {
            kind: "definition",
            term: "vs S&P 500",
            text: "Your time-weighted return minus the index's over the same window. The benchmark is fixed, so past figures never shift.",
          },
          {
            kind: "paragraph",
            text: "Contributions vs. market growth splits the change in value into money you added and what the market did with it. It answers “did it grow, or did I just add money?”",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Change the range or the account. Everything here is a display figure; none of it is tax reporting.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "With fewer than two days of holdings history in the window, the page shows no return at all rather than an invented one. History from before you started using the app is estimated from today's quantities at past prices, so early ranges are approximate.",
          },
        ],
      },
    ],
    terms: ["time-weighted-return", "xirr", "cost-basis"],
    relatedRoutes: ["/investments", "/analysis/networth"],
    tour: {
      id: "performance",
      version: 1,
      steps: [
        {
          anchor: "performance-range",
          title: "Range and account",
          body: "Pick the period, and one account if you like. Every figure below follows it.",
        },
        {
          anchor: "performance-tiles",
          title: "Two kinds of return",
          body: "Time-weighted return is how the investments did, with your deposits and withdrawals taken out. XIRR is how your own money did, so it also reflects when you added it.",
        },
        {
          anchor: "performance-value",
          title: "Value & cost basis over time",
          body: "What the portfolio was worth against what you had paid in. The space between the lines is your gain or loss.",
        },
        {
          anchor: "performance-benchmark",
          title: "Return vs. benchmark",
          body: "Your time-weighted return beside the S&P 500, both starting at 100. Above its line means you did better over this range.",
        },
        {
          anchor: "performance-contributions",
          title: "Contributions vs. market growth",
          body: "Splits the change in value into money you added and what the market did with it.",
        },
      ],
    },
  },
  {
    route: "/investments/forecast",
    title: "Forecast",
    summary: "What will the portfolio pay out next year, and where could it be at a return I pick?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "callout",
            tone: "note",
            text: "Everything on this page is an illustrative estimate, not advice and not a prediction of the market.",
          },
          {
            kind: "paragraph",
            text: [
              { strong: "Forward income" },
              " is what today's holdings would pay over the next 12 months at their current published payout rates. Yield on cost compares that with what you paid. Trailing 12-mo income and Income YoY are what was actually received, not estimates.",
            ],
          },
          {
            kind: "paragraph",
            text: "Income growth shows the dividends and interest actually received each year.",
          },
          {
            kind: "paragraph",
            text: "Value projection compounds today's total at the rate you pick, as a dashed line because it is illustrative from start to end.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Choose a growth rate. Enter a goal target, and optionally a monthly contribution, to mark the date the projection reaches it, or to learn that it does not within a century.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Holdings with no published payout rate, such as crypto, metals and many workplace-plan funds, add nothing to forward income. Received income appears only where the account records dividends, which usually means a bank-synced brokerage.",
          },
        ],
      },
    ],
    terms: ["forward-income", "yield-on-cost"],
    relatedRoutes: ["/investments", "/investments/performance"],
  },
  {
    route: "/investments/security/<id>",
    title: "Security",
    summary: "What has one holding done, and what did I pay for each lot?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "The header gives the holding's account and classification, and its value: quantity times the last close, with the gain or loss beside it.",
          },
          {
            kind: "paragraph",
            text: "Beneath are its cost basis, forward yield and dividend per share, and the fund's expense ratio where one is published. A dash means the figure is not known.",
          },
          {
            kind: "paragraph",
            text: "Price history is the daily close for up to two years. Value & cost basis over time shows what the position was worth against what it cost. The lots table lists each purchase with its source, and Dividends received lists what it paid.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Read only. Lots are added and edited on the account's own page, under the holding. For a workplace plan funded from your paycheck, the cost basis comes from your contribution rules in Settings → Income, and the page says so.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Value history from before you started using the app is estimated from today's quantity at past prices. Manual holding in place of a name means the app has no market data for that symbol. Some contributions cannot be priced to a share count; their cost is still recorded, and the quantity stays your own entry.",
          },
        ],
      },
    ],
    terms: ["cost-basis-lot", "forward-income"],
    relatedRoutes: ["/investments", "/settings/income"],
  },
  {
    route: "/watchlist",
    title: "Watchlist",
    summary: "What am I watching, and has anything hit my price target?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Symbols you follow but do not need to own: stocks, funds, metals or crypto. Each row shows the last daily close and how many price targets it has.",
          },
          {
            kind: "paragraph",
            text: [
              "Pretend value and Gain/Loss appear only for a symbol with a pretend purchase. ",
              { strong: "Nothing here is ever counted in net worth" },
              ", however large the pretend position.",
            ],
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "steps",
            items: [
              "Add symbol to start watching one.",
              "Filter by symbol, name or notes.",
              "Open a symbol to see its price history and set price targets.",
            ],
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "History for a newly added symbol is fetched once, on a best-effort basis, so an obscure or foreign ticker may start thin and fill in nightly. A target that the price crossed during the day but not at the close did not fire: targets check the daily close only.",
          },
          {
            kind: "callout",
            tone: "note",
            text: "A fired target raises an alert and then pauses itself. Re-arm it on the symbol's page to be told again.",
          },
        ],
      },
    ],
    terms: ["pretend-position", "price-target"],
    relatedRoutes: ["/alerts", "/investments"],
  },
  {
    route: "/watchlist/new",
    title: "Add to watchlist",
    summary: "Which symbol do I want to watch, and do I want to pretend I bought it?",
    sections: [
      {
        heading: "How to fill it in",
        blocks: [
          {
            kind: "definition",
            term: "Symbol and type",
            text: "The ticker, and whether it is a stock or ETF, crypto, or a metal. The type decides where its prices come from.",
          },
          {
            kind: "definition",
            term: "Display name",
            text: "Optional; shown alongside the symbol.",
          },
          {
            kind: "definition",
            term: "Pretend position",
            text: "Optional, and all three or none: a quantity, a cost per unit and a purchase date. With it, the symbol shows what that made-up buy would be worth now.",
          },
          {
            kind: "definition",
            term: "Notes",
            text: "Optional; why you are watching it. Notes are searchable on the watchlist.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Add symbol. The app then fetches its daily price history, back to the pretend purchase date or for the last two years. Price targets are set afterwards, on the symbol's own page.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "A symbol the price sources do not know will show no price; check the ticker, and the type. Watching a symbol you also hold is fine: the holding counts toward net worth and the watched copy does not.",
          },
        ],
      },
    ],
    terms: ["pretend-position"],
    relatedRoutes: ["/watchlist"],
  },
  {
    route: "/watchlist/<id>",
    title: "Watchlist item",
    summary: "How has a symbol I am watching moved, and how close is it to my target?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "The last daily close, and, with a pretend position, its pretend value, cost basis, gain or loss and return. The symbol is marked Not counted in net worth, and it never is.",
          },
          {
            kind: "paragraph",
            text: "Price history runs from the pretend purchase date, or over the last two years. Limited history means the first fetch found little; the nightly price update fills it in over time.",
          },
          {
            kind: "paragraph",
            text: [
              "Each price target shows its direction, threshold and status: ",
              { strong: "Armed" },
              " is waiting, ",
              { strong: "Triggered" },
              " gives the date and close that fired it, and ",
              { strong: "Paused" },
              " is waiting for you.",
            ],
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Add target with a direction (rises to or above, falls to or below), a threshold and an optional note. Pause an armed target, re-arm a paused or triggered one, or delete it. Edit changes the symbol's details; Delete watchlist item removes it.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Targets are checked once a night against the daily close, not during the day. A close exactly at the threshold counts as reaching it. A target fires once, raises an alert, and pauses, so it never nags while the price sits past it.",
          },
        ],
      },
    ],
    terms: ["price-target", "pretend-position"],
    relatedRoutes: ["/watchlist", "/alerts"],
  },
  {
    route: "/watchlist/<id>/edit",
    title: "Edit watchlist item",
    summary: "How do I change a watched symbol's name, pretend position, or notes?",
    sections: [
      {
        heading: "How to fill it in",
        blocks: [
          {
            kind: "paragraph",
            text: "The same fields as adding a symbol, filled in with what you entered before. Change any of them and press Save changes.",
          },
          {
            kind: "definition",
            term: "Pretend position",
            text: "A quantity, a cost per unit and a purchase date, all three or none. Clearing all three turns the symbol back into a plain watch with no gain or loss.",
          },
          {
            kind: "definition",
            term: "Display name and notes",
            text: "Free text for your own reference. Notes are searchable from the watchlist.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Edit the symbol's details only. Price targets are managed on the symbol's page, which the link at the top returns you to, and deleting the symbol is done there too.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "A pretend gain or loss is a display figure only. Changing it here moves nothing anywhere else in the app: the watchlist is never part of net worth, allocation or performance.",
          },
        ],
      },
    ],
    terms: ["pretend-position"],
    relatedRoutes: ["/watchlist"],
  },
];
