import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ShellExecutor } from "./shell-executor.js"
import type { ShellStep, ExecutionContext } from "../types/index.js"

// --- Mock BunShell factory ---

type MockShellResult = {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

function createMockShell(results: MockShellResult | MockShellResult[]) {
  const resultQueue = Array.isArray(results) ? [...results] : [results]
  let callIndex = 0

  const quietFn = vi.fn()
  const envRecords: Array<Record<string, string | undefined>> = []

  // The shell promise with .quiet() and .env() and .nothrow()
  const makeShellPromise = () => {
    const result = resultQueue[Math.min(callIndex++, resultQueue.length - 1)]
    const promise = Promise.resolve(result)
    const shellPromise = Object.assign(promise, {
      quiet: vi.fn().mockReturnValue(promise),
      env: vi.fn().mockReturnThis(),
      nothrow: vi.fn().mockReturnThis(),
    })
    quietFn.mockReturnValue(promise)
    return shellPromise
  }

  // The shell function (tagged template callable)
  const shellCalls: string[] = []

  const shellFn = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
    shellCalls.push(strings[0])
    return makeShellPromise()
  })

  // nothrow() returns a new shell-like object
  const nothrowShell = Object.assign(
    vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      shellCalls.push(strings[0])
      return makeShellPromise()
    }),
    {
      nothrow: vi.fn(),
      env: vi.fn().mockImplementation((envObj: Record<string, string | undefined>) => {
        envRecords.push(envObj)
        return nothrowShell
      }),
    },
  )
  nothrowShell.nothrow.mockReturnValue(nothrowShell)

  // The top-level $ mock
  const $mock = Object.assign(shellFn, {
    nothrow: vi.fn().mockReturnValue(nothrowShell),
    env: vi.fn().mockReturnThis(),
    cwd: vi.fn().mockReturnThis(),
    braces: vi.fn(),
    escape: vi.fn(),
    throws: vi.fn().mockReturnThis(),
  })

  return { $: $mock, shellCalls, envRecords, nothrowShell }
}

// --- Mock ExecutionContext factory ---

function createMockContext(
  overrides: Partial<{
    inputs: Record<string, string>
    steps: Record<string, { output: unknown; exit_code?: number }>
    env: Record<string, string>
    workflowName: string
  }> = {},
): ExecutionContext {
  const inputs = overrides.inputs ?? {}
  const steps = overrides.steps ?? {}
  const env = overrides.env ?? {}
  const workflowName = overrides.workflowName ?? "test-workflow"

  return {
    inputs,
    steps,
    workflow: { name: workflowName },
    env,
    get(path: string): unknown {
      const parts = path.split(".")
      let current: unknown

      if (parts[0] === "inputs") {
        current = inputs[parts[1]]
      } else if (parts[0] === "steps") {
        const stepData = steps[parts[1]] as Record<string, unknown> | undefined
        current = stepData
        for (let i = 2; i < parts.length && current != null; i++) {
          current = (current as Record<string, unknown>)[parts[i]]
        }
      } else if (parts[0] === "env") {
        current = env[parts[1]]
      } else if (parts[0] === "workflow") {
        if (parts[1] === "name") current = workflowName
      }

      return current
    },
    set: vi.fn(),
  }
}

// --- Tests ---

