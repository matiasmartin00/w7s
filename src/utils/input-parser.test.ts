import { describe, it, expect } from "vitest"
import { parseInputs } from "./input-parser.js"

describe("parseInputs", () => {
  describe("key=value format", () => {
    it("parses a single key=value", () => {
      expect(parseInputs("feature=auth")).toEqual({ feature: "auth" })
    })

    it("parses multiple key=value pairs", () => {
      expect(parseInputs("feature=auth scope=backend")).toEqual({
        feature: "auth",
        scope: "backend",
      })
    })
  })

  describe("--key value format", () => {
    it("parses a single --key value", () => {
      expect(parseInputs("--feature auth")).toEqual({ feature: "auth" })
    })

    it("parses multiple --key value pairs", () => {
      expect(parseInputs("--feature auth --scope backend")).toEqual({
        feature: "auth",
        scope: "backend",
      })
    })
  })

  describe("mixed formats", () => {
    it("parses mixed key=value and --key value", () => {
      expect(parseInputs("feature=auth --scope backend")).toEqual({
        feature: "auth",
        scope: "backend",
      })
    })

    it("parses mixed --key value and key=value", () => {
      expect(parseInputs("--feature auth scope=backend")).toEqual({
        feature: "auth",
        scope: "backend",
      })
    })
  })

  describe("quoted values", () => {
    it("handles double-quoted values in key=value", () => {
      expect(parseInputs('feature="user auth"')).toEqual({
        feature: "user auth",
      })
    })

    it("handles single-quoted values in key=value", () => {
      expect(parseInputs("feature='user auth'")).toEqual({
        feature: "user auth",
      })
    })

    it("handles double-quoted values with --key", () => {
      expect(parseInputs('--feature "user auth"')).toEqual({
        feature: "user auth",
      })
    })

    it("handles single-quoted values with --key", () => {
      expect(parseInputs("--feature 'user auth'")).toEqual({
        feature: "user auth",
      })
    })
  })

  describe("edge cases", () => {
    it("returns empty object for empty string", () => {
      expect(parseInputs("")).toEqual({})
    })

    it("returns empty object for whitespace-only string", () => {
      expect(parseInputs("   ")).toEqual({})
    })

    it("handles value with = sign (url=http://localhost:3000)", () => {
      expect(parseInputs("url=http://localhost:3000")).toEqual({
        url: "http://localhost:3000",
      })
    })

    it("handles boolean flag --verbose as 'true'", () => {
      expect(parseInputs("--verbose")).toEqual({ verbose: "true" })
    })

    it("handles boolean flag followed by another flag", () => {
      expect(parseInputs("--verbose --feature auth")).toEqual({
        verbose: "true",
        feature: "auth",
      })
    })

    it("handles boolean flag followed by key=value", () => {
      expect(parseInputs("--verbose feature=auth")).toEqual({
        verbose: "true",
        feature: "auth",
      })
    })

    it("handles multiple = in value correctly", () => {
      expect(parseInputs("query=a==b")).toEqual({
        query: "a==b",
      })
    })
  })
})
