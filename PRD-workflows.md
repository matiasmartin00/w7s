# PRD: w7s — OpenCode Workflows Plugin

**Status:** Draft v0.4  
**Author:** Matías Leandro Martin  
**Date:** 2026-03-31

---

## 1. Problem

OpenCode allows defining agent behavior through skills, agents, and system prompts. But when a developer has a process with a fixed structure — a sequence of steps that is always the same — the only option today is to explain that sequence to the LLM in the context and trust that it follows it.

This has concrete problems:

- **Wasted context** — Orchestration instructions consume tokens that could be used to reason about the actual problem. A 7-step workflow documented in a skill takes hundreds of tokens per session.
- **Unreliable execution** — The LLM may skip steps, reorder them, or decide a step "doesn't apply." There's no guarantee the sequence will be executed as defined.
- **Not verifiable** — There's no way to know if the LLM respected the order until you read through all the output.
- **Repeated across sessions** — The process has to be re-explained every time, whether via prompts, skills, or agent definitions.

Concrete examples:
- An SDD workflow always has the same steps: `init → explore → design → propose → tasks → apply → verify`. There's no reason to spend context for the LLM to decide whether to execute them or in what order.
- An `npm install`, a formatter, or a build script don't need reasoning. They're commands. Delegating them to the AI is introducing noise where it doesn't belong.

**The LLM should reason within each step. The orchestrator should handle the sequence, advancement conditions, and execution rules.**

---

## 2. Solution

**w7s** is an OpenCode server plugin that allows defining **declarative workflows** with typed steps. The plugin executes steps in deterministic order through code, not through the LLM. Each step can be:

- An instruction to the LLM (`ai_prompt`) — the LLM reasons, explores, and generates within a bounded step
- A shell script (`shell`) — deterministic command execution
- A pause for user confirmation (`approval`)

Steps can pass output to each other through explicit variables. The workflow accepts input parameters. The user triggers the workflow via explicit command.

The plugin works as a **sequential state machine**: it advances step by step, each step has clear preconditions and postconditions, and the flow is predictable and verifiable.

---

## 3. Target Users

Developers using OpenCode who have repeatable processes (custom methodologies, team conventions, project pipelines) that they don't want to re-explain to the LLM every session.

---

## 4. Scope v1

### 4.1 Out of scope
- Central registry of reusable actions
- Visual UI for building workflows
- External triggers (webhooks, CI/CD)
- Step parallelism
- Actions as a step type (revisit in v2)
- `continue_on_error` per step (v2)
- Automatic workflow detection by context (v2) — explicit triggers only in v1

---

## 5. Functional Design

### 5.1 File Structure

Workflows are defined in YAML. The plugin resolves in this order of precedence:

```
{repo}/.opencode/workflows/*.yaml   ← highest precedence
~/.opencode/workflows/*.yaml        ← global fallback
```

One workflow per file. The filename is the workflow identifier.

### 5.2 Workflow Schema

