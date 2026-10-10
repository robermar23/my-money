"use server";

import { changePassword, parseChangePassword } from "@/lib/auth/change-password.ts";
import { allowLoginAttempt } from "@/lib/auth/login-throttle.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { getSession } from "@/lib/auth/session.ts";
import { recordRestoreDrill } from "@/lib/household/queries.ts";
import { revalidatePath } from "next/cache";

/**
 * Record that the operator just completed a restore drill (PLAN19 P19-12,
 * ADR-052 §8).
 *
 * Takes no input: the only fact recorded is "the human says they did it, now".
 * Nothing is verified, and the page says so beside the button.
 *
 * @returns Nothing; the page re-renders with the new date.
 */
export async function recordRestoreDrillAction(): Promise<void> {
  await requireUser();
  await recordRestoreDrill(new Date());
  revalidatePath("/settings/instance");
}

/** What the password form shows after a submission. */
export interface ChangePasswordState {
  readonly error?: string;
  readonly changed?: boolean;
}

/**
 * Change the password (PLAN19 P19-33(b)).
 *
 * Throttled through the login bucket before any argon2 work: this form checks
 * the current password, so without the throttle it would be an unthrottled way
 * to guess it from a stolen session. On success the session is re-issued with
 * the rotated user id, so this browser stays signed in and every other one is
 * signed out (see `changePassword`).
 *
 * @param _prev - The previous form state (unused).
 * @param formData - `current`, `next` and `confirm`.
 * @returns An error to show, or `changed: true`.
 */
export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const user = await requireUser();
  if (!(await allowLoginAttempt())) {
    return { error: "Too many attempts. Wait a minute and try again." };
  }
  const parsed = parseChangePassword(formData);
  if (!parsed.ok) return { error: parsed.error };

  const result = await changePassword(user.id, parsed.input);
  switch (result.kind) {
    case "wrong_current":
      return { error: "The current password is wrong." };
    case "no_user":
      return { error: "Your session has expired. Sign in again." };
    case "changed": {
      const session = await getSession();
      session.userId = result.userId;
      await session.save();
      return { changed: true };
    }
  }
}
