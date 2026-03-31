# Design: w7s OpenCode Workflows Plugin v1

## Technical Approach

Sequential state machine plugin — YAML workflows execute step-by-step via OpenCode hooks. `command.execute.before` intercepts triggers, `client.session.prompt` drives ai_prompt steps (one isolated session each), `ctx.$` runs shell commands, and chat-based messaging handles approvals. A custom expression engine resolves `${{ }}` interpolation. Zod v4 validates schemas at load time.

## Architecture Decisions

| # | Decision | Choice | Alternatives | Rationale |
|---|----------|--------|-------------|-----------|
| 1 | Trigger mechanism | `command.execute.before` hook, check against registry map | Config-based custom commands; custom tools | Hook is dynamic (responds to loaded YAML), no static config needed. If blocking doesn't work, fallback to throwing to abort default processing |
| 2 | Expression engine | Custom tokenizer → AST → evaluator | Regex-based replace; `eval()`; expression libraries | Scope is bounded (var access, `.`, `\|\|`, `==`/`!=`, booleans). Regex can't handle nested property access or `\|\|` precedence. `eval()` = security hole. A library is overkill for 5 operators |
| 3 | JSON extraction from LLM | Multi-strategy: (1) regex `` ```json `` fences → (2) bracket-scan first `{`/`[` to last `}`/`]` → (3) raw `JSON.parse` | Single `JSON.parse`; LLM-specific parsers | LLMs wrap JSON inconsistently. Ordered strategies minimize false negatives. System prompt also instructs "respond with JSON only" |
| 4 | Approval mechanism | Send assistant message to parent session with `[Approval]` prefix, poll `session.messages` for user reply containing yes/no | `permission.ask` hook; custom tool with `context.ask()` | Chat-based is natural UX. Permission system is designed for tool perms, not workflow gates. Custom tool requires running inside tool execution context we don't have |
| 5 | ai_prompt session isolation | `client.session.create()` per step, `client.session.prompt()` sync | Reuse single session; `promptAsync` + event polling | Isolated sessions = clean context per step (PRD requirement). Sync is simpler, switch to async only if timeout proves real |
| 6 | Retry implementation | Loop with `delay = 1000 * 2^attempt` ms, capped at 30s | Fixed delay; configurable delay per step | Exponential backoff is standard, cap prevents absurd waits. Per-step config is v2 |
| 7 | Log format | JSONL (one JSON object per event line) | Plain text; structured YAML | JSONL is grep-able, parseable, appendable. Each line: `{ts, stepId, event, data}` |
| 8 | Schema library | Zod v4 with `.parse()` for validation | Ajv; manual validation | Zod is already a transitive dep, produces TS types from schemas, good error messages |

## Data Flow

```
User types /sdd feature=auth
         │
         ▼
