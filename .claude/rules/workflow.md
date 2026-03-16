---
paths:
  - src/workflow/**
  - tests/workflow/**
---

# Workflow Engine (CNCF Serverless Workflow DSL)

`src/workflow/` implements a CNCF Serverless Workflow DSL 1.0 execution engine.
Workflows are defined in YAML, parsed into typed `WorkflowDefinition` objects,
stored via `StorageProvider`, and executed by a task-dispatching engine with
classification-gated persistence.

## CNCF Serverless Workflow DSL Conventions

- All workflow types model the CNCF Serverless Workflow DSL 1.0 specification.
  The top-level document uses `dsl`, `namespace`, `name`, `version`, and a `do:`
  task list.
- Supported task types: `call`, `run`, `set`, `switch`, `for`, `raise`, `emit`,
  `wait`. The `WorkflowTask` union covers all eight. Never add ad-hoc task types
  outside this union.
- Every task shares `TaskBase` fields: `if`, `input`, `output`, `timeout`,
  `then`, `metadata`. Extend `TaskBase`, do not duplicate these fields.
- Flow control uses `TaskFlowDirective`: `"continue"` (next task), `"end"`
  (terminate), or a named task string (jump). The engine resolves jumps via
  `findTaskIndex`.
- Durations use ISO 8601 format (`PT5S`, `PT1M`, `PT2H`). Parsing is in
  `parseDuration`. Never invent custom duration formats.
- The `WorkflowDocument` metadata (`dsl`, `namespace`, `name`) is required.
  `version` and `description` are optional.

## Task Runner Pattern

Each task type has its own executor function in `task_runners.ts`, named with a
domain-specific verb instead of the generic `execute` prefix (e.g.,
`applySetTask`, `evaluateSwitchTask`, `raiseWorkflowError`, `emitWorkflowEvent`,
`invokeRunTask`). The engine loop's `dispatchTask` function (in `engine_loop.ts`) routes by `task.type` to
the correct executor.

- Task executors return `EngineResult<TaskResult>` — a `Result`-style
  discriminated union (`{ ok: true, value }` or `{ ok: false, error }`). Never
  throw from a task executor; always return a structured error.
- `run` task subtypes (`shell`, `script`, `workflow`) are further dispatched in
  `task_runners.ts` via `invokeRunTask`, which delegates to subtype handlers.
- Sub-workflow execution uses an injected `SubWorkflowExecutor` callback to avoid
  circular imports between `task_runners.ts` and `engine.ts`. The engine passes
  itself (`executeWorkflow`) as the callback.
- Shell and script execution require `allowShellExecution !== false` in options.
  Default-deny: if the flag is explicitly `false`, the task fails with a typed
  error.
- Sub-workflow recursion is capped at `MAX_RECURSION_DEPTH` (5). The `depth`
  field in `ExecuteWorkflowOptions` is internal — callers must not set it.

## Expression Safety

Expressions use `${ .path.to.value }` interpolation syntax, evaluated by a
restricted resolver in `expressions.ts`. This is NOT JavaScript `eval`.

- **No arbitrary code execution.** The expression engine supports only: dot-path
  resolution, string/number/boolean/null literals, comparison operators
  (`==`, `!=`, `>`, `<`, `>=`, `<=`), and arithmetic operators
  (`+`, `-`, `*`, `/`, `%`).
- `evaluateExpression` handles string interpolation (mixed text + expressions).
  Single-expression strings return the raw typed value; multi-expression strings
  interpolate as a string.
- `evaluateConditionExpression` wraps `evaluateExpression` with truthiness
  coercion for `if:` and `switch.when` conditions.
- `resolveDotPath` traverses nested objects and array indices
  (`.items[0].name`). Returns `undefined` for missing paths — never throws.
- `deepResolveExpressions` recursively resolves all `${ }` expressions in an
  object tree. Used for input/output transforms.
- Never add `eval`, `Function()`, `import()`, or any dynamic code execution
  to the expression engine. If a new operator is needed, add it as a named
  case in `evaluateSingleExpression`.

## Registry Lifecycle

Workflows follow a register-validate-store-execute lifecycle.

- **Store** (`store.ts`): Persists workflow definitions (YAML + classification)
  and run history via `StorageProvider`. Keys use `workflows:{name}` and
  `workflow-runs:{runId}` prefixes. All reads are classification-gated —
  `canFlowTo(stored.classification, sessionTaint)` must pass.
- **Parser** (`parser.ts`): Validates raw YAML into typed `WorkflowDefinition`.
  Returns `ParseResult<T>` (Result pattern), never throws.
- **Validators** (`validators.ts`): Per-task-type validation functions
  (`validateSetTask`, `validateSwitchTask`, etc.) called by the parser. Each
  returns `ParseResult<T>` with a descriptive error context string.
- **Registry** (`registry.ts`): Tracks active workflow runs in memory. Provides
  pause/unpause/stop signals checked at task boundaries. The registry emits
  events (`run_started`, `run_paused`, `run_stopped`, `run_completed`,
  `task_progress`) to subscribed listeners.
- **Engine** (`engine.ts`): Orchestrates execution — walks the task list, checks
  abort signals and pause checkpoints between tasks, enforces classification
  ceilings via `canFlowTo`, and dispatches to task runners.
- Never bypass the parser for raw YAML — always validate before storing or
  executing.
- Never store workflows without a classification level. Default-deny applies:
  unclassified workflows are rejected.

## Healing Module Guidelines

The `healing/` subdirectory implements self-healing retries, versioning, and
error recovery for long-running workflows.

- **Types** (`healing/types.ts`): Rich event types (`StepStartedEvent`,
  `StepFailedEvent`, `WorkflowFaultedEvent`, etc.), workflow versioning
  (`WorkflowVersion`, `VersionStatus`), runtime deviations
  (`RuntimeDeviation`), step metadata (`StepMetadata`), and extended workflow
  state (`WorkflowState` with healing-specific pause states like
  `PAUSED_HEALING`, `PAUSED_AWAITING_APPROVAL`).
- **Scoped pause** (`healing/scoped_pause.ts`): `ScopedPauseController` blocks
  only downstream tasks after a failure, not independent branches. The engine
  checks `isTaskBlocked` at each task boundary.
- **Version store** (`healing/version_store.ts`): Persists workflow version
  snapshots. Versions have a lifecycle: `PROPOSED` -> `APPROVED` | `REJECTED` |
  `SUPERSEDED`. Self-healing proposals require explicit approval before
  replacing the active definition.
- **Metadata validation** (`healing/metadata_validator.ts`): When self-healing
  is enabled, every task must include `StepMetadata` (`description`, `expects`,
  `produces`). `enforceStepMetadataRequirements` rejects workflows missing
  these fields.
- **Version validation** (`healing/version_validation.ts`):
  `validateConfigImmutability` ensures self-healing config cannot be changed
  by the healing process itself — only humans can modify healing parameters.
- Shared healing types (config shape, categories, phases) live in
  `core/types/healing.ts`. Workflow-specific healing types live in
  `healing/types.ts`. Never move workflow-domain types into core.
- Runtime deviations are workarounds applied without changing the definition.
  They are recorded per-run and surfaced in `WorkflowRunResult`. Never silently
  apply a deviation — always record it with `leadReasoning`.
- Self-healing changes produce a `WorkflowVersion` with `source: "self_healing"`
  and `status: "PROPOSED"`. The version must be approved before it takes effect.
  Never auto-approve self-healing proposals.
