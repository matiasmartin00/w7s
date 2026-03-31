/**
 * Approval step executor — pauses workflow execution and waits for user
 * confirmation via an injected handler.
 *
 * The handler abstraction (ApprovalHandler) decouples this executor from the
 * actual user interaction mechanism (OpenCode chat, CLI prompt, etc.), making
 * it testable and adaptable.
 *
 * Covers REQ-STEP-APPROVAL-001.
 */

import type { ApprovalStep } from "../types/workflow.js"
import type { StepResult } from "../types/execution.js"
import type { ExecutionContext } from "../types/execution.js"
import { interpolate } from "../expression/interpolate.js"

/**
 * Callback that presents a message to the user and resolves with their decision.
 * Returns `true` if the user approves, `false` if they cancel.
 */
export type ApprovalHandler = (message: string) => Promise<boolean>

export class ApprovalExecutor {
  constructor(private approvalHandler: ApprovalHandler) {}

  async execute(
    step: ApprovalStep,
    context: ExecutionContext,
  ): Promise<StepResult> {
    const startTime = Date.now()

    // Interpolate the message with expression context variables
    const message = interpolate(step.message, context)

    // Delegate to the injected handler for user interaction
    const approved = await this.approvalHandler(message)

    const duration = Date.now() - startTime

    if (approved) {
      return {
        stepId: step.id,
        status: "completed",
        duration,
        attempts: 1,
      }
    }

    return {
      stepId: step.id,
      status: "failed",
      error: `cancelled by user at step: ${step.id}`,
      duration,
      attempts: 1,
    }
  }
}
