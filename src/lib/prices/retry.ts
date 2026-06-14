/**
 * Rate-limit-aware retry for upstream price fetches.
 *
 * Yahoo Finance throttles bursts with HTTP 429; `yahoo-finance2` surfaces that
 * as a JSON-parse error on the plaintext `"Too Many Requests"` body. A short
 * exponential backoff clears the vast majority of these without failing the run.
 */

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Heuristic: is this error an upstream rate-limit (HTTP 429)?
 *
 * Matches both the literal `"Too Many Requests"` body (what yahoo-finance2's
 * JSON parse chokes on) and a bare `429`.
 *
 * @param err - The thrown error.
 * @returns Whether it looks like a 429 throttle.
 */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /too many requests|\b429\b/i.test(msg);
}

export interface RetryOptions {
  /** Total attempts (including the first). Default 3. */
  readonly attempts?: number;
  /** Base backoff in ms; delay before retry N is `baseDelayMs * 2**(N-1)`. Default 1000. */
  readonly baseDelayMs?: number;
  /** Injectable sleep (tests pass a no-op to stay fast). */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Run `fn`, retrying only on rate-limit (429) errors with exponential backoff
 * (default 3 attempts at ~1s/2s). Any non-429 error throws immediately, as does
 * the final attempt.
 *
 * @param fn - The operation to attempt.
 * @param opts - Retry tuning + sleep injection.
 * @returns The resolved value of `fn`.
 * @throws The last error if all attempts fail (or any non-429 error).
 */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const doSleep = opts.sleepFn ?? sleep;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || i === attempts - 1) throw err;
      await doSleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}
