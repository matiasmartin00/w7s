/**
 * Execution context builder — creates and manages runtime state for workflow execution.
 *
 * createExecutionContext() builds the initial context from a workflow + provided inputs.
 * buildExpressionContext() wraps an ExecutionContext into an ExpressionContext for
 * the expression engine (tokenizer → parser → evaluator → interpolate).
 *
 * Covers: REQ-ENGINE-003 (step output storage), REQ-EXPR-002 (variable namespaces)
 */

import type { Workflow, StepResult, ExecutionContext } from "../types/index.js"
import type { ExpressionContext } from "../types/expression.js"

/**
 * Creates the initial ExecutionContext for a workflow run.
 *
 * - `steps`: empty map (populated as steps execute)
 * - `inputs`: provided inputs with defaults applied from workflow.inputs definitions
 * - `env`: process.env (string values only)
 * - `workflow`: { name: workflow.name }
 */
export function createExecutionContext(
  workflow: Workflow,
  inputs: Record<string, string>,
): ExecutionContext {
  // Apply defaults from workflow input definitions
  const resolvedInputs: Record<string, string> = { ...inputs }
  if (workflow.inputs) {
    for (const [name, def] of Object.entries(workflow.inputs)) {
      if (resolvedInputs[name] === undefined && def.default !== undefined) {
        resolvedInputs[name] = def.default
      }
    }
  }

  // Collect string-valued env vars from process.env
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value
    }
  }

  const steps: Record<string, { output: unknown; exit_code?: number }> = {}

  const context: ExecutionContext = {
    inputs: resolvedInputs,
    steps,
    workflow: { name: workflow.name },
    env,

    get(path: string): unknown {
      const parts = path.split(".")

      if (parts[0] === "inputs") {
        return resolvedInputs[parts[1]]
      }

      if (parts[0] === "steps") {
        let current: unknown = steps[parts[1]]
        for (let i = 2; i < parts.length && current != null; i++) {
          current = (current as Record<string, unknown>)[parts[i]]
        }
        return current
      }

      if (parts[0] === "env") {
        return env[parts[1]]
      }

      if (parts[0] === "workflow") {
        if (parts[1] === "name") return workflow.name
      }

      return undefined
    },

    set(stepId: string, result: StepResult): void {
      steps[stepId] = {
        output: result.output,
        exit_code: result.exitCode,
      }
    },
  }

  return context
}

/**
 * Wraps an ExecutionContext into an ExpressionContext that the expression
 * engine can use for variable resolution during interpolation and evaluation.
 */
export function buildExpressionContext(
  ctx: ExecutionContext,
): ExpressionContext {
  return {
    get(path: string): unknown {
      return ctx.get(path)
    },
  }
}
