/** One reviewed local investigation on an already completed assessment. */
import { createHash } from "node:crypto";
import { executeSentinelTask } from "./adaptive_planner.ts";
import {
  type AdaptiveFindingFollowup,
  sentinelAdaptiveTaskId,
} from "./adaptive_store.ts";
import type { readSentinelAssessment } from "./assessment_store.ts";
import {
  type SentinelOperatingConstraints,
  sentinelOperatingConstraintsAllow,
} from "./operating_constraints.ts";

export interface CompletedSentinelGraphFollowupRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
  readonly kind: "trace" | "impact";
  readonly nodeId: string;
  readonly finding?: Pick<AdaptiveFindingFollowup, "findingId" | "note">;
}

export interface CompletedSentinelGraphFollowupBinding
  extends Omit<CompletedSentinelGraphFollowupRequest, "finding"> {
  readonly findingFollowup?: AdaptiveFindingFollowup;
  readonly graphSha256: string;
  readonly completionSha256: string;
  readonly constraintsVersion: number;
}

export interface CompletedSentinelGraphFollowupReceipt
  extends CompletedSentinelGraphFollowupBinding {
  readonly completedAt: string;
  readonly observation:
    | ReturnType<typeof executeSentinelTask>
    | {
      readonly resultSha256: string;
      readonly relatedNodeIds: readonly string[];
    };
}

/** Use the same deterministic graph reader as a normal scoped worker. */
export function executeCompletedSentinelGraphFollowup(
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
  binding: CompletedSentinelGraphFollowupBinding,
  constraints?: SentinelOperatingConstraints,
): CompletedSentinelGraphFollowupReceipt["observation"] {
  const revision = binding.graphSha256;
  const task = {
    kind: binding.kind,
    nodeId: binding.nodeId,
    depth: 1,
  } as const;
  const result = state.result;
  const snapshot = result?.sharedGraph.snapshot;
  let scoped = state;
  if (result && snapshot && constraints?.allowedAssetIds !== undefined) {
    const nodes = snapshot.nodes.filter(({ id }) =>
      sentinelOperatingConstraintsAllow(constraints, {
        kind: binding.kind,
        nodeId: id,
      }, snapshot)
    );
    const allowed = new Set(nodes.map(({ id }) => id));
    const edges = snapshot.edges.filter(({ from, to }) =>
      allowed.has(from) && allowed.has(to)
    );
    scoped = {
      ...state,
      result: {
        ...result,
        sharedGraph: {
          ...result.sharedGraph,
          snapshot: { ...snapshot, nodes, edges },
        },
      },
    };
  }
  const observation = executeSentinelTask(scoped, {
    ...task,
    id: sentinelAdaptiveTaskId(revision, task),
    revision,
    status: "running",
    prerequisites: [],
    evidenceIds: [],
    attempts: 1,
  });
  const serialized = JSON.stringify(observation);
  if (serialized.length <= 4500) return observation;
  return {
    relatedNodeIds: Array.isArray(observation.relatedNodeIds)
      ? observation.relatedNodeIds.filter((id): id is string =>
        typeof id === "string"
      ).slice(0, 12)
      : [],
    resultSha256: createHash("sha256").update(serialized).digest("hex"),
  };
}
