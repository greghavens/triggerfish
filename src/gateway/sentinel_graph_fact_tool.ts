/** Broker exact relationship facts from post-authorized assigned-target reads. */
import {
  controlEvidenceKey,
  notifyCommittedEvidence,
} from "../core/evidence_task_progression.ts";
import type { ToolDefinition } from "../core/types/tool.ts";
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";
import {
  extractSentinelAssignedRelationshipFacts,
  type SentinelAssignedRelationshipFact,
} from "../sentinel/assigned_relationship_facts.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
import {
  listSentinelWorkerGraphFacts,
  matchesSentinelGraphFact,
  openSentinelWorkerGraphFacts,
  readSentinelCaseGraphFactCursorPage,
  readSentinelCaseGraphFacts,
  readSentinelWorkerGraphFact,
  sentinelGraphFactScopeFilter,
  type SentinelWorkerGraphFact,
} from "../sentinel/worker_graph_facts.ts";
import type { SentinelAgentOptions } from "./sentinel_agent.ts";
import { readAssignedSentinelModelReview } from "./sentinel_adaptive_runtime.ts";

type Scope = Pick<
  SentinelAgentOptions,
  | "snapshotPath"
  | "assessmentRevision"
  | "assignedTaskId"
  | "assignedTaskLeaseToken"
>;
type StagedFact = SentinelAssignedRelationshipFact & {
  readonly sourceStepIndex: number;
};
const text = {
  type: "string",
  description: "Exact identifier",
  required: true,
};

export const sentinelPublishGraphFact: ToolDefinition = {
  name: "sentinel_publish_graph_fact",
  description:
    "Publish an exact relationship or control check delivered by sentinel_assigned_target in this assignment.",
  parameters: { from: text, to: text, relation: text, requestId: text },
};
export const sentinelReadGraphFact: ToolDefinition = {
  name: "sentinel_graph_facts",
  description:
    "List committed relationship facts for the assigned target or reopen one by exact ID.",
  parameters: {
    id: { type: "string", description: "Exact committed graph fact ID" },
    offset: { type: "integer", description: "Page offset" },
  },
};
export function isSentinelGraphFactTool(name: string) {
  return name === sentinelPublishGraphFact.name ||
    name === sentinelReadGraphFact.name;
}

function assigned(scope: Scope) {
  const {
    snapshotPath,
    assessmentRevision,
    assignedTaskId,
    assignedTaskLeaseToken,
  } = scope;
  return assessmentRevision && assignedTaskId && assignedTaskLeaseToken
    ? readAssignedSentinelModelReview(
      snapshotPath,
      assessmentRevision,
      assignedTaskId,
      assignedTaskLeaseToken,
    )
    : undefined;
}

export function stageSentinelGraphFacts(
  scope: Scope,
  result: string,
  sourceStepIndex: number,
): StagedFact[] {
  const task = assigned(scope);
  const state = readSentinelAssessment(scope.snapshotPath);
  const caseId = locateSentinelCase(scope.snapshotPath)?.caseId;
  const snapshot = state?.result?.sharedGraph.snapshot;
  const runId = state?.plan.runId;
  if (
    !task?.nodeId || !caseId || !snapshot || !runId || !state ||
    state.revision !== scope.assessmentRevision || sourceStepIndex >= 16
  ) return [];
  return extractSentinelAssignedRelationshipFacts(result, {
    caseId,
    runId,
    evidenceRevision: state.revision,
    taskId: task.id,
    taskKind: task.kind,
    targetId: task.nodeId,
    snapshot,
  }).map((fact) => ({ ...fact, sourceStepIndex }));
}

