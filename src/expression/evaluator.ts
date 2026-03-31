/**
 * Expression evaluator — walks an AST and resolves values from an ExpressionContext.
 *
 * - AccessNode: traverse context object following path segments
 * - OrNode: return left if truthy, otherwise right
 * - ComparisonNode: evaluate both sides, compare with == or !=
 * - LiteralNode: return the literal value
 */

import type { ASTNode } from "../types/expression.js"
import type { ExpressionContext } from "../types/expression.js"

export function evaluate(node: ASTNode, context: ExpressionContext): unknown {
  switch (node.type) {
    case "access": {
      // Resolve dotted path against context
      return context.get(node.path.join("."))
    }

    case "or": {
      const left = evaluate(node.left, context)
      // Falsy: null, undefined, "", false, 0
      if (left == null || left === "" || left === false || left === 0) {
        return evaluate(node.right, context)
      }
      return left
    }

    case "comparison": {
      const left = evaluate(node.left, context)
      const right = evaluate(node.right, context)
      if (node.op === "==") {
        return left === right
      }
      // node.op === "!="
      return left !== right
    }

    case "literal": {
      return node.value
    }
  }
}
