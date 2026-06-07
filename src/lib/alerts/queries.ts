import "server-only";

import { db } from "@/db/client.ts";
import { type Alert, alerts } from "@/db/schema/index.ts";
import { desc, isNotNull, isNull } from "drizzle-orm";

/** Open (unresolved) alerts, newest first — the top of the /alerts page + the nav badge. */
export async function listOpenAlerts(): Promise<Alert[]> {
  return db.select().from(alerts).where(isNull(alerts.resolvedAt)).orderBy(desc(alerts.detectedAt));
}

/** Recently-resolved alerts (history), newest first. */
export async function listResolvedAlerts(limit = 50): Promise<Alert[]> {
  return db
    .select()
    .from(alerts)
    .where(isNotNull(alerts.resolvedAt))
    .orderBy(desc(alerts.detectedAt))
    .limit(limit);
}

/** Count of open alerts — drives the nav badge. */
export async function openAlertCount(): Promise<number> {
  return db.$count(alerts, isNull(alerts.resolvedAt));
}
