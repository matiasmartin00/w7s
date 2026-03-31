import { describe, it, expect, beforeEach } from "vitest"
import { WorkflowRegistry } from "../loader/index.js"
import type { Workflow } from "../types/index.js"
import type { LoadError } from "../loader/index.js"
import { validateWorkflowCommand } from "./validate.js"
import { dryRunWorkflow } from "./dry-run.js"
import { listWorkflows } from "./list.js"

// --- Fixtures ---

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: "test-wf",
    description: "A test workflow",
    trigger: { commands: ["/test"] },
    inputs: {
      feature: { description: "Feature name", required: true },
      scope: { description: "Scope", default: "full" },
    },
    steps: [
      {
        id: "init",
        type: "ai_prompt",
        prompt: "Analyze ${{ inputs.feature }} with scope ${{ inputs.scope }}",
        agent: "sdd-init",
        output: "project_summary",
        output_format: "json",
      },
      {
        id: "build",
        type: "shell",
        run: "echo building ${{ inputs.feature }}",
        output: "build_result",
      },
      {
        id: "confirm",
        type: "approval",
        message: "Continue? Summary: ${{ steps.init.output }}",
      },
      {
        id: "verify",
        type: "ai_prompt",
        prompt: "Verify: ${{ steps.init.output.summary }}",
        agent: "sdd-verify",
        when: "${{ steps.init.output.has_legacy == true }}",
        retry: 2,
      },
    ],
    ...overrides,
  }
}

function makeRegistry(...workflows: Array<{ name: string; workflow: Workflow }>): WorkflowRegistry {
  const registry = new WorkflowRegistry()
  for (const { name, workflow } of workflows) {
    registry.register(name, workflow)
  }
  return registry
}

// ============================================================
// VALIDATE TESTS
// ============================================================

