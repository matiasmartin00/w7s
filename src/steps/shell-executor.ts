/**
 * Shell step executor — runs commands via Bun shell (ctx.$).
 *
 * Behavior:
 * 1. Interpolate `step.run` using the expression engine
 * 2. Merge environment: process.env + step.env (interpolated)
 * 3. Execute via pluginCtx.$ with .nothrow().quiet()
 * 4. Capture stdout, stderr, exit code
 * 5. Exit code != 0 → step fails
 * 6. Wrap in withRetry() if step.retry is defined
 * 7. Store stdout as step output if step.output is defined
 *
 * Covers: REQ-STEP-SHELL-001, REQ-STEP-SHELL-002, REQ-STEP-SHELL-003
 */

import type { ShellStep, StepResult, ExecutionContext, PluginInput } from "../types/index.js"
import type { StepExecutor } from "../types/step-executor.js"
import { interpolate } from "../expression/interpolate.js"
import { withRetry } from "../utils/retry.js"

/** Bun shell type extracted from PluginInput["$"] */
type BunShell = PluginInput["$"]

export class ShellExecutor implements StepExecutor<ShellStep> {
  private readonly $: BunShell

  constructor($: BunShell) {
    this.$ = $
  }

  async execute(
    step: ShellStep,
    context: ExecutionContext,
  ): Promise<StepResult> {
    const startTime = Date.now()
    let attempts = 0

    const run = async (): Promise<StepResult> => {
      attempts++

      // 1. Interpolate the command string
      const command = interpolate(step.run, context)

      // 2. Build environment: merge process.env + step.env (interpolated)
      const env: Record<string, string> = {}
      if (step.env) {
        for (const [key, value] of Object.entries(step.env)) {
          env[key] = interpolate(value, context)
        }
      }

      // 3. Execute via Bun shell with nothrow + quiet
      //    Build a tagged template call with the interpolated command
      const strings = [command] as unknown as TemplateStringsArray
      Object.defineProperty(strings, "raw", { value: [command] })

      let shell = this.$.nothrow()
      if (Object.keys(env).length > 0) {
        shell = shell.env({ ...process.env, ...env } as Record<string, string | undefined>)
      }

      const result = await shell(strings).quiet()

      // 4. Capture stdout, stderr, exit code
      const stdout = result.stdout.toString().trimEnd()
      const stderr = result.stderr.toString().trimEnd()
      const exitCode = result.exitCode

      // 5. Exit code != 0 → fail (throw so retry can catch)
      if (exitCode !== 0) {
        const error = new Error(
          stderr || `Command exited with code ${exitCode}`,
        )
        ;(error as Error & { exitCode: number; stdout: string; stderr: string }).exitCode = exitCode
        ;(error as Error & { stdout: string }).stdout = stdout
        ;(error as Error & { stderr: string }).stderr = stderr
        throw error
      }

      return {
        stepId: step.id,
        status: "completed",
        output: stdout,
        exitCode,
        duration: Date.now() - startTime,
        attempts,
      }
    }

    try {
      // 6. Wrap in withRetry if step.retry is defined
      const maxRetries = step.retry ?? 0
      const result = await withRetry(run, { maxRetries })

      // 7. Store output in context if step.output is defined
      if (step.output !== undefined) {
        context.set(step.id, result)
      }

      return result
    } catch (error) {
      const err = error as Error & {
        exitCode?: number
        stdout?: string
        stderr?: string
      }

      const result: StepResult = {
        stepId: step.id,
        status: "failed",
        output: err.stdout ?? undefined,
        exitCode: err.exitCode ?? 1,
        error: err.stderr || err.message,
        duration: Date.now() - startTime,
        attempts,
      }

      return result
    }
  }
}
