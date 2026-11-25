/** Operator-admitted deterministic plans using the ordinary workflow runtime. */

import { createHash } from "node:crypto";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../core/types/classification.ts";
import { executeWorkflow } from "../workflow/engine.ts";
import type { WorkflowRunRegistry } from "../workflow/registry_types.ts";
import type { WorkflowStatus, WorkflowTaskEntry } from "../workflow/types.ts";
import {
  createOperatorWorkflowJournal,
  type OperatorWorkflowJournalRow,
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
  status: WorkflowStatus;
  completedAt?: string;
};

const MAX_ACTIVE = 8;
const MAX_HISTORY = 64;
const MAX_PLANS = 32;
const MAX_STEPS = 20;
const MAX_DELAY_SECONDS = 30;
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

  function save(run: AdmittedRun) {
    journal?.update(
      run.id,
      run.status,
      run.completedAt ?? null,
      JSON.stringify(run.stepStatuses),
    );
  }

  async function execute(
    run: AdmittedRun,
    registration: ReturnType<WorkflowRunRegistry["registerRun"]>,
  ) {
    let terminal: WorkflowStatus = "failed";
    try {
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
          switch (event.type) {
            case "STEP_STARTED":
              run.stepStatuses[event.taskIndex] = "running";
              break;
            case "STEP_COMPLETED":
              run.stepStatuses[event.taskIndex] = "completed";
              break;
            case "STEP_FAILED":
              run.stepStatuses[event.taskIndex] = "failed";
              break;
            default:
              return;
          }
          save(run);
        },
      });
      if (result.ok) terminal = result.value.status;
    } catch {
      // Return status only. Workflow outputs and errors do not leave the engine.
    } finally {
      run.status = registration.signal.aborted ? "cancelled" : terminal;
      run.completedAt = new Date().toISOString();
      try {
        save(run);
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
      void execute(run, registration);
      return project(run);
    },
    pause(runId: string, ceiling: ClassificationLevel = "INTERNAL") {
      const run = find(runId, ceiling);
      return run && registry.pauseRun(runId) ? project(run) : undefined;
    },
    resume(runId: string, ceiling: ClassificationLevel = "INTERNAL") {
      const run = find(runId, ceiling);
      return run && registry.unpauseRun(runId) ? project(run) : undefined;
    },
  };
}

export type OperatorWorkflowRuns = ReturnType<
  typeof createOperatorWorkflowRuns
>;
