import {
  controlEvidenceKey,
  validControlEvidenceId,
  waitForCommittedEvidence,
} from "../core/evidence_task_progression.ts";
import type { WorkflowEvidenceRequirement } from "../core/config_types.ts";
import type {
  ArchivedOperatorRunLink,
  OperatorRunLinkInput,
} from "../core/operator_runs.ts";
/** Operator-admitted deterministic plans using the ordinary workflow runtime. */

import type { RunArchiveRestoreKey } from "../core/run_archive_actions.ts";
import { createHash } from "node:crypto";
import { dirname, resolve } from "@std/path";
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
  validWorkflowStepEvidence,
  validWorkflowWaitDeadline,
  type WorkflowStepEvidence,
} from "./operator_workflow_journal.ts";

interface WorkflowArchiveSnapshot {
  readonly admission: OperatorWorkflowJournalRow;
  readonly events: readonly OperatorWorkflowTraceEvent[];
}

const terminalEvents = new Set(["completed", "failed", "cancelled"]);
const lifecycleArchiveEvents = new Set([
  "admitted",
  "started",
  "paused",
  "resumed",
]);
const stepArchiveEvents = new Set([
  "step_started",
  "step_completed",
  "step_failed",
  "step_satisfied",
  "step_proof_renewed",
  "step_waiting",
]);

function validWorkflowArchive(
  { admission, events }: WorkflowArchiveSnapshot,
  view: OperatorWorkflowRun,
): boolean {
  if (
    !Array.isArray(events) || !events.length || events.length >= 1000 ||
    events[0]?.event !== "admitted" || events[0].at !== admission.startedAt
  ) return false;
  if (
    events.some((event, index) =>
      !event || event.sequence !== index + 1 ||
      !Number.isFinite(Date.parse(event.at)) ||
      (event.event === "step_waiting" &&
        !validWorkflowWaitDeadline(event.at, event.deadlineAt)) ||
      ((event.event === "step_satisfied" ||
        event.event === "step_proof_renewed") &&
        !validWorkflowStepEvidence(event.evidence)) ||
      (stepArchiveEvents.has(event.event)
        ? !("stepId" in event) ||
          !view.steps.some(({ id }) => id === event.stepId)
        : "stepId" in event ||
          (!lifecycleArchiveEvents.has(event.event) &&
            !terminalEvents.has(event.event)))
    )
  ) return false;
  const terminal = events.filter(({ event }) => terminalEvents.has(event));
  if (admission.completedAt === null) {
    return ["running", "paused", "restored_paused"].includes(
      admission.status,
    ) &&
      terminal.length === 0;
  }
  return terminal.length === 1 && terminal[0] === events.at(-1) &&
    terminal[0].event === view.status &&
    terminal[0].at === admission.completedAt;
}

