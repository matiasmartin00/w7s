/**
 * AI Prompt Step Executor — creates isolated sessions and sends
 * interpolated prompts to OpenCode agents.
 *
 * Design decision #5: isolated session per step (session.create + session.prompt).
 * Design decision #3: multi-strategy JSON extraction for output_format: json.
 *
 * The OpenCode client is injected via the constructor, matching the pattern
 * used by ShellExecutor ($) and ApprovalExecutor (handler). This keeps
 * the execute() signature conforming to StepExecutor<AiPromptStep>.
 */

import type {
  AiPromptStep,
  StepResult,
  ExecutionContext,
  PluginInput,
} from "../types/index.js"
import type { StepExecutor } from "../types/step-executor.js"
import { interpolate } from "../expression/interpolate.js"
import { withRetry } from "../utils/retry.js"
import { extractJson, JsonExtractionError } from "../utils/json-extractor.js"

/** The subset of PluginInput["client"] that this executor needs */
type OpenCodeClient = PluginInput["client"]

/**
 * Extract text content from the response parts returned by session.prompt().
 * Concatenates all TextPart.text values, ignoring reasoning/tool/other part types.
 */
function extractTextFromParts(
  parts: Array<{ type: string; text?: string }>,
): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("")
}

export class AiPromptExecutor implements StepExecutor<AiPromptStep> {
  private readonly client: OpenCodeClient

  constructor(client: OpenCodeClient) {
    this.client = client
  }

  async execute(
    step: AiPromptStep,
    context: ExecutionContext,
  ): Promise<StepResult> {
    const startTime = Date.now()
    const maxRetries = step.retry ?? 0
    let attemptCount = 0

    try {
      const output = await withRetry(
        async () => {
          attemptCount++
          return this.executeOnce(step, context)
        },
        { maxRetries, baseDelay: 1000, maxDelay: 30_000 },
      )

      const duration = Date.now() - startTime
      return {
        stepId: step.id,
        status: "completed",
        output,
        duration,
        attempts: attemptCount,
      }
    } catch (error) {
      const duration = Date.now() - startTime
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      return {
        stepId: step.id,
        status: "failed",
        error: errorMessage,
        duration,
        attempts: attemptCount,
      }
    }
  }

  private async executeOnce(
    step: AiPromptStep,
    context: ExecutionContext,
  ): Promise<unknown> {
    // 1. Interpolate prompt using expression engine
    const interpolatedPrompt = interpolate(step.prompt, context)

    // 2. Create isolated session (REQ-STEP-AI-003)
    const sessionResponse = await this.client.session.create()
    const session = sessionResponse.data
    if (!session) {
      throw new Error(
        `Failed to create session: ${sessionResponse.error ? JSON.stringify(sessionResponse.error) : "unknown error"}`,
      )
    }

    // 3. Build prompt body and send to agent (REQ-STEP-AI-001)
    const promptBody: {
      parts: Array<{ type: "text"; text: string }>
      agent?: string
    } = {
      parts: [{ type: "text", text: interpolatedPrompt }],
    }

    if (step.agent) {
      promptBody.agent = step.agent
    }

    const promptResponse = await this.client.session.prompt({
      path: { id: session.id },
      body: promptBody,
    })

    const promptData = promptResponse.data
    if (!promptData) {
      throw new Error(
        `Failed to send prompt: ${promptResponse.error ? JSON.stringify(promptResponse.error) : "unknown error"}`,
      )
    }

    // 4. Extract response text from parts
    const responseText = extractTextFromParts(
      promptData.parts as Array<{ type: string; text?: string }>,
    )

    // 5. Handle output format (REQ-STEP-AI-002)
    const outputFormat = step.output_format ?? "text"

    if (outputFormat === "json") {
      try {
        return extractJson(responseText)
      } catch (error) {
        if (error instanceof JsonExtractionError) {
          throw new Error(`JSON extraction failed: ${error.message}`)
        }
        throw error
      }
    }

    // Default: text output
    return responseText
  }
}
