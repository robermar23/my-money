import { listAccounts } from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { loadCandidates, loadLiabilityCandidates } from "@/lib/cashflow/candidate-loader.ts";
import { listObligations } from "@/lib/cashflow/queries.ts";
import { listCategoriesWithGroups } from "@/lib/categories/queries.ts";
import { Money } from "@/lib/money/money.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { CandidateReview } from "./candidate-review.tsx";
import { LiabilityReview } from "./liability-review.tsx";
import { ObligationManager } from "./obligation-manager.tsx";
import type {
  AccountView,
  CandidateView,
  LiabilityCandidateView,
  ObligationView,
} from "./view-models.ts";

export const metadata: Metadata = { title: "Recurring bills" };

/** Account types a bill can be paid from. Nothing else can hold an obligation. */
const OBLIGATION_ACCOUNT_TYPES = new Set(["depository", "credit_card"]);

/**
 * Candidate review and obligation management (P16-24, P16-25, ADR-036 §2/§3).
 *
 * Server component, `requireUser`-guarded. Two sections in the order the work
 * actually happens: what the detector found and is waiting on an answer for,
 * then the schedule the household has already confirmed.
 *
 * Candidates are computed on read rather than stored — see
 * [candidate-loader.ts](../../../../lib/cashflow/candidate-loader.ts). Nothing
 * on this page writes; every change goes through a server action in
 * [actions.ts](./actions.ts), which is where the preview → confirm boundary
 * ADR-036 §2 requires actually lives.
 *
 * Every dollar figure is formatted HERE, on the server, and crosses to the
 * client as a display string (CLAUDE.md §Money).
 */
export default async function CashFlowReviewPage(): Promise<React.JSX.Element> {
  await requireUser();

  const today = new Date().toISOString().slice(0, 10);
  const [candidates, liabilityProposals, obligations, accounts, categoryData] = await Promise.all([
    loadCandidates({ today }),
    loadLiabilityCandidates({ today }),
    listObligations({ includeInactive: true }),
    listAccounts(),
    listCategoriesWithGroups(),
  ]);

  const accountNames = new Map(accounts.map((account) => [account.id, account.name]));

  const accountOptions: AccountView[] = accounts
    .filter((account) => OBLIGATION_ACCOUNT_TYPES.has(account.type) && account.closedAt === null)
    .map((account) => ({
      id: account.id,
      name: account.name,
      institution: account.institution,
    }));

  const categories = categoryData.categories.map((category) => ({
    id: category.id,
    name: category.name,
    groupName: category.groupName,
    kind: category.kind,
  }));

  const candidateViews: CandidateView[] = candidates.map((candidate) => ({
    accountId: candidate.accountId,
    accountName: accountNames.get(candidate.accountId) ?? "Unknown account",
    detectionKey: candidate.payeeKey,
    sampleName: candidate.sampleName,
    label: candidate.label,
    direction: candidate.direction,
    categoryId: candidate.categoryId,
    cadence: candidate.cadence,
    anchorDate: candidate.anchorDate,
    // The series has been running since its first observed occurrence; starting
    // the obligation there keeps the confirmed schedule consistent with the
    // history that justified it.
    startDate: candidate.firstSeen,
    expectedAmount: candidate.expectedAmount,
    expectedDisplay: money(candidate.expectedAmount),
    spreadDisplay: money(candidate.amountSpread),
    amountMode: candidate.amountMode,
    confidence: candidate.confidence,
    firstSeen: candidate.firstSeen,
    lastSeen: candidate.lastSeen,
    evidence: candidate.occurrences.map((occurrence) => ({
      date: occurrence.date,
      amountDisplay: money(occurrence.amount),
    })),
  }));

  const liabilityViews: LiabilityCandidateView[] = liabilityProposals.map((candidate) => ({
    liabilityId: candidate.liabilityId,
    accountId: candidate.accountId,
    accountOptions: candidate.accountOptions.map((account) => ({
      id: account.accountId,
      name: account.name,
      institution: account.institution,
    })),
    label: candidate.label,
    expectedAmount: candidate.expectedAmount,
    expectedDisplay: money(candidate.expectedAmount),
    scheduledDisplay: money(candidate.scheduledPayment),
    observedDisplay: candidate.observedMedian === null ? null : money(candidate.observedMedian),
    spreadDisplay: candidate.observedSpread === null ? null : money(candidate.observedSpread),
    observedCount: candidate.observedCount,
    escrowCaveat: candidate.escrowCaveat,
    amountMode: candidate.amountMode,
    anchorDate: candidate.anchorDate,
    startDate: candidate.startDate,
    sampleName: candidate.sampleName,
    evidence: candidate.evidence.map((payment) => ({
      date: payment.date,
      amountDisplay: money(payment.amount),
    })),
    collision: collisionWarning(candidate.payeeKey, candidate.accountId, candidates),
  }));

  const obligationViews: ObligationView[] = obligations.map((obligation) => ({
    id: obligation.id,
    accountId: obligation.accountId,
    accountName: obligation.accountName,
    categoryId: obligation.categoryId,
    categoryName: obligation.categoryName,
    label: obligation.label,
    expectedAmount: obligation.expectedAmount,
    expectedDisplay: money(obligation.expectedAmount),
    direction: obligation.direction,
    currency: obligation.currency,
    cadence: obligation.cadence,
    anchorDate: obligation.anchorDate,
    startDate: obligation.startDate,
    endDate: obligation.endDate,
    active: obligation.active,
    amountMode: obligation.amountMode,
    source: obligation.source,
    liabilityId: obligation.liabilityId,
    confidence: obligation.confidence,
    notes: obligation.notes,
  }));

  return (
    <main className="mx-auto max-w-4xl p-6">
      <Link href="/plan" className="text-sm text-zinc-500 hover:underline">
        ← Guidance
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">Recurring bills</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        Bills and regular receipts the projection should expect. Suggestions come from your own
        transaction history and are never added on their own — confirming one is what makes it real.
      </p>

      <LiabilityReview candidates={liabilityViews} categories={categories} />

      <section aria-labelledby="candidates-heading" className="mt-8">
        <h2 id="candidates-heading" className="font-medium text-lg">
          Suggestions
        </h2>
        <CandidateReview candidates={candidateViews} categories={categories} />
      </section>

      <section aria-labelledby="obligations-heading" className="mt-12">
        <h2 id="obligations-heading" className="font-medium text-lg">
          Confirmed bills
        </h2>
        <ObligationManager
          obligations={obligationViews}
          accounts={accountOptions}
          categories={categories}
        />
      </section>
    </main>
  );
}

