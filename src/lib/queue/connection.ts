import IORedis, { type Redis } from "ioredis";

/**
 * Builds the shared Redis connection for BullMQ.
 *
 * Per the bullmq-specialist skill:
 *   - `maxRetriesPerRequest: null` is REQUIRED for BullMQ (default would break workers).
 *   - `enableReadyCheck: false` avoids a startup race when Redis is still warming up.
 *
 * @returns A configured IORedis client.
 * @throws If `REDIS_URL` is not set.
 */
function createRedis(): Redis {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is not set");
  }
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

// Lazily instantiate on first use. Connecting (or even reading `REDIS_URL`) at
// module load breaks `next build`: its "Collecting page data" step imports every
// route module — including the Plaid webhook route, which pulls in the BullMQ
// queues and therefore this connection — while `REDIS_URL` is legitimately unset
// inside the build container. Deferring makes importing this module
// side-effect-free; the socket opens on the first real property access (a query
// at request time, or worker startup), when the env var is present.
let instance: Redis | undefined;

function getRedis(): Redis {
  if (!instance) {
    instance = createRedis();
  }
  return instance;
}

/**
 * Shared Redis connection for BullMQ. One connection is shared across all queues
 * and workers in a process. Backed by a lazily-created IORedis client; the socket
 * is not opened until the first property access. BullMQ accepts this transparently
 * — it duck-types the connection via its `connect`/`disconnect`/`duplicate` methods,
 * which the proxy forwards.
 */
export const redisConnection: Redis = new Proxy({} as Redis, {
  get(_target, prop) {
    const real = getRedis();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