describe("validateWorkflowCommand", () => {
  let registry: WorkflowRegistry

  beforeEach(() => {
    registry = new WorkflowRegistry()
  })

  it("valid workflow → all checks pass", () => {
    const wf = makeWorkflow()
    registry.register("test-wf", wf)

    const results = validateWorkflowCommand("test-wf", registry, [])

    expect(results).toHaveLength(1)
    expect(results[0].valid).toBe(true)
    expect(results[0].workflow).toBe("test-wf")
    expect(results[0].checks.every((c) => c.passed)).toBe(true)
  })

  it("broken step reference → reference check fails", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "step1",
          type: "ai_prompt",
          prompt: "Use ${{ steps.nonexistent.output }}",
          agent: "test",
        },
      ],
    })
    registry.register("broken", wf)

    const results = validateWorkflowCommand("broken", registry, [])

    expect(results).toHaveLength(1)
    expect(results[0].valid).toBe(false)

    const refCheck = results[0].checks.find((c) => c.name === "step_references")
    expect(refCheck).toBeDefined()
    expect(refCheck!.passed).toBe(false)
    expect(refCheck!.detail).toContain("nonexistent")
  })

  it("load error reported → syntax check fails", () => {
    const wf = makeWorkflow()
    registry.register("with-error", wf)

    const loadErrors: LoadError[] = [
      {
        file: "with-error.yaml",
        error: "YAML parse error: unexpected token",
        type: "parse",
      },
    ]

    const results = validateWorkflowCommand("with-error", registry, loadErrors)

    expect(results).toHaveLength(1)
    const syntaxCheck = results[0].checks.find((c) => c.name === "yaml_syntax")
    expect(syntaxCheck).toBeDefined()
    expect(syntaxCheck!.passed).toBe(false)
    expect(syntaxCheck!.detail).toContain("YAML parse error")
  })

  it("forward reference (step B references step A that comes after) → fails", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "first",
          type: "ai_prompt",
          prompt: "Using output: ${{ steps.second.output }}",
          agent: "test",
        },
        {
          id: "second",
          type: "shell",
          run: "echo hello",
          output: "result",
        },
      ],
    })
    registry.register("forward-ref", wf)

    const results = validateWorkflowCommand("forward-ref", registry, [])

    expect(results).toHaveLength(1)
    expect(results[0].valid).toBe(false)

    const refCheck = results[0].checks.find((c) => c.name === "step_references")
    expect(refCheck!.passed).toBe(false)
    expect(refCheck!.detail).toContain("forward reference")
    expect(refCheck!.detail).toContain('"second"')
  })

  it("input referenced in prompt but not defined → fails", () => {
    const wf = makeWorkflow({
      inputs: {
        feature: { description: "Feature name", required: true },
        // 'scope' is NOT defined
      },
      steps: [
        {
          id: "init",
          type: "ai_prompt",
          prompt: "Feature: ${{ inputs.feature }}, Scope: ${{ inputs.missing_input }}",
          agent: "test",
        },
      ],
    })
    registry.register("missing-input", wf)

    const results = validateWorkflowCommand("missing-input", registry, [])

    expect(results).toHaveLength(1)
    expect(results[0].valid).toBe(false)

    const inputCheck = results[0].checks.find((c) => c.name === "input_references")
    expect(inputCheck!.passed).toBe(false)
    expect(inputCheck!.detail).toContain("missing_input")
  })

  it("single workflow validation targets only that workflow", () => {
    const wf1 = makeWorkflow({
      name: "wf1",
      trigger: { commands: ["/wf1"] },
    })
    const wf2 = makeWorkflow({
      name: "wf2",
      trigger: { commands: ["/wf2"] },
    })
    registry.register("wf1", wf1)
    registry.register("wf2", wf2)

    const results = validateWorkflowCommand("wf1", registry, [])

    expect(results).toHaveLength(1)
    expect(results[0].workflow).toBe("wf1")
  })

  it("all-workflows validation returns results for every workflow", () => {
    const wf1 = makeWorkflow({
      name: "wf1",
      trigger: { commands: ["/wf1"] },
    })
    const wf2 = makeWorkflow({
      name: "wf2",
      trigger: { commands: ["/wf2"] },
    })
    registry.register("wf1", wf1)
    registry.register("wf2", wf2)

    const results = validateWorkflowCommand(undefined, registry, [])

    expect(results).toHaveLength(2)
    const names = results.map((r) => r.workflow)
    expect(names).toContain("wf1")
    expect(names).toContain("wf2")
  })

  it("duplicate triggers between workflows → check fails", () => {
    const wf1 = makeWorkflow({
      name: "wf1",
      trigger: { commands: ["/deploy"] },
      steps: [{ id: "s1", type: "shell", run: "echo a" }],
    })
    const wf2 = makeWorkflow({
      name: "wf2",
      trigger: { commands: ["/deploy"] },
      steps: [{ id: "s2", type: "shell", run: "echo b" }],
    })
    registry.register("wf1", wf1)
    registry.register("wf2", wf2)

    const results = validateWorkflowCommand("wf1", registry, [])

    expect(results).toHaveLength(1)
    expect(results[0].valid).toBe(false)

    const triggerCheck = results[0].checks.find((c) => c.name === "duplicate_triggers")
    expect(triggerCheck!.passed).toBe(false)
    expect(triggerCheck!.detail).toContain("/deploy")
  })

  it("valid backward step reference passes", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "first",
          type: "shell",
          run: "echo hello",
          output: "result",
        },
        {
          id: "second",
          type: "ai_prompt",
          prompt: "Use: ${{ steps.first.output }}",
          agent: "test",
        },
      ],
    })
    registry.register("backward-ref", wf)

    const results = validateWorkflowCommand("backward-ref", registry, [])

    expect(results).toHaveLength(1)
    expect(results[0].valid).toBe(true)

    const refCheck = results[0].checks.find((c) => c.name === "step_references")
    expect(refCheck!.passed).toBe(true)
  })

  it("when condition with step reference checks backward correctly", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "explore",
          type: "ai_prompt",
          prompt: "Explore",
          agent: "test",
          output: "exploration",
          output_format: "json",
        },
        {
          id: "design",
          type: "ai_prompt",
          prompt: "Design",
          agent: "test",
          when: "${{ steps.explore.output.has_legacy == true }}",
        },
      ],
    })
    registry.register("when-ref", wf)

    const results = validateWorkflowCommand("when-ref", registry, [])

    expect(results[0].valid).toBe(true)
  })

  it("workflow with no inputs and no input references → valid", () => {
    const wf = makeWorkflow({
      inputs: undefined,
      steps: [
        {
          id: "s1",
          type: "shell",
          run: "echo hello",
        },
      ],
    })
    registry.register("no-inputs", wf)

    const results = validateWorkflowCommand("no-inputs", registry, [])

    expect(results[0].valid).toBe(true)
  })

  it("or expression with valid step refs passes", () => {
    const wf = makeWorkflow({
      steps: [
        { id: "a", type: "shell", run: "echo a", output: "out_a" },
        { id: "b", type: "shell", run: "echo b", output: "out_b" },
        {
          id: "c",
          type: "ai_prompt",
          prompt: "${{ steps.a.output || steps.b.output }}",
          agent: "test",
        },
      ],
    })
    registry.register("or-expr", wf)

    const results = validateWorkflowCommand("or-expr", registry, [])

    expect(results[0].valid).toBe(true)
  })
})

// ============================================================
// DRY-RUN TESTS
// ============================================================

