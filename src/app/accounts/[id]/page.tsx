import {
  getAccount,
  getAssetDocuments,
  getCreditLine,
  getLatestSnapshot,
  getLiability,
  listHoldings,
  listLots,
  listSnapshots,
} from "@/lib/accounts/queries.ts";
import { resolveRange } from "@/lib/analytics/range.ts";
import { spendByCategory } from "@/lib/analytics/spending.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { listCategoriesWithGroups } from "@/lib/categories/queries.ts";
import { valueHolding } from "@/lib/holdings/value.ts";
import { listAccountContributions } from "@/lib/income/queries.ts";
import { basisProvenance } from "@/lib/investments/basis-provenance.ts";
import { gainLoss } from "@/lib/investments/gain-loss.ts";
import { lotCoverage, resolveCostBasis } from "@/lib/investments/lots.ts";
import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth } from "@/lib/mortgage/amortization.ts";
import { transactionFilterSchema } from "@/lib/schemas/search.ts";
import { type TransactionFilters, listTransactions } from "@/lib/transactions/queries.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import Decimal from "decimal.js";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountAdmin } from "./account-admin.tsx";
import { AccountTermsForm } from "./account-terms-form.tsx";
import { AssetDocumentForm } from "./asset-document-form.tsx";
import { AssetValueChart } from "./asset-value-chart.tsx";
import { AssetValueForm } from "./asset-value-form.tsx";
import { BalanceForm } from "./balance-form.tsx";
import { CreditLineForm } from "./credit-line-form.tsx";
import { DeleteAssetDocumentButton } from "./delete-asset-document-button.tsx";
import { DeleteHoldingButton } from "./delete-holding-button.tsx";
import { HoldingForm } from "./holding-form.tsx";
import { type LotView, LotsEditor } from "./lot-form.tsx";
import { MortgageForm } from "./mortgage-form.tsx";
import { PropertyForm } from "./property-form.tsx";
import { ReconciliationBanner } from "./reconciliation-banner.tsx";
import { TransactionsSection } from "./transactions-section.tsx";

interface AccountPageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams?: Promise<Record<string, string | undefined>>;
}

/** The filter keys this page reads from the URL (excludes `page`/`imported`). */
const FILTER_KEYS = ["q", "from", "to", "minAmount", "maxAmount", "categoryId"] as const;

const TYPE_LABEL: Record<string, string> = {
  depository: "Cash",
  credit_card: "Credit card",
  investment: "Investment",
  crypto_ira: "Crypto / metals IRA",
  loan: "Loan",
  property: "Property",
  personal_asset: "Asset",
};

/** Display labels for personal-asset categories (mirrors ASSET_CATEGORIES). */
const ASSET_CATEGORY_LABEL: Record<string, string> = {
  vehicle: "Vehicle",
  watercraft: "Boat & watercraft",
  jewelry: "Jewelry & watches",
  collectible: "Art & collectibles",
  other: "Other",
};

