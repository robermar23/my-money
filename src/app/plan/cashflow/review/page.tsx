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
    collision: collisionWarning(candidate.accountId, candidate.expectedAmount, candidates),
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
 * How close a detected amount has to be before it might be the same payment.
 *
 * The matcher's own band for a `fixed` obligation (ADR-037 §6). Using the same
 * figure is deliberate: if the two amounts are close enough that ONE posted
 * transaction could satisfy either schedule, the household is at risk of having
 * the same money dated twice, and that is exactly what the warning is about.
 */
const COLLISION_TOLERANCE_PCT = "0.15";

/**
 * A sentence naming a detected suggestion that looks like this loan payment.
 *
 * ADR-047 cannot prevent the double-entry by structure — a detected series and a
 * stated loan schedule are two legitimately different rows, and there are real
 * households where both belong. So it is handled by DISCLOSURE, the same posture
 * the rest of this surface takes: say what the app noticed, and let the person
 * who knows their own book decide.
 *
 * Computed on the server so no money arithmetic crosses to the browser
 * (CLAUDE.md §Money).
 *
 * @param accountId - The account the loan payment leaves, or `null` when the app
 *   cannot tell — in which case nothing is compared, because a collision on an
 *   unknown account is a guess about a guess.
 * @param expectedAmount - The proposed payment, as a `numeric` string.
 * @param candidates - The detector's current proposals.
 * @returns The warning, or `null` when nothing overlaps.
 */
function collisionWarning(
  accountId: string | null,
  expectedAmount: string,
  candidates: readonly {
    accountId: string;
    direction: string;
    label: string;
    expectedAmount: string;
  }[],
): string | null {
  if (accountId === null) return null;

  const expected = Money.fromString(expectedAmount, "USD").abs();
  if (expected.isZero()) return null;
  const tolerance = expected.mul(COLLISION_TOLERANCE_PCT);

  const overlapping = candidates.find(
    (candidate) =>
      candidate.accountId === accountId &&
      candidate.direction === "outflow" &&
      Money.fromString(candidate.expectedAmount, "USD")
        .abs()
        .sub(expected)
        .abs()
        .compare(tolerance) <= 0,
  );
  if (overlapping === undefined) return null;

  return `Your history also suggests “${overlapping.label}” on this account for about the same amount. If that is this loan payment, add one of them — not both, or the calendar will expect it twice.`;
}