describe("dryRunWorkflow", () => {
  it("simple workflow with known inputs → prompts fully interpolated", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "init",
          type: "ai_prompt",
          prompt: "Analyze ${{ inputs.feature }} with scope ${{ inputs.scope }}",
          agent: "sdd-init",
        },
      ],
    })
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = dryRunWorkflow("test", { feature: "auth" }, registry)

    expect(result.workflow).toBe("test")
    expect(result.inputs.feature).toBe("auth")
    expect(result.inputs.scope).toBe("full") // default applied
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].prompt).toBe("Analyze auth with scope full")
    expect(result.steps[0].skipped).toBe(false)
  })

  it("references to step outputs → marked as <pending>", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "init",
          type: "ai_prompt",
          prompt: "Analyze ${{ inputs.feature }}",
          agent: "test",
          output: "summary",
        },
        {
          id: "verify",
          type: "ai_prompt",
          prompt: "Verify: ${{ steps.init.output }}",
          agent: "test",
        },
      ],
    })
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = dryRunWorkflow("test", { feature: "auth" }, registry)

    expect(result.steps[0].prompt).toBe("Analyze auth")
    expect(result.steps[1].prompt).toBe("Verify: <pending>")
  })

  it("when condition with known value → resolved", () => {
    const wf = makeWorkflow({
      inputs: {
        feature: { required: true },
      },
      steps: [
        {
          id: "init",
          type: "ai_prompt",
          prompt: "Go",
          agent: "test",
          when: "${{ inputs.feature }}",
        },
      ],
    })
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = dryRunWorkflow("test", { feature: "auth" }, registry)

    expect(result.steps[0].when).toBe("${{ inputs.feature }}")
    expect(result.steps[0].whenResolved).toBe("true")
    expect(result.steps[0].skipped).toBe(false)
  })

  it("when condition with runtime dependency → <pending>", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "init",
          type: "ai_prompt",
          prompt: "Go",
          agent: "test",
          output: "summary",
          output_format: "json",
        },
        {
          id: "design",
          type: "ai_prompt",
          prompt: "Design",
          agent: "test",
          when: "${{ steps.init.output.has_legacy == true }}",
        },
      ],
    })
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = dryRunWorkflow("test", { feature: "auth" }, registry)

    expect(result.steps[1].when).toBe("${{ steps.init.output.has_legacy == true }}")
    expect(result.steps[1].whenResolved).toBe("<pending>")
    expect(result.steps[1].skipped).toBe(false) // pending ≠ false
  })

  it("step with retry → shown in output", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "lint",
          type: "shell",
          run: "npm run lint",
          description: "Running linter",
          retry: 2,
        },
      ],
    })
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = dryRunWorkflow("test", { feature: "auth" }, registry)

    expect(result.steps[0].retry).toBe(2)
    expect(result.steps[0].type).toBe("shell")
    expect(result.steps[0].run).toBe("npm run lint")
    expect(result.steps[0].description).toBe("Running linter")
  })

  it("approval step message is interpolated", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "confirm",
          type: "approval",
          message: "Continue with ${{ inputs.feature }}?",
        },
      ],
    })
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = dryRunWorkflow("test", { feature: "auth" }, registry)

    expect(result.steps[0].message).toBe("Continue with auth?")
    expect(result.steps[0].type).toBe("approval")
  })

  it("throws if workflow not found", () => {
    const registry = new WorkflowRegistry()

    expect(() => dryRunWorkflow("nonexistent", {}, registry)).toThrow(
      'Workflow "nonexistent" not found',
    )
  })

  it("defaults are applied to missing inputs", () => {
    const wf = makeWorkflow()
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = dryRunWorkflow("test", { feature: "auth" }, registry)

    expect(result.inputs.scope).toBe("full")
  })

  it("shell step with interpolation", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "build",
          type: "shell",
          run: "npm run build --feature=${{ inputs.feature }}",
          output: "build_result",
        },
      ],
    })
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = dryRunWorkflow("test", { feature: "auth" }, registry)

    expect(result.steps[0].run).toBe("npm run build --feature=auth")
  })

  it("shows all steps with their type-specific fields", () => {
    const wf = makeWorkflow()
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = dryRunWorkflow("test", { feature: "auth" }, registry)

    expect(result.steps).toHaveLength(4)

    // ai_prompt step
    expect(result.steps[0].type).toBe("ai_prompt")
    expect(result.steps[0].agent).toBe("sdd-init")
    expect(result.steps[0].prompt).toBeDefined()

    // shell step
    expect(result.steps[1].type).toBe("shell")
    expect(result.steps[1].run).toBeDefined()

    // approval step
    expect(result.steps[2].type).toBe("approval")
    expect(result.steps[2].message).toBeDefined()

    // ai_prompt with when + retry
    expect(result.steps[3].type).toBe("ai_prompt")
    expect(result.steps[3].when).toBeDefined()
    expect(result.steps[3].whenResolved).toBe("<pending>")
    expect(result.steps[3].retry).toBe(2)
  })

  it("or expression with step refs → <pending>", () => {
    const wf = makeWorkflow({
      steps: [
        { id: "a", type: "shell", run: "echo a", output: "out_a" },
        { id: "b", type: "shell", run: "echo b", output: "out_b" },
        {
          id: "c",
          type: "ai_prompt",
          prompt: "${{ steps.a.output || steps.b.output }}",
          agent: "test",
        },
      ],
    })
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = dryRunWorkflow("test", { feature: "auth" }, registry)

    expect(result.steps[2].prompt).toBe("<pending>")
  })
})

