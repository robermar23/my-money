"use server";

import { db } from "@/db/client.ts";
import { users } from "@/db/schema/users.ts";
import { hashPassword } from "@/lib/auth/password.ts";
import { userCount } from "@/lib/auth/require-user.ts";
import { getSession } from "@/lib/auth/session.ts";
import { redirect } from "next/navigation";
import { z } from "zod";

const bootstrapSchema = z.object({
  email: z.string().email("Enter a valid email").max(254),
  password: z.string().min(12, "Password must be at least 12 characters").max(1024),
});

export interface BootstrapResult {
  error?: string;
}

/**
 * Server action: create the single user record on first run.
 *
 * Refuses to run if any user already exists — bootstrap is a one-time operation.
 * On success, sets the session and redirects to `/`.
 */
export async function bootstrapUser(
  _prev: BootstrapResult,
  formData: FormData,
): Promise<BootstrapResult> {
  if ((await userCount()) > 0) {
    return { error: "A user already exists. Use /login instead." };
  }

  const parsed = bootstrapSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue?.message ?? "Invalid input" };
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const [created] = await db
    .insert(users)
    .values({ email: parsed.data.email, passwordHash })
    .returning({ id: users.id });

  if (!created) {
    return { error: "Failed to create user" };
  }

  const session = await getSession();
  session.userId = created.id;
  await session.save();

  redirect("/");
}
