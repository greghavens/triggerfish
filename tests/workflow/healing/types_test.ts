import { assertEquals } from "@std/assert";
import type {
  HealingEventType,
  HealingPhase,
  InterventionCategory,
  PauseOnIntervention,
  PauseTimeoutPolicy,
  SelfHealingConfig,
  WorkflowHealth,
} from "../../../src/core/types/healing.ts";
import type {
  RichWorkflowEvent,
  RuntimeDeviation,
  StepMetadata,
  VersionStatus,
  WorkflowState,
  WorkflowStatusDetail,
  WorkflowStatusEvent,
  WorkflowVersion,
} from "../../../src/workflow/healing/types.ts";

Deno.test("HealingEventType: all 9 variants are distinct", () => {
  const variants: HealingEventType[] = [
    "STEP_STARTED",
    "STEP_COMPLETED",
    "STEP_FAILED",
    "STEP_SKIPPED",
    "BRANCH_TAKEN",
    "WORKFLOW_PAUSED",
    "WORKFLOW_RESUMED",
    "WORKFLOW_COMPLETED",
    "WORKFLOW_FAULTED",
  ];
  assertEquals(new Set(variants).size, 9);
});

Deno.test("InterventionCategory: all 5 categories distinct", () => {
  const categories: InterventionCategory[] = [
    "transient_retry",
    "runtime_workaround",
    "structural_fix",
    "plugin_gap",
    "unresolvable",
  ];
  assertEquals(new Set(categories).size, 5);
});

Deno.test("SelfHealingConfig: constructs with all fields", () => {
  const config: SelfHealingConfig = {
    enabled: true,
    pause_on_intervention: "blocking_only",
    pause_timeout_seconds: 300,
    pause_timeout_policy: "escalate_and_halt",
    retry_budget: 3,
    approval_required: true,
    notify_on: ["intervention", "escalation", "approval_required"],
    run_history_window: 10,
    soft_signals: {
      empty_output_from_prior_success: true,
      duration_multiplier_threshold: 10,
      schema_drift: true,
    },
  };
  assertEquals(config.enabled, true);
  assertEquals(config.retry_budget, 3);
});

Deno.test("PauseOnIntervention: all variants distinct", () => {
  const variants: PauseOnIntervention[] = ["always", "never", "blocking_only"];
  assertEquals(new Set(variants).size, 3);
});

Deno.test("PauseTimeoutPolicy: all variants distinct", () => {
  const variants: PauseTimeoutPolicy[] = [
    "escalate_and_halt",
    "escalate_and_skip",
    "escalate_and_fail",
  ];
  assertEquals(new Set(variants).size, 3);
});

Deno.test("WorkflowHealth: all variants distinct", () => {
  const variants: WorkflowHealth[] = [
    "healthy",
    "degraded",
    "failing",
    "unknown",
  ];
  assertEquals(new Set(variants).size, 4);
});

Deno.test("HealingPhase: all 7 variants distinct", () => {
  const variants: HealingPhase[] = [
    "WATCHING",
    "TRIAGING",
    "RETRYING",
    "APPLYING_WORKAROUND",
    "PROPOSING_FIX",
    "AUTHORING_PLUGIN",
    "ESCALATING",
  ];
  assertEquals(new Set(variants).size, 7);
});

