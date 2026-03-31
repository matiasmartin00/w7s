/**
 * Template string interpolator — finds all ${{ ... }} expressions,
 * evaluates each, and replaces with the stringified result.
 *
 * Result coercion:
 * - object → JSON.stringify
 * - null/undefined → ""
 * - primitive → String()
 */

import type { ExpressionContext } from "../types/expression.js"
import { tokenize } from "./tokenizer.js"
import { parse } from "./parser.js"
import { evaluate } from "./evaluator.js"

const EXPRESSION_PATTERN = /\$\{\{\s*(.*?)\s*\}\}/g

export function interpolate(
  template: string,
  context: ExpressionContext,
): string {
  return template.replace(EXPRESSION_PATTERN, (_match, expr: string) => {
    const tokens = tokenize(expr)
    const ast = parse(tokens)
    const result = evaluate(ast, context)
    return stringify(result)
  })
}

function stringify(value: unknown): string {
  if (value == null) {
    return ""
  }
  if (typeof value === "object") {
    return JSON.stringify(value)
  }
  return String(value)
}
