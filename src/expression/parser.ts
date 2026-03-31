/**
 * Expression parser — recursive descent parser for workflow expressions.
 *
 * Grammar:
 *   expression   = or_expr
 *   or_expr      = compare_expr ( "||" compare_expr )*
 *   compare_expr = access_expr ( ("==" | "!=") literal )?
 *   access_expr  = primary ( "." IDENTIFIER )*
 *   primary      = IDENTIFIER | STRING | BOOLEAN | NUMBER
 *   literal      = STRING | BOOLEAN | NUMBER
 */

import type { Token } from "./tokenizer.js"
import type {
  ASTNode,
  AccessNode,
  OrNode,
  ComparisonNode,
  LiteralNode,
} from "../types/expression.js"

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(`${message} at position ${position}`)
    this.name = "ParseError"
  }
}

export function parse(tokens: Token[]): ASTNode {
  let pos = 0

  function peek(): Token {
    return tokens[pos]
  }

  function advance(): Token {
    const token = tokens[pos]
    pos++
    return token
  }

  function expect(type: string): Token {
    const token = peek()
    if (token.type !== type) {
      throw new ParseError(
        `Expected ${type} but got ${token.type} ("${token.value}")`,
        token.position,
      )
    }
    return advance()
  }

  // expression = or_expr
  function parseExpression(): ASTNode {
    const node = parseOr()
    const remaining = peek()
    if (remaining.type !== "EOF") {
      throw new ParseError(
        `Unexpected token ${remaining.type} ("${remaining.value}")`,
        remaining.position,
      )
    }
    return node
  }

  // or_expr = compare_expr ( "||" compare_expr )*
  function parseOr(): ASTNode {
    let left = parseComparison()

    while (peek().type === "PIPE_PIPE") {
      advance() // consume ||
      const right = parseComparison()
      const node: OrNode = { type: "or", left, right }
      left = node
    }

    return left
  }

  // compare_expr = access_expr ( ("==" | "!=") literal )?
  function parseComparison(): ASTNode {
    const left = parseAccess()

    const next = peek()
    if (next.type === "EQUALS" || next.type === "NOT_EQUALS") {
      const opToken = advance()
      const op = opToken.value as "==" | "!="
      const right = parseLiteral()
      const node: ComparisonNode = { type: "comparison", op, left, right }
      return node
    }

    return left
  }

  // access_expr = primary ( "." IDENTIFIER )*
  function parseAccess(): ASTNode {
    const first = parsePrimary()

    // Only identifiers can start a dotted access path
    if (first.type !== "access") {
      return first
    }

    const path = [...first.path]

    while (peek().type === "DOT") {
      advance() // consume .
      const ident = expect("IDENTIFIER")
      path.push(ident.value)
    }

    const node: AccessNode = { type: "access", path }
    return node
  }

  // primary = IDENTIFIER | STRING | BOOLEAN | NUMBER
  function parsePrimary(): ASTNode {
    const token = peek()

    if (token.type === "IDENTIFIER") {
      advance()
      const node: AccessNode = { type: "access", path: [token.value] }
      return node
    }

    if (token.type === "STRING") {
      advance()
      const node: LiteralNode = { type: "literal", value: token.value }
      return node
    }

    if (token.type === "BOOLEAN") {
      advance()
      const node: LiteralNode = {
        type: "literal",
        value: token.value === "true",
      }
      return node
    }

    if (token.type === "NUMBER") {
      advance()
      const node: LiteralNode = {
        type: "literal",
        value: Number(token.value),
      }
      return node
    }

    throw new ParseError(
      `Unexpected token ${token.type} ("${token.value}")`,
      token.position,
    )
  }

  // literal = STRING | BOOLEAN | NUMBER
  function parseLiteral(): ASTNode {
    const token = peek()

    if (token.type === "STRING") {
      advance()
      const node: LiteralNode = { type: "literal", value: token.value }
      return node
    }

    if (token.type === "BOOLEAN") {
      advance()
      const node: LiteralNode = {
        type: "literal",
        value: token.value === "true",
      }
      return node
    }

    if (token.type === "NUMBER") {
      advance()
      const node: LiteralNode = {
        type: "literal",
        value: Number(token.value),
      }
      return node
    }

    throw new ParseError(
      `Expected literal (string, boolean, or number) but got ${token.type} ("${token.value}")`,
      token.position,
    )
  }

  return parseExpression()
}
