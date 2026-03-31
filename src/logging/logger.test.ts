import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ExecutionLogger } from "./logger.js"
import type { LogEntry } from "./logger.js"
import type { WorkflowResult, StepResult } from "../types/index.js"

// --- Helpers ---

function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    stepId: "step-1",
    status: "completed",
    duration: 100,
    attempts: 1,
    ...overrides,
  }
}

function makeWorkflowResult(overrides: Partial<WorkflowResult> = {}): WorkflowResult {
  return {
    workflow: "test-wf",
    status: "completed",
    steps: [makeStepResult()],
    inputs: { feature: "auth" },
    startedAt: "2026-03-31T10:00:00.000Z",
    completedAt: "2026-03-31T10:00:05.000Z",
    duration: 5000,
    ...overrides,
  }
}

describe("ExecutionLogger", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "w7s-log-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  // --- writeLog ---

  describe("writeLog", () => {
    it("creates a log file with correct content", async () => {
      const logger = new ExecutionLogger(tempDir)
      const result = makeWorkflowResult()

      const filePath = await logger.writeLog("my-wf", result, { feature: "auth" })

      const content = JSON.parse(await readFile(filePath, "utf-8")) as LogEntry
      expect(content.workflow).toBe("my-wf")
      expect(content.status).toBe("completed")
      expect(content.duration).toBe(5000)
      expect(content.inputs).toEqual({ feature: "auth" })
      expect(content.timestamp).toBe("2026-03-31T10:00:00.000Z")
    })

    it("log file name format: {workflow}-{timestamp}.log", async () => {
      const logger = new ExecutionLogger(tempDir)
      const result = makeWorkflowResult({ startedAt: "2026-03-31T10:00:00.000Z" })

      const filePath = await logger.writeLog("sdd", result, {})

      const filename = filePath.split("/").pop()!
      // Colons replaced with dashes for filesystem safety
      expect(filename).toBe("sdd-2026-03-31T10-00-00.000Z.log")
    })

    it("log contains all expected fields", async () => {
      const logger = new ExecutionLogger(tempDir)
      const steps: StepResult[] = [
        makeStepResult({ stepId: "init", status: "completed", output: "hello", duration: 200 }),
        makeStepResult({ stepId: "build", status: "failed", error: "boom", exitCode: 1, duration: 300 }),
      ]
      const result = makeWorkflowResult({
        steps,
        failedStep: "build",
        error: "Step build failed",
      })

      const filePath = await logger.writeLog("test-wf", result, { feature: "auth" })
      const content = JSON.parse(await readFile(filePath, "utf-8")) as LogEntry

      // Top-level fields
      expect(content).toHaveProperty("timestamp")
      expect(content).toHaveProperty("workflow")
      expect(content).toHaveProperty("status")
      expect(content).toHaveProperty("duration")
      expect(content).toHaveProperty("inputs")
      expect(content).toHaveProperty("steps")
      expect(content).toHaveProperty("failedStep", "build")
      expect(content).toHaveProperty("error", "Step build failed")

      // Step fields
      expect(content.steps).toHaveLength(2)
      expect(content.steps[0]).toEqual({
        id: "init",
        status: "completed",
        duration: 200,
        output: "hello",
      })
      expect(content.steps[1]).toEqual({
        id: "build",
        status: "failed",
        duration: 300,
        error: "boom",
        exitCode: 1,
      })
    })

    it("step output is included in log", async () => {
      const logger = new ExecutionLogger(tempDir)
      const steps: StepResult[] = [
        makeStepResult({ stepId: "analyze", output: { modules: ["auth", "db"], count: 2 } }),
      ]
      const result = makeWorkflowResult({ steps })

      const filePath = await logger.writeLog("test-wf", result, {})
      const content = JSON.parse(await readFile(filePath, "utf-8")) as LogEntry

      expect(content.steps[0].output).toEqual({ modules: ["auth", "db"], count: 2 })
    })

    it("failed step info is captured", async () => {
      const logger = new ExecutionLogger(tempDir)
      const result = makeWorkflowResult({
        status: "failed",
        failedStep: "deploy",
        error: "exit code 1",
        steps: [
          makeStepResult({ stepId: "build", status: "completed" }),
          makeStepResult({ stepId: "deploy", status: "failed", error: "exit code 1", exitCode: 1 }),
        ],
      })

      const filePath = await logger.writeLog("deploy-wf", result, {})
      const content = JSON.parse(await readFile(filePath, "utf-8")) as LogEntry

      expect(content.status).toBe("failed")
      expect(content.failedStep).toBe("deploy")
      expect(content.error).toBe("exit code 1")
    })

    it("directory is created if it doesn't exist", async () => {
      const nestedDir = join(tempDir, "nested", "runs")
      const logger = new ExecutionLogger(nestedDir)
      const result = makeWorkflowResult()

      const filePath = await logger.writeLog("test-wf", result, {})

      expect(filePath).toContain(nestedDir)
      const files = await readdir(nestedDir)
      expect(files.length).toBe(1)
    })

    it("omits optional fields when not present", async () => {
      const logger = new ExecutionLogger(tempDir)
      const result = makeWorkflowResult({
        steps: [makeStepResult({ stepId: "s1" })],
        // no failedStep, no error
      })
      // Remove optional fields from result
      delete result.failedStep
      delete result.error

      const filePath = await logger.writeLog("test-wf", result, {})
      const content = JSON.parse(await readFile(filePath, "utf-8")) as LogEntry

      expect(content).not.toHaveProperty("failedStep")
      expect(content).not.toHaveProperty("error")
      // Step should also not have output/error/exitCode if undefined
      expect(content.steps[0]).not.toHaveProperty("output")
      expect(content.steps[0]).not.toHaveProperty("error")
      expect(content.steps[0]).not.toHaveProperty("exitCode")
    })
  })

  // --- rotate ---

  describe("rotate", () => {
    it("keeps only last N logs", async () => {
      const logger = new ExecutionLogger(tempDir, 3)
      const timestamps = [
        "2026-03-31T10:00:00.000Z",
        "2026-03-31T10:01:00.000Z",
        "2026-03-31T10:02:00.000Z",
        "2026-03-31T10:03:00.000Z",
        "2026-03-31T10:04:00.000Z",
      ]

      // Write 5 logs
      for (const ts of timestamps) {
        const result = makeWorkflowResult({ startedAt: ts })
        await logger.writeLog("sdd", result, {})
      }

      const filesBefore = await readdir(tempDir)
      expect(filesBefore.filter((f) => f.startsWith("sdd-"))).toHaveLength(5)

      await logger.rotate("sdd")

      const filesAfter = await readdir(tempDir)
      const sddFiles = filesAfter.filter((f) => f.startsWith("sdd-")).sort()
      expect(sddFiles).toHaveLength(3)

      // Should keep the 3 newest
      expect(sddFiles[0]).toContain("10-02-00")
      expect(sddFiles[1]).toContain("10-03-00")
      expect(sddFiles[2]).toContain("10-04-00")
    })

    it("with fewer than N logs — doesn't delete anything", async () => {
      const logger = new ExecutionLogger(tempDir, 5)

      // Write only 3 logs
      for (let i = 0; i < 3; i++) {
        const result = makeWorkflowResult({
          startedAt: `2026-03-31T10:0${i}:00.000Z`,
        })
        await logger.writeLog("sdd", result, {})
      }

      await logger.rotate("sdd")

      const files = await readdir(tempDir)
      expect(files.filter((f) => f.startsWith("sdd-"))).toHaveLength(3)
    })

    it("only rotates logs for the specified workflow", async () => {
      const logger = new ExecutionLogger(tempDir, 2)

      // Write logs for two different workflows
      for (let i = 0; i < 4; i++) {
        const result = makeWorkflowResult({
          startedAt: `2026-03-31T10:0${i}:00.000Z`,
        })
        await logger.writeLog("sdd", result, {})
        await logger.writeLog("deploy", result, {})
      }

      await logger.rotate("sdd")

      const files = await readdir(tempDir)
      const sddFiles = files.filter((f) => f.startsWith("sdd-"))
      const deployFiles = files.filter((f) => f.startsWith("deploy-"))

      expect(sddFiles).toHaveLength(2)
      expect(deployFiles).toHaveLength(4) // untouched
    })

    it("handles non-existent directory gracefully", async () => {
      const logger = new ExecutionLogger(join(tempDir, "nonexistent"), 3)

      // Should not throw
      await expect(logger.rotate("sdd")).resolves.toBeUndefined()
    })
  })

  // --- getHistory ---

  describe("getHistory", () => {
    it("returns logs sorted by timestamp desc", async () => {
      const logger = new ExecutionLogger(tempDir)
      const timestamps = [
        "2026-03-31T10:00:00.000Z",
        "2026-03-31T10:02:00.000Z",
        "2026-03-31T10:01:00.000Z", // out of order on purpose
      ]

      for (const ts of timestamps) {
        const result = makeWorkflowResult({ startedAt: ts })
        await logger.writeLog("sdd", result, {})
      }

      const history = await logger.getHistory("sdd")

      expect(history).toHaveLength(3)
      // Newest first
      expect(history[0].timestamp).toBe("2026-03-31T10:02:00.000Z")
      expect(history[1].timestamp).toBe("2026-03-31T10:01:00.000Z")
      expect(history[2].timestamp).toBe("2026-03-31T10:00:00.000Z")
    })

    it("with no logs — returns empty array", async () => {
      const logger = new ExecutionLogger(tempDir)

      const history = await logger.getHistory("sdd")

      expect(history).toEqual([])
    })

    it("with no logs and non-existent directory — returns empty array", async () => {
      const logger = new ExecutionLogger(join(tempDir, "nonexistent"))

      const history = await logger.getHistory("sdd")

      expect(history).toEqual([])
    })

    it("only returns logs for the specified workflow", async () => {
      const logger = new ExecutionLogger(tempDir)

      await logger.writeLog(
        "sdd",
        makeWorkflowResult({ startedAt: "2026-03-31T10:00:00.000Z" }),
        {},
      )
      await logger.writeLog(
        "deploy",
        makeWorkflowResult({ startedAt: "2026-03-31T10:01:00.000Z" }),
        {},
      )

      const history = await logger.getHistory("sdd")
      expect(history).toHaveLength(1)
      expect(history[0].workflow).toBe("sdd")
    })

    it("each entry contains full log data", async () => {
      const logger = new ExecutionLogger(tempDir)
      const result = makeWorkflowResult({
        steps: [
          makeStepResult({ stepId: "init", output: "done", duration: 250 }),
        ],
      })

      await logger.writeLog("sdd", result, { feature: "auth" })

      const history = await logger.getHistory("sdd")
      expect(history).toHaveLength(1)

      const entry = history[0]
      expect(entry.workflow).toBe("sdd")
      expect(entry.status).toBe("completed")
      expect(entry.inputs).toEqual({ feature: "auth" })
      expect(entry.steps[0].id).toBe("init")
      expect(entry.steps[0].output).toBe("done")
      expect(entry.steps[0].duration).toBe(250)
    })
  })
})
