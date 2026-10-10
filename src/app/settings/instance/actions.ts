"use server";

import { requireUser } from "@/lib/auth/require-user.ts";
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
