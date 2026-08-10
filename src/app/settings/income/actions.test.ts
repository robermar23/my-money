// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accounts,
  holdings,
  incomeContributions,
  incomeSources,
  retirementContributions,
} from "@/db/schema/index.ts";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const {
  createIncomeSourceAction,
  deleteContributionRuleAction,
  deleteIncomeSourceAction,
  previewContributionAction,
  saveContributionRuleAction,
  setIncomeSourceActiveAction,
  updateIncomeSourceAction,
} = await import("./actions.ts");

/**
 * P14-14/P14-15 — the guards that Zod structurally cannot enforce, and the
 * preview arithmetic.
 *
 * Two classes of test here, both load-bearing:
 *   1. **Cross-row guards.** A client-supplied account or holding id is never
 *      trusted; pointing a rule at the wrong account would silently create cost
 *      basis in the wrong place.
 *   2. **History protection.** Deleting a source or rule cascades the
 *      `income_contributions` audit trail while leaving the lots it created —
 *      the 401k would keep a basis with no record of where it came from.
 */

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE income_contributions, retirement_contributions, income_sources,
        investment_transactions, holding_lots, holdings, accounts CASCADE`,
  );
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/** A biweekly $3,000 paycheck. */
const SOURCE_FIELDS = {
  name: "Acme Corp",
  cadence: "biweekly",
  grossPerPeriod: "3000.00",
  currency: "usd",
  anchorDate: "2026-01-02",
  startDate: "2026-01-01",
  endDate: "",
  notes: "",
  active: "on",
};

async function seedAccounts(): Promise<{
  investmentId: string;
  checkingId: string;
  holdingId: string;
  otherHoldingId: string;
}> {
  const [investment] = await db
    .insert(accounts)
    .values({ name: "401k", institution: "Fidelity", type: "investment", currency: "USD" })
    .returning({ id: accounts.id });
  const [checking] = await db
    .insert(accounts)
    .values({ name: "Checking", institution: "Ally", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  const [other] = await db
    .insert(accounts)
    .values({ name: "Brokerage", institution: "Schwab", type: "investment", currency: "USD" })
    .returning({ id: accounts.id });
  if (!investment || !checking || !other) throw new Error("seed accounts failed");

  const [holding] = await db
    .insert(holdings)
    .values({
      accountId: investment.id,
      symbol: "FXAIX",
      quantity: "0",
      quantityUnit: "shares",
      assetClass: "equity",
    })
    .returning({ id: holdings.id });
  const [otherHolding] = await db
    .insert(holdings)
    .values({
      accountId: other.id,
      symbol: "VTI",
      quantity: "0",
      quantityUnit: "shares",
      assetClass: "equity",
    })
    .returning({ id: holdings.id });
  if (!holding || !otherHolding) throw new Error("seed holdings failed");

  return {
    investmentId: investment.id,
    checkingId: checking.id,
    holdingId: holding.id,
    otherHoldingId: otherHolding.id,
  };
}

/** Create a source through the action and return its id. */
async function seedSource(overrides: Record<string, string> = {}): Promise<string> {
  const result = await createIncomeSourceAction({}, form({ ...SOURCE_FIELDS, ...overrides }));
  if (!result.createdId) throw new Error(result.error ?? "source not created");
  return result.createdId;
}

beforeEach(reset);
afterEach(() => vi.clearAllMocks());
afterAll(reset);

describe("createIncomeSourceAction", () => {
  it("stores a normalised source", async () => {
    const id = await seedSource();
    const [row] = await db.select().from(incomeSources).where(eq(incomeSources.id, id));

    expect(row?.currency).toBe("USD"); // upper-cased at the boundary
    expect(row?.endDate).toBeNull(); // blank stored as NULL, not ""
    expect(row?.grossPerPeriod).toBe("3000.00"); // NUMERIC round-trips as a string
    expect(row?.active).toBe(true);
  });

  it("refuses an end date before the start date", async () => {
    const result = await createIncomeSourceAction(
      {},
      form({ ...SOURCE_FIELDS, startDate: "2026-06-01", endDate: "2026-01-01" }),
    );
    expect(result.error).toMatch(/on or after the start date/i);
    expect(await db.select().from(incomeSources)).toHaveLength(0);
  });

  it("refuses negative gross pay", async () => {
    const result = await createIncomeSourceAction(
      {},
      form({ ...SOURCE_FIELDS, grossPerPeriod: "-3000.00" }),
    );
    expect(result.error).toBeTruthy();
    expect(await db.select().from(incomeSources)).toHaveLength(0);
  });
});

describe("updateIncomeSourceAction / setIncomeSourceActiveAction", () => {
  it("edits a source without touching its identity", async () => {
    const id = await seedSource();
    const result = await updateIncomeSourceAction(
      {},
      form({ ...SOURCE_FIELDS, id, name: "Acme Corp — raise", grossPerPeriod: "3300.00" }),
    );
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(incomeSources).where(eq(incomeSources.id, id));
    expect(row?.name).toBe("Acme Corp — raise");
    expect(row?.grossPerPeriod).toBe("3300.00");
  });

  it("rejects an unknown id rather than silently doing nothing", async () => {
    const result = await updateIncomeSourceAction(
      {},
      form({ ...SOURCE_FIELDS, id: "11111111-1111-1111-1111-111111111111" }),
    );
    expect(result.error).toMatch(/unknown income source/i);
  });

  it("pauses a source without deleting anything", async () => {
    const id = await seedSource();
    await setIncomeSourceActiveAction(id, false);

    const [row] = await db.select().from(incomeSources).where(eq(incomeSources.id, id));
    expect(row?.active).toBe(false);
    expect(row?.grossPerPeriod).toBe("3000.00");
  });
});

describe("saveContributionRuleAction", () => {
  const RULE_FIELDS = {
    employeeBasis: "percent",
    employeeValue: "6",
    pretax: "on",
    matchBasis: "percent_of_gross",
    matchValue: "3",
    matchCapPercent: "4",
    active: "on",
  };

  it("creates a rule against an investment account", async () => {
    const { investmentId, holdingId } = await seedAccounts();
    const sourceId = await seedSource();

    const result = await saveContributionRuleAction(
      {},
      form({
        ...RULE_FIELDS,
        incomeSourceId: sourceId,
        accountId: investmentId,
        holdingId,
      }),
    );
    expect(result.ok).toBe(true);

    const [rule] = await db.select().from(retirementContributions);
    expect(rule?.incomeSourceId).toBe(sourceId);
    expect(rule?.holdingId).toBe(holdingId);
    expect(rule?.employeeValue).toBe("6.0000");
    expect(rule?.matchCapPercent).toBe("4.0000");
  });

  it("refuses an account that is not an investment account", async () => {
    // A contribution funds a retirement account; pointing it at checking would
    // create investment ledger rows in an account that has no holdings at all.
    const { checkingId } = await seedAccounts();
    const sourceId = await seedSource();

    const result = await saveContributionRuleAction(
      {},
      form({ ...RULE_FIELDS, incomeSourceId: sourceId, accountId: checkingId, holdingId: "" }),
    );
    expect(result.error).toMatch(/investment account/i);
    expect(await db.select().from(retirementContributions)).toHaveLength(0);
  });

  it("refuses a holding that belongs to a different account", async () => {
    // The client can send any id; the basis would otherwise land on a position
    // in an account the paycheck never funds.
    const { investmentId, otherHoldingId } = await seedAccounts();
    const sourceId = await seedSource();

    const result = await saveContributionRuleAction(
      {},
      form({
        ...RULE_FIELDS,
        incomeSourceId: sourceId,
        accountId: investmentId,
        holdingId: otherHoldingId,
      }),
    );
    expect(result.error).toMatch(/not in the selected account/i);
    expect(await db.select().from(retirementContributions)).toHaveLength(0);
  });

  it("allows a rule with no holding — basis-only is a supported shape", async () => {
    const { investmentId } = await seedAccounts();
    const sourceId = await seedSource();

    const result = await saveContributionRuleAction(
      {},
      form({ ...RULE_FIELDS, incomeSourceId: sourceId, accountId: investmentId, holdingId: "" }),
    );
    expect(result.ok).toBe(true);

    const [rule] = await db.select().from(retirementContributions);
    expect(rule?.holdingId).toBeNull();
  });

  it("updates in place rather than creating a second rule", async () => {
    const { investmentId, holdingId } = await seedAccounts();
    const sourceId = await seedSource();
    const created = await saveContributionRuleAction(
      {},
      form({ ...RULE_FIELDS, incomeSourceId: sourceId, accountId: investmentId, holdingId }),
    );

    await saveContributionRuleAction(
      {},
      form({
        ...RULE_FIELDS,
        id: created.createdId ?? "",
        incomeSourceId: sourceId,
        accountId: investmentId,
        holdingId,
        employeeValue: "8",
      }),
    );

    const rules = await db.select().from(retirementContributions);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.employeeValue).toBe("8.0000");
  });

  it("clears the match fields when the basis is 'none'", async () => {
    const { investmentId } = await seedAccounts();
    const sourceId = await seedSource();

    await saveContributionRuleAction(
      {},
      form({
        ...RULE_FIELDS,
        incomeSourceId: sourceId,
        accountId: investmentId,
        holdingId: "",
        matchBasis: "none",
      }),
    );

    const [rule] = await db.select().from(retirementContributions);
    expect(rule?.matchValue).toBe("0.0000");
    expect(rule?.matchCapPercent).toBeNull();
  });
});

describe("delete guards", () => {
  /** Wire up a source + rule, then fake a materialized contribution. */
  async function seedWithHistory(): Promise<{ sourceId: string; ruleId: string }> {
    const { investmentId, holdingId } = await seedAccounts();
    const sourceId = await seedSource();
    const created = await saveContributionRuleAction(
      {},
      form({
        incomeSourceId: sourceId,
        accountId: investmentId,
        holdingId,
        employeeBasis: "percent",
        employeeValue: "6",
        pretax: "on",
        matchBasis: "none",
        matchValue: "0",
        matchCapPercent: "",
        active: "on",
      }),
    );
    const ruleId = created.createdId ?? "";
    await db.insert(incomeContributions).values({
      retirementContributionId: ruleId,
      payDate: "2026-01-02",
      grossAmount: "3000.00",
      employeeAmount: "180.00",
      employerAmount: "0.00",
    });
    return { sourceId, ruleId };
  }

  it("refuses to delete a source that has materialized contributions", async () => {
    const { sourceId } = await seedWithHistory();

    const result = await deleteIncomeSourceAction(sourceId);
    expect(result.error).toMatch(/deactivate it instead/i);
    expect(await db.select().from(incomeSources)).toHaveLength(1);
    expect(await db.select().from(incomeContributions)).toHaveLength(1);
  });

  it("refuses to delete a rule that has materialized contributions", async () => {
    const { ruleId } = await seedWithHistory();

    const result = await deleteContributionRuleAction(ruleId);
    expect(result.error).toMatch(/deactivate it instead/i);
    expect(await db.select().from(retirementContributions)).toHaveLength(1);
  });

  it("deletes a source that has never materialized anything", async () => {
    const sourceId = await seedSource();

    const result = await deleteIncomeSourceAction(sourceId);
    expect(result.ok).toBe(true);
    expect(await db.select().from(incomeSources)).toHaveLength(0);
  });
});

describe("previewContributionAction (P14-15)", () => {
  it("computes per-period and annual dollars plus the projected rate", async () => {
    const sourceId = await seedSource();

    const result = await previewContributionAction(
      {},
      form({
        incomeSourceId: sourceId,
        employeeBasis: "percent",
        employeeValue: "6",
        matchBasis: "percent_of_gross",
        matchValue: "3",
        matchCapPercent: "",
      }),
    );

    // 6% and 3% of $3,000, biweekly (26 periods).
    expect(result.preview?.employeePerPeriod).toBe("$180.00");
    expect(result.preview?.employerPerPeriod).toBe("$90.00");
    expect(result.preview?.totalPerPeriod).toBe("$270.00");
    expect(result.preview?.annualEmployee).toBe("$4,680.00");
    expect(result.preview?.annualGross).toBe("$78,000.00");
    expect(result.preview?.ratePct).toBe("6"); // employee ÷ gross, not total ÷ gross
    expect(result.preview?.periodsPerYear).toBe(26);
  });

  it("writes nothing — a preview is read-only", async () => {
    const sourceId = await seedSource();
    await previewContributionAction(
      {},
      form({
        incomeSourceId: sourceId,
        employeeBasis: "percent",
        employeeValue: "6",
        matchBasis: "none",
        matchValue: "0",
        matchCapPercent: "",
      }),
    );

    expect(await db.select().from(incomeContributions)).toHaveLength(0);
    expect(await db.select().from(retirementContributions)).toHaveLength(0);
  });

  it("flags a match reduced by the cap", async () => {
    const sourceId = await seedSource();

    const result = await previewContributionAction(
      {},
      form({
        incomeSourceId: sourceId,
        employeeBasis: "percent",
        employeeValue: "6",
        matchBasis: "percent_of_gross",
        matchValue: "10",
        matchCapPercent: "4",
      }),
    );

    // 10% of gross would be $300; the 4% cap holds it to $120.
    expect(result.preview?.employerPerPeriod).toBe("$120.00");
    expect(result.preview?.matchCapped).toBe(true);
  });

  it("flags a fixed contribution larger than gross, which is clamped", async () => {
    const sourceId = await seedSource();

    const result = await previewContributionAction(
      {},
      form({
        incomeSourceId: sourceId,
        employeeBasis: "amount",
        employeeValue: "5000",
        matchBasis: "none",
        matchValue: "0",
        matchCapPercent: "",
      }),
    );

    expect(result.preview?.employeeClamped).toBe(true);
    expect(result.preview?.employeePerPeriod).toBe("$3,000.00");
  });

  it("projects a paused source as if it were active", async () => {
    // A preview answers "what would this do"; excluding a paused source from the
    // denominator would report a nonsense rate on a source about to resume.
    const sourceId = await seedSource();
    await setIncomeSourceActiveAction(sourceId, false);

    const result = await previewContributionAction(
      {},
      form({
        incomeSourceId: sourceId,
        employeeBasis: "percent",
        employeeValue: "6",
        matchBasis: "none",
        matchValue: "0",
        matchCapPercent: "",
      }),
    );

    expect(result.preview?.annualGross).toBe("$78,000.00");
    expect(result.preview?.ratePct).toBe("6");
  });

  it("rejects an unknown source instead of guessing a gross", async () => {
    const result = await previewContributionAction(
      {},
      form({
        incomeSourceId: "11111111-1111-1111-1111-111111111111",
        employeeBasis: "percent",
        employeeValue: "6",
        matchBasis: "none",
        matchValue: "0",
        matchCapPercent: "",
      }),
    );
    expect(result.error).toMatch(/unknown income source/i);
  });
});