```yaml
name: SDD
description: Complete Software Design Document workflow
trigger:
  commands:
    - /sdd
    - /run sdd

inputs:
  feature:
    description: "Feature to design"
    required: true
  scope:
    description: "Scope of the change"
    default: "full"

steps:
  - id: init
    type: ai_prompt
    agent: sdd-init
    description: "Analyzing repository"
    prompt: |
      Analyze the repository focusing on: ${{ inputs.feature }}
      Scope: ${{ inputs.scope }}
      Produce a summary of the current project state.
      Include: stack, folder structure, visible tech debt.
    output: project_summary
    output_format: json

  - id: explore
    type: ai_prompt
    agent: sdd-explore
    description: "Exploring project modules"
    prompt: |
      Given this project context:
      ${{ steps.init.output }}

      Explore the relevant files to understand the problem domain.
      List key modules and their responsibilities.

      Respond in JSON with the structure:
      { "modules": [...], "has_legacy": true/false, "summary": "..." }
    output: exploration
    output_format: json

  - id: confirm_design
    type: approval
    message: |
      Exploration completed. Modules found:
      ${{ steps.explore.output.summary }}

      Continue with design?

  - id: design_simple
    type: ai_prompt
    agent: sdd-design
    when: ${{ steps.explore.output.has_legacy == false }}
    prompt: |
      Based on:
      ${{ steps.explore.output }}
      Propose a straightforward design without over-engineering.
    output: design

  - id: design_complex
    type: ai_prompt
    agent: sdd-design
    when: ${{ steps.explore.output.has_legacy == true }}
    prompt: |
      Based on:
      ${{ steps.explore.output }}
      The project has legacy components. Propose a design that considers
      progressive migration and backward compatibility.
    output: design

  - id: lint_check
    type: shell
    description: "Running linter"
    run: npm run lint
    output: lint_result
    retry: 2

  - id: verify
    type: ai_prompt
    agent: sdd-verify
    description: "Verifying design consistency"
    prompt: |
      Review the proposed design:
      ${{ steps.design_simple.output || steps.design_complex.output }}

      Lint result:
      ${{ steps.lint_check.output }}

      Is the design consistent with the current state of the code?
      List problems if any, or confirm it's ready to proceed.
```

### 5.3 Step Types

#### `ai_prompt`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique step identifier |
| `type` | `"ai_prompt"` | yes | Step type |
| `description` | string | no | Short text shown in UI and logs during execution. Defaults to `id` if not specified |
| `prompt` | string | yes | Instruction to the LLM. Supports `${{ }}` interpolation. Injected as the user message to the agent |
| `agent` | string | no | Name of the OpenCode agent to use for this step. The agent defines model, tools, permissions, and system prompt. If not specified, the session's default agent is used |
| `output` | string | no | Variable name where the response is stored |
| `output_format` | `"text"` \| `"json"` | no | Output format. Default `"text"`. If `"json"`, the LLM must respond with valid JSON. The output is parsed as an object accessible by field. If parsing fails, the step is treated as failed (retry applies if configured) |
| `when` | string | no | `${{ }}` expression that evaluates to true/false. If false, the step is skipped |
| `retry` | int | no | Number of retries on failure (default: 0) |

#### `shell`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique step identifier |
| `type` | `"shell"` | yes | Step type |
| `description` | string | no | Short text shown in UI and logs during execution. Defaults to `id` if not specified |
| `run` | string | yes | Bash/sh script to execute |
| `output` | string | no | Captures script stdout |
| `env` | map | no | Additional environment variables |
| `when` | string | no | Conditional expression |
| `retry` | int | no | Number of retries on failure (default: 0) |

The step fails if `exit code != 0`. If it has `retry: N`, it retries up to N times. If it exhausts retries, the workflow stops and reports the error with stdout/stderr.

#### `approval`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique step identifier |
| `type` | `"approval"` | yes | Step type |
| `description` | string | no | Short text shown in UI and logs during execution. Defaults to `id` if not specified |
| `message` | string | yes | Message shown to the user. Supports `${{ }}` interpolation |
| `when` | string | no | Conditional expression |

The workflow pauses and shows the message to the user. If the user confirms, it continues. If they cancel, the workflow stops.

### 5.4 Variables and Context

The system exposes an execution context accessible via `${{ }}`:

| Variable | Type | Description |
|---|---|---|
| `steps.<id>.output` | string \| object | Step output. If `output_format: json`, it's an object accessible by field (`steps.X.output.field`) |
| `steps.<id>.exit_code` | int | Only for `shell` steps |
| `inputs.<name>` | string | Workflow input parameters |
| `workflow.name` | string | Name of the running workflow |
| `env.<VAR>` | string | System environment variables |

The `||` operator allows fallback between variables: `${{ steps.a.output || steps.b.output }}`.

### 5.5 Context Between Steps

Each `ai_prompt` step executes in an **isolated session**. The invoked agent does not receive the conversation history from previous steps.