command.execute.before ──→ Registry.findByTrigger("/sdd")
         │                         │
         │ (no match → pass through)
         │
         ▼ (match found)
    InputParser.parse("feature=auth", workflow.inputs)
         │
         ▼
    ExecutionEngine.run(workflow, parsedInputs, sessionID)
         │
         ▼
    ┌─ FOR each step ──────────────────────────────┐
    │  1. Evaluate when condition (ExpressionEngine)│
    │     → false? skip, continue                   │
    │  2. Interpolate prompt/run/message             │
    │  3. Dispatch to StepExecutor by type           │
    │     ├─ AiPromptExecutor                       │
    │     │   → session.create → session.prompt      │
    │     │   → extract output (text or JSON)        │
    │     ├─ ShellExecutor                          │
    │     │   → ctx.$ with env, nothrow              │
    │     │   → capture stdout/stderr/exitCode       │
    │     └─ ApprovalExecutor                       │
    │         → send message to parent session       │
    │         → poll for user yes/no reply           │
    │  4. Store output in ExecutionContext            │
    │  5. Log step result (Logger.logStep)           │
    │  6. On failure → retry loop or stop            │
    └──────────────────────────────────────────────┘
         │
         ▼
    Logger.finalize(result) → write .runs/ log file
    Return formatted parts to command hook output
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/index.ts` | Create | Plugin entry: exports `w7s` plugin fn, wires `command.execute.before` + `event` hooks, calls `WorkflowLoader.load()` on init |
| `src/loader/resolver.ts` | Create | `resolveWorkflowPaths(projectDir)` — returns ordered YAML file paths from local + global dirs |
| `src/loader/parser.ts` | Create | `parseWorkflow(yamlContent, filePath)` — YAML parse + Zod validate, returns `Workflow` or throws with path-annotated errors |
| `src/loader/registry.ts` | Create | `WorkflowRegistry` class — stores workflows, maps `trigger→Workflow`, detects duplicate triggers, applies local-over-global precedence |
| `src/engine/executor.ts` | Create | `ExecutionEngine.run(workflow, inputs, sessionID)` — main loop: iterate steps, evaluate `when`, dispatch to executors, handle retry, collect results |
| `src/engine/context.ts` | Create | `ExecutionContext` class — stores inputs, step outputs (by id), workflow metadata. Provides `get(path)` for expression resolution |
| `src/expression/tokenizer.ts` | Create | Tokenizes `${{ expr }}` — outputs token stream: `IDENT`, `DOT`, `OR`, `EQ`, `NEQ`, `STRING`, `BOOL`, `EOF` |
| `src/expression/parser.ts` | Create | Recursive descent: `parseExpression → parseOr → parseComparison → parseAccess → parsePrimary`. Produces AST nodes |
| `src/expression/evaluator.ts` | Create | `evaluate(ast, context)` — walks AST, resolves variables from `ExecutionContext`, applies operators. `interpolate(template, context)` — finds all `${{ }}` blocks, evaluates each |
| `src/expression/types.ts` | Create | AST node types: `AccessNode`, `OrNode`, `ComparisonNode`, `LiteralNode` |
| `src/steps/ai-prompt.ts` | Create | `AiPromptExecutor.execute(step, context, client)` — create session, build parts, send prompt, extract/parse output |
| `src/steps/shell.ts` | Create | `ShellExecutor.execute(step, context, $)` — build command, set env/cwd, run with `.nothrow().quiet()`, capture result |
| `src/steps/approval.ts` | Create | `ApprovalExecutor.execute(step, context, client, sessionID)` — send approval message, poll for user response, return continue/cancel |
| `src/steps/types.ts` | Create | `StepExecutor` interface, `StepResult` type |
| `src/steps/json-extractor.ts` | Create | `extractJSON(text)` — multi-strategy JSON extraction from LLM text output |
| `src/commands/validate.ts` | Create | Validates workflow(s): schema, step refs, agent existence (`client.app.agents()`), duplicate triggers, input refs |
| `src/commands/dry-run.ts` | Create | Simulates execution: resolve inputs, interpolate prompts (mark unresolvable as `<pending>`), show step sequence |
| `src/commands/list.ts` | Create | Lists all registered workflows with triggers, descriptions, inputs |
| `src/commands/router.ts` | Create | Routes `/w7s <subcommand>` to the correct handler |
| `src/logging/logger.ts` | Create | `ExecutionLogger` — creates JSONL log file, `logStep()`, `finalize()`, writes to `.runs/` dir |
| `src/logging/rotation.ts` | Create | `rotateRuns(workflowName, maxRuns)` — deletes oldest logs when count exceeds limit |
| `src/schema/workflow.ts` | Create | Zod schemas: `WorkflowSchema`, `StepSchema` (discriminated union on `type`), `InputSchema`, `TriggerSchema` |
| `src/schema/index.ts` | Create | Re-exports all schemas |
| `src/types/workflow.ts` | Create | TS types inferred from Zod: `Workflow`, `Step`, `AiPromptStep`, `ShellStep`, `ApprovalStep`, `WorkflowInput`, `Trigger` |
| `src/types/execution.ts` | Create | `ExecutionContext`, `StepResult`, `WorkflowResult`, `ExecutionStatus` |
| `src/types/expression.ts` | Create | `ExpressionContext` interface (what variables are available), AST re-exports |
| `src/types/index.ts` | Create | Re-exports all types |
| `src/utils/input-parser.ts` | Create | `parseInputArgs(raw, inputDefs)` — parse `key=value` and `--key value`, validate required/defaults |
| `src/utils/retry.ts` | Create | `withRetry(fn, maxRetries)` — retry loop with exponential backoff |
| `package.json` | Create | Project config: name `w7s`, deps, scripts, `"type": "module"` |
| `tsconfig.json` | Create | Strict TS config targeting Bun/ESM |

**Total: 29 new files, 0 modified, 0 deleted**

## Interfaces / Contracts

```typescript
// --- Workflow Schema Types (inferred from Zod) ---

interface Workflow {
  name: string
  description?: string
  trigger: { commands: string[] }
  inputs?: Record<string, { description?: string; required?: boolean; default?: string }>
  steps: Step[]
}

type Step = AiPromptStep | ShellStep | ApprovalStep

interface StepBase {
  id: string
  type: string
  description?: string
  when?: string       // ${{ }} expression
  retry?: number
}

interface AiPromptStep extends StepBase {
  type: "ai_prompt"
  prompt: string
  agent?: string
  output?: string
  output_format?: "text" | "json"
}

