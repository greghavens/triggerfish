import { createHash } from "node:crypto";
import { dirname, join } from "@std/path";
import { openSentinelAdaptiveStore } from "./adaptive_store.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelGitHubWorkflowReadReceipt,
  readSentinelRunIdForRevision,
} from "./assessment_store.ts";
import { nativeWorkflowControlCandidate } from "./case_execution_evidence.ts";
import type { SentinelNativeWorkflowSource } from "./graph.ts";

/** Resolve a native graph citation against its exact persisted tool step. */
export function readNativeWorkflowCitation(
  store: ReturnType<typeof openSentinelAdaptiveStore>,
  source: SentinelNativeWorkflowSource,
) {
  const mapping = store.forEvidence(source.revision);
  if (!mapping || mapping.goal.id !== source.runId) return;
  const task = store.list(mapping.revision).find(({ id }) =>
    id === source.taskId
  );
  if (!task?.nodeId) return;
  const step = store.modelReviewNotes(mapping.revision).find(
    ({ taskId }) => taskId === source.taskId,
  )?.steps[source.stepIndex] ??
    store.modelReviewStates(mapping.revision).find(
      ({ taskId }) => taskId === source.taskId,
    )?.progressSteps?.[source.stepIndex];
  if (
    step?.tool !== "sentinel_live_workflow_status" ||
    step.outcome !== "returned" || step.target !== task.nodeId
  ) return;
  const saved = readSentinelGitHubWorkflowReadReceipt(
    step.githubWorkflowRead,
    source.revision,
  );
  if (
    !saved || saved.resultSha256 !== source.resultSha256 ||
    createHash("sha256").update(JSON.stringify(saved.runs)).digest("hex") !==
      source.resultSha256
  ) return;
  const candidate = nativeWorkflowControlCandidate(
    saved,
    source.workflowRunNumber,
  );
  if (candidate) return { assetId: task.nodeId, saved, candidate };
}

/** Reopen a graph citation for the exact case revision and optional assigned asset. */
export function readNativeWorkflowGraphEvidence(
  path: string,
  revision: number,
  nodeId: string,
  assignedAsset?: string,
) {
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  const node = snapshot?.nodes.find(({ id }) => id === nodeId);
  if (node?.kind !== "evidence" || !node.nativeWorkflowSource) return;
  const source = node.nativeWorkflowSource;
  if (
    source.revision > revision ||
    readSentinelRunIdForRevision(path, revision) !== source.runId
  ) return;
  const store = openSentinelAdaptiveStore(
    join(dirname(path), "sentinel-adaptive.db"),
  );
  try {
    const citation = readNativeWorkflowCitation(store, source);
    if (
      !citation || (assignedAsset && citation.assetId !== assignedAsset) ||
      !snapshot?.edges.some(({ from, to, relation }) =>
        from === nodeId && to === citation.assetId && relation === "observed_on"
      ) ||
      citation.saved.observedAt !== node.controlVerification?.observedAt ||
      citation.candidate.outcome !== node.controlVerification.outcome
    ) return;
    return { ...citation, source };
  } finally {
    store.close();
  }
}
