import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not set");
}

/**
 * Shared Redis connection for BullMQ.
 *
 * Per the bullmq-specialist skill:
 *   - `maxRetriesPerRequest: null` is REQUIRED for BullMQ (default would break workers).
 *   - `enableReadyCheck: false` avoids a startup race when Redis is still warming up.
 *
 * One connection is shared across all queues + workers in a process.
 */
export const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
