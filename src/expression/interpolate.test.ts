import { describe, it, expect } from "vitest"
import { interpolate } from "./interpolate.js"
import type { ExpressionContext } from "../types/expression.js"

/** Simple context implementation for testing */
function makeContext(
  data: Record<string, unknown>,
): ExpressionContext {
  return {
    get(path: string): unknown {
      const parts = path.split(".")
      let current: unknown = data
      for (const part of parts) {
        if (current == null || typeof current !== "object") {
          return undefined
        }
        current = (current as Record<string, unknown>)[part]
      }
      return current
    },
  }
}

describe("interpolate", () => {
  it("interpolates a simple expression", () => {
    const ctx = makeContext({ inputs: { name: "world" } })
    const result = interpolate("Hello ${{ inputs.name }}", ctx)
    expect(result).toBe("Hello world")
  })

  it("handles multiple expressions in one template", () => {
    const ctx = makeContext({
      inputs: { feature: "auth", scope: "backend" },
    })
    const result = interpolate(
      "Build ${{ inputs.feature }} for ${{ inputs.scope }}",
      ctx,
    )
    expect(result).toBe("Build auth for backend")
  })

  it("converts object result to JSON string", () => {
    const ctx = makeContext({
      steps: {
        init: { output: { modules: ["auth"], count: 1 } },
      },
    })
    const result = interpolate("Result: ${{ steps.init.output }}", ctx)
    expect(result).toBe('Result: {"modules":["auth"],"count":1}')
  })

  it("converts null to empty string", () => {
    const ctx = makeContext({
      steps: { init: { output: null } },
    })
    const result = interpolate("Value: ${{ steps.init.output }}", ctx)
    expect(result).toBe("Value: ")
  })

  it("converts undefined (missing path) to empty string", () => {
    const ctx = makeContext({})
    const result = interpolate("Value: ${{ inputs.missing }}", ctx)
    expect(result).toBe("Value: ")
  })

  it("returns template as-is when no expressions present", () => {
    const ctx = makeContext({})
    const result = interpolate("No expressions here", ctx)
    expect(result).toBe("No expressions here")
  })

  it("handles mixed text and expressions", () => {
    const ctx = makeContext({
      inputs: { feature: "auth" },
      workflow: { name: "sdd" },
    })
    const result = interpolate(
      "Running ${{ workflow.name }} for feature=${{ inputs.feature }}, please wait...",
      ctx,
    )
    expect(result).toBe("Running sdd for feature=auth, please wait...")
  })

  it("handles nested ${{ }} in longer text", () => {
    const ctx = makeContext({
      steps: {
        explore: {
          output: { summary: "found 3 modules" },
        },
      },
    })
    const result = interpolate(
      "Analysis complete. Summary: ${{ steps.explore.output.summary }}. Proceed?",
      ctx,
    )
    expect(result).toBe(
      "Analysis complete. Summary: found 3 modules. Proceed?",
    )
  })

  it("converts number to string", () => {
    const ctx = makeContext({
      steps: { count: { output: 42 } },
    })
    const result = interpolate("Count: ${{ steps.count.output }}", ctx)
    expect(result).toBe("Count: 42")
  })

  it("converts boolean to string", () => {
    const ctx = makeContext({
      steps: { check: { output: true } },
    })
    const result = interpolate("Flag: ${{ steps.check.output }}", ctx)
    expect(result).toBe("Flag: true")
  })

  it("handles expression with whitespace inside ${{ }}", () => {
    const ctx = makeContext({ inputs: { name: "world" } })
    const result = interpolate("Hello ${{   inputs.name   }}", ctx)
    expect(result).toBe("Hello world")
  })

  it("handles array result as JSON", () => {
    const ctx = makeContext({
      steps: { init: { output: ["a", "b", "c"] } },
    })
    const result = interpolate("List: ${{ steps.init.output }}", ctx)
    expect(result).toBe('List: ["a","b","c"]')
  })

  it("handles or fallback in interpolation", () => {
    const ctx = makeContext({
      steps: {
        b: { output: "fallback value" },
      },
    })
    const result = interpolate(
      "Result: ${{ steps.a.output || steps.b.output }}",
      ctx,
    )
    expect(result).toBe("Result: fallback value")
  })

  it("handles empty template string", () => {
    const ctx = makeContext({})
    const result = interpolate("", ctx)
    expect(result).toBe("")
  })
})
