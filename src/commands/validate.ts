/**
 * Validate command — checks workflow(s) for structural correctness
 * without executing them.
 *
 * Checks:
 * 1. YAML syntax (reported via load errors)
 * 2. Required fields present (covered by Zod schema during load)
 * 3. Valid inter-step references: ${{ steps.X.output }} points to a step that exists AND precedes
 * 4. Referenced agents are non-empty strings (v1 — actual existence requires OpenCode config)
 * 5. No duplicate trigger commands between workflows
 * 6. Inputs referenced in prompts are defined in the inputs block
 */

import type { Workflow, Step } from "../types/index.js"
import type { WorkflowRegistry } from "../loader/index.js"
import type { LoadError } from "../loader/index.js"

// --- Types ---

export interface ValidationCheck {
  name: string
  passed: boolean
  detail?: string
}

export interface ValidationResult {
  workflow: string
  checks: ValidationCheck[]
  valid: boolean
}

// --- Expression reference extraction ---

const EXPRESSION_PATTERN = /\$\{\{\s*(.*?)\s*\}\}/g

/**
 * Extract all step references from ${{ }} expressions in a string.
 * Returns references in the form { stepId, field } for `steps.X.output` or `steps.X.exit_code`.
 */
function extractStepReferences(text: string): Array<{ stepId: string; field: string }> {
  const refs: Array<{ stepId: string; field: string }> = []
  let match: RegExpExecArray | null

  // Reset lastIndex for global regex
  EXPRESSION_PATTERN.lastIndex = 0

  while ((match = EXPRESSION_PATTERN.exec(text)) !== null) {
    const expr = match[1].trim()
    // Extract all steps.X references from the expression.
    // An expression like `steps.a.output || steps.b.output` has two refs.
    const stepRefPattern = /steps\.([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_.]*)/g
    let refMatch: RegExpExecArray | null
    while ((refMatch = stepRefPattern.exec(expr)) !== null) {
      refs.push({ stepId: refMatch[1], field: refMatch[2] })
    }
  }

  return refs
}

/**
 * Extract all input references from ${{ }} expressions in a string.
 * Returns input names referenced as `inputs.X`.
 */
function extractInputReferences(text: string): string[] {
  const refs: string[] = []
  let match: RegExpExecArray | null

  EXPRESSION_PATTERN.lastIndex = 0

  while ((match = EXPRESSION_PATTERN.exec(text)) !== null) {
    const expr = match[1].trim()
    const inputRefPattern = /inputs\.([a-zA-Z_][a-zA-Z0-9_]*)/g
    let refMatch: RegExpExecArray | null
    while ((refMatch = inputRefPattern.exec(expr)) !== null) {
      refs.push(refMatch[1])
    }
  }

  return refs
}

/**
 * Get all interpolatable text fields from a step.
 */
function getStepTextFields(step: Step): string[] {
  const fields: string[] = []

  if (step.when) fields.push(step.when)

  switch (step.type) {
    case "ai_prompt":
      fields.push(step.prompt)
      break
    case "shell":
      fields.push(step.run)
      if (step.env) {
        for (const value of Object.values(step.env)) {
          fields.push(value)
        }
      }
      break
    case "approval":
      fields.push(step.message)
      break
  }

  return fields
}

// --- Validation checks ---

/**
 * Check that all ${{ steps.X.* }} references point to a step that exists
 * AND comes before the referencing step (no forward references).
 */
function checkStepReferences(workflow: Workflow): ValidationCheck {
  const errors: string[] = []
  const seenStepIds = new Set<string>()

  for (const step of workflow.steps) {
    // Collect all text fields that may contain expressions
    const textFields = getStepTextFields(step)

    for (const text of textFields) {
      const refs = extractStepReferences(text)
      for (const ref of refs) {
        // Check step exists anywhere in the workflow
        const stepExists = workflow.steps.some((s) => s.id === ref.stepId)
        if (!stepExists) {
          errors.push(
            `Step "${step.id}" references non-existent step "${ref.stepId}"`,
          )
        } else if (!seenStepIds.has(ref.stepId)) {
          // Step exists but hasn't been seen yet → forward reference
          errors.push(
            `Step "${step.id}" has forward reference to step "${ref.stepId}" (must come before)`,
          )
        }
      }
    }

    seenStepIds.add(step.id)
  }

  if (errors.length === 0) {
    return { name: "step_references", passed: true }
  }

  return {
    name: "step_references",
    passed: false,
    detail: errors.join("; "),
  }
}

/**
 * Check that referenced agents are non-empty strings.
 * In v1, we can only check if the agent field is a non-empty string.
 */
