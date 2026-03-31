/**
 * Parse command arguments into key-value pairs.
 *
 * Supports two formats (PRD section 5.6, REQ-INPUT-001):
 * - key=value: `/sdd feature=auth scope=backend`
 * - --key value: `/sdd --feature auth --scope backend`
 * - Mixed: `/sdd feature=auth --scope backend`
 * - Quoted values: `feature="user auth"` or `--feature "user auth"`
 */

export type ParsedInputs = Record<string, string>

/**
 * Parse a raw argument string into a key-value record.
 *
 * Returns an empty object for empty/whitespace-only input.
 */
export function parseInputs(args: string): ParsedInputs {
  const result: ParsedInputs = {}

  if (!args || !args.trim()) {
    return result
  }

  const tokens = tokenizeArgs(args.trim())
  let i = 0

  while (i < tokens.length) {
    const token = tokens[i]

    // --key value format
    if (token.startsWith("--")) {
      const key = token.slice(2)
      if (key === "") {
        i++
        continue
      }
      // If next token exists and is not another flag or key=value
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("--") && !tokens[i + 1].includes("=")) {
        result[key] = tokens[i + 1]
        i += 2
      } else {
        // Boolean flag: --verbose → "true"
        result[key] = "true"
        i++
      }
      continue
    }

    // key=value format
    if (token.includes("=")) {
      const eqIdx = token.indexOf("=")
      const key = token.slice(0, eqIdx)
      const value = token.slice(eqIdx + 1)
      if (key) {
        result[key] = value
      }
      i++
      continue
    }

    // Skip positional args that don't match either format
    i++
  }

  return result
}

/**
 * Tokenize an argument string, respecting quoted sections.
 *
 * Handles:
 * - Double-quoted values: "user auth"
 * - Single-quoted values: 'user auth'
 * - key="value with spaces" → single token: key=value with spaces
 * - Unquoted values split by whitespace
 */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let i = 0

  while (i < input.length) {
    const ch = input[i]

    // Whitespace outside quotes → finish current token
    if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current)
        current = ""
      }
      i++
      continue
    }

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch
      i++ // skip opening quote
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          i++ // skip backslash
          current += input[i]
        } else {
          current += input[i]
        }
        i++
      }
      if (i < input.length) {
        i++ // skip closing quote
      }
      continue
    }

    // Regular character
    current += ch
    i++
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}
