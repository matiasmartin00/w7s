import { describe, it, expect, vi, beforeEach } from "vitest"
import { ExecutionEngine } from "./engine.js"
import { createExecutionContext, buildExpressionContext } from "./context.js"
import type {
  Workflow,
  Step,
  StepResult,
  ExecutionContext,
  AiPromptStep,
  ShellStep,
  ApprovalStep,
} from "../types/index.js"
import type { ShellExecutor } from "../steps/shell-executor.js"
import type { AiPromptExecutor } from "../steps/ai-prompt-executor.js"
import type { ApprovalExecutor } from "../steps/approval-executor.js"

// --- Mock executor factories ---

function mockShellExecutor(
  impl?: (step: ShellStep, ctx: ExecutionContext) => Promise<StepResult>,
): ShellExecutor {
  return {
    execute: vi.fn(
      impl ??
        (async (step: ShellStep) => ({
          stepId: step.id,
          status: "completed" as const,
          output: `shell-output-${step.id}`,
          exitCode: 0,
          duration: 10,
          attempts: 1,
        })),
    ),
  } as unknown as ShellExecutor
}

function mockAiPromptExecutor(
  impl?: (step: AiPromptStep, ctx: ExecutionContext) => Promise<StepResult>,
): AiPromptExecutor {
  return {
    execute: vi.fn(
      impl ??
        (async (step: AiPromptStep) => ({
          stepId: step.id,
          status: "completed" as const,
          output: `ai-output-${step.id}`,
          duration: 50,
          attempts: 1,
        })),
    ),
  } as unknown as AiPromptExecutor
}

function mockApprovalExecutor(
  impl?: (step: ApprovalStep, ctx: ExecutionContext) => Promise<StepResult>,
): ApprovalExecutor {
  return {
    execute: vi.fn(
      impl ??
        (async (step: ApprovalStep) => ({
          stepId: step.id,
          status: "completed" as const,
          duration: 5,
          attempts: 1,
        })),
    ),
  } as unknown as ApprovalExecutor
}

// --- Helper to build a workflow ---

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: "test-workflow",
    trigger: { commands: ["/test"] },
    steps: [],
    ...overrides,
  }
}

// --- Tests ---

