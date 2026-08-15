import { requireUser } from "@/lib/auth/require-user.ts";
import { loadIncomeSettings } from "@/lib/income/queries.ts";
import { Money } from "@/lib/money/money.ts";
import Link from "next/link";
import { IncomeManager } from "./income-manager.tsx";
import type { HoldingView, SourceView } from "./view-models.ts";

/**
 * `/settings/income` — define paychecks and the 401k contribution they fund
 * (Phase 14, P14-14).
 *
 * A server component: it reads, formats every dollar with `Money.format()`, and
 * hands plain strings to the client island. No money value crosses the boundary
 * as a number, and none of it goes anywhere else — gross pay is the most
 * sensitive column in the app and stays in local Postgres (CLAUDE.md §Privacy).
 *
 * This page defines INTENT only. The `materialize-contributions` job (ADR-031)
 * is the sole writer of the contributions themselves, which is what keeps the
 * `(rule, pay_date)` idempotency guarantee meaningful.
 */
export default async function IncomeSettingsPage(): Promise<React.JSX.Element> {
  await requireUser();
  const { sources, investmentAccounts, holdings } = await loadIncomeSettings();

  const holdingViews: HoldingView[] = holdings.map((holding) => ({
    id: holding.id,
    accountId: holding.accountId,
    symbol: holding.symbol,
    hasPlaidLots: holding.hasPlaidLots,
  }));
  const plaidLotHoldings = new Set(
    holdingViews.filter((holding) => holding.hasPlaidLots).map((holding) => holding.id),
  );

  const sourceViews: SourceView[] = sources.map((source) => ({
    id: source.id,
    name: source.name,
    cadence: source.cadence,
    grossPerPeriod: source.grossPerPeriod,
    grossDisplay: Money.fromString(source.grossPerPeriod, source.currency).format(),
    currency: source.currency,
    anchorDate: source.anchorDate,
    startDate: source.startDate,
    endDate: source.endDate ?? "",
    notes: source.notes ?? "",
    active: source.active,
    rule: source.rule
      ? {
          id: source.rule.id,
          accountId: source.rule.accountId,
          accountName: source.rule.accountName,
          holdingId: source.rule.holdingId ?? "",
          holdingSymbol: source.rule.holdingSymbol,
          employeeBasis: source.rule.employeeBasis,
          employeeValue: trimScale(source.rule.employeeValue),
          pretax: source.rule.pretax,
          matchBasis: source.rule.matchBasis,
          matchValue: trimScale(source.rule.matchValue),
          matchCapPercent:
            source.rule.matchCapPercent === null ? "" : trimScale(source.rule.matchCapPercent),
          active: source.rule.active,
          materializedCount: source.rule.materializedCount,
          lastPayDate: source.rule.lastPayDate,
          totalEmployeeDisplay: Money.fromString(
            source.rule.totalEmployee,
            source.currency,
          ).format(),
          totalEmployerDisplay: Money.fromString(
            source.rule.totalEmployer,
            source.currency,
          ).format(),
          doubleCountRisk:
            source.rule.holdingId !== null && plaidLotHoldings.has(source.rule.holdingId),
        }
      : null,
  }));

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          ← Dashboard
        </Link>
        <h1 className="mt-2 font-semibold text-2xl tracking-tight">Income &amp; contributions</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Define each paycheck and the 401k contribution it funds. Every payday, those dollars are
          recorded as real cost basis on the retirement account — so gain/loss, return, and your
          savings rate reflect money you actually invested.
        </p>
        <p className="mt-2 max-w-3xl text-xs text-zinc-500">
          This is not payroll: only gross pay and the contribution are stored, never withholding or
          net pay. Nothing here leaves this machine.
        </p>
      </div>

      <IncomeManager
        sources={sourceViews}
        accounts={investmentAccounts.map((account) => ({
          id: account.id,
          name: account.name,
          institution: account.institution,
        }))}
        holdings={holdingViews}
      />
    </main>
  );
}

/**
 * Trim a `numeric` percentage to its shortest exact form for a form field.
 *
 * Postgres hands back `employee_value` as `"6.0000"`; round-tripping that
 * through the form would show the user noise. Purely a string operation — no
 * value is parsed to a number and no precision is lost, because trailing
 * fractional zeros are all that is ever removed.
 *
 * @param value - A `numeric` string such as `"6.0000"` or `"3.5000"`.
 * @returns `"6"` / `"3.5"`; unchanged when there is no fractional part.
 */
function trimScale(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/\.?0+$/, "");
}
