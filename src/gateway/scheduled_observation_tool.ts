import { createHash } from "node:crypto";
import {
  readVerifiedPassingFindingRecheck,
  verifyWorkerFindingRecheck,
} from "../sentinel/worker_finding_evidence.ts";
import {
  readSentinelCaseFindingReceipts,
  readSentinelWorkerFindingHistory,
  type SentinelWorkerFindingJournalRecord,
} from "../sentinel/worker_finding_store.ts";
/** Reopen one observation explicitly granted to a trusted execution. */
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
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
  sentinelLocalObservationKind,
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
import type { loadSentinelGraph } from "../sentinel/graph.ts";
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
  const grant = selectSentinelScheduledObservationRead(
    sentinel?.scheduled_observation_reads,
    options.scheduledObservationSource ?? options.cronJobId,
  );
  if (
    grant && sentinelLocalObservationKind(grant.observation_id) &&
    (!options.scheduledObservationSource || !options.recoverySessionId)
  ) return;
  return grant;
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

type CaseSnapshot = ReturnType<
  ReturnType<typeof loadSentinelGraph>["snapshot"]
>;

function localControlReceipt(
  snapshot: CaseSnapshot,
  record: SentinelWorkerFindingJournalRecord,
  evaluatedAt: string,
) {
  const evidence = snapshot.nodes.find(({ id }) => id === record.evidenceId);
  if (
    evidence?.kind !== "evidence" || evidence.executionSource ||
    evidence.nativeWorkflowSource
  ) return;
  const receipt = verifyWorkerFindingRecheck(snapshot, {
    caseId: record.caseId,
    evidenceRevision: record.evidenceRevision,
    evaluatedAt,
  }, {
    assetId: record.targetId,
    findingId: record.graphFindingId,
    controlId: record.controlId,
    evidenceId: record.evidenceId,
  });
  if (
    !receipt || receipt.snapshotDigest !== record.snapshotDigest ||
    receipt.observedAt !== record.observedAt ||
    receipt.validUntil !== record.validUntil ||
    receipt.outcome !== (record.kind === "finding" ? "fail" : record.outcome)
  ) return;
  return {
    id: record.id,
    caseId: record.caseId,
    runId: record.runId,
    evidenceRevision: record.evidenceRevision,
    taskId: record.taskId,
    recordedAt: record.recordedAt,
    assetId: receipt.assetId,
    graphFindingId: receipt.findingId,
    evidenceId: receipt.evidenceId,
    controlId: receipt.controlId,
    snapshotDigest: receipt.snapshotDigest,
    outcome: receipt.outcome,
    observedAt: receipt.observedAt,
    validUntil: receipt.validUntil,
    evaluatedAt: record.evaluatedAt,
  };
}

function localFindingRecheckProjection(
  path: string,
  grant: SentinelObservationReference,
  snapshot: CaseSnapshot,
  allowTarget: (nodeId: string) => boolean,
) {
  const recheck = readSentinelCaseFindingReceipts(path, [grant.observation_id])
    .get(grant.observation_id);
  if (
    recheck?.kind !== "recheck" || recheck.caseId !== grant.case ||
    recheck.runId !== grant.run_id ||
    recheck.evidenceRevision !== grant.revision ||
    !allowTarget(recheck.targetId)
  ) return;
  const finding = readSentinelCaseFindingReceipts(path, [recheck.findingId])
    .get(recheck.findingId);
  if (
    finding?.kind !== "finding" || finding.caseId !== recheck.caseId ||
    finding.runId !== recheck.runId || finding.targetId !== recheck.targetId ||
    finding.graphFindingId !== recheck.graphFindingId ||
    finding.controlId !== recheck.controlId ||
    finding.evidenceRevision > recheck.evidenceRevision ||
    finding.taskId === recheck.taskId ||
    finding.observedAt >= recheck.observedAt
  ) return;
  const originalSnapshot = readSentinelAssessmentRevision(
    path,
    finding.evidenceRevision,
  )
    ?.result.sharedGraph.snapshot;
  const verifiedFinding = originalSnapshot &&
    localControlReceipt(originalSnapshot, finding, finding.evaluatedAt);
  const verifiedRecheck = verifiedFinding &&
    localControlReceipt(snapshot, recheck, new Date().toISOString());
  if (!verifiedRecheck) return;
  const projection = JSON.stringify({
    _classification: "INTERNAL",
    kind: "finding_recheck",
    finding: verifiedFinding,
    recheck: { ...verifiedRecheck, findingId: finding.id },
  });
  return projection.length <= 7000 ? projection : undefined;
}

function exactLocalObservationProjection(
  baseDir: string,
  grant: SentinelObservationReference,
) {
  const path = resolveSentinelCasePath(baseDir, grant.case);
  const state = readSentinelAssessment(path);
  if (state?.plan.runId !== grant.run_id || state.revision !== grant.revision) {
    return;
  }
  const snapshot = state.result?.sharedGraph.snapshot;
  if (!snapshot) return;
  const restrictions = readSentinelOperatingConstraints(path, grant.run_id);
  const allowTarget = (nodeId: string) =>
    sentinelOperatingConstraintsAllow(
      restrictions?.constraints,
      { kind: "review_evidence", nodeId },
      snapshot,
    );
  const result =
    sentinelLocalObservationKind(grant.observation_id) === "finding_recheck"
      ? localFindingRecheckProjection(path, grant, snapshot, allowTarget)
      : readSentinelPlannerGraphFacts(
        path,
        grant.case,
        grant.run_id,
        grant.revision,
        { id: grant.observation_id },
        allowTarget,
      );
  const current = readSentinelAssessment(path);
  if (
    current?.plan.runId !== grant.run_id ||
    current.revision !== grant.revision ||
    readSentinelOperatingConstraints(path, grant.run_id)?.digest !==
      restrictions?.digest
  ) {
    return;
  }
  return result;
}

export function matchesScheduledObservationProjection(
  baseDir: string,
  grant: SentinelObservationReference,
  text: string,
) {
  try {
    if (sentinelLocalObservationKind(grant.observation_id)) {
      return exactLocalObservationProjection(baseDir, grant) === text;
    }
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
  authorize: Authorize | undefined,
  authorizeScope?: () => Promise<boolean>,
) {
  const unavailable =
    "Error: The granted committed observation is unavailable.";
  return async (args: Record<string, unknown>) => {
    if (Object.keys(args).length) return unavailable;
    try {
      if (authorizeScope && !await authorizeScope()) return unavailable;
      if (sentinelLocalObservationKind(grant.observation_id)) {
        const result = exactLocalObservationProjection(baseDir, grant);
        if (
          !result || (authorizeScope && !await authorizeScope()) ||
          !matchesScheduledObservationProjection(baseDir, grant, result)
        ) return unavailable;
        return result;
      }
      if (!authorize) return unavailable;
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
