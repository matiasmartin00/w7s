import { describe, it, expect } from "vitest"
import type {
  // Workflow types
  StepType,
  OutputFormat,
  StepBase,
  AiPromptStep,
  ShellStep,
  ApprovalStep,
  Step,
  WorkflowInput,
  WorkflowTrigger,
  Workflow,
  // Execution types
  ExecutionStatus,
  StepStatus,
  StepResult,
  WorkflowResult,
  ExecutionContext,
  // Expression types
  AccessNode,
  OrNode,
  ComparisonNode,
  LiteralNode,
  ASTNode,
  ExpressionContext,
  // Plugin types
  PluginInput,
  Hooks,
  // Step executor
  StepExecutor,
} from "./index.js"

describe("Workflow types", () => {
  it("creates a valid AiPromptStep", () => {
    const step: AiPromptStep = {
      id: "generate",
      type: "ai_prompt",
      prompt: "Generate code for ${{ inputs.feature }}",
      agent: "coder",
      output: "generated_code",
      output_format: "json",
      description: "Generate the code",
      when: "${{ inputs.feature != '' }}",
      retry: 2,
    }
    expect(step.type).toBe("ai_prompt")
    expect(step.id).toBe("generate")
  })

  it("creates a valid ShellStep", () => {
    const step: ShellStep = {
      id: "build",
      type: "shell",
      run: "npm run build",
      output: "build_output",
      env: { NODE_ENV: "production" },
      description: "Build the project",
    }
    expect(step.type).toBe("shell")
    expect(step.run).toBe("npm run build")
  })

  it("creates a valid ApprovalStep", () => {
    const step: ApprovalStep = {
      id: "confirm",
      type: "approval",
      message: "Deploy to production?",
      description: "Get user confirmation",
    }
    expect(step.type).toBe("approval")
    expect(step.message).toBe("Deploy to production?")
  })

  it("discriminated union narrows Step by type field", () => {
    const steps: Step[] = [
      { id: "ai", type: "ai_prompt", prompt: "Do something" },
      { id: "sh", type: "shell", run: "echo hello" },
      { id: "ap", type: "approval", message: "Continue?" },
    ]

    for (const step of steps) {
      switch (step.type) {
        case "ai_prompt":
          // TypeScript narrows to AiPromptStep — prompt is accessible
          expect(step.prompt).toBeDefined()
          break
        case "shell":
          // TypeScript narrows to ShellStep — run is accessible
          expect(step.run).toBeDefined()
          break
        case "approval":
          // TypeScript narrows to ApprovalStep — message is accessible
          expect(step.message).toBeDefined()
          break
      }
    }
  })

  it("creates a valid Workflow", () => {
    const workflow: Workflow = {
      name: "deploy",
      description: "Deploy to production",
      trigger: { commands: ["/deploy", "/ship"] },
      inputs: {
        env: { description: "Target environment", required: true },
        dry_run: { description: "Dry run mode", default: "false" },
      },
      steps: [
        { id: "build", type: "shell", run: "npm run build" },
        { id: "confirm", type: "approval", message: "Deploy?" },
        {
          id: "deploy",
          type: "ai_prompt",
          prompt: "Deploy the build",
          output_format: "text",
        },
      ],
    }
    expect(workflow.name).toBe("deploy")
    expect(workflow.steps).toHaveLength(3)
    expect(workflow.trigger.commands).toContain("/deploy")
  })

  it("creates a workflow with minimal fields", () => {
    const workflow: Workflow = {
      name: "simple",
      trigger: { commands: ["/simple"] },
      steps: [{ id: "run", type: "shell", run: "echo done" }],
    }
    expect(workflow.description).toBeUndefined()
    expect(workflow.inputs).toBeUndefined()
  })

  it("StepType literal accepts valid values", () => {
    const types: StepType[] = ["ai_prompt", "shell", "approval"]
    expect(types).toHaveLength(3)
  })

  it("OutputFormat literal accepts valid values", () => {
    const formats: OutputFormat[] = ["text", "json"]
    expect(formats).toHaveLength(2)
  })

  it("WorkflowInput has optional fields", () => {
    const input: WorkflowInput = {}
    expect(input.description).toBeUndefined()
    expect(input.required).toBeUndefined()
    expect(input.default).toBeUndefined()
  })
})

