import { createHash } from "node:crypto";
import type { openSentinelAdaptiveStore } from "./adaptive_store.ts";
import { readSentinelGitHubWorkflowReadReceipt } from "./assessment_store.ts";
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