describe("ShellExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("successful command → status: completed, captures stdout", async () => {
    vi.useRealTimers()

    const { $ } = createMockShell({
      stdout: Buffer.from("hello world\n"),
      stderr: Buffer.from(""),
      exitCode: 0,
    })

    const executor = new ShellExecutor($ as any)
    const context = createMockContext()

    const step: ShellStep = {
      id: "greet",
      type: "shell",
      run: "echo hello world",
    }

    const result = await executor.execute(step, context)

    expect(result.status).toBe("completed")
    expect(result.output).toBe("hello world")
    expect(result.exitCode).toBe(0)
    expect(result.stepId).toBe("greet")
    expect(result.attempts).toBe(1)
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })

  it("failed command (exit code 1) → status: failed, captures stderr", async () => {
    vi.useRealTimers()

    const { $ } = createMockShell({
      stdout: Buffer.from(""),
      stderr: Buffer.from("command not found\n"),
      exitCode: 1,
    })

    const executor = new ShellExecutor($ as any)
    const context = createMockContext()

    const step: ShellStep = {
      id: "fail-step",
      type: "shell",
      run: "nonexistent-command",
    }

    const result = await executor.execute(step, context)

    expect(result.status).toBe("failed")
    expect(result.exitCode).toBe(1)
    expect(result.error).toBe("command not found")
    expect(result.stepId).toBe("fail-step")
    expect(result.attempts).toBe(1)
  })

  it("retry on failure: fails twice, succeeds third → status: completed", async () => {
    const results: MockShellResult[] = [
      { stdout: Buffer.from(""), stderr: Buffer.from("err1\n"), exitCode: 1 },
      { stdout: Buffer.from(""), stderr: Buffer.from("err2\n"), exitCode: 1 },
      { stdout: Buffer.from("success\n"), stderr: Buffer.from(""), exitCode: 0 },
    ]
    const { $ } = createMockShell(results)

    const executor = new ShellExecutor($ as any)
    const context = createMockContext()

    const step: ShellStep = {
      id: "retry-step",
      type: "shell",
      run: "flaky-command",
      retry: 2,
    }

    const promise = executor.execute(step, context)

    // First attempt fails → delay 1000ms (attempt 0)
    await vi.advanceTimersByTimeAsync(1000)
    // Second attempt fails → delay 2000ms (attempt 1)
    await vi.advanceTimersByTimeAsync(2000)
    // Third attempt succeeds

    const result = await promise

    expect(result.status).toBe("completed")
    expect(result.output).toBe("success")
    expect(result.attempts).toBe(3)
  })

  it("retry exhausted → status: failed with last error", async () => {
    vi.useRealTimers()

    const results: MockShellResult[] = [
      { stdout: Buffer.from(""), stderr: Buffer.from("fail 1\n"), exitCode: 1 },
      { stdout: Buffer.from(""), stderr: Buffer.from("fail 2\n"), exitCode: 1 },
      { stdout: Buffer.from(""), stderr: Buffer.from("fail 3\n"), exitCode: 1 },
    ]
    const { $ } = createMockShell(results)

    const executor = new ShellExecutor($ as any)
    const context = createMockContext()

    const step: ShellStep = {
      id: "exhaust-step",
      type: "shell",
      run: "always-fail",
      retry: 2,
    }

    const result = await executor.execute(step, context)

    expect(result.status).toBe("failed")
    expect(result.error).toBe("fail 3")
    expect(result.attempts).toBe(3) // 1 initial + 2 retries
  })

  it("environment variables merged correctly", async () => {
    vi.useRealTimers()

    const { $, nothrowShell } = createMockShell({
      stdout: Buffer.from("test-output\n"),
      stderr: Buffer.from(""),
      exitCode: 0,
    })

    const executor = new ShellExecutor($ as any)
    const context = createMockContext()

    const step: ShellStep = {
      id: "env-step",
      type: "shell",
      run: "echo $NODE_ENV",
      env: { NODE_ENV: "test", DEBUG: "true" },
    }

    await executor.execute(step, context)

    // Verify env was called with merged environment
    expect(nothrowShell.env).toHaveBeenCalled()
    const envArg = nothrowShell.env.mock.calls[0][0] as Record<string, string | undefined>
    expect(envArg.NODE_ENV).toBe("test")
    expect(envArg.DEBUG).toBe("true")
  })

  it("expression interpolation in run command", async () => {
    vi.useRealTimers()

    const { $, shellCalls } = createMockShell({
      stdout: Buffer.from("done\n"),
      stderr: Buffer.from(""),
      exitCode: 0,
    })

    const executor = new ShellExecutor($ as any)
    const context = createMockContext({
      inputs: { feature: "auth" },
    })

    const step: ShellStep = {
      id: "interp-step",
      type: "shell",
      run: "echo Building ${{ inputs.feature }}",
    }

    // Need to use the nothrowShell to track calls
    const { nothrowShell } = createMockShell({
      stdout: Buffer.from("done\n"),
      stderr: Buffer.from(""),
      exitCode: 0,
    })

    // We verify interpolation happened by checking the command string
    await executor.execute(step, context)

    // The mock tracks the command strings passed to it
    // Since our mock captures strings in shellCalls via nothrowShell
    // But our executor calls nothrow() first, then the returned shell
    // Let's verify the nothrow shell was called with interpolated command
    const nothrowReturn = $.nothrow.mock.results[0].value
    const callArgs = nothrowReturn.mock.calls[0][0] as TemplateStringsArray
    expect(callArgs[0]).toBe("echo Building auth")
  })

  it("duration is tracked", async () => {
    const { $ } = createMockShell({
      stdout: Buffer.from("ok\n"),
      stderr: Buffer.from(""),
      exitCode: 0,
    })

    const executor = new ShellExecutor($ as any)
    const context = createMockContext()

    const step: ShellStep = {
      id: "duration-step",
      type: "shell",
      run: "sleep 1",
    }

    // Advance time to simulate duration
    const promise = executor.execute(step, context)
    vi.advanceTimersByTime(500)
    const result = await promise

    expect(result.duration).toBeGreaterThanOrEqual(0)
    expect(typeof result.duration).toBe("number")
  })

  it("output stored when step.output defined", async () => {
    vi.useRealTimers()

    const { $ } = createMockShell({
      stdout: Buffer.from("output-value\n"),
      stderr: Buffer.from(""),
      exitCode: 0,
    })

    const executor = new ShellExecutor($ as any)
    const context = createMockContext()

    const step: ShellStep = {
      id: "output-step",
      type: "shell",
      run: "echo output-value",
      output: "result",
    }

    await executor.execute(step, context)

    // context.set should have been called
    expect(context.set).toHaveBeenCalledWith(
      "output-step",
      expect.objectContaining({
        stepId: "output-step",
        status: "completed",
        output: "output-value",
      }),
    )
  })

  it("no output stored when step.output not defined", async () => {
    vi.useRealTimers()

    const { $ } = createMockShell({
      stdout: Buffer.from("some-output\n"),
      stderr: Buffer.from(""),
      exitCode: 0,
    })

    const executor = new ShellExecutor($ as any)
    const context = createMockContext()

    const step: ShellStep = {
      id: "no-output-step",
      type: "shell",
      run: "echo some-output",
      // No output field
    }

    await executor.execute(step, context)

    // context.set should NOT have been called
    expect(context.set).not.toHaveBeenCalled()
  })

  it("env values are interpolated with expressions", async () => {
    vi.useRealTimers()

    const { $, nothrowShell } = createMockShell({
      stdout: Buffer.from("ok\n"),
      stderr: Buffer.from(""),
      exitCode: 0,
    })

    const executor = new ShellExecutor($ as any)
    const context = createMockContext({
      inputs: { env_name: "production" },
    })

    const step: ShellStep = {
      id: "env-interp-step",
      type: "shell",
      run: "deploy",
      env: { NODE_ENV: "${{ inputs.env_name }}" },
    }

    await executor.execute(step, context)

    expect(nothrowShell.env).toHaveBeenCalled()
    const envArg = nothrowShell.env.mock.calls[0][0] as Record<string, string | undefined>
    expect(envArg.NODE_ENV).toBe("production")
  })

  it("failed command with no stderr uses exit code message", async () => {
    vi.useRealTimers()

    const { $ } = createMockShell({
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      exitCode: 127,
    })

    const executor = new ShellExecutor($ as any)
    const context = createMockContext()

    const step: ShellStep = {
      id: "no-stderr-step",
      type: "shell",
      run: "missing-command",
    }

    const result = await executor.execute(step, context)

    expect(result.status).toBe("failed")
    expect(result.exitCode).toBe(127)
    expect(result.error).toBe("Command exited with code 127")
  })
})