Context between steps is shared through two complementary mechanisms:

**1. Explicit interpolation (`${{ }}`)** — For specific, structured data that a step needs from a previous one. Useful for flags, configurations, and concrete values. Example: `${{ steps.explore.output.has_legacy }}`.

**2. Persistent memory (Engram / OpenSpec)** — At the end of each step, the plugin persists the output and relevant metadata to the memory system. The next step's agent can retrieve broad context via `mem_search` / `mem_context` without the workflow needing to copy the entire output literally.

This means:
- Workflow prompts don't need to be verbose. There's no need to copy the full output of the previous step into each prompt.
- `${{ steps.X.output }}` is used for concrete data that the step needs as direct input (e.g., a JSON with flags, a path, a value).
- Rich context (codebase exploration, architecture analysis, design decisions) flows through the memory layer, just as it would between manual sessions.
- The plugin handles persisting each step's output on completion — the workflow author doesn't need to configure this.

### 5.6 Triggers

A workflow is triggered exclusively by **explicit command**.

The user types the command defined in `trigger.commands` (e.g., `/sdd` or `/run sdd`) in the OpenCode interface. The plugin intercepts the command via the `command.execute.before` hook and executes the corresponding workflow.

Inputs are passed as command arguments:

```
/sdd feature=auth scope=backend
/sdd --feature auth --scope backend
```

If a `required` input is not provided, the plugin prompts the user for the value before starting the workflow.

### 5.7 Error Handling

- If a step has `retry: N`, it retries up to N times on failure. Between each retry, there's an incremental backoff (1s, 2s, 4s...).
- If a step exhausts its retries (or has no retry configured and fails): the workflow stops, reports the failed step, shows full stdout/stderr for `shell` steps or the API error for `ai_prompt` steps, and does not execute subsequent steps.
- If an `approval` step is cancelled by the user: the workflow stops with a "cancelled by user" status.
- Steps completed before the error **are not reverted**.

### 5.8 Logging and Execution History

The plugin stores a history of the last N executions per workflow (default: 5, configurable).

Location:
```
{repo}/.opencode/workflows/.runs/<workflow>-<timestamp>.log
```

Each log contains:
- Start and end timestamps
- Inputs received
- Output of each step (stdout, AI response, approval result)
- Final status (completed, failed, cancelled)
- Failed step and error, if applicable

Logs are automatically rotated: when the limit of N is exceeded, the oldest is deleted.

### 5.9 Management Commands

The plugin registers its own commands for managing workflows without executing them:

#### `/w7s validate [workflow]`

Validates a workflow (or all if not specified) without executing it. Checks:
- Correct YAML syntax
- Required fields present in each step
- Valid inter-step references (`${{ steps.X.output }}` points to a step that exists and executes before)
- Referenced agents exist in OpenCode configuration
- No duplicate trigger commands between workflows
- Inputs referenced in prompts are defined in the `inputs` block

```
/w7s validate sdd

[Validation: sdd]
✓ YAML syntax
✓ Steps: 7 defined, all with required fields
✓ References: all ${{ }} variables resolve
✓ Agents: sdd-init, sdd-explore, sdd-design, sdd-verify — all exist
✓ Triggers: /sdd, /run sdd — no conflicts
✓ Inputs: feature (required), scope (default: "full")

Workflow valid.
```

#### `/w7s dry-run <workflow> [inputs]`

Simulates workflow execution showing the sequence of steps that would run, with interpolated prompts, without executing anything. Useful for verifying that inputs interpolate correctly and that `when` conditions resolve as expected.

