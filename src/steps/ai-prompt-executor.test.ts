import { describe, it, expect, vi, beforeEach } from "vitest"
import { AiPromptExecutor } from "./ai-prompt-executor.js"
import type { AiPromptStep, ExecutionContext, PluginInput } from "../types/index.js"

// --- Test Helpers ---

function makeStep(overrides: Partial<AiPromptStep> = {}): AiPromptStep {
  return {
    id: "test-step",
    type: "ai_prompt",
    prompt: "Hello world",
    ...overrides,
  }
}

function makeContext(
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  return {
    inputs: {},
    steps: {},
    workflow: { name: "test-workflow" },
    env: {},
    get(path: string): unknown {
      const parts = path.split(".")
      // biome-ignore lint/suspicious/noExplicitAny: test helper
      let current: any = this
      for (const part of parts) {
        if (current == null) return undefined
        current = current[part]
      }
      return current
    },
    set(_stepId: string, _result: unknown): void {
      // no-op for tests
    },
    ...overrides,
  }
}

type MockClient = PluginInput["client"]

function makeMockClient(overrides: {
  createReturn?: unknown
  promptReturn?: unknown
  createFn?: ReturnType<typeof vi.fn>
  promptFn?: ReturnType<typeof vi.fn>
} = {}): MockClient {
  const defaultSession = {
    id: "test-session-id",
    projectID: "proj",
    directory: "/tmp",
    title: "test",
    version: "1",
    time: { created: 0, updated: 0 },
  }
  const defaultPromptResponse = {
    info: { id: "msg-1", role: "assistant", sessionID: "test-session-id" },
    parts: [
      {
        id: "p1",
        sessionID: "test-session-id",
        messageID: "msg-1",
        type: "text",
        text: "mock response",
      },
    ],
  }

  const createFn =
    overrides.createFn ??
    vi.fn().mockResolvedValue({
      data: overrides.createReturn ?? defaultSession,
    })
  const promptFn =
    overrides.promptFn ??
    vi.fn().mockResolvedValue({
      data: overrides.promptReturn ?? defaultPromptResponse,
    })

  return {
    session: {
      create: createFn,
      prompt: promptFn,
    },
  } as unknown as MockClient
}

// --- Tests ---

