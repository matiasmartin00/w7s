import { describe, it, expect } from "vitest"
import {
  workflowSchema,
  stepSchema,
  aiPromptStepSchema,
  shellStepSchema,
  approvalStepSchema,
  workflowInputSchema,
  workflowTriggerSchema,
  validateWorkflow,
} from "./index.js"

// --- Fixtures ---

const validAiPromptStep = {
  id: "analyze",
  type: "ai_prompt" as const,
  prompt: "Analyze the project",
  agent: "sdd-init",
  output: "analysis",
  output_format: "json" as const,
  description: "Run AI analysis",
  when: "${{ inputs.feature }}",
  retry: 2,
}

const validShellStep = {
  id: "build",
  type: "shell" as const,
  run: "npm run build",
  output: "build_result",
  env: { NODE_ENV: "production" },
  description: "Build the project",
  when: "${{ steps.analyze.output.ready == true }}",
  retry: 1,
}

const validApprovalStep = {
  id: "confirm",
  type: "approval" as const,
  message: "Continue with deployment?",
  description: "User confirms deployment",
  when: "${{ steps.build.output }}",
}

const validWorkflow = {
  name: "deploy",
  description: "Deploy pipeline",
  trigger: { commands: ["/deploy"] },
  inputs: {
    feature: { description: "Feature name", required: true },
    scope: { description: "Scope", required: false, default: "full" },
  },
  steps: [validAiPromptStep, validShellStep, validApprovalStep],
}

// --- Workflow Schema Tests ---

describe("workflowSchema", () => {
  it("parses a valid workflow with all fields", () => {
    const result = workflowSchema.safeParse(validWorkflow)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe("deploy")
      expect(result.data.description).toBe("Deploy pipeline")
      expect(result.data.steps).toHaveLength(3)
      expect(result.data.trigger.commands).toEqual(["/deploy"])
      expect(result.data.inputs?.feature.required).toBe(true)
      expect(result.data.inputs?.scope.default).toBe("full")
    }
  })

  it("parses a minimal workflow (only required fields)", () => {
    const minimal = {
      name: "simple",
      trigger: { commands: ["/simple"] },
      steps: [{ id: "step1", type: "shell", run: "echo hello" }],
    }
    const result = workflowSchema.safeParse(minimal)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe("simple")
      expect(result.data.description).toBeUndefined()
      expect(result.data.inputs).toBeUndefined()
      expect(result.data.steps).toHaveLength(1)
    }
  })

  it("rejects workflow without name", () => {
    const noName = { ...validWorkflow, name: undefined }
    const result = workflowSchema.safeParse(noName)
    expect(result.success).toBe(false)
  })

  it("rejects workflow without steps", () => {
    const { steps: _, ...noSteps } = validWorkflow
    const result = workflowSchema.safeParse(noSteps)
    expect(result.success).toBe(false)
  })

  it("rejects workflow with empty steps array", () => {
    const emptySteps = { ...validWorkflow, steps: [] }
    const result = workflowSchema.safeParse(emptySteps)
    expect(result.success).toBe(false)
  })

  it("rejects workflow without trigger", () => {
    const { trigger: _, ...noTrigger } = validWorkflow
    const result = workflowSchema.safeParse(noTrigger)
    expect(result.success).toBe(false)
  })

  it("allows workflow without description", () => {
    const { description: _, ...noDesc } = validWorkflow
    const result = workflowSchema.safeParse(noDesc)
    expect(result.success).toBe(true)
  })

  it("allows workflow without inputs", () => {
    const { inputs: _, ...noInputs } = validWorkflow
    const result = workflowSchema.safeParse(noInputs)
    expect(result.success).toBe(true)
  })
})

// --- Step Schema Discriminated Union Tests ---

