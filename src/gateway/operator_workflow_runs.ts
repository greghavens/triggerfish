/** Operator-admitted deterministic plans using the ordinary workflow runtime. */

import { createHash } from "node:crypto";
import { resolve } from "@std/path";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../core/types/classification.ts";
import { executeWorkflow } from "../workflow/engine.ts";
import type { WorkflowRunRegistry } from "../workflow/registry_types.ts";
import type { WorkflowStatus, WorkflowTaskEntry } from "../workflow/types.ts";
import {
  createOperatorWorkflowJournal,
  MAX_OPERATOR_WORKFLOW_CONTROL_EVENTS,
  type OperatorWorkflowJournalRow,
  type OperatorWorkflowTraceEvent,
  type OperatorWorkflowTraceInput,
} from "./operator_workflow_journal.ts";

export interface OperatorWorkflowPlan {
  readonly id: string;
  readonly classification: "PUBLIC" | "INTERNAL";
  readonly steps: readonly {
    readonly id: string;
    readonly waitSeconds?: number;
  }[];
}

type StepStatus = "pending" | "running" | "completed" | "failed";
export interface OperatorWorkflowRun {
  readonly runId: string;
  readonly planId: string;
  readonly classification: OperatorWorkflowPlan["classification"];
  readonly status: WorkflowStatus | "interrupted";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly currentStep?: string;
  readonly steps: readonly {
    readonly id: string;
    readonly status: StepStatus;
  }[];
}

type AdmittedPlan = {
  readonly id: string;
  readonly classification: OperatorWorkflowPlan["classification"];
  readonly fingerprint: string;
  readonly steps: readonly WorkflowTaskEntry[];
};

type AdmittedRun = {
  readonly id: string;
  readonly requestId: string;
  readonly plan: AdmittedPlan;
  readonly startedAt: string;
  readonly stepStatuses: StepStatus[];
  readonly transientTrace: OperatorWorkflowTraceEvent[];
  status: WorkflowStatus;
  completedAt?: string;
};

const MAX_ACTIVE = 8;
const MAX_HISTORY = 64;
const MAX_PLANS = 32;
const MAX_STEPS = 20;
const MAX_DELAY_SECONDS = 30;
const MAX_TRACE_PAGE = 30;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RUN_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const REQUEST_ID = /^[a-f0-9]{64}$/i;

function validConfigurationKeys(value: object, permitted: readonly string[]) {
  return Object.keys(value).every((key) => permitted.includes(key));
}

function admitPlans(configuration: readonly OperatorWorkflowPlan[]) {
  if (!Array.isArray(configuration) || configuration.length > MAX_PLANS) {
    throw new Error("Invalid operator workflow plan list.");
  }
  const plans = new Map<string, AdmittedPlan>();
  for (const plan of configuration) {
    if (
      !plan || typeof plan !== "object" || typeof plan.id !== "string" ||
      !ID.test(plan.id) || plans.has(plan.id) ||
      (plan.classification !== "PUBLIC" &&
        plan.classification !== "INTERNAL") ||
      !validConfigurationKeys(plan, ["id", "classification", "steps"]) ||
      !Array.isArray(plan.steps) || plan.steps.length === 0 ||
      plan.steps.length > MAX_STEPS
    ) throw new Error("Invalid operator workflow plan.");
    let delay = 0;
    const names = new Set<string>();
    const steps: WorkflowTaskEntry[] = [];
    for (const step of plan.steps) {
      if (
        !step || typeof step !== "object" || typeof step.id !== "string" ||
        !ID.test(step.id) || names.has(step.id) ||
        !validConfigurationKeys(step, ["id", "waitSeconds"])
      ) throw new Error("Invalid operator workflow step.");
      const wait = step.waitSeconds ?? 0;
      if (
        typeof wait !== "number" || !Number.isFinite(wait) || wait < 0 ||
        !Number.isSafeInteger(wait * 1000) ||
        (delay += wait) > MAX_DELAY_SECONDS
      ) throw new Error("Invalid operator workflow delay.");
      names.add(step.id);
      steps.push({
        name: step.id,
        task: wait > 0
          ? { type: "wait", wait: `PT${wait}S` }
          : { type: "set", set: { step: step.id } },
      });
    }
    plans.set(plan.id, {
      id: plan.id,
      classification: plan.classification,
      fingerprint: createHash("sha256").update(JSON.stringify([
        1,
        plan.id,
        plan.classification,
        steps,
      ])).digest("hex"),
      steps,
    });
  }
  return plans;
}

