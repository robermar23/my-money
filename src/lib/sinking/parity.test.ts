// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  categories,
  householdProfile,
  obligationOccurrences,
  plannedExpenses,
  scheduledObligations,
  transactions,
} from "@/db/schema/index.ts";
import { sinkingFundRule } from "@/lib/advice/rules/sinking-fund.ts";
import { loadFinancialSnapshot } from "@/lib/advice/snapshot.ts";
import { Money } from "@/lib/money/money.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadSinkingFund } from "./loader.ts";

/**
 * P18-32 — the two surfaces state the same number, proved mechanically.
 *
 * ADR-046 consequence 1 is a promise about two *pages*: the itemized
 * `/plan/sinking` and the `sinking_fund` card on `/plan` **cannot** disagree
 * about what a household should be holding. Every other test in this directory
 * proves a piece of the arithmetic. This one proves the composition — that the
 * two entry points, each loading from Postgres on its own, arrive at the same
 * string.
 *
 * ── Why this is cheap, and what it means if it ever stops being ───────────
 * PLAN18's own P18-32 wording: *"it is cheap precisely because both go through
 * the same pure functions — if it is ever hard to write, the composition has
 * been broken."* The whole test is a seed, two loads and an `expect`, because
 * [loader.ts](./loader.ts) and
 * [advice/rules/sinking-fund.ts](../advice/rules/sinking-fund.ts) both call
 * `sinkingHorizon` → `sinkingRequirement` → `sinkingAvailability` →
 * `sinkingStatus` over an `AdviceInput`. The day somebody writes a narrower,
 * faster loader for `/plan/sinking` that computes the requirement its own way,
 * this file is where it costs them: there would be no single pure function to
 * point both sides at, and the test would have to assert two hand-maintained
 * literals instead — which is the drift it exists to prevent.
 *
 * ── Why a string comparison and not a numeric one ────────────────────────
 * `"1500.00"` and `"1500.0"` are the same money and different *answers*: the
 * second means one of the two paths rounded or re-serialized somewhere, which is
 * exactly the kind of difference a household notices and neither page can
 * explain. Money is a string end-to-end in this codebase (CLAUDE.md §Money), so
 * the strings are what gets compared.
 *
 * ── What is seeded, and why it is not the fixture ────────────────────────
 * [round12.fixture.ts](./round12.fixture.ts) is an `AdviceInput` — handing it to
 * both paths would skip the half of the claim that matters, since
 * `loadSinkingFund` loads its own snapshot and the whole question is whether two
 * independent reads agree. So this seeds real rows and lets each side read them:
 * a cost from **each** of ADR-045's two sources, because a stream built from
 * `planned_expenses` alone would agree with itself perfectly while omitting the
 * premium the round opens with.
 */

const TODAY = "2026-10-04";