export interface OperatorWorkflowPlan {
  readonly id: string;
  readonly classification: "PUBLIC" | "INTERNAL";
  readonly steps: readonly {
    readonly id: string;
    readonly waitSeconds?: number;
    readonly satisfiedBy?: WorkflowEvidenceRequirement;
    readonly evidenceWaitSeconds?: number;
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
  readonly requirements: ReadonlyMap<string, WorkflowEvidenceRequirement>;
  readonly evidenceWaits: ReadonlyMap<string, number>;
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

function lockWorkflowRun(journalPath: string, runId: string) {
  const directory = resolve(dirname(journalPath), "operator-workflow-locks");
  Deno.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = Deno.lstatSync(directory);
  if (!dir.isDirectory || dir.isSymlink || ((dir.mode ?? 0) & 0o077) !== 0) {
    return undefined;
  }
  const path = resolve(directory, runId);
  try {
    Deno.openSync(path, { createNew: true, write: true, mode: 0o600 }).close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = Deno.lstatSync(path);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    ((info.mode ?? 0) & 0o077) !== 0
  ) return undefined;
  const file = Deno.openSync(path, { write: true });
  let locked = false;
  try {
    locked = file.tryLockSync(true);
    if (locked) return file;
  } finally {
    if (!locked) file.close();
  }
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
    const requirements = new Map<string, WorkflowEvidenceRequirement>();
    const evidenceWaits = new Map<string, number>();
    for (const step of plan.steps) {
      if (
        !step || typeof step !== "object" || typeof step.id !== "string" ||
        !ID.test(step.id) || names.has(step.id) ||
        !validConfigurationKeys(step, [
          "id",
          "waitSeconds",
          "satisfiedBy",
          "evidenceWaitSeconds",
        ])
      ) throw new Error("Invalid operator workflow step.");
      const proof = step.satisfiedBy;
      if (proof !== undefined) {
        if (
          !proof || typeof proof !== "object" ||
          plan.classification !== "INTERNAL" ||
          !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(proof.case) ||
          !RUN_ID.test(proof.run_id) || !Number.isSafeInteger(proof.revision) ||
          proof.revision < 1 ||
          ("goal_id" in proof
            ? Object.keys(proof).length !== 4 ||
              typeof proof.goal_id !== "string" ||
              !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(proof.goal_id)
            : "finding_id" in proof
            ? Object.keys(proof).length !== 4 ||
              typeof proof.finding_id !== "string" ||
              !/^worker-finding:[a-f0-9]{64}$/.test(proof.finding_id)
            : "finding_recheck_id" in proof
            ? Object.keys(proof).length !== 4 ||
              typeof proof.finding_recheck_id !== "string" ||
              !/^worker-recheck:[a-f0-9]{64}$/.test(proof.finding_recheck_id)
            : "graph_fact_id" in proof
            ? (Object.hasOwn(proof, "require_current_pass")
              ? Object.keys(proof).length !== 5 ||
                proof.require_current_pass !== true
              : Object.keys(proof).length !== 4) ||
              !/^worker-graph-fact:[a-f0-9]{64}$/.test(proof.graph_fact_id)
            : "asset_id" in proof
            ? Object.keys(proof).length !== 6 ||
              proof.require_current_pass !== true ||
              !validControlEvidenceId(proof.asset_id) ||
              !validControlEvidenceId(proof.control_id)
            : Object.keys(proof).length !== 5 ||
              !/^workflow-observation:[a-f0-9]{64}$/.test(
                proof.observation_id,
              ) ||
              !Number.isSafeInteger(proof.workflow_run_id) ||
              proof.workflow_run_id < 1)
        ) throw new Error("Invalid workflow evidence requirement.");
        requirements.set(step.id, { ...proof });
      }
      if (step.evidenceWaitSeconds !== undefined) {
        if (
          !proof || !Number.isSafeInteger(step.evidenceWaitSeconds) ||
          step.evidenceWaitSeconds < 1 || step.evidenceWaitSeconds > 60
        ) {
          throw new Error("Invalid workflow evidence wait.");
        }
        evidenceWaits.set(step.id, step.evidenceWaitSeconds * 1000);
      }
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
    const evidenceKinds = [...requirements.values()];
    if (
      evidenceKinds.some((proof) => "goal_id" in proof) &&
      evidenceKinds.some((proof) => !("goal_id" in proof))
    ) {
      throw new Error(
        "Goal-conditioned workflows must use local goal proof or record-only steps.",
      );
    }
    plans.set(plan.id, {
      id: plan.id,
      classification: plan.classification,
      fingerprint: createHash("sha256").update(JSON.stringify([
        1,
        plan.id,
        plan.classification,
        steps,
        ...(requirements.size ? [[...requirements]] : []),
        ...(evidenceWaits.size ? [[...evidenceWaits]] : []),
      ])).digest("hex"),
      steps,
      requirements,
      evidenceWaits,
    });
  }
  return plans;
}

/** Create a local registry view containing only runs started through this adapter. */
export function createOperatorWorkflowRuns(
  registry: WorkflowRunRegistry,
  configuration: readonly OperatorWorkflowPlan[],
  journalPath?: string,
  verifyEvidence?: (
    requirement: WorkflowEvidenceRequirement,
  ) => Promise<WorkflowStepEvidence | undefined>,
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
      status: run.status === "cancelled"
        ? "cancelled"
        : current?.paused && current.status === "running"
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
      status: terminal ??
        (row.status === "restored_paused" ? "paused" : "interrupted"),
      startedAt: row.startedAt,
      ...(terminal && row.completedAt && { completedAt: row.completedAt }),
      steps: plan.steps.map(({ name }, index) => ({
        id: name,
        status: statuses[index] as StepStatus,
      })),
    };
  }