function checkAgents(workflow: Workflow): ValidationCheck {
  const issues: string[] = []

  for (const step of workflow.steps) {
    if (step.type === "ai_prompt" && step.agent !== undefined) {
      if (typeof step.agent !== "string" || step.agent.trim() === "") {
        issues.push(`Step "${step.id}" has an empty or invalid agent field`)
      }
    }
  }

  if (issues.length === 0) {
    return { name: "agents", passed: true }
  }

  return {
    name: "agents",
    passed: false,
    detail: issues.join("; "),
  }
}

/**
 * Check that inputs referenced in prompts/messages/run/when are defined
 * in the workflow's inputs block.
 */
function checkInputReferences(workflow: Workflow): ValidationCheck {
  const definedInputs = new Set(Object.keys(workflow.inputs ?? {}))
  const issues: string[] = []

  for (const step of workflow.steps) {
    const textFields = getStepTextFields(step)
    for (const text of textFields) {
      const inputRefs = extractInputReferences(text)
      for (const inputName of inputRefs) {
        if (!definedInputs.has(inputName)) {
          issues.push(
            `Step "${step.id}" references undefined input "${inputName}"`,
          )
        }
      }
    }
  }

  if (issues.length === 0) {
    return { name: "input_references", passed: true }
  }

  return {
    name: "input_references",
    passed: false,
    detail: issues.join("; "),
  }
}

/**
 * Check for duplicate trigger commands across all workflows in the registry.
 */
function checkDuplicateTriggers(
  workflowName: string,
  registry: WorkflowRegistry,
): ValidationCheck {
  const allWorkflows = registry.list()
  const triggerMap = new Map<string, string[]>()

  for (const { name, workflow } of allWorkflows) {
    for (const cmd of workflow.trigger.commands) {
      const owners = triggerMap.get(cmd) ?? []
      owners.push(name)
      triggerMap.set(cmd, owners)
    }
  }

  const conflicts: string[] = []
  const thisWorkflow = registry.getByName(workflowName)
  if (thisWorkflow) {
    for (const cmd of thisWorkflow.trigger.commands) {
      const owners = triggerMap.get(cmd) ?? []
      if (owners.length > 1) {
        conflicts.push(
          `Trigger "${cmd}" is shared with: ${owners.filter((n) => n !== workflowName).join(", ")}`,
        )
      }
    }
  }

  if (conflicts.length === 0) {
    return { name: "duplicate_triggers", passed: true }
  }

  return {
    name: "duplicate_triggers",
    passed: false,
    detail: conflicts.join("; "),
  }
}

// --- Public API ---

/**
 * Validate one or all workflows.
 *
 * @param workflowName - Name of a specific workflow to validate, or undefined to validate all.
 * @param registry - The workflow registry containing loaded workflows.
 * @param loadErrors - Errors from the load phase (YAML parse / schema validation failures).
 */
export function validateWorkflowCommand(
  workflowName: string | undefined,
  registry: WorkflowRegistry,
  loadErrors: LoadError[],
): ValidationResult[] {
  const results: ValidationResult[] = []

  // If specific workflow requested, validate just that one
  const entries = workflowName
    ? (() => {
        const wf = registry.getByName(workflowName)
        return wf ? [{ name: workflowName, workflow: wf }] : []
      })()
    : registry.list()

  for (const { name, workflow } of entries) {
    const checks: ValidationCheck[] = []

    // 1. YAML syntax check — report any load errors for this workflow
    const relatedErrors = loadErrors.filter(
      (e) => e.file.includes(name) && (e.type === "parse" || e.type === "validation"),
    )
    if (relatedErrors.length > 0) {
      checks.push({
        name: "yaml_syntax",
        passed: false,
        detail: relatedErrors.map((e) => e.error).join("; "),
      })
    } else {
      checks.push({ name: "yaml_syntax", passed: true })
    }

    // 2. Required fields — already validated by Zod during load, so if we're here, it passed
    checks.push({ name: "required_fields", passed: true })

    // 3. Step references (exist and precede)
    checks.push(checkStepReferences(workflow))

    // 4. Agents
    checks.push(checkAgents(workflow))

    // 5. Duplicate triggers
    checks.push(checkDuplicateTriggers(name, registry))

    // 6. Input references
    checks.push(checkInputReferences(workflow))

    results.push({
      workflow: name,
      checks,
      valid: checks.every((c) => c.passed),
    })
  }

  // Also report load errors for workflows that failed to load (not in registry)
  if (workflowName === undefined) {
    for (const err of loadErrors) {
      if (err.type === "parse" || err.type === "validation") {
        // Check if this error's workflow is already in results
        const alreadyReported = results.some((r) =>
          r.checks.some((c) => c.name === "yaml_syntax" && !c.passed),
        )
        if (!alreadyReported) {
          results.push({
            workflow: err.file,
            checks: [
              {
                name: "yaml_syntax",
                passed: false,
                detail: err.error,
              },
            ],
            valid: false,
          })
        }
      }
    }
  }

  return results
}
