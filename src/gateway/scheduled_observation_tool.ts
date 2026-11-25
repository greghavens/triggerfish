import { createHash } from "node:crypto";
import { readVerifiedPassingFindingRecheck } from "../sentinel/worker_finding_evidence.ts";
import {
  readSentinelCaseFindingReceipts,
  readSentinelWorkerFindingHistory,
} from "../sentinel/worker_finding_store.ts";
/** Reopen one observation explicitly granted to a trusted execution. */
import {
  readSentinelAssessment,
  readSentinelOperatingConstraints,
} from "../sentinel/assessment_store.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import {
  readSentinelWorkerGraphRelationship,
  satisfiesSentinelGraphFactRequirement,
  type SentinelWorkerGraphFact,
} from "../sentinel/worker_graph_facts.ts";
import { latestAssignedControlCheck } from "../sentinel/assigned_relationship_facts.ts";
import { readSentinelPlannerGraphFacts } from "./sentinel_graph_fact_tool.ts";
import {
  selectSentinelDelegatedObservationRead,
  selectSentinelScheduledObservationRead,
  selectSentinelTeamObservationRead,
} from "../core/config_types.ts";
import { canFlowTo } from "../core/types/classification.ts";
import type { OrchestratorCreateOptions } from "../scheduler/service_types.ts";
import type {
  SentinelObservationReference,
  TriggerFishConfig,
  WorkflowEvidenceRequirement,
} from "../core/config_types.ts";
import type { ExecutionTraceApprovedPayload } from "../core/execution_traces.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { ToolDefinition } from "../core/types/tool.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import { readSentinelIntermediateWorkflowObservations } from "./sentinel_adaptive_runtime.ts";

type Authorize = (
  payload: ExecutionTraceApprovedPayload,
  prior: ClassificationLevel,
) => Promise<boolean>;

/** Bind the exact grant only to a trusted execution and sufficient ceiling. */
export function selectAgentObservationRead(
  sentinel: TriggerFishConfig["sentinel"],
  options: OrchestratorCreateOptions | undefined,
): SentinelObservationReference | undefined {
  if (!options?.ceiling || !canFlowTo("INTERNAL", options.ceiling)) return;
  if (
    options.delegatedKind === "team" && options.teamObservation &&
    options.recoverySessionId ===
      options.teamObservation.source.memberSessionId &&
    options.recoverySessionTaint &&
    canFlowTo("INTERNAL", options.recoverySessionTaint)
  ) {
    return selectSentinelTeamObservationRead(
      sentinel?.team_observation_reads,
      options.teamObservation.source,
    );
  }
  if (options.delegatedKind) {
    if (options.delegatedKind !== "subagent" || !options.recoverySessionId) {
      return;
    }
    return selectSentinelDelegatedObservationRead(
      sentinel?.delegated_observation_reads,
      options.delegatedObservationSource,
    );
  }
  return selectSentinelScheduledObservationRead(
    sentinel?.scheduled_observation_reads,
    options.scheduledObservationSource ?? options.cronJobId,
  );
}

export const scheduledObservationTool: ToolDefinition = {
  name: "read_committed_observation",
  description:
    "Open the exact committed observation granted to this scheduled or delegated execution, with its source assignment and step.",
  parameters: {},
};

function exactObservation(
  baseDir: string,
  grant: SentinelObservationReference,
) {
  const result = readSentinelIntermediateWorkflowObservations(
    resolveSentinelCasePath(baseDir, grant.case),
    grant.revision,
    grant.run_id,
    { id: grant.observation_id },
  );
  return result && "observation" in result ? result.observation : undefined;
}