  function save(
    run: AdmittedRun,
    event: OperatorWorkflowTraceInput,
    stepStatuses = run.stepStatuses,
  ) {
    if (!journal) {
      if (
        (event.event === "paused" || event.event === "resumed") &&
        run.transientTrace.filter((item) =>
            item.event === "paused" || item.event === "resumed"
          ).length >=
          MAX_OPERATOR_WORKFLOW_CONTROL_EVENTS
      ) return false;
      run.transientTrace.push({
        ...event,
        sequence: run.transientTrace.length + 1,
      });
      return true;
    }
    return journal.update(
      run.id,
      run.status,
      run.completedAt ?? null,
      JSON.stringify(stepStatuses),
      event,
    );
  }

  async function resolveEvidence(requirement: WorkflowEvidenceRequirement) {
    const verified = await verifyEvidence?.(requirement);
    return validWorkflowStepEvidence(verified) &&
        verified.caseId === requirement.case &&
        verified.runId === requirement.run_id &&
        verified.revision === requirement.revision &&
        ("goal_id" in requirement
          ? "goalId" in verified && verified.goalId === requirement.goal_id
          : "finding_id" in requirement
          ? "findingRecheckId" in verified &&
            verified.findingId === requirement.finding_id
          : "finding_recheck_id" in requirement
          ? "findingRecheckId" in verified &&
            verified.findingRecheckId === requirement.finding_recheck_id
          : "graph_fact_id" in requirement
          ? "graphFactId" in verified &&
            verified.graphFactId === requirement.graph_fact_id &&
            (verified.controlCheckedAt !== undefined) ===
              (requirement.require_current_pass === true)
          : "asset_id" in requirement
          ? "graphFactId" in verified &&
            verified.controlCheckedAt !== undefined &&
            verified.assetId === requirement.asset_id &&
            verified.controlId === requirement.control_id
          : "observationId" in verified &&
            verified.observationId === requirement.observation_id &&
            verified.workflowRunId === requirement.workflow_run_id)
      ? verified
      : undefined;
  }