interface ShellStep extends StepBase {
  type: "shell"
  run: string
  output?: string
  env?: Record<string, string>
}

interface ApprovalStep extends StepBase {
  type: "approval"
  message: string
}

// --- Execution Types ---

type ExecutionStatus = "running" | "completed" | "failed" | "cancelled"
type StepStatus = "pending" | "running" | "completed" | "skipped" | "failed"

interface StepResult {
  stepId: string
  status: StepStatus
  output?: unknown          // string | parsed JSON object
  exitCode?: number         // shell steps only
  error?: string
  duration: number          // ms
  attempts: number          // 1 = no retry
}

interface WorkflowResult {
  workflow: string
  status: ExecutionStatus
  steps: StepResult[]
  inputs: Record<string, string>
  startedAt: string         // ISO timestamp
  completedAt: string
  duration: number
  failedStep?: string
  error?: string
}

// --- Execution Context ---

interface ExecutionContext {
  inputs: Record<string, string>
  steps: Record<string, { output: unknown; exit_code?: number }>
  workflow: { name: string }
  env: Record<string, string>
  get(path: string): unknown  // resolve "steps.init.output.has_legacy"
  set(stepId: string, result: StepResult): void
}

// --- Step Executor Interface ---

interface StepExecutor<T extends Step = Step> {
  execute(step: T, context: ExecutionContext): Promise<StepResult>
}

// --- Expression AST ---

type ASTNode = AccessNode | OrNode | ComparisonNode | LiteralNode
interface AccessNode { type: "access"; path: string[] }       // steps.init.output
interface OrNode { type: "or"; left: ASTNode; right: ASTNode }
interface ComparisonNode { type: "comparison"; op: "==" | "!="; left: ASTNode; right: ASTNode }
interface LiteralNode { type: "literal"; value: string | boolean | number }

// --- Plugin Signature ---

type Plugin = (ctx: PluginContext) => Promise<Hooks>
// ctx: { project, client, $, directory, worktree }
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Expression tokenizer — all token types, edge cases | Pure function tests with vitest. Input string → expected tokens |
| Unit | Expression parser — AST construction for each grammar rule | Token stream → expected AST. Cover: access, or, comparison, literals |
| Unit | Expression evaluator — variable resolution, operators | AST + mock context → expected value. Cover: nested props, `\|\|` fallback, `==`/`!=`, undefined vars |
| Unit | `interpolate()` — template string with multiple `${{ }}` blocks | Template + context → expected string. Cover: no expressions, single, multiple, nested |
| Unit | Zod schemas — valid/invalid workflow YAML | `schema.safeParse()` on fixture objects. Cover: all step types, missing required fields, invalid types |
| Unit | JSON extractor — all strategies | Raw LLM text → extracted JSON. Cover: fenced, bracket-scan, raw, mixed content, invalid JSON |
| Unit | Input parser — `key=value`, `--key value`, defaults, required | Argument string → parsed inputs or validation error |
| Unit | Retry utility — backoff timing, success on Nth attempt | Mock fn that fails N times then succeeds. Verify call count and delay pattern |
| Integration | WorkflowLoader — full load pipeline | Fixture YAML files on disk → registry with correct workflows, triggers, precedence |
| Integration | StepExecutors — mocked `client` and `$` | Mock `session.create`/`session.prompt`/`$`, verify correct calls and output handling |
| Integration | ExecutionEngine — full workflow with mocked step executors | Multi-step workflow → verify execution order, `when` skips, context propagation, retry, failure stop |
| Integration | Commands (validate, dry-run, list) — mocked registry | Mock registry with fixture workflows → verify output format and error detection |
| E2E | Full plugin with real YAML → command trigger → execution | Requires OpenCode test harness or mock plugin context. Define approach in spike |

## Migration / Rollout

No migration required. Greenfield plugin — remove `w7s` from `opencode.json` to fully revert. YAML workflow files are inert without the plugin.

## Open Questions

- [x] Expression engine approach — **decided**: custom tokenizer + parser (see Decision #2)
- [x] Approval mechanism — **decided**: chat-based message + poll (see Decision #4)
- [ ] `command.execute.before` blocking — does setting `output.parts` prevent default processing? **Spike required before implementing trigger wiring** — if it doesn't block, throw an error to abort or use config-based custom commands
- [ ] `session.prompt` timeout behavior for 60+ second LLM responses — **test in spike**, plan B is `promptAsync` + event polling
- [ ] `session.prompt({body: {agent: "name"}})` — confirm it loads full agent config (model, tools, permissions, system) — **verify in spike**
