// Execution types — runtime state and results

// --- Status Literals ---

export type ExecutionStatus = "running" | "completed" | "failed" | "cancelled"
export type StepStatus = "pending" | "running" | "completed" | "skipped" | "failed"

// --- Step Result ---

export interface StepResult {
  stepId: string
  status: StepStatus
  output?: unknown // string | parsed JSON object
  exitCode?: number // shell steps only
  error?: string
  duration: number // ms
  attempts: number // 1 = no retry
}

// --- Workflow Result ---

export interface WorkflowResult {
  workflow: string
  status: ExecutionStatus
  steps: StepResult[]
  inputs: Record<string, string>
  startedAt: string // ISO timestamp
  completedAt: string
  duration: number
  failedStep?: string
  error?: string
}

// --- Execution Context ---

export interface ExecutionContext {
  inputs: Record<string, string>
  steps: Record<string, { output: unknown; exit_code?: number }>
  workflow: { name: string }
  env: Record<string, string>
  get(path: string): unknown // resolve "steps.init.output.has_legacy"
  set(stepId: string, result: StepResult): void
}
