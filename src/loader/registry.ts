import type { Workflow } from "../types/index.js"

/**
 * In-memory registry of loaded workflows.
 *
 * Maps workflow names to their definitions, and trigger commands to workflow names
 * for O(1) lookup when intercepting commands.
 */
export class WorkflowRegistry {
  private workflows: Map<string, Workflow> = new Map()
  private triggerMap: Map<string, string> = new Map() // command → workflow name

  /**
   * Register a workflow by name.
   * Automatically indexes all trigger commands for fast lookup.
   */
  register(name: string, workflow: Workflow): void {
    this.workflows.set(name, workflow)
    for (const cmd of workflow.trigger.commands) {
      this.triggerMap.set(cmd, name)
    }
  }

  /**
   * Get a workflow by its registered name.
   */
  getByName(name: string): Workflow | undefined {
    return this.workflows.get(name)
  }

  /**
   * Get a workflow by a trigger command string (e.g. "/deploy").
   */
  getByTrigger(command: string): Workflow | undefined {
    const name = this.triggerMap.get(command)
    if (name === undefined) return undefined
    return this.workflows.get(name)
  }

  /**
   * List all registered workflows.
   */
  list(): Array<{ name: string; workflow: Workflow }> {
    return Array.from(this.workflows.entries()).map(([name, workflow]) => ({
      name,
      workflow,
    }))
  }

  /**
   * Check if a workflow with the given name is registered.
   */
  has(name: string): boolean {
    return this.workflows.has(name)
  }
}
