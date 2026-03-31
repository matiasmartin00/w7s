import { type ZodError } from "zod"
import {
  workflowSchema,
  type WorkflowSchema,
} from "./workflow.js"

export {
  aiPromptStepSchema,
  shellStepSchema,
  approvalStepSchema,
  stepSchema,
  workflowInputSchema,
  workflowTriggerSchema,
  workflowSchema,
} from "./workflow.js"

export type {
  AiPromptStepSchema,
  ShellStepSchema,
  ApprovalStepSchema,
  StepSchema,
  WorkflowInputSchema,
  WorkflowTriggerSchema,
  WorkflowSchema,
} from "./workflow.js"

// --- Validation Helper ---

type ValidationSuccess = { success: true; workflow: WorkflowSchema }
type ValidationFailure = { success: false; errors: ZodError }
export type ValidationResult = ValidationSuccess | ValidationFailure

export function validateWorkflow(data: unknown): ValidationResult {
  const result = workflowSchema.safeParse(data)
  if (result.success) {
    return { success: true, workflow: result.data }
  }
  return { success: false, errors: result.error }
}