describe("Execution types", () => {
  it("creates a valid StepResult", () => {
    const result: StepResult = {
      stepId: "build",
      status: "completed",
      output: "Build successful",
      exitCode: 0,
      duration: 1234,
      attempts: 1,
    }
    expect(result.status).toBe("completed")
    expect(result.exitCode).toBe(0)
  })

  it("creates a failed StepResult with error", () => {
    const result: StepResult = {
      stepId: "deploy",
      status: "failed",
      error: "Connection refused",
      duration: 500,
      attempts: 3,
    }
    expect(result.status).toBe("failed")
    expect(result.error).toBe("Connection refused")
    expect(result.output).toBeUndefined()
  })

  it("StepStatus accepts all valid values", () => {
    const statuses: StepStatus[] = [
      "pending",
      "running",
      "completed",
      "skipped",
      "failed",
    ]
    expect(statuses).toHaveLength(5)
  })

  it("creates a valid WorkflowResult", () => {
    const result: WorkflowResult = {
      workflow: "deploy",
      status: "completed",
      steps: [
        {
          stepId: "build",
          status: "completed",
          output: "ok",
          duration: 100,
          attempts: 1,
        },
      ],
      inputs: { env: "production" },
      startedAt: "2026-03-31T12:00:00Z",
      completedAt: "2026-03-31T12:01:00Z",
      duration: 60000,
    }
    expect(result.status).toBe("completed")
    expect(result.failedStep).toBeUndefined()
  })

  it("creates a failed WorkflowResult", () => {
    const result: WorkflowResult = {
      workflow: "deploy",
      status: "failed",
      steps: [],
      inputs: {},
      startedAt: "2026-03-31T12:00:00Z",
      completedAt: "2026-03-31T12:00:05Z",
      duration: 5000,
      failedStep: "build",
      error: "Exit code 1",
    }
    expect(result.failedStep).toBe("build")
    expect(result.error).toBeDefined()
  })

  it("ExecutionStatus accepts all valid values", () => {
    const statuses: ExecutionStatus[] = [
      "running",
      "completed",
      "failed",
      "cancelled",
    ]
    expect(statuses).toHaveLength(4)
  })
})

describe("Expression types", () => {
  it("creates an AccessNode", () => {
    const node: AccessNode = {
      type: "access",
      path: ["steps", "init", "output", "has_legacy"],
    }
    expect(node.type).toBe("access")
    expect(node.path).toHaveLength(4)
  })

  it("creates an OrNode", () => {
    const node: OrNode = {
      type: "or",
      left: { type: "access", path: ["inputs", "name"] },
      right: { type: "literal", value: "default" },
    }
    expect(node.type).toBe("or")
  })

  it("creates a ComparisonNode", () => {
    const node: ComparisonNode = {
      type: "comparison",
      op: "==",
      left: { type: "access", path: ["inputs", "env"] },
      right: { type: "literal", value: "production" },
    }
    expect(node.op).toBe("==")
  })

  it("creates a LiteralNode with different value types", () => {
    const strNode: LiteralNode = { type: "literal", value: "hello" }
    const boolNode: LiteralNode = { type: "literal", value: true }
    const numNode: LiteralNode = { type: "literal", value: 42 }

    expect(strNode.value).toBe("hello")
    expect(boolNode.value).toBe(true)
    expect(numNode.value).toBe(42)
  })

  it("ASTNode union narrows by type field", () => {
    const nodes: ASTNode[] = [
      { type: "access", path: ["x"] },
      { type: "or", left: { type: "literal", value: "a" }, right: { type: "literal", value: "b" } },
      { type: "comparison", op: "!=", left: { type: "literal", value: 1 }, right: { type: "literal", value: 2 } },
      { type: "literal", value: true },
    ]

    for (const node of nodes) {
      switch (node.type) {
        case "access":
          expect(node.path).toBeDefined()
          break
        case "or":
          expect(node.left).toBeDefined()
          expect(node.right).toBeDefined()
          break
        case "comparison":
          expect(node.op).toBeDefined()
          expect(node.left).toBeDefined()
          break
        case "literal":
          expect(node.value).toBeDefined()
          break
      }
    }
  })
})

describe("StepExecutor interface", () => {
  it("can be implemented with a generic step type", () => {
    // A mock executor that satisfies the interface
    const executor: StepExecutor<ShellStep> = {
      execute: async (step, _context) => ({
        stepId: step.id,
        status: "completed",
        output: "done",
        exitCode: 0,
        duration: 100,
        attempts: 1,
      }),
    }

    expect(typeof executor.execute).toBe("function")
  })

  it("can be implemented with the base Step union", () => {
    const executor: StepExecutor = {
      execute: async (step, _context) => ({
        stepId: step.id,
        status: "completed",
        duration: 50,
        attempts: 1,
      }),
    }

    expect(typeof executor.execute).toBe("function")
  })
})

describe("Plugin types re-export", () => {
  it("PluginInput type is importable", () => {
    // This compiles = type exists and is correctly re-exported
    const _input: PluginInput = {} as PluginInput
    expect(_input).toBeDefined()
  })

  it("Hooks type is importable", () => {
    const _hooks: Hooks = {} as Hooks
    expect(_hooks).toBeDefined()
  })
})