  async function recheckControlPrerequisites(run: AdmittedRun, index: number) {
    for (const step of run.plan.steps.slice(0, index)) {
      const requirement = run.plan.requirements.get(step.name);
      if (
        !requirement ||
        !("goal_id" in requirement || "require_current_pass" in requirement ||
          "finding_recheck_id" in requirement || "finding_id" in requirement)
      ) continue;
      const original = journal
        ? journal.stepEvidence(run.id, step.name)
        : run.transientTrace.findLast((event) =>
          (event.event === "step_satisfied" ||
            event.event === "step_proof_renewed") &&
          event.stepId === step.name
        );
      const evidence = original && "evidence" in original
        ? original.evidence
        : original;
      if ("goal_id" in requirement) {
        const current = await resolveEvidence(requirement);
        if (
          !evidence || !("goalId" in evidence) ||
          !current || !("goalId" in current) ||
          evidence.resultSha256 !== current.resultSha256
        ) {
          throw new Error(
            "A committed Sentinel goal proof is no longer current.",
          );
        }
        continue;
      }
      if ("finding_recheck_id" in requirement || "finding_id" in requirement) {
        if (
          !evidence || !("findingRecheckId" in evidence) ||
          ("finding_id" in requirement &&
            evidence.findingId !== requirement.finding_id)
        ) {
          throw new Error(
            "A committed remediation recheck is no longer current.",
          );
        }
        const current = await resolveEvidence(
          "finding_id" in requirement
            ? {
              case: requirement.case,
              run_id: requirement.run_id,
              revision: requirement.revision,
              finding_recheck_id: evidence.findingRecheckId,
            }
            : requirement,
        );
        if (
          !current ||
          !("findingRecheckId" in current) ||
          evidence.findingRecheckId !== current.findingRecheckId ||
          evidence.findingId !== current.findingId ||
          evidence.evidenceId !== current.evidenceId ||
          evidence.sourceTaskId !== current.sourceTaskId ||
          evidence.resultSha256 !== current.resultSha256
        ) {
          throw new Error(
            "A committed remediation recheck is no longer current.",
          );
        }
        continue;
      }
      const current = await resolveEvidence(requirement);
      if (
        !evidence || !("graphFactId" in evidence) ||
        !current || !("graphFactId" in current)
      ) {
        throw new Error(
          "A committed control prerequisite is no longer current.",
        );
      }
      if (evidence.graphFactId === current.graphFactId) {
        if (evidence.resultSha256 !== current.resultSha256) {
          throw new Error("A committed control proof changed.");
        }
        continue;
      }
      if (
        !("asset_id" in requirement) ||
        evidence.assetId !== requirement.asset_id ||
        evidence.controlId !== requirement.control_id ||
        !evidence.controlCheckedAt || !current.controlCheckedAt ||
        Date.parse(current.controlCheckedAt) <=
          Date.parse(evidence.controlCheckedAt) ||
        !save(run, {
          event: "step_proof_renewed",
          stepId: step.name,
          at: new Date().toISOString(),
          evidence: current,
        })
      ) {
        throw new Error(
          "The replacement control proof could not be committed.",
        );
      }
    }
  }

