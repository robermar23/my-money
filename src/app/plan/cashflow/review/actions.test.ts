// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accounts,
  obligationOccurrences,
  recommendationDismissals,
  scheduledObligations,
  transactions,
} from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* Mocks: requireUser (needs cookies) + next/cache. The DB runs for real. */
vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: "00000000-0000-0000-0000-000000000001",
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { loadCandidates } = await import("@/lib/cashflow/candidate-loader.ts");
const { listObligations } = await import("@/lib/cashflow/queries.ts");
const {
  confirmCandidateAction,
  deactivateObligationAction,
  dismissCandidateAction,
  restoreCandidateAction,
  saveObligationAction,
} = await import("./actions.ts");

/**
 * P16-24 / P16-25 — the guarantees Zod structurally cannot make.
 *
 * Every case here is a cross-row or provenance fact that a schema fed by the
 * client cannot know, which is exactly the class of check
 * [actions.ts](./actions.ts) exists to perform:
 *
 *   1. **Detection proposes; the user disposes.** A confirmation names a series
 *      the SERVER re-derived, and its confidence comes from there — never from
 *      the form. Without this, `source='detected'` would mean nothing.
 *   2. **Provenance survives an edit.** Relabelling a detected obligation as
 *      manual would clear its `detection_key` and the detector would propose the
 *      same series again the next time the page loaded.
 *   3. **Deactivate is not delete.** The occurrence history that explains past
 *      months — and that the residual attribution reads (ADR-038 §2) — has to
 *      still be there afterwards.
 */

