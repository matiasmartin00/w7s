/**
 * Expression tokenizer for ${{ }} expressions.
 *
 * Performs character-by-character tokenization (no regex).
 * Handles: identifiers, dots, ||, ==, !=, boolean literals,
 * string literals (single/double quotes), numbers, and EOF.
 */

export type TokenType =
  | "IDENTIFIER"
  | "DOT"
  | "PIPE_PIPE"
  | "EQUALS"
  | "NOT_EQUALS"
  | "BOOLEAN"
  | "STRING"
  | "NUMBER"
  | "EOF"

export interface Token {
  type: TokenType
  value: string
  position: number
}

export class TokenizerError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(`${message} at position ${position}`)
    this.name = "TokenizerError"
  }
}

export function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let pos = 0

  while (pos < expression.length) {
    // Skip whitespace
    if (isWhitespace(expression[pos])) {
      pos++
      continue
    }

    const ch = expression[pos]

    // Dot
    if (ch === ".") {
      tokens.push({ type: "DOT", value: ".", position: pos })
      pos++
      continue
    }

    // Pipe-pipe (||)
    if (ch === "|") {
      if (pos + 1 < expression.length && expression[pos + 1] === "|") {
        tokens.push({ type: "PIPE_PIPE", value: "||", position: pos })
        pos += 2
        continue
      }
      throw new TokenizerError(`Unexpected character '|' (did you mean '||'?)`, pos)
    }

    // Equals (==)
    if (ch === "=") {
      if (pos + 1 < expression.length && expression[pos + 1] === "=") {
        tokens.push({ type: "EQUALS", value: "==", position: pos })
        pos += 2
        continue
      }
      throw new TokenizerError(`Unexpected character '=' (did you mean '=='?)`, pos)
    }

    // Not-equals (!=)
    if (ch === "!") {
      if (pos + 1 < expression.length && expression[pos + 1] === "=") {
        tokens.push({ type: "NOT_EQUALS", value: "!=", position: pos })
        pos += 2
        continue
      }
      throw new TokenizerError(`Unexpected character '!' (did you mean '!='?)`, pos)
    }

    // String literals (single or double quotes)
    if (ch === '"' || ch === "'") {
      const start = pos
      const quote = ch
      pos++ // skip opening quote
      let value = ""
      while (pos < expression.length && expression[pos] !== quote) {
        // Handle escape sequences
        if (expression[pos] === "\\" && pos + 1 < expression.length) {
          pos++ // skip backslash
          value += expression[pos]
        } else {
          value += expression[pos]
        }
        pos++
      }
      if (pos >= expression.length) {
        throw new TokenizerError(`Unterminated string literal`, start)
      }
      pos++ // skip closing quote
      tokens.push({ type: "STRING", value, position: start })
      continue
    }

    // Numbers
    if (isDigit(ch)) {
      const start = pos
      let value = ""
      while (pos < expression.length && isDigit(expression[pos])) {
        value += expression[pos]
        pos++
      }
      tokens.push({ type: "NUMBER", value, position: start })
      continue
    }

    // Identifiers and boolean keywords
    if (isIdentStart(ch)) {
      const start = pos
      let value = ""
      while (pos < expression.length && isIdentPart(expression[pos])) {
        value += expression[pos]
        pos++
      }
      if (value === "true" || value === "false") {
        tokens.push({ type: "BOOLEAN", value, position: start })
      } else {
        tokens.push({ type: "IDENTIFIER", value, position: start })
      }
      continue
    }

    // Unknown character
    throw new TokenizerError(`Unexpected character '${ch}'`, pos)
  }

  tokens.push({ type: "EOF", value: "", position: pos })
  return tokens
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r"
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9"
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_"
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch)
}
