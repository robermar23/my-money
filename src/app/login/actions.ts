"use server";

import { db } from "@/db/client.ts";
import { users } from "@/db/schema/users.ts";
import { verifyPassword } from "@/lib/auth/password.ts";
import { getSession } from "@/lib/auth/session.ts";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});

export interface LoginResult {
  error?: string;
}

/**
 * Server action: verify credentials and start a session.
 *
 * Uses a deliberately generic error message so timing/error differences don't
 * leak which field was wrong (email vs. password). The argon2 verify call
 * always runs even when the user lookup fails, to keep timing uniform.
 */
export async function login(_prev: LoginResult, formData: FormData): Promise<LoginResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "Invalid email or password" };
  }

  const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);

  // Dummy hash so we still spend ~50ms on argon2 verify when the user doesn't exist —
  // prevents timing-based user enumeration. The hash itself never matches anything.
  const hashToCheck =
    user?.passwordHash ??
    "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const ok = await verifyPassword(hashToCheck, parsed.data.password);

  if (!user || !ok) {
    return { error: "Invalid email or password" };
  }

  const session = await getSession();
  session.userId = user.id;
  await session.save();

  redirect("/");
}
