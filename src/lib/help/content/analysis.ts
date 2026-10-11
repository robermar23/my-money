import type { HelpEntry } from "../types.ts";

/**
 * Help for the Analysis pages (PLAN20 P20-10).
 *
 * Sources: `src/app/analysis/**` and `src/lib/net-worth/decompose.ts` (the rung
 * labels); docs/SPENDING.md, docs/ATTRIBUTION.md, docs/INCOME.md §The savings
 * rate.
 */
export const ANALYSIS_HELP: readonly HelpEntry[] = [
  {
    route: "/analysis",
    title: "Analysis",
    summary: "Where does the money go, by category and by month?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Everything covers the window you pick, across all accounts or one. Income and Expense come from categorized transactions; transfers between your own accounts count as neither. Net is income minus expense, and Income kept is net as a share of income: what was left after spending.",
          },
          {
            kind: "paragraph",
            text: "Spending by month stacks each month's spending by category, with net as a line. A dimmed extra bar after the last month is the average of the three months before it; it is an average, not a forecast.",
          },
          {
            kind: "paragraph",
            text: "The breakdown and Spending detail rank where the money went. The sentence under the tiles summarises how net worth moved over the same window.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Pick a preset window or your own dates, narrow to one account, switch between categories and groups, and click a category for its history. The window and account live in the address, so a view can be bookmarked.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Uncategorized transactions count toward nothing, so a long backlog makes spending look low; the amber banner says how much and links to the review queue. Card payments counted as spending mean the payment's category is not a transfer.",
          },
          {
            kind: "callout",
            tone: "note",
            text: "Income kept is not the dashboard's savings rate. That one measures your retirement contributions against gross pay, over a fixed 12 months.",
          },
        ],
      },
    ],
    terms: ["uncategorized", "kind", "savings-rate"],
    relatedRoutes: ["/analysis/review", "/analysis/networth", "/analysis/budgets"],
  },
  {
    route: "/analysis/networth",
    title: "Net worth change",
    summary:
      "Why did my net worth change: saving, markets, debt paydown, or something unexplained?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "The sentence states how much net worth moved over the window and what mostly drove it. The start and end figures are the same ones the dashboard draws. The chart then walks from start to end, one cause at a time:",
          },
          {
            kind: "steps",
            items: [
              "Saved from income: money in minus money out, from your transactions.",
              "Retirement contributions: payroll money that never passed through checking.",
              "Loan principal paid: how much your loans shrank, from their schedules.",
              "Investment return: what the market did, after removing money you added.",
              "Property & asset revaluation: changes in values you recorded.",
              "Not yet explained: whatever the five above do not account for.",
            ],
          },
          {
            kind: "callout",
            tone: "note",
            text: "A mortgage payment lowers Saved by the whole payment, and Loan principal paid adds back the part you still own. Together they come to the interest, which is exactly what the payment cost you.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Change the window. Under each figure, Worked out from lists its inputs. Each cause under Why some of it is unexplained has a Fix this link to the screen that clears it.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Common causes of a large unexplained share: uncategorized transactions, transfers to accounts the app does not track, an account whose balance changed with no transactions, balances more than 45 days old at either end, and a loan with no terms. When most of the change is unexplained, the page lists the causes first.",
          },
        ],
      },
    ],
    terms: ["not-yet-explained", "net-worth"],
    relatedRoutes: ["/analysis", "/investments/performance", "/"],
  },
  {
    route: "/analysis/category/<id>",
    title: "Category detail",
    summary: "What has one category cost me over time?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "The figure beside the name is the category's total over the window you came from, and the line under it gives the category's group, its kind and that window.",
          },
          {
            kind: "paragraph",
            text: "The chart shows the total month by month, so a rising cost or a one-off spike stands out. Below it, every transaction in the category for the window, newest first, with the account each came from.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "paragraph",
            text: "Page through the transactions, and go back to Analysis with the same window and account still applied. To compare months against a target, set the category a monthly budget in Budgets.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: [
              "A transaction that belongs here but is missing is either uncategorized or in another category. Fix it from its account's page, or with a ",
              { strong: "rule" },
              " so the same payee lands here every time.",
            ],
          },
          {
            kind: "paragraph",
            text: "A payment that does not belong here at all usually means a rule matched too broadly. Settings → Categories lets you test a rule's pattern against existing transactions before you change it.",
          },
        ],
      },
    ],
    terms: ["rule", "kind"],
    relatedRoutes: ["/analysis", "/analysis/budgets", "/settings/categories"],
  },
  {
    route: "/analysis/budgets",
    title: "Budgets",
    summary: "Am I on budget this month?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "One row per expense category, grouped, with this month's spending against the monthly target you set: what is left, or how far over in red. The total at the top adds up every budgeted category.",
          },
          {
            kind: "paragraph",
            text: "For the current month, a projected figure estimates where each category ends the month if spending continues at its pace so far. It is a run rate, not a forecast.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "steps",
            items: [
              "Type a monthly target beside a category, or clear it.",
              "Step to earlier months with the arrows to see how they went.",
              "Open Suggest budgets from your spending: targets are the median of recent complete months, so one unusual month does not inflate them. Tick the ones you want, adjust, and Apply. Nothing is saved before that.",
            ],
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "Actuals count categorized spending only; transfers are excluded and uncategorized transactions are missing until you categorize them. A category absent from the list may be set as income or transfer rather than expense.",
          },
          {
            kind: "callout",
            tone: "note",
            text: "Budgets compare; they do not set money aside. For costs that arrive once or twice a year, use Sinking funds.",
          },
        ],
      },
    ],
    terms: ["uncategorized", "kind"],
    relatedRoutes: ["/analysis/review", "/plan/sinking"],
  },
  {
    route: "/analysis/review",
    title: "Review queue",
    summary: "Which transactions still need a category?",
    sections: [
      {
        heading: "How to read it",
        blocks: [
          {
            kind: "paragraph",
            text: "Every uncategorized transaction, grouped by payee, with how many there are and their total. The count at the top is the whole backlog.",
          },
          {
            kind: "paragraph",
            text: "Uncategorized transactions are left out of spending, budgets and guidance, so this list is the gap between those figures and reality.",
          },
        ],
      },
      {
        heading: "What you can do here",
        blocks: [
          {
            kind: "steps",
            items: [
              "Pick a category for a payee, or create one with + New category.",
              "Leave make rule ticked to have future transactions from that payee categorized automatically.",
              "Press Categorize all, and the payee leaves the list.",
            ],
          },
          {
            kind: "paragraph",
            text: "Working the largest groups first clears the most money for the fewest clicks.",
          },
        ],
      },
      {
        heading: "When it looks wrong",
        blocks: [
          {
            kind: "paragraph",
            text: "A payee that keeps coming back has no rule, or its rule's pattern no longer matches how the bank writes the name. Rules, their priority and their patterns are managed in Settings → Categories, where Re-categorize existing transactions applies a changed rule to the past.",
          },
          {
            kind: "callout",
            tone: "note",
            text: "Moves between your own accounts, and card payments, belong in a transfer category so they never count as spending.",
          },
        ],
      },
    ],
    terms: ["review-queue", "rule", "uncategorized"],
    relatedRoutes: ["/settings/categories", "/analysis"],
  },
];
