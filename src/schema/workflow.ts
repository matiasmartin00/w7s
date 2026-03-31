import { z } from "zod"

// --- Step Base Fields ---

const stepBaseSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  when: z.string().optional(),
})

// --- Step Schemas ---

export const aiPromptStepSchema = stepBaseSchema.extend({
  type: z.literal("ai_prompt"),
  prompt: z.string(),
  agent: z.string().optional(),
  output: z.string().optional(),
  output_format: z.enum(["text", "json"]).optional(),
  retry: z.number().int().min(0).optional(),
})

export const shellStepSchema = stepBaseSchema.extend({
  type: z.literal("shell"),
  run: z.string(),
  output: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  when: z.string().optional(),
  retry: z.number().int().min(0).optional(),
})

export const approvalStepSchema = stepBaseSchema.extend({
  type: z.literal("approval"),
  message: z.string(),
})

export const stepSchema = z.discriminatedUnion("type", [
  aiPromptStepSchema,
  shellStepSchema,
  approvalStepSchema,
])

// --- Workflow Input Schema ---

export const workflowInputSchema = z.object({
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
})

// --- Trigger Schema ---

export const workflowTriggerSchema = z.object({
  commands: z.array(z.string()).min(1),
})

// --- Workflow Schema ---

export const workflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  trigger: workflowTriggerSchema,
  inputs: z.record(z.string(), workflowInputSchema).optional(),
  steps: z.array(stepSchema).min(1),
})

// --- Inferred Types ---

export type AiPromptStepSchema = z.infer<typeof aiPromptStepSchema>
export type ShellStepSchema = z.infer<typeof shellStepSchema>
export type ApprovalStepSchema = z.infer<typeof approvalStepSchema>
export type StepSchema = z.infer<typeof stepSchema>
export type WorkflowInputSchema = z.infer<typeof workflowInputSchema>
export type WorkflowTriggerSchema = z.infer<typeof workflowTriggerSchema>
export type WorkflowSchema = z.infer<typeof workflowSchema>
