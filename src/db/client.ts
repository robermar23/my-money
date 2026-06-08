import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

// Single shared pool across the Next.js server runtime.
// `max: 10` is plenty for single-user; raises with Plaid webhook bursts in Phase 4.
//
// `idle_timeout` is intentionally NOT set (postgres.js default = keep pooled
// connections open). With an idle_timeout, the driver closes idle connections;
// the next request reconnects via `reconnect()`, which schedules
// `setTimeout(connect, closedDate + delay - performance.now())`. Once the
// connection has sat closed longer than `delay` (e.g. the dev box idled, or the
// worker slept between nightly jobs), that value is negative and Node emits a
// `TimeoutNegativeWarning` (benign — clamped to 1ms — but noisy). Keeping the
// small pool warm avoids the idle-close→reconnect cycle entirely, and at
// single-user scale holding a few connections open costs nothing.
const queryClient = postgres(databaseUrl, {
  max: 10,
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;
