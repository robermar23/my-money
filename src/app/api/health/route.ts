import { db } from "@/db/client.ts";
import { redisConnection } from "@/lib/queue/connection.ts";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * P6-22 — Liveness/readiness probe for the container healthcheck.
 *
 * `GET /api/health` confirms the two hard dependencies are reachable:
 *   - Postgres (`SELECT 1`)
 *   - Redis (`PING`)
 *
 * Returns `200 {status:'ok'}` when both answer, `503 {status:'error'}` when
 * either is down or slow. Per the P6-01 threat model this endpoint is
 * unauthenticated (the orchestrator hits it with no session) and therefore
 * MUST leak nothing useful to an attacker: no version, no hostname, no
 * dependency error text, no which-check-failed detail. The body is a single
 * static status word; the granular reason goes only to the server log.
 *
 * Node runtime (postgres.js + ioredis need it); never cached.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upper bound on a single dependency probe. A wedged Postgres/Redis must not
 * hang the healthcheck — we'd rather report 503 fast and let the orchestrator
 * restart us. Kept well under the compose healthcheck `timeout`.
 */
const PROBE_TIMEOUT_MS = 2_000;

/** Reject if `promise` doesn't settle within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} probe timed out`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Health probe.
 *
 * @returns 200 with `{status:'ok'}` when Postgres and Redis both respond;
 *   503 with `{status:'error'}` otherwise. The response intentionally carries
 *   no internal detail.
 */
export async function GET(): Promise<NextResponse> {
  try {
    await Promise.all([
      withTimeout(db.execute(sql`select 1`), PROBE_TIMEOUT_MS, "postgres"),
      withTimeout(redisConnection.ping(), PROBE_TIMEOUT_MS, "redis"),
    ]);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch (err) {
    // Log the real reason server-side only; never put it in the response.
    console.error("[health] dependency check failed:", err);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