describe("ExecutionEngine", () => {
  let shellExec: ShellExecutor
  let aiExec: AiPromptExecutor
  let approvalExec: ApprovalExecutor
  let engine: ExecutionEngine

  beforeEach(() => {
    shellExec = mockShellExecutor()
    aiExec = mockAiPromptExecutor()
    approvalExec = mockApprovalExecutor()
    engine = new ExecutionEngine(shellExec, aiExec, approvalExec)
  })

  it("happy path: 3-step workflow (shell → ai_prompt → shell) → status: completed", async () => {
    const workflow = makeWorkflow({
      steps: [
        { id: "s1", type: "shell", run: "echo hello" } as ShellStep,
        { id: "s2", type: "ai_prompt", prompt: "analyze" } as AiPromptStep,
        { id: "s3", type: "shell", run: "echo done" } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("completed")
    expect(result.workflow).toBe("test-workflow")
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0].stepId).toBe("s1")
    expect(result.steps[1].stepId).toBe("s2")
    expect(result.steps[2].stepId).toBe("s3")

    // Verify executors called in order
    expect(shellExec.execute).toHaveBeenCalledTimes(2)
    expect(aiExec.execute).toHaveBeenCalledTimes(1)
  })

  it("when condition true → step executes", async () => {
    shellExec = mockShellExecutor(async (step) => ({
      stepId: step.id,
      status: "completed",
      output: "result",
      exitCode: 0,
      duration: 10,
      attempts: 1,
    }))
    engine = new ExecutionEngine(shellExec, aiExec, approvalExec)

    const workflow = makeWorkflow({
      steps: [
        {
          id: "s1",
          type: "shell",
          run: "echo true",
          when: "true",
        } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("completed")
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].status).toBe("completed")
    expect(shellExec.execute).toHaveBeenCalledTimes(1)
  })

  it("when condition false → step skipped", async () => {
    const workflow = makeWorkflow({
      steps: [
        {
          id: "s1",
          type: "shell",
          run: "echo should-not-run",
          when: "false",
        } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("completed")
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].status).toBe("skipped")
    expect(result.steps[0].stepId).toBe("s1")
    expect(shellExec.execute).not.toHaveBeenCalled()
  })

  it("step failure stops workflow → subsequent steps not executed", async () => {
    const callOrder: string[] = []

    shellExec = mockShellExecutor(async (step) => {
      callOrder.push(step.id)
      if (step.id === "s2") {
        return {
          stepId: step.id,
          status: "failed",
          error: "command failed",
          exitCode: 1,
          duration: 10,
          attempts: 1,
        }
      }
      return {
        stepId: step.id,
        status: "completed",
        output: `output-${step.id}`,
        exitCode: 0,
        duration: 10,
        attempts: 1,
      }
    })
    engine = new ExecutionEngine(shellExec, aiExec, approvalExec)

    const workflow = makeWorkflow({
      steps: [
        { id: "s1", type: "shell", run: "echo one" } as ShellStep,
        { id: "s2", type: "shell", run: "exit 1" } as ShellStep,
        { id: "s3", type: "shell", run: "echo three" } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("failed")
    expect(result.failedStep).toBe("s2")
    expect(result.error).toBe("command failed")
    expect(result.steps).toHaveLength(2) // s1 completed, s2 failed, s3 not run
    expect(result.steps[0].status).toBe("completed")
    expect(result.steps[1].status).toBe("failed")
    expect(callOrder).toEqual(["s1", "s2"]) // s3 was never called
  })

  it("approval cancellation → workflow status: cancelled", async () => {
    approvalExec = mockApprovalExecutor(async (step) => ({
      stepId: step.id,
      status: "failed",
      error: `cancelled by user at step: ${step.id}`,
      duration: 5,
      attempts: 1,
    }))
    engine = new ExecutionEngine(shellExec, aiExec, approvalExec)

    const workflow = makeWorkflow({
      steps: [
        { id: "s1", type: "shell", run: "echo prep" } as ShellStep,
        { id: "approve", type: "approval", message: "Continue?" } as ApprovalStep,
        { id: "s3", type: "shell", run: "echo deploy" } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("cancelled")
    expect(result.failedStep).toBe("approve")
    expect(result.error).toContain("cancelled by user")
    expect(result.steps).toHaveLength(2) // s1 + approve, s3 not run
  })

  it("input defaults applied when not provided", async () => {
    const workflow = makeWorkflow({
      inputs: {
        feature: { required: true },
        scope: { default: "full" },
      },
      steps: [
        { id: "s1", type: "shell", run: "echo hello" } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, { feature: "auth" })

    expect(result.status).toBe("completed")
    expect(result.inputs.feature).toBe("auth")
    expect(result.inputs.scope).toBe("full")
  })

  it("required input missing → error before execution starts", async () => {
    const workflow = makeWorkflow({
      inputs: {
        feature: { required: true },
      },
      steps: [
        { id: "s1", type: "shell", run: "echo hello" } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("failed")
    expect(result.error).toBe("Missing required input: feature")
    expect(result.steps).toHaveLength(0) // No steps executed
    expect(shellExec.execute).not.toHaveBeenCalled()
  })

  it("step output accessible by next step via context", async () => {
    let capturedContext: ExecutionContext | null = null

    shellExec = mockShellExecutor(async (step, ctx) => {
      if (step.id === "s2") {
        capturedContext = ctx
      }
      return {
        stepId: step.id,
        status: "completed",
        output: step.id === "s1" ? "step-one-output" : "step-two-output",
        exitCode: 0,
        duration: 10,
        attempts: 1,
      }
    })
    engine = new ExecutionEngine(shellExec, aiExec, approvalExec)

    const workflow = makeWorkflow({
      steps: [
        { id: "s1", type: "shell", run: "echo one", output: "result" } as ShellStep,
        { id: "s2", type: "shell", run: "echo two" } as ShellStep,
      ],
    })

    await engine.execute(workflow, {})

    // After s1 completes, s2 should have access to s1's output in context
    expect(capturedContext).not.toBeNull()
    expect(capturedContext!.steps.s1).toBeDefined()
    expect(capturedContext!.steps.s1.output).toBe("step-one-output")
    expect(capturedContext!.get("steps.s1.output")).toBe("step-one-output")
  })

  it("multiple when conditions: mix of skipped and executed steps", async () => {
    // First step produces output, second step's when evaluates against it
    shellExec = mockShellExecutor(async (step) => ({
      stepId: step.id,
      status: "completed",
      output: "value",
      exitCode: 0,
      duration: 10,
      attempts: 1,
    }))
    engine = new ExecutionEngine(shellExec, aiExec, approvalExec)

    const workflow = makeWorkflow({
      steps: [
        { id: "s1", type: "shell", run: "echo one", when: "true" } as ShellStep,
        { id: "s2", type: "shell", run: "echo two", when: "false" } as ShellStep,
        { id: "s3", type: "shell", run: "echo three", when: "true" } as ShellStep,
        { id: "s4", type: "shell", run: "echo four", when: "false" } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("completed")
    expect(result.steps).toHaveLength(4)
    expect(result.steps[0].status).toBe("completed") // s1 when: true
    expect(result.steps[1].status).toBe("skipped")   // s2 when: false
    expect(result.steps[2].status).toBe("completed") // s3 when: true
    expect(result.steps[3].status).toBe("skipped")   // s4 when: false
    expect(shellExec.execute).toHaveBeenCalledTimes(2) // only s1 and s3
  })

  it("all steps skipped (every when is false) → completed", async () => {
    const workflow = makeWorkflow({
      steps: [
        { id: "s1", type: "shell", run: "echo one", when: "false" } as ShellStep,
        { id: "s2", type: "shell", run: "echo two", when: "false" } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("completed")
    expect(result.steps).toHaveLength(2)
    expect(result.steps.every((s) => s.status === "skipped")).toBe(true)
    expect(shellExec.execute).not.toHaveBeenCalled()
  })

  it("duration tracking: total and per-step", async () => {
    const workflow = makeWorkflow({
      steps: [
        { id: "s1", type: "shell", run: "echo hello" } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(typeof result.duration).toBe("number")
    expect(result.duration).toBeGreaterThanOrEqual(0)
    expect(result.startedAt).toBeTruthy()
    expect(result.completedAt).toBeTruthy()

    // Per-step duration
    expect(result.steps[0].duration).toBeGreaterThanOrEqual(0)
    expect(typeof result.steps[0].duration).toBe("number")
  })

  it("empty workflow (no steps) → completed immediately", async () => {
    const workflow = makeWorkflow({ steps: [] })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("completed")
    expect(result.steps).toHaveLength(0)
    expect(shellExec.execute).not.toHaveBeenCalled()
    expect(aiExec.execute).not.toHaveBeenCalled()
    expect(approvalExec.execute).not.toHaveBeenCalled()
  })

  it("when condition with dynamic expression: steps.X.output == value", async () => {
    // s1 sets output, s2's when checks s1's output
    shellExec = mockShellExecutor(async (step) => ({
      stepId: step.id,
      status: "completed",
      output: step.id === "s1" ? "go" : "executed",
      exitCode: 0,
      duration: 10,
      attempts: 1,
    }))
    engine = new ExecutionEngine(shellExec, aiExec, approvalExec)

    const workflow = makeWorkflow({
      steps: [
        { id: "s1", type: "shell", run: "echo go" } as ShellStep,
        {
          id: "s2",
          type: "shell",
          run: "echo conditional",
          when: 'steps.s1.output == "go"',
        } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("completed")
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].status).toBe("completed")
    expect(result.steps[1].status).toBe("completed")
    expect(shellExec.execute).toHaveBeenCalledTimes(2)
  })

  it("when condition with dynamic expression: evaluates to false → skip", async () => {
    shellExec = mockShellExecutor(async (step) => ({
      stepId: step.id,
      status: "completed",
      output: step.id === "s1" ? "no-go" : "should-not-run",
      exitCode: 0,
      duration: 10,
      attempts: 1,
    }))
    engine = new ExecutionEngine(shellExec, aiExec, approvalExec)

    const workflow = makeWorkflow({
      steps: [
        { id: "s1", type: "shell", run: "echo no-go" } as ShellStep,
        {
          id: "s2",
          type: "shell",
          run: "echo skip-me",
          when: 'steps.s1.output == "go"',
        } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("completed")
    expect(result.steps[1].status).toBe("skipped")
    expect(shellExec.execute).toHaveBeenCalledTimes(1) // only s1
  })

  it("input with required: false and no default is not an error when missing", async () => {
    const workflow = makeWorkflow({
      inputs: {
        optional_thing: { required: false },
      },
      steps: [
        { id: "s1", type: "shell", run: "echo ok" } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("completed")
  })

  it("step results preserved after failure (completed steps not reverted)", async () => {
    shellExec = mockShellExecutor(async (step) => {
      if (step.id === "s2") {
        return {
          stepId: step.id,
          status: "failed",
          error: "boom",
          exitCode: 1,
          duration: 10,
          attempts: 1,
        }
      }
      return {
        stepId: step.id,
        status: "completed",
        output: `output-${step.id}`,
        exitCode: 0,
        duration: 10,
        attempts: 1,
      }
    })
    engine = new ExecutionEngine(shellExec, aiExec, approvalExec)

    const workflow = makeWorkflow({
      steps: [
        { id: "s1", type: "shell", run: "echo one" } as ShellStep,
        { id: "s2", type: "shell", run: "exit 1" } as ShellStep,
        { id: "s3", type: "shell", run: "echo three" } as ShellStep,
      ],
    })

    const result = await engine.execute(workflow, {})

    expect(result.status).toBe("failed")
    // s1's result is preserved
    expect(result.steps[0].status).toBe("completed")
    expect(result.steps[0].output).toBe("output-s1")
    // s2 is recorded as failed
    expect(result.steps[1].status).toBe("failed")
  })
})

describe("createExecutionContext", () => {
  it("creates context with correct structure", () => {
    const workflow: Workflow = {
      name: "my-wf",
      trigger: { commands: ["/test"] },
      steps: [],
    }

    const context = createExecutionContext(workflow, { key: "val" })

    expect(context.inputs).toEqual({ key: "val" })
    expect(context.steps).toEqual({})
    expect(context.workflow.name).toBe("my-wf")
    expect(typeof context.env).toBe("object")
    expect(typeof context.get).toBe("function")
    expect(typeof context.set).toBe("function")
  })

  it("applies input defaults", () => {
    const workflow: Workflow = {
      name: "wf",
      trigger: { commands: ["/test"] },
      inputs: {
        feature: { required: true },
        scope: { default: "full" },
        mode: { default: "fast" },
      },
      steps: [],
    }

    const context = createExecutionContext(workflow, { feature: "auth", mode: "slow" })

    expect(context.inputs.feature).toBe("auth")
    expect(context.inputs.scope).toBe("full") // default applied
    expect(context.inputs.mode).toBe("slow") // provided overrides default
  })

  it("get() resolves input namespace", () => {
    const workflow: Workflow = {
      name: "wf",
      trigger: { commands: ["/test"] },
      steps: [],
    }

    const context = createExecutionContext(workflow, { feature: "auth" })

    expect(context.get("inputs.feature")).toBe("auth")
    expect(context.get("inputs.missing")).toBeUndefined()
  })

  it("get() resolves workflow namespace", () => {
    const workflow: Workflow = {
      name: "my-workflow",
      trigger: { commands: ["/test"] },
      steps: [],
    }

    const context = createExecutionContext(workflow, {})

    expect(context.get("workflow.name")).toBe("my-workflow")
  })

  it("get() resolves env namespace", () => {
    const workflow: Workflow = {
      name: "wf",
      trigger: { commands: ["/test"] },
      steps: [],
    }

    const context = createExecutionContext(workflow, {})

    // process.env.PATH should exist on any system
    expect(context.get("env.PATH")).toBe(process.env.PATH)
  })

  it("set() and get() for step outputs", () => {
    const workflow: Workflow = {
      name: "wf",
      trigger: { commands: ["/test"] },
      steps: [],
    }

    const context = createExecutionContext(workflow, {})

    context.set("init", {
      stepId: "init",
      status: "completed",
      output: "hello world",
      exitCode: 0,
      duration: 10,
      attempts: 1,
    })

    expect(context.get("steps.init.output")).toBe("hello world")
    expect(context.get("steps.init.exit_code")).toBe(0)
    expect(context.steps.init).toEqual({
      output: "hello world",
      exit_code: 0,
    })
  })

  it("set() and get() for nested JSON output", () => {
    const workflow: Workflow = {
      name: "wf",
      trigger: { commands: ["/test"] },
      steps: [],
    }

    const context = createExecutionContext(workflow, {})

    context.set("explore", {
      stepId: "explore",
      status: "completed",
      output: { has_legacy: true, summary: "found 3 modules" },
      duration: 50,
      attempts: 1,
    })

    expect(context.get("steps.explore.output.has_legacy")).toBe(true)
    expect(context.get("steps.explore.output.summary")).toBe("found 3 modules")
  })
})

describe("buildExpressionContext", () => {
  it("wraps ExecutionContext get() for expression engine", () => {
    const workflow: Workflow = {
      name: "wf",
      trigger: { commands: ["/test"] },
      steps: [],
    }

    const execCtx = createExecutionContext(workflow, { feature: "auth" })
    const exprCtx = buildExpressionContext(execCtx)

    expect(exprCtx.get("inputs.feature")).toBe("auth")
    expect(exprCtx.get("workflow.name")).toBe("wf")
  })
})
