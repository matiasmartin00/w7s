/**
 * Dry-run command — simulates workflow execution without running anything.
 *
 * Shows the step sequence with:
 * - Interpolated prompts/commands/messages where possible (inputs are known)
 * - `<pending>` for values that depend on runtime step outputs
 * - Resolved `when` conditions where possible, `<pending>` for runtime-dependent
 */

import type { Workflow, Step, StepType } from "../types/index.js"
import type { ExpressionContext } from "../types/expression.js"
import type { WorkflowRegistry } from "../loader/index.js"

// --- Types ---

export interface DryRunStep {
  id: string
  type: StepType
  description?: string
  agent?: string
  prompt?: string
  run?: string
  message?: string
  when?: string
  whenResolved?: string
  skipped: boolean
  retry?: number
}

export interface DryRunResult {
  workflow: string
  inputs: Record<string, string>
  steps: DryRunStep[]
}

// --- Dry-run expression context ---

const EXPRESSION_PATTERN = /\$\{\{\s*(.*?)\s*\}\}/g

/**
 * Check if an expression depends on step outputs (runtime values).
 * Returns true if the expression references `steps.*`.
 */
function dependsOnRuntime(expr: string): boolean {
  return /steps\.[a-zA-Z_]/.test(expr)
}

/**
 * A limited context that only resolves inputs and marks runtime-dependent
 * values as `<pending>`.
 */
class DryRunContext implements ExpressionContext {
  constructor(
    private inputs: Record<string, string>,
    private workflowName: string,
  ) {}

  get(path: string): unknown {
    const parts = path.split(".")

    if (parts[0] === "inputs" && parts.length === 2) {
      return this.inputs[parts[1]]
    }

    if (parts[0] === "workflow" && parts[1] === "name") {
      return this.workflowName
    }

    if (parts[0] === "env" && parts.length === 2) {
      return process.env[parts[1]] ?? ""
    }

    // steps.* and anything else → undefined (will become <pending>)
    return undefined
  }
}

/**
 * Interpolate a template for dry-run: resolve what we can (inputs, env, workflow),
 * mark anything depending on step outputs as <pending>.
 */
function dryRunInterpolate(
  template: string,
  context: DryRunContext,
): string {
  return template.replace(EXPRESSION_PATTERN, (_match, expr: string) => {
    const trimmed = expr.trim()

    // If the expression depends on runtime values, mark as <pending>
    if (dependsOnRuntime(trimmed)) {
      return "<pending>"
    }

    // Try to resolve from context (inputs, workflow.name, env)
    const value = resolveSimpleExpression(trimmed, context)
    if (value === undefined || value === null) {
      return "<pending>"
    }

    if (typeof value === "object") {
      return JSON.stringify(value)
    }

    return String(value)
  })
}

/**
 * Resolve simple expressions (just variable access, no operators) for dry-run.
 * For complex expressions with ||, ==, != that reference runtime values, returns undefined.
 */
function resolveSimpleExpression(
  expr: string,
  context: DryRunContext,
): unknown {
  // Handle || operator
  if (expr.includes("||")) {
    // If any part depends on runtime, the whole thing is pending
    if (dependsOnRuntime(expr)) return undefined
    // Otherwise, try each side
    const parts = expr.split("||").map((p) => p.trim())
    for (const part of parts) {
      const val = context.get(part)
      if (val != null && val !== "" && val !== false && val !== 0) {
        return val
      }
    }
    return ""
  }

  // Handle == and != operators
  if (expr.includes("==") || expr.includes("!=")) {
    if (dependsOnRuntime(expr)) return undefined
    // For non-runtime comparisons, we could evaluate but it's rare — mark as pending
    return undefined
  }

  // Simple variable access
  return context.get(expr)
}

/**
 * Try to resolve a `when` condition for dry-run.
 * Returns 'true', 'false', or '<pending>'.
 */
function resolveWhenCondition(
  whenExpr: string,
  context: DryRunContext,
): string {
  // Strip ${{ }} wrapper if present
  const inner = whenExpr.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "").trim()

  // If it depends on runtime values, it's pending
  if (dependsOnRuntime(inner)) {
    return "<pending>"
  }

  // Try to evaluate simple cases
  const value = resolveSimpleExpression(inner, context)
  if (value === undefined || value === null) {
    return "<pending>"
  }

  // Coerce to boolean
  if (value === false || value === "false" || value === "" || value === 0) {
    return "false"
  }

  return "true"
}

// --- Public API ---

/**
 * Simulate workflow execution.
 *
 * @param workflowName - Name of the workflow to dry-run.
 * @param inputs - User-provided inputs (key=value).
 * @param registry - The workflow registry.
 */
export function dryRunWorkflow(
  workflowName: string,
  inputs: Record<string, string>,
  registry: WorkflowRegistry,
): DryRunResult {
  const workflow = registry.getByName(workflowName)
  if (!workflow) {
    throw new Error(`Workflow "${workflowName}" not found in registry`)
  }

  // Apply defaults to inputs
  const resolvedInputs: Record<string, string> = { ...inputs }
  if (workflow.inputs) {
    for (const [name, def] of Object.entries(workflow.inputs)) {
      if (resolvedInputs[name] === undefined && def.default !== undefined) {
        resolvedInputs[name] = def.default
      }
    }
  }

  const context = new DryRunContext(resolvedInputs, workflow.name)
  const dryRunSteps: DryRunStep[] = []

  for (const step of workflow.steps) {
    const dryStep: DryRunStep = {
      id: step.id,
      type: step.type,
      description: step.description,
      skipped: false,
    }

    // When condition
    if (step.when) {
      dryStep.when = step.when
      dryStep.whenResolved = resolveWhenCondition(step.when, context)
      if (dryStep.whenResolved === "false") {
        dryStep.skipped = true
      }
    }

    // Retry
    if (step.retry !== undefined && step.retry > 0) {
      dryStep.retry = step.retry
    }

    // Step-type-specific fields
    switch (step.type) {
      case "ai_prompt":
        dryStep.agent = step.agent
        dryStep.prompt = dryRunInterpolate(step.prompt, context)
        break
      case "shell":
        dryStep.run = dryRunInterpolate(step.run, context)
        break
      case "approval":
        dryStep.message = dryRunInterpolate(step.message, context)
        break
    }

    dryRunSteps.push(dryStep)
  }

  return {
    workflow: workflowName,
    inputs: resolvedInputs,
    steps: dryRunSteps,
  }
}
