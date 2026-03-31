// Workflow types — inferred from design, will be validated by Zod schemas in T-03

// --- Literal Types ---

export type StepType = "ai_prompt" | "shell" | "approval"
export type OutputFormat = "text" | "json"

// --- Step Types (Discriminated Union on `type`) ---

export interface StepBase {
  id: string
  type: StepType
  description?: string
  when?: string // ${{ }} expression
  retry?: number
}

export interface AiPromptStep extends StepBase {
  type: "ai_prompt"
  prompt: string
  agent?: string
  output?: string
  output_format?: OutputFormat
}

export interface ShellStep extends StepBase {
  type: "shell"
  run: string
  output?: string
  env?: Record<string, string>
}

export interface ApprovalStep extends StepBase {
  type: "approval"
  message: string
}

export type Step = AiPromptStep | ShellStep | ApprovalStep

// --- Workflow Input ---

export interface WorkflowInput {
  description?: string
  required?: boolean
  default?: string
}

// --- Workflow Trigger ---

export interface WorkflowTrigger {
  commands: string[]
}

// --- Workflow ---

export interface Workflow {
  name: string
  description?: string
  trigger: WorkflowTrigger
  inputs?: Record<string, WorkflowInput>
  steps: Step[]
}
