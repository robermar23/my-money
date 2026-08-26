import "server-only";

import { db } from "@/db/client.ts";
import {
  type HouseholdMember,
  type HouseholdProfile,
  householdMembers,
  householdProfile,
} from "@/db/schema/index.ts";
import { asc, eq } from "drizzle-orm";

/**
 * Reads and writes for the household profile + members (Phase 15, P15-32).
 *
 * ── PRIVACY (CLAUDE.md §Privacy & Data Sovereignty) ────────────────────────
 * These are the only rows in the database that describe PEOPLE rather than
 * money, and three properties are binding rather than aspirational (see the
 * [schema header](../../db/schema/household.ts)):
 *
 *   1. They never leave the box. Nothing in this module or its callers makes an
 *      outbound request, and the advice engine that consumes them has an egress
 *      budget of exactly zero.
 *   2. They ride the nightly `age`-encrypted `pg_dump` (ADR-014) like every
 *      other table — no separate handling, no separate key.
 *   3. `label` is deliberately excluded from the ⌘K search index (ADR-033 §7).
 *      There is no trigram index on it and no search query reads it.
 *
 * Nothing here is ever logged. A birth year and a household member's name are
 * not debugging output.
 *
 * ── The singleton ──────────────────────────────────────────────────────────
 * `household_profile` holds exactly one row, like `users`. The table has a UUID
 * PK rather than a one-row constraint, so {@link saveHouseholdProfile} enforces
 * the invariant: update the existing row if there is one, insert otherwise, in a
 * transaction so two concurrent saves cannot produce two profiles.
 *
 * Every profile column is NULLABLE and NULL is MEANINGFUL: it means "use the
 * checked-in default from `src/lib/advice/constants.ts`". That keeps the
 * defaults reviewable and testable in code, and keeps the database from pinning
 * a stale default from install day. This module therefore writes `null` for a
 * cleared field and never substitutes a default for one.
 */

export interface Household {
  readonly profile: HouseholdProfile | null;
  readonly members: readonly HouseholdMember[];
}

/** The overridable profile fields, as `numeric`/integer values or `null`. */
export interface HouseholdProfilePatch {
  readonly reserveMonthsOverride: number | null;
  readonly retirementTargetAge: number | null;
  readonly benchmarkSavingsApy: string | null;
  readonly needsPct: string | null;
  readonly wantsPct: string | null;
  readonly savingsPct: string | null;
  readonly highInterestThresholdApr: string | null;
}

/**
 * The two Phase-16 projection settings. Kept apart from
 * {@link HouseholdProfilePatch} so the two forms that write this row cannot
 * clear each other's columns.
 */
export interface CashFlowSettingsPatch {
  /** Money string, or `null` to fall back to the default (no buffer). */
  readonly cashFloor: string | null;
  /** Days, or `null` to fall back to the 60-day default. */
  readonly projectionHorizonDays: number | null;
}

/** One member's editable fields. */
export interface HouseholdMemberPatch {
  readonly label: string;
  readonly birthYear: number | null;
  readonly isDependent: boolean;
}

/**
 * Load the household profile and its members.
 *
 * @returns The singleton profile (`null` when never saved) and the members,
 *   oldest first so the list is stable across edits.
 */
export async function loadHousehold(): Promise<Household> {
  const [profiles, members] = await Promise.all([
    db.select().from(householdProfile).limit(1),
    db.select().from(householdMembers).orderBy(asc(householdMembers.createdAt)),
  ]);
  return { profile: profiles[0] ?? null, members };
}

/**
 * Save the singleton profile, creating it on first use (P15-32).
 *
 * Writes the whole patch every time, including `null`s. A partial patch would
 * make "clear this override" unreachable — and clearing an override back to the
 * default is a normal thing to want, not an edge case.
 *
 * @param patch - Every overridable field; `null` clears back to the default.
 * @returns The saved profile row.
 */
export async function saveHouseholdProfile(
  patch: HouseholdProfilePatch,
): Promise<HouseholdProfile> {
  return upsertProfile(patch, "saveHouseholdProfile");
}

/**
 * Save the two cash-flow projection settings (Phase 16, P16-23, ADR-038 §4/§5).
 *
 * A SEPARATE entry point rather than two more fields on
 * {@link HouseholdProfilePatch}, because these are edited from the projection
 * surface rather than from `/settings/household`, and the two forms must not
 * clobber each other's columns. They share {@link upsertProfile}, so there is
 * still exactly one writer of the singleton row and one place the
 * insert-or-update invariant lives.
 *
 * `null` means "use the checked-in default", exactly as every other override on
 * this table does — never zero. For the floor that distinction is load-bearing:
 * a stored `0.00` says "I want no cushion", while `null` says "I have not
 * thought about it", and only the first should silence the prompt to set one.
 *
 * @param patch - Floor as a money string or `null`; horizon in days or `null`.
 * @returns The saved profile row.
 */
export async function saveCashFlowSettings(
  patch: CashFlowSettingsPatch,
): Promise<HouseholdProfile> {
  return upsertProfile(patch, "saveCashFlowSettings");
}

/** Insert-or-update the singleton profile row with whichever columns are given. */
async function upsertProfile(
  patch: HouseholdProfilePatch | CashFlowSettingsPatch,
  label: string,
): Promise<HouseholdProfile> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: householdProfile.id }).from(householdProfile).limit(1);

    if (existing) {
      const [row] = await tx
        .update(householdProfile)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(householdProfile.id, existing.id))
        .returning();
      if (!row) throw new Error(`${label}: update returned no row`);
      return row;
    }

    const [row] = await tx.insert(householdProfile).values(patch).returning();
    if (!row) throw new Error(`${label}: insert returned no row`);
    return row;
  });
}

/**
 * Add a household member.
 *
 * @param patch - Label, optional birth year, dependent flag.
 * @returns The inserted member.
 */
export async function createHouseholdMember(patch: HouseholdMemberPatch): Promise<HouseholdMember> {
  const [row] = await db.insert(householdMembers).values(patch).returning();
  if (!row) throw new Error("createHouseholdMember: insert returned no row");
  return row;
}

/**
 * Edit a household member.
 *
 * @param id - Member UUID.
 * @param patch - The full editable field set.
 * @returns The updated member, or null when the id didn't exist.
 */
export async function updateHouseholdMember(
  id: string,
  patch: HouseholdMemberPatch,
): Promise<HouseholdMember | null> {
  const [row] = await db
    .update(householdMembers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(householdMembers.id, id))
    .returning();
  return row ?? null;
}

/**
 * Remove a household member.
 *
 * A hard delete, unlike accounts and categories, which archive. Those carry
 * history that other rows point at; a member row has no children, no FK
 * referencing it, and no historical meaning — it is a fact about today that
 * feeds the reserve multiplier. Keeping a soft-deleted person's name and birth
 * year in the database forever would be storing PII for no purpose, which is the
 * opposite of this project's posture.
 *
 * @param id - Member UUID.
 */
export async function deleteHouseholdMember(id: string): Promise<void> {
  await db.delete(householdMembers).where(eq(householdMembers.id, id));
}
