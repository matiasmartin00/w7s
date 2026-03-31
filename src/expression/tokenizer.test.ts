import { describe, it, expect } from "vitest"
import { tokenize, TokenizerError } from "./tokenizer.js"
import type { Token } from "./tokenizer.js"

/** Helper: extract just type and value from tokens for concise assertions */
function types(tokens: Token[]): Array<[string, string]> {
  return tokens.map((t) => [t.type, t.value])
}

describe("tokenizer", () => {
  it("tokenizes a simple dotted variable path", () => {
    const tokens = tokenize("steps.init.output")
    expect(types(tokens)).toEqual([
      ["IDENTIFIER", "steps"],
      ["DOT", "."],
      ["IDENTIFIER", "init"],
      ["DOT", "."],
      ["IDENTIFIER", "output"],
      ["EOF", ""],
    ])
  })

  it("tokenizes a fallback expression with ||", () => {
    const tokens = tokenize("steps.a.output || steps.b.output")
    expect(types(tokens)).toEqual([
      ["IDENTIFIER", "steps"],
      ["DOT", "."],
      ["IDENTIFIER", "a"],
      ["DOT", "."],
      ["IDENTIFIER", "output"],
      ["PIPE_PIPE", "||"],
      ["IDENTIFIER", "steps"],
      ["DOT", "."],
      ["IDENTIFIER", "b"],
      ["DOT", "."],
      ["IDENTIFIER", "output"],
      ["EOF", ""],
    ])
  })

  it("tokenizes a comparison with == and boolean literal", () => {
    const tokens = tokenize("steps.x.output.flag == true")
    expect(types(tokens)).toEqual([
      ["IDENTIFIER", "steps"],
      ["DOT", "."],
      ["IDENTIFIER", "x"],
      ["DOT", "."],
      ["IDENTIFIER", "output"],
      ["DOT", "."],
      ["IDENTIFIER", "flag"],
      ["EQUALS", "=="],
      ["BOOLEAN", "true"],
      ["EOF", ""],
    ])
  })

  it("tokenizes a comparison with a double-quoted string literal", () => {
    const tokens = tokenize('steps.x.output.name == "hello"')
    expect(types(tokens)).toEqual([
      ["IDENTIFIER", "steps"],
      ["DOT", "."],
      ["IDENTIFIER", "x"],
      ["DOT", "."],
      ["IDENTIFIER", "output"],
      ["DOT", "."],
      ["IDENTIFIER", "name"],
      ["EQUALS", "=="],
      ["STRING", "hello"],
      ["EOF", ""],
    ])
  })

  it("tokenizes a single-quoted string literal", () => {
    const tokens = tokenize("steps.x.output.name == 'world'")
    expect(types(tokens)).toEqual([
      ["IDENTIFIER", "steps"],
      ["DOT", "."],
      ["IDENTIFIER", "x"],
      ["DOT", "."],
      ["IDENTIFIER", "output"],
      ["DOT", "."],
      ["IDENTIFIER", "name"],
      ["EQUALS", "=="],
      ["STRING", "world"],
      ["EOF", ""],
    ])
  })

  it("tokenizes nested field access", () => {
    const tokens = tokenize("steps.explore.output.has_legacy")
    expect(types(tokens)).toEqual([
      ["IDENTIFIER", "steps"],
      ["DOT", "."],
      ["IDENTIFIER", "explore"],
      ["DOT", "."],
      ["IDENTIFIER", "output"],
      ["DOT", "."],
      ["IDENTIFIER", "has_legacy"],
      ["EOF", ""],
    ])
  })

  it("handles whitespace — result matches no-whitespace version", () => {
    const withSpaces = tokenize("  steps.a.output  ||  steps.b.output  ")
    const noSpaces = tokenize("steps.a.output || steps.b.output")
    // Types and values match (positions may differ)
    expect(types(withSpaces)).toEqual(types(noSpaces))
  })

  it("throws with position info on unexpected character", () => {
    expect(() => tokenize("steps.a.output & steps.b.output")).toThrow(
      TokenizerError,
    )
    try {
      tokenize("steps.a.output & steps.b.output")
    } catch (e) {
      const err = e as TokenizerError
      expect(err.position).toBe(15) // position of '&'
      expect(err.message).toContain("Unexpected character")
      expect(err.message).toContain("15")
    }
  })

  it("tokenizes an empty expression as just EOF", () => {
    const tokens = tokenize("")
    expect(types(tokens)).toEqual([["EOF", ""]])
  })

  it("tokenizes a number literal", () => {
    const tokens = tokenize("42")
    expect(types(tokens)).toEqual([
      ["NUMBER", "42"],
      ["EOF", ""],
    ])
  })

  it("tokenizes not-equals operator", () => {
    const tokens = tokenize('steps.x.output.status != "done"')
    expect(types(tokens)).toEqual([
      ["IDENTIFIER", "steps"],
      ["DOT", "."],
      ["IDENTIFIER", "x"],
      ["DOT", "."],
      ["IDENTIFIER", "output"],
      ["DOT", "."],
      ["IDENTIFIER", "status"],
      ["NOT_EQUALS", "!="],
      ["STRING", "done"],
      ["EOF", ""],
    ])
  })

  it("tokenizes false boolean literal", () => {
    const tokens = tokenize("steps.x.output.flag == false")
    expect(types(tokens)).toEqual([
      ["IDENTIFIER", "steps"],
      ["DOT", "."],
      ["IDENTIFIER", "x"],
      ["DOT", "."],
      ["IDENTIFIER", "output"],
      ["DOT", "."],
      ["IDENTIFIER", "flag"],
      ["EQUALS", "=="],
      ["BOOLEAN", "false"],
      ["EOF", ""],
    ])
  })

  it("records correct position for each token", () => {
    const tokens = tokenize("a.b || c")
    expect(tokens[0]).toEqual({ type: "IDENTIFIER", value: "a", position: 0 })
    expect(tokens[1]).toEqual({ type: "DOT", value: ".", position: 1 })
    expect(tokens[2]).toEqual({ type: "IDENTIFIER", value: "b", position: 2 })
    expect(tokens[3]).toEqual({ type: "PIPE_PIPE", value: "||", position: 4 })
    expect(tokens[4]).toEqual({ type: "IDENTIFIER", value: "c", position: 7 })
    expect(tokens[5]).toEqual({ type: "EOF", value: "", position: 8 })
  })

  it("throws on unterminated string literal", () => {
    expect(() => tokenize('"unterminated')).toThrow(TokenizerError)
    try {
      tokenize('"unterminated')
    } catch (e) {
      const err = e as TokenizerError
      expect(err.message).toContain("Unterminated string literal")
    }
  })

  it("throws helpful hint for single pipe", () => {
    expect(() => tokenize("a | b")).toThrow(TokenizerError)
    try {
      tokenize("a | b")
    } catch (e) {
      const err = e as TokenizerError
      expect(err.message).toContain("||")
    }
  })

  it("throws helpful hint for single equals", () => {
    expect(() => tokenize("a = b")).toThrow(TokenizerError)
    try {
      tokenize("a = b")
    } catch (e) {
      const err = e as TokenizerError
      expect(err.message).toContain("==")
    }
  })

  it("handles identifiers with underscores and numbers", () => {
    const tokens = tokenize("step_1.output_v2")
    expect(types(tokens)).toEqual([
      ["IDENTIFIER", "step_1"],
      ["DOT", "."],
      ["IDENTIFIER", "output_v2"],
      ["EOF", ""],
    ])
  })

  it("handles escape sequences in strings", () => {
    const tokens = tokenize('"hello\\"world"')
    expect(tokens[0].type).toBe("STRING")
    expect(tokens[0].value).toBe('hello"world')
  })

  it("handles whitespace-only input as EOF", () => {
    const tokens = tokenize("   ")
    expect(types(tokens)).toEqual([["EOF", ""]])
  })
})