describe("AiPromptExecutor", () => {
  let executor: AiPromptExecutor
  let client: MockClient

  beforeEach(() => {
    client = makeMockClient()
    executor = new AiPromptExecutor(client)
  })

  describe("text output", () => {
    it("captures response string as output", async () => {
      const step = makeStep()
      const ctx = makeContext()

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("completed")
      expect(result.output).toBe("mock response")
      expect(result.stepId).toBe("test-step")
      expect(result.attempts).toBe(1)
    })

    it("defaults to text output_format when not specified", async () => {
      const step = makeStep({ output_format: undefined })
      const ctx = makeContext()

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("completed")
      expect(result.output).toBe("mock response")
    })

    it("handles explicit output_format: text", async () => {
      const step = makeStep({ output_format: "text" })
      const ctx = makeContext()

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("completed")
      expect(result.output).toBe("mock response")
    })

    it("concatenates multiple text parts", async () => {
      const step = makeStep()
      const ctx = makeContext()
      const promptReturn = {
        info: { id: "msg-1", role: "assistant", sessionID: "s1" },
        parts: [
          { id: "p1", sessionID: "s1", messageID: "msg-1", type: "text", text: "Hello " },
          { id: "p2", sessionID: "s1", messageID: "msg-1", type: "reasoning", text: "thinking..." },
          { id: "p3", sessionID: "s1", messageID: "msg-1", type: "text", text: "world" },
        ],
      }
      client = makeMockClient({ promptReturn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("completed")
      expect(result.output).toBe("Hello world")
    })
  })

  describe("JSON output", () => {
    it("parses and returns JSON object", async () => {
      const step = makeStep({ output_format: "json" })
      const ctx = makeContext()
      const promptReturn = {
        info: { id: "msg-1", role: "assistant", sessionID: "s1" },
        parts: [
          {
            id: "p1",
            sessionID: "s1",
            messageID: "msg-1",
            type: "text",
            text: '{"modules": ["auth"], "count": 1}',
          },
        ],
      }
      client = makeMockClient({ promptReturn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("completed")
      expect(result.output).toEqual({ modules: ["auth"], count: 1 })
    })

    it("extracts JSON from markdown code fences", async () => {
      const step = makeStep({ output_format: "json" })
      const ctx = makeContext()
      const promptReturn = {
        info: { id: "msg-1", role: "assistant", sessionID: "s1" },
        parts: [
          {
            id: "p1",
            sessionID: "s1",
            messageID: "msg-1",
            type: "text",
            text: 'Here is the result:\n```json\n{"key": "value"}\n```\nHope that helps!',
          },
        ],
      }
      client = makeMockClient({ promptReturn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("completed")
      expect(result.output).toEqual({ key: "value" })
    })

    it("fails when response is not valid JSON", async () => {
      const step = makeStep({ output_format: "json" })
      const ctx = makeContext()
      const promptReturn = {
        info: { id: "msg-1", role: "assistant", sessionID: "s1" },
        parts: [
          {
            id: "p1",
            sessionID: "s1",
            messageID: "msg-1",
            type: "text",
            text: "This is not JSON at all",
          },
        ],
      }
      client = makeMockClient({ promptReturn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("failed")
      expect(result.error).toContain("JSON extraction failed")
    })
  })

  describe("retry", () => {
    it("retries on JSON parse failure and succeeds on second attempt", async () => {
      const step = makeStep({ output_format: "json", retry: 1 })
      const ctx = makeContext()

      let callCount = 0
      const promptFn = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return {
            data: {
              info: { id: "msg-1", role: "assistant", sessionID: "s1" },
              parts: [
                {
                  id: "p1",
                  sessionID: "s1",
                  messageID: "msg-1",
                  type: "text",
                  text: "not json",
                },
              ],
            },
          }
        }
        return {
          data: {
            info: { id: "msg-2", role: "assistant", sessionID: "s2" },
            parts: [
              {
                id: "p2",
                sessionID: "s2",
                messageID: "msg-2",
                type: "text",
                text: '{"success": true}',
              },
            ],
          },
        }
      })

      client = makeMockClient({ promptFn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("completed")
      expect(result.output).toEqual({ success: true })
      expect(result.attempts).toBe(2)
    })

    it("fails after all retries exhausted", async () => {
      const step = makeStep({ output_format: "json", retry: 1 })
      const ctx = makeContext()

      const promptFn = vi.fn().mockResolvedValue({
        data: {
          info: { id: "msg-1", role: "assistant", sessionID: "s1" },
          parts: [
            {
              id: "p1",
              sessionID: "s1",
              messageID: "msg-1",
              type: "text",
              text: "always bad",
            },
          ],
        },
      })

      client = makeMockClient({ promptFn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("failed")
      expect(result.error).toContain("JSON extraction failed")
      expect(result.attempts).toBe(2) // initial + 1 retry
    })
  })

  describe("agent handling", () => {
    it("passes agent to session.prompt when specified", async () => {
      const step = makeStep({ agent: "sdd-init" })
      const ctx = makeContext()

      await executor.execute(step, ctx)

      const promptFn = client.session.prompt as ReturnType<typeof vi.fn>
      expect(promptFn).toHaveBeenCalledWith({
        path: { id: "test-session-id" },
        body: {
          parts: [{ type: "text", text: "Hello world" }],
          agent: "sdd-init",
        },
      })
    })

    it("does not pass agent when not specified", async () => {
      const step = makeStep({ agent: undefined })
      const ctx = makeContext()

      await executor.execute(step, ctx)

      const promptFn = client.session.prompt as ReturnType<typeof vi.fn>
      const callArgs = promptFn.mock.calls[0][0]
      expect(callArgs.body).not.toHaveProperty("agent")
    })
  })

  describe("session isolation (REQ-STEP-AI-003)", () => {
    it("creates a new session for each execution", async () => {
      const step = makeStep()
      const ctx = makeContext()

      let sessionCount = 0
      const createFn = vi.fn().mockImplementation(async () => {
        sessionCount++
        return {
          data: {
            id: `session-${sessionCount}`,
            projectID: "proj",
            directory: "/tmp",
            title: "test",
            version: "1",
            time: { created: 0, updated: 0 },
          },
        }
      })

      client = makeMockClient({ createFn })
      executor = new AiPromptExecutor(client)

      // Execute twice — should create two separate sessions
      await executor.execute(step, ctx)
      await executor.execute(step, ctx)

      expect(createFn).toHaveBeenCalledTimes(2)

      const promptFn = client.session.prompt as ReturnType<typeof vi.fn>
      expect(promptFn.mock.calls[0][0].path.id).toBe("session-1")
      expect(promptFn.mock.calls[1][0].path.id).toBe("session-2")
    })
  })

  describe("prompt interpolation", () => {
    it("interpolates context variables in prompt", async () => {
      const step = makeStep({
        prompt: "Build the ${{ inputs.feature }} feature",
      })
      const ctx = makeContext({
        inputs: { feature: "auth" },
      })

      await executor.execute(step, ctx)

      const promptFn = client.session.prompt as ReturnType<typeof vi.fn>
      const sentParts = promptFn.mock.calls[0][0].body.parts
      expect(sentParts[0].text).toBe("Build the auth feature")
    })

    it("interpolates step output references", async () => {
      const step = makeStep({
        prompt: "Previous result: ${{ steps.init.output }}",
      })
      const ctx = makeContext({
        steps: { init: { output: "some result" } },
      })

      await executor.execute(step, ctx)

      const promptFn = client.session.prompt as ReturnType<typeof vi.fn>
      const sentParts = promptFn.mock.calls[0][0].body.parts
      expect(sentParts[0].text).toBe("Previous result: some result")
    })
  })

  describe("duration tracking", () => {
    it("tracks execution duration in milliseconds", async () => {
      const step = makeStep()
      const ctx = makeContext()

      const result = await executor.execute(step, ctx)

      expect(result.duration).toBeGreaterThanOrEqual(0)
      expect(typeof result.duration).toBe("number")
    })
  })

  describe("error handling", () => {
    it("fails with error message when session creation fails", async () => {
      const step = makeStep()
      const ctx = makeContext()

      const createFn = vi
        .fn()
        .mockResolvedValue({
          data: undefined,
          error: { message: "server error" },
        })
      client = makeMockClient({ createFn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("failed")
      expect(result.error).toContain("Failed to create session")
    })

    it("fails with error message when prompt call returns error", async () => {
      const step = makeStep()
      const ctx = makeContext()

      const promptFn = vi.fn().mockResolvedValue({
        data: undefined,
        error: { message: "prompt failed" },
      })
      client = makeMockClient({ promptFn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("failed")
      expect(result.error).toContain("Failed to send prompt")
    })

    it("fails when session.create throws", async () => {
      const step = makeStep()
      const ctx = makeContext()

      const createFn = vi.fn().mockRejectedValue(new Error("Network error"))
      client = makeMockClient({ createFn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("failed")
      expect(result.error).toBe("Network error")
    })

    it("fails when session.prompt throws", async () => {
      const step = makeStep()
      const ctx = makeContext()

      const promptFn = vi.fn().mockRejectedValue(new Error("API timeout"))
      client = makeMockClient({ promptFn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("failed")
      expect(result.error).toBe("API timeout")
    })
  })

  describe("output storage", () => {
    it("returns output in result when step.output is defined", async () => {
      const step = makeStep({ output: "ai_result" })
      const ctx = makeContext()

      const result = await executor.execute(step, ctx)

      // The executor returns the output in StepResult — the engine is responsible
      // for storing it in context using step.output as the key
      expect(result.status).toBe("completed")
      expect(result.output).toBe("mock response")
    })

    it("returns output even when step.output is not defined", async () => {
      const step = makeStep({ output: undefined })
      const ctx = makeContext()

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("completed")
      expect(result.output).toBe("mock response")
    })
  })

  describe("empty response", () => {
    it("handles empty response parts gracefully", async () => {
      const step = makeStep()
      const ctx = makeContext()

      const promptReturn = {
        info: { id: "msg-1", role: "assistant", sessionID: "s1" },
        parts: [],
      }
      client = makeMockClient({ promptReturn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("completed")
      expect(result.output).toBe("")
    })

    it("handles response with only non-text parts", async () => {
      const step = makeStep()
      const ctx = makeContext()

      const promptReturn = {
        info: { id: "msg-1", role: "assistant", sessionID: "s1" },
        parts: [
          {
            id: "p1",
            sessionID: "s1",
            messageID: "msg-1",
            type: "reasoning",
            text: "thinking...",
          },
        ],
      }
      client = makeMockClient({ promptReturn })
      executor = new AiPromptExecutor(client)

      const result = await executor.execute(step, ctx)

      expect(result.status).toBe("completed")
      expect(result.output).toBe("")
    })
  })
})