```
/w7s dry-run sdd feature=auth

[Dry-run: SDD]
  inputs: feature=auth, scope=full (default)

1. init (ai_prompt, agent: sdd-init)
   description: "Analyzing repository"
   prompt: "Analyze the repository focusing on: auth..."

2. explore (ai_prompt, agent: sdd-explore)
   description: "Exploring project modules"
   prompt: "Given this project context: <pending>..."

3. confirm_design (approval)
   message: "Exploration completed..."

4. design_simple (ai_prompt, agent: sdd-design)
   when: steps.explore.output.has_legacy == false → <pending>

5. design_complex (ai_prompt, agent: sdd-design)
   when: steps.explore.output.has_legacy == true → <pending>

6. lint_check (shell, retry: 2)
   description: "Running linter"
   run: "npm run lint"

7. verify (ai_prompt, agent: sdd-verify)
   description: "Verifying design consistency"
   prompt: "Review the proposed design: <pending>..."

Steps depending on previous output are marked as <pending>.
```

#### `/w7s list`

Lists all available workflows with their triggers and inputs.

```
/w7s list

Available workflows:
  sdd       /sdd, /run sdd      inputs: feature (required), scope (default: "full")
  deploy    /deploy              inputs: env (required)
  review    /review              inputs: pr (required)
```

### 5.10 Conflict Resolution

- **Same workflow name**: local (`{repo}/.opencode/workflows/`) takes precedence over global (`~/.opencode/workflows/`). The global one is silently ignored.
- **Same trigger command between two different workflows**: this is a **validation error**. The plugin reports the conflict on load and does not register either of the conflicting workflows. The user must resolve it before they can use either of them.

---

## 6. User Experience

### Successful execution
```
User: /sdd feature=auth

[Workflow: SDD]
  inputs: feature=auth, scope=full (default)

▶ init              Analyzing repository...            ✓ (3.2s)
▶ explore           Exploring project modules...       ✓ (5.1s)
▶ confirm_design    Exploration completed.
                    Modules: auth, users, sessions
                    Continue with design?              [y/n] y
▶ design_complex    Generating design (legacy)...      ✓ (8.4s)
  design_simple     (skipped — when: false)
▶ lint_check        Running linter...                  ✓ (1.1s)
▶ verify            Verifying consistency...            ✓ (4.0s)

Workflow completed in 21.8s
Log saved to .opencode/workflows/.runs/sdd-2026-03-31T14:32:00.log
```

### Error with retry
```
▶ lint_check        Running linter...                  ✗ (attempt 1/3)
                    Running linter...                  ✗ (attempt 2/3)
                    Running linter...                  ✗ (attempt 3/3)

Error in step: lint_check (exhausted 3 retries)
stdout: ESLint found 3 errors in src/auth/token.ts
stderr: ...

Workflow stopped.
Log saved to .opencode/workflows/.runs/sdd-2026-03-31T14:32:00.log
```

### Approval cancelled
```
▶ confirm_design    Continue with design?              [y/n] n

Workflow cancelled by user at step: confirm_design
Log saved to .opencode/workflows/.runs/sdd-2026-03-31T14:32:00.log
```

---

## 7. Integration Architecture

w7s is implemented as an OpenCode **server plugin** using `@opencode-ai/plugin`.

### Registration

```json
// opencode.json
{
  "plugin": ["w7s"]
}
```

### Hooks Used

| Hook | Usage |
|---|---|
| `command.execute.before` | Intercepts commands defined in `trigger.commands` for each workflow. Parses command inputs. |
| `event` | Listens to `session.created` to load available workflows. Listens to `session.idle` for cleanup. |
| `experimental.chat.system.transform` | When executing an `ai_prompt`, injects the step prompt as context. If the step has an `agent`, the plugin delegates execution to the corresponding agent with its full configuration. |

### Step Execution

| Step type | Mechanism |
|---|---|
| `ai_prompt` | Invokes the specified agent (or the session default) via `ctx.client`, sending the interpolated prompt as a user message. The agent inherits its full configuration: model, tools, permissions, and system prompt. If `output_format: json`, instructs the LLM to respond in JSON and parses the response. |
| `shell` | Executes the script via `ctx.$` (Bun shell). Captures stdout, stderr, and exit code. |
| `approval` | Uses OpenCode's permission/confirmation system to pause and wait for user response. |