// ============================================================
// LIST TESTS
// ============================================================

describe("listWorkflows", () => {
  it("multiple workflows → all listed with triggers and inputs", () => {
    const wf1 = makeWorkflow({
      name: "sdd",
      description: "SDD workflow",
      trigger: { commands: ["/sdd", "/run sdd"] },
      inputs: {
        feature: { description: "Feature name", required: true },
        scope: { description: "Scope", default: "full" },
      },
    })
    const wf2 = makeWorkflow({
      name: "deploy",
      description: "Deploy pipeline",
      trigger: { commands: ["/deploy"] },
      inputs: {
        env: { description: "Environment", required: true },
      },
    })
    const registry = makeRegistry(
      { name: "sdd", workflow: wf1 },
      { name: "deploy", workflow: wf2 },
    )

    const result = listWorkflows(registry)

    expect(result).toHaveLength(2)

    const sdd = result.find((r) => r.name === "sdd")
    expect(sdd).toBeDefined()
    expect(sdd!.description).toBe("SDD workflow")
    expect(sdd!.triggers).toEqual(["/sdd", "/run sdd"])
    expect(sdd!.inputs).toHaveLength(2)

    const feature = sdd!.inputs.find((i) => i.name === "feature")
    expect(feature!.required).toBe(true)
    expect(feature!.description).toBe("Feature name")

    const scope = sdd!.inputs.find((i) => i.name === "scope")
    expect(scope!.required).toBe(false)
    expect(scope!.default).toBe("full")

    const deploy = result.find((r) => r.name === "deploy")
    expect(deploy).toBeDefined()
    expect(deploy!.triggers).toEqual(["/deploy"])
    expect(deploy!.inputs).toHaveLength(1)
    expect(deploy!.inputs[0].name).toBe("env")
    expect(deploy!.inputs[0].required).toBe(true)
  })

  it("empty registry → empty list", () => {
    const registry = new WorkflowRegistry()

    const result = listWorkflows(registry)

    expect(result).toEqual([])
  })

  it("workflow with required and optional inputs", () => {
    const wf = makeWorkflow({
      name: "test",
      trigger: { commands: ["/test"] },
      inputs: {
        name: { description: "Name", required: true },
        verbose: { description: "Verbose mode", default: "false" },
        extra: { description: "Extra param" },
      },
    })
    const registry = makeRegistry({ name: "test", workflow: wf })

    const result = listWorkflows(registry)

    expect(result).toHaveLength(1)
    expect(result[0].inputs).toHaveLength(3)

    const nameInput = result[0].inputs.find((i) => i.name === "name")
    expect(nameInput!.required).toBe(true)
    expect(nameInput!.default).toBeUndefined()

    const verboseInput = result[0].inputs.find((i) => i.name === "verbose")
    expect(verboseInput!.required).toBe(false)
    expect(verboseInput!.default).toBe("false")

    const extraInput = result[0].inputs.find((i) => i.name === "extra")
    expect(extraInput!.required).toBe(false)
    expect(extraInput!.default).toBeUndefined()
  })

  it("workflow with no inputs → empty inputs array", () => {
    const wf = makeWorkflow({
      name: "simple",
      trigger: { commands: ["/simple"] },
      inputs: undefined,
    })
    const registry = makeRegistry({ name: "simple", workflow: wf })

    const result = listWorkflows(registry)

    expect(result).toHaveLength(1)
    expect(result[0].inputs).toEqual([])
  })

  it("workflow without description → undefined", () => {
    const wf = makeWorkflow({
      name: "no-desc",
      description: undefined,
      trigger: { commands: ["/nd"] },
    })
    const registry = makeRegistry({ name: "no-desc", workflow: wf })

    const result = listWorkflows(registry)

    expect(result[0].description).toBeUndefined()
  })
})
