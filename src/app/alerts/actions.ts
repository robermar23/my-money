"use server";

import { db } from "@/db/client.ts";
import { alerts } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/**
 * Dismiss an open alert — sets `resolved_at`. Bound per-row in the page
 * (`dismissAlertAction.bind(null, id)`), so the trailing FormData arg is ignored.
 */
export async function dismissAlertAction(alertId: string): Promise<void> {
  await requireUser();
  if (!/^[0-9a-f-]{36}$/i.test(alertId)) return;
  await db
    .update(alerts)
    .set({ resolvedAt: new Date() })
    .where(and(eq(alerts.id, alertId), isNull(alerts.resolvedAt)));
  revalidatePath("/alerts");
  // Refresh the nav badge (rendered in the root layout).
  revalidatePath("/", "layout");
}
