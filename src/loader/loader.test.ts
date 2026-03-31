import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadWorkflows } from "./loader.js"

// --- Helpers ---

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "w7s-loader-test-"))
}

function writeYaml(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, "utf-8")
}

// --- Fixtures ---

const validWorkflowYaml = `
name: deploy
description: Deploy pipeline
trigger:
  commands:
    - /deploy
inputs:
  feature:
    description: Feature name
    required: true
steps:
  - id: build
    type: shell
    run: echo building
    output: build_result
`

const validWorkflow2Yaml = `
name: test
description: Test runner
trigger:
  commands:
    - /test
steps:
  - id: run
    type: shell
    run: npm test
`

const invalidYamlSyntax = `
name: bad
  trigger: {
    - broken yaml !!! [
`

const missingStepsYaml = `
name: incomplete
trigger:
  commands:
    - /incomplete
`

const unknownStepTypeYaml = `
name: badstep
trigger:
  commands:
    - /badstep
steps:
  - id: x
    type: unknown_type
    foo: bar
`

const duplicateTriggerA = `
name: workflow-a
trigger:
  commands:
    - /shared
steps:
  - id: a1
    type: shell
    run: echo a
`

const duplicateTriggerB = `
name: workflow-b
trigger:
  commands:
    - /shared
steps:
  - id: b1
    type: shell
    run: echo b
`

// --- Tests ---

