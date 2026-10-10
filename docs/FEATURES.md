# What my-money does

One line per surface: the question it answers, where it lives, and the document
that explains it. If you know a page exists, **⌘K / Ctrl-K** takes you there;
this page is for finding out what exists in the first place.

Everything below runs on your server and reads only your own database. Nothing
is sent anywhere, except the bank sync (Plaid) and price lookups, and only if
you turn them on. The app is built for US households and US dollars
([README §Scope](../README.md#scope-us-households-us-dollars)).

Trying it out? `make seed-demo` (or [DEPLOY.md §2.0](DEPLOY.md#20--optional-try-it-on-demo-data-first)
on a production stack) fills an empty instance with a fictional household, so
every page below has something to show.

## Overview

| Question | Where | More |
|---|---|---|
| Where do I stand right now: net worth, this month's spending, savings rate? | `/` Dashboard | [DASHBOARD.md](DASHBOARD.md) |
| Is anything wrong: a large charge, a stale account, a failed sync or backup? | `/alerts` | [ALERTS.md](ALERTS.md) |
| Where is that transaction, account, or security? | ⌘K anywhere, or `/transactions` | [SEARCH.md](SEARCH.md) |

## Accounts and transactions

| Question | Where | More |
|---|---|---|
| What accounts do I have, and is each one up to date? | `/accounts` | [PLAID.md](PLAID.md), [IMPORT.md](IMPORT.md) |
| How do I add an account by hand, including a house, car, or collectible? | `/accounts/new` | [ASSETS.md](ASSETS.md) |
| What is in one account: balance history, transactions, holdings, loan or card terms? | `/accounts/<id>` | [INVESTMENTS.md](INVESTMENTS.md), [ASSETS.md](ASSETS.md) |
| How do I load a bank's QFX or CSV export, and did it reconcile? | `/accounts/<id>/import` | [IMPORT.md](IMPORT.md) |
| Which transactions match a payee, amount, date or category, across every account? | `/transactions` | [SEARCH.md](SEARCH.md) |
| Which transactions still need a category? | `/analysis/review` | [SPENDING.md](SPENDING.md) |

## Investing

| Question | Where | More |
|---|---|---|
| What do I hold, what did it cost, and what is it worth? | `/investments` | [INVESTMENTS.md](INVESTMENTS.md) |
| What has one holding done, and what did I pay for each lot? | `/investments/security/<id>` | [INVESTMENTS.md](INVESTMENTS.md) |
| How has the portfolio performed against the S&P 500? | `/investments/performance` | [INVESTMENTS.md](INVESTMENTS.md) |
| What will the portfolio pay out next year, and where could it be at a return I pick? | `/investments/forecast` | [INVESTMENTS.md](INVESTMENTS.md) |
| What am I watching, and has anything hit my price target? | `/watchlist` | [WATCHLIST.md](WATCHLIST.md) |

## Spending and net worth

| Question | Where | More |
|---|---|---|
| Where does the money go, by category and by month? | `/analysis` | [SPENDING.md](SPENDING.md) |
| What has one category cost me over time? | `/analysis/category/<id>` | [SPENDING.md](SPENDING.md) |
| Am I on budget this month? | `/analysis/budgets` | [SPENDING.md](SPENDING.md) |
| Why did my net worth change: saving, markets, debt paydown, or something unexplained? | `/analysis/networth` | [ATTRIBUTION.md](ATTRIBUTION.md) |

## Planning

| Question | Where | More |
|---|---|---|
| What should I do next with my money: emergency fund, match, debt, retirement? | `/plan` Guidance | [GUIDANCE.md](GUIDANCE.md) |
| Will my cash cover the bills ahead, and how much is safe to spend? | `/plan/cashflow` | [CASHFLOW.md](CASHFLOW.md) |
| Which recurring bills does the app expect, and are they right? | `/plan/cashflow/review` | [CASHFLOW.md](CASHFLOW.md) |
| How much should I be holding now for irregular costs like insurance or a car? | `/plan/sinking` | [SINKING.md](SINKING.md) |

## Settings

| Question | Where | More |
|---|---|---|
| How are transactions categorized, and how do I change the rules? | `/settings/categories` | [SPENDING.md](SPENDING.md) |
| What do I earn, and what goes into my 401(k) from each paycheck? | `/settings/income` | [INCOME.md](INCOME.md) |
| Who is in the household, and what does the guidance assume about us? | `/settings/household` | [GUIDANCE.md](GUIDANCE.md) |
| Are my bank connections working, and which need signing in again? | `/settings/connections` | [PLAID.md](PLAID.md) |
| Is this installation healthy: backups, worker, schema, optional features? How do I change the password? | `/settings/instance` | [DEPLOY.md](DEPLOY.md) |

## Running in the background

These have no page of their own; **Settings → Instance** shows whether each is on.

| What | When | More |
|---|---|---|
| Bank sync through Plaid, by webhook and once a day | 03:00 UTC, and on webhook | [PLAID.md](PLAID.md) |
| Closing prices for everything you hold or watch | 01:30 UTC | [INVESTMENTS.md](INVESTMENTS.md) |
| Daily balance snapshots, which every chart reads | 02:00 UTC | [DEPLOY.md §8](DEPLOY.md#8-what-runs-when-nightly-timeline) |
| Encrypted database backup | 04:00 your time | [BACKUP.md](BACKUP.md) |
| A plain-text Beancount copy of your ledger | 04:30 your time | [BEANCOUNT.md](BEANCOUNT.md) |
| Anomaly checks, and an optional alert email | 05:00 UTC | [ALERTS.md](ALERTS.md) |

## Deliberately not here

my-money tracks and advises. It does not move money, prepare taxes, keep
double-entry books, run envelope budgets, or serve more than one household per
installation, and none of those are planned. A second household runs its own
installation.
