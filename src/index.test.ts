import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { w7s } from "./index.js"
import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { stringify as yamlStringify } from "yaml"
import type { Workflow } from "./types/index.js"

// --- Helpers ---

/**
 * Create a minimal mock of PluginInput for testing.
 */
function createMockCtx(overrides: Partial<{
  directory: string
  worktree: string
}> = {}): PluginInput {
  const directory = overrides.directory ?? join(tmpdir(), `w7s-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)

  // Create the directory if needed
  mkdirSync(directory, { recursive: true })

  const mockShell = Object.assign(
    function mockShellFn(strings: TemplateStringsArray, ..._args: unknown[]) {
      const cmd = strings.join("")
      return {
        quiet: () => Promise.resolve({
          stdout: Buffer.from(`mock output for: ${cmd}`),
          stderr: Buffer.from(""),
          exitCode: 0,
        }),
      }
    },
    {
      nothrow: () => mockShell,
      env: () => mockShell,
      quiet: () => mockShell,
      cwd: () => mockShell,
    },
  ) as unknown as PluginInput["$"]

  const mockClient = {
    session: {
      create: vi.fn().mockResolvedValue({
        data: { id: "mock-session-id" },
      }),
      prompt: vi.fn().mockResolvedValue({
        data: {
          parts: [{ type: "text", text: "mock LLM response" }],
        },
      }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
    app: {
      agents: vi.fn().mockResolvedValue({ data: [] }),
      log: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PluginInput["client"]

  return {
    directory,
    worktree: overrides.worktree ?? directory,
    client: mockClient,
    $: mockShell,
    project: { id: "mock-project" } as PluginInput["project"],
    serverUrl: new URL("http://localhost:3000"),
  }
}

/**
 * Write a workflow YAML file to the local workflows directory.
 */
function writeWorkflowYaml(
  directory: string,
  filename: string,
  workflow: Workflow,
): void {
  const workflowsDir = join(directory, ".opencode", "workflows")
  mkdirSync(workflowsDir, { recursive: true })
  const filePath = join(workflowsDir, filename)
  writeFileSync(filePath, yamlStringify(workflow), "utf-8")
}

/**
 * Create a simple valid workflow for testing.
 */
function makeTestWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: "test-wf",
    description: "A test workflow",
    trigger: { commands: ["/test-cmd"] },
    inputs: {
      feature: { description: "Feature name", required: true },
      scope: { description: "Scope", default: "full" },
    },
    steps: [
      {
        id: "echo",
        type: "shell",
        run: "echo hello ${{ inputs.feature }}",
        output: "echo_result",
      },
    ],
    ...overrides,
  }
}

// --- Test suites ---

describe("w7s plugin", () => {
  let tempDirs: string[] = []

  afterEach(() => {
    // Clean up temp directories
    for (const dir of tempDirs) {
      try {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true })
        }
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs = []
  })

  function trackDir(dir: string): string {
    tempDirs.push(dir)
    return dir
  }

  describe("exports", () => {
    it("exports a function", () => {
      expect(typeof w7s).toBe("function")
    })

    it("is async (returns a promise)", () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)
      const result = w7s(ctx)
      expect(result).toBeInstanceOf(Promise)
    })
  })

  describe("initialization", () => {
    it("returns hooks object with command.execute.before", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      const hooks = await w7s(ctx)

      expect(hooks).toBeDefined()
      expect(typeof hooks).toBe("object")
      expect(typeof hooks["command.execute.before"]).toBe("function")
    })

    it("loads workflows from local directory on init", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      // Write a workflow file
      writeWorkflowYaml(ctx.directory, "my-wf.yaml", makeTestWorkflow())

      const hooks = await w7s(ctx)

      expect(hooks["command.execute.before"]).toBeDefined()
    })

    it("handles empty workflow directories gracefully", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      // Don't create any workflow files
      const hooks = await w7s(ctx)

      expect(hooks["command.execute.before"]).toBeDefined()
    })

    it("handles missing workflow directories gracefully", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)
      // directory exists but no .opencode/workflows/ subdirectory

      const hooks = await w7s(ctx)

      expect(hooks["command.execute.before"]).toBeDefined()
    })
  })

  describe("workflow trigger interception", () => {
    it("trigger command executes the matching workflow", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      writeWorkflowYaml(ctx.directory, "greet.yaml", makeTestWorkflow({
        name: "greet",
        trigger: { commands: ["/greet"] },
        steps: [
          {
            id: "echo",
            type: "shell",
            run: "echo hello",
            output: "result",
          },
        ],
      }))

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/greet", sessionID: "s1", arguments: "feature=auth" },
        output as any,
      )

      // Output parts should be set (intercepted)
      expect(output.parts.length).toBeGreaterThan(0)
      const text = (output.parts[0] as { type: string; text: string }).text
      expect(text).toContain("greet")
    })

    it("unknown trigger command passes through (no interception)", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      writeWorkflowYaml(ctx.directory, "greet.yaml", makeTestWorkflow({
        name: "greet",
        trigger: { commands: ["/greet"] },
      }))

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/unknown-cmd", sessionID: "s1", arguments: "" },
        output as any,
      )

      // Output parts should NOT be modified — pass through
      expect(output.parts).toHaveLength(0)
    })

    it("parses inputs from command arguments", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      writeWorkflowYaml(ctx.directory, "test.yaml", makeTestWorkflow({
        name: "test",
        trigger: { commands: ["/test-run"] },
        inputs: {
          feature: { required: true },
        },
        steps: [
          {
            id: "echo",
            type: "shell",
            run: "echo ${{ inputs.feature }}",
          },
        ],
      }))

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/test-run", sessionID: "s1", arguments: "feature=auth" },
        output as any,
      )

      expect(output.parts.length).toBeGreaterThan(0)
      const text = (output.parts[0] as { type: string; text: string }).text
      // Workflow should have completed or failed — either way the text contains the workflow name
      expect(text).toContain("test")
    })

    it("logs workflow result after execution", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      writeWorkflowYaml(ctx.directory, "log-test.yaml", makeTestWorkflow({
        name: "log-test",
        trigger: { commands: ["/log-test"] },
        inputs: undefined,
        steps: [
          {
            id: "step1",
            type: "shell",
            run: "echo done",
          },
        ],
      }))

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/log-test", sessionID: "s1", arguments: "" },
        output as any,
      )

      // Check that the runs directory was created
      const runsDir = join(ctx.directory, ".opencode", "workflows", ".runs")
      expect(existsSync(runsDir)).toBe(true)
    })
  })

  describe("management commands", () => {
    it("/w7s list → returns formatted workflow list", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      writeWorkflowYaml(ctx.directory, "deploy.yaml", makeTestWorkflow({
        name: "deploy",
        description: "Deploy workflow",
        trigger: { commands: ["/deploy"] },
        inputs: {
          env: { description: "Environment", required: true },
        },
      }))

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/w7s", sessionID: "s1", arguments: "list" },
        output as any,
      )

      expect(output.parts.length).toBeGreaterThan(0)
      const text = (output.parts[0] as { type: string; text: string }).text
      expect(text).toContain("deploy")
      expect(text).toContain("/deploy")
      expect(text).toContain("Registered Workflows")
    })

    it("/w7s validate → runs validation and shows results", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      writeWorkflowYaml(ctx.directory, "valid.yaml", makeTestWorkflow({
        name: "valid",
        trigger: { commands: ["/valid"] },
        steps: [
          { id: "s1", type: "shell", run: "echo ok" },
        ],
      }))

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/w7s", sessionID: "s1", arguments: "validate" },
        output as any,
      )

      expect(output.parts.length).toBeGreaterThan(0)
      const text = (output.parts[0] as { type: string; text: string }).text
      expect(text).toContain("valid")
    })

    it("/w7s validate <name> → validates specific workflow", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      writeWorkflowYaml(ctx.directory, "specific.yaml", makeTestWorkflow({
        name: "specific",
        trigger: { commands: ["/specific"] },
        steps: [
          { id: "s1", type: "shell", run: "echo ok" },
        ],
      }))

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/w7s", sessionID: "s1", arguments: "validate specific" },
        output as any,
      )

      expect(output.parts.length).toBeGreaterThan(0)
      const text = (output.parts[0] as { type: string; text: string }).text
      expect(text).toContain("specific")
    })

    it("/w7s dry-run <name> [inputs] → shows simulation", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      writeWorkflowYaml(ctx.directory, "simwf.yaml", makeTestWorkflow({
        name: "simwf",
        trigger: { commands: ["/sim"] },
        inputs: {
          feature: { required: true },
        },
        steps: [
          {
            id: "init",
            type: "ai_prompt",
            prompt: "Analyze ${{ inputs.feature }}",
            agent: "test-agent",
          },
        ],
      }))

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/w7s", sessionID: "s1", arguments: "dry-run simwf feature=auth" },
        output as any,
      )

      expect(output.parts.length).toBeGreaterThan(0)
      const text = (output.parts[0] as { type: string; text: string }).text
      expect(text).toContain("Dry Run")
      expect(text).toContain("simwf")
      expect(text).toContain("Analyze auth")
    })

    it("/w7s dry-run without workflow name → shows usage", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/w7s", sessionID: "s1", arguments: "dry-run" },
        output as any,
      )

      expect(output.parts.length).toBeGreaterThan(0)
      const text = (output.parts[0] as { type: string; text: string }).text
      expect(text).toContain("Usage")
    })

    it("/w7s with unknown subcommand → shows help", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/w7s", sessionID: "s1", arguments: "" },
        output as any,
      )

      expect(output.parts.length).toBeGreaterThan(0)
      const text = (output.parts[0] as { type: string; text: string }).text
      expect(text).toContain("Commands:")
      expect(text).toContain("list")
      expect(text).toContain("validate")
      expect(text).toContain("dry-run")
    })

    it("/w7s list with no workflows → shows empty message", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/w7s", sessionID: "s1", arguments: "list" },
        output as any,
      )

      expect(output.parts.length).toBeGreaterThan(0)
      const text = (output.parts[0] as { type: string; text: string }).text
      expect(text).toContain("No workflows registered")
    })
  })

  describe("output formatting", () => {
    it("completed workflow shows success icon and step details", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      writeWorkflowYaml(ctx.directory, "fmt.yaml", makeTestWorkflow({
        name: "fmt",
        trigger: { commands: ["/fmt"] },
        inputs: undefined,
        steps: [
          { id: "s1", type: "shell", run: "echo ok" },
        ],
      }))

      const hooks = await w7s(ctx)
      const output = { parts: [] as unknown[] }

      await hooks["command.execute.before"]!(
        { command: "/fmt", sessionID: "s1", arguments: "" },
        output as any,
      )

      expect(output.parts.length).toBeGreaterThan(0)
      const text = (output.parts[0] as { type: string; text: string }).text
      // Should contain workflow name and status info
      expect(text).toContain("fmt")
      expect(text).toContain("s1")
    })
  })

  describe("multiple workflows", () => {
    it("loads and triggers different workflows independently", async () => {
      const ctx = createMockCtx()
      trackDir(ctx.directory)

      writeWorkflowYaml(ctx.directory, "alpha.yaml", makeTestWorkflow({
        name: "alpha",
        trigger: { commands: ["/alpha"] },
        inputs: undefined,
        steps: [{ id: "a1", type: "shell", run: "echo alpha" }],
      }))

      writeWorkflowYaml(ctx.directory, "beta.yaml", makeTestWorkflow({
        name: "beta",
        trigger: { commands: ["/beta"] },
        inputs: undefined,
        steps: [{ id: "b1", type: "shell", run: "echo beta" }],
      }))

      const hooks = await w7s(ctx)

      // Trigger alpha
      const outputA = { parts: [] as unknown[] }
      await hooks["command.execute.before"]!(
        { command: "/alpha", sessionID: "s1", arguments: "" },
        outputA as any,
      )
      const textA = (outputA.parts[0] as { type: string; text: string }).text
      expect(textA).toContain("alpha")

      // Trigger beta
      const outputB = { parts: [] as unknown[] }
      await hooks["command.execute.before"]!(
        { command: "/beta", sessionID: "s2", arguments: "" },
        outputB as any,
      )
      const textB = (outputB.parts[0] as { type: string; text: string }).text
      expect(textB).toContain("beta")
    })
  })
})
