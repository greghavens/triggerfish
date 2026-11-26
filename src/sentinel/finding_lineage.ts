/** Page the authorized retained evidence path of one exact graph finding. */
import { createHash } from "node:crypto";
import { redactCredentialText } from "../core/logger/redactor.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
} from "./assessment_store.ts";
import { sentinelOperatingConstraintsAllow } from "./operating_constraints.ts";

export function readSentinelFindingLineage(
  path: string,
  revision: number,
  findingId: string,
  limit: number,
  cursor?: string,
) {
  const state = readSentinelAssessmentRevision(path, revision);
  const snapshot = state?.result?.sharedGraph.snapshot;
  const runId = readSentinelRunIdForRevision(path, revision);
  if (!snapshot || !runId) return;
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const finding = nodes.get(findingId);
  if (
    finding?.kind !== "finding" || redactCredentialText(findingId) !== findingId
  ) return;

  const policies = [
    readSentinelOperatingConstraints(path, runId, revision)?.constraints,
    readSentinelOperatingConstraints(path, runId)?.constraints,
  ];
  const canRead = (
    kind: "review_finding" | "review_evidence",
    nodeId: string,
  ) =>
    policies.every((policy) =>
      sentinelOperatingConstraintsAllow(policy, { kind, nodeId }, snapshot)
    );
  if (!canRead("review_finding", findingId)) return;

  const incoming = new Map<string, typeof snapshot.edges[number][]>();
  for (const edge of snapshot.edges) {
    const edges = incoming.get(edge.to);
    if (redactCredentialText(edge.from) !== edge.from) continue;
    if (edges) edges.push(edge);
    else incoming.set(edge.to, [edge]);
  }
  const controls = new Set<string>();
  for (const { from, relation } of incoming.get(findingId) ?? []) {
    if (
      relation === "mitigates" &&
      policies.every((policy) =>
        !policy?.deniedKinds.includes("review_evidence")
      )
    ) controls.add(from);
  }
  if (policies.some((policy) => policy?.allowedAssetIds !== undefined)) {
    for (const { from, to, relation } of snapshot.edges) {
      if (
        relation === "mitigates" && controls.has(from) &&
        !canRead("review_finding", to)
      ) controls.delete(from);
    }
  }
  const evidence = new Set<string>();
  for (const target of [findingId, ...controls]) {
    for (const { from, relation } of incoming.get(target) ?? []) {
      if (
        (relation === "supports" || relation === "verifies") &&
        canRead("review_evidence", from)
      ) evidence.add(from);
    }
  }
  const assets = new Set<string>();
  for (const { from, to, relation } of snapshot.edges) {
    if (
      ((relation === "affects" && from === findingId) ||
        (relation === "observed_on" && evidence.has(from))) &&
      redactCredentialText(to) === to && canRead("review_evidence", to)
    ) assets.add(to);
  }
  const edges = snapshot.edges.filter(({ from, to, relation }) =>
    (relation === "supports" && evidence.has(from) && to === findingId) ||
    (relation === "mitigates" && controls.has(from) && to === findingId) ||
    (relation === "verifies" && evidence.has(from) && controls.has(to)) ||
    (relation === "affects" && from === findingId && assets.has(to)) ||
    (relation === "observed_on" && evidence.has(from) && assets.has(to))
  );
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, revision, findingId, edges, policies]))
    .digest("hex");
  const match = cursor &&
    /^finding-lineage:([a-f0-9]{64}):([1-9][0-9]{0,6})$/.exec(cursor);
  const offset = match ? Number(match[2]) : 0;
  if (
    cursor !== undefined &&
    (!match || match[1] !== digest || offset >= edges.length)
  ) {
    return;
  }

  const page = edges.slice(offset, offset + limit);
  const pageNodes = new Set([
    findingId,
    ...page.flatMap(({ from, to }) => [from, to]),
  ]);
  return {
    runId,
    revision,
    findingId,
    lineageDigest: digest,
    nodes: [...pageNodes].map((id) => {
      const node = nodes.get(id)!;
      return {
        id,
        kind: node.kind,
        label: redactCredentialText(node.label).slice(0, 120),
      };
    }),
    edges: page,
    nextCursor: offset + page.length < edges.length
      ? `finding-lineage:${digest}:${offset + page.length}`
      : null,
  };
}
