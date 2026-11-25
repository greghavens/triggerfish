/** Verify exact defensive graph relationships delivered to an assigned worker. */
import { createHash } from "node:crypto";
import type { AdaptiveTaskKind } from "./adaptive_store.ts";
import { isSentinelCaseId } from "./cases.ts";
import { loadSentinelGraph } from "./graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type Relationship = Snapshot["edges"][number];

export interface SentinelAssignedRelationshipScope {
  readonly caseId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
  readonly taskId: string;
  readonly taskKind: AdaptiveTaskKind;
  readonly targetId: string;
  readonly snapshot: Snapshot;
}

export interface SentinelAssignedRelationshipFact {
  readonly caseId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
  readonly taskId: string;
  readonly targetId: string;
  readonly snapshotDigest: string;
  readonly resultSha256: string;
  readonly relationship: Relationship;
}

const maxResponseChars = 7000;
const maxDeliveredNeighbors = 8;
const adaptiveTaskId = /^adaptive:[a-f0-9]{64}$/;
const runIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 4096 &&
    !value.includes("\0");
}

function edgeKey(from: string, relation: string, to: string): string {
  return JSON.stringify([from, relation, to]);
}

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function deliveredNode(
  value: unknown,
  nodes: ReadonlyMap<string, Snapshot["nodes"][number]>,
) {
  const node = object(value);
  return identifier(node?.id) && nodes.get(node.id)?.kind === node.kind
    ? node.id
    : undefined;
}

/** Call only with the actual successful `sentinel_assigned_target` response after POST policy. */
export function extractSentinelAssignedRelationshipFacts(
  resultText: string,
  scope: SentinelAssignedRelationshipScope,
): SentinelAssignedRelationshipFact[] {
  const { caseId, runId, evidenceRevision, taskId, taskKind, targetId } = scope;
  if (
    typeof resultText !== "string" || resultText.length > maxResponseChars ||
    !isSentinelCaseId(caseId) || !runIdPattern.test(runId) ||
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
    !adaptiveTaskId.test(taskId) || !identifier(targetId)
  ) return [];
  try {
    const response = object(JSON.parse(resultText));
    if (
      response?.taskId !== taskId || response.kind !== taskKind ||
      response.revision !== evidenceRevision ||
      !Array.isArray(response.linked) ||
      response.linked.length > maxDeliveredNeighbors ||
      !Array.isArray(response.relationships) ||
      typeof response.truncated !== "boolean"
    ) return [];
    const snapshot = loadSentinelGraph(scope.snapshot).snapshot();
    const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    if (deliveredNode(response.target, nodes) !== targetId) return [];
    const delivered = new Set([targetId]);
    for (const node of response.linked) {
      const id = deliveredNode(node, nodes);
      if (!id || delivered.has(id)) return [];
      delivered.add(id);
    }
    const direct = new Map(
      snapshot.edges.flatMap((edge) =>
        edge.from === targetId || edge.to === targetId
          ? [[edgeKey(edge.from, edge.relation, edge.to), edge] as const]
          : []
      ),
    );
    const selected = new Map<string, Relationship>();
    for (const item of response.relationships) {
      const edge = object(item);
      if (
        !edge || Object.keys(edge).length !== 3 ||
        !identifier(edge.from) || !identifier(edge.to) ||
        typeof edge.relation !== "string" ||
        !delivered.has(edge.from) || !delivered.has(edge.to)
      ) return [];
      const key = edgeKey(edge.from, edge.relation, edge.to);
      const saved = direct.get(key);
      if (!saved || selected.has(key)) return [];
      selected.set(key, saved);
    }
    if (
      response.relationshipCount !== direct.size ||
      !Number.isSafeInteger(response.linkedCount) ||
      (response.linkedCount as number) < delivered.size - 1 ||
      response.truncated !== (
          selected.size < direct.size ||
          delivered.size - 1 < Number(response.linkedCount)
        )
    ) return [];
    const snapshotDigest = digest(JSON.stringify(snapshot));
    const resultSha256 = digest(resultText);
    return [...selected.values()].map((relationship) => ({
      caseId,
      runId,
      evidenceRevision,
      taskId,
      targetId,
      snapshotDigest,
      resultSha256,
      relationship,
    }));
  } catch {
    return [];
  }
}

/** Match both immutable source digests and the exact delivered, archived relation. */
export function verifySentinelAssignedRelationshipFact(
  fact: SentinelAssignedRelationshipFact,
  resultText: string,
  scope: SentinelAssignedRelationshipScope,
): boolean {
  return extractSentinelAssignedRelationshipFacts(resultText, scope).some((
    candidate,
  ) =>
    candidate.caseId === fact.caseId && candidate.runId === fact.runId &&
    candidate.evidenceRevision === fact.evidenceRevision &&
    candidate.taskId === fact.taskId &&
    candidate.targetId === fact.targetId &&
    candidate.snapshotDigest === fact.snapshotDigest &&
    candidate.resultSha256 === fact.resultSha256 &&
    candidate.relationship.from === fact.relationship.from &&
    candidate.relationship.to === fact.relationship.to &&
    candidate.relationship.relation === fact.relationship.relation
  );
}
