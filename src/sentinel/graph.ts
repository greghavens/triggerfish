/** A read-only graph of imported defensive observations. */

import {
  alternateSentinelRelationshipPaths,
  type SentinelPathDirection,
} from "./path_search.ts";
import { isSentinelCaseId } from "./cases.ts";
import {
  deriveSentinelAssetParents,
  type SentinelAssetType,
  sentinelAssetTypes,
} from "./asset_hierarchy.ts";

interface RelationshipSource {
  readonly caseId: string;
  readonly from: string;
  readonly to: string;
  readonly snapshotDigest?: string;
}

export interface SentinelExecutionEvidenceSource {
  readonly role: "delegated" | "scheduled";
  readonly runId: string;
  readonly ordinal: number;
  readonly receiptId: string;
  readonly resultSha256: string;
  readonly recordedAt?: string;
}

export interface SentinelNativeWorkflowSource {
  readonly runId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly stepIndex: number;
  readonly workflowRunNumber: number;
  readonly resultSha256: string;
}

function readNativeWorkflowSource(
  value: unknown,
): SentinelNativeWorkflowSource {
  const {
    runId,
    revision,
    taskId,
    stepIndex,
    workflowRunNumber,
    resultSha256,
    ...extra
  } = record(value);
  if (
    typeof runId !== "string" || !/^[a-f0-9-]{36}$/.test(runId) ||
    typeof taskId !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof stepIndex !== "number" || !Number.isSafeInteger(stepIndex) ||
    stepIndex < 0 || stepIndex >= 16 ||
    typeof workflowRunNumber !== "number" ||
    !Number.isSafeInteger(workflowRunNumber) || workflowRunNumber < 1 ||
    typeof resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(resultSha256) ||
    Object.keys(extra).length
  ) throw new Error("Invalid Sentinel native workflow source");
  return {
    runId,
    revision,
    taskId,
    stepIndex,
    workflowRunNumber,
    resultSha256,
  };
}

function readExecutionEvidenceSource(
  value: unknown,
): SentinelExecutionEvidenceSource {
  const {
    role,
    runId,
    ordinal,
    receiptId,
    resultSha256,
    recordedAt,
    ...extra
  } = record(
    value,
  );
  if (
    (role !== "delegated" && role !== "scheduled") ||
    typeof runId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(runId) ||
    typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    typeof receiptId !== "string" ||
    !/^execution-trace:[a-f0-9]{64}$/.test(receiptId) ||
    typeof resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(resultSha256) ||
    (recordedAt !== undefined &&
      (typeof recordedAt !== "string" ||
        !Number.isFinite(Date.parse(recordedAt)) ||
        new Date(recordedAt).toISOString() !== recordedAt)) ||
    Object.keys(extra).length
  ) throw new Error("Invalid Sentinel execution evidence source");
  return {
    role,
    runId,
    ordinal,
    receiptId,
    resultSha256,
    ...(recordedAt && { recordedAt }),
  };
}

export interface SentinelFindingAnalyst {
  readonly operatorScope: "owner";
  readonly planner?: {
    readonly identity: string;
    readonly attempt: number;
    readonly approvalId: string;
  };
}

/** Normalize the recorded owner attribution for an owner or reviewed planner finding. */
export function readSentinelFindingAnalyst(
  value: unknown,
): SentinelFindingAnalyst {
  const { operatorScope, planner, ...extra } = record(value);
  if (operatorScope !== "owner" || Object.keys(extra).length) {
    throw new Error("Invalid Sentinel analyst finding attribution");
  }
  if (planner === undefined) return { operatorScope };
  const { identity, attempt, approvalId, ...remaining } = record(planner);
  if (
    typeof identity !== "string" || identity.length > 224 ||
    !/^[a-f0-9]{64}(?::[A-Za-z0-9:-]+)?$/.test(identity) ||
    typeof attempt !== "number" || !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    typeof approvalId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(approvalId) ||
    Object.keys(remaining).length
  ) throw new Error("Invalid Sentinel analyst finding attribution");
  return { operatorScope, planner: { identity, attempt, approvalId } };
}

