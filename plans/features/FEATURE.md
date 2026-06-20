# my-money

I want to be able to track all of my income and expenses, assets, savings and investements.

I am not trying to replace Quicken or Quickbooks.

But I want a tool I can use to store personal finances.

Ideally it can integrate into the company's systems I use for banking and investing and any other online tool that can help gather info on those topics.

- I have accounts with M&T Bank where all income and payments go in and out of
- I have investment/401k accounts with:
  - Fidelity Investments
  - iTrust Capital
- I own a home and it has value and a mortgage with Sunwest Mortage
- I have a credit card account to track

Now even if not all these systems can be integrated with, I want to track them all over time.

how much I have vs owe.  total in accounts.  total value.

For investments, I want it to track value of stocks and minerals and crypto.

There are tools for this online but they call cost money and/or off easy integrations but then sell your data or advertise to you.

I want my own tool tracking my own data.

---

## Scope updates

This section records explicit, owner-approved changes to the domain scope that
CLAUDE.md §Domain Scope marks as requiring an explicit decision before they may
be built. CLAUDE.md points here as the authoritative place for those decisions.

### 2026-06-19 — Spending analytics + simple budgets (in scope)

Source: [IDEAS2.md](IDEAS2.md). The owner explicitly asked to "expand my-money
to provide details on spending and budgets related to categories" and to see
"historical and future trends … as a whole, per category, per account."

- **In scope (newly added):**
  - **Spending analytics** — historical income/expense trends as a whole, per
    category, per group, and per account, over time (first-party SQL only).
  - **Simple monthly per-category budget targets** — a recurring monthly target
    per category with actual-vs-target tracking, plus a deterministic
    trailing-average forecast of future spend.
- **Still explicitly OUT of scope:** envelope / rollover / "assign every dollar"
  (YNAB-style) budgeting; tax forms or capital-gains reporting; anything that
  ships financial data to a third-party (no LLM categorization, no analytics
  SaaS — per CLAUDE.md §Privacy).

Implemented under **ADR-018** (IDEAS.md §11 Decision Log) via [PLAN8.md](PLAN8.md).

### 2026-06-20 — Investment history, performance, asset intelligence, forward view (in scope)

Source: [IDEAS2.md](IDEAS2.md) Round 3. The owner asked to expand investments the
way spend was expanded: "Historical as well as future. Can we bring in any info on
the invested assets? How can we slice the data?"

- **In scope (newly added):**
  - **Per-holding history** — a daily value per position (`holding_snapshots`) so
    investment value can be sliced over time by asset class / account / security.
  - **Asset intelligence** — sector / industry / asset-type / region / forward
    dividend metadata pulled from the same public market-data source already used
    for prices, to slice allocation and project forward income.
  - **Performance display** — value & gain/loss over time, contributions-vs-market-
    growth, time-weighted (TWR) and money-weighted (XIRR) return, and an `^GSPC`
    benchmark comparison. **All read-only display metrics.**
  - **Forward view** — projected forward dividend income + yield-on-cost, an
    income-growth trend, and a **clearly-labeled illustrative value projection**
    with a single-target goal/retirement marker.
- **Reaffirmed OUT of scope (not relaxed):** tax-lot selection (FIFO/LIFO/specific-
  ID), wash-sale tracking, realized-vs-unrealized capital-gains *reporting*, 1099
  generation, and any financial *advice* feature. TWR/XIRR/projection are display
  numbers; the value projection is a labeled estimate, never a recommendation.
  Crossing this line needs a new FEATURE.md decision first.
- **Privacy stance:** the asset-intelligence fetch sends **only ticker symbols**
  outbound to the public market-data endpoint — the exact data category and trust
  boundary the existing price fetch already crosses. No quantities, balances,
  account names, or holdings leave the host; all analytics are first-party SQL.

Implemented under **ADR-019 → ADR-022** (IDEAS.md §11 Decision Log) via [PLAN9.md](PLAN9.md).