Deno.test("RichWorkflowEvent: all 9 event types constructible", () => {
  const base = {
    runId: "r1",
    workflowName: "wf",
    timestamp: "2026-01-01T00:00:00Z",
  };
  const events: RichWorkflowEvent[] = [
    {
      ...base,
      type: "STEP_STARTED",
      taskName: "a",
      taskIndex: 0,
      taskDef: { name: "a", task: { type: "set", set: {} } },
      input: null,
      runningTaint: "PUBLIC" as const,
    },
    {
      ...base,
      type: "STEP_COMPLETED",
      taskName: "a",
      taskIndex: 0,
      output: {},
      duration: 100,
      taintAfter: "PUBLIC" as const,
    },
    {
      ...base,
      type: "STEP_FAILED",
      taskName: "a",
      taskIndex: 0,
      error: "boom",
      input: null,
      attemptNumber: 1,
    },
    {
      ...base,
      type: "STEP_SKIPPED",
      taskName: "a",
      taskIndex: 0,
      reason: "condition false",
    },
    {
      ...base,
      type: "BRANCH_TAKEN",
      switchName: "sw",
      branch: "b1",
      condition: ".x == 1",
    },
    {
      ...base,
      type: "WORKFLOW_PAUSED",
      reason: "intervention",
      pausedAt: base.timestamp,
    },
    { ...base, type: "WORKFLOW_RESUMED", resumedAt: base.timestamp },
    { ...base, type: "WORKFLOW_COMPLETED", output: {}, taskCount: 3 },
    {
      ...base,
      type: "WORKFLOW_FAULTED",
      error: "fatal",
      failedTaskName: "a",
      failedTaskIndex: 0,
    },
  ];
  assertEquals(new Set(events.map((e) => e.type)).size, 9);
});

Deno.test("WorkflowVersion: constructs with all fields", () => {
  const v: WorkflowVersion = {
    versionId: "v1",
    workflowName: "wf",
    agentId: "a1",
    versionNumber: 1,
    definition: "yaml",
    diff: "diff",
    status: "PROPOSED",
    source: "self_healing",
    authorReasoning: "API changed",
    runId: "r1",
    proposedAt: "2026-01-01T00:00:00Z",
  };
  assertEquals(v.status, "PROPOSED");
});

Deno.test("VersionStatus: all 4 statuses distinct", () => {
  const s: VersionStatus[] = ["PROPOSED", "APPROVED", "REJECTED", "SUPERSEDED"];
  assertEquals(new Set(s).size, 4);
});

Deno.test("RuntimeDeviation: constructs correctly", () => {
  const d: RuntimeDeviation = {
    taskName: "fetch",
    deviationDescription: "Used fallback",
    leadReasoning: "Primary down",
    runId: "r1",
    appliedAt: "2026-01-01T00:00:00Z",
  };
  assertEquals(d.taskName, "fetch");
});

Deno.test("StepMetadata: constructs with required fields", () => {
  const m: StepMetadata = {
    description: "d",
    intent: "i",
    expects: "e",
    produces: "p",
  };
  assertEquals(m.description.length > 0, true);
});

Deno.test("WorkflowState: all 9 states distinct", () => {
  const states: WorkflowState[] = [
    "IDLE",
    "RUNNING",
    "PAUSED_HEALING",
    "PAUSED_AWAITING_APPROVAL",
    "PAUSED_TIMEOUT",
    "COMPLETED",
    "FAULTED",
    "ESCALATED",
    "CANCELLED",
  ];
  assertEquals(new Set(states).size, 9);
});

Deno.test("WorkflowStatusDetail: constructs with healing phase", () => {
  const s: WorkflowStatusDetail = {
    state: "PAUSED_HEALING",
    health: "degraded",
    source: "self_healing",
    healingPhase: "TRIAGING",
    versionStatus: "PROPOSED",
    activeDeviations: 1,
  };
  assertEquals(s.healingPhase, "TRIAGING");
});

Deno.test("WorkflowStatusEvent: constructs with state transition", () => {
  const e: WorkflowStatusEvent = {
    workflowName: "wf",
    runId: "r1",
    previousState: "RUNNING",
    currentState: "PAUSED_HEALING",
    status: {
      state: "PAUSED_HEALING",
      health: "degraded",
      source: "self_healing",
      healingPhase: "TRIAGING",
      versionStatus: "APPROVED",
      activeDeviations: 0,
    },
    timestamp: "2026-01-01T00:00:00Z",
    message: "Lead detected step failure",
  };
  assertEquals(e.previousState, "RUNNING");
});