/** Format a stored `numeric` string for display. The only place this happens. */
function money(amount: string): string {
  return Money.fromString(amount, "USD").abs().format();
}

/**
 * A sentence naming a detected suggestion that IS this loan payment.
 *
 * ADR-047 cannot prevent the double-entry by structure — a detected series and a
 * stated loan schedule are two legitimately different rows, and there are real
 * households where both belong. So it is handled by DISCLOSURE, the same posture
 * the rest of this surface takes: say what the app noticed, and let the person
 * who knows their own book decide.
 *
 * ── Matched on the SERIES, not on the amount ───────────────────────────────
 * The obvious rule — "a detected outflow on the same account for about the same
 * money" — cries wolf, and the E2E fixture caught it doing so: rent at $1,850
 * and a mortgage at $1,750 are within any tolerance loose enough to be useful,
 * and they are plainly different bills. The only honest signal is IDENTITY: the
 * detector proposed the very payments this proposal was priced from, which is
 * an exact `payeeKey` comparison and cannot false-positive.
 *
 * The cost of that strictness is stated rather than hidden: a loan whose
 * payments were never recognized has no `payeeKey`, so no warning is possible.
 * That is the case where the two rows are least likely to be the same money
 * anyway — and a warning nobody can trust is worse than none.
 *
 * @param payeeKey - The series this loan proposal was priced from, or `null`.
 * @param accountId - The account the payment leaves, or `null` when unknown.
 * @param candidates - The detector's current proposals.
 * @returns The warning, or `null` when nothing collides.
 */
function collisionWarning(
  payeeKey: string | null,
  accountId: string | null,
  candidates: readonly { accountId: string; payeeKey: string; label: string }[],
): string | null {
  if (payeeKey === null || accountId === null) return null;

  const overlapping = candidates.find(
    (candidate) => candidate.accountId === accountId && candidate.payeeKey === payeeKey,
  );
  if (overlapping === undefined) return null;

  return `Your history also suggests “${overlapping.label}” — the same payments this schedule was priced from. Add one of them, not both, or the calendar will expect this money twice.`;
}
