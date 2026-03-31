import { describe, it, expect, beforeEach } from "vitest"
import { WorkflowRegistry } from "./registry.js"
import type { Workflow } from "../types/index.js"

// --- Fixtures ---

const deployWorkflow: Workflow = {
  name: "deploy",
  description: "Deploy pipeline",
  trigger: { commands: ["/deploy", "/ship"] },
  steps: [
    { id: "build", type: "shell", run: "npm run build" },
  ],
}

const testWorkflow: Workflow = {
  name: "test",
  description: "Test runner",
  trigger: { commands: ["/test"] },
  steps: [
    { id: "run", type: "shell", run: "npm test" },
  ],
}

// --- Tests ---

describe("WorkflowRegistry", () => {
  let registry: WorkflowRegistry

  beforeEach(() => {
    registry = new WorkflowRegistry()
  })

  it("registers and retrieves a workflow by name", () => {
    registry.register("deploy", deployWorkflow)

    const wf = registry.getByName("deploy")
    expect(wf).toBeDefined()
    expect(wf!.name).toBe("deploy")
  })

  it("retrieves a workflow by trigger command", () => {
    registry.register("deploy", deployWorkflow)

    const wf = registry.getByTrigger("/deploy")
    expect(wf).toBeDefined()
    expect(wf!.name).toBe("deploy")
  })

  it("retrieves a workflow by any of its trigger commands", () => {
    registry.register("deploy", deployWorkflow)

    const wf = registry.getByTrigger("/ship")
    expect(wf).toBeDefined()
    expect(wf!.name).toBe("deploy")
  })

  it("lists all registered workflows", () => {
    registry.register("deploy", deployWorkflow)
    registry.register("test", testWorkflow)

    const all = registry.list()
    expect(all).toHaveLength(2)

    const names = all.map((e) => e.name)
    expect(names).toContain("deploy")
    expect(names).toContain("test")
  })

  it("returns undefined for unknown workflow name", () => {
    const wf = registry.getByName("nonexistent")
    expect(wf).toBeUndefined()
  })

  it("returns undefined for unknown trigger command", () => {
    const wf = registry.getByTrigger("/nope")
    expect(wf).toBeUndefined()
  })

  it("has() returns true for registered workflow", () => {
    registry.register("deploy", deployWorkflow)

    expect(registry.has("deploy")).toBe(true)
  })

  it("has() returns false for unregistered workflow", () => {
    expect(registry.has("deploy")).toBe(false)
  })

  it("returns empty list when no workflows registered", () => {
    const all = registry.list()
    expect(all).toHaveLength(0)
  })

  it("list entries contain correct workflow data", () => {
    registry.register("deploy", deployWorkflow)

    const all = registry.list()
    expect(all[0].name).toBe("deploy")
    expect(all[0].workflow.trigger.commands).toEqual(["/deploy", "/ship"])
    expect(all[0].workflow.steps).toHaveLength(1)
  })
})
