# w7s Workflows Specification

## Purpose

Declarative YAML workflow engine for OpenCode — deterministic step-by-step execution with 3 step types (ai_prompt, shell, approval), expression interpolation, management commands, and execution logging.

---

## Module 1: Workflow Loader

### REQ-LOAD-001: YAML File Discovery

The system MUST discover workflow files from `{repo}/.opencode/workflows/*.yaml` (local) and `~/.opencode/workflows/*.yaml` (global). One workflow per file; filename is the workflow identifier.

#### Scenario: Local and global workflows loaded

- GIVEN local dir has `sdd.yaml` and global dir has `deploy.yaml`
- WHEN the plugin loads workflows
- THEN both workflows are registered with identifiers `sdd` and `deploy`

#### Scenario: Empty directories

- GIVEN both local and global workflow directories are empty or missing
- WHEN the plugin loads workflows
- THEN zero workflows are registered and no error is thrown

### REQ-LOAD-002: Schema Validation

The system MUST validate each YAML file against the workflow schema. A file with missing required fields (name, steps, step.id, step.type) or invalid step types MUST be rejected with a descriptive error.

#### Scenario: Invalid YAML rejected

- GIVEN a YAML file missing the `steps` field
- WHEN the plugin parses it
- THEN the workflow is rejected with an error identifying the missing field
- AND the remaining valid workflows are still loaded

#### Scenario: Unknown step type rejected

- GIVEN a YAML file with a step of `type: "unknown"`
- WHEN the plugin parses it
- THEN the workflow is rejected with an error identifying the invalid step type

### REQ-LOAD-003: Precedence Resolution

The system MUST apply local-over-global precedence: when a local and global workflow share the same filename (identifier), the local version MUST be used and the global version silently ignored.

#### Scenario: Local overrides global

- GIVEN local has `sdd.yaml` and global has `sdd.yaml`
- WHEN the plugin loads workflows
- THEN only the local `sdd.yaml` is registered

### REQ-LOAD-004: Trigger Conflict Detection

The system MUST detect when two different workflows register the same trigger command. Conflicting workflows MUST NOT be registered; the plugin MUST report the conflict.

#### Scenario: Duplicate triggers rejected

- GIVEN workflow A has trigger `/deploy` and workflow B also has trigger `/deploy`
- WHEN the plugin loads workflows
- THEN neither A nor B is registered
- AND an error reports the trigger conflict between A and B

---

## Module 2: Expression Engine

### REQ-EXPR-001: Interpolation Syntax

The system MUST resolve `${{ <expression> }}` tokens within strings, replacing them with evaluated values. Unresolved variables MUST produce an empty string (not throw).

#### Scenario: Simple variable resolution

- GIVEN context has `inputs.feature = "auth"`
- WHEN interpolating `"Build: ${{ inputs.feature }}"`
- THEN the result is `"Build: auth"`

#### Scenario: Unresolved variable

- GIVEN context has no `inputs.missing`
- WHEN interpolating `"Value: ${{ inputs.missing }}"`
- THEN the result is `"Value: "`

### REQ-EXPR-002: Variable Namespaces

The system MUST support these namespaces: `steps.<id>.output` (string or object), `steps.<id>.exit_code` (shell only), `inputs.<name>`, `workflow.name`, `env.<VAR>`.

#### Scenario: Step output access

- GIVEN step `init` completed with output `"summary text"`
- WHEN evaluating `${{ steps.init.output }}`
- THEN the result is `"summary text"`

#### Scenario: Environment variable

- GIVEN env `HOME=/Users/dev`
- WHEN evaluating `${{ env.HOME }}`
- THEN the result is `"/Users/dev"`

### REQ-EXPR-003: Nested Field Access

The system MUST support dot-notation for accessing fields on JSON-parsed step outputs (e.g., `steps.X.output.field`).

#### Scenario: Nested JSON field

- GIVEN step `explore` output is `{"has_legacy": true, "summary": "found 3 modules"}`
- WHEN evaluating `${{ steps.explore.output.summary }}`
- THEN the result is `"found 3 modules"`

### REQ-EXPR-004: Fallback Operator

The system MUST support `||` as a fallback operator: `${{ A || B }}` returns A if truthy, otherwise B.

