# Exploration: w7s OpenCode Workflows Plugin

**Date**: 2026-03-31
**Change**: w7s-plugin
**Status**: Complete

---

## Executive Summary

The OpenCode plugin API (`@opencode-ai/plugin` v1.3.10) **fully supports** the three hooks referenced in the PRD: `command.execute.before`, `event` (with `session.created`/`session.idle`), and `experimental.chat.system.transform`. The SDK client provides `session.prompt` for synchronous agent execution and `ctx.$` (BunShell) for shell commands. All major PRD requirements are technically feasible. Key risks center on `command.execute.before` blocking behavior and the approval step UX.

---

## 1. Plugin API — Hook Verification

### Confirmed Hooks (from actual TypeScript types)

| Hook | PRD References | Status | Signature |
|------|---------------|--------|-----------|
| `command.execute.before` | Intercept trigger commands | **EXISTS** | `(input: {command, sessionID, arguments}, output: {parts: Part[]})` |
| `event` | `session.created`, `session.idle` | **EXISTS** | `(input: {event: Event})` — union of 30+ event types |
| `experimental.chat.system.transform` | Inject step prompt | **EXISTS** | `(input: {sessionID?, model}, output: {system: string[]})` |
| `tool.execute.before` | — | **EXISTS** | `(input: {tool, sessionID, callID}, output: {args})` |
| `tool.execute.after` | — | **EXISTS** | `(input: {tool, sessionID, callID, args}, output: {title, output, metadata})` |
| `shell.env` | — | **EXISTS** | `(input: {cwd, sessionID?, callID?}, output: {env})` |
| `permission.ask` | Potential for approval | **EXISTS** | `(input: Permission, output: {status})` |
| `config` | — | **EXISTS** | `(input: Config)` |
| `tool` | Custom tool registration | **EXISTS** | `{[key: string]: ToolDefinition}` |
| `chat.message` | — | **EXISTS** | `(input: {sessionID, agent?, model?, ...}, output: {message, parts})` |
| `chat.params` | — | **EXISTS** | Modify temperature, topP, topK |
| `tool.definition` | — | **EXISTS** | Modify tool descriptions/parameters |

**Result: 0 API gaps. All PRD hooks are real.**

### Available Event Types (Event union)

The `Event` type includes: `session.created`, `session.updated`, `session.deleted`, `session.idle`, `session.status`, `session.compacted`, `session.error`, `session.diff`, `message.updated`, `message.removed`, `message.part.updated`, `message.part.removed`, `permission.updated`, `permission.replied`, `command.executed`, `file.edited`, `file.watcher.updated`, `todo.updated`, `vcs.branch.updated`, `server.connected`, `server.instance.disposed`, `lsp.*`, `pty.*`, `tui.*`

---

## 2. SDK Client (`ctx.client`) — Agent Execution

### Session Prompt (Sync) — Key for ai_prompt steps

```typescript
client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [
      { type: "agent", name: "sdd-explore" },
      { type: "text", text: "Analyze the repository..." }
    ],
    agent: "sdd-explore",          // agent config (model, tools, permissions)
    system: "Respond in JSON...",   // additional system prompt
    tools: { bash: true, read: true },  // override tools if needed
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }  // override model
  }
})
// Returns: { info: AssistantMessage, parts: Part[] }
```

- **Synchronous**: waits for LLM completion, returns full response
- **`promptAsync`**: fire-and-forget variant (returns 204 immediately)
- **`AgentPartInput`**: `{type: "agent", name: string}` — selects agent with all its config
- **`SubtaskPartInput`**: `{type: "subtask", prompt, description, agent}` — runs as subtask

### Other Critical Methods

- `client.session.create()` — new isolated session per step
- `client.session.abort()` — cancel running session
- `client.session.messages()` — read conversation history
- `client.event.subscribe()` — SSE event stream
- `client.app.agents()` — list available agents (for validation)
- `client.command.list()` — list registered commands