describe("stepSchema (discriminated union)", () => {
  it("parses ai_prompt step", () => {
    const result = stepSchema.safeParse(validAiPromptStep)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe("ai_prompt")
      if (result.data.type === "ai_prompt") {
        expect(result.data.prompt).toBe("Analyze the project")
        expect(result.data.agent).toBe("sdd-init")
        expect(result.data.output_format).toBe("json")
      }
    }
  })

  it("parses shell step", () => {
    const result = stepSchema.safeParse(validShellStep)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe("shell")
      if (result.data.type === "shell") {
        expect(result.data.run).toBe("npm run build")
        expect(result.data.env).toEqual({ NODE_ENV: "production" })
      }
    }
  })

  it("parses approval step", () => {
    const result = stepSchema.safeParse(validApprovalStep)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe("approval")
      if (result.data.type === "approval") {
        expect(result.data.message).toBe("Continue with deployment?")
      }
    }
  })

  it("rejects unknown step type", () => {
    const badStep = { id: "x", type: "unknown", foo: "bar" }
    const result = stepSchema.safeParse(badStep)
    expect(result.success).toBe(false)
  })

  it("correctly narrows ai_prompt type", () => {
    const result = stepSchema.safeParse(validAiPromptStep)
    expect(result.success).toBe(true)
    if (result.success && result.data.type === "ai_prompt") {
      // TypeScript narrowing: prompt is accessible
      expect(result.data.prompt).toBeDefined()
      expect(result.data.output_format).toBe("json")
    }
  })

  it("correctly narrows shell type", () => {
    const result = stepSchema.safeParse(validShellStep)
    expect(result.success).toBe(true)
    if (result.success && result.data.type === "shell") {
      // TypeScript narrowing: run is accessible
      expect(result.data.run).toBeDefined()
      expect(result.data.env).toBeDefined()
    }
  })

  it("correctly narrows approval type", () => {
    const result = stepSchema.safeParse(validApprovalStep)
    expect(result.success).toBe(true)
    if (result.success && result.data.type === "approval") {
      // TypeScript narrowing: message is accessible
      expect(result.data.message).toBeDefined()
    }
  })
})

// --- ai_prompt Step Schema Tests ---

describe("aiPromptStepSchema", () => {
  it("rejects ai_prompt step without prompt", () => {
    const noPrompt = { id: "x", type: "ai_prompt" }
    const result = aiPromptStepSchema.safeParse(noPrompt)
    expect(result.success).toBe(false)
  })

  it("accepts ai_prompt with only required fields", () => {
    const minimal = { id: "x", type: "ai_prompt", prompt: "Do something" }
    const result = aiPromptStepSchema.safeParse(minimal)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.agent).toBeUndefined()
      expect(result.data.output).toBeUndefined()
      expect(result.data.output_format).toBeUndefined()
      expect(result.data.retry).toBeUndefined()
    }
  })

  it("validates output_format enum — text", () => {
    const step = { id: "x", type: "ai_prompt", prompt: "p", output_format: "text" }
    const result = aiPromptStepSchema.safeParse(step)
    expect(result.success).toBe(true)
  })

  it("validates output_format enum — json", () => {
    const step = { id: "x", type: "ai_prompt", prompt: "p", output_format: "json" }
    const result = aiPromptStepSchema.safeParse(step)
    expect(result.success).toBe(true)
  })

  it("rejects invalid output_format value", () => {
    const step = { id: "x", type: "ai_prompt", prompt: "p", output_format: "xml" }
    const result = aiPromptStepSchema.safeParse(step)
    expect(result.success).toBe(false)
  })

  it("validates retry as non-negative integer", () => {
    const valid = { id: "x", type: "ai_prompt", prompt: "p", retry: 3 }
    expect(aiPromptStepSchema.safeParse(valid).success).toBe(true)

    const zero = { id: "x", type: "ai_prompt", prompt: "p", retry: 0 }
    expect(aiPromptStepSchema.safeParse(zero).success).toBe(true)
  })

  it("rejects negative retry", () => {
    const step = { id: "x", type: "ai_prompt", prompt: "p", retry: -1 }
    const result = aiPromptStepSchema.safeParse(step)
    expect(result.success).toBe(false)
  })

  it("rejects fractional retry", () => {
    const step = { id: "x", type: "ai_prompt", prompt: "p", retry: 1.5 }
    const result = aiPromptStepSchema.safeParse(step)
    expect(result.success).toBe(false)
  })

  it("rejects missing id", () => {
    const step = { type: "ai_prompt", prompt: "p" }
    const result = aiPromptStepSchema.safeParse(step)
    expect(result.success).toBe(false)
  })
})

// --- Shell Step Schema Tests ---

