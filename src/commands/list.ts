/**
 * List command — displays all registered workflows with their
 * triggers, inputs, and descriptions.
 */

import type { WorkflowRegistry } from "../loader/index.js"

// --- Types ---

export interface ListInput {
  name: string
  required: boolean
  default?: string
  description?: string
}

export interface ListEntry {
  name: string
  description?: string
  triggers: string[]
  inputs: ListInput[]
}

export type ListResult = ListEntry[]

// --- Public API ---

/**
 * List all registered workflows with metadata.
 *
 * @param registry - The workflow registry.
 */
export function listWorkflows(registry: WorkflowRegistry): ListResult {
  const entries = registry.list()
  const result: ListResult = []

  for (const { name, workflow } of entries) {
    const inputs: ListInput[] = []

    if (workflow.inputs) {
      for (const [inputName, inputDef] of Object.entries(workflow.inputs)) {
        inputs.push({
          name: inputName,
          required: inputDef.required ?? false,
          default: inputDef.default,
          description: inputDef.description,
        })
      }
    }

    result.push({
      name,
      description: workflow.description,
      triggers: [...workflow.trigger.commands],
      inputs,
    })
  }

  return result
}