const PAYEE = "ACME MORTGAGE PMT 0098";
const DETECTION_KEY = "acme mortgage pmt";

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE obligation_occurrences, scheduled_obligations, transactions, recommendation_dismissals, accounts CASCADE`,
  );
}

beforeEach(reset);

/** The 1st of each of the last `count` months, oldest first, none in the future. */
function monthlyDates(count: number): string[] {
  const now = new Date();
  const dates: string[] = [];
  for (let back = count; back >= 1; back -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 1));
    if (date.getTime() <= now.getTime()) dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

/** A checking account carrying a clean monthly mortgage series. */
async function seedSeries(): Promise<{ accountId: string; dates: string[] }> {
  const [account] = await db
    .insert(accounts)
    .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");

  const dates = monthlyDates(9);
  await db.insert(transactions).values(
    dates.map((postedAt) => ({
      accountId: account.id,
      // `fitid` is NOT NULL and (account_id, fitid) is UNIQUE — the OFX import
      // dedup key. One per date keeps the fixture representative of real rows.
      fitid: `mortgage-${postedAt}`,
      postedAt,
      amount: "-2150.00",
      name: PAYEE,
      source: "manual" as const,
    })),
  );

  return { accountId: account.id, dates };
}

function confirmForm(accountId: string, over: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("accountId", accountId);
  form.set("detectionKey", DETECTION_KEY);
  form.set("categoryId", "");
  form.set("label", "Mortgage");
  form.set("expectedAmount", "2150.00");
  form.set("direction", "outflow");
  form.set("cadence", "monthly");
  form.set("anchorDate", monthlyDates(2)[0] ?? "2026-01-01");
  form.set("startDate", monthlyDates(9)[0] ?? "2025-01-01");
  form.set("amountMode", "fixed");
  for (const [k, v] of Object.entries(over)) form.set(k, v);
  return form;
}

describe("the fixture", () => {
  it("produces a candidate the detector actually proposes", async () => {
    // If this fails, every provenance test below would pass vacuously.
    const { accountId } = await seedSeries();

    const candidates = await loadCandidates({ today: new Date().toISOString().slice(0, 10) });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      accountId,
      payeeKey: DETECTION_KEY,
      cadence: "monthly",
      direction: "outflow",
    });
  });
});

describe("confirmCandidateAction", () => {
  it("writes the obligation with the detector's own confidence", async () => {
    const { accountId } = await seedSeries();
    const [candidate] = await loadCandidates({ today: new Date().toISOString().slice(0, 10) });

    const result = await confirmCandidateAction({}, confirmForm(accountId));

    expect(result.ok).toBe(true);
    const [stored] = await listObligations();
    expect(stored).toMatchObject({
      label: "Mortgage",
      source: "detected",
      detectionKey: DETECTION_KEY,
      confidence: candidate?.confidence,
    });
  });

  it("refuses a detection key the detector never proposed", async () => {
    // The whole point of re-deriving server-side. A hand-crafted POST must not
    // be able to mint a `source='detected'` row for a series that does not exist.
    const { accountId } = await seedSeries();

    const result = await confirmCandidateAction(
      {},
      confirmForm(accountId, { detectionKey: "a series nobody detected" }),
    );

    expect(result.error).toMatch(/no longer available/i);
    expect(await listObligations()).toEqual([]);
  });

  it("keeps the user's edits to label and amount", async () => {
    const { accountId } = await seedSeries();

    await confirmCandidateAction(
      {},
      confirmForm(accountId, { label: "Mortgage (Wells)", expectedAmount: "2175.00" }),
    );

    const [stored] = await listObligations();
    expect(stored).toMatchObject({ label: "Mortgage (Wells)", expectedAmount: "2175.00" });
  });

  it("materializes the calendar so the projection has rows immediately", async () => {
    const { accountId } = await seedSeries();

    await confirmCandidateAction({}, confirmForm(accountId));

    const rows = await db.select().from(obligationOccurrences);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("confirms once when the same series is confirmed twice", async () => {
    // The partial UNIQUE index on (account_id, detection_key) doing its job. A
    // double-click must not produce two obligations that both charge the
    // mortgage — which would double-count it in the projection.
    const { accountId } = await seedSeries();

    await confirmCandidateAction({}, confirmForm(accountId));
    const second = await confirmCandidateAction({}, confirmForm(accountId));

    expect(second.error).toMatch(/already confirmed/i);
    expect(await listObligations()).toHaveLength(1);
  });

  it("removes the candidate from the list once confirmed", async () => {
    const { accountId } = await seedSeries();

    await confirmCandidateAction({}, confirmForm(accountId));

    expect(await loadCandidates({ today: new Date().toISOString().slice(0, 10) })).toEqual([]);
  });

  it("rejects an invalid amount without writing anything", async () => {
    const { accountId } = await seedSeries();

    const result = await confirmCandidateAction(
      {},
      confirmForm(accountId, { expectedAmount: "-2150.00" }),
    );

    expect(result.error).toBe("Must be zero or more");
    expect(await listObligations()).toEqual([]);
  });
});

describe("dismissCandidateAction", () => {
  it("suppresses the candidate and stores it as user intent", async () => {
    const { accountId } = await seedSeries();

    const result = await dismissCandidateAction({}, dismissForm(accountId, ""));

    expect(result.ok).toBe(true);
    expect(await loadCandidates({ today: new Date().toISOString().slice(0, 10) })).toEqual([]);
    const [row] = await db.select().from(recommendationDismissals);
    expect(row).toMatchObject({
      ruleId: "obligation_candidate",
      subjectKey: `${accountId} ${DETECTION_KEY}`,
      snoozeUntil: null,
    });
  });

  it("brings a snoozed candidate back on its own once the snooze lapses", async () => {
    // The whole difference between a snooze and a dismissal. A snooze that never
    // ended would be a dismissal wearing another name.
    const { accountId } = await seedSeries();
    await dismissCandidateAction({}, dismissForm(accountId, "30"));

    const today = new Date().toISOString().slice(0, 10);
    expect(await loadCandidates({ today })).toEqual([]);

    const afterSnooze = new Date(Date.now() + 31 * 86_400_000);
    expect(await loadCandidates({ today, now: afterSnooze })).toHaveLength(1);
  });

  it("writes one row when the same candidate is dismissed twice", async () => {
    const { accountId } = await seedSeries();

    await dismissCandidateAction({}, dismissForm(accountId, "30"));
    await dismissCandidateAction({}, dismissForm(accountId, ""));

    expect(await db.select().from(recommendationDismissals)).toHaveLength(1);
  });

  it("restores a dismissed candidate", async () => {
    const { accountId } = await seedSeries();
    await dismissCandidateAction({}, dismissForm(accountId, ""));

    await restoreCandidateAction(accountId, DETECTION_KEY);

    expect(await loadCandidates({ today: new Date().toISOString().slice(0, 10) })).toHaveLength(1);
  });
});

describe("saveObligationAction", () => {
  it("creates a manual obligation with no detection key", async () => {
    const { accountId } = await seedSeries();

    const result = await saveObligationAction({}, obligationForm(accountId));

    expect(result.ok).toBe(true);
    const [stored] = await listObligations();
    expect(stored).toMatchObject({
      source: "manual",
      detectionKey: null,
      confidence: null,
      label: "Water bill",
    });
  });

  it("preserves detected provenance across an edit", async () => {
    // If an edit reset `source` and `detection_key`, the detector would propose
    // the same series again the next time the page loaded — and the user would
    // be asked to confirm a bill they already confirmed.
    const { accountId } = await seedSeries();
    await confirmCandidateAction({}, confirmForm(accountId));
    const [before] = await listObligations();
    if (!before) throw new Error("expected a confirmed obligation");

    const form = obligationForm(accountId, { label: "Mortgage renamed" });
    form.set("id", before.id);
    await saveObligationAction({}, form);

    const [after] = await listObligations();
    expect(after).toMatchObject({
      id: before.id,
      label: "Mortgage renamed",
      source: "detected",
      detectionKey: DETECTION_KEY,
      confidence: before.confidence,
    });
    expect(await loadCandidates({ today: new Date().toISOString().slice(0, 10) })).toEqual([]);
  });

  it("rejects an end date before the start date without writing", async () => {
    const { accountId } = await seedSeries();

    const result = await saveObligationAction(
      {},
      obligationForm(accountId, { startDate: "2026-06-01", endDate: "2026-05-01" }),
    );

    expect(result.error).toMatch(/on or after the start date/i);
    expect(await listObligations()).toEqual([]);
  });

  it("refuses to edit an obligation that does not exist", async () => {
    const { accountId } = await seedSeries();
    const form = obligationForm(accountId);
    form.set("id", "00000000-0000-4000-8000-000000000999");

    expect((await saveObligationAction({}, form)).error).toBe("Unknown obligation");
  });
});

describe("deactivateObligationAction", () => {
  it("stops the obligation and keeps every occurrence it explains", async () => {
    // Deactivate, never delete (CLAUDE.md §Database). Deleting would cascade the
    // occurrence history away and silently change every residual window that
    // included those months.
    const { accountId } = await seedSeries();
    await confirmCandidateAction({}, confirmForm(accountId));
    const [obligation] = await listObligations();
    if (!obligation) throw new Error("expected a confirmed obligation");
    const before = await db.select().from(obligationOccurrences);

    await deactivateObligationAction(obligation.id);

    expect(await listObligations()).toEqual([]);
    expect(await listObligations({ includeInactive: true })).toHaveLength(1);
    expect(await db.select().from(obligationOccurrences)).toHaveLength(before.length);
    expect(await db.select().from(scheduledObligations)).toHaveLength(1);
  });

  it("does not re-propose a stopped series as a candidate", async () => {
    // Re-proposing something the user deliberately turned off is the re-nagging
    // ADR-026 rejected for price targets.
    const { accountId } = await seedSeries();
    await confirmCandidateAction({}, confirmForm(accountId));
    const [obligation] = await listObligations();
    if (!obligation) throw new Error("expected a confirmed obligation");

    await deactivateObligationAction(obligation.id);

    expect(await loadCandidates({ today: new Date().toISOString().slice(0, 10) })).toEqual([]);
  });

  it("rejects a malformed id", async () => {
    expect((await deactivateObligationAction("not-a-uuid")).error).toBe("Unknown obligation");
  });
});

function dismissForm(accountId: string, snoozeDays: string): FormData {
  const form = new FormData();
  form.set("accountId", accountId);
  form.set("detectionKey", DETECTION_KEY);
  form.set("snoozeDays", snoozeDays);
  return form;
}

function obligationForm(accountId: string, over: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("accountId", accountId);
  form.set("categoryId", "");
  form.set("label", "Water bill");
  form.set("expectedAmount", "64.00");
  form.set("direction", "outflow");
  form.set("currency", "USD");
  form.set("cadence", "monthly");
  form.set("anchorDate", "2026-01-15");
  form.set("startDate", "2026-01-01");
  form.set("endDate", "");
  form.set("amountMode", "fixed");
  form.set("notes", "");
  form.set("active", "on");
  for (const [k, v] of Object.entries(over)) form.set(k, v);
  return form;
}
