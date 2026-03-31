import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { withRetry, calculateDelay } from "./retry.js"

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns result on first try — no retry needed", async () => {
    const fn = vi.fn().mockResolvedValue("success")

    const result = await withRetry(fn, { maxRetries: 3 })

    expect(result).toBe("success")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries on failure and returns on success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockResolvedValue("ok")

    const promise = withRetry(fn, { maxRetries: 3, baseDelay: 100 })

    // Advance past the first retry delay (100ms for attempt 0)
    await vi.advanceTimersByTimeAsync(100)

    const result = await promise
    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("throws last error when all retries are exhausted", async () => {
    vi.useRealTimers()

    let callCount = 0
    const fn = vi.fn().mockImplementation(async () => {
      callCount++
      throw new Error(`fail ${callCount}`)
    })

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelay: 1 }),
    ).rejects.toThrow("fail 3")
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it("maxRetries: 0 executes once with no retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("no retry"))

    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow("no retry")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("backoff timing: delays increase exponentially", async () => {
    let callCount = 0
    const callTimestamps: number[] = []

    const fn = vi.fn().mockImplementation(() => {
      callTimestamps.push(Date.now())
      callCount++
      if (callCount <= 3) {
        return Promise.reject(new Error(`fail ${callCount}`))
      }
      return Promise.resolve("done")
    })

    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelay: 1000,
    })

    // Attempt 0 (immediate) fails → delay 1000ms
    await vi.advanceTimersByTimeAsync(1000)
    // Attempt 1 fails → delay 2000ms
    await vi.advanceTimersByTimeAsync(2000)
    // Attempt 2 fails → delay 4000ms
    await vi.advanceTimersByTimeAsync(4000)
    // Attempt 3 succeeds

    const result = await promise
    expect(result).toBe("done")
    expect(fn).toHaveBeenCalledTimes(4)

    // Verify delays between calls
    const delays = []
    for (let i = 1; i < callTimestamps.length; i++) {
      delays.push(callTimestamps[i] - callTimestamps[i - 1])
    }
    expect(delays).toEqual([1000, 2000, 4000])
  })

  it("cap at maxDelay: verify delay does not exceed 30s", async () => {
    let callCount = 0
    const callTimestamps: number[] = []

    const fn = vi.fn().mockImplementation(() => {
      callTimestamps.push(Date.now())
      callCount++
      if (callCount <= 3) {
        return Promise.reject(new Error(`fail ${callCount}`))
      }
      return Promise.resolve("done")
    })

    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelay: 10_000,
      maxDelay: 30_000,
    })

    // Attempt 0 fails → delay min(10000, 30000) = 10000ms
    await vi.advanceTimersByTimeAsync(10_000)
    // Attempt 1 fails → delay min(20000, 30000) = 20000ms
    await vi.advanceTimersByTimeAsync(20_000)
    // Attempt 2 fails → delay min(40000, 30000) = 30000ms (CAPPED)
    await vi.advanceTimersByTimeAsync(30_000)
    // Attempt 3 succeeds

    const result = await promise
    expect(result).toBe("done")
    expect(fn).toHaveBeenCalledTimes(4)

    // Verify delays
    const delays = []
    for (let i = 1; i < callTimestamps.length; i++) {
      delays.push(callTimestamps[i] - callTimestamps[i - 1])
    }
    expect(delays).toEqual([10_000, 20_000, 30_000]) // last is capped at 30s
  })

  it("preserves the error type from the function", async () => {
    class CustomError extends Error {
      code = "CUSTOM"
    }
    const fn = vi.fn().mockRejectedValue(new CustomError("custom"))

    try {
      await withRetry(fn, { maxRetries: 0 })
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(CustomError)
      expect((e as CustomError).code).toBe("CUSTOM")
    }
  })

  it("uses default baseDelay of 1000ms and maxDelay of 30000ms", async () => {
    let callCount = 0
    const callTimestamps: number[] = []

    const fn = vi.fn().mockImplementation(() => {
      callTimestamps.push(Date.now())
      callCount++
      if (callCount <= 1) {
        return Promise.reject(new Error(`fail`))
      }
      return Promise.resolve("ok")
    })

    const promise = withRetry(fn, { maxRetries: 1 })

    // Default baseDelay is 1000ms
    await vi.advanceTimersByTimeAsync(1000)

    const result = await promise
    expect(result).toBe("ok")

    const delay = callTimestamps[1] - callTimestamps[0]
    expect(delay).toBe(1000)
  })
})

describe("calculateDelay", () => {
  it("returns baseDelay for attempt 0", () => {
    expect(calculateDelay(0, 1000, 30_000)).toBe(1000)
  })

  it("doubles for each attempt", () => {
    expect(calculateDelay(0, 1000, 30_000)).toBe(1000)
    expect(calculateDelay(1, 1000, 30_000)).toBe(2000)
    expect(calculateDelay(2, 1000, 30_000)).toBe(4000)
    expect(calculateDelay(3, 1000, 30_000)).toBe(8000)
    expect(calculateDelay(4, 1000, 30_000)).toBe(16_000)
  })

  it("caps at maxDelay", () => {
    expect(calculateDelay(5, 1000, 30_000)).toBe(30_000) // 32000 capped to 30000
    expect(calculateDelay(10, 1000, 30_000)).toBe(30_000)
  })

  it("works with custom baseDelay", () => {
    expect(calculateDelay(0, 500, 5000)).toBe(500)
    expect(calculateDelay(1, 500, 5000)).toBe(1000)
    expect(calculateDelay(2, 500, 5000)).toBe(2000)
    expect(calculateDelay(3, 500, 5000)).toBe(4000)
    expect(calculateDelay(4, 500, 5000)).toBe(5000) // capped
  })
})