/** Exact lineage for an operator-approved local finding publication. */
export type SentinelPublishedFindingSource =
  & {
    readonly caseId: string;
    readonly runId: string;
    readonly revision: number;
    readonly receiptId: string;
    readonly evidenceId: string;
    readonly snapshotDigest: string;
    readonly reportVersion: number;
  }
  & (
    | { readonly taskId: string; readonly analyst?: never }
    | { readonly analyst: SentinelFindingAnalyst; readonly taskId?: never }
  );

export function readSentinelPublishedFindingSource(
  value: unknown,
): SentinelPublishedFindingSource {
  const {
    caseId,
    runId,
    revision,
    taskId,
    analyst,
    receiptId,
    evidenceId,
    snapshotDigest,
    reportVersion,
    ...extra
  } = record(value);
  if (
    typeof caseId !== "string" || !isSentinelCaseId(caseId) ||
    typeof runId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId) ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (analyst === undefined
      ? typeof taskId !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(taskId)
      : taskId !== undefined) ||
    typeof receiptId !== "string" ||
    !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
    typeof evidenceId !== "string" || !evidenceId.trim() ||
    evidenceId.length > 4096 || evidenceId.includes("\0") ||
    typeof snapshotDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshotDigest) ||
    typeof reportVersion !== "number" || !Number.isSafeInteger(reportVersion) ||
    reportVersion < 1 ||
    Object.keys(extra).length
  ) throw new Error("Invalid published Sentinel finding lineage");
  return {
    caseId,
    runId,
    revision,
    ...(analyst === undefined
      ? { taskId: taskId as string }
      : { analyst: readSentinelFindingAnalyst(analyst) }),
    receiptId,
    evidenceId,
    snapshotDigest,
    reportVersion,
  };
}

const verificationOutcomes = ["pass", "fail"] as const;
type VerificationOutcome = typeof verificationOutcomes[number];

export interface ControlVerification {
  readonly outcome: VerificationOutcome;
  readonly observedAt: string;
  readonly validUntil: string;
}

interface LinkedControlCoverage {
  readonly controlId: string;
  readonly status: VerificationOutcome | "stale" | "unverified";
  readonly evidenceId?: string;
  readonly verification?: ControlVerification;
}

const kinds = ["asset", "finding", "control", "evidence"] as const;
export const sentinelFindingSeverities = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;
export const sentinelFindingDispositions = [
  "open",
  "confirmed",
  "resolved",
  "dismissed",
] as const;
type Kind = typeof kinds[number];
type Severity = typeof sentinelFindingSeverities[number];

interface NodeFields {
  readonly id: string;
  readonly label: string;
}

export type GraphNode =
  & NodeFields
  & (
    | {
      readonly kind: "finding";
      readonly severity: Severity;
      readonly workerFindingSource?: SentinelPublishedFindingSource;
    }
    | {
      readonly kind: "asset";
      readonly aliases?: readonly string[];
      readonly assetType?: SentinelAssetType;
      readonly parentId?: string;
      readonly organization?: { readonly id: string; readonly label: string };
    }
    | {
      readonly kind: "evidence";
      readonly relationshipSources?: readonly RelationshipSource[];
      readonly controlVerification?: ControlVerification;
      readonly executionSource?: SentinelExecutionEvidenceSource;
      readonly nativeWorkflowSource?: SentinelNativeWorkflowSource;
    }
    | { readonly kind: "control" }
  );

/** Remove typed references to endpoints outside an authorized inventory view. */
export function scopeSentinelInventoryReferences<T extends GraphNode>(
  node: T,
  allow: (id: string) => boolean,
  caseId?: string,
): T {
  if (node.kind === "asset" && node.parentId && !allow(node.parentId)) {
    return { ...node, parentId: undefined };
  }
  if (node.kind === "evidence" && node.relationshipSources) {
    const sources = node.relationshipSources.filter((source) =>
      source.caseId === caseId && allow(source.from) && allow(source.to)
    );
    if (sources.length !== node.relationshipSources.length) {
      return {
        ...node,
        relationshipSources: sources.length ? sources : undefined,
      };
    }
  }
  return node;
}

