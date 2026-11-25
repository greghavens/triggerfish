/** A cron occurrence can reopen one explicitly granted, policy-approved observation. */
import { readSentinelAssessment } from "../sentinel/assessment_store.ts";
import type {
  TriggerFishConfig,
  WorkflowEvidenceRequirement,
} from "../core/config_types.ts";
import type { ExecutionTraceApprovedPayload } from "../core/execution_traces.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { ToolDefinition } from "../core/types/tool.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import { readSentinelIntermediateWorkflowObservations } from "./sentinel_adaptive_runtime.ts";

type Grant = NonNullable<
  NonNullable<TriggerFishConfig["sentinel"]>["scheduled_observation_reads"]
>[number];
type Authorize = (
  payload: ExecutionTraceApprovedPayload,
  prior: ClassificationLevel,
) => Promise<boolean>;

export const scheduledObservationTool: ToolDefinition = {
  name: "read_committed_observation",
  description:
    "Open the exact committed observation granted to this cron job, with its source assignment and step.",
  parameters: {},
};

function exactObservation(baseDir: string, grant: Omit<Grant, "cron_job_id">) {
  const result = readSentinelIntermediateWorkflowObservations(
    resolveSentinelCasePath(baseDir, grant.case),
    grant.revision,
    grant.run_id,
    { id: grant.observation_id },
  );
  return result && "observation" in result ? result.observation : undefined;
}

function project(
  grant: Omit<Grant, "cron_job_id">,
  observation: NonNullable<ReturnType<typeof exactObservation>>,
) {
  return JSON.stringify({
    _classification: "INTERNAL",
    caseId: grant.case,
    runId: grant.run_id,
    observation,
  });
}

export function matchesScheduledObservationProjection(
  baseDir: string,
  grant: Omit<Grant, "cron_job_id">,
  text: string,
) {
  try {
    const current = exactObservation(baseDir, grant);
    return !!current && text.length <= 6_000 &&
      project(grant, current) === text;
  } catch {
    return false;
  }
}

export function createScheduledObservationRead(
  baseDir: string,
  grant: Omit<Grant, "cron_job_id">,
  authorize: Authorize,
) {
  const unavailable =
    "Error: The granted committed observation is unavailable.";
  return async (args: Record<string, unknown>) => {
    if (Object.keys(args).length) return unavailable;
    try {
      const observation = exactObservation(baseDir, grant);
      if (!observation) return unavailable;
      const { receipt } = observation;
      const repositoryId = receipt.runs[0]?.repositoryId;
      if (
        receipt.connectorId !== "github-actions" ||
        repositoryId === undefined ||
        !receipt.runs.every((run) => run.repositoryId === repositoryId)
      ) return unavailable;
      const result = project(grant, observation);
      if (
        !await authorize({
          kind: "github_actions_status",
          repo: receipt.repository,
          workflow: String(receipt.workflowId),
          repositoryId,
          runs: receipt.runs.map(({ id, status, conclusion, createdAt }) => ({
            id,
            status,
            conclusion,
            ...(createdAt && { created_at: createdAt }),
          })),
        }, "INTERNAL") ||
        !matchesScheduledObservationProjection(baseDir, grant, result)
      ) {
        return unavailable;
      }
      return result.length <= 6_000 ? result : unavailable;
    } catch {
      return unavailable;
    }
  };
}

export function createWorkflowObservationVerifier(
  baseDir: string,
  authorize: Authorize,
) {
  return async (requirement: WorkflowEvidenceRequirement) => {
    const {
      case: caseId,
      run_id: runId,
      revision,
      workflow_run_id: workflowRunId,
    } = requirement;
    const current = () => {
      const state = readSentinelAssessment(
        resolveSentinelCasePath(baseDir, caseId),
      );
      return state?.plan.runId === runId && state.revision === revision;
    };
    if (!current()) return;
    const read = createScheduledObservationRead(
      baseDir,
      requirement,
      authorize,
    );
    const text = await read({});
    if (!text.startsWith("{") || !current()) return;
    const observation = (JSON.parse(text) as {
      observation: NonNullable<ReturnType<typeof exactObservation>>;
    }).observation;
    if (
      !observation.receipt.runs.some(({ id, status, conclusion }) =>
        id === workflowRunId && status === "completed" &&
        conclusion === "success"
      )
    ) return;
    return {
      observationId: observation.id,
      sourceTaskId: observation.taskId,
      sourceStepIndex: observation.stepIndex,
      caseId,
      runId,
      revision,
      resultSha256: observation.receipt.resultSha256,
      workflowRunId,
    };
  };
}