function project(
  grant: SentinelObservationReference,
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
  grant: SentinelObservationReference,
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
  grant: SentinelObservationReference,
  authorize: Authorize,
  authorizeScope?: () => Promise<boolean>,
) {
  const unavailable =
    "Error: The granted committed observation is unavailable.";
  return async (args: Record<string, unknown>) => {
    if (Object.keys(args).length) return unavailable;
    try {
      if (authorizeScope && !await authorizeScope()) return unavailable;
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
        (authorizeScope && !await authorizeScope()) ||
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
  authorize?: Authorize,
  now = Date.now,
) {
  return async (requirement: WorkflowEvidenceRequirement) => {
    const { case: caseId, run_id: runId, revision } = requirement;
    const path = resolveSentinelCasePath(baseDir, caseId);
    const current = () => {
      const state = readSentinelAssessment(path);
      return state?.plan.runId === runId && state.revision === revision
        ? state
        : undefined;
    };
    const state = current();
    if (!state) return;
    if ("finding_recheck_id" in requirement || "finding_id" in requirement) {
      const snapshot = state.result?.sharedGraph.snapshot;
      if (!snapshot) return;
      const exact = "finding_recheck_id" in requirement;
      const id = exact
        ? requirement.finding_recheck_id
        : requirement.finding_id;
      const candidate = readSentinelCaseFindingReceipts(path, [id]).get(id);
      const constraints = readSentinelOperatingConstraints(path, runId);
      if (
        candidate?.kind !== (exact ? "recheck" : "finding") ||
        candidate.caseId !== caseId || candidate.runId !== runId ||
        candidate.evidenceRevision > revision ||
        !sentinelOperatingConstraintsAllow(
          constraints?.constraints,
          { kind: "review_evidence", nodeId: candidate.targetId },
          snapshot,
        )
      ) return;
      const controlCheckedAt = new Date(now()).toISOString();
      const scope = {
        caseId,
        runId,
        evidenceRevision: revision,
        targetId: candidate.targetId,
        evaluatedAt: controlCheckedAt,
      };
      const candidateIds = exact
        ? [id]
        : readSentinelWorkerFindingHistory(path, revision).flatMap((record) =>
          record.kind === "recheck" && record.findingId === id &&
            record.caseId === caseId && record.runId === runId &&
            record.targetId === candidate.targetId && record.outcome === "pass"
            ? [record.id]
            : []
        );
      let receipt: ReturnType<typeof readVerifiedPassingFindingRecheck>;
      for (const candidateId of candidateIds) {
        receipt = readVerifiedPassingFindingRecheck(
          path,
          snapshot,
          scope,
          candidateId,
        );
        if (receipt) break;
      }
      if (
        !receipt || !current() ||
        readSentinelOperatingConstraints(path, runId)?.digest !==
          constraints?.digest
      ) return;
      return {
        caseId,
        runId,
        revision,
        findingRecheckId: receipt.id,
        findingId: receipt.findingId,
        evidenceId: receipt.evidenceId,
        sourceTaskId: receipt.taskId,
        resultSha256: createHash("sha256").update(JSON.stringify(receipt))
          .digest("hex"),
        controlCheckedAt,
      };
    }
    if (!("observation_id" in requirement)) {
      const snapshot = state.result?.sharedGraph.snapshot;
      if (!snapshot) return;
      const time = now();
      const selected = "asset_id" in requirement
        ? latestAssignedControlCheck(
          snapshot,
          requirement.asset_id,
          requirement.control_id,
          time,
        )
        : undefined;
      const factId = "graph_fact_id" in requirement
        ? requirement.graph_fact_id
        : selected && readSentinelWorkerGraphRelationship(
          path,
          {
            caseId,
            runId,
            evidenceRevision: revision,
            targetId: requirement.asset_id,
          },
          selected.relationship,
        )?.id;
      if (!factId) return;
      const constraints = readSentinelOperatingConstraints(path, runId);
      const text = readSentinelPlannerGraphFacts(
        path,
        caseId,
        runId,
        revision,
        { id: factId },
        (nodeId) =>
          sentinelOperatingConstraintsAllow(
            constraints?.constraints,
            { kind: "review_evidence", nodeId },
            state.result?.sharedGraph.snapshot,
          ),
      );
      if (
        !text || !current() ||
        readSentinelOperatingConstraints(path, runId)?.digest !==
          constraints?.digest
      ) return;
      const fact = JSON.parse(text) as SentinelWorkerGraphFact;
      let controlCheckedAt: string | undefined;
      if (requirement.require_current_pass) {
        if (
          !satisfiesSentinelGraphFactRequirement(
            {
              to: fact.relationship.to,
              relation: "verifies",
              requireCurrentPass: true,
            },
            fact,
            time,
          ) ||
          (selected ??
              latestAssignedControlCheck(
                snapshot,
                fact.targetId,
                fact.relationship.to,
                time,
              ))?.relationship.from !== fact.relationship.from
        ) return;
        controlCheckedAt = new Date(time).toISOString();
      }
      return {
        ...(controlCheckedAt !== undefined && { controlCheckedAt }),
        graphFactId: fact.id,
        ...("asset_id" in requirement && {
          assetId: fact.targetId,
          controlId: fact.relationship.to,
        }),
        sourceTaskId: fact.taskId,
        sourceStepIndex: fact.sourceStepIndex,
        caseId,
        runId,
        revision,
        resultSha256: fact.resultSha256,
      };
    }
    if (!authorize) return;
    const { workflow_run_id: workflowRunId } = requirement;
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
