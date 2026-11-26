import { createHash } from "node:crypto";
import { dirname, join } from "@std/path";
import { redactCredentialText } from "../core/logger/redactor.ts";
import { openSentinelAdaptiveStore } from "../sentinel/adaptive_store.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraints,
  readSentinelOperatingConstraintsForRevision,
  readSentinelRunIdForRevision,
} from "../sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import {
  type SentinelLinkedCaseSource,
  type SentinelLinkedWorkerReview,
} from "../sentinel/linked_case_sources.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import { mappedArchivedSentinelAsset } from "../sentinel/shared_inventory.ts";
import type { loadSentinelGraph } from "../sentinel/graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;

export function readLocalSentinelReview(
  path: string,
  source: SentinelLinkedCaseSource,
  taskId: string,
) {
  try {
    const revision = source.revision;
    const snapshot = readSentinelAssessmentRevision(path, revision)?.result
      .sharedGraph.snapshot;
    if (
      !snapshot || readSentinelRunIdForRevision(path, revision) !== source.runId
    ) return;
    const storePath = join(dirname(path), "sentinel-adaptive.db");
    if (!Deno.lstatSync(storePath).isFile) return;
    const store = openSentinelAdaptiveStore(storePath);
    try {
      const mapping = store.forEvidence(revision);
      if (mapping?.goal.id !== source.runId) return;
      const task = store.list(mapping.revision).find(({ id }) => id === taskId);
      if (
        !task || task.status !== "completed" ||
        (task.kind !== "trace" && task.kind !== "impact") ||
        !task.nodeId || task.carriedFrom || task.reviewedFrom ||
        task.prerequisites.length || task.evidenceIds.length ||
        task.factSatisfaction ||
        (task.plannerRound &&
          Object.keys(task.plannerRound).some((key) =>
            !["identity", "attempt"].includes(key)
          ))
      ) return;
      const assetId = task.nodeId;
      if (
        !snapshot.nodes.some(({ id, kind }) =>
          id === assetId && kind === "asset"
        )
      ) return;
      const policies = [
        readSentinelOperatingConstraintsForRevision(path, revision)
          ?.constraints,
        readSentinelOperatingConstraints(path, source.runId)?.constraints,
      ];
      if (
        policies.some((policy) =>
          !sentinelOperatingConstraintsAllow(policy, {
            kind: "review_evidence",
            nodeId: assetId,
          }, snapshot)
        )
      ) return;
      if (
        !store.modelReviewStates(mapping.revision).some(
          (review) =>
            review.taskId === taskId && review.status === "completed" &&
            !review.lastSteering,
        )
      ) return;
      const review = store.modelReviewNotes(mapping.revision).find((row) =>
        row.taskId === taskId
      );
      if (
        !review?.summary || review.summary.length > 1500 ||
        redactCredentialText(review.summary) !== review.summary ||
        review.steps.some(({ tool, outcome }) =>
          tool !== "sentinel_assigned_target" || outcome !== "returned"
        )
      ) return;
      const binding = {
        taskId,
        assetId,
        summarySha256: createHash("sha256").update(review.summary).digest(
          "hex",
        ),
      } satisfies SentinelLinkedWorkerReview;
      return { snapshot, binding, summary: review.summary };
    } finally {
      store.close();
    }
  } catch {
    return;
  }
}

export function readLinkedSentinelWorkerReview(
  baseDir: string,
  sources: readonly SentinelLinkedCaseSource[],
  local: Snapshot,
  query: { sourceCase: string; taskId: string; asset?: string },
) {
  const source = sources.find(({ caseId }) => caseId === query.sourceCase);
  const pinned = source?.workerReviews?.find(({ taskId }) =>
    taskId === query.taskId
  );
  if (!source || !pinned) return;
  const value = readLocalSentinelReview(
    resolveSentinelCasePath(baseDir, source.caseId),
    source,
    pinned.taskId,
  );
  if (
    !value || value.binding.assetId !== pinned.assetId ||
    value.binding.summarySha256 !== pinned.summarySha256
  ) return;
  const asset = mappedArchivedSentinelAsset(
    local,
    value.snapshot,
    pinned.assetId,
  );
  if (!asset || (query.asset !== undefined && asset !== query.asset)) return;
  return {
    reference: {
      sourceCase: source.caseId,
      sourceRunId: source.runId,
      sourceRevision: source.revision,
      sourceTaskId: pinned.taskId,
      sourceAssetId: pinned.assetId,
      asset,
      summarySha256: pinned.summarySha256,
    },
    summary: value.summary,
  };
}
