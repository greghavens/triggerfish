import { dirname, join } from "@std/path";
import { createHash } from "node:crypto";
import {
  readSentinelAssessment,
  readSentinelOperatingConstraints,
} from "../sentinel/assessment_store.ts";
import { readAdaptiveWorkerNarrative } from "../sentinel/adaptive_store.ts";
import { SENTINEL_PROVENANCE_NODE_READ } from "../sentinel/worker_goal_recovery.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import { readProjectedSentinelTrafficReceipt } from "./sentinel_traffic_tool.ts";

export function currentWorkerNarrativeScope(
  path: string,
  runId: string,
  revision: number,
) {
  const state = readSentinelAssessment(path);
  const graph = state?.result?.sharedGraph.snapshot;
  const location = locateSentinelCase(path);
  if (
    !state?.active || state.paused || state.revision !== revision ||
    state.plan.runId !== runId || !graph || !location
  ) return;
  const constraints = readSentinelOperatingConstraints(path, runId);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const links = new Map<string, Set<string>>();
  const allowed = new Map<string, boolean>();
  function canRead(nodeId: string) {
    let resolved = allowed.get(nodeId);
    if (resolved === undefined) {
      resolved = sentinelOperatingConstraintsAllow(constraints?.constraints, {
        kind: "review_evidence",
        nodeId,
      }, graph);
      allowed.set(nodeId, resolved);
    }
    return resolved;
  }
  for (const { from, to } of graph.edges) {
    const asset = nodes.get(from)?.kind === "asset" ? from : to;
    const evidence = asset === from ? to : from;
    if (
      nodes.get(asset)?.kind !== "asset" ||
      nodes.get(evidence)?.kind !== "evidence"
    ) continue;
    let owned = links.get(asset);
    if (!owned) links.set(asset, owned = new Set());
    owned.add(evidence);
  }
  return (asset: string, evidenceId: string, trafficDigest?: string) => {
    const evidence = nodes.get(evidenceId);
    if (
      evidence?.kind !== "evidence" || evidence.executionSource ||
      evidence.nativeWorkflowSource || !links.get(asset)?.has(evidenceId) ||
      !canRead(asset) || !canRead(evidenceId)
    ) return;
    const traffic = trafficDigest
      ? readProjectedSentinelTrafficReceipt(
        path,
        location.caseId,
        revision,
        { evidenceId, digest: trafficDigest },
        asset,
      )
      : undefined;
    if (trafficDigest && !traffic) return;
    return {
      caseId: location.caseId,
      runId,
      evidence,
      ...(traffic && { traffic }),
      constraintsVersion: constraints?.version,
      constraintsDigest: constraints?.digest,
    };
  };
}

export function currentWorkerNarrativeEvidence(
  path: string,
  runId: string,
  revision: number,
  asset: string,
  evidenceId: string,
  trafficDigest?: string,
) {
  return currentWorkerNarrativeScope(path, runId, revision)?.(
    asset,
    evidenceId,
    trafficDigest,
  );
}

export function currentWorkerNarrative(
  path: string,
  runId: string,
  revision: number,
  id: string,
  asset: string,
) {
  const record = readAdaptiveWorkerNarrative(
    join(dirname(path), "sentinel-adaptive.db"),
    runId,
    revision,
    { id },
  );
  if (record?.targetId !== asset || record.evidenceRevision !== revision) {
    return;
  }
  const source = currentWorkerNarrativeEvidence(
    path,
    runId,
    revision,
    asset,
    record.receipt.evidenceId,
    record.receipt.trafficDigest,
  );
  if (
    !source || (source.traffic &&
      createHash("sha256").update(JSON.stringify(source.traffic)).digest(
          "hex",
        ) !==
        record.receipt.sourceSha256)
  ) return;
  return record;
}

export function workerNarrativeEvidenceCall(
  evidenceId: string,
  revision: number,
) {
  return {
    name: SENTINEL_PROVENANCE_NODE_READ,
    args: { node: "evidence:" + evidenceId, revision },
  };
}