#### Scenario: First value truthy

- GIVEN `steps.a.output = "result A"` and `steps.b.output = "result B"`
- WHEN evaluating `${{ steps.a.output || steps.b.output }}`
- THEN the result is `"result A"`

#### Scenario: First value falsy, fallback used

- GIVEN step `a` was skipped (no output) and `steps.b.output = "result B"`
- WHEN evaluating `${{ steps.a.output || steps.b.output }}`
- THEN the result is `"result B"`

### REQ-EXPR-005: Comparison for `when` Conditions

The system MUST support `==` and `!=` comparisons that evaluate to boolean, and MUST coerce values to boolean for `when` conditions. `false`, `"false"`, `""`, `null`, `undefined`, `0` MUST be falsy.

#### Scenario: When condition evaluates to false

- GIVEN `steps.explore.output.has_legacy == false` evaluates to `false`
- WHEN the engine evaluates the `when` condition
- THEN the step is skipped

#### Scenario: When condition evaluates to true

- GIVEN `steps.explore.output.has_legacy == true` evaluates to `true`
- WHEN the engine evaluates the `when` condition
- THEN the step is executed

---

## Module 3: Step Executors

### REQ-STEP-AI-001: Agent Execution

An `ai_prompt` step MUST create an isolated session, send the interpolated prompt to the specified agent (or session default if none), and capture the response text as step output.

#### Scenario: ai_prompt with specified agent

- GIVEN a step with `agent: "sdd-init"` and `prompt: "Analyze ${{ inputs.feature }}"`
- WHEN the step executes
- THEN a new isolated session is created
- AND the prompt is sent to agent `sdd-init`
- AND the response text is stored as the step's output

#### Scenario: ai_prompt without agent uses default

- GIVEN a step with no `agent` field
- WHEN the step executes
- THEN the session's default agent is used

### REQ-STEP-AI-002: JSON Output Format

When `output_format: json`, the system MUST extract and parse JSON from the LLM response. The parsed object MUST be accessible by field via `steps.X.output.field`. If JSON parsing fails, the step MUST be treated as failed (retry applies).

#### Scenario: Valid JSON extracted

- GIVEN a step with `output_format: json`
- WHEN the LLM responds with `{"modules": ["auth"], "count": 1}`
- THEN `steps.X.output.modules` resolves to `["auth"]`
- AND `steps.X.output.count` resolves to `1`

#### Scenario: Invalid JSON treated as failure

- GIVEN a step with `output_format: json` and `retry: 1`
- WHEN the LLM responds with non-parseable text
- THEN the step fails and is retried
- AND if retry also fails, the workflow stops with an error

### REQ-STEP-AI-003: Isolated Sessions

Each `ai_prompt` step MUST execute in its own isolated session. The agent MUST NOT receive conversation history from previous steps.

#### Scenario: No cross-step history

- GIVEN steps A and B are both `ai_prompt`
- WHEN step B executes after step A
- THEN step B's session does not contain step A's messages

### REQ-STEP-SHELL-001: Shell Execution

A `shell` step MUST execute the `run` script, capture stdout as output, capture stderr, and record the exit code. Exit code != 0 MUST be treated as failure.

#### Scenario: Successful shell step

- GIVEN a step with `run: "echo hello"`
- WHEN the step executes
- THEN output is `"hello"` and exit_code is `0`

#### Scenario: Failed shell step

- GIVEN a step with `run: "exit 1"`
- WHEN the step executes
- THEN the step fails with exit_code `1`
- AND stderr is captured for the error report

### REQ-STEP-SHELL-002: Environment Variables

A `shell` step with an `env` map MUST inject those variables into the shell environment for that execution.

#### Scenario: Custom env vars

- GIVEN a step with `env: {NODE_ENV: "test"}`
- WHEN the step executes `run: "echo $NODE_ENV"`
- THEN the output is `"test"`

### REQ-STEP-SHELL-003: Retry with Backoff

Steps with `retry: N` MUST retry up to N times on failure with incremental backoff (1s, 2s, 4s...). If all retries exhaust, the workflow MUST stop.

#### Scenario: Retry succeeds on second attempt