---

## 3. Shell Execution (`ctx.$`)

BunShell with tagged template literals:

```typescript
const result = await ctx.$`npm run lint`.quiet()
result.exitCode   // number
result.text()     // stdout as string  
result.stderr     // Buffer
```

- `.cwd(dir)` — change working directory
- `.env(vars)` — set environment variables
- `.quiet()` — suppress terminal output, buffer only
- `.nothrow()` — don't throw on non-zero exit
- `.text()`, `.json()`, `.lines()` — output accessors

**Perfect fit for `shell` step type. No gaps.**

---

## 4. Mechanisms for PRD Requirements

### 4.1 Command Registration (Workflow Triggers)

**Mechanism**: `command.execute.before` hook

```typescript
"command.execute.before": async (input, output) => {
  const workflow = registry.findByCommand(input.command)
  if (workflow) {
    const args = parseArguments(input.arguments)
    const result = await executor.run(workflow, args, input.sessionID)
    output.parts = formatResult(result)
  }
}
```

The hook receives the command name and arguments. If matched to a workflow trigger, execute the workflow and return parts.

**Risk**: Unknown if setting `output.parts` prevents default command processing.

### 4.2 Agent Execution (ai_prompt steps)

**Mechanism**: `client.session.create()` + `client.session.prompt()`

```typescript
async function executeAiPrompt(step, context, client) {
  const session = await client.session.create({ body: { title: `w7s: ${step.id}` } })
  const response = await client.session.prompt({
    path: { id: session.data.id },
    body: {
      agent: step.agent,
      parts: [{ type: "text", text: interpolate(step.prompt, context) }],
      system: step.output_format === "json" 
        ? "You MUST respond with valid JSON only. No markdown, no explanation." 
        : undefined
    }
  })
  const text = extractText(response.data.parts)
  return step.output_format === "json" ? JSON.parse(text) : text
}
```

### 4.3 Approval Pause

**Best approach**: Use the session to send a message to the user, then wait for their response.

```typescript
async function executeApproval(step, context, client, sessionID) {
  // Send approval message as a prompt that expects user input
  const message = interpolate(step.message, context)
  // Use the existing session to show the message
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      parts: [{ type: "text", text: `[Workflow Approval Required]\n\n${message}\n\nReply "yes" to continue or "no" to cancel.` }],
      noReply: true  // don't let the LLM respond, wait for user
    }
  })
  // Wait for user response via event stream
  // ...poll for message with role: "user" in the session
}
```

**Alternative**: Register a custom tool that uses `context.ask()` for the permission dialog.

### 4.4 Persistent Memory Integration

The plugin runs server-side. To persist step outputs to Engram:
- **Option A**: Shell out via `ctx.$` to call engram CLI
- **Option B**: Direct HTTP to Engram MCP server (if running as HTTP)
- **Option C**: The ai_prompt agent already has Engram tools — the prompt can instruct it to save

---

## 5. Core Modules

```
w7s/
├── src/
│   ├── index.ts              — Plugin entry, hook wiring
│   ├── loader/
│   │   ├── resolver.ts       — Find YAML files (local + global precedence)
│   │   ├── parser.ts         — YAML parse + Zod schema validation
│   │   └── registry.ts       — Workflow registry, trigger→workflow map
│   ├── engine/
│   │   ├── executor.ts       — Sequential execution loop (state machine)
│   │   ├── context.ts        — Variable store (inputs, step outputs)
│   │   └── interpolator.ts   — ${{ }} expression evaluator
│   ├── steps/
│   │   ├── ai-prompt.ts      — Create session, send prompt, capture output
│   │   ├── shell.ts          — Run via ctx.$, capture stdout/stderr/exitCode
│   │   └── approval.ts       — Pause and wait for user confirmation
│   ├── types/
│   │   ├── workflow.ts        — Zod schemas for YAML structure
│   │   └── execution.ts       — Runtime state types
│   ├── commands/
│   │   ├── validate.ts        — Schema + reference validation
│   │   ├── dry-run.ts         — Simulated execution with interpolation
│   │   └── list.ts            — List available workflows
│   └── logging/
│       ├── history.ts         — Run history storage + rotation
│       └── formatter.ts       — Step output formatting
├── package.json
├── tsconfig.json
└── tests/
```

