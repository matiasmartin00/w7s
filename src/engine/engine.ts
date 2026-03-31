/**
 * Execution engine — sequential state machine that runs workflows step by step.
 *
 * Execution loop:
 * 1. Create ExecutionContext with createExecutionContext()
 * 2. Validate required inputs are provided
 * 3. For each step (sequential, top to bottom):
 *    a. Evaluate `when` condition → skip if falsy
 *    b. Dispatch to correct executor by step type
 *    c. Store step result in context
 *    d. If step failed → fail-stop or cancel
 *    e. Track duration per step
 * 4. If all steps complete → status: completed
 *
 * Covers: REQ-ENGINE-001 (sequential execution), REQ-ENGINE-002 (when conditions),
 *         REQ-ENGINE-003 (output storage), REQ-ENGINE-004 (fail-stop)
 */

import type {
  Workflow,
  Step,
  AiPromptStep,
  ShellStep,
  ApprovalStep,
  StepResult,
  WorkflowResult,
} from "../types/index.js"
import type { ShellExecutor } from "../steps/shell-executor.js"
import type { AiPromptExecutor } from "../steps/ai-prompt-executor.js"
import type { ApprovalExecutor } from "../steps/approval-executor.js"
import { createExecutionContext, buildExpressionContext } from "./context.js"
import { tokenize } from "../expression/tokenizer.js"
import { parse } from "../expression/parser.js"
import { evaluate } from "../expression/evaluator.js"

/**
 * Coerce a value to boolean for `when` condition evaluation.
 * Falsy: false, "false", "", null, undefined, 0
 */
function isTruthy(value: unknown): boolean {
  if (value === false || value === "false") return false
  if (value === "" || value == null || value === 0) return false
  return true
}

export class ExecutionEngine {
  constructor(
    private shellExecutor: ShellExecutor,
    private aiPromptExecutor: AiPromptExecutor,
    private approvalExecutor: ApprovalExecutor,
  ) {}

  async execute(
    workflow: Workflow,
    inputs: Record<string, string>,
  ): Promise<WorkflowResult> {
    const startedAt = new Date().toISOString()
    const startTime = Date.now()
    const stepResults: StepResult[] = []

    // 1. Create execution context (applies input defaults)
    const context = createExecutionContext(workflow, inputs)

    // 2. Validate required inputs are provided
    if (workflow.inputs) {
      for (const [name, def] of Object.entries(workflow.inputs)) {
        if (def.required !== false && context.inputs[name] === undefined) {
          return {
            workflow: workflow.name,
            status: "failed",
            steps: stepResults,
            inputs: context.inputs,
            startedAt,
            completedAt: new Date().toISOString(),
            duration: Date.now() - startTime,
            error: `Missing required input: ${name}`,
          }
        }
      }
    }

    // 3. Execute each step sequentially
    for (const step of workflow.steps) {
      const stepStartTime = Date.now()

      // 3a. Evaluate `when` condition if present
      if (step.when) {
        const exprCtx = buildExpressionContext(context)
        const tokens = tokenize(step.when)
        const ast = parse(tokens)
        const whenResult = evaluate(ast, exprCtx)

        if (!isTruthy(whenResult)) {
          // Skip this step
          const skippedResult: StepResult = {
            stepId: step.id,
            status: "skipped",
            duration: Date.now() - stepStartTime,
            attempts: 0,
          }
          stepResults.push(skippedResult)
          continue
        }
      }

      // 3b. Execute step based on type
      let result: StepResult
      switch (step.type) {
        case "shell":
          result = await this.shellExecutor.execute(
            step as ShellStep,
            context,
          )
          break
        case "ai_prompt":
          result = await this.aiPromptExecutor.execute(
            step as AiPromptStep,
            context,
          )
          break
        case "approval":
          result = await this.approvalExecutor.execute(
            step as ApprovalStep,
            context,
          )
          break
      }

      // 3c. Store step result in context
      context.set(step.id, result)

      // Ensure duration is set from engine perspective
      result.duration = Date.now() - stepStartTime

      stepResults.push(result)

      // 3d. Handle failure
      if (result.status === "failed") {
        // Check for approval cancellation
        if (result.error && result.error.includes("cancelled by user")) {
          return {
            workflow: workflow.name,
            status: "cancelled",
            steps: stepResults,
            inputs: context.inputs,
            startedAt,
            completedAt: new Date().toISOString(),
            duration: Date.now() - startTime,
            failedStep: step.id,
            error: result.error,
          }
        }

        // Regular failure → fail-stop
        return {
          workflow: workflow.name,
          status: "failed",
          steps: stepResults,
          inputs: context.inputs,
          startedAt,
          completedAt: new Date().toISOString(),
          duration: Date.now() - startTime,
          failedStep: step.id,
          error: result.error,
        }
      }
    }

    // 4. All steps completed successfully
    return {
      workflow: workflow.name,
      status: "completed",
      steps: stepResults,
      inputs: context.inputs,
      startedAt,
      completedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    }
  }
}