/** Human-readable file size for the documents list (KB/MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function monthsBetween(startIso: string): number {
  const start = new Date(`${startIso}T00:00:00Z`);
  const now = new Date();
  const months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - start.getUTCMonth());
  return Math.max(0, months);
}

export default async function AccountDetailPage(
  props: AccountPageProps,
): Promise<React.JSX.Element> {
  await requireUser();
  const { id } = await props.params;
  const search = (await props.searchParams) ?? {};
  const justImported = search.imported ? Number.parseInt(search.imported, 10) : null;
  const accountId = toAccountId(id);

  // P12-11 — parse the structured transaction filters from the URL. On an
  // invalid combination (e.g. from > to) fall back to no filters + page 1; the
  // bar still echoes the raw URL values so the user can correct them.
  const parsed = transactionFilterSchema.safeParse(search);
  const filterData = parsed.success ? parsed.data : null;
  const page = filterData?.page ?? 1;
  const filters: TransactionFilters | undefined = filterData
    ? {
        q: filterData.q,
        from: filterData.from,
        to: filterData.to,
        minAmount: filterData.minAmount,
        maxAmount: filterData.maxAmount,
        categoryId: filterData.categoryId,
      }
    : undefined;
  const filtersActive = FILTER_KEYS.some((k) => (search[k] ?? "") !== "");
  // Filter params (minus `page`) to carry through pagination links.
  const filterParams = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = search[k];
    if (v) filterParams.set(k, v);
  }
  const filterQuery = filterParams.toString();
  const account = await getAccount(accountId);
  if (!account) notFound();

  const showTransactions =
    account.type === "depository" ||
    account.type === "credit_card" ||
    account.type === "investment";

  // P14-18 — only an `investment` account can be a contribution target (the
  // rule editor refuses anything else), so nothing else pays for this read.
  const showContributions = account.type === "investment";

  const [
    latestSnap,
    snapshots,
    accountHoldings,
    accountLots,
    liability,
    creditLine,
    txnResult,
    categoryData,
    contributions,
  ] = await Promise.all([
    getLatestSnapshot(accountId),
    listSnapshots(accountId),
    listHoldings(accountId),
    listLots(accountId),
    getLiability(accountId),
    // P15-30 — revolving terms. Only a card can have them (the action is gated
    // to `credit_card`), so nothing else pays for this read.
    account.type === "credit_card" ? getCreditLine(accountId) : Promise.resolve(undefined),
    showTransactions
      ? listTransactions({ accountId, filters, page })
      : Promise.resolve({ rows: [], totalCount: 0, page: 1, pageSize: 50, totalPages: 1 }),
    showTransactions ? listCategoriesWithGroups() : Promise.resolve({ groups: [], categories: [] }),
    showContributions ? listAccountContributions(accountId) : Promise.resolve([]),
  ]);

  const categoryOptions = categoryData.categories.map((c) => ({
    id: c.id,
    name: c.name,
    groupName: c.groupName,
    kind: c.kind,
  }));

  // P8-15 — per-account top spending (last 12 months), reusing the analytics lib
  // with accountIds scoped to this account. Links through to the full analysis.
  const spendRange = resolveRange({ range: "12m" });
  const topSpend = showTransactions
    ? (
        await spendByCategory({
          from: spendRange.from,
          to: spendRange.to,
          accountIds: [account.id],
        })
      )
        .filter((r) => r.kind === "expense")
        .slice(0, 5)
    : [];

  // Phase 2: price each holding using cached `prices` (closeUsed: null means
  // no price has been fetched yet — UI displays "—" for value).
  const todayIso = new Date().toISOString().slice(0, 10);
  const valuations = await Promise.all(
    accountHoldings.map((h) => valueHolding(h, account.currency, todayIso)),
  );
  const holdingsTotal = valuations.reduce(
    (acc, v) => acc.add(v.value),
    Money.zero(account.currency),
  );

  // P5-19: resolved cost basis (lots-aware), gain/loss, and lot coverage per
  // holding. Lots are grouped from the flat account-wide query.
  const lotsByHolding = new Map<string, typeof accountLots>();
  for (const lot of accountLots) {
    const arr = lotsByHolding.get(lot.holdingId) ?? [];
    arr.push(lot);
    lotsByHolding.set(lot.holdingId, arr);
  }
  const holdingDerived = valuations.map((v) => {
    const lots = lotsByHolding.get(v.holding.id) ?? [];
    const lotInputs = lots.map((l) => ({ quantity: l.quantity, costBasisTotal: l.costBasisTotal }));
    const resolvedBasis = resolveCostBasis(
      { costBasis: v.holding.costBasis },
      lotInputs,
      account.currency,
    );
    // Only show gain/loss once a price (or face value) is known — otherwise
    // value is $0 and the figure would be a misleading -100%.
    const priced = v.closeUsed !== null || v.holding.assetClass === "cash";
    const gl =
      priced && resolvedBasis ? gainLoss({ value: v.value, costBasis: resolvedBasis }) : null;
    const coverage = lots.length > 0 ? lotCoverage(v.holding, lotInputs) : null;
    // P14-16 — did a payroll contribution rule fund this basis?
    const provenance = basisProvenance(lots);
    const coverageNote =
      coverage && !coverage.isComplete
        ? `lots cover ${coverage.coveredQty} of ${coverage.holdingQty}`
        : null;
    const lotViews: LotView[] = lots.map((l) => {
      const qty = new Decimal(l.quantity);
      return {
        id: l.id,
        acquiredAt: l.acquiredAt,
        quantity: l.quantity,
        costBasisTotal: l.costBasisTotal,
        perUnit: qty.isZero() ? "0.00" : new Decimal(l.costBasisTotal).dividedBy(qty).toFixed(2),
        source: l.source,
      };
    });
    return { v, resolvedBasis, gl, coverageNote, lotViews, provenance };
  });

  // P14-16 — page-level flags for the contribution-basis footnote.
  const anyContributionBasis = holdingDerived.some((h) => h.provenance.fromContributions);
  const anyBasisOnlyContribution = holdingDerived.some(
    (h) => h.provenance.hasBasisOnlyContributions,
  );

  // Quarterly-update hint: when was any holding last touched?
  const lastHoldingUpdate = accountHoldings.reduce<Date | null>((latest, h) => {
    return !latest || h.updatedAt > latest ? h.updatedAt : latest;
  }, null);

  // While a filter is active a zero `totalCount` reflects the filter, not an
  // empty account — keep `hasData` true so deletion isn't wrongly enabled.
  const hasData =
    snapshots.length > 0 ||
    accountHoldings.length > 0 ||
    txnResult.totalCount > 0 ||
    !!liability ||
    filtersActive;

  const showBalanceForm = account.type === "depository" || account.type === "credit_card";
  const showHoldingsForm = account.type === "investment" || account.type === "crypto_ira";
  const showMortgageForm = account.type === "loan";
  const showPropertyForm = account.type === "property";
  const isAsset = account.type === "personal_asset";
  // P15-29 — the terms form only has something to offer for the types whose
  // columns it edits: cash subtype/APY/maturity, or an investment's container.
  const showTermsForm =
    account.type === "depository" || account.type === "investment" || account.type === "crypto_ira";
  const showCreditLineForm = account.type === "credit_card";

  // Personal-asset detail data (P10-12/P10-13): proof documents (metadata only)
  // and a simple display gain/loss = latest value − acquisition cost.
  const assetDocs = isAsset ? await getAssetDocuments(accountId) : [];
  const assetGainLoss =
    isAsset && account.acquisitionCost && latestSnap
      ? gainLoss({
          value: Money.fromString(latestSnap.balance, account.currency),
          costBasis: Money.fromString(account.acquisitionCost, account.currency),
        })
      : null;
  // The header shows the category in the slot financial accounts use for the
  // institution (the `"Personal asset"` sentinel is never displayed, ADR-023).
  const headerLabel = isAsset
    ? account.assetCategory
      ? (ASSET_CATEGORY_LABEL[account.assetCategory] ?? account.assetCategory)
      : "Asset"
    : account.institution;

  // Live mortgage balance via amortization (no DB read of snapshots needed for display).
  const computedLoanBalance = liability
    ? balanceAtMonth(
        Money.fromString(liability.principalAtOrigination, account.currency),
        liability.annualRate,
        liability.termMonths,
        monthsBetween(liability.startDate),
      )
    : null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Link href="/accounts" className="text-sm text-zinc-500 hover:underline">
        ← Accounts
      </Link>
      <div className="mt-2 flex items-start justify-between">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">
            {account.name}
            {account.closedAt !== null && (
              <span className="ml-2 rounded bg-zinc-200 px-1.5 py-0.5 align-middle text-[10px] text-zinc-600 uppercase dark:bg-zinc-800 dark:text-zinc-400">
                Closed
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {headerLabel} · {TYPE_LABEL[account.type] ?? account.type} · {account.currency}
          </p>
          {isAsset && account.description && (
            <p className="mt-1 max-w-prose text-sm text-zinc-500">{account.description}</p>
          )}
        </div>
        <div className="text-right">
          <div className="text-xs text-zinc-500 uppercase">Latest</div>
          <div className="font-mono text-xl">
            {computedLoanBalance
              ? computedLoanBalance.negate().format()
              : showHoldingsForm && !holdingsTotal.isZero()
                ? holdingsTotal.format()
                : latestSnap
                  ? Money.fromString(latestSnap.balance, account.currency).format()
                  : "—"}
          </div>
          {computedLoanBalance && (
            <div className="mt-0.5 text-xs text-zinc-400">computed from amortization</div>
          )}
        </div>
      </div>

      <AccountAdmin
        accountId={account.id}
        name={account.name}
        institution={account.institution}
        type={account.type}
        currency={account.currency}
        hasData={hasData}
        closed={account.closedAt !== null}
        isPlaidLinked={account.plaidItemId !== null}
      />

      {justImported !== null && justImported > 0 && (
        <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-emerald-800 text-sm dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Imported {justImported} transaction{justImported === 1 ? "" : "s"}.
        </div>
      )}

      {(account.type === "depository" || account.type === "credit_card") && (
        <ReconciliationBanner accountId={account.id} currency={account.currency} />
      )}

      {/* P15-29 — the details the guidance engine reads. Optional by design:
          without them it reports what is missing rather than guessing. */}
      {showTermsForm && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-medium">Account details</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Optional. These tell the household guidance how to treat this account — how much cash is
            spending money versus reserve, and which savings container this is. Leave anything blank
            you don't want to record.
          </p>
          <div className="mt-4">
            <AccountTermsForm
              accountId={account.id}
              accountType={account.type}
              subtype={account.subtype}
              apy={account.apy}
              maturityDate={account.maturityDate}
              taxTreatment={account.taxTreatment}
            />
          </div>
        </section>
      )}

      {/* P15-30 — manual revolving terms (ADR-033 §6: Plaid Liabilities is
          deliberately not enabled). The entry date is shown by the form. */}
      {showCreditLineForm && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-medium">Card terms</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Optional. The APR, limit and minimum payment drive utilization and debt-payoff guidance.
            Enter what you know — anything left blank is reported as missing rather than assumed.
          </p>
          <CreditLineForm
            accountId={account.id}
            existing={
              creditLine
                ? {
                    apr: creditLine.apr,
                    creditLimit: creditLine.creditLimit,
                    minimumPayment: creditLine.minimumPayment,
                    minimumPaymentPercent: creditLine.minimumPaymentPercent,
                    notes: creditLine.notes,
                    updatedAt: creditLine.updatedAt.toISOString(),
                  }
                : null
            }
          />
        </section>
      )}

      {/* Conditional entry forms by account type */}
      {showBalanceForm && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-medium">Record balance</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Enter the end-of-day balance from your statement or online portal.
          </p>
          <div className="mt-4">
            <BalanceForm accountId={account.id} />
          </div>
        </section>
      )}

      {showHoldingsForm && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-medium">Add or update holding</h2>
          <p className="mt-1 text-sm text-zinc-500">
            For iTrust gold use symbol <code>XAU</code>, asset class <code>physical_metal</code>,
            unit <code>troy_oz</code>.
          </p>
          {lastHoldingUpdate && (
            <p className="mt-1 text-xs text-zinc-400">
              Last updated {lastHoldingUpdate.toLocaleDateString("en-US", { dateStyle: "medium" })}{" "}
              — review quarterly.
            </p>
          )}
          <div className="mt-4">
            <HoldingForm accountId={account.id} />
          </div>

          {holdingDerived.length > 0 && (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead className="text-left text-xs text-zinc-500 uppercase">
                  <tr>
                    <th className="py-2">Symbol</th>
                    <th className="py-2">Asset class</th>
                    <th className="py-2 text-right">Quantity</th>
                    <th className="py-2">Unit</th>
                    <th className="py-2 text-right">Latest price</th>
                    <th className="py-2 text-right">Value</th>
                    <th className="py-2 text-right">Cost basis</th>
                    <th className="py-2 text-right">Gain/Loss</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                  {holdingDerived.map(({ v, resolvedBasis, gl, coverageNote, provenance }) => (
                    <tr key={v.holding.id}>
                      <td className="py-2 font-mono">{v.holding.symbol}</td>
                      <td className="py-2 text-zinc-600 dark:text-zinc-400">
                        {v.holding.assetClass.replace("_", " ")}
                      </td>
                      <td className="py-2 text-right font-mono">{v.holding.quantity}</td>
                      <td className="py-2 text-zinc-600 dark:text-zinc-400">
                        {v.holding.quantityUnit}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {v.closeUsed
                          ? Money.fromString(v.closeUsed, account.currency).format()
                          : "—"}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {v.closeUsed || v.holding.assetClass === "cash" ? v.value.format() : "—"}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {resolvedBasis ? resolvedBasis.format() : "—"}
                        {coverageNote && (
                          <span
                            className="ml-1 text-amber-600 dark:text-amber-400"
                            title={coverageNote}
                          >
                            *
                          </span>
                        )}
                        {provenance.fromContributions && (
                          <span
                            className="ml-1 text-zinc-400"
                            title="Cost basis tracked from payroll contributions"
                          >
                            †
                          </span>
                        )}
                      </td>
                      <td
                        className={`py-2 text-right font-mono ${
                          gl?.absolute
                            ? gl.absolute.isNegative()
                              ? "text-red-600 dark:text-red-400"
                              : "text-emerald-600 dark:text-emerald-400"
                            : ""
                        }`}
                      >
                        {gl?.absolute ? `${gl.absolute.format()} (${gl.percent}%)` : "—"}
                      </td>
                      <td className="py-2 text-right">
                        <DeleteHoldingButton
                          accountId={account.id}
                          holdingId={v.holding.id}
                          symbol={v.holding.symbol}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-zinc-200 border-t dark:border-zinc-800">
                  <tr>
                    <td className="py-2 font-medium" colSpan={5}>
                      Total
                    </td>
                    <td className="py-2 text-right font-medium font-mono">
                      {holdingsTotal.format()}
                    </td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* P14-16 — a 401k's basis now comes from the user's own contribution
              rule rather than the institution; say so where the figure appears. */}
          {anyContributionBasis && (
            <p className="mt-2 text-xs text-zinc-500">
              † Cost basis tracked from payroll contributions.{" "}
              <Link href="/settings/income" className="underline">
                Income settings
              </Link>
              {anyBasisOnlyContribution && (
                <>
                  {" "}
                  Some contributions could not be priced, so their basis is recorded without shares
                  — those quantities are your own entries.
                </>
              )}
            </p>
          )}

          {/* P5-18 — per-holding cost-basis lot editors. */}
          {holdingDerived.length > 0 && (
            <div className="mt-6 border-zinc-200 border-t pt-4 dark:border-zinc-800">
              <h3 className="font-medium text-sm">Cost-basis lots</h3>
              <p className="mt-1 text-xs text-zinc-500">
                Record acquisition lots for accurate gain/loss. When lots exist they override the
                aggregate cost basis above.
              </p>
              <div className="mt-2 space-y-1">
                {holdingDerived.map(({ v, lotViews, coverageNote }) => (
                  <LotsEditor
                    key={v.holding.id}
                    accountId={account.id}
                    holdingId={v.holding.id}
                    symbol={v.holding.symbol}
                    currency={account.currency}
                    lots={lotViews}
                    coverageNote={coverageNote}
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* P14-18 — the audit trail behind the cost basis above: which paycheck
          put which dollars in, read-only. Contributions are written solely by
          the materialization job (ADR-031), so there is nothing to edit here —
          the rule that generates them lives in /settings/income. */}
      {contributions.length > 0 && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">Contributions</h2>
            <Link href="/settings/income" className="text-sm text-zinc-500 hover:underline">
              Income settings →
            </Link>
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            Payroll contributions that funded this account, newest first. These created the cost
            basis on the holdings above.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead className="text-left text-xs text-zinc-500 uppercase">
                <tr>
                  <th className="py-2">Pay date</th>
                  <th className="py-2">Source</th>
                  <th className="py-2 text-right">You</th>
                  <th className="py-2 text-right">Employer</th>
                  <th className="py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {contributions.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2 font-mono">{c.payDate}</td>
                    <td className="py-2 text-zinc-600 dark:text-zinc-400">{c.sourceName}</td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {Money.fromString(c.employeeAmount, c.currency).format()}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {Money.fromString(c.employerAmount, c.currency).format()}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {Money.fromString(c.employeeAmount, c.currency)
                        .add(Money.fromString(c.employerAmount, c.currency))
                        .format()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {showMortgageForm && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-medium">Mortgage parameters</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Once set, the current balance is computed from the amortization schedule. No monthly
            entry needed.
          </p>
          <div className="mt-4">
            <MortgageForm accountId={account.id} existing={liability ?? null} />
          </div>
        </section>
      )}

      {showPropertyForm && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-medium">Record property value</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Update quarterly with your estimated market value (Zillow, Redfin, county assessor,
            etc.).
          </p>
          <div className="mt-4">
            <PropertyForm accountId={account.id} />
          </div>
        </section>
      )}

      {/* Personal-asset detail (P10-12): acquisition + gain/loss, value entry. */}
      {isAsset && (
        <>
          <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-medium">Acquisition</h2>
            <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-zinc-500 uppercase">Acquired</dt>
                <dd className="mt-1 font-mono text-sm">{account.acquiredAt ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500 uppercase">Acquisition cost</dt>
                <dd className="mt-1 font-mono text-sm">
                  {account.acquisitionCost
                    ? Money.fromString(account.acquisitionCost, account.currency).format()
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500 uppercase">Gain / loss</dt>
                <dd
                  className={`mt-1 font-mono text-sm ${
                    assetGainLoss?.absolute
                      ? assetGainLoss.absolute.isNegative()
                        ? "text-red-600 dark:text-red-400"
                        : "text-emerald-600 dark:text-emerald-400"
                      : ""
                  }`}
                >
                  {assetGainLoss?.absolute
                    ? `${assetGainLoss.absolute.format()}${
                        assetGainLoss.percent ? ` (${assetGainLoss.percent}%)` : ""
                      }`
                    : "—"}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-zinc-400">
              Gain/loss is a simple display figure (latest value − acquisition cost), not a tax or
              capital-gains calculation.
            </p>
          </section>

          <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-medium">Record value</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Update the asset's current value whenever it changes. Each entry is dated and
              contributes to your net worth over time.
            </p>
            <div className="mt-4">
              <AssetValueForm accountId={account.id} />
            </div>
            {snapshots.length >= 2 && (
              <div className="mt-6">
                <AssetValueChart
                  currency={account.currency}
                  points={[...snapshots].reverse().map((s) => ({ date: s.date, value: s.balance }))}
                />
              </div>
            )}
          </section>

          {/* Proof-of-authenticity documents (P10-13). */}
          <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-medium">Proof of authenticity</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Optional — attach a title, receipt, or appraisal (image or PDF, up to 10 MB). Files
              are stored privately and downloaded only as attachments.
            </p>
            <div className="mt-4">
              <AssetDocumentForm accountId={account.id} />
            </div>
            {assetDocs.length > 0 && (
              <div className="mt-6 overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm">
                  <thead className="text-left text-xs text-zinc-500 uppercase">
                    <tr>
                      <th className="py-2">File</th>
                      <th className="py-2">Description</th>
                      <th className="py-2 text-right">Size</th>
                      <th className="py-2">Uploaded</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    {assetDocs.map((doc) => (
                      <tr key={doc.id}>
                        <td className="py-2">
                          <a
                            href={`/accounts/${account.id}/documents/${doc.id}`}
                            className="font-medium hover:underline"
                          >
                            {doc.filename}
                          </a>
                        </td>
                        <td className="py-2 text-zinc-600 dark:text-zinc-400">
                          {doc.description ?? "—"}
                        </td>
                        <td className="py-2 text-right font-mono text-zinc-600 dark:text-zinc-400">
                          {formatBytes(doc.sizeBytes)}
                        </td>
                        <td className="py-2 text-zinc-600 dark:text-zinc-400">
                          {doc.uploadedAt.toLocaleDateString("en-US", { dateStyle: "medium" })}
                        </td>
                        <td className="py-2 text-right">
                          <DeleteAssetDocumentButton
                            accountId={account.id}
                            docId={doc.id}
                            filename={doc.filename}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {/* Transactions table for cash + credit + investment accounts */}
      {showTransactions && (
        <TransactionsSection
          accountId={account.id}
          accountCurrency={account.currency}
          flipSign={account.type === "credit_card"}
          rows={txnResult.rows}
          categories={categoryOptions}
          page={txnResult.page}
          totalPages={txnResult.totalPages}
          totalCount={txnResult.totalCount}
          filtersActive={filtersActive}
          filterQuery={filterQuery}
        />
      )}

      {/* P8-15 — per-account spending snapshot */}
      {showTransactions && topSpend.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Top spending (12 mo)</h2>
            <Link
              href={`/analysis?account=${account.id}`}
              className="text-sm text-zinc-500 hover:underline"
            >
              Full analysis →
            </Link>
          </div>
          <table className="mt-3 w-full text-sm">
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {topSpend.map((r) => (
                <tr key={r.id}>
                  <td className="py-2">
                    <Link
                      href={`/analysis/category/${r.id}?account=${account.id}`}
                      className="hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {Money.fromString(r.total, account.currency).format()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Snapshot history */}
      {snapshots.length > 0 && (
        <section className="mt-8">
          <h2 className="font-medium">Snapshot history</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[20rem] text-sm">
              <thead className="text-left text-xs text-zinc-500 uppercase">
                <tr>
                  <th className="py-2">Date</th>
                  <th className="py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {snapshots.map((s) => (
                  <tr key={s.date}>
                    <td className="py-2 font-mono">{s.date}</td>
                    <td className="py-2 text-right font-mono">
                      {Money.fromString(s.balance, account.currency).format()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
