# Spending, categories and budgets

Where the money goes, by category and by month, and whether this month is on
budget. Every figure is first-party SQL over your own Postgres: no third-party
analytics and no model-based categorization.

## Categories

Transactions are organized by a two-level taxonomy: leaf **categories** grouped
into **groups**. Each category is tagged `income`, `expense` or `transfer`, so
moves between your own accounts and credit-card payments never count as
spending.

- **Categorize one transaction** from its category picker. "+ new category"
  creates one inline and can add a rule at the same time.
- **Clear the backlog** at `/analysis/review`, which lists every uncategorized
  transaction.
- **Manage categories, groups and rules** at `/settings/categories`. Rules are
  regular expressions matched against the payee name or the memo, tried in
  priority order; the first match wins.

After editing rules in bulk, re-apply them to existing transactions once:

```sh
pnpm worker:once backfill-categories             # development
sh scripts/prod.sh job backfill-categories       # production
```

## Spending analysis

`/analysis` shows income, expense, net and savings-rate tiles; spending by
month, stacked by category, with a net line; a category breakdown; and a
drill-down per category at `/analysis/category/<id>`. Date range and account
filters live in the URL, so a view can be bookmarked.

The monthly chart extends one **projected** month (dashed) from the trailing
three-month average. It is an average, not a forecast of anything specific.

## Budgets

`/analysis/budgets` sets a monthly target per expense category and shows actual
against target (over budget is red), with group roll-ups and a month switcher.
For the current month it also marks a **projected end-of-month** figure from
the month-to-date run rate.

Budgets compare; they do not allocate. Nothing is set aside, moved or reserved,
and there are no envelopes. For irregular costs that need money held back, see
[SINKING.md](SINKING.md).