/** $600 of the dental bill plus $900 of the premium — see the seed. */
const EXPECTED_REQUIRED = "1500.00";

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE planned_expenses, obligation_occurrences, scheduled_obligations,
        transactions, categories, category_groups, account_snapshots, accounts,
        household_profile CASCADE`,
  );
});

/**
 * A household with one cost from each source, a reserve, and enough classified
 * history for an essential baseline.
 *
 * The baseline matters because without it `sinkingAvailability` has no target,
 * the rule takes its first degradation and reports **no figure at all** — a
 * parity test between two nulls passes while proving nothing. So the seed earns
 * a real target: $1,800/month of rent over six months, no override, therefore a
 * 3-month $5,400 target against $9,000 of savings.
 */
async function seed(): Promise<void> {
  const account = async (values: typeof accounts.$inferInsert): Promise<string> => {
    const [row] = await db.insert(accounts).values(values).returning({ id: accounts.id });
    if (!row) throw new Error(`seed account ${values.name}`);
    return row.id;
  };

  const checking = await account({
    name: "Everyday",
    institution: "M&T",
    type: "depository",
    subtype: "checking",
  });
  const savings = await account({
    name: "Reserve",
    institution: "M&T",
    type: "depository",
    subtype: "savings",
  });

  await db.insert(accountSnapshots).values([
    { accountId: checking, date: "2026-10-01", balance: "2000.00" },
    { accountId: savings, date: "2026-10-01", balance: "9000.00" },
  ]);

  const [rent] = await db
    .insert(categories)
    .values({ name: "Rent", kind: "expense", necessity: "essential" })
    .returning({ id: categories.id });
  if (!rent) throw new Error("seed category");

  let fit = 0;
  await db.insert(transactions).values(
    ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"].map((month) => ({
      accountId: checking,
      postedAt: `${month}-02`,
      amount: "-1800.00",
      name: "rent",
      fitid: `parity-${fit++}`,
      source: "manual" as const,
      categoryId: rent.id,
    })),
  );

  await db.insert(householdProfile).values({ currency: "USD" });

  // Source 1 (ADR-045 §1): the household typed this one in. $1,800 over the six
  // months from its accrual start, two of them elapsed → $600.
  await db.insert(plannedExpenses).values({
    label: "Dental work",
    amount: "1800.00",
    currency: "USD",
    dueDate: "2027-02-04",
    accrualStartDate: "2026-08-04",
    status: "planned",
  });

  // Source 2 (ADR-045 §1/§3): an annual premium the detector already knows
  // about, funded from last January's MATCHED occurrence. $1,200 over twelve
  // months, nine elapsed → $900.
  const [obligation] = await db
    .insert(scheduledObligations)
    .values({
      accountId: checking,
      label: "Car insurance",
      expectedAmount: "1200.00",
      direction: "outflow",
      currency: "USD",
      cadence: "annual",
      anchorDate: "2026-01-04",
      startDate: "2026-01-01",
      source: "manual",
    })
    .returning({ id: scheduledObligations.id });
  if (!obligation) throw new Error("seed obligation");

  await db.insert(obligationOccurrences).values([
    {
      obligationId: obligation.id,
      dueDate: "2026-01-04",
      expectedAmount: "1200.00",
      status: "matched",
    },
    {
      obligationId: obligation.id,
      dueDate: "2027-01-04",
      expectedAmount: "1200.00",
      status: "scheduled",
    },
  ]);
}

describe("P18-32 — /plan/sinking and the sinking_fund card cannot disagree", () => {
  it("states the same requirement string from two independent loads", async () => {
    await seed();

    // The two entry points, each doing its own reading.
    const snapshot = await loadSinkingFund({ today: TODAY });
    const [card] = sinkingFundRule.evaluate(await loadFinancialSnapshot({ today: TODAY }));
    if (!card) throw new Error("the rule produced no recommendation");

    // Vacuity guards first. Two nulls are equal, and so are two $0.00s.
    expect(card.status).not.toBe("unknown_input");
    expect(snapshot.requirement.costCount).toBe(2);
    expect(snapshot.requirement.requiredToday).toBe(EXPECTED_REQUIRED);

    // The claim (ADR-046 consequence 1). Both of the rule's money-bearing slots
    // carry the requirement, so both are checked — `benchmark` is what the card
    // compares against and `suggestedValue` is what it tells the household to
    // hold, and they are the same figure for the same reason.
    expect(card.suggestedValue).toBe(snapshot.requirement.requiredToday);
    expect(card.benchmark).toBe(snapshot.requirement.requiredToday);
  });

  it("agrees on the position against the requirement, not only the requirement", async () => {
    await seed();

    const snapshot = await loadSinkingFund({ today: TODAY });
    const [card] = sinkingFundRule.evaluate(await loadFinancialSnapshot({ today: TODAY }));
    if (!card) throw new Error("the rule produced no recommendation");

    // $9,000 of savings less a $5,400 target is $3,600 available against
    // $1,500 required — so the shortfall is zero and the card is the covered
    // one. Asserting the branch by name matters: `impact` means "the gap" in one
    // branch and is hard-coded "0.00" in the other, and a parity test that did
    // not know which branch it was in would be asserting a coincidence.
    expect(snapshot.availability.emergencyTarget).toBe("5400.00");
    expect(snapshot.availability.available).toBe("3600.00");
    expect(snapshot.availability.gap).toBe("0.00");
    expect(card.status).toBe("ok");
    expect(card.impact).toBe(snapshot.availability.gap);
    expect(card.currentValue).toBe(snapshot.availability.available);
  });

  it("quotes the same dollars in its prose as the page puts in its table", async () => {
    await seed();

    const snapshot = await loadSinkingFund({ today: TODAY });
    const [card] = sinkingFundRule.evaluate(await loadFinancialSnapshot({ today: TODAY }));
    if (!card) throw new Error("the rule produced no recommendation");

    // The structural parity above is the mechanical proof. This is the one a
    // household would actually notice: the sentence on `/plan` and the total on
    // `/plan/sinking` are the same formatted figure, so the two pages read as
    // one answer rather than two opinions. Formatting through the same `Money`
    // the page's formatter uses, since that is the only edge where a money
    // string legitimately becomes a rendered number (CLAUDE.md §Money).
    const required = Money.fromString(snapshot.requirement.requiredToday, snapshot.currency);
    expect(card.title).toContain(required.format());
    expect(card.rationale).toContain(required.format());

    const perMonth = Money.fromString(snapshot.requirement.perMonth, snapshot.currency);
    expect(card.rationale).toContain(perMonth.format());
    expect(card.rationale).toContain(`${snapshot.requirement.costCount} known costs`);
  });

  it("cites the same audit trail, so neither surface explains itself differently", async () => {
    await seed();

    const snapshot = await loadSinkingFund({ today: TODAY });
    const [card] = sinkingFundRule.evaluate(await loadFinancialSnapshot({ today: TODAY }));
    if (!card) throw new Error("the rule produced no recommendation");

    // `sinkingInputsUsed` is one function with two callers (P18-22), so this is
    // a wiring assertion rather than an arithmetic one: the day one side starts
    // building its own list, a household reading both pages gets two different
    // accounts of where the same number came from.
    expect(card.inputsUsed).toEqual(snapshot.inputsUsed);
    expect(card.inputsUsed.length).toBeGreaterThan(0);
  });
});