describe("loadWorkflows", () => {
  let localDir: string
  let globalDir: string

  beforeEach(() => {
    localDir = createTmpDir()
    globalDir = createTmpDir()
  })

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true })
    rmSync(globalDir, { recursive: true, force: true })
  })

  it("loads a valid workflow from local directory", () => {
    writeYaml(localDir, "deploy.yaml", validWorkflowYaml)

    const result = loadWorkflows(localDir, globalDir)

    expect(result.errors).toHaveLength(0)
    expect(result.workflows.size).toBe(1)

    const wf = result.workflows.get("deploy")
    expect(wf).toBeDefined()
    expect(wf!.name).toBe("deploy")
    expect(wf!.trigger.commands).toEqual(["/deploy"])
    expect(wf!.steps).toHaveLength(1)
  })

  it("loads a valid workflow from global directory", () => {
    writeYaml(globalDir, "test.yaml", validWorkflow2Yaml)

    const result = loadWorkflows(localDir, globalDir)

    expect(result.errors).toHaveLength(0)
    expect(result.workflows.size).toBe(1)
    expect(result.workflows.get("test")?.name).toBe("test")
  })

  it("loads workflows from both local and global directories", () => {
    writeYaml(localDir, "deploy.yaml", validWorkflowYaml)
    writeYaml(globalDir, "test.yaml", validWorkflow2Yaml)

    const result = loadWorkflows(localDir, globalDir)

    expect(result.errors).toHaveLength(0)
    expect(result.workflows.size).toBe(2)
    expect(result.workflows.has("deploy")).toBe(true)
    expect(result.workflows.has("test")).toBe(true)
  })

  it("reports parse error for invalid YAML syntax", () => {
    writeYaml(localDir, "broken.yaml", invalidYamlSyntax)

    const result = loadWorkflows(localDir, globalDir)

    expect(result.workflows.size).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].type).toBe("parse")
    expect(result.errors[0].error).toContain("YAML parse error")
  })

  it("reports validation error for missing required fields", () => {
    writeYaml(localDir, "incomplete.yaml", missingStepsYaml)

    const result = loadWorkflows(localDir, globalDir)

    expect(result.workflows.size).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].type).toBe("validation")
    expect(result.errors[0].error).toContain("Validation failed")
  })

  it("reports validation error for unknown step type", () => {
    writeYaml(localDir, "badstep.yaml", unknownStepTypeYaml)

    const result = loadWorkflows(localDir, globalDir)

    expect(result.workflows.size).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].type).toBe("validation")
  })

  it("local overrides global workflow with same filename", () => {
    const localVersion = `
name: sdd-local
trigger:
  commands:
    - /sdd
steps:
  - id: local-step
    type: shell
    run: echo local
`
    const globalVersion = `
name: sdd-global
trigger:
  commands:
    - /sdd
steps:
  - id: global-step
    type: shell
    run: echo global
`
    writeYaml(localDir, "sdd.yaml", localVersion)
    writeYaml(globalDir, "sdd.yaml", globalVersion)

    const result = loadWorkflows(localDir, globalDir)

    expect(result.errors).toHaveLength(0)
    expect(result.workflows.size).toBe(1)

    const wf = result.workflows.get("sdd")
    expect(wf).toBeDefined()
    expect(wf!.name).toBe("sdd-local")
  })

  it("detects trigger conflict between different workflows — neither loaded", () => {
    writeYaml(localDir, "workflow-a.yaml", duplicateTriggerA)
    writeYaml(localDir, "workflow-b.yaml", duplicateTriggerB)

    const result = loadWorkflows(localDir, globalDir)

    // Neither workflow should be loaded
    expect(result.workflows.size).toBe(0)
    // Should have a conflict error
    const conflictErrors = result.errors.filter((e) => e.type === "conflict")
    expect(conflictErrors.length).toBeGreaterThan(0)
    expect(conflictErrors[0].error).toContain("workflow-a")
    expect(conflictErrors[0].error).toContain("workflow-b")
  })

  it("returns empty result with no errors for empty directories", () => {
    const result = loadWorkflows(localDir, globalDir)

    expect(result.workflows.size).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it("loads valid workflows and reports errors for invalid ones (mixed)", () => {
    writeYaml(localDir, "good.yaml", validWorkflowYaml)
    writeYaml(localDir, "bad.yaml", invalidYamlSyntax)
    writeYaml(localDir, "incomplete.yaml", missingStepsYaml)

    const result = loadWorkflows(localDir, globalDir)

    // Valid one should be loaded
    expect(result.workflows.size).toBe(1)
    expect(result.workflows.has("good")).toBe(true)
    // Two errors for the invalid files
    expect(result.errors).toHaveLength(2)
  })

  it("handles .yml extension the same as .yaml", () => {
    writeYaml(localDir, "deploy.yml", validWorkflowYaml)

    const result = loadWorkflows(localDir, globalDir)

    expect(result.errors).toHaveLength(0)
    expect(result.workflows.size).toBe(1)
    expect(result.workflows.has("deploy")).toBe(true)
  })

  it("returns empty result (no crash) when directories do not exist", () => {
    const result = loadWorkflows("/nonexistent/local", "/nonexistent/global")

    expect(result.workflows.size).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it("ignores non-yaml files in directories", () => {
    writeYaml(localDir, "deploy.yaml", validWorkflowYaml)
    writeFileSync(join(localDir, "readme.md"), "# readme", "utf-8")
    writeFileSync(join(localDir, "config.json"), "{}", "utf-8")

    const result = loadWorkflows(localDir, globalDir)

    expect(result.workflows.size).toBe(1)
    expect(result.errors).toHaveLength(0)
  })

  it("detects trigger conflict across local and global directories", () => {
    // Different filenames but same trigger command
    const localWf = `
name: local-deploy
trigger:
  commands:
    - /deploy
steps:
  - id: s1
    type: shell
    run: echo local
`
    const globalWf = `
name: global-deploy
trigger:
  commands:
    - /deploy
steps:
  - id: s1
    type: shell
    run: echo global
`
    writeYaml(localDir, "local-deploy.yaml", localWf)
    writeYaml(globalDir, "global-deploy.yaml", globalWf)

    const result = loadWorkflows(localDir, globalDir)

    // Both have different filenames so both get loaded to merge, but trigger conflicts
    expect(result.workflows.size).toBe(0)
    const conflictErrors = result.errors.filter((e) => e.type === "conflict")
    expect(conflictErrors.length).toBeGreaterThan(0)
  })

  it("handles workflow with multiple trigger commands", () => {
    const multiTrigger = `
name: multi
trigger:
  commands:
    - /multi
    - /m
steps:
  - id: s1
    type: shell
    run: echo multi
`
    writeYaml(localDir, "multi.yaml", multiTrigger)

    const result = loadWorkflows(localDir, globalDir)

    expect(result.errors).toHaveLength(0)
    expect(result.workflows.size).toBe(1)
    expect(result.workflows.get("multi")?.trigger.commands).toEqual(["/multi", "/m"])
  })
})
