"use server";

import { requireUser } from "@/lib/auth/require-user.ts";
import {
  createHouseholdMember,
  deleteHouseholdMember,
  saveHouseholdProfile,
  updateHouseholdMember,
} from "@/lib/household/queries.ts";
import { householdMemberSchema, householdProfileSchema } from "@/lib/schemas/advice.ts";
import { revalidatePath } from "next/cache";

/**
 * Server actions for `/settings/household` (Phase 15, P15-32).
 *
 * Convention (per PLAN7): `requireUser()` → Zod validate → mutate →
 * `revalidatePath`. Single-user app, so ownership is implicit.
 *
 * Blank fields are written as `null`, never as a default. Every profile column
 * is an OVERRIDE of a checked-in constant, so clearing one has to mean "go back
 * to the default" — if a blank field silently stored the current default value,
 * the household would stop tracking that constant without anyone choosing to.
 *
 * Nothing here logs a value. Household names and birth years are the most
 * personal data the app holds (CLAUDE.md §Privacy) and never reach a logger, a
 * notification body, or any outbound request.
 */

export interface HouseholdActionResult {
  error?: string;
  ok?: boolean;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Revalidate everything a household change can move. */
function revalidateHouseholdSurfaces(): void {
  revalidatePath("/settings/household");
  revalidatePath("/plan");
  revalidatePath("/");
}

/** `""` → null; otherwise the trimmed string. */
function orNull(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

/** `""` → null; otherwise the integer. Zod has already bounded the range. */
function intOrNull(value: string | undefined): number | null {
  const raw = orNull(value);
  return raw === null ? null : Number(raw);
}

/**
 * Save the singleton household profile (P15-32).
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - Every override field; blank clears one to its default.
 * @returns HouseholdActionResult with `ok` on success, or `error`.
 */
export async function saveHouseholdProfileAction(
  _prev: HouseholdActionResult,
  formData: FormData,
): Promise<HouseholdActionResult> {
  await requireUser();
  const parsed = householdProfileSchema.safeParse({
    reserveMonthsOverride: formData.get("reserveMonthsOverride") ?? "",
    retirementTargetAge: formData.get("retirementTargetAge") ?? "",
    benchmarkSavingsApy: formData.get("benchmarkSavingsApy") ?? "",
    needsPct: formData.get("needsPct") ?? "",
    wantsPct: formData.get("wantsPct") ?? "",
    savingsPct: formData.get("savingsPct") ?? "",
    highInterestThresholdApr: formData.get("highInterestThresholdApr") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await saveHouseholdProfile({
    reserveMonthsOverride: intOrNull(parsed.data.reserveMonthsOverride),
    retirementTargetAge: intOrNull(parsed.data.retirementTargetAge),
    benchmarkSavingsApy: orNull(parsed.data.benchmarkSavingsApy),
    needsPct: orNull(parsed.data.needsPct),
    wantsPct: orNull(parsed.data.wantsPct),
    savingsPct: orNull(parsed.data.savingsPct),
    highInterestThresholdApr: orNull(parsed.data.highInterestThresholdApr),
  });

  revalidateHouseholdSurfaces();
  return { ok: true };
}

/**
 * Add a household member (P15-32).
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - Fields: label, birthYear, isDependent.
 * @returns HouseholdActionResult with `ok` on success, or `error`.
 */
export async function createHouseholdMemberAction(
  _prev: HouseholdActionResult,
  formData: FormData,
): Promise<HouseholdActionResult> {
  await requireUser();
  const parsed = householdMemberSchema.safeParse({
    label: formData.get("label") ?? "",
    birthYear: formData.get("birthYear") ?? "",
    isDependent: formData.get("isDependent") === "on",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await createHouseholdMember({
    label: parsed.data.label,
    birthYear: intOrNull(parsed.data.birthYear),
    isDependent: parsed.data.isDependent ?? false,
  });

  revalidateHouseholdSurfaces();
  return { ok: true };
}

/**
 * Edit a household member (P15-32).
 *
 * @param memberId - The member UUID.
 * @param patch - Label, birth year (blank clears), dependent flag.
 * @returns HouseholdActionResult with `ok` on success, or `error`.
 */
export async function updateHouseholdMemberAction(
  memberId: string,
  patch: { label: string; birthYear: string; isDependent: boolean },
): Promise<HouseholdActionResult> {
  await requireUser();
  if (!UUID_RE.test(memberId)) return { error: "Invalid id" };
  const parsed = householdMemberSchema.safeParse(patch);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const updated = await updateHouseholdMember(memberId, {
    label: parsed.data.label,
    birthYear: intOrNull(parsed.data.birthYear),
    isDependent: parsed.data.isDependent ?? false,
  });
  if (!updated) return { error: "Member not found" };

  revalidateHouseholdSurfaces();
  return { ok: true };
}

/**
 * Remove a household member (P15-32). A hard delete — see the queries module on
 * why this one row does not archive.
 *
 * @param memberId - The member UUID.
 * @returns HouseholdActionResult with `ok` on success, or `error`.
 */
export async function deleteHouseholdMemberAction(
  memberId: string,
): Promise<HouseholdActionResult> {
  await requireUser();
  if (!UUID_RE.test(memberId)) return { error: "Invalid id" };
  await deleteHouseholdMember(memberId);
  revalidateHouseholdSurfaces();
  return { ok: true };
}
