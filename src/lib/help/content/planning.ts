import type { HelpEntry } from "../types.ts";

/**
 * Help for the Planning pages (PLAN20 P20-10).
 *
 * Sources: `src/app/plan/**` and `src/lib/advice/rules/waterfall.ts` (the rung
 * names); docs/GUIDANCE.md, docs/CASHFLOW.md, docs/SINKING.md.
 */
export const PLANNING_HELP: readonly HelpEntry[] = [
  {
    route: "/plan",
    title: "Guidance",
    summary: "What should I do next with my money: emergency fund, match, debt, retirement?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Guidance applies conventional rules of thumb to your own records. It is not financial advice: it recommends amounts and structures, never a product, and does no tax calculation.",
          },
          {
            kind: "paragraph",
            text: "Where your next dollar goes is a fixed ladder, worked top to bottom: starter buffer, employer match, high-interest debt, full emergency reserve, IRA and HSA, workplace plan to the annual cap, then taxable and medium-term savings. Each rung is Done, Working on this, Comes later, or Missing an input.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Missing an input means the app cannot tell. It never means you are fine, and a rung is never marked done on data the app does not have.",
          },
          {
            kind: "paragraph",
            text: "What to look at ranks the recommendations by urgency. Each names its rule of thumb, its confidence, and every input it used; an input shown as not recorded is the one to supply.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Follow an input's link to fill it in. Hide a recommendation for 30 days, 90 days, or for good; Hidden by you, at the bottom, lists each one with a way to bring it back.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "A wrong recommendation points at a wrong input. The usual ones: a cash account with no subtype, a card with no interest rate, expense categories not marked essential, or household details left at their defaults. Some rules stay quiet until there are enough months of history to answer honestly, and the page lists them.",
          },
        ],
      },
    ],
    terms: ["rung", "emergency-fund", "necessity"],
    relatedRoutes: ["/settings/household", "/settings/categories", "/plan/cashflow"],
  },
  {
    route: "/plan/cashflow",
    title: "Cash flow",
    summary: "Will my cash cover the bills ahead, and how much is safe to spend?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: [
              { strong: "Safe to spend" },
              " is how much you could spend on top of your usual spending before the window ends and still keep your cushion. It is always stated with the window and the cushion, because on its own it would read as a balance.",
            ],
          },
          {
            kind: "paragraph",
            text: "If the balance is projected to drop below the cushion, the headline becomes a shortfall: how far below, and on which day, with whether your savings could cover it in time.",
          },
          {
            kind: "paragraph",
            text: "The chart walks your checking and cash-management accounts forward day by day. Bills and pay land on their dates; everyday spending is spread evenly. What is coming lists the bills by week.",
          },
          {
            kind: "paragraph",
            text: "The share of your recent spending that is known bills says how much to trust the line. Under a quarter, most of it is a flat average.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Confirm recurring bills to sharpen the dates. Set the cushion and the window in Settings → Household. Where these numbers came from links each input to the screen that fixes it.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "steps",
            items: [
              "Check the known-bills share first.",
              "Check account subtypes: savings, CDs, investments and cards are left out on purpose; an account with no subtype is left out too.",
              "Check a confirmed bill's date and how often it repeats.",
              "A sudden cliff may be a one-off cost you recorded under Sinking funds; hover the day to see.",
            ],
          },
        ],
      },
    ],
    terms: ["safe-to-spend", "lowest-projected-balance", "cash-cushion", "account-subtype"],
    relatedRoutes: ["/plan/cashflow/review", "/settings/household", "/plan/sinking"],
  },
  {
    route: "/plan/cashflow/review",
    title: "Recurring bills",
    summary: "Which recurring bills does the app expect, and are they right?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Nothing reaches the cash-flow calendar until you confirm it here. There are three lists:",
          },
          {
            kind: "definition",
            term: "From your loan terms",
            text: "A schedule for each loan whose terms you recorded. The amount comes from your own payments where there are some, so escrow is included; otherwise it is principal and interest only, and says so.",
          },
          {
            kind: "definition",
            term: "Suggestions",
            text: "Series the app found repeating in your last two years of transactions, rated Strong match, Likely or Possible. Show the charges lists the transactions behind each.",
          },
          {
            kind: "definition",
            term: "Confirmed bills",
            text: "What the projection expects, payments and receipts alike.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Correct a suggestion's name, amount, repeat or category, then Confirm it, or confirm every strong match at once. Not a bill dismisses one; Ask me in 90 days snoozes it. Add a bill by hand, Edit one, or Stop one, which keeps its history.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "A confirmed bill is matched to a real transaction within a few days of its date and close to its amount. One that never matches raises an alert, “A bill did not post”, so check its date and amount. Choose Varies for a utility-style bill whose amount moves.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "When a suggestion and a loan schedule are the same payments, the page warns you. Add one of them, not both, or the calendar expects the money twice.",
          },
        ],
      },
    ],
    terms: ["recurring-bill"],
    relatedRoutes: ["/plan/cashflow", "/plan/sinking"],
  },
  {
    route: "/plan/sinking",
    title: "Sinking funds",
    summary: "How much should I be holding now for irregular costs like insurance or a car?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "The headline says what you should already be holding for the known costs in the next 12 months, and how much savings you have above your emergency-fund target to hold it with. Below that you are short, spare or level, with the monthly amount that keeps you on track.",
          },
          {
            kind: "paragraph",
            text: "Costs come from two places: those you record here, and confirmed bills that repeat quarterly, twice a year or yearly. Monthly bills are left out, because everyday spending already pays them.",
          },
          {
            kind: "paragraph",
            text: "The table shows each cost, its months left, its per-month share, and how much of it is required today.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Add a cost: what it is, the whole cost, when it is due, and when you start setting aside for it. Edit it, Mark paid once you have paid it, or Cancel it. Paid and cancelled costs stay listed but count for nothing.",
          },
          {
            kind: "callout",
            tone: "note",
            text: "Nothing here moves or reserves money. It compares a requirement with savings you already hold.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Nothing recorded to work from yet is not the same as on track: record the costs you know are coming. With too little classified spending there is no emergency-fund target to measure against, so mark categories as essential. A paid cost keeps counting, as past due, until you mark it paid. A cost that looks like a bill you already track is flagged, and Record it anyway counts both.",
          },
        ],
      },
    ],
    terms: ["sinking-fund", "required-today", "emergency-fund"],
    relatedRoutes: ["/plan/cashflow/review", "/settings/categories"],
  },
];
