import { describe, it, expect } from "vitest"
import { parse, ParseError } from "./parser.js"
import { tokenize } from "./tokenizer.js"
import type { ASTNode } from "../types/expression.js"

/** Helper: tokenize then parse */
function parseExpr(expr: string): ASTNode {
  return parse(tokenize(expr))
}

describe("parser", () => {
  it("parses simple dotted access path", () => {
    const ast = parseExpr("steps.init.output")
    expect(ast).toEqual({
      type: "access",
      path: ["steps", "init", "output"],
    })
  })

  it("parses a single identifier as access with one-element path", () => {
    const ast = parseExpr("name")
    expect(ast).toEqual({
      type: "access",
      path: ["name"],
    })
  })

  it("parses fallback expression with ||", () => {
    const ast = parseExpr("steps.a.output || steps.b.output")
    expect(ast).toEqual({
      type: "or",
      left: { type: "access", path: ["steps", "a", "output"] },
      right: { type: "access", path: ["steps", "b", "output"] },
    })
  })

  it("parses comparison with == true", () => {
    const ast = parseExpr("steps.x.flag == true")
    expect(ast).toEqual({
      type: "comparison",
      op: "==",
      left: { type: "access", path: ["steps", "x", "flag"] },
      right: { type: "literal", value: true },
    })
  })

  it("parses comparison with != and string literal", () => {
    const ast = parseExpr('steps.x.status != "done"')
    expect(ast).toEqual({
      type: "comparison",
      op: "!=",
      left: { type: "access", path: ["steps", "x", "status"] },
      right: { type: "literal", value: "done" },
    })
  })

  it("parses nested or as left-associative chain", () => {
    // a || b || c  →  OrNode(OrNode(a, b), c)
    const ast = parseExpr("a || b || c")
    expect(ast).toEqual({
      type: "or",
      left: {
        type: "or",
        left: { type: "access", path: ["a"] },
        right: { type: "access", path: ["b"] },
      },
      right: { type: "access", path: ["c"] },
    })
  })

  it("parses comparison with number literal", () => {
    const ast = parseExpr("steps.x.count == 42")
    expect(ast).toEqual({
      type: "comparison",
      op: "==",
      left: { type: "access", path: ["steps", "x", "count"] },
      right: { type: "literal", value: 42 },
    })
  })

  it("parses comparison with false boolean", () => {
    const ast = parseExpr("steps.x.flag == false")
    expect(ast).toEqual({
      type: "comparison",
      op: "==",
      left: { type: "access", path: ["steps", "x", "flag"] },
      right: { type: "literal", value: false },
    })
  })

  it("parses or with comparison on the left", () => {
    // (steps.x.flag == true) || steps.y.output
    const ast = parseExpr("steps.x.flag == true || steps.y.output")
    expect(ast).toEqual({
      type: "or",
      left: {
        type: "comparison",
        op: "==",
        left: { type: "access", path: ["steps", "x", "flag"] },
        right: { type: "literal", value: true },
      },
      right: { type: "access", path: ["steps", "y", "output"] },
    })
  })

  it("parses deeply nested field access", () => {
    const ast = parseExpr("steps.explore.output.has_legacy")
    expect(ast).toEqual({
      type: "access",
      path: ["steps", "explore", "output", "has_legacy"],
    })
  })

  it("throws ParseError on unexpected token at start", () => {
    expect(() => parseExpr("||")).toThrow(ParseError)
  })

  it("throws ParseError on incomplete comparison", () => {
    // == expects a literal on the right, not another access path
    expect(() => parseExpr("steps.x.flag ==")).toThrow(ParseError)
  })

  it("throws ParseError on trailing garbage", () => {
    expect(() => parseExpr("a b")).toThrow(ParseError)
  })

  it("throws ParseError with position info", () => {
    try {
      parseExpr("a b")
    } catch (e) {
      const err = e as ParseError
      expect(err.name).toBe("ParseError")
      expect(err.position).toBe(2)
      expect(err.message).toContain("Unexpected token")
    }
  })
})