/** Create a local registry view containing only runs started through this adapter. */
export function createOperatorWorkflowRuns(
  registry: WorkflowRunRegistry,
  configuration: readonly OperatorWorkflowPlan[],
  journalPath?: string,
) {
  const plans = admitPlans(configuration);
  const journal = journalPath
    ? createOperatorWorkflowJournal(journalPath)
    : undefined;
  const runs = new Map<string, AdmittedRun>();
  let active = 0;

  function project(run: AdmittedRun): OperatorWorkflowRun {
    const current = registry.getActiveRun(run.id);
    return {
      runId: run.id,
      planId: run.plan.id,
      classification: run.plan.classification,
      status: current?.paused && current.status === "running"
        ? "paused"
        : current?.status ?? run.status,
      startedAt: run.startedAt,
      ...(run.completedAt && { completedAt: run.completedAt }),
      ...(current?.currentTaskName && { currentStep: current.currentTaskName }),
      steps: run.plan.steps.map(({ name }, index) => ({
        id: name,
        status: run.stepStatuses[index],
      })),
    };
  }

  function find(runId: string, ceiling: ClassificationLevel) {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) return undefined;
    const run = runs.get(runId);
    return run && canFlowTo(run.plan.classification, ceiling) ? run : undefined;
  }

  function reopen(
    row: OperatorWorkflowJournalRow,
    ceiling: ClassificationLevel,
  ): OperatorWorkflowRun | undefined {
    const plan = plans.get(row.planId);
    if (
      !plan || row.fingerprint !== plan.fingerprint ||
      row.classification !== plan.classification ||
      !canFlowTo(plan.classification, ceiling)
    ) return undefined;
    const live = runs.get(row.runId);
    if (live) return project(live);
    const statuses: unknown = JSON.parse(row.stepStatuses);
    if (
      !Array.isArray(statuses) || statuses.length !== plan.steps.length ||
      statuses.some((status) =>
        !["pending", "running", "completed", "failed"].includes(status)
      )
    ) return undefined;
    const terminal = row.status === "completed" || row.status === "failed" ||
        row.status === "cancelled"
      ? row.status
      : undefined;
    return {
      runId: row.runId,
      planId: plan.id,
      classification: plan.classification,
      status: terminal ?? "interrupted",
      startedAt: row.startedAt,
      ...(terminal && row.completedAt && { completedAt: row.completedAt }),
      steps: plan.steps.map(({ name }, index) => ({
        id: name,
        status: statuses[index] as StepStatus,
      })),
    };
  }

  function save(run: AdmittedRun, event: OperatorWorkflowTraceInput) {
    if (!journal) {
      if (
        (event.event === "paused" || event.event === "resumed") &&
        run.transientTrace.filter((item) =>
            item.event === "paused" || item.event === "resumed"
          ).length >=
          MAX_OPERATOR_WORKFLOW_CONTROL_EVENTS
      ) return;
      run.transientTrace.push({
        ...event,
        sequence: run.transientTrace.length + 1,
      });
      return;
    }
    journal.update(
      run.id,
      run.status,
      run.completedAt ?? null,
      JSON.stringify(run.stepStatuses),
      event,
    );
  }

  async function execute(
    run: AdmittedRun,
    registration: ReturnType<WorkflowRunRegistry["registerRun"]>,
  ) {
    let terminal: "completed" | "failed" | "cancelled" = "failed";
    try {
      save(run, { event: "started", at: new Date().toISOString() });
      const result = await executeWorkflow({
        definition: {
          document: { dsl: "1.0.0", namespace: "operator", name: run.plan.id },
          do: run.plan.steps,
          classificationCeiling: run.plan.classification,
        },
        toolExecutor: () =>
          Promise.reject(
            new Error("This operator workflow has no dispatched tools."),
          ),
        getSessionTaint: () => run.plan.classification,
        allowShellExecution: false,
        signal: registration.signal,
        checkPause: registration.checkPause,
        onTaskProgress: (taskIndex, taskName) =>
          registry.reportTaskProgress(run.id, {
            taskIndex,
            taskName,
            taint: run.plan.classification,
          }),
        onStepEvent: (event) => {
          if (
            event.type !== "STEP_STARTED" && event.type !== "STEP_COMPLETED" &&
            event.type !== "STEP_FAILED"
          ) return;
          const step = run.plan.steps[event.taskIndex];
          if (!step || step.name !== event.taskName) return;
          const before = run.stepStatuses[event.taskIndex];
          let typedEvent: OperatorWorkflowTraceInput["event"];
          switch (event.type) {
            case "STEP_STARTED":
              if (before !== "pending") return;
              run.stepStatuses[event.taskIndex] = "running";
              typedEvent = "step_started";
              break;
            case "STEP_COMPLETED":
              if (before !== "running") return;
              run.stepStatuses[event.taskIndex] = "completed";
              typedEvent = "step_completed";
              break;
            case "STEP_FAILED":
              if (before !== "running") return;
              run.stepStatuses[event.taskIndex] = "failed";
              typedEvent = "step_failed";
              break;
          }
          save(run, {
            event: typedEvent,
            stepId: step.name,
            at: event.timestamp,
          });
        },
      });
      if (
        result.ok && (result.value.status === "completed" ||
          result.value.status === "failed" ||
          result.value.status === "cancelled")
      ) {
        terminal = result.value.status;
      }
    } catch {
      // Return status only. Workflow outputs and errors do not leave the engine.
    } finally {
      run.status = registration.signal.aborted ? "cancelled" : terminal;
      run.completedAt = new Date().toISOString();
      try {
        save(run, {
          event: run.status,
          at: run.completedAt,
        });
      } catch {
        // An unavailable journal leaves the durable admission interrupted.
      }
      registry.completeRun(run.id, { status: run.status });
      active--;
      for (const [id, entry] of runs) {
        if (runs.size <= MAX_HISTORY) break;
        if (entry.completedAt) runs.delete(id);
      }
    }
  }

  return {
    listPlans(ceiling: ClassificationLevel = "INTERNAL") {
      return [...plans.values()]
        .filter(({ classification }) => canFlowTo(classification, ceiling))
        .map(({ id, classification, steps }) => ({
          id,
          classification,
          stepCount: steps.length,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    list(
      ceiling: ClassificationLevel = "INTERNAL",
    ): readonly OperatorWorkflowRun[] {
      if (journal) {
        return journal.list(MAX_HISTORY).flatMap((row) => {
          const run = reopen(row, ceiling);
          return run ? [run] : [];
        });
      }
      return [...runs.values()].reverse().filter(({ plan }) =>
        canFlowTo(plan.classification, ceiling)
      ).map(project);
    },
    inspect(runId: string, ceiling: ClassificationLevel = "INTERNAL") {
      const run = find(runId, ceiling);
      if (run) return project(run);
      if (typeof runId !== "string" || !RUN_ID.test(runId)) return undefined;
      const saved = journal?.inspect(runId);
      return saved && reopen(saved, ceiling);
    },
    traces(
      runId: string,
      ceiling: ClassificationLevel = "INTERNAL",
      options: {
        readonly cursor?: string;
        readonly limit?: number;
        readonly sequence?: number;
      } = {},
    ) {
      const { cursor, limit = 10, sequence } = options;
      if (
        typeof runId !== "string" || !RUN_ID.test(runId) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRACE_PAGE ||
        (sequence !== undefined && (cursor !== undefined ||
          !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999))
      ) return undefined;
      const live = find(runId, ceiling);
      const saved = journal?.inspect(runId);
      const run = saved
        ? reopen(saved, ceiling)
        : live
        ? project(live)
        : undefined;
      const plan = run && plans.get(run.planId);
      if (!run || !plan) return undefined;
      const binding = createHash("sha256").update(JSON.stringify([
        journalPath === undefined ? null : resolve(journalPath),
        runId,
        plan.fingerprint,
      ])).digest("hex");
      const parsed = typeof cursor === "string" &&
        /^([a-f0-9]{64})\.([1-9][0-9]{0,2})$/.exec(cursor);
      if (cursor !== undefined && (!parsed || parsed[1] !== binding)) {
        return undefined;
      }
      const after = sequence !== undefined
        ? sequence - 1
        : parsed
        ? Number(parsed[2])
        : 0;
      const pageSize = sequence === undefined ? limit + 1 : 1;
      if (!journal && after > (live?.transientTrace.length ?? 0)) {
        return undefined;
      }
      const page = journal
        ? journal.traces(runId, plan.fingerprint, after, pageSize)
        : live && {
          events: live.transientTrace.slice(after, after + pageSize),
          controlLimitReached: live.transientTrace.filter((item) =>
            item.event === "paused" ||
            item.event === "resumed"
          ).length >= MAX_OPERATOR_WORKFLOW_CONTROL_EVENTS,
        };
      if (!page) return undefined;
      if (sequence !== undefined && page.events[0]?.sequence !== sequence) {
        return undefined;
      }
      if (
        page.events.some((event) =>
          "stepId" in event &&
          !plan.steps.some(({ name }) => name === event.stepId)
        )
      ) return undefined;
      const events = page.events.slice(0, limit);
      return {
        runId,
        planId: plan.id,
        classification: plan.classification,
        events,
        controlLimitReached: page.controlLimitReached,
        nextCursor: page.events.length > limit
          ? `${binding}.${events.at(-1)!.sequence}`
          : null,
      };
    },
    start(
      planId: string,
      ceiling: ClassificationLevel = "INTERNAL",
      requestId: string = crypto.randomUUID(),
    ) {
      const plan = plans.get(planId);
      if (
        typeof requestId !== "string" ||
        !RUN_ID.test(requestId.toLowerCase()) && !REQUEST_ID.test(requestId)
      ) return undefined;
      requestId = requestId.toLowerCase();
      if (!plan || !canFlowTo(plan.classification, ceiling)) return undefined;
      const prior = journal?.readRequest(requestId);
      if (prior) {
        return prior.planId === planId ? reopen(prior, ceiling) : undefined;
      }
      const memorized = [...runs.values()].find((entry) =>
        entry.requestId === requestId
      );
      if (memorized) {
        return memorized.plan.id === planId ? project(memorized) : undefined;
      }
      if (
        active >= MAX_ACTIVE
      ) return undefined;
      const id = crypto.randomUUID();
      const run: AdmittedRun = {
        id,
        requestId,
        plan,
        startedAt: new Date().toISOString(),
        status: "running",
        stepStatuses: plan.steps.map(() => "pending"),
        transientTrace: [],
      };
      const admission = journal?.admit({
        runId: id,
        requestId,
        planId,
        fingerprint: plan.fingerprint,
        classification: plan.classification,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: null,
        stepStatuses: JSON.stringify(run.stepStatuses),
      });
      if (admission && !admission.admitted) {
        return admission.prior?.planId === planId
          ? reopen(admission.prior, ceiling)
          : undefined;
      }
      const registration = registry.registerRun({
        runId: id,
        workflowName: plan.id,
        taint: plan.classification,
      });
      runs.set(id, run);
      active++;
      if (!journal) save(run, { event: "admitted", at: run.startedAt });
      void execute(run, registration);
      return project(run);
    },
    pause(runId: string, ceiling: ClassificationLevel = "INTERNAL") {
      const run = find(runId, ceiling);
      if (!run || !registry.pauseRun(runId)) return undefined;
      run.status = "paused";
      save(run, { event: "paused", at: new Date().toISOString() });
      return project(run);
    },
    resume(runId: string, ceiling: ClassificationLevel = "INTERNAL") {
      const run = find(runId, ceiling);
      if (!run || !registry.unpauseRun(runId)) return undefined;
      run.status = "running";
      save(run, { event: "resumed", at: new Date().toISOString() });
      return project(run);
    },
  };
}

export type OperatorWorkflowRuns = ReturnType<
  typeof createOperatorWorkflowRuns
>;