const relationships = {
  affects: ["finding", "asset"],
  mitigates: ["control", "finding"],
  supports: ["evidence", "finding"],
  verifies: ["evidence", "control"],
  observed_on: ["evidence", "asset"],
  resolved_to: ["asset", "asset"],
  uses_hostname: ["asset", "asset"],
  depends_on: ["asset", "asset"],
  contained_in: ["asset", "asset"],
} as const;

interface Edge {
  readonly from: string;
  readonly to: string;
  readonly relation: keyof typeof relationships;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a Sentinel object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected a nonempty string for ${field}`);
  }
  return value;
}

function member<const T extends string>(
  choices: readonly T[],
  value: unknown,
  field: string,
): T {
  const match = choices.find((choice) => choice === value);
  if (match === undefined) throw new Error(`Invalid Sentinel ${field}`);
  return match;
}

function verificationTime(value: unknown): string {
  const match = typeof value === "string"
    ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value)
    : null;
  if (!match) throw new Error("Expected a Sentinel verification UTC timestamp");
  const normalized = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const time = Date.parse(normalized);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== normalized) {
    throw new Error("Invalid Sentinel verification calendar timestamp");
  }
  return normalized;
}

export function readControlVerification(value: unknown): ControlVerification {
  const raw = record(value);
  const outcome = member(verificationOutcomes, raw.outcome, "control outcome");
  const observedAt = verificationTime(raw.observedAt);
  const validUntil = verificationTime(raw.validUntil);
  if (validUntil <= observedAt) {
    throw new Error(
      "Sentinel verification validity must end after observation",
    );
  }
  return Object.freeze({ outcome, observedAt, validUntil });
}

function parseNode(value: unknown): GraphNode {
  const raw = record(value);
  const id = string(raw.id, "node ID");
  const label = string(raw.label, "node label");
  const kind = member(kinds, raw.kind, "node kind");
  if (raw.organization !== undefined && kind !== "asset") {
    throw new Error("Sentinel organization belongs on an asset node");
  }
  if (raw.controlVerification !== undefined && kind !== "evidence") {
    throw new Error(
      "Sentinel control verification belongs on an evidence node",
    );
  }
  const controlVerification = raw.controlVerification === undefined
    ? undefined
    : readControlVerification(raw.controlVerification);
  if (raw.nativeWorkflowSource !== undefined) {
    if (
      kind !== "evidence" || !controlVerification ||
      raw.executionSource !== undefined || raw.relationshipSources !== undefined
    ) {
      throw new Error(
        "Native workflow evidence requires a control verification",
      );
    }
    return {
      id,
      kind,
      label,
      controlVerification,
      nativeWorkflowSource: readNativeWorkflowSource(raw.nativeWorkflowSource),
    };
  }
  if (kind === "finding") {
    const workerFindingSource = raw.workerFindingSource === undefined
      ? undefined
      : readSentinelPublishedFindingSource(raw.workerFindingSource);
    if (workerFindingSource && workerFindingSource.receiptId !== id) {
      throw new Error(
        "Published Sentinel finding must use its exact receipt identifier",
      );
    }
    return {
      id,
      kind,
      label,
      severity: member(sentinelFindingSeverities, raw.severity, "severity"),
      ...(workerFindingSource && { workerFindingSource }),
    };
  }
  if (kind === "asset") {
    let organization;
    if (raw.organization !== undefined) {
      const fields = record(raw.organization);
      const id = string(fields.id, "organization ID");
      const label = string(fields.label, "organization label");
      if (
        Object.keys(fields).length !== 2 || id.length > 256 ||
        label.length > 512 || id.includes("\0") || label.includes("\0")
      ) {
        throw new Error("Invalid Sentinel asset organization");
      }
      organization = Object.freeze({ id, label });
    }
    const assetType = raw.assetType === undefined
      ? undefined
      : member(sentinelAssetTypes, raw.assetType, "asset type");
    const parentId = raw.parentId === undefined
      ? undefined
      : string(raw.parentId, "asset parent ID");
    if (parentId !== undefined && parentId.length > 4096) {
      throw new Error("Invalid Sentinel asset parent ID");
    }
    const importedAliases = raw.aliases === undefined ? [] : raw.aliases;
    if (
      !Array.isArray(importedAliases) || importedAliases.length > 32 ||
      importedAliases.some((alias) =>
        typeof alias !== "string" || !alias.trim() || alias.length > 4096
      )
    ) {
      throw new Error("Invalid Sentinel asset aliases");
    }
    const aliases = [
      ...new Set(importedAliases.filter((alias) => alias !== id)),
    ]
      .sort();
    return {
      id,
      kind,
      label,
      ...(aliases.length && { aliases }),
      ...(assetType !== undefined && { assetType }),
      ...(parentId !== undefined && { parentId }),
      ...(organization && { organization }),
    };
  }
  if (raw.executionSource !== undefined) {
    const executionSource = readExecutionEvidenceSource(raw.executionSource);
    if (
      kind !== "evidence" ||
      (!controlVerification && !executionSource.recordedAt) ||
      (controlVerification && executionSource.recordedAt &&
        controlVerification.observedAt !== executionSource.recordedAt) ||
      raw.relationshipSources !== undefined
    ) {
      throw new Error("Execution evidence requires an exact observation time");
    }
    return {
      id,
      kind,
      label,
      ...(controlVerification && { controlVerification }),
      executionSource,
    };
  }
  if (kind === "evidence" && raw.relationshipSources !== undefined) {
    if (
      !Array.isArray(raw.relationshipSources) || !raw.relationshipSources.length
    ) {
      throw new Error("Invalid Sentinel relationship sources");
    }
    const cases = new Set<string>();
    const relationshipSources = raw.relationshipSources.map((value) => {
      const source = record(value);
      const caseId = string(source.caseId, "reporting case ID");
      if (!isSentinelCaseId(caseId) || cases.has(caseId)) {
        throw new Error("Invalid Sentinel reporting case ID");
      }
      cases.add(caseId);
      const digest = source.snapshotDigest;
      if (
        digest !== undefined &&
        (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
      ) {
        throw new Error("Invalid Sentinel source snapshot digest");
      }
      return {
        ...(typeof digest === "string" && { snapshotDigest: digest }),
        caseId,
        from: string(source.from, "reported source endpoint"),
        to: string(source.to, "reported destination endpoint"),
      };
    });
    return {
      id,
      kind,
      label,
      relationshipSources,
      ...(controlVerification && { controlVerification }),
    };
  }
  if (kind === "evidence" && controlVerification) {
    return { id, kind, label, controlVerification };
  }
  return { id, kind, label };
}

type Relation = keyof typeof relationships;
const relationNames = Object.keys(relationships) as Relation[];

export function isSentinelGraphRelation(value: unknown): value is Relation {
  return typeof value === "string" && Object.hasOwn(relationships, value);
}

interface Visit<E = Edge> {
  readonly id: string;
  readonly distance: number;
  readonly previous?: Visit<E>;
  readonly edge?: E;
}

function walk<E>(
  adjacency: ReadonlyMap<string, readonly E[]>,
  id: string,
  maxDepth: number,
  next: (edge: E, current: string) => string | undefined,
  destination?: string,
) {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error("Sentinel depth must be a nonnegative safe integer");
  }

  const visits: Visit<E>[] = [{ id, distance: 0 }];
  const seen = new Set([id]);
  for (const visit of visits) {
    if (visit.id === destination || visit.distance >= maxDepth) break;
    for (const edge of adjacency.get(visit.id) ?? []) {
      const neighbor = next(edge, visit.id);
      if (neighbor === undefined || seen.has(neighbor)) continue;
      seen.add(neighbor);
      visits.push({
        id: neighbor,
        distance: visit.distance + 1,
        previous: visit,
        edge,
      });
    }
  }
  return { visits, seen };
}

export type { SentinelPathDirection } from "./path_search.ts";

export function shortestSentinelRelationshipPath<
  N extends { readonly id: string },
  E extends {
    readonly from: string;
    readonly to: string;
    readonly relation: string;
  },
>(
  nodes: ReadonlyMap<string, N>,
  adjacency: ReadonlyMap<string, readonly E[]>,
  from: string,
  to: string,
  maxDepth: number,
  direction: SentinelPathDirection,
  relation?: string,
) {
  if (!nodes.has(from) || !nodes.has(to)) {
    throw new Error("Unknown Sentinel path endpoint");
  }
  const allowedRelations = relation === undefined
    ? undefined
    : new Set(relation.split(","));
  const { visits } = walk(adjacency, from, maxDepth, (edge, current) => {
    if (allowedRelations && !allowedRelations.has(edge.relation)) {
      return undefined;
    }
    if (edge.from === current) {
      return direction === "incoming" ? undefined : edge.to;
    }
    return direction === "outgoing" ? undefined : edge.from;
  }, to);
  const destination = visits.find(({ id }) => id === to);
  if (!destination) return null;
  const pathNodes = [];
  const pathEdges = [];
  for (
    let visit: Visit<E> | undefined = destination;
    visit;
    visit = visit.previous
  ) {
    pathNodes.push({ ...nodes.get(visit.id)! });
    if (visit.edge) pathEdges.push({ ...visit.edge });
  }
  return { nodes: pathNodes.reverse(), edges: pathEdges.reverse() };
}

function collectEdges(
  adjacency: ReadonlyMap<string, readonly Edge[]>,
  visits: readonly Visit[],
  seen: ReadonlySet<string>,
  relation?: Relation,
): Edge[] {
  return visits.flatMap(({ id }) =>
    (adjacency.get(id) ?? []).filter((edge) =>
      edge.from === id && seen.has(edge.to) &&
      (relation === undefined || edge.relation === relation)
    ).map((edge) => ({ ...edge }))
  );
}

function parseEdge(
  value: unknown,
  nodes: ReadonlyMap<string, GraphNode>,
): Edge {
  const raw = record(value);
  const from = string(raw.from, "edge source");
  const to = string(raw.to, "edge destination");
  const relation = member(relationNames, raw.relation, "relationship");
  const [source, destination] = relationships[relation];
  if (nodes.get(from)?.kind !== source || nodes.get(to)?.kind !== destination) {
    throw new Error(
      `Relationship ${relation} requires ${source} → ${destination}`,
    );
  }
  if (relation === "verifies") {
    const evidence = nodes.get(from);
    if (evidence?.kind !== "evidence" || !evidence.controlVerification) {
      throw new Error(
        "Sentinel verifies link requires control verification evidence",
      );
    }
  }
  return { from, to, relation };
}

/** Build and index a versioned snapshot exported by a defensive source. */
/** Index aliases and IDs, marking identifiers shared by multiple assets as ambiguous. */
export function assetIdentityIndex(
  assets: Iterable<
    { readonly id: string; readonly aliases?: readonly string[] }
  >,
) {
  const owners = new Map<string, string | null>();
  for (const asset of assets) {
    for (const key of [asset.id, ...(asset.aliases ?? [])]) {
      if (!owners.has(key)) owners.set(key, asset.id);
      else if (owners.get(key) !== asset.id) owners.set(key, null);
    }
  }
  return owners;
}

export function loadSentinelGraph(value: unknown) {
  const snapshot = record(value);
  if (
    snapshot.version !== 1 || !Array.isArray(snapshot.nodes) ||
    !Array.isArray(snapshot.edges)
  ) {
    throw new Error(
      "Expected a Sentinel version 1 snapshot with nodes and edges",
    );
  }

  const nodes = new Map<string, GraphNode>();
  const organizations = new Map<string, string>();
  const adjacency = new Map<string, Edge[]>();
  for (const raw of snapshot.nodes) {
    const node = parseNode(raw);
    if (node.kind === "asset" && node.organization) {
      const { id, label } = node.organization;
      const previousLabel = organizations.get(id);
      if (previousLabel !== undefined && previousLabel !== label) {
        throw new Error("Conflicting Sentinel organization labels");
      }
      organizations.set(id, label);
    }
    if (nodes.has(node.id)) {
      throw new Error(`Duplicate Sentinel node ID ${JSON.stringify(node.id)}`);
    }
    nodes.set(node.id, node);
    adjacency.set(node.id, []);
  }

  const parents = deriveSentinelAssetParents(
    [...nodes.values()].filter((node) => node.kind === "asset"),
  );
  const edges = new Map<string, Edge>();
  function addEdge(edge: Edge) {
    const key = JSON.stringify([edge.from, edge.relation, edge.to]);
    if (edges.has(key)) return;
    edges.set(key, edge);
    adjacency.get(edge.from)?.push(edge);
    if (edge.to !== edge.from) adjacency.get(edge.to)?.push(edge);
  }
  for (const raw of snapshot.edges) {
    const edge = parseEdge(raw, nodes);
    if (edge.relation === "contained_in") {
      if (parents.get(edge.from) !== edge.to) {
        throw new Error(
          "Sentinel containment link must match the declared parent",
        );
      }
      continue;
    }
    addEdge(edge);
  }
  for (const [from, to] of parents) {
    addEdge({ from, to, relation: "contained_in" });
  }

  /** Triage findings by reported severity, then directly affected asset count. */
  function report() {
    return [...nodes.values()]
      .flatMap((node) => {
        if (node.kind !== "finding") return [];
        const edges = adjacency.get(node.id) ?? [];
        const assets = edges.filter((edge) => edge.relation === "affects")
          .map((edge) => edge.to);
        const controls = edges.filter((edge) => edge.relation === "mitigates")
          .map((edge) => edge.from);
        const evidence = edges.filter((edge) => edge.relation === "supports")
          .map((edge) => edge.from);
        return [{ ...node, assets, controls, evidence }];
      })
      .sort((a, b) =>
        sentinelFindingSeverities.indexOf(a.severity) -
          sentinelFindingSeverities.indexOf(b.severity) ||
        b.assets.length - a.assets.length || a.id.localeCompare(b.id)
      );
  }

  type RecordedVerification = {
    readonly evidenceId: string;
    readonly verification: ControlVerification;
  };
  const controlEvidence = new Map<string, RecordedVerification[]>();

  function verificationFor(
    controlId: string,
    asOf: string,
  ): LinkedControlCoverage {
    let records = controlEvidence.get(controlId);
    if (!records) {
      records = (adjacency.get(controlId) ?? []).flatMap((edge) => {
        if (edge.relation !== "verifies") return [];
        const evidence = nodes.get(edge.from);
        if (evidence?.kind !== "evidence" || !evidence.controlVerification) {
          return [];
        }
        return [{
          evidenceId: evidence.id,
          verification: evidence.controlVerification,
        }];
      }).sort((a, b) =>
        b.verification.observedAt.localeCompare(a.verification.observedAt) ||
        a.verification.outcome.localeCompare(b.verification.outcome) ||
        b.verification.validUntil.localeCompare(a.verification.validUntil) ||
        (a.evidenceId < b.evidenceId
          ? -1
          : a.evidenceId === b.evidenceId
          ? 0
          : 1)
      );
      controlEvidence.set(controlId, records);
    }
    const chosen = records.find(({ verification }) =>
      verification.observedAt <= asOf
    );
    return chosen
      ? {
        controlId,
        status: chosen.verification.validUntil <= asOf
          ? "stale"
          : chosen.verification.outcome,
        ...chosen,
      }
      : { controlId, status: "unverified" };
  }

  function coverageFor(controls: readonly string[], asOf: string) {
    const linked = controls.map((id) => verificationFor(id, asOf));
    const status = !linked.length
      ? "no_control_link" as const
      : linked.some(({ status }) => status === "fail")
      ? "fail" as const
      : linked.some(({ status }) => status === "stale")
      ? "stale" as const
      : linked.every(({ status }) => status === "pass")
      ? "pass" as const
      : "unverified" as const;
    return { asOf, status, controls: linked };
  }

  let owners: ReturnType<typeof assetIdentityIndex> | undefined;
  return {
    resolveAssetId(identifier: string): string | undefined {
      if (nodes.get(identifier)?.kind === "asset") return identifier;
      owners ??= assetIdentityIndex(
        [...nodes.values()].filter((node) => node.kind === "asset"),
      );
      return owners.get(identifier) ?? undefined;
    },

    /** Export validated node and edge records without exposing the graph indexes. */
    snapshot() {
      return {
        version: 1 as const,
        nodes: [...nodes.values()].map((node) => ({ ...node })),
        edges: [...edges.values()].map((edge) => ({ ...edge })),
      };
    },

    /** Walk relationships in either direction, retaining their original orientation. */
    trace(id: string, maxDepth: number) {
      if (!nodes.has(id)) {
        throw new Error(`Unknown Sentinel node ${JSON.stringify(id)}`);
      }
      const { visits, seen } = walk(
        adjacency,
        id,
        maxDepth,
        (edge, current) => edge.from === current ? edge.to : edge.from,
      );
      return {
        nodes: visits.map((visit) => ({
          ...nodes.get(visit.id)!,
          distance: visit.distance,
        })),
        edges: collectEdges(adjacency, visits, seen),
      };
    },

    /** Return one shortest path through imported records and preserve the edges' direction. */
    shortestPath(
      from: string,
      to: string,
      maxDepth: number,
      direction: SentinelPathDirection = "both",
      relation?: string,
    ) {
      return shortestSentinelRelationshipPath(
        nodes,
        adjacency,
        from,
        to,
        maxDepth,
        direction,
        relation,
      );
    },

    alternatePaths(
      from: string,
      to: string,
      depth: number,
      direction: SentinelPathDirection,
      relation: string | undefined,
      limit: number,
    ) {
      return alternateSentinelRelationshipPaths(
        nodes,
        adjacency,
        from,
        to,
        depth,
        direction,
        relation,
        limit,
      );
    },

    report,

    /** Evaluate imported checks at an explicit instant without probing systems. */
    controlCoverage(findingId: string, evaluatedAt: string) {
      if (nodes.get(findingId)?.kind !== "finding") {
        throw new Error(
          `Unknown Sentinel finding ${JSON.stringify(findingId)}`,
        );
      }
      const controls = (adjacency.get(findingId) ?? [])
        .filter(({ relation }) => relation === "mitigates")
        .map(({ from }) => from);
      return coverageFor(controls, verificationTime(evaluatedAt));
    },

    /** Document which findings have linked mitigation controls and evidence. */
    coverage(evaluatedAt?: string) {
      const at = evaluatedAt === undefined
        ? undefined
        : verificationTime(evaluatedAt);
      const findings = report().map((finding) => ({
        ...finding,
        hasControlLink: finding.controls.length > 0,
        hasEvidenceLink: finding.evidence.length > 0,
        ...(at !== undefined && {
          controlVerification: coverageFor(finding.controls, at),
        }),
      }));
      return {
        summary: {
          totalFindings: findings.length,
          withoutControlLink:
            findings.filter((finding) => !finding.hasControlLink).length,
          withoutEvidenceLink:
            findings.filter((finding) => !finding.hasEvidenceLink).length,
        },
        findings,
      };
    },

    /** Find assets that depend on the selected asset, directly or transitively. */
    impact(assetId: string, maxDepth: number) {
      if (nodes.get(assetId)?.kind !== "asset") {
        throw new Error(`Unknown Sentinel asset ${JSON.stringify(assetId)}`);
      }
      const { visits, seen } = walk(
        adjacency,
        assetId,
        maxDepth,
        (edge, current) =>
          edge.relation === "depends_on" && edge.to === current
            ? edge.from
            : undefined,
      );
      return {
        assets: visits.map(({ id, distance }) => ({
          ...nodes.get(id)!,
          distance,
          findings: (adjacency.get(id) ?? [])
            .filter((edge) => edge.relation === "affects").map((edge) =>
              edge.from
            ),
        })),
        edges: collectEdges(adjacency, visits, seen, "depends_on"),
      };
    },
  };
}