- GIVEN a shell step with `retry: 2` that fails the first time but succeeds the second
- WHEN the step executes
- THEN it retries once and succeeds
- AND the workflow continues

#### Scenario: All retries exhausted

- GIVEN a shell step with `retry: 2` that fails 3 times
- WHEN the step executes
- THEN the workflow stops with error reporting the step, attempt count, stdout, and stderr

### REQ-STEP-APPROVAL-001: User Confirmation

An `approval` step MUST display the interpolated message and pause execution. If the user confirms, the workflow continues. If the user cancels, the workflow stops with status `"cancelled"`.

#### Scenario: User approves

- GIVEN an approval step with message `"Continue? Found: ${{ steps.X.output }}"`
- WHEN the user confirms
- THEN the workflow continues to the next step

#### Scenario: User cancels

- GIVEN an approval step
- WHEN the user cancels
- THEN the workflow stops with status `"cancelled by user at step: <id>"`

---

## Module 4: Execution Engine

### REQ-ENGINE-001: Sequential Execution

The system MUST execute steps in declaration order (top-to-bottom) as a sequential state machine. Each step completes before the next begins.

#### Scenario: Steps execute in order

- GIVEN steps `[A, B, C]` defined in order
- WHEN the workflow runs
- THEN A completes, then B, then C

### REQ-ENGINE-002: When Condition Evaluation

Steps with a `when` expression MUST be skipped (not executed) when the expression evaluates to falsy. Skipped steps MUST NOT produce output.

#### Scenario: Step skipped by when:false

- GIVEN step B has `when: ${{ steps.A.output.flag == true }}` and flag is `false`
- WHEN the engine reaches step B
- THEN step B is skipped
- AND `steps.B.output` is undefined

### REQ-ENGINE-003: Step Output Storage

When a step defines an `output` field, the system MUST store the result in the execution context under `steps.<id>.output`, accessible to subsequent steps.

#### Scenario: Output passed between steps

- GIVEN step A outputs `"data"` with `output: result_a`
- WHEN step B references `${{ steps.A.output }}`
- THEN `"data"` is interpolated

### REQ-ENGINE-004: Error Propagation (Fail-Stop)

When a step fails (after exhausting retries), the engine MUST stop execution immediately. Subsequent steps MUST NOT execute. Completed steps MUST NOT be reverted.

#### Scenario: Fail-stop on error

- GIVEN steps `[A, B, C]` where B fails
- WHEN B fails after exhausting retries
- THEN C does not execute
- AND A's results are preserved
- AND the workflow reports status `"failed"` with B's error details

---

## Module 5: Management Commands

### REQ-CMD-VALIDATE-001: Workflow Validation

`/w7s validate [workflow]` MUST check: YAML syntax, required fields, valid `${{ }}` references (step exists and precedes), agent existence, no duplicate triggers between workflows, and inputs referenced in prompts are defined.

#### Scenario: Valid workflow

- GIVEN a correctly-defined workflow
- WHEN `/w7s validate sdd` runs
- THEN it reports all checks passed

#### Scenario: Broken reference detected

- GIVEN a prompt referencing `${{ steps.nonexistent.output }}`
- WHEN `/w7s validate` runs
- THEN it reports the broken reference with the step id and field

#### Scenario: Agent does not exist

- GIVEN a step with `agent: "no-such-agent"` that is not in OpenCode config
- WHEN `/w7s validate` runs
- THEN it reports the missing agent

### REQ-CMD-DRYRUN-001: Dry Run Simulation

`/w7s dry-run <workflow> [inputs]` MUST show the step sequence with interpolated prompts for known values, `<pending>` for runtime-dependent values, and resolved `when` conditions where possible.

#### Scenario: Dry run with inputs

- GIVEN a workflow with `inputs.feature` referenced in step prompts
- WHEN `/w7s dry-run sdd feature=auth` runs
- THEN inputs are interpolated in prompts
- AND step outputs show `<pending>`
- AND `when` conditions depending on runtime values show `<pending>`

### REQ-CMD-LIST-001: List Workflows

`/w7s list` MUST display all registered workflows with their trigger commands, input definitions (required/default), and descriptions.

#### Scenario: Multiple workflows listed