describe("shellStepSchema", () => {
  it("rejects shell step without run", () => {
    const noRun = { id: "x", type: "shell" }
    const result = shellStepSchema.safeParse(noRun)
    expect(result.success).toBe(false)
  })

  it("accepts shell with only required fields", () => {
    const minimal = { id: "x", type: "shell", run: "echo hi" }
    const result = shellStepSchema.safeParse(minimal)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.env).toBeUndefined()
      expect(result.data.output).toBeUndefined()
      expect(result.data.retry).toBeUndefined()
    }
  })

  it("accepts shell with env record", () => {
    const step = { id: "x", type: "shell", run: "echo", env: { A: "1", B: "2" } }
    const result = shellStepSchema.safeParse(step)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.env).toEqual({ A: "1", B: "2" })
    }
  })

  it("validates retry as non-negative integer", () => {
    const valid = { id: "x", type: "shell", run: "ls", retry: 2 }
    expect(shellStepSchema.safeParse(valid).success).toBe(true)
  })

  it("rejects negative retry", () => {
    const step = { id: "x", type: "shell", run: "ls", retry: -1 }
    expect(shellStepSchema.safeParse(step).success).toBe(false)
  })

  it("rejects fractional retry", () => {
    const step = { id: "x", type: "shell", run: "ls", retry: 0.5 }
    expect(shellStepSchema.safeParse(step).success).toBe(false)
  })
})

// --- Approval Step Schema Tests ---

describe("approvalStepSchema", () => {
  it("rejects approval step without message", () => {
    const noMsg = { id: "x", type: "approval" }
    const result = approvalStepSchema.safeParse(noMsg)
    expect(result.success).toBe(false)
  })

  it("accepts approval with only required fields", () => {
    const minimal = { id: "x", type: "approval", message: "Continue?" }
    const result = approvalStepSchema.safeParse(minimal)
    expect(result.success).toBe(true)
  })

  it("approval step does not have retry field", () => {
    // Approval steps shouldn't have retry per design — extra fields are stripped
    const step = { id: "x", type: "approval", message: "ok", retry: 3 }
    const result = approvalStepSchema.safeParse(step)
    // Zod strips unknown keys by default — should still parse
    expect(result.success).toBe(true)
  })
})

// --- Trigger Schema Tests ---

describe("workflowTriggerSchema", () => {
  it("accepts trigger with one command", () => {
    const result = workflowTriggerSchema.safeParse({ commands: ["/deploy"] })
    expect(result.success).toBe(true)
  })

  it("accepts trigger with multiple commands", () => {
    const result = workflowTriggerSchema.safeParse({ commands: ["/deploy", "/ship"] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.commands).toHaveLength(2)
    }
  })

  it("rejects trigger with empty commands array", () => {
    const result = workflowTriggerSchema.safeParse({ commands: [] })
    expect(result.success).toBe(false)
  })

  it("rejects trigger without commands", () => {
    const result = workflowTriggerSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// --- Input Schema Tests ---

describe("workflowInputSchema", () => {
  it("accepts input with all fields", () => {
    const result = workflowInputSchema.safeParse({
      description: "Feature name",
      required: true,
      default: "auth",
    })
    expect(result.success).toBe(true)
  })

  it("accepts empty input (all optional)", () => {
    const result = workflowInputSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it("accepts input with only description", () => {
    const result = workflowInputSchema.safeParse({ description: "Name" })
    expect(result.success).toBe(true)
  })
})

// --- validateWorkflow Helper Tests ---

describe("validateWorkflow", () => {
  it("returns success with parsed workflow for valid data", () => {
    const result = validateWorkflow(validWorkflow)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.workflow.name).toBe("deploy")
      expect(result.workflow.steps).toHaveLength(3)
    }
  })

  it("returns failure with ZodError for invalid data", () => {
    const result = validateWorkflow({ name: "bad" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors).toBeDefined()
      expect(result.errors.issues.length).toBeGreaterThan(0)
    }
  })

  it("returns failure for completely invalid input", () => {
    const result = validateWorkflow(null)
    expect(result.success).toBe(false)
  })

  it("returns failure for string input", () => {
    const result = validateWorkflow("not a workflow")
    expect(result.success).toBe(false)
  })
})

// --- Extra fields behavior ---

describe("extra fields handling", () => {
  it("strips unknown fields from workflow (Zod default behavior)", () => {
    const withExtra = {
      ...validWorkflow,
      unknownField: "should be stripped",
    }
    const result = workflowSchema.safeParse(withExtra)
    expect(result.success).toBe(true)
    if (result.success) {
      expect("unknownField" in result.data).toBe(false)
    }
  })

  it("strips unknown fields from steps", () => {
    const stepWithExtra = {
      ...validShellStep,
      unknownField: "should be stripped",
    }
    const result = stepSchema.safeParse(stepWithExtra)
    expect(result.success).toBe(true)
    if (result.success) {
      expect("unknownField" in result.data).toBe(false)
    }
  })
})
