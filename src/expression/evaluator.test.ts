import { describe, it, expect } from "vitest"
import { evaluate } from "./evaluator.js"
import type { ASTNode } from "../types/expression.js"
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

describe("evaluator", () => {
  it("resolves simple access from context", () => {
    const ctx = makeContext({
      steps: { init: { output: "hello world" } },
    })
    const node: ASTNode = {
      type: "access",
      path: ["steps", "init", "output"],
    }
    expect(evaluate(node, ctx)).toBe("hello world")
  })

  it("resolves nested access into JSON object fields", () => {
    const ctx = makeContext({
      steps: {
        explore: {
          output: { has_legacy: true, summary: "found 3 modules" },
        },
      },
    })
    const node: ASTNode = {
      type: "access",
      path: ["steps", "explore", "output", "has_legacy"],
    }
    expect(evaluate(node, ctx)).toBe(true)
  })

  it("returns undefined for missing path", () => {
    const ctx = makeContext({ steps: {} })
    const node: ASTNode = {
      type: "access",
      path: ["steps", "nonexistent", "output"],
    }
    expect(evaluate(node, ctx)).toBeUndefined()
  })

  it("returns undefined when traversing through non-object", () => {
    const ctx = makeContext({
      steps: { init: { output: "plain string" } },
    })
    const node: ASTNode = {
      type: "access",
      path: ["steps", "init", "output", "field"],
    }
    expect(evaluate(node, ctx)).toBeUndefined()
  })

  it("or fallback — left is null, returns right", () => {
    const ctx = makeContext({
      steps: {
        a: { output: null },
        b: { output: "fallback value" },
      },
    })
    const node: ASTNode = {
      type: "or",
      left: { type: "access", path: ["steps", "a", "output"] },
      right: { type: "access", path: ["steps", "b", "output"] },
    }
    expect(evaluate(node, ctx)).toBe("fallback value")
  })

  it("or fallback — left is undefined (missing), returns right", () => {
    const ctx = makeContext({
      steps: {
        b: { output: "fallback value" },
      },
    })
    const node: ASTNode = {
      type: "or",
      left: { type: "access", path: ["steps", "a", "output"] },
      right: { type: "access", path: ["steps", "b", "output"] },
    }
    expect(evaluate(node, ctx)).toBe("fallback value")
  })

  it("or fallback — left is empty string, returns right", () => {
    const ctx = makeContext({
      steps: {
        a: { output: "" },
        b: { output: "fallback" },
      },
    })
    const node: ASTNode = {
      type: "or",
      left: { type: "access", path: ["steps", "a", "output"] },
      right: { type: "access", path: ["steps", "b", "output"] },
    }
    expect(evaluate(node, ctx)).toBe("fallback")
  })

  it("or no fallback — left exists and truthy, returns left", () => {
    const ctx = makeContext({
      steps: {
        a: { output: "result A" },
        b: { output: "result B" },
      },
    })
    const node: ASTNode = {
      type: "or",
      left: { type: "access", path: ["steps", "a", "output"] },
      right: { type: "access", path: ["steps", "b", "output"] },
    }
    expect(evaluate(node, ctx)).toBe("result A")
  })

  it("or fallback — left is false, returns right", () => {
    const ctx = makeContext({
      steps: {
        a: { output: false },
        b: { output: "fallback" },
      },
    })
    const node: ASTNode = {
      type: "or",
      left: { type: "access", path: ["steps", "a", "output"] },
      right: { type: "access", path: ["steps", "b", "output"] },
    }
    expect(evaluate(node, ctx)).toBe("fallback")
  })

  it("comparison == returns true when values match", () => {
    const ctx = makeContext({
      steps: { x: { output: { flag: true } } },
    })
    const node: ASTNode = {
      type: "comparison",
      op: "==",
      left: { type: "access", path: ["steps", "x", "output", "flag"] },
      right: { type: "literal", value: true },
    }
    expect(evaluate(node, ctx)).toBe(true)
  })

  it("comparison == returns false when values differ", () => {
    const ctx = makeContext({
      steps: { x: { output: { flag: false } } },
    })
    const node: ASTNode = {
      type: "comparison",
      op: "==",
      left: { type: "access", path: ["steps", "x", "output", "flag"] },
      right: { type: "literal", value: true },
    }
    expect(evaluate(node, ctx)).toBe(false)
  })

  it("comparison != returns true when values differ", () => {
    const ctx = makeContext({
      steps: { x: { output: { status: "pending" } } },
    })
    const node: ASTNode = {
      type: "comparison",
      op: "!=",
      left: { type: "access", path: ["steps", "x", "output", "status"] },
      right: { type: "literal", value: "done" },
    }
    expect(evaluate(node, ctx)).toBe(true)
  })

  it("comparison != returns false when values match", () => {
    const ctx = makeContext({
      steps: { x: { output: { status: "done" } } },
    })
    const node: ASTNode = {
      type: "comparison",
      op: "!=",
      left: { type: "access", path: ["steps", "x", "output", "status"] },
      right: { type: "literal", value: "done" },
    }
    expect(evaluate(node, ctx)).toBe(false)
  })

  it("literal values pass through", () => {
    const ctx = makeContext({})
    expect(evaluate({ type: "literal", value: "hello" }, ctx)).toBe("hello")
    expect(evaluate({ type: "literal", value: 42 }, ctx)).toBe(42)
    expect(evaluate({ type: "literal", value: true }, ctx)).toBe(true)
    expect(evaluate({ type: "literal", value: false }, ctx)).toBe(false)
  })

  it("comparison with string literal", () => {
    const ctx = makeContext({
      steps: { x: { output: { name: "auth" } } },
    })
    const node: ASTNode = {
      type: "comparison",
      op: "==",
      left: { type: "access", path: ["steps", "x", "output", "name"] },
      right: { type: "literal", value: "auth" },
    }
    expect(evaluate(node, ctx)).toBe(true)
  })

  it("env variable resolution", () => {
    const ctx = makeContext({
      env: { HOME: "/Users/dev" },
    })
    const node: ASTNode = {
      type: "access",
      path: ["env", "HOME"],
    }
    expect(evaluate(node, ctx)).toBe("/Users/dev")
  })

  it("inputs resolution", () => {
    const ctx = makeContext({
      inputs: { feature: "auth" },
    })
    const node: ASTNode = {
      type: "access",
      path: ["inputs", "feature"],
    }
    expect(evaluate(node, ctx)).toBe("auth")
  })
})
