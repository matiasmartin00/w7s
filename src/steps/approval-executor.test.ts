import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ApprovalExecutor, type ApprovalHandler } from "./approval-executor.js"
import type { ApprovalStep } from "../types/workflow.js"
import type { ExecutionContext } from "../types/execution.js"

/**
 * Builds a mock ExecutionContext with a working `get()` for interpolation.
 */
function mockContext(
  data: Record<string, unknown> = {},
): ExecutionContext {
  return {
    inputs: {},
    steps: {},
    workflow: { name: "test-workflow" },
    env: {},
    get(path: string): unknown {
      // Simple dot-path traversal over the flat data map
      return data[path]
    },
    set: vi.fn(),
  }
}

function approvalStep(overrides: Partial<ApprovalStep> = {}): ApprovalStep {
  return {
    id: "confirm",
    type: "approval",
    message: "Do you want to continue?",
    ...overrides,
  }
}

describe("ApprovalExecutor", () => {
  let handler: ReturnType<typeof vi.fn<ApprovalHandler>>

  beforeEach(() => {
    vi.useFakeTimers()
    handler = vi.fn<ApprovalHandler>()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns completed when user approves", async () => {
    handler.mockResolvedValue(true)
    const executor = new ApprovalExecutor(handler)
    const context = mockContext()
    const step = approvalStep()

    const result = await executor.execute(step, context)

    expect(result.stepId).toBe("confirm")
    expect(result.status).toBe("completed")
    expect(result.error).toBeUndefined()
    expect(result.attempts).toBe(1)
  })

  it("returns failed with cancellation error when user cancels", async () => {
    handler.mockResolvedValue(false)
    const executor = new ApprovalExecutor(handler)
    const context = mockContext()
    const step = approvalStep()

    const result = await executor.execute(step, context)

    expect(result.stepId).toBe("confirm")
    expect(result.status).toBe("failed")
    expect(result.error).toBe("cancelled by user at step: confirm")
    expect(result.attempts).toBe(1)
  })

  it("interpolates the message with context variables", async () => {
    handler.mockResolvedValue(true)
    const executor = new ApprovalExecutor(handler)
    const context = mockContext({
      "steps.explore.output": "found 3 legacy modules",
    })
    const step = approvalStep({
      message: "Continue? Found: ${{ steps.explore.output }}",
    })

    await executor.execute(step, context)

    // The handler should receive the interpolated message
    expect(handler).toHaveBeenCalledWith(
      "Continue? Found: found 3 legacy modules",
    )
  })

  it("handler receives the exact interpolated message", async () => {
    handler.mockResolvedValue(false)
    const executor = new ApprovalExecutor(handler)
    const context = mockContext({
      "inputs.feature": "auth",
      "workflow.name": "deploy",
    })
    const step = approvalStep({
      message:
        "Deploy ${{ inputs.feature }} for ${{ workflow.name }}?",
    })

    await executor.execute(step, context)

    expect(handler).toHaveBeenCalledWith("Deploy auth for deploy?")
  })

  it("tracks duration", async () => {
    // Handler takes 500ms to resolve
    handler.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(true), 500)
        }),
    )
    const executor = new ApprovalExecutor(handler)
    const context = mockContext()
    const step = approvalStep()

    const resultPromise = executor.execute(step, context)

    // Advance time by 500ms for the handler
    await vi.advanceTimersByTimeAsync(500)

    const result = await resultPromise

    expect(result.duration).toBeGreaterThanOrEqual(500)
    expect(result.status).toBe("completed")
  })

  it("always reports attempts as 1 (approval steps do not retry)", async () => {
    handler.mockResolvedValue(false)
    const executor = new ApprovalExecutor(handler)
    const context = mockContext()
    const step = approvalStep({ retry: 3 }) // retry field is ignored

    const result = await executor.execute(step, context)

    // Approval steps never retry — attempts is always 1
    expect(result.attempts).toBe(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("uses step.id in the result", async () => {
    handler.mockResolvedValue(true)
    const executor = new ApprovalExecutor(handler)
    const context = mockContext()
    const step = approvalStep({ id: "review-gate" })

    const result = await executor.execute(step, context)

    expect(result.stepId).toBe("review-gate")
  })

  it("interpolates unresolved variables to empty string", async () => {
    handler.mockResolvedValue(true)
    const executor = new ApprovalExecutor(handler)
    const context = mockContext() // no data
    const step = approvalStep({
      message: "Status: ${{ steps.unknown.output }}",
    })

    await executor.execute(step, context)

    expect(handler).toHaveBeenCalledWith("Status: ")
  })
})
