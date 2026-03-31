// Expression AST node types

export interface AccessNode {
  type: "access"
  path: string[] // e.g. ["steps", "init", "output"]
}

export interface OrNode {
  type: "or"
  left: ASTNode
  right: ASTNode
}

export interface ComparisonNode {
  type: "comparison"
  op: "==" | "!="
  left: ASTNode
  right: ASTNode
}

export interface LiteralNode {
  type: "literal"
  value: string | boolean | number
}

export type ASTNode = AccessNode | OrNode | ComparisonNode | LiteralNode

// --- Expression Context Interface ---
// What variables are available for expression resolution

export interface ExpressionContext {
  get(path: string): unknown
}
