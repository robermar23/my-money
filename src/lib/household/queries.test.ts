// @vitest-environment node
import { db } from "@/db/client.ts";
import { householdMembers, householdProfile } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createHouseholdMember,
  deleteHouseholdMember,
  loadHousehold,
  saveHouseholdProfile,
  updateHouseholdMember,
} from "./queries.ts";

/* Real DB, like the other query modules — nothing here to mock. */

const BLANK = {
  reserveMonthsOverride: null,
  retirementTargetAge: null,
  benchmarkSavingsApy: null,
  needsPct: null,
  wantsPct: null,
  savingsPct: null,
  highInterestThresholdApr: null,
};

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE household_profile, household_members CASCADE`);
}

beforeEach(reset);

describe("saveHouseholdProfile", () => {
  it("creates the profile on first save", async () => {
    const saved = await saveHouseholdProfile({ ...BLANK, reserveMonthsOverride: 6 });

    expect(saved.reserveMonthsOverride).toBe(6);
    expect(saved.currency).toBe("USD");
  });

  it("keeps exactly one row across repeated saves", async () => {
    // The singleton invariant, like `users`. The table has a UUID PK rather than
    // a one-row constraint, so this function is what enforces it — a second row
    // would make `loadHousehold`'s LIMIT 1 return an arbitrary profile.
    await saveHouseholdProfile({ ...BLANK, reserveMonthsOverride: 6 });
    await saveHouseholdProfile({ ...BLANK, reserveMonthsOverride: 12 });
    await saveHouseholdProfile({ ...BLANK, retirementTargetAge: 62 });

    const rows = await db.select().from(householdProfile);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.retirementTargetAge).toBe(62);
  });

  it("clears an override back to null rather than keeping the old value", async () => {
    // Blank means "use the checked-in default". If a cleared field kept its
    // previous value, an override would be impossible to undo and the household
    // would stop tracking the constant.
    await saveHouseholdProfile({ ...BLANK, reserveMonthsOverride: 6 });
    const cleared = await saveHouseholdProfile(BLANK);

    expect(cleared.reserveMonthsOverride).toBeNull();
  });

  it("round-trips the split as numeric strings", async () => {
    const saved = await saveHouseholdProfile({
      ...BLANK,
      needsPct: "60.00",
      wantsPct: "20.00",
      savingsPct: "20.00",
    });

    // Money-adjacent values stay strings end-to-end (CLAUDE.md §Money).
    expect(saved.needsPct).toBe("60.00");
    expect(typeof saved.needsPct).toBe("string");
  });

  it("is rejected by the DB when a split does not sum to 100", async () => {
    // The Zod schema is the message the user reads; this CHECK is the backstop
    // that holds even if a future caller forgets to validate.
    await expect(
      saveHouseholdProfile({
        ...BLANK,
        needsPct: "60.00",
        wantsPct: "20.00",
        savingsPct: "10.00",
      }),
    ).rejects.toThrow();
  });
});

describe("household members", () => {
  it("stores a member with only a label", async () => {
    const member = await createHouseholdMember({
      label: "Me",
      birthYear: null,
      isDependent: false,
    });

    expect(member.label).toBe("Me");
    expect(member.birthYear).toBeNull();
  });

  it("edits a member and can clear the birth year", async () => {
    const member = await createHouseholdMember({
      label: "Alex",
      birthYear: 1985,
      isDependent: false,
    });

    const updated = await updateHouseholdMember(member.id, {
      label: "Alex",
      birthYear: null,
      isDependent: true,
    });

    expect(updated?.birthYear).toBeNull();
    expect(updated?.isDependent).toBe(true);
  });

  it("returns null when editing a member that does not exist", async () => {
    const missing = await updateHouseholdMember("11111111-1111-4111-8111-111111111111", {
      label: "Nobody",
      birthYear: null,
      isDependent: false,
    });

    expect(missing).toBeNull();
  });

  it("removes a member outright rather than archiving", async () => {
    // A member row has no children and no historical meaning — it is a fact
    // about today. Keeping a soft-deleted person's name and birth year forever
    // would be storing PII for no purpose.
    const member = await createHouseholdMember({
      label: "Sam",
      birthYear: 2010,
      isDependent: true,
    });
    await deleteHouseholdMember(member.id);

    expect(await db.select().from(householdMembers)).toHaveLength(0);
  });

  it("rejects an out-of-range birth year at the database", async () => {
    await expect(
      createHouseholdMember({ label: "Impossible", birthYear: 1799, isDependent: false }),
    ).rejects.toThrow();
  });
});

describe("loadHousehold", () => {
  it("reports no profile before anything is saved", async () => {
    const household = await loadHousehold();

    // Not an empty-but-present profile: "never configured" and "configured with
    // no overrides" are different states, and the guidance surfaces say so.
    expect(household.profile).toBeNull();
    expect(household.members).toEqual([]);
  });

  it("returns the profile and members in a stable order", async () => {
    await saveHouseholdProfile({ ...BLANK, reserveMonthsOverride: 6 });
    await createHouseholdMember({ label: "First", birthYear: null, isDependent: false });
    await createHouseholdMember({ label: "Second", birthYear: null, isDependent: true });

    const household = await loadHousehold();

    expect(household.profile?.reserveMonthsOverride).toBe(6);
    expect(household.members.map((m) => m.label)).toEqual(["First", "Second"]);
  });
});