### Workflow Resolution

On startup, the plugin:
1. Reads YAML files from `{repo}/.opencode/workflows/` and `~/.opencode/workflows/`
2. Parses and validates against the schema
3. Applies precedence: local workflows override globals with the same name
4. Validates that there are no duplicate trigger commands between different workflows — if there are, reports an error and does not register the conflicting workflows
5. Registers trigger commands for valid workflows

---

## 8. Decisions Made

| # | Question | Decision | Reasoning |
|---|---|---|---|
| 1 | Reusable actions in v1? | **No, v2** | The v1 core is enough to validate |
| 2 | How to version a shared workflow? | **Git** | `.opencode/workflows/` inside the repo |
| 3 | Can the agent modify a workflow before executing it? | **No** | Static workflows in v1 |
| 4 | Retry per step? | **Yes, `retry: N`** | Useful for shell with network and transient API errors. Trivial to implement |
| 5 | Execution model? | **Linear list with `when`** | Simpler and more readable than a DAG. Steps execute top-to-bottom, `when` activates/deactivates |
| 6 | AI configuration per step? | **`agent` field** | Each step references an OpenCode agent that defines model, tools, and permissions. No loose `model` or `tools` — all configuration comes from the agent. If not specified, uses the session's default agent |
| 7 | Input parameters? | **Yes in v1** | `inputs` block with required/default. Without this, workflows are static and not very reusable |
| 8 | continue_on_error? | **No, v2** | Simplifies the model. If it fails, it stops |
| 9 | Approval step? | **Yes in v1** | New step type for sensitive operations. Cheap to implement |
| 10 | Context-based trigger? | **No, v2** | Reintroduces LLM dependency for something deterministic. Explicit commands only in v1 |
| 11 | Logging? | **History of N executions** | Automatic storage of the last N runs per workflow. Default: 5 |
| 12 | Conditions on LLM output? | **Structured output (JSON)** | `output_format: json` allows evaluating specific fields instead of searching for text in prose |
| 13 | Context between steps? | **Isolated sessions + persistent memory** | Each ai_prompt is a new session. Rich context flows via Engram/OpenSpec. `${{ }}` for specific data. The plugin persists each step's output on completion |
| 14 | Duplicate trigger commands? | **Validation error** | If two different workflows register the same command, neither is loaded. The user must resolve the conflict |
| 15 | Management commands? | **validate, dry-run, list** | To validate workflows without executing, simulate execution, and list available workflows |
| 16 | What if output_format: json fails to parse? | **Step failure** | Invalid JSON is treated as a step failure. Retry applies if configured. Forces the agent to fulfill the contract |

---

## 9. Success Criteria (v1)

- A workflow defined in YAML runs end-to-end without user intervention (except explicit approvals)
- A step's output is accessible as input to the next step with explicit syntax
- A shell step that fails stops the workflow with useful diagnostic information
- A step with `retry: N` retries correctly before failing
- The same workflow defined globally can be overridden by a local one in the repo
- Workflow inputs are passed by command and interpolated correctly in prompts
- Steps with `when: false` are skipped without executing
- An `approval` step pauses the workflow and respects the user's decision
- Execution history is saved and rotated correctly
- An `ai_prompt` step with a configured `agent` executes with that agent (model, tools, permissions inherited)
- An `ai_prompt` step without an `agent` executes with the session's default agent
- An `ai_prompt` step with `output_format: json` produces an object accessible by field
- Each `ai_prompt` step executes in an isolated session; context between steps flows via persistent memory
- `/w7s validate` detects schema errors, broken references, and nonexistent agents without executing
- `/w7s dry-run` shows the step sequence with interpolated prompts without executing
- `/w7s list` shows all available workflows with triggers and inputs
- Two workflows with the same trigger command produce a validation error on load
- A step with `output_format: json` that receives invalid JSON is treated as failure and retries apply
- The setup time to define a new workflow from scratch is less than 10 minutes
