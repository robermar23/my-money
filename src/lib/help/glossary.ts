/**
 * The glossary: one definition for each word the app uses with a precise
 * meaning (PLAN20 P20-09).
 *
 * Each entry answers two questions, in this order: what the word means here,
 * and what it tells you to do. A definition that only explains how a figure is
 * computed leaves the reader holding a number with nothing to do about it.
 *
 * `term` is the page's own wording, not ours: [copy.test.ts](./copy.test.ts)
 * fails when a term does not appear in the UI source, so the glossary follows
 * the pages and never the other way round. Help entries refer to terms by key,
 * and `GlossaryTermId` is those keys, so an entry naming a missing term does
 * not compile.
 *
 * Like the rest of the help content, this module is static text with no
 * imports: nothing here can read or interpolate the household's data.
 */

/** One glossary definition. */
export interface GlossaryEntry {
  /** The word as the pages print it. */
  readonly term: string;
  /** What it means in this app. */
  readonly means: string;
  /** What it tells you, or what to do about it. */
  readonly tellsYou: string;
}

export const GLOSSARY = {
  "net-worth": {
    term: "Net worth",
    means:
      "Everything you own that the app tracks, minus everything you owe: cash, investments, property and personal assets, less card balances and loans.",
    tellsYou:
      "Its direction over months matters more than any one day. To see why it moved, open Analysis → Net worth change.",
  },
  snapshot: {
    term: "Snapshot",
    means:
      "An account's balance recorded for one day. A nightly job writes one for every account, and every chart reads them.",
    tellsYou:
      "If an account's newest snapshot is days old, its balance on every chart is old too. Alerts says so when snapshots stop.",
  },
  "not-yet-explained": {
    term: "Not yet explained",
    means:
      "The part of a net-worth change the app cannot match to saving, retirement contributions, loan paydown, market moves or revaluation.",
    tellsYou:
      "It is a signal about missing or thin records, not a mistake you made. The causes listed under it each link to the screen that fixes them.",
  },
  "time-weighted-return": {
    term: "Time-weighted return",
    means:
      "How the investments themselves performed, with the timing and size of your deposits and withdrawals taken out. It is comparable to a fund's published return.",
    tellsYou:
      "Use it to compare against the S&P 500. It answers “were these good investments?”, not “did I do well?”.",
  },
  xirr: {
    term: "Money-weighted (XIRR)",
    means:
      "Your personal rate of return, which counts when and how much you put in. Buying heavily just before a rise raises it.",
    tellsYou:
      "When it differs from the time-weighted return, your timing helped or hurt. The gap is the point, not an error.",
  },
  "cost-basis": {
    term: "Cost basis",
    means: "What you paid for a holding. Gain or loss is its current value minus this.",
    tellsYou:
      "A dash means no cost was recorded, so gain or loss is unknown rather than zero. Adding lots fills it in.",
  },
  "cost-basis-lot": {
    term: "Cost-basis lot",
    means:
      "One purchase of a holding: when, how many, and what it cost. Lots, when present, replace a single total cost.",
    tellsYou:
      "Record a lot per purchase for an accurate gain or loss. Lots are for accuracy only, not for taxes.",
  },
  allocation: {
    term: "Allocation",
    means:
      "How your invested money divides by asset class, sector, region or account. The slices always add up to the whole portfolio.",
    tellsYou:
      "A slice far larger than you intended is concentration risk. Holdings with no published classification show as Unclassified.",
  },
  "savings-rate": {
    term: "Savings rate",
    means:
      "On the dashboard: your own payroll retirement contributions over the last 12 months, divided by your yearly gross pay. The employer match is shown beside it, not in it.",
    tellsYou:
      "Raise it by changing your contribution in Settings → Income. It is the app's only savings rate; Analysis's Income kept tile is a different figure, the share of income left after spending.",
  },
  "safe-to-spend": {
    term: "Safe to spend",
    means:
      "How much more than your usual spending you could spend before the projection window ends without your everyday accounts falling below your cash cushion.",
    tellsYou:
      "It is an allowance, not a balance. It comes from the tightest day ahead, so spending it early is fine and spending it twice is not.",
  },
  "lowest-projected-balance": {
    term: "Lowest projected balance",
    means:
      "The day your everyday accounts are projected to hold the least before the window ends, and how much they hold then.",
    tellsYou:
      "That date is when a large purchase would hurt most. If it is below your cushion, move money in before then.",
  },
  "cash-cushion": {
    term: "Cash cushion",
    means:
      "The balance you want never to drop below. Safe to spend is measured down to it, not down to zero.",
    tellsYou:
      "Set it in Settings → Household. Left blank it is zero: the app never invents a cushion for you.",
  },
  "emergency-fund": {
    term: "Emergency fund",
    means:
      "Savings sized to cover several months of essential expenses. The number of months comes from your household settings or a conventional default.",
    tellsYou:
      "Only savings above this target count as available for planned costs, so one pot is never counted twice.",
  },
  "sinking-fund": {
    term: "Sinking fund",
    means:
      "Money you should already have set aside for an irregular cost you know is coming, such as an annual premium or a tax bill.",
    tellsYou:
      "The app computes what is required and compares it with savings you already hold. It never moves or reserves money.",
  },
  "required-today": {
    term: "Required today",
    means:
      "How much of a known cost should already be set aside, spread evenly by whole months from when you started saving for it to when it is due.",
    tellsYou:
      "On the due date it equals the whole cost. Short of it now means setting aside the per-month figure to catch up.",
  },
  "recurring-bill": {
    term: "Recurring bill",
    means:
      "A payment or receipt you confirmed repeats on a schedule, such as rent, a subscription or a paycheck. The cash-flow projection puts each one on its due date.",
    tellsYou:
      "The more of your spending is confirmed bills, the sharper the projection. Suggestions are never added until you confirm them.",
  },
  "review-queue": {
    term: "Review queue",
    means: "Every transaction that has no category yet, grouped by payee.",
    tellsYou:
      "Uncategorized spending is left out of spending totals and budgets, so a long queue makes those figures low. Clear it with a rule per payee.",
  },
  rule: {
    term: "Rule",
    means:
      "A pattern matched against a transaction's payee or memo that sets its category automatically. Rules are tried in priority order and the first match wins.",
    tellsYou:
      "A rule saves you categorizing the same payee every month. A category you set by hand is never overwritten by a rule.",
  },
  uncategorized: {
    term: "Uncategorized",
    means: "A transaction with no category, so the app cannot tell whether it is spending.",
    tellsYou:
      "It counts toward no total. Pick a category, or let the review queue do a whole payee at once.",
  },
  kind: {
    term: "Kind",
    means:
      "Whether a category is income, expense or transfer. Transfers are money moving between your own accounts, including card payments.",
    tellsYou:
      "Set card payments and account moves to a transfer category, or they count as spending twice.",
  },
  necessity: {
    term: "Necessity",
    means:
      "Whether an expense category is essential (you would still pay it if money got tight), discretionary, or savings.",
    tellsYou:
      "Essential spending sizes your emergency fund. Unclassified categories make that target low, and the app says by how much.",
  },
  "reconciliation-drift": {
    term: "Reconciliation drift",
    means:
      "The difference between a balance your bank reported and the balance the app gets by adding up the transactions it has.",
    tellsYou:
      "Zero means the records agree. Anything else usually means a statement is missing; importing it closes the gap.",
  },
  duplicate: {
    term: "Duplicate",
    means:
      "A transaction in an import file that is already in the account, recognized by the bank's own transaction ID, or in a CSV by date, amount, payee and memo.",
    tellsYou:
      "Duplicates are skipped, so importing the same or an overlapping file twice is always safe.",
  },
  connection: {
    term: "Connection",
    means:
      "A link to one bank or brokerage through Plaid, covering every account you mapped at that institution.",
    tellsYou:
      "Reconnect needed means the bank wants you to sign in again. Until you do, those accounts stop updating.",
  },
  "pretend-position": {
    term: "Pretend position",
    means:
      "An optional made-up purchase of a watched symbol (date, quantity, cost per unit) used to show what it would have gained or lost.",
    tellsYou:
      "It is never counted in net worth, so you can try any amount without affecting a real figure.",
  },
  "price-target": {
    term: "Price target",
    means:
      "A price that raises an alert when a watched symbol's daily close reaches it, rising to or falling to the threshold.",
    tellsYou:
      "A target fires once and then pauses. Re-arm it if you want to be told again. It checks the daily close, not prices during the day.",
  },
  "forward-income": {
    term: "Forward income",
    means:
      "The dividends and interest your current holdings would pay over the next 12 months at their current published rates.",
    tellsYou:
      "It is an estimate that assumes nothing changes. Holdings that pay nothing add nothing.",
  },
  "yield-on-cost": {
    term: "Yield on cost",
    means: "Forward income divided by what you paid for the holdings that produce it.",
    tellsYou:
      "It shows the income return on your own money, which rises as payouts grow on a position you bought long ago.",
  },
  "take-home": {
    term: "Take-home",
    means:
      "What actually reaches your bank from a paycheck after taxes and deductions, as opposed to gross pay.",
    tellsYou:
      "The cash-flow projection uses take-home for paydays. Stating it per paycheck in Settings → Income makes each payday exact.",
  },
  rung: {
    term: "Rung",
    means:
      "One step of the fixed order in which guidance suggests using your next dollar, from a small starter buffer up to taxable savings.",
    tellsYou:
      "Work from the top. Missing an input means the app cannot tell, which is never the same as done.",
  },
  "account-subtype": {
    term: "Account subtype",
    means: "What a cash account is for: checking, savings, money market, CD, or cash management.",
    tellsYou:
      "Cash flow walks only checking and cash management accounts, and guidance reads savings as your reserve. An unset subtype leaves the account out of both.",
  },
} as const satisfies Record<string, GlossaryEntry>;

/** The key of a glossary term. Help entries name terms by these keys. */
export type GlossaryTermId = keyof typeof GLOSSARY;
