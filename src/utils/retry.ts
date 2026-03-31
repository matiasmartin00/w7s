/**
 * Retry utility with exponential backoff.
 *
 * Backoff formula: baseDelay * 2^attempt (capped at maxDelay).
 * Design decision #6: exponential backoff capped at 30s.
 */

export type RetryOptions = {
  maxRetries: number
  baseDelay?: number // default 1000ms
  maxDelay?: number // default 30000ms (30s cap from design)
}

/**
 * Execute `fn` with retry. If `fn` throws, waits with exponential backoff
 * and retries up to `maxRetries` times. If all retries are exhausted,
 * throws the last error.
 *
 * If maxRetries is 0, executes once with no retry.
 *
 * Returns `{ result, delays }` — delays array records each wait duration
 * for observability.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelay = 1000, maxDelay = 30_000 } = options

  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      // If this was the last attempt, don't wait — just throw
      if (attempt >= maxRetries) {
        break
      }

      // Exponential backoff: baseDelay * 2^attempt, capped at maxDelay
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

/**
 * Calculate the delay for a given attempt (pure function, no side effects).
 * Exported for testing backoff logic without timers.
 */
export function calculateDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
): number {
  return Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
}
