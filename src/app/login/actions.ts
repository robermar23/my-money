"use server";

import { db } from "@/db/client.ts";
import { users } from "@/db/schema/index.ts";
import { hashPassword, verifyPassword } from "@/lib/auth/password.ts";
import { getSession } from "@/lib/auth/session.ts";
import { redirect } from "next/navigation";
import { z } from "zod";

const schema = z.object({
  password: z.string().min(1, "Password is required").max(1024),
});

export interface LoginResult {
  error?: string;
}

/**
 * Single auth action.
 *
 *   - If no user row exists yet: this submission SETS the password
 *     (first-run bootstrap) and signs in.
 *   - If a user row exists: this submission VERIFIES against the stored
 *     argon2id hash and signs in.
 *
 * No email, no username — there is exactly one user. The session lasts a
 * year (see session.ts); logout is via POST /logout.
 */
export async function loginOrBootstrap(
  _prev: LoginResult,
  formData: FormData,
): Promise<LoginResult> {
  const parsed = schema.safeParse({ password: formData.get("password") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const [existing] = await db.select().from(users).limit(1);

  if (!existing) {
    // First-time: this password becomes THE password.
    const passwordHash = await hashPassword(parsed.data.password);
    const [created] = await db.insert(users).values({ passwordHash }).returning({ id: users.id });
    if (!created) {
      return { error: "Failed to create user" };
    }
    const session = await getSession();
    session.userId = created.id;
    await session.save();
    redirect("/");
  }

  // Returning visit: verify.
  const ok = await verifyPassword(existing.passwordHash, parsed.data.password);
  if (!ok) {
    return { error: "Wrong password" };
  }

  const session = await getSession();
  session.userId = existing.id;
  await session.save();
  redirect("/");
}
