import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

/**
 * Builds the Drizzle instance backed by a single shared postgres-js pool.
 *
 * Connection details:
 * `max: 10` is plenty for single-user; raises with Plaid webhook bursts in Phase 4.
 *
 * `idle_timeout` is intentionally NOT set (postgres.js default = keep pooled
 * connections open). With an idle_timeout, the driver closes idle connections;
 * the next request reconnects via `reconnect()`, which schedules
 * `setTimeout(connect, closedDate + delay - performance.now())`. Once the
 * connection has sat closed longer than `delay` (e.g. the dev box idled, or the
 * worker slept between nightly jobs), that value is negative and Node emits a
 * `TimeoutNegativeWarning` (benign — clamped to 1ms — but noisy). Keeping the
 * small pool warm avoids the idle-close→reconnect cycle entirely, and at
 * single-user scale holding a few connections open costs nothing.
 *
 * @returns A Drizzle instance bound to the schema.
 * @throws If `DATABASE_URL` is not set.
 */
function createDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const queryClient = postgres(databaseUrl, {
    max: 10,
    connect_timeout: 10,
  });
  return drizzle(queryClient, { schema });
}

export type Db = ReturnType<typeof createDb>;

// Lazily instantiate on first use. Connecting eagerly at module load breaks
// `next build`: its "Collecting page data" step imports every route module
// (including ones that import this client) while `DATABASE_URL` is legitimately
// unset inside the build container, which would throw before the app ever runs.
// Deferring means importing this module is side-effect-free; the connection —
// and the `DATABASE_URL` requirement — kicks in only on the first real query,
// which happens at request time when the env var is present.
let instance: Db | undefined;

function getDb(): Db {
  if (!instance) {
    instance = createDb();
  }
  return instance;
}

/**
 * Shared Drizzle database handle. Backed by a lazily-created connection pool;
 * the underlying postgres-js client is not opened until the first property
 * access (i.e. the first query). Use exactly like a normal Drizzle instance:
 * `db.select()...`, `db.query.table.findMany(...)`, etc.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