---

## 6. Dependencies

| Package | Purpose | Version | Rationale |
|---------|---------|---------|-----------|
| `@opencode-ai/plugin` | Plugin API types + tools | ^1.3.10 | Required |
| `yaml` | YAML parsing | ^2.x | Better TS support than js-yaml, 0 deps |
| `zod` | Schema validation | ^4.x | Already transitive dep of @opencode-ai/plugin |

**Expression engine**: Custom (simple recursive descent). The scope is small: variable access, `||` fallback, `==`/`!=` comparisons. Using `eval()` or a full expression library would be over-engineering and a security risk.

---

## 7. Risks

### Critical

1. **`command.execute.before` blocking behavior** — Does setting `output.parts` prevent OpenCode from processing the command normally? If not, workflow commands might trigger both the workflow AND the default command handler. **Mitigation**: Build a minimal spike to test. If it doesn't block, use config-based custom commands as primary trigger and `command.execute.before` for validation/routing.

2. **`session.prompt` timeout** — HTTP request to OpenCode server. Long-running LLM steps (60+ seconds) may timeout. **Mitigation**: Use `promptAsync` + event polling for long steps, with configurable timeout.

### High

3. **Approval UX** — No built-in "workflow approval" primitive. The permission system (`context.ask()`, `permission.ask` hook) is designed for tool permissions, not workflow gates. Using it for approvals may confuse users. **Mitigation**: Use chat-based approval (send message, wait for user reply) for the most natural UX.

4. **Output extraction from LLM** — For `output_format: json`, the LLM may wrap JSON in markdown code blocks. Need robust extraction (regex for ```json blocks, fallback to raw parse). **Mitigation**: Include clear system prompt instruction + extraction logic with retry.

5. **Agent specification verification** — Need to confirm `session.prompt({body: {agent: "name"}})` actually loads the agent's full config (model, tools, permissions, system prompt). **Mitigation**: Test with a known agent in a spike.

### Medium

6. **Concurrent executions** — Multiple workflows running simultaneously need isolated state. Each execution gets its own context object.

7. **Argument parsing** — PRD supports `key=value` and `--key value` syntax. Need a mini-parser.

8. **Engram integration** — Plugin is server-side; needs to call Engram to persist step outputs. Best path: instruct the ai_prompt agent to save to Engram, or shell out to engram CLI.

---

## 8. Comparison with opencode-workflows (mark-hingston)

| Aspect | w7s (ours) | opencode-workflows |
|--------|------------|-------------------|
| Format | YAML | JSON |
| Execution | Linear + `when` | DAG with `after` |
| Engine | Custom (lightweight) | Mastra + LibSQL (heavy) |
| Dependencies | ~3 | ~10 |
| Step types | ai_prompt, shell, approval | agent, command, file, suspend |
| Agent config | References OpenCode agent | Inline model + maxTokens |
| Scheduling | Commands only (v1) | node-cron support |
| Expression | `${{ }}` | `{{ }}` |
| Size | Target: <50KB | 7.4MB unpacked |

**Our approach is deliberately leaner** — no external DB, no execution engine dependency, simpler linear model.

---

## 9. Recommendation

**Proceed to proposal.** The API landscape is favorable:
- All hooks exist and are well-typed
- The SDK client provides exactly the primitives needed
- BunShell covers shell execution perfectly
- Dependencies are minimal

**Priority items for the proposal:**
1. Define the `command.execute.before` behavior spike
2. Lock down the approval mechanism (chat-based vs permission-based)
3. Define the expression engine scope precisely
4. Decide on Engram integration approach
