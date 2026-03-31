import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, extname, basename } from "node:path"
import { parse as parseYaml } from "yaml"
import { validateWorkflow } from "../schema/index.js"
import type { Workflow } from "../types/index.js"

// --- Types ---

export type LoadErrorType = "parse" | "validation" | "conflict"

export interface LoadError {
  file: string
  error: string
  type: LoadErrorType
}

export interface LoadResult {
  workflows: Map<string, Workflow>
  errors: LoadError[]
}

// --- Internal helpers ---

function isYamlFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase()
  return ext === ".yaml" || ext === ".yml"
}

function workflowId(filename: string): string {
  const ext = extname(filename)
  return basename(filename, ext)
}

interface ParsedFile {
  id: string
  file: string
  workflow: Workflow
}

function readYamlFiles(dir: string): { parsed: ParsedFile[]; errors: LoadError[] } {
  const parsed: ParsedFile[] = []
  const errors: LoadError[] = []

  if (!existsSync(dir)) {
    return { parsed, errors }
  }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { parsed, errors }
  }

  const yamlFiles = entries.filter(isYamlFile).sort()

  for (const filename of yamlFiles) {
    const filePath = join(dir, filename)
    const id = workflowId(filename)

    // Read file
    let content: string
    try {
      content = readFileSync(filePath, "utf-8")
    } catch (err) {
      errors.push({
        file: filePath,
        error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        type: "parse",
      })
      continue
    }

    // Parse YAML
    let data: unknown
    try {
      data = parseYaml(content)
    } catch (err) {
      errors.push({
        file: filePath,
        error: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
        type: "parse",
      })
      continue
    }

    // Validate against Zod schema
    const result = validateWorkflow(data)
    if (!result.success) {
      const issues = result.errors.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
      errors.push({
        file: filePath,
        error: `Validation failed: ${issues}`,
        type: "validation",
      })
      continue
    }

    parsed.push({ id, file: filePath, workflow: result.workflow as Workflow })
  }

  return { parsed, errors }
}

// --- Public API ---

/**
 * Load workflows from local and global directories.
 *
 * - Reads *.yaml and *.yml files from both directories
 * - Validates each against the Zod workflow schema
 * - Local workflows override global ones with the same identifier (filename sans extension)
 * - Detects trigger conflicts: if two different workflows register the same trigger command,
 *   neither is loaded and a conflict error is reported
 */
export function loadWorkflows(localDir: string, globalDir: string): LoadResult {
  const errors: LoadError[] = []

  // 1. Read both directories
  const local = readYamlFiles(localDir)
  const global = readYamlFiles(globalDir)

  errors.push(...local.errors, ...global.errors)

  // 2. Apply precedence: local overrides global (by workflow id = filename without extension)
  const localIds = new Set(local.parsed.map((p) => p.id))
  const merged = new Map<string, ParsedFile>()

  // Add local first (higher priority)
  for (const entry of local.parsed) {
    merged.set(entry.id, entry)
  }

  // Add global only if not overridden by local
  for (const entry of global.parsed) {
    if (!localIds.has(entry.id)) {
      merged.set(entry.id, entry)
    }
  }

  // 3. Detect trigger conflicts — map each command to the workflow(s) that claim it
  const triggerOwners = new Map<string, string[]>() // command → [workflow ids]

  for (const [id, entry] of merged) {
    for (const cmd of entry.workflow.trigger.commands) {
      const owners = triggerOwners.get(cmd) ?? []
      owners.push(id)
      triggerOwners.set(cmd, owners)
    }
  }

  // Find conflicting workflow ids
  const conflictingIds = new Set<string>()
  for (const [cmd, owners] of triggerOwners) {
    if (owners.length > 1) {
      for (const id of owners) conflictingIds.add(id)
      errors.push({
        file: cmd,
        error: `Trigger conflict: command "${cmd}" is registered by workflows: ${owners.join(", ")}`,
        type: "conflict",
      })
    }
  }

  // 4. Build final map — exclude conflicting workflows
  const workflows = new Map<string, Workflow>()
  for (const [id, entry] of merged) {
    if (!conflictingIds.has(id)) {
      workflows.set(id, entry.workflow)
    }
  }

  return { workflows, errors }
}
