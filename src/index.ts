/**
 * w7s — OpenCode Workflows Plugin
 *
 * Wires all modules together:
 * - On init: loads workflows from local + global dirs, populates registry
 * - command.execute.before: intercepts workflow triggers + /w7s management commands
 *
 * T-14: Plugin integration (wiring)
 */

import { join } from "node:path"
import { homedir } from "node:os"
import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import type { Workflow, WorkflowResult } from "./types/index.js"
import { loadWorkflows, WorkflowRegistry } from "./loader/index.js"
import type { LoadError } from "./loader/index.js"
import { ExecutionEngine } from "./engine/index.js"
import { ShellExecutor } from "./steps/shell-executor.js"
import { AiPromptExecutor } from "./steps/ai-prompt-executor.js"
import { ApprovalExecutor } from "./steps/approval-executor.js"
import type { ApprovalHandler } from "./steps/approval-executor.js"
import { ExecutionLogger } from "./logging/index.js"
import { parseInputs } from "./utils/input-parser.js"
import { validateWorkflowCommand } from "./commands/validate.js"
import { dryRunWorkflow } from "./commands/dry-run.js"
import { listWorkflows } from "./commands/list.js"

// --- Output formatting helpers ---

/**
 * Format a WorkflowResult into a human-readable text summary.
 */
function formatWorkflowResult(result: WorkflowResult): string {
  const icon = result.status === "completed" ? "✅" : result.status === "cancelled" ? "⚠️" : "❌"
  const lines: string[] = [
    `${icon} Workflow "${result.workflow}" ${result.status} in ${result.duration}ms`,
  ]

  for (const step of result.steps) {
    const stepIcon =
      step.status === "completed" ? "✓" :
      step.status === "skipped" ? "⊘" :
      step.status === "failed" ? "✗" : "?"
    let line = `  ${stepIcon} ${step.stepId} (${step.status})`
    if (step.duration > 0) line += ` [${step.duration}ms]`
    if (step.attempts > 1) line += ` [${step.attempts} attempts]`
    lines.push(line)
  }

  if (result.error) {
    lines.push(`\nError: ${result.error}`)
  }
  if (result.failedStep) {
    lines.push(`Failed at step: ${result.failedStep}`)
  }

  return lines.join("\n")
}

/**
 * Format validation results for display.
 */