  async function execute(
    run: AdmittedRun,
    registration: ReturnType<WorkflowRunRegistry["registerRun"]>,
    lock: Deno.FsFile | undefined,
    offset: number,
  ) {
    let terminal: "completed" | "failed" | "cancelled" = "failed";
    try {
      save(run, { event: "started", at: new Date().toISOString() });
      const result = await executeWorkflow({
        definition: {
          document: { dsl: "1.0.0", namespace: "operator", name: run.plan.id },
          do: run.plan.steps.slice(offset),
          classificationCeiling: run.plan.classification,
        },
        toolExecutor: () =>
          Promise.reject(
            new Error("This operator workflow has no dispatched tools."),
          ),
        getSessionTaint: () => run.plan.classification,
        allowShellExecution: false,
        signal: registration.signal,
        async checkPause() {
          await registration.checkPause();
          registration.signal.throwIfAborted();
        },
        satisfyTask: run.plan.requirements.size
          ? async (taskIndex, taskName) => {
            await recheckControlPrerequisites(run, taskIndex + offset);
            registration.signal.throwIfAborted();
            const requirement = run.plan.requirements.get(taskName);
            if (!requirement) return false;
            const configuredWait = run.plan.evidenceWaits.get(taskName);
            let remaining = 0;
            if (configuredWait !== undefined) {
              const retained = journal?.waitDeadline(run.id, taskName);
              const start = Date.now();
              const deadline = retained ?? start + configuredWait;
              if (
                retained === undefined &&
                !save(run, {
                  event: "step_waiting",
                  stepId: taskName,
                  at: new Date(start).toISOString(),
                  deadlineAt: new Date(deadline).toISOString(),
                })
              ) {
                throw new Error(
                  "The committed evidence wait could not be recorded.",
                );
              }
              remaining = deadline - Date.now();
              if (remaining <= 0) {
                throw new Error("The committed evidence wait expired.");
              }
            }
            const address = "goal_id" in requirement
              ? {
                ...requirement,
                observation_id: `goal:${requirement.goal_id}`,
              }
              : "finding_id" in requirement
              ? { ...requirement, observation_id: requirement.finding_id }
              : "finding_recheck_id" in requirement
              ? {
                ...requirement,
                observation_id: requirement.finding_recheck_id,
              }
              : "graph_fact_id" in requirement
              ? { ...requirement, observation_id: requirement.graph_fact_id }
              : "asset_id" in requirement
              ? {
                ...requirement,
                observation_id: controlEvidenceKey(
                  requirement.asset_id,
                  requirement.control_id,
                ),
              }
              : requirement;
            const evidence = await waitForCommittedEvidence(
              address,
              remaining,
              registration.signal,
              async () => {
                await registration.checkPause();
                registration.signal.throwIfAborted();
                return await resolveEvidence(requirement);
              },
            );
            registration.signal.throwIfAborted();
            const index = taskIndex + offset;
            if (
              !evidence ||
              run.stepStatuses[index] !== "pending" ||
              run.status === "cancelled"
            ) {
              throw new Error(
                "Required committed workflow evidence is unavailable.",
              );
            }
            const settled = [...run.stepStatuses];
            settled[index] = "completed";
            if (
              !save(run, {
                event: "step_satisfied",
                stepId: taskName,
                at: new Date().toISOString(),
                evidence,
              }, settled)
            ) {
              throw new Error(
                "The workflow evidence decision could not be committed.",
              );
            }
            run.stepStatuses[index] = "completed";
            return true;
          }
          : undefined,
        onTaskProgress: (taskIndex, taskName) =>
          registry.reportTaskProgress(run.id, {
            taskIndex: taskIndex + offset,
            taskName,
            taint: run.plan.classification,
          }),
        onStepEvent: (event) => {
          if (run.status === "cancelled") return;
          if (
            event.type !== "STEP_STARTED" && event.type !== "STEP_COMPLETED" &&
            event.type !== "STEP_FAILED"
          ) return;
          const index = event.taskIndex + offset;
          const step = run.plan.steps[index];
          if (!step || step.name !== event.taskName) return;
          const before = run.stepStatuses[index];
          let typedEvent: OperatorWorkflowTraceInput["event"];
          switch (event.type) {
            case "STEP_STARTED":
              if (before !== "pending") return;
              run.stepStatuses[index] = "running";
              typedEvent = "step_started";
              break;
            case "STEP_COMPLETED":
              if (before !== "running") return;
              run.stepStatuses[index] = "completed";
              typedEvent = "step_completed";
              break;
            case "STEP_FAILED":
              if (before !== "running") return;
              run.stepStatuses[index] = "failed";
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
      if (run.status !== "cancelled" || !run.completedAt) {
        run.status = registration.signal.aborted ? "cancelled" : terminal;
        run.completedAt = new Date().toISOString();
        try {
          save(run, { event: run.status, at: run.completedAt });
        } catch {
          // An unavailable journal leaves the durable admission interrupted.
        }
      }
      registry.completeRun(run.id, { status: run.status });
      lock?.close();
      active--;
      for (const [id, entry] of runs) {
        if (runs.size <= MAX_HISTORY) break;
        if (entry.completedAt) runs.delete(id);
      }
    }
  }

  function launch(run: AdmittedRun, lock?: Deno.FsFile, offset = 0) {
    const registration = registry.registerRun({
      runId: run.id,
      workflowName: run.plan.id,
      taint: run.plan.classification,
    });
    runs.set(run.id, run);
    active++;
    if (!journal) save(run, { event: "admitted", at: run.startedAt });
    void execute(run, registration, lock, offset);
    return project(run);
  }

  function resumeInterrupted(
    runId: string,
    ceiling: ClassificationLevel,
    onlyWaiting: boolean,
  ) {
    if (
      !journal || !journalPath || active >= MAX_ACTIVE ||
      !RUN_ID.test(runId) || registry.getActiveRun(runId)
    ) return undefined;
    const lock = lockWorkflowRun(journalPath, runId);
    if (!lock) return undefined;
    let launched = false;
    try {
      const row = journal.inspect(runId);
      if (
        !row || row.completedAt !== null ||
        (onlyWaiting
          ? row.status !== "running"
          : (row.status !== "paused" && row.status !== "running" &&
            row.status !== "restored_paused"))
      ) return;
      const view = reopen(row, ceiling);
      if (
        !view || (view.status !== "interrupted" && view.status !== "paused")
      ) return;
      const plan = plans.get(view.planId)!;
      // These admitted steps have no external side effects or downstream
      // dependencies on the completed steps' in-memory outputs.
      if (
        plan.steps.some(({ task }) =>
          task.type !== "set" && task.type !== "wait"
        )
      ) return;
      const statuses = view.steps.map(({ status }) => status);
      const firstPending = statuses.findIndex((status) =>
        status !== "completed"
      );
      const offset = firstPending < 0 ? statuses.length : firstPending;
      if (
        statuses.slice(offset).some((status, index) =>
          status !== "pending" && !(index === 0 && status === "running")
        )
      ) return;
      if (onlyWaiting) {
        const step = plan.steps[offset];
        if (
          !step || statuses[offset] !== "pending" ||
          !plan.evidenceWaits.has(step.name) ||
          journal.waitDeadline(runId, step.name) === undefined
        ) return;
      }
      if (offset < statuses.length) statuses[offset] = "pending";
      const resumed: AdmittedRun = {
        id: row.runId,
        requestId: row.requestId,
        plan,
        startedAt: row.startedAt,
        status: "running",
        stepStatuses: statuses,
        transientTrace: [],
      };
      if (!save(resumed, { event: "resumed", at: new Date().toISOString() })) {
        return;
      }
      const result = launch(resumed, lock, offset);
      launched = true;
      return result;
    } finally {
      if (!launched) lock.close();
    }
  }

  return {
    recoverWaiting() {
      if (!journal || !verifyEvidence) return [];
      const recovered: string[] = [];
      for (const { runId } of journal.interruptedWaits(MAX_HISTORY)) {
        if (active >= MAX_ACTIVE) break;
        if (runs.has(runId)) continue;
        try {
          if (resumeInterrupted(runId, "INTERNAL", true)) recovered.push(runId);
        } catch {
          // An invalid retained deadline requires an operator to inspect the run.
        }
      }
      return recovered;
    },
    archiveSnapshot(runId: string): WorkflowArchiveSnapshot | undefined {
      if (!journal || !journalPath || !RUN_ID.test(runId)) return;
      using lock = lockWorkflowRun(journalPath, runId);
      if (!lock) return;
      const admission = journal.inspect(runId);
      const view = admission && reopen(admission, "INTERNAL");
      if (!admission || !view) return;
      const page = journal.traces(runId, admission.fingerprint, 0, 1000);
      if (!page) return;
      const snapshot = { admission, events: page.events };
      return validWorkflowArchive(snapshot, view) ? snapshot : undefined;
    },
    restoreArchive(
      runId: string,
      snapshot: WorkflowArchiveSnapshot,
      links?: { path: string; records: readonly ArchivedOperatorRunLink[] },
      installKey?: RunArchiveRestoreKey,
    ) {
      if (!journal || !journalPath || !RUN_ID.test(runId)) return false;
      using lock = lockWorkflowRun(journalPath, runId);
      if (!lock || registry.getActiveRun(runId) || runs.has(runId)) {
        return false;
      }
      const { admission, events } = snapshot;
      const view = admission.runId === runId && reopen(admission, "INTERNAL");
      return !!view && validWorkflowArchive(snapshot, view) &&
        journal.restore(admission, events, links, installKey);
    },
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
        readonly query?: string;
      } = {},
    ) {
      const { cursor, limit = 10, sequence, query } = options;
      if (
        typeof runId !== "string" || !RUN_ID.test(runId) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRACE_PAGE ||
        (query !== undefined && (typeof query !== "string" ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(query) || sequence !== undefined)) ||
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
      const term = query?.toLowerCase();
      const binding = createHash("sha256").update(JSON.stringify([
        journalPath === undefined ? null : resolve(journalPath),
        runId,
        plan.fingerprint,
        ...(term ? [term] : []),
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
        ? journal.traces(runId, plan.fingerprint, after, pageSize, term)
        : live && {
          events: live.transientTrace.slice(after).filter((item) =>
            !term || item.event.includes(term) ||
            ("stepId" in item && item.stepId.toLowerCase().includes(term))
          ).slice(0, pageSize),
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
    inspectRequest(
      requestId: string,
      ceiling: ClassificationLevel = "INTERNAL",
    ) {
      const saved = journal?.readRequest(requestId);
      return saved && reopen(saved, ceiling);
    },
    start(
      planId: string,
      ceiling: ClassificationLevel = "INTERNAL",
      requestId: string = crypto.randomUUID(),
      link?: { path: string; input: Omit<OperatorRunLinkInput, "right"> },
    ) {
      if (link && !journal) return undefined;
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
      const lock = journalPath && lockWorkflowRun(journalPath, id);
      if (journalPath && !lock) return undefined;
      try {
        const admission = journal?.admit(
          {
            runId: id,
            requestId,
            planId,
            fingerprint: plan.fingerprint,
            classification: plan.classification,
            status: run.status,
            startedAt: run.startedAt,
            completedAt: null,
            stepStatuses: JSON.stringify(run.stepStatuses),
          },
          link && {
            path: link.path,
            input: { ...link.input, right: { kind: "workflow", id } },
          },
        );
        if (admission && !admission.admitted) {
          if (lock) lock.close();
          return admission.prior?.planId === planId
            ? reopen(admission.prior, ceiling)
            : undefined;
        }
        return launch(run, lock || undefined);
      } catch (error) {
        if (lock) lock.close();
        throw error;
      }
    },
    cancel(runId: string, ceiling: ClassificationLevel = "INTERNAL") {
      if (typeof runId !== "string" || !RUN_ID.test(runId)) return;
      const live = find(runId, ceiling);
      const at = new Date().toISOString();
      if (live) {
        const view = project(live);
        if (view.status === "cancelled") return view;
        if (view.status !== "running" && view.status !== "paused") return;
        if (journal && !journal.cancel(runId, at)) return;
        live.status = "cancelled";
        live.completedAt = at;
        if (!journal) save(live, { event: "cancelled", at });
        registry.stopRun(runId);
        return project(live);
      }
      if (!journalPath || !journal || registry.getActiveRun(runId)) return;
      using lock = lockWorkflowRun(journalPath, runId);
      if (!lock) return;
      const row = journal.inspect(runId);
      const view = row && reopen(row, ceiling);
      if (!view || view.status === "cancelled") return view;
      if (!journal.cancel(runId, at)) return;
      return { ...view, status: "cancelled" as const, completedAt: at };
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
      if (run) {
        if (run.status === "cancelled" || !registry.unpauseRun(runId)) {
          return undefined;
        }
        run.status = "running";
        save(run, { event: "resumed", at: new Date().toISOString() });
        return project(run);
      }
      return resumeInterrupted(runId, ceiling, false);
    },
  };
}

export type OperatorWorkflowRuns = ReturnType<
  typeof createOperatorWorkflowRuns
>;
