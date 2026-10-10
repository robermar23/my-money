import "server-only";

import { db } from "@/db/client.ts";
import { users } from "@/db/schema/index.ts";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./password.ts";

/**
 * PLAN19 P19-33(b) — change the one password from the browser.
 *
 * Before this the only path was `make db-reset-password`, which needs a shell
 * on the host and works by deleting the user. ADR-004 stands unchanged: one
 * password, no email, no username, no minimum length, **no reset path**. This
 * requires the current password, so a forgotten one is still
 * `make db-reset-password`.
 *
 * **It signs every other browser out.** Sessions are stateless iron-session
 * cookies carrying the user's id, and `requireUser` resolves that id against
 * `users`. Changing the password also gives the row a new id, so every cookie
 * minted before the change resolves to no user, and the caller re-issues its
 * own cookie with the new id. That is what someone changing a password after a
 * suspected leak needs, at no schema cost: nothing references `users.id`.
 */

/** Same bounds as the login form: required, and capped against huge inputs. */
const passwordField = z.string().min(1, "Enter a password.").max(1024, "That is too long.");

const schema = z
  .object({ current: passwordField, next: passwordField, confirm: z.string() })
  .refine((v) => v.next === v.confirm, {
    message: "The new password and its confirmation do not match.",
    path: ["confirm"],
  });

export type ChangePasswordInput = z.infer<typeof schema>;

/**
 * Validate the form fields.
 *
 * @param form - The submitted form.
 * @returns The parsed fields, or the first validation message.
 */
export function parseChangePassword(
  form: FormData,
):
  | { readonly ok: true; readonly input: ChangePasswordInput }
  | { readonly ok: false; readonly error: string } {
  const parsed = schema.safeParse({
    current: form.get("current"),
    next: form.get("next"),
    confirm: form.get("confirm"),
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
}

export type ChangePasswordResult =
  | { readonly kind: "changed"; readonly userId: string }
  | { readonly kind: "wrong_current" }
  | { readonly kind: "no_user" };

/**
 * Verify the current password, store the new one, and rotate the user's id.
 *
 * @param userId - The signed-in user's id, from the session.
 * @param input - The validated form fields.
 * @returns The new id on success; otherwise why nothing changed.
 */
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
): Promise<ChangePasswordResult> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { kind: "no_user" };
  if (!(await verifyPassword(user.passwordHash, input.current))) return { kind: "wrong_current" };

  const passwordHash = await hashPassword(input.next);
  const [updated] = await db
    .update(users)
    .set({ id: sql`gen_random_uuid()`, passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return updated ? { kind: "changed", userId: updated.id } : { kind: "no_user" };
}
