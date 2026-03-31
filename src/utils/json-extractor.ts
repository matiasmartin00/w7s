/**
 * Multi-strategy JSON extraction from LLM responses.
 *
 * Design decision #3: Ordered strategies minimize false negatives.
 *
 * Strategy order:
 * 1. Direct JSON.parse(text.trim())
 * 2. Extract from markdown code fences: ```json ... ``` or ``` ... ```
 * 3. Bracket detection: first { to last } or first [ to last ]
 * 4. Throw JsonExtractionError
 */

export class JsonExtractionError extends Error {
  constructor(
    message: string,
    public readonly originalText: string,
  ) {
    super(message)
    this.name = "JsonExtractionError"
  }
}

/**
 * Extract and parse JSON from text that may contain surrounding prose,
 * code fences, or other non-JSON content.
 *
 * Returns the parsed value (object, array, or primitive).
 * Throws JsonExtractionError if no valid JSON can be extracted.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()

  if (!trimmed) {
    throw new JsonExtractionError("Empty input — no JSON found", text)
  }

  // Strategy 1: Direct parse
  try {
    return JSON.parse(trimmed)
  } catch {
    // Continue to next strategy
  }

  // Strategy 2: Markdown code fences
  const fenceResult = extractFromCodeFence(trimmed)
  if (fenceResult !== undefined) {
    return fenceResult
  }

  // Strategy 3: Bracket detection
  const bracketResult = extractByBrackets(trimmed)
  if (bracketResult !== undefined) {
    return bracketResult
  }

  // All strategies failed
  throw new JsonExtractionError(
    "Could not extract valid JSON from text",
    text,
  )
}

/**
 * Extract JSON from markdown code fences.
 * Matches ```json ... ``` and ``` ... ```
 */
function extractFromCodeFence(text: string): unknown | undefined {
  // Match ```json\n...\n``` or ```\n...\n``` (with optional language tag)
  const fenceRegex = /```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/
  const match = fenceRegex.exec(text)

  if (match && match[1]) {
    try {
      return JSON.parse(match[1].trim())
    } catch {
      // Fence content wasn't valid JSON
    }
  }

  return undefined
}

/**
 * Extract JSON by finding matching outermost brackets.
 * Finds first { to last } or first [ to last ].
 */
function extractByBrackets(text: string): unknown | undefined {
  // Try object brackets first, then array brackets
  const result = tryBracketPair(text, "{", "}") ?? tryBracketPair(text, "[", "]")
  return result
}

function tryBracketPair(text: string, open: string, close: string): unknown | undefined {
  const firstOpen = text.indexOf(open)
  const lastClose = text.lastIndexOf(close)

  if (firstOpen === -1 || lastClose === -1 || lastClose <= firstOpen) {
    return undefined
  }

  const candidate = text.slice(firstOpen, lastClose + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return undefined
  }
}
