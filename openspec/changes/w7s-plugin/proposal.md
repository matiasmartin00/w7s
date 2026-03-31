# Proposal: w7s OpenCode Workflows Plugin v1

## Intent

Developers using OpenCode have repeatable multi-step processes (SDD pipelines, deploy flows, review checklists) that they currently explain to the LLM each session — wasting context tokens, producing unreliable step ordering, and lacking verifiability. **w7s** moves orchestration into deterministic code: a plugin that reads declarative YAML workflows and executes steps sequentially, letting the LLM reason only within each bounded step.

## Scope

### In Scope
- **Plugin entry point** — hook registration (`command.execute.before`, `event`, `experimental.chat.system.transform`)
- **YAML loader** — resolve local (`{repo}/.opencode/workflows/`) + global (`~/.opencode/workflows/`), precedence rules, one-file-per-workflow
- **Schema validation** — Zod v4 schemas for workflow, steps, inputs
- **Expression engine** — custom `${{ }}` interpolator: variable access (`steps.X.output`, `inputs.Y`, `env.Z`, `workflow.name`), property traversal, fallback `||`, comparison `==`/`!=`, boolean coercion for `when`
- **3 step types**:
  - `ai_prompt` — isolated session via `client.session.prompt`, agent delegation, `output_format: json` with parse-or-fail
  - `shell` — `ctx.$` (BunShell), stdout/stderr/exitCode capture, `env` map, `retry`
  - `approval` — pause workflow, show interpolated message, continue/cancel
- **Sequential execution engine** — linear state machine, `when` condition evaluation, step skip semantics
- **Step output context** — outputs stored by step id, accessible via `${{ steps.X.output }}` and `.field` for JSON
- **Management commands** — `/w7s validate [workflow]`, `/w7s dry-run <workflow> [inputs]`, `/w7s list`
- **Execution logging** — `.opencode/workflows/.runs/<workflow>-<timestamp>.log`, history rotation (default 5)
- **Conflict resolution** — same-name: local wins; duplicate trigger: validation error, neither loads
- **Error handling** — retry with exponential backoff (1s, 2s, 4s…), fail-stop on exhaustion
- **Input parsing** — `key=value` and `--key value` syntaxes from command arguments

### Out of Scope
- Central registry of reusable actions
- Visual UI for building workflows
- External triggers (webhooks, CI/CD)
- Step parallelism
- Actions as a step type (v2)
- `continue_on_error` per step (v2)
- Automatic workflow detection by context (v2)

## Approach

**Lean custom engine** with 3 external deps: `@opencode-ai/plugin` (required), `yaml` v2, `zod` v4.

### Architecture

```
src/
├── index.ts              — Plugin entry, hook wiring
├── loader/
│   ├── resolver.ts       — Find YAML files (local + global paths)
│   ├── parser.ts         — YAML parse + Zod schema validation
│   └── registry.ts       — Workflow registry, trigger→workflow map
├── engine/
│   ├── executor.ts       — Sequential state machine (main loop)
│   ├── context.ts        — Execution context (inputs, step outputs)
│   └── interpolator.ts   — ${{ }} expression parser + evaluator
├── steps/
│   ├── ai-prompt.ts      — session.prompt with agent, output_format
│   ├── shell.ts          — ctx.$ execution, retry, env
│   └── approval.ts       — Pause, message, continue/cancel
├── commands/
│   ├── validate.ts       — Schema + reference + agent checks
│   ├── dry-run.ts        — Simulate with interpolated prompts
│   └── list.ts           — Show available workflows
├── logging/
│   ├── history.ts        — Write/rotate execution logs
│   └── formatter.ts      — Log formatting (step status, timing)
└── types/
    ├── workflow.ts        — Zod schemas + TS types
    └── execution.ts       — Runtime state types
```

### Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Trigger mechanism | `command.execute.before` hook | Intercepts all commands; plugin checks trigger map; returns `output.parts` to prevent default processing |
| ai_prompt execution | `client.session.prompt` (sync) | Creates isolated session per step, sends interpolated prompt with `agent` param, waits for response |
| Shell execution | `ctx.$` tagged template | BunShell built into plugin context, captures stdout/stderr/exitCode |
| Approval mechanism | Send prompt message + monitor for user reply | Most natural chat UX; avoids hijacking permission system meant for tool approvals |
| Expression engine | Custom recursive descent | Scope is small (var access, `||`, `==`); avoids `eval()` security risk; zero deps |
| JSON output extraction | Extract from markdown code fences, then raw parse | LLMs often wrap JSON in ```json blocks; strip fences first, then `JSON.parse` |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/index.ts` | New | Plugin entry point with all hook registrations |
| `src/loader/` | New | YAML file discovery, parsing, validation, registry |
| `src/engine/` | New | Core execution loop, context management, expression interpolation |
| `src/steps/` | New | Step type handlers (ai_prompt, shell, approval) |
| `src/commands/` | New | Management commands (validate, dry-run, list) |
| `src/logging/` | New | Execution history and log rotation |
| `src/types/` | New | Zod schemas and TypeScript types |
| `package.json` | New | Project setup with deps: @opencode-ai/plugin, yaml, zod |
| `tsconfig.json` | New | TypeScript strict config for Bun |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `command.execute.before` may not block default command processing — workflow triggers could execute twice | Med | **Test first in spike.** If returning `output.parts` doesn't suppress default, use a sentinel prefix (e.g., `_w7s:`) and register as custom commands in `opencode.json`. Fallback: use the `tool` hook to register trigger commands as tools. |
| `session.prompt` timeout for long-running ai_prompt steps (60s+ LLM responses) | Med | Start with sync `session.prompt`. If timeouts occur, switch to `promptAsync` + SSE event polling (`session.status → idle`). Add configurable timeout per step (default 120s). |
| Approval UX is not first-class in OpenCode — no built-in "approve/reject workflow step" primitive | Med | Use `session.prompt` to send the approval message as a user-visible prompt, asking the agent to relay approval request. Monitor user's next message for yes/no. If OpenCode adds a permission primitive later, adopt it. |
| JSON extraction from LLM output — responses may include markdown fences, preamble, or trailing text | High | Multi-strategy extraction: (1) regex for ```json fences, (2) find first `{`/`[` to last `}`/`]`, (3) raw `JSON.parse`. Retry on parse failure if `retry` configured. Add clear system prompt instruction: "respond with ONLY valid JSON". |
| Agent config via `session.prompt({agent})` may not fully load agent's model/tools/permissions | Low | Verify in spike that `agent` param in `session.prompt` inherits full config. If not, read agent config manually from OpenCode config and pass `model`, `tools`, `system` explicitly. |
| Concurrent workflow executions sharing state | Low | Each execution gets its own `ExecutionContext` instance with isolated step outputs. No shared mutable state. |
| Command argument parsing edge cases (`--key "value with spaces"`, special chars) | Low | Use simple key=value parser for v1. Document supported syntax. Expand in v2 if needed. |

## Rollback Plan

**Full revert**: Remove `w7s` from `opencode.json` plugins array. The plugin is self-contained — no modifications to OpenCode core, no database migrations, no global state. Workflow YAML files remain inert when the plugin is not loaded.

**Partial rollback**: Disable individual workflows by removing their YAML files. The plugin gracefully handles missing files on reload.

## Dependencies

- `@opencode-ai/plugin` v1.3.10+ — plugin SDK (required, provides `ctx`, hooks, client)
- `yaml` v2.x — YAML parsing with schema support
- `zod` v4.x — schema validation (already transitive dep of @opencode-ai/plugin)
- `vitest` — test runner (dev dependency)

## Success Criteria

- [ ] A YAML workflow runs end-to-end with ai_prompt, shell, and approval steps
- [ ] Step outputs are accessible via `${{ steps.X.output }}` with property traversal
- [ ] `output_format: json` parses response into object with field access
- [ ] Shell step failure stops workflow with diagnostic output
- [ ] `retry: N` retries with exponential backoff before failing
- [ ] Local workflows override global workflows with same name
- [ ] Duplicate trigger commands produce validation error on load
- [ ] `when: false` steps are skipped without executing
- [ ] Approval step pauses workflow and respects user's continue/cancel
- [ ] `/w7s validate` catches schema errors, broken refs, missing agents
- [ ] `/w7s dry-run` shows step sequence with interpolated prompts
- [ ] `/w7s list` shows all workflows with triggers and inputs
- [ ] Execution logs are written and rotated (default 5)
- [ ] Each ai_prompt step runs in isolated session with specified agent
- [ ] Input parameters are parsed from command arguments and interpolated
- [ ] Setup time for a new workflow < 10 minutes