- GIVEN 3 registered workflows
- WHEN `/w7s list` runs
- THEN all 3 are listed with triggers, inputs, and descriptions

---

## Module 6: Logging

### REQ-LOG-001: Execution History

The system MUST store a log for each workflow execution at `{repo}/.opencode/workflows/.runs/<workflow>-<timestamp>.log` containing: start/end timestamps, inputs received, each step's output/result, and final status.

#### Scenario: Successful run logged

- GIVEN a workflow completes successfully
- WHEN the execution finishes
- THEN a log file is written with timestamps, inputs, per-step outputs, and status `"completed"`

#### Scenario: Failed run logged

- GIVEN a workflow fails at step B
- WHEN the execution stops
- THEN a log file is written with status `"failed"`, the failed step, and error details

### REQ-LOG-002: Log Rotation

The system MUST keep at most N logs per workflow (default: 5, configurable). When the limit is exceeded, the oldest log MUST be deleted.

#### Scenario: Rotation deletes oldest

- GIVEN 5 existing logs for workflow `sdd` and N=5
- WHEN a new execution completes
- THEN a new log is written and the oldest is deleted
- AND exactly 5 logs remain

---

## Module 7: Input Parsing

### REQ-INPUT-001: Command Argument Formats

The system MUST parse workflow inputs from command arguments supporting both `key=value` and `--key value` formats.

#### Scenario: key=value format

- GIVEN command `/sdd feature=auth scope=backend`
- WHEN inputs are parsed
- THEN `inputs.feature = "auth"` and `inputs.scope = "backend"`

#### Scenario: --key value format

- GIVEN command `/sdd --feature auth --scope backend`
- WHEN inputs are parsed
- THEN `inputs.feature = "auth"` and `inputs.scope = "backend"`

#### Scenario: Mixed formats

- GIVEN command `/sdd feature=auth --scope backend`
- WHEN inputs are parsed
- THEN both inputs are correctly parsed

### REQ-INPUT-002: Required Input Prompting

When a required input is not provided in the command, the system MUST prompt the user for the value before starting the workflow. Inputs with `default` values MUST use the default when not provided.

#### Scenario: Missing required input prompts user

- GIVEN workflow has `feature` (required) and `scope` (default: "full")
- WHEN command `/sdd` is issued with no arguments
- THEN the user is prompted for `feature`
- AND `scope` defaults to `"full"`

---

## PRD Success Criteria Coverage

| PRD Criterion | Requirement(s) |
|---|---|
| 1. YAML workflow runs E2E | REQ-ENGINE-001, REQ-LOAD-001 |
| 2. Step output accessible as input | REQ-ENGINE-003, REQ-EXPR-001, REQ-EXPR-002 |
| 3. Shell failure stops workflow | REQ-STEP-SHELL-001, REQ-ENGINE-004 |
| 4. Retry works correctly | REQ-STEP-SHELL-003 |
| 5. Local overrides global | REQ-LOAD-003 |
| 6. Inputs interpolated in prompts | REQ-INPUT-001, REQ-EXPR-001 |
| 7. when:false skips step | REQ-ENGINE-002, REQ-EXPR-005 |
| 8. Approval pauses and respects decision | REQ-STEP-APPROVAL-001 |
| 9. Execution history saved and rotated | REQ-LOG-001, REQ-LOG-002 |
| 10. ai_prompt with agent uses that agent | REQ-STEP-AI-001 |
| 11. ai_prompt without agent uses default | REQ-STEP-AI-001 |
| 12. output_format:json produces accessible object | REQ-STEP-AI-002, REQ-EXPR-003 |
| 13. Isolated sessions, context via memory | REQ-STEP-AI-003 |
| 14. /w7s validate detects errors | REQ-CMD-VALIDATE-001 |
| 15. /w7s dry-run shows sequence | REQ-CMD-DRYRUN-001 |
| 16. /w7s list shows workflows | REQ-CMD-LIST-001 |
| 17. Duplicate triggers produce error | REQ-LOAD-004 |
| 18. Invalid JSON treated as failure | REQ-STEP-AI-002 |
| 19. Setup time < 10 minutes | Implicit (system-level, validated by UX) |
