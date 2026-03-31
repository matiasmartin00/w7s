// Step executor interface — generic executor contract for all step types

import type { Step } from "./workflow.js"
import type { StepResult } from "./execution.js"
import type { ExecutionContext } from "./execution.js"

export interface StepExecutor<T extends Step = Step> {
  execute(step: T, context: ExecutionContext): Promise<StepResult>
}