export function executeSentinelGraphFactTool(
  scope: Scope,
  name: string,
  args: Record<string, unknown>,
  staged: readonly StagedFact[],
  signal: AbortSignal,
): string {
  const unavailable =
    "Error: The exact assigned relationship fact is unavailable.";
  try {
    return withSentinelAssessmentWriteLock(scope.snapshotPath, (state) => {
      const task = assigned(scope);
      const caseId = locateSentinelCase(scope.snapshotPath)?.caseId;
      const snapshot = state?.result?.sharedGraph.snapshot;
      const runId = state?.plan.runId;
      if (
        !task?.nodeId || !caseId || !snapshot || !runId || !state ||
        state.revision !== scope.assessmentRevision || signal.aborted
      ) return unavailable;
      const exact = {
        caseId,
        runId,
        evidenceRevision: state.revision,
        targetId: task.nodeId,
      };
      if (name === sentinelReadGraphFact.name) {
        const { id, offset } = args;
        if (
          Object.keys(args).some((key) => key !== "id" && key !== "offset") ||
          (id !== undefined &&
            (typeof id !== "string" || offset !== undefined)) ||
          (offset !== undefined &&
            (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
              offset < 0))
        ) return unavailable;
        const page = typeof id === "string"
          ? readSentinelWorkerGraphFact(scope.snapshotPath, exact, id)
          : listSentinelWorkerGraphFacts(scope.snapshotPath, exact, {
            limit: 3,
            offset,
          });
        return page
          ? JSON.stringify({ _classification: "INTERNAL", ...page })
          : unavailable;
      }
      const { from, to, relation, requestId } = args;
      if (
        Object.keys(args).some((key) =>
          !Object.hasOwn(sentinelPublishGraphFact.parameters, key)
        ) ||
        typeof requestId !== "string"
      ) return unavailable;
      const proof = staged.find((fact) =>
        fact.taskId === task.id &&
        fact.caseId === caseId && fact.runId === runId &&
        fact.evidenceRevision === state.revision &&
        fact.targetId === task.nodeId &&
        fact.relationship.from === from && fact.relationship.to === to &&
        fact.relationship.relation === relation
      );
      if (!proof || proof.snapshotDigest !== digestSentinelSnapshot(snapshot)) {
        return unavailable;
      }
      const journal = openSentinelWorkerGraphFacts(scope.snapshotPath);
      try {
        const fact = journal.record(
          { ...proof, requestId },
          () => !signal.aborted && assigned(scope)?.id === task.id,
        );
        if (fact) {
          const address = {
            case: caseId,
            run_id: runId,
            revision: state.revision,
          };
          notifyCommittedEvidence({ ...address, observation_id: fact.id });
          if (fact.controlVerification) {
            notifyCommittedEvidence({
              ...address,
              observation_id: controlEvidenceKey(
                fact.targetId,
                fact.relationship.to,
              ),
            });
          }
        }
        return fact
          ? JSON.stringify({ _classification: "INTERNAL", ...fact })
          : unavailable;
      } finally {
        journal.close();
      }
    });
  } catch {
    return unavailable;
  }
}

/** Project committed facts filtered to the selected planner scope. */
export function readSentinelPlannerGraphFacts(
  snapshotPath: string,
  caseId: string,
  runId: string,
  evidenceRevision: number,
  selector: { id?: string; offset?: number; query?: string; cursor?: string },
  allowTarget: (id: string) => boolean,
  retained?: {
    ids: readonly string[];
    nextOffset: number | null;
    nextCursor?: string | null;
  },
  policy?: { version: number; digest: string },
) {
  const snapshot = readSentinelAssessmentRevision(
    snapshotPath,
    evidenceRevision,
  )
    ?.result.sharedGraph.snapshot;
  if (!snapshot) return;
  const allows = sentinelGraphFactScopeFilter(snapshot, allowTarget);
  const scope = { caseId, runId, evidenceRevision };
  const single = (id: string) => {
    const result = readSentinelCaseGraphFacts(
      snapshotPath,
      scope,
      { id },
      allows,
    );
    if (!result || !("fact" in result)) return;
    return selector.query === undefined ||
        matchesSentinelGraphFact(result.fact, selector.query)
      ? result.fact
      : undefined;
  };
  const visible = (
    { requestId: _requestId, ...fact }: SentinelWorkerGraphFact,
  ) => fact;
  let projection: unknown;
  if (selector.id !== undefined) {
    const fact = single(selector.id);
    if (!fact) return;
    projection = { _classification: "INTERNAL", ...visible(fact) };
  } else {
    const saved = retained
      ? {
        facts: retained.ids.map(single),
        nextOffset: retained.nextOffset,
        nextCursor: retained.nextCursor,
      }
      : selector.cursor !== undefined
      ? readSentinelCaseGraphFactCursorPage(
        snapshotPath,
        scope,
        {
          cursor: selector.cursor,
          query: selector.query,
          limit: 3,
          audience: "planner",
        },
        policy,
        allows,
      )
      : readSentinelCaseGraphFacts(snapshotPath, scope, {
        offset: selector.offset,
        query: selector.query,
        limit: 3,
      }, allows);
    if (!saved || !("facts" in saved)) return;
    const facts = Array.from(saved.facts).filter((fact) => fact !== undefined);
    if (facts.length !== saved.facts.length) return;
    projection = {
      _classification: "INTERNAL",
      facts: facts.map(visible),
      nextOffset: saved.nextOffset,
      ...("nextCursor" in saved && saved.nextCursor !== undefined &&
        { nextCursor: saved.nextCursor }),
    };
  }
  const text = JSON.stringify(projection);
  return text.length <= 7000 ? text : undefined;
}
