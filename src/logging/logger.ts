import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { StepResult, WorkflowResult, ExecutionStatus, StepStatus } from "../types/index.js"

// --- Log Entry Types ---

export type LogEntry = {
  timestamp: string // ISO 8601
  workflow: string // workflow name
  status: ExecutionStatus // completed | failed | cancelled
  duration: number // total ms
  inputs: Record<string, string>
  steps: Array<{
    id: string
    status: StepStatus
    duration: number
    output?: unknown // truncated if too large
    error?: string
    exitCode?: number
  }>
  failedStep?: string
  error?: string
}

// --- Max output size before truncation ---

const MAX_OUTPUT_SIZE = 10_000 // characters

function truncateOutput(output: unknown): unknown {
  if (output === undefined || output === null) return output
  const str = typeof output === "string" ? output : JSON.stringify(output)
  if (str.length <= MAX_OUTPUT_SIZE) return output
  return str.slice(0, MAX_OUTPUT_SIZE) + "...[truncated]"
}

// --- Format timestamp for filename (filesystem-safe ISO) ---

function formatTimestamp(iso: string): string {
  // Replace colons with dashes for filesystem compatibility
  return iso.replace(/:/g, "-")
}

// --- Build log entry from WorkflowResult ---

function buildLogEntry(
  workflowName: string,
  result: WorkflowResult,
  inputs: Record<string, string>,
): LogEntry {
  return {
    timestamp: result.startedAt,
    workflow: workflowName,
    status: result.status as ExecutionStatus,
    duration: result.duration,
    inputs,
    steps: result.steps.map((step: StepResult) => ({
      id: step.stepId,
      status: step.status,
      duration: step.duration,
      ...(step.output !== undefined && { output: truncateOutput(step.output) }),
      ...(step.error !== undefined && { error: step.error }),
      ...(step.exitCode !== undefined && { exitCode: step.exitCode }),
    })),
    ...(result.failedStep !== undefined && { failedStep: result.failedStep }),
    ...(result.error !== undefined && { error: result.error }),
  }
}

// --- ExecutionLogger ---

export class ExecutionLogger {
  constructor(
    private runsDir: string, // e.g., .opencode/workflows/.runs
    private maxRuns: number = 5,
  ) {}

  /**
   * Write a log entry for a workflow execution.
   * Creates the runs directory if it doesn't exist.
   * File: {runsDir}/{workflowName}-{ISO-timestamp}.log
   * Format: JSON (one entry per file)
   * Returns the log file path.
   */
  async writeLog(
    workflowName: string,
    result: WorkflowResult,
    inputs: Record<string, string>,
  ): Promise<string> {
    await mkdir(this.runsDir, { recursive: true })

    const entry = buildLogEntry(workflowName, result, inputs)
    const safeTimestamp = formatTimestamp(result.startedAt)
    const filename = `${workflowName}-${safeTimestamp}.log`
    const filePath = join(this.runsDir, filename)

    await writeFile(filePath, JSON.stringify(entry, null, 2), "utf-8")

    return filePath
  }

  /**
   * Keep only the last maxRuns logs for this workflow.
   * Deletes oldest first.
   */
  async rotate(workflowName: string): Promise<void> {
    const files = await this.getLogFiles(workflowName)

    if (files.length <= this.maxRuns) return

    // Files are sorted oldest→newest, delete from the beginning
    const toDelete = files.slice(0, files.length - this.maxRuns)
    await Promise.all(
      toDelete.map((file) => rm(join(this.runsDir, file))),
    )
  }

  /**
   * Read all logs for a workflow, sorted by timestamp desc (newest first).
   */
  async getHistory(workflowName: string): Promise<LogEntry[]> {
    const files = await this.getLogFiles(workflowName)

    if (files.length === 0) return []

    const entries = await Promise.all(
      files.map(async (file) => {
        const content = await readFile(join(this.runsDir, file), "utf-8")
        return JSON.parse(content) as LogEntry
      }),
    )

    // Sort by timestamp descending (newest first)
    entries.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    )

    return entries
  }

  /**
   * Get sorted log files for a workflow (oldest→newest by filename).
   */
  private async getLogFiles(workflowName: string): Promise<string[]> {
    let allFiles: string[]
    try {
      allFiles = await readdir(this.runsDir)
    } catch {
      // Directory doesn't exist yet — no logs
      return []
    }

    const prefix = `${workflowName}-`
    const suffix = ".log"

    return allFiles
      .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
      .sort() // lexicographic sort on ISO timestamps = chronological
  }
}
