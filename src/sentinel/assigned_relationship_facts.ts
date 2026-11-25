/** Verify exact defensive graph relationships delivered to an assigned worker. */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { AdaptiveTaskKind } from "./adaptive_store.ts";
import { isSentinelCaseId } from "./cases.ts";
import { type ControlVerification, loadSentinelGraph } from "./graph.ts";

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
  readonly controlVerification?: ControlVerification;
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

/** Edges from controls to findings delivered for the assigned asset. */
export function assignedMitigationEdges(
  snapshot: Snapshot,
  targetId: string,
  direct: readonly Relationship[] = snapshot.edges,
) {
  const findings = new Set(
    direct.flatMap((edge) =>
      edge.relation === "affects" && edge.to === targetId ? [edge.from] : []
    ),
  );
  return snapshot.edges.filter((edge) =>
    edge.relation === "mitigates" && findings.has(edge.to)
  );
}

/** Controls that mitigate a finding linked to the assigned asset. */
export function assignedMitigatingControls(
  snapshot: Snapshot,
  targetId: string,
  direct: readonly Relationship[] = snapshot.edges,
) {
  const byControl = new Map<string, string>();
  for (
    const { from, to } of assignedMitigationEdges(snapshot, targetId, direct)
  ) {
    if (!byControl.has(from)) byControl.set(from, to);
  }
  return byControl;
}

/** Include only checks linked to the assigned asset by both its evidence and finding. */
export function assignedControlChecks(
  snapshot: Snapshot,
  targetId: string,
  direct: readonly Relationship[],
) {
  const evidence = new Set(
    direct.flatMap((edge) =>
      edge.relation === "observed_on" && edge.to === targetId ? [edge.from] : []
    ),
  );
  if (!evidence.size) return [];
  const byControl = assignedMitigatingControls(snapshot, targetId, direct);
  if (!byControl.size) return [];
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return snapshot.edges.flatMap((edge) => {
    if (edge.relation !== "verifies" || !evidence.has(edge.from)) return [];
    const findingId = byControl.get(edge.to);
    const source = nodes.get(edge.from);
    if (
      !findingId || source?.kind !== "evidence" || !source.controlVerification
    ) {
      return [];
    }
    return [{
      relationship: edge,
      findingId,
      controlVerification: source.controlVerification,
    }];
  });
}

/** Prefer the newest observed check. Conflicting same-time checks fail closed. */
export function latestAssignedControlCheck(
  snapshot: Snapshot,
  targetId: string,
  controlId: string,
  timestamp: number,
) {
  return assignedControlChecks(snapshot, targetId, snapshot.edges)
    .filter(({ relationship, controlVerification }) =>
      relationship.to === controlId &&
      Date.parse(controlVerification.observedAt) <= timestamp
    )
    .sort((a, b) =>
      Date.parse(b.controlVerification.observedAt) -
        Date.parse(a.controlVerification.observedAt) ||
      Number(b.controlVerification.outcome === "fail") -
        Number(a.controlVerification.outcome === "fail") ||
      Date.parse(a.controlVerification.validUntil) -
        Date.parse(b.controlVerification.validUntil) ||
      a.relationship.from.localeCompare(b.relationship.from)
    )[0];
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
    if (response.supportingRelationships !== undefined) {
      if (!Array.isArray(response.supportingRelationships)) return [];
      const neighbors = new Set(
        [...selected.values()].map((edge) =>
          edge.from === targetId ? edge.to : edge.from
        ),
      );
      neighbors.delete(targetId);
      const supported = new Map(
        snapshot.edges.flatMap((edge) =>
          edge.relation === "supports" && neighbors.has(edge.from) &&
            neighbors.has(edge.to)
            ? [[edgeKey(edge.from, edge.relation, edge.to), edge] as const]
            : []
        ),
      );
      for (const item of response.supportingRelationships) {
        const edge = object(item);
        if (
          !edge || Object.keys(edge).length !== 3 ||
          !identifier(edge.from) || !identifier(edge.to) ||
          edge.relation !== "supports"
        ) return [];
        const key = edgeKey(edge.from, edge.relation, edge.to);
        const saved = supported.get(key);
        if (!saved || selected.has(key)) return [];
        selected.set(key, saved);
      }
    }
    if (response.mitigationRelationships !== undefined) {
      if (!Array.isArray(response.mitigationRelationships)) return [];
      const candidates = assignedMitigationEdges(snapshot, targetId, [
        ...selected.values(),
      ]);
      for (const item of response.mitigationRelationships) {
        const edge = candidates.find((candidate) =>
          isDeepStrictEqual(candidate, item)
        );
        if (!edge) return [];
        const key = edgeKey(edge.from, edge.relation, edge.to);
        if (selected.has(key)) return [];
        selected.set(key, edge);
      }
    }
    const checks = new Map<string, ControlVerification>();
    if (response.controlChecks !== undefined) {
      if (!Array.isArray(response.controlChecks)) return [];
      const candidates = assignedControlChecks(
        snapshot,
        targetId,
        [...selected.values()],
      );
      for (const check of response.controlChecks) {
        const candidate = candidates.find((item) =>
          isDeepStrictEqual(item, check)
        );
        if (!candidate) return [];
        const edge = candidate.relationship;
        const key = edgeKey(edge.from, edge.relation, edge.to);
        if (selected.has(key)) return [];
        selected.set(key, edge);
        checks.set(key, candidate.controlVerification);
      }
    }
    const snapshotDigest = digest(JSON.stringify(snapshot));
    const resultSha256 = digest(resultText);
    return [...selected].map(([key, relationship]) => ({
      caseId,
      runId,
      evidenceRevision,
      taskId,
      targetId,
      snapshotDigest,
      resultSha256,
      relationship,
      ...(checks.has(key) && { controlVerification: checks.get(key)! }),
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
    candidate.relationship.relation === fact.relationship.relation &&
    isDeepStrictEqual(candidate.controlVerification, fact.controlVerification)
  );
}