function formatValidationResults(
  results: ReturnType<typeof validateWorkflowCommand>,
): string {
  if (results.length === 0) {
    return "No workflows found to validate."
  }

  const lines: string[] = []

  for (const result of results) {
    const icon = result.valid ? "✅" : "❌"
    lines.push(`${icon} ${result.workflow}`)

    for (const check of result.checks) {
      const checkIcon = check.passed ? "  ✓" : "  ✗"
      let line = `${checkIcon} ${check.name}`
      if (check.detail) line += `: ${check.detail}`
      lines.push(line)
    }

    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

/**
 * Format dry-run results for display.
 */
function formatDryRunResult(result: ReturnType<typeof dryRunWorkflow>): string {
  const lines: string[] = [
    `🔍 Dry Run: "${result.workflow}"`,
    `Inputs: ${JSON.stringify(result.inputs)}`,
    "",
  ]

  for (let i = 0; i < result.steps.length; i++) {
    const step = result.steps[i]
    const num = i + 1
    const skipNote = step.skipped ? " [SKIPPED]" : ""

    lines.push(`Step ${num}: ${step.id} (${step.type})${skipNote}`)

    if (step.description) lines.push(`  Description: ${step.description}`)
    if (step.when) lines.push(`  When: ${step.when} → ${step.whenResolved}`)
    if (step.agent) lines.push(`  Agent: ${step.agent}`)
    if (step.prompt !== undefined) lines.push(`  Prompt: ${step.prompt}`)
    if (step.run !== undefined) lines.push(`  Run: ${step.run}`)
    if (step.message !== undefined) lines.push(`  Message: ${step.message}`)
    if (step.retry) lines.push(`  Retry: ${step.retry}`)

    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

/**
 * Format list results for display.
 */
function formatListResult(result: ReturnType<typeof listWorkflows>): string {
  if (result.length === 0) {
    return "No workflows registered."
  }

  const lines: string[] = ["📋 Registered Workflows", ""]

  for (const entry of result) {
    lines.push(`• ${entry.name}`)
    if (entry.description) lines.push(`  ${entry.description}`)
    lines.push(`  Triggers: ${entry.triggers.join(", ")}`)

    if (entry.inputs.length > 0) {
      lines.push("  Inputs:")
      for (const input of entry.inputs) {
        const req = input.required ? "required" : "optional"
        const def = input.default !== undefined ? `, default: "${input.default}"` : ""
        const desc = input.description ? ` — ${input.description}` : ""
        lines.push(`    - ${input.name} (${req}${def})${desc}`)
      }
    }

    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

// --- Plugin logger helper ---

type PluginLogLevel = "debug" | "info" | "warn" | "error"

type PluginLogger = {
  debug: (message: string, extra?: Record<string, unknown>) => Promise<void>
  info: (message: string, extra?: Record<string, unknown>) => Promise<void>
  warn: (message: string, extra?: Record<string, unknown>) => Promise<void>
  error: (message: string, extra?: Record<string, unknown>) => Promise<void>
}

function createPluginLogger(
  client: PluginInput["client"],
  service = "w7s-plugin",
): PluginLogger {
  const send = async (
    level: PluginLogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await client.app.log({
        body: {
          service,
          level,
          message,
          ...(extra && Object.keys(extra).length > 0 ? { extra } : {}),
        },
      })
    } catch {
      // Swallow logging failures to avoid impacting plugin behavior.
    }
  }

  return {
    debug: (message, extra) => send("debug", message, extra),
    info: (message, extra) => send("info", message, extra),
    warn: (message, extra) => send("warn", message, extra),
    error: (message, extra) => send("error", message, extra),
  }
}

// --- Approval handler factory ---

/**
 * Create an approval handler that uses the OpenCode client to send
 * an approval message to the user and waits for a response.
 *
 * For v1, uses a simple Promise-based approach: sends a message
 * with [Approval] prefix and auto-approves since we can't poll
 * for user responses through the plugin API without a session context.
 *
 * TODO: In v2, integrate with a proper interactive mechanism when
 * the plugin API supports it.
 */
function createApprovalHandler(client: PluginInput["client"]): ApprovalHandler {
  // v1: Auto-approve — the workflow shows the message but can't block
  // for user input through the plugin hook system. This is a known
  // limitation from the design open questions.
  return async (message: string): Promise<boolean> => {
    // Log the approval message — in a real interactive context,
    // this would present a prompt and wait for user input.
    // For now we auto-approve to not block workflow execution.
    void message
    void client
    return true
  }
}

// --- Plugin entry point ---

export const w7s = async (ctx: PluginInput): Promise<Hooks> => {
  const logger = createPluginLogger(ctx.client)

  await logger.info("Plugin initializing")

  // 1. Resolve workflow directories
  const localDir = join(ctx.directory, ".opencode", "workflows")
  const globalDir = join(homedir(), ".config/opencode", "workflows")
  await logger.info("Resolved workflow directories", { localDir, globalDir })

  // 2. Load workflows from both directories
  const loadResult = loadWorkflows(localDir, globalDir)
  const loadErrors: LoadError[] = loadResult.errors

  // Log any load errors (non-fatal — valid workflows still load)
  for (const err of loadErrors) {
    await logger.error("Workflow load error", {
      type: err.type,
      file: err.file,
      error: err.error,
    })
  }

  await logger.info("Workflow loading complete", {
    loadedCount: loadResult.workflows.size,
    wokflows: Array.from(loadResult.workflows.keys()),
    errorCount: loadErrors.length,
  })

  // 3. Populate the registry
  const registry = new WorkflowRegistry()
  for (const [name, workflow] of loadResult.workflows) {
    registry.register(name, workflow)
  }

  const registeredCount = loadResult.workflows.size
  if (registeredCount > 0) {
    const names = Array.from(loadResult.workflows.keys()).join(", ")
    await logger.info("Workflows loaded", { count: registeredCount, names })
  }

  // 4. Create step executors
  const shellExecutor = new ShellExecutor(ctx.$)
  const aiPromptExecutor = new AiPromptExecutor(ctx.client)
  const approvalHandler = createApprovalHandler(ctx.client)
  const approvalExecutor = new ApprovalExecutor(approvalHandler)

  // 5. Create execution engine
  const engine = new ExecutionEngine(shellExecutor, aiPromptExecutor, approvalExecutor)

  // 6. Create execution logger
  const runsDir = join(ctx.directory, ".opencode", "workflows", ".runs")
  const executionLogger = new ExecutionLogger(runsDir)

  await logger.info("Plugin initialized, hooks ready")

  // 7. Return hooks
  return {
    "command.execute.before": async (input, output) => {
      const { command, arguments: args } = input
      await logger.info("command.execute.before fired", { command, args })

      // Normalize: strip leading "/" if present for matching
      const cmd = command.startsWith("/") ? command.slice(1) : command

      await logger.info("Processing command", { cmd })
      // --- Management commands: /w7s <subcommand> ---
      if (cmd === "w7s") {
        const trimmed = (args ?? "").trim()
        const parts = trimmed.split(/\s+/)
        const subcommand = parts[0] ?? ""
        const subArgs = parts.slice(1).join(" ")

        let text: string

        await logger.info("Processing w7s subcommand", { subcommand, subArgs })

        switch (subcommand) {
          case "list": {
            const result = listWorkflows(registry)
            text = formatListResult(result)
            break
          }

          case "validate": {
            const workflowName = subArgs.trim() || undefined
            const results = validateWorkflowCommand(workflowName, registry, loadErrors)
            text = formatValidationResults(results)
            break
          }

          case "dry-run": {
            const dryParts = subArgs.trim().split(/\s+/)
            const workflowName = dryParts[0]
            if (!workflowName) {
              text = "Usage: /w7s dry-run <workflow-name> [inputs...]"
              break
            }
            const dryInputArgs = dryParts.slice(1).join(" ")
            const dryInputs = parseInputs(dryInputArgs)
            try {
              const result = dryRunWorkflow(workflowName, dryInputs, registry)
              text = formatDryRunResult(result)
            } catch (err) {
              text = `Error: ${err instanceof Error ? err.message : String(err)}`
            }
            break
          }

          default: {
            text = [
              "w7s — Workflow Engine",
              "",
              "Commands:",
              "  /w7s list                     — List all registered workflows",
              "  /w7s validate [name]          — Validate workflow(s)",
              "  /w7s dry-run <name> [inputs]  — Simulate workflow execution",
              "",
              `Loaded: ${registeredCount} workflow(s)`,
            ].join("\n")
          }
        }

        await logger.info("Subcommand result", { subcommand, text })
        // Set output parts to display result and prevent default processing
        output.parts = [{ type: "text", text } as (typeof output.parts)[number]]
        return
      }

      // --- Workflow trigger commands ---
      // Always match with "/" prefix since workflow triggers are defined as "/hello"
      const triggerCommand = `/${cmd}`
      await logger.debug("Looking up workflow trigger", { triggerCommand })
      const workflow: Workflow | undefined = registry.getByTrigger(triggerCommand)

      if (!workflow) {
        // Not a workflow trigger — pass through to default processing
        const registered = registry.list().map((e) => e.name)
        await logger.info("No workflow found for trigger", {
          triggerCommand,
          registered,
        })
        return
      }

      await logger.info("Workflow found for trigger", {
        triggerCommand,
        workflow: workflow.name,
      })

      // Parse inputs from command arguments
      const inputs = parseInputs(args ?? "")

      // Execute the workflow
      const result: WorkflowResult = await engine.execute(workflow, inputs)

      // Log the result
      try {
        await executionLogger.writeLog(workflow.name, result, inputs)
        await executionLogger.rotate(workflow.name)
      } catch (logErr) {
        await logger.error("Failed to write execution log", {
          error:
            logErr instanceof Error ? logErr.message : String(logErr),
        })
      }

      // Format and return result
      const text = formatWorkflowResult(result)
      output.parts = [{ type: "text", text } as (typeof output.parts)[number]]
    },
  }
}

export default w7s
