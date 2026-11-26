import type { SentinelWorkerFindingRecheckRecord } from "./worker_finding_store.ts";
import {
  satisfiesSentinelGraphFactRequirement,
  type SentinelWorkerGraphFact,
} from "./worker_graph_facts.ts";
/** Combine original defensive graph records with linked assessment provenance. */

import {
  futureWorkflowOutcomeMatches,
  taskWorkerSources,
  workflowObservationMatchesOutcome,
} from "./adaptive_store.ts";
import {
  normalizeSentinelAssetDiscoveryClaim,
  parseDiscoveryGraphFactSource,
  type SentinelAssetDiscoveryRecord,
} from "./asset_discovery_store.ts";
import { isSentinelCaseId } from "./cases.ts";
import { parseSentinelTelemetryAlert } from "./case_report.ts";
import {
  AUTH_FANOUT_LIMIT,
  AUTH_WINDOW_MS,
  isSentinelAlertSeverity,
  sentinelAlertKey,
  sentinelAlertReference,
  type TelemetryAlert,
} from "./telemetry.ts";
import {
  normalizeSentinelWorkflowReviewStep,
  projectSentinelTraceMetadata,
  readSentinelAssignedTargetReceipt,
  readSentinelGitHubWorkflowReadReceipt,
  type SentinelFindingReview,
  type SentinelGitHubWorkflowReadReceipt,
  type SentinelIncidentReview,
  type SentinelReviewStep,
} from "./assessment_store.ts";
import {
  loadSentinelGraph,
  type SentinelPathDirection,
  shortestSentinelRelationshipPath,
} from "./graph.ts";

import { alternateSentinelRelationshipPaths } from "./path_search.ts";

type GraphSnapshot = ReturnType<
  ReturnType<typeof loadSentinelGraph>["snapshot"]
>;
type ImportedNode = GraphSnapshot["nodes"][number];
type ImportedRelation = GraphSnapshot["edges"][number]["relation"];

interface ModelReview {
  readonly taskId: string;
  readonly summary: string;
  readonly at: string;
  readonly operatingConstraints?: AdaptivePlannerConstraintProof;
  readonly steps: readonly (SentinelReviewStep & {
    /** Exact imported provenance ID resolved from the assigned task. */
    readonly targetRef?: string;
  })[];
}

import { createHash } from "node:crypto";
import type {
  AdaptiveFactSatisfaction,
  AdaptivePeerFindingCitation,
  AdaptivePlannerConstraintProof,
  AdaptivePlannerRound,
  AdaptivePriorAssignedTargetCitation,
  AdaptiveWorkflowObservation,
} from "./adaptive_store.ts";

interface DecisionHold {
  readonly kind: "finding" | "incident";
  readonly id: number;
  readonly revision: number;
  readonly disposition: "resolved" | "dismissed";
}

type ProvenanceNode =
  | (ImportedNode & {
    readonly sourceId: string;
    readonly origin: "imported";
    readonly findingReviews?: readonly SentinelFindingReview[];
  })
  | {
    readonly id: string;
    readonly sourceId: string;
    readonly origin: "assessment" | "adaptive";
    readonly kind: "goal" | "task" | "observation";
    readonly label: string;
    readonly status?: string;
    readonly worker?: string;
    readonly reason?: string;
    readonly plannerRound?: AdaptivePlannerRound;
    readonly peerFinding?: Omit<AdaptivePeerFindingCitation, "mappingSources">;
    readonly priorAssignedTarget?: AdaptivePriorAssignedTargetCitation;
    readonly factSatisfaction?: AdaptiveFactSatisfaction;
    readonly githubWorkflowRead?: SentinelGitHubWorkflowReadReceipt;
    readonly graphFact?: Omit<SentinelWorkerGraphFact, "requestId">;
    readonly workflowObservation?: Omit<AdaptiveWorkflowObservation, "receipt">;
    readonly assetDiscovery?: SentinelAssetDiscoveryRecord;
    readonly remediationRecheck?: RemediationRecheckProvenance;
    readonly decisionHold?: DecisionHold;
    readonly requiredInput?: string;
    readonly alert?: TelemetryAlert;
    readonly incident?: {
      asset: string;
      severity?: string;
      startedAt: string;
      endedAt: string;
      signals: readonly string[];
      reportedAssets: readonly string[];
      correlationBasis?:
        | "shared_session_reference"
        | "shared_identity_reference"
        | "shared_reported_subject";
      gaps?: readonly string[];
      evidenceIds: readonly string[];
      findingIds: readonly string[];
      alertCount?: number;
    };
    readonly modelReview?: ModelReview;
    readonly incidentReview?: SentinelIncidentReview;
  };

interface ProvenanceEdge {
  readonly from: string;
  readonly to: string;
  readonly relation:
    | ImportedRelation
    | "requests"
    | "requires"
    | "prompted"
    | "produces"
    | "references";
}

interface UnresolvedReference {
  readonly node: string;
  readonly reference: string;
  readonly relation: "prompted" | "references";
}

type RemediationRecheckProvenance =
  & Pick<
    SentinelWorkerFindingRecheckRecord,
    | "id"
    | "caseId"
    | "runId"
    | "evidenceRevision"
    | "taskId"
    | "targetId"
    | "evidenceId"
    | "findingId"
    | "graphFindingId"
    | "outcome"
  >
  & { readonly receiptSha256: string };

/** An adaptive goal and its current persisted task list. */
export interface AdaptiveProvenanceView {
  readonly goal: { readonly id: string; readonly label: string };
  readonly caseId?: string;
  readonly evidenceRevision?: number;
  readonly assignedIncidents?: readonly Record<string, unknown>[];
  readonly assignedAlerts?: readonly TelemetryAlert[];
  readonly modelReviews?: readonly ModelReview[];
  readonly modelReviewStates?: readonly {
    readonly taskId: string;
    readonly status: string;
  }[];
  readonly remediationRechecks?: readonly RemediationRecheckProvenance[];
  readonly graphFacts?: readonly SentinelWorkerGraphFact[];
  readonly workflowObservations?: readonly AdaptiveWorkflowObservation[];
  readonly assetDiscoveries?: readonly SentinelAssetDiscoveryRecord[];
  readonly verificationReviewSources?: readonly {
    targetId: string;
    sourceId: string;
    evidenceId: string;
  }[];
  readonly tasks: readonly {
    readonly id: string;
    readonly revision?: string;
    readonly nodeId?: string;
    readonly kind: string;
    readonly depth?: number;
    readonly status: string;
    readonly attempts?: number;
    readonly prerequisites: readonly string[];
    readonly evidenceIds: readonly string[];
    readonly observation?: unknown;
    readonly reviewedFrom?: string;
    readonly factSatisfaction?: AdaptiveFactSatisfaction;
    readonly plannerRound?: AdaptivePlannerRound;
    readonly decisionHold?: DecisionHold;
    readonly reason?: string;
  }[];
}

const MAX_NODES = 5_000;
const MAX_EDGES = 20_000;
const MAX_TRACE_DEPTH = 16;

function object(raw: unknown, field: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected Sentinel provenance ${field} object`);
  }
  return raw as Record<string, unknown>;
}

function text(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4_096) {
    throw new Error(`Invalid Sentinel provenance ${field}`);
  }
  return raw;
}

function list(
  raw: unknown,
  field: string,
  max = MAX_NODES,
): readonly unknown[] {
  if (!Array.isArray(raw) || raw.length > max) {
    throw new Error(`Invalid or oversized Sentinel provenance ${field}`);
  }
  return raw;
}

function derivedRef(
  kind: "goal" | "task" | "observation",
  origin: "assessment" | "adaptive",
  sourceId: string,
): string {
  return `${kind}:${origin}:${sourceId}`;
}

export function sentinelIncidentProvenanceId(incidentId: string): string {
  return derivedRef("observation", "assessment", incidentId);
}

function indexProvenance() {
  const nodes = new Map<string, ProvenanceNode>();
  const edges = new Map<string, ProvenanceEdge>();
  const unresolved = new Map<string, UnresolvedReference>();
  const adjacency = new Map<string, ProvenanceEdge[]>();

  function addNode(node: ProvenanceNode): void {
    if (nodes.has(node.id)) {
      throw new Error("Duplicate Sentinel provenance node");
    }
    if (nodes.size >= MAX_NODES) {
      throw new Error("Sentinel provenance node limit exceeded");
    }
    nodes.set(node.id, node);
    adjacency.set(node.id, []);
  }

  function addEdge(
    from: string,
    to: string,
    relation: ProvenanceEdge["relation"],
  ): void {
    const source = adjacency.get(from);
    const destination = adjacency.get(to);
    if (!source || !destination) {
      throw new Error(
        `Missing endpoint for Sentinel provenance ${relation} link`,
      );
    }
    const key = JSON.stringify([from, to, relation]);
    if (edges.has(key)) return;
    if (edges.size >= MAX_EDGES) {
      throw new Error("Sentinel provenance edge limit exceeded");
    }
    const edge = { from, to, relation };
    edges.set(key, edge);
    source.push(edge);
    if (to !== from) destination.push(edge);
  }

  function addUnresolved(ref: UnresolvedReference): void {
    const key = JSON.stringify([ref.node, ref.reference, ref.relation]);
    if (unresolved.has(key)) return;
    if (unresolved.size >= MAX_EDGES) {
      throw new Error(
        "Sentinel provenance unresolved reference limit exceeded",
      );
    }
    unresolved.set(key, ref);
  }

  function overview() {
    const nodesByKind: Record<string, number> = Object.create(null);
    const edgesByRelation: Record<string, number> = Object.create(null);
    for (const { kind } of nodes.values()) {
      nodesByKind[kind] = (nodesByKind[kind] ?? 0) + 1;
    }
    for (const { relation } of edges.values()) {
      edgesByRelation[relation] = (edgesByRelation[relation] ?? 0) + 1;
    }
    return {
      nodeCount: nodes.size,
      edgeCount: edges.size,
      unresolvedReferenceCount: unresolved.size,
      nodesByKind,
      edgesByRelation,
    };
  }

  function snapshot() {
    return {
      version: 1 as const,
      nodes: [...nodes.values()].map((node) => ({ ...node })),
      edges: [...edges.values()].map((edge) => ({ ...edge })),
      unresolvedReferences: [...unresolved.values()].map((entry) => ({
        ...entry,
      })),
    };
  }

  function trace(id: string, depth = 2) {
    if (!nodes.has(id)) {
      throw new Error("Unknown Sentinel provenance reference");
    }
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > MAX_TRACE_DEPTH) {
      throw new Error("Sentinel provenance depth must be 0 to 16");
    }

    const visited = new Map([[id, 0]]);
    for (const [current, distance] of visited) {
      if (distance >= depth) break;
      for (const edge of adjacency.get(current) ?? []) {
        const next = edge.from === current ? edge.to : edge.from;
        if (!visited.has(next)) visited.set(next, distance + 1);
      }
    }

    return {
      version: 1 as const,
      nodes: [...visited].map(([ref, distance]) => ({
        ...nodes.get(ref)!,
        distance,
      })),
      edges: [...visited.keys()].flatMap((current) =>
        (adjacency.get(current) ?? []).filter((edge) =>
          edge.from === current && visited.has(edge.to)
        ).map((edge) => ({ ...edge }))
      ),
      unresolvedReferences: [...unresolved.values()].filter(({ node }) =>
        visited.has(node)
      ).map((entry) => ({ ...entry })),
    };
  }

  function shortestPath(
    from: string,
    to: string,
    depth: number,
    direction: SentinelPathDirection = "both",
    relation?: string,
  ) {
    if (depth > MAX_TRACE_DEPTH) {
      throw new Error("Sentinel provenance depth must be 0 to 16");
    }
    return shortestSentinelRelationshipPath(
      nodes,
      adjacency,
      from,
      to,
      depth,
      direction,
      relation,
    );
  }

  function alternatePaths(
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
  }

  function searchNodes(query: string, kind?: string, origin?: string) {
    const term = query.trim().toLowerCase();
    return [...nodes.values()].filter((node) =>
      (kind === undefined || node.kind === kind) &&
      (origin === undefined || node.origin === origin) &&
      (!term || [
        node.id,
        node.sourceId,
        node.label,
        "incidentReview" in node ? node.incidentReview?.note : undefined,
        "incidentReview" in node ? node.incidentReview?.disposition : undefined,
        "modelReview" in node ? node.modelReview?.summary : undefined,
        "plannerRound" in node ? node.plannerRound?.identity : undefined,
      ].some((value) => value?.toLowerCase().includes(term)) ||
        (node.kind === "finding" &&
          node.findingReviews?.some(({ note, disposition }) =>
            note.toLowerCase().includes(term) ||
            disposition.toLowerCase().includes(term)
          )) ||
        (node.kind === "asset" &&
          node.aliases?.some((alias) => alias.toLowerCase().includes(term))) ||
        (node.kind === "evidence" && node.relationshipSources?.some(
          ({ caseId, from, to, snapshotDigest }) =>
            [caseId, from, to, snapshotDigest].some((value) =>
              value?.toLowerCase().includes(term)
            ),
        )))
    ).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(({ id, label, kind, origin }) => ({
        id,
        label: label.slice(0, 256),
        kind,
        origin,
      }));
  }

  function searchReviewSteps(query: string, taskId?: string) {
    const term = query.trim().toLowerCase();
    return [...nodes.values()].flatMap((node) => {
      const review = "modelReview" in node ? node.modelReview : undefined;
      if (!review || (taskId !== undefined && review.taskId !== taskId)) {
        return [];
      }
      return review.steps.flatMap((step, index) =>
        !term ||
          [
            step.tool,
            step.target,
            step.outcome,
            ...step.sourceSnapshots?.flatMap((
              { caseId, assetId, snapshotDigest },
            ) => [caseId, assetId, snapshotDigest]) ?? [],
          ].some((value) => value?.toLowerCase().includes(term))
          ? [{
            reviewId: node.id,
            taskId: review.taskId,
            at: review.at,
            index,
            ...step,
          }]
          : []
      );
    });
  }

  function inspect(id: string) {
    const node = nodes.get(id);
    if (!node) return undefined;
    return {
      node: { ...node },
      connections: [
        ...(adjacency.get(id) ?? []).map((edge) => ({
          kind: "edge" as const,
          ...edge,
        })),
        ...[...unresolved.values()].filter((entry) => entry.node === id).map((
          entry,
        ) => ({
          kind: "unresolved" as const,
          ...entry,
        })),
      ],
    };
  }

  return {
    addNode,
    nodes,
    hasNode: (id: string) => nodes.has(id),
    addEdge,
    addUnresolved,
    snapshot,
    overview,
    trace,
    shortestPath,
    alternatePaths,
    inspect,
    searchNodes,
    searchReviewSteps,
  };
}

type Index = ReturnType<typeof indexProvenance>;

function importSourceGraph(
  index: Index,
  raw: unknown,
  findingReviews: readonly SentinelFindingReview[],
) {
  const imported = new Map<
    string,
    { ref: string; kind: ImportedNode["kind"] }
  >();
  const supportingEvidence = new Set<string>();
  if (raw === null) {
    return {
      imported,
      supportingEvidence,
      resolveAssetId: (_: string) => undefined,
    };
  }
  const snapshot = object(raw, "snapshot");
  list(snapshot.nodes, "imported nodes", MAX_NODES);
  list(snapshot.edges, "imported edges", MAX_EDGES);
  const loaded = loadSentinelGraph(snapshot);
  const graph = loaded.snapshot();

  const reviewsByFinding = Map.groupBy(
    findingReviews,
    ({ findingId }) => findingId,
  );
  for (const node of graph.nodes) {
    const id = `${node.kind}:${node.id}`;
    const reviews = node.kind === "finding"
      ? reviewsByFinding.get(node.id)
      : undefined;
    index.addNode({
      ...node,
      id,
      sourceId: node.id,
      origin: "imported",
      ...(reviews && { findingReviews: reviews }),
    });
    imported.set(node.id, { ref: id, kind: node.kind });
  }
  for (const edge of graph.edges) {
    index.addEdge(
      imported.get(edge.from)!.ref,
      imported.get(edge.to)!.ref,
      edge.relation,
    );
    if (edge.relation === "supports") supportingEvidence.add(edge.from);
  }
  return {
    imported,
    supportingEvidence,
    resolveAssetId: loaded.resolveAssetId,
  };
}

type ImportedIndex = ReturnType<typeof importSourceGraph>["imported"];

export function sentinelAlertProvenanceId(alert: TelemetryAlert): string {
  return derivedRef("observation", "assessment", sentinelAlertReference(alert));
}

function matchesAuthenticationFanout(
  followUp: TelemetryAlert,
  fanout: TelemetryAlert | undefined,
): fanout is TelemetryAlert {
  if (
    followUp.type !== "authentication_success_after_fanout" ||
    fanout?.type !== "authentication_failure_fanout" ||
    fanout.asset !== followUp.asset ||
    !followUp.sourceReference ||
    fanout.sourceReference !== followUp.sourceReference ||
    fanout.evidenceIds.length !== AUTH_FANOUT_LIMIT ||
    followUp.evidenceIds.length !== AUTH_FANOUT_LIMIT + 1 ||
    !fanout.evidenceIds.every((id, offset) =>
      id === followUp.evidenceIds[offset]
    )
  ) return false;
  const delay = Date.parse(followUp.observedAt) - Date.parse(fanout.observedAt);
  return delay > 0 && delay < AUTH_WINDOW_MS;
}

function linkAuthenticationFanout(index: Index): void {
  for (const [id, node] of index.nodes) {
    if (!("alert" in node)) continue;
    const followUp = node.alert;
    if (followUp?.type !== "authentication_success_after_fanout") continue;
    const failedEvidence = followUp.evidenceIds.slice(0, AUTH_FANOUT_LIMIT);
    const sourceId = derivedRef(
      "observation",
      "assessment",
      sentinelAlertReference({
        type: "authentication_failure_fanout",
        asset: followUp.asset,
        evidenceIds: failedEvidence,
      }),
    );
    const source = index.nodes.get(sourceId);
    const fanout = source && "alert" in source ? source.alert : undefined;
    if (matchesAuthenticationFanout(followUp, fanout)) {
      index.addEdge(id, sourceId, "references");
    }
  }
}

function findFocusedAuthenticationSibling(
  alert: TelemetryAlert,
  revisionFeed: readonly TelemetryAlert[],
): TelemetryAlert | undefined {
  if (alert.type === "authentication_success_after_fanout") {
    return revisionFeed.find((candidate) =>
      matchesAuthenticationFanout(alert, candidate)
    );
  }
  if (alert.type !== "authentication_failure_fanout") return undefined;
  let followUp: TelemetryAlert | undefined;
  for (const candidate of revisionFeed) {
    if (!matchesAuthenticationFanout(candidate, alert)) continue;
    if (
      followUp && sentinelAlertKey(followUp) !== sentinelAlertKey(candidate)
    ) {
      return undefined;
    }
    followUp ??= candidate;
  }
  return followUp;
}

function addAlertNode(
  index: Index,
  imported: ImportedIndex,
  alert: TelemetryAlert,
  resolveAssetId: (identifier: string) => string | undefined,
  observation?: string,
) {
  const id = sentinelAlertProvenanceId(alert);
  index.addNode({
    id,
    sourceId: sentinelAlertReference(alert),
    label: [alert.type.replaceAll("_", " "), alert.triggeringAction].filter(
      Boolean,
    ).join(" · "),
    origin: "assessment",
    kind: "observation",
    worker: "incident_review",
    alert,
  });
  if (observation) index.addEdge(observation, id, "references");
  const matchedAsset = resolveAssetId(alert.asset);
  const asset = matchedAsset === undefined
    ? undefined
    : imported.get(matchedAsset);
  if (asset?.kind === "asset") index.addEdge(id, asset.ref, "observed_on");
  for (const evidence of alert.evidenceIds) {
    const record = imported.get(evidence);
    if (record?.kind === "evidence") {
      index.addEdge(id, record.ref, "references");
    }
  }
}

function addIncidentCandidates(
  index: Index,
  imported: ImportedIndex,
  observation: string | undefined,
  raw: unknown,
) {
  const facts = object(raw, "incident observation facts");
  if (facts.candidates === undefined) return;
  const strings = (value: unknown, label: string) =>
    list(value, label, 25).map((item) => text(item, label));
  for (const value of list(facts.candidates, "incident candidates", 25)) {
    const candidate = object(value, "incident candidate");
    const sourceId = text(candidate.id, "incident ID");
    const id = sentinelIncidentProvenanceId(sourceId);
    if (index.hasNode(id)) continue;
    const asset = text(candidate.asset, "incident asset");
    const relatedAssets = strings(
      candidate.relatedAssetIds ?? [],
      "related incident assets",
    );
    const findingIds = strings(candidate.findingIds, "incident findings");
    const evidenceIds = strings(candidate.evidenceIds, "incident evidence");
    index.addNode({
      id,
      sourceId,
      kind: "observation",
      origin: "assessment",
      label: `Incident candidate · ${asset}`,
      status: "requires_review",
      incident: {
        asset,
        ...(isSentinelAlertSeverity(candidate.severity) &&
          { severity: candidate.severity }),
        startedAt: text(candidate.startedAt, "incident start"),
        endedAt: text(candidate.endedAt, "incident end"),
        signals: strings(candidate.signals, "incident signals"),
        ...((candidate.correlationBasis === "shared_session_reference" ||
          candidate.correlationBasis === "shared_identity_reference" ||
          candidate.correlationBasis === "shared_reported_subject") &&
          { correlationBasis: candidate.correlationBasis }),
        ...(candidate.gaps !== undefined &&
          { gaps: strings(candidate.gaps, "incident gaps") }),
        reportedAssets: strings(
          candidate.reportedAssets ?? [],
          "reported assets",
        ),
        evidenceIds,
        findingIds,
        ...(typeof candidate.alertCount === "number" &&
          { alertCount: candidate.alertCount }),
      },
    });
    if (observation) index.addEdge(observation, id, "references");
    for (
      const target of new Set([
        asset,
        ...relatedAssets,
        ...findingIds,
        ...evidenceIds,
      ])
    ) {
      const node = imported.get(target);
      if (node) index.addEdge(id, node.ref, "references");
    }
    for (
      const reference of list(
        candidate.alertReferences ?? [],
        "incident alerts",
        2_000,
      ).map((reference) => text(reference, "incident alert reference"))
    ) {
      const alert = derivedRef("observation", "assessment", reference);
      if (index.hasNode(alert)) index.addEdge(id, alert, "references");
    }
  }
}

function addAssessment(
  index: Index,
  report: Record<string, unknown>,
  shared: Record<string, unknown>,
  imported: ImportedIndex,
  supportingEvidence: ReadonlySet<string>,
  resolveAssetId: (identifier: string) => string | undefined,
  selectedAlerts: ReadonlyMap<string, TelemetryAlert>,
  focusedAlert?: TelemetryAlert,
): void {
  const revision = text(report.revision, "assessment revision");
  const goal = derivedRef("goal", "assessment", revision);
  index.addNode({
    id: goal,
    sourceId: revision,
    origin: "assessment",
    kind: "goal",
    label: "Defensive assessment",
  });
  const tasks = list(report.tasks, "assessment tasks").map((raw) =>
    object(raw, "assessment task")
  );
  const taskWorkers = new Map<string, { worker: string; status: string }>();
  for (const task of tasks) {
    const sourceId = text(task.id, "assessment task ID");
    const worker = text(task.worker, "assessment task worker");
    const status = text(task.status, "assessment task status");
    if (
      status !== "waiting" && status !== "skipped" && status !== "completed"
    ) {
      throw new Error("Invalid Sentinel assessment task status");
    }
    const id = derivedRef("task", "assessment", sourceId);
    index.addNode({
      id,
      sourceId,
      label: sourceId,
      origin: "assessment",
      kind: "task",
      status,
      worker,
      ...(task.reason !== undefined && {
        reason: text(task.reason, "assessment task reason"),
      }),
      ...(task.requiredInput !== undefined && {
        requiredInput: text(task.requiredInput, "assessment required input"),
      }),
    });
    taskWorkers.set(sourceId, { worker, status });
    index.addEdge(goal, id, "requests");
    if (sourceId === "case" && typeof task.requiredInput === "string") {
      if (supportingEvidence.has(task.requiredInput)) {
        index.addEdge(imported.get(task.requiredInput)!.ref, id, "prompted");
      } else {
        index.addUnresolved({
          node: id,
          reference: task.requiredInput,
          relation: "prompted",
        });
      }
    }
  }
  for (const task of tasks) {
    const id = derivedRef(
      "task",
      "assessment",
      text(task.id, "assessment task ID"),
    );
    for (
      const dependency of list(
        task.prerequisites,
        "assessment task prerequisites",
      )
    ) {
      const ref = derivedRef(
        "task",
        "assessment",
        text(dependency, "assessment prerequisite ID"),
      );
      index.addEdge(id, ref, "requires");
    }
  }

  const observations = list(shared.observations, "assessment observations");
  for (const raw of observations) {
    const observation = object(raw, "assessment observation");
    const sourceId = text(observation.id, "assessment observation ID");
    const taskId = text(observation.task, "assessment observation task");
    const worker = text(observation.worker, "assessment observation worker");
    const task = taskWorkers.get(taskId);
    if (task?.worker !== worker || task.status !== "completed") {
      throw new Error("Invalid Sentinel assessment observation worker or task");
    }
    const id = derivedRef("observation", "assessment", sourceId);
    index.addNode({
      id,
      sourceId,
      label: "Worker observation",
      origin: "assessment",
      kind: "observation",
      worker,
    });
    index.addEdge(derivedRef("task", "assessment", taskId), id, "produces");
    if (taskId === "case" && observation.facts) {
      const facts = object(observation.facts, "case observation facts");
      if (facts.alerts !== undefined) {
        const seen = new Set<string>();
        for (
          const [offset, rawAlert] of list(facts.alerts, "case alerts", 25)
            .entries()
        ) {
          const alert = parseSentinelTelemetryAlert(rawAlert, offset + 1);
          const key = sentinelAlertKey(alert);
          if (seen.has(key)) continue;
          seen.add(key);
          addAlertNode(
            index,
            imported,
            selectedAlerts.get(key) ?? alert,
            resolveAssetId,
            id,
          );
        }
      }
    }
  }
  if (focusedAlert && !index.hasNode(sentinelAlertProvenanceId(focusedAlert))) {
    const observation = derivedRef(
      "observation",
      "assessment",
      "assessment:case",
    );
    addAlertNode(
      index,
      imported,
      focusedAlert,
      resolveAssetId,
      index.hasNode(observation) ? observation : undefined,
    );
  }
  for (const raw of observations) {
    const observation = object(raw, "assessment observation");
    if (observation.task === "incident_correlation" && observation.facts) {
      const sourceId = text(observation.id, "assessment observation ID");
      const facts = object(observation.facts, "incident observation facts");
      for (
        const [offset, rawAlert] of list(
          facts.isolatedPriorityAlerts ?? [],
          "isolated priority alerts",
          25,
        ).entries()
      ) {
        const alert = parseSentinelTelemetryAlert(rawAlert, offset + 1);
        if (!index.hasNode(sentinelAlertProvenanceId(alert))) {
          addAlertNode(
            index,
            imported,
            selectedAlerts.get(sentinelAlertKey(alert)) ?? alert,
            resolveAssetId,
            derivedRef("observation", "assessment", sourceId),
          );
        }
      }
      addIncidentCandidates(
        index,
        imported,
        derivedRef("observation", "assessment", sourceId),
        observation.facts,
      );
    }
  }
  for (
    const raw of list(
      shared.observationLinks,
      "assessment observation links",
      MAX_EDGES,
    )
  ) {
    const link = object(raw, "assessment observation link");
    const from = derivedRef(
      "observation",
      "assessment",
      text(link.observation, "observation reference"),
    );
    const target = typeof link.node === "string"
      ? imported.get(link.node)
      : undefined;
    if (!target) {
      throw new Error(
        "Unknown imported node in Sentinel assessment observation link",
      );
    }
    index.addEdge(from, target.ref, "references");
  }
}

function validatedFactSatisfaction(
  task: AdaptiveProvenanceView["tasks"][number],
  tasksById: ReadonlyMap<string, AdaptiveProvenanceView["tasks"][number]>,
  evidenceRevision?: number,
): AdaptiveFactSatisfaction | undefined {
  const receipt = task.factSatisfaction;
  if (
    !receipt || receipt.graphFactId || receipt.findingRecheckId ||
    receipt.workflowObservationId ||
    task.status !== "completed" ||
    task.observation === undefined ||
    (receipt.evidenceRevision !== undefined &&
      receipt.evidenceRevision !== evidenceRevision)
  ) {
    return undefined;
  }
  const source = tasksById.get(receipt.sourceTaskId);
  if (
    source?.status !== "completed" || source.observation === undefined ||
    source.id === task.id || !task.nodeId || source.nodeId !== task.nodeId ||
    !((task.kind === "trace" && source.kind === "review_evidence") ||
      (task.kind === "review_evidence" && source.kind === "trace")) ||
    (task.depth ?? 1) !== 1 || (source.depth ?? 1) !== 1 ||
    !/^[a-f0-9]{64}$/.test(receipt.sourceObservationSha256)
  ) return undefined;
  const encoded = JSON.stringify(source.observation);
  if (
    !encoded || encoded !== JSON.stringify(task.observation) ||
    createHash("sha256").update(encoded).digest("hex") !==
      receipt.sourceObservationSha256
  ) return undefined;
  return {
    sourceTaskId: source.id,
    sourceObservationSha256: receipt.sourceObservationSha256,
    ...(receipt.evidenceRevision !== undefined &&
      { evidenceRevision: receipt.evidenceRevision }),
  };
}

function addWorkflowObservations(
  index: Index,
  view: AdaptiveProvenanceView,
  assignments: ReadonlyMap<string, AdaptiveProvenanceView["tasks"][number]>,
) {
  const statuses = new Map((view.modelReviewStates ?? []).map((row) => [
    row.taskId,
    row.status,
  ]));
  const observations = new Map<string, AdaptiveWorkflowObservation>();
  for (const observation of view.workflowObservations ?? []) {
    const { id, taskId, targetId, evidenceRevision, stepIndex } = observation;
    const source = assignments.get(taskId);
    if (
      !/^workflow-observation:[a-f0-9]{64}$/.test(id) ||
      observations.has(id) || !source?.revision || source.nodeId !== targetId ||
      evidenceRevision !== view.evidenceRevision ||
      !Number.isSafeInteger(stepIndex) || stepIndex < 0 || stepIndex >= 16
    ) continue;
    const receipt = readSentinelGitHubWorkflowReadReceipt(
      observation.receipt,
      evidenceRevision,
    );
    if (
      !receipt || createHash("sha256").update(JSON.stringify(receipt.runs))
          .digest("hex") !== receipt.resultSha256
    ) continue;
    const observationDigest = createHash("sha256").update(JSON.stringify([
      source.revision,
      taskId,
      targetId,
      evidenceRevision,
      stepIndex,
      receipt,
    ])).digest("hex");
    if (id !== `workflow-observation:${observationDigest}`) continue;
    const ref = derivedRef("observation", "adaptive", id);
    const status = statuses.get(taskId);
    const workflowObservation = {
      id,
      taskId,
      targetId,
      evidenceRevision,
      stepIndex,
    };
    index.addNode({
      id: ref,
      sourceId: id,
      label: "Intermediate workflow observation",
      kind: "observation",
      origin: "adaptive",
      ...(status && { status }),
      workflowObservation,
      githubWorkflowRead: receipt,
    });
    index.addEdge(derivedRef("task", "adaptive", taskId), ref, "produces");
    observations.set(id, { ...workflowObservation, receipt });
  }
  return observations;
}

export function verifiedSharedAssetDiscovery(
  caseId: string | undefined,
  records: ReadonlyMap<string, SentinelAssetDiscoveryRecord>,
  step: SentinelReviewStep,
): SentinelAssetDiscoveryRecord | undefined {
  const citation = step.sharedAssetDiscovery;
  if (
    !citation || step.tool !== "sentinel_shared_asset_discoveries" ||
    step.outcome !== "returned" || step.target !== citation.id
  ) return undefined;
  const source = records.get(citation.id);
  if (
    !source || source.status !== "approved" && source.status !== "withdrawn" ||
    !Number.isSafeInteger(source.version) ||
    source.version < (source.status === "approved" ? 2 : 3) ||
    !isSentinelCaseId(source.sourceCaseId) || source.sourceCaseId === caseId ||
    !/^adaptive:[a-f0-9]{64}$/.test(source.taskId) ||
    !Number.isSafeInteger(source.evidenceRevision) ||
    source.evidenceRevision < 1 ||
    !/^[a-f0-9]{64}$/.test(source.sourceDigest) ||
    (citation.version !== undefined && citation.version !== source.version) ||
    citation.sourceCaseId !== source.sourceCaseId ||
    citation.taskId !== source.taskId ||
    citation.evidenceRevision !== source.evidenceRevision ||
    citation.sourceDigest !== source.sourceDigest
  ) return undefined;
  let claim;
  try {
    claim = normalizeSentinelAssetDiscoveryClaim(source.claim);
  } catch {
    return undefined;
  }
  if (citation.evidenceId !== claim.evidenceId) return undefined;
  const { sourceCaseId, taskId, evidenceRevision, sourceDigest } = source;
  const graphFactSource = parseDiscoveryGraphFactSource(source.graphFactSource);
  if (
    source.graphFactSource !== undefined &&
    (!graphFactSource || claim.kind !== "relationship")
  ) return undefined;
  const digest = createHash("sha256").update(JSON.stringify({
    sourceCaseId,
    taskId,
    evidenceRevision,
    sourceDigest,
    claim,
    ...(graphFactSource && { graphFactSource }),
  })).digest("hex");
  if (source.id !== `asset-discovery:${digest}`) return undefined;
  const { id, status, version, proposedAt, updatedAt } = source;
  return {
    id,
    status,
    version,
    proposedAt,
    updatedAt,
    sourceCaseId,
    taskId,
    evidenceRevision,
    sourceDigest,
    claim,
    ...(graphFactSource && { graphFactSource }),
  };
}

function addAdaptive(
  index: Index,
  view: AdaptiveProvenanceView,
  imported: ImportedIndex,
): void {
  const origin = "adaptive";
  const goalSource = text(view.goal.id, "adaptive goal ID");
  const goal = derivedRef("goal", origin, goalSource);
  index.addNode({
    id: goal,
    sourceId: goalSource,
    label: text(view.goal.label, "adaptive goal label"),
    origin,
    kind: "goal",
  });

  const assignments = new Map(view.tasks.map((task) => [task.id, task]));
  const rechecks = new Map(
    view.remediationRechecks?.map((receipt) => [
      receipt.id,
      receipt,
    ]),
  );
  const recheckSatisfactions: {
    task: string;
    receipt: RemediationRecheckProvenance;
  }[] = [];
  const factSatisfactions: { target: string; source: string }[] = [];
  const graphSatisfactions = new Map<string, string>();
  const futureWorkflowSatisfactions = new Map<string, string>();
  for (const task of view.tasks) {
    const sourceId = text(task.id, "adaptive task ID");
    const id = derivedRef("task", origin, sourceId);
    const receipt = task.factSatisfaction;
    const relationshipFact = receipt?.graphFactId &&
      task.plannerRound?.graphFactOnly &&
      (task.plannerRound.graphFactId === receipt.graphFactId ||
        task.plannerRound.graphRelationship) &&
      task.status === "completed" &&
      view.graphFacts?.find((fact) =>
        fact.id === receipt.graphFactId && fact.targetId === task.nodeId &&
        fact.taskId === receipt.sourceTaskId &&
        assignments.get(fact.taskId)?.nodeId === fact.targetId &&
        fact.runId === view.goal.id &&
        fact.evidenceRevision === view.evidenceRevision &&
        (view.caseId === undefined || fact.caseId === view.caseId) &&
        imported.has(fact.relationship.from) &&
        imported.has(fact.relationship.to) &&
        fact.resultSha256 === receipt.sourceObservationSha256 &&
        (receipt.evidenceRevision === undefined ||
          receipt.evidenceRevision === fact.evidenceRevision) &&
        (task.plannerRound?.graphRelationship
          ? satisfiesSentinelGraphFactRequirement(
            task.plannerRound.graphRelationship,
            fact,
            receipt.checkedAt === undefined
              ? undefined
              : Date.parse(receipt.checkedAt),
          )
          : task.prerequisites.includes(fact.taskId))
      );
    if (relationshipFact) graphSatisfactions.set(task.id, relationshipFact.id);
    const recheck = receipt?.findingRecheckId &&
      rechecks.get(receipt.findingRecheckId);
    const verifiedRecheck = recheck && task.status === "completed" &&
      (recheck.id === task.plannerRound?.passingRecheckId ||
        recheck.findingId === task.plannerRound?.passingRecheckForFindingId) &&
      recheck.caseId === view.caseId && recheck.runId === view.goal.id &&
      recheck.evidenceRevision === view.evidenceRevision &&
      recheck.evidenceRevision === receipt?.evidenceRevision &&
      recheck.targetId === task.nodeId && recheck.outcome === "pass" &&
      recheck.taskId === receipt.sourceTaskId &&
      assignments.has(recheck.taskId) &&
      recheck.receiptSha256 === receipt.sourceObservationSha256;
    if (verifiedRecheck) {
      recheckSatisfactions.push({ task: id, receipt: recheck });
    }
    const citation = task.plannerRound?.committedObservation;
    const future = task.plannerRound?.futureWorkflowOutcome;
    const workflow = receipt?.workflowObservationId && (citation || future)
      ? view.workflowObservations?.find(({ id }) =>
        id === receipt.workflowObservationId
      )
      : undefined;
    const requiredOutcome = task.plannerRound?.requiredWorkflowOutcome;
    const workflowSource = workflow && assignments.get(workflow.taskId);
    const workflowReceipt = workflow &&
      readSentinelGitHubWorkflowReadReceipt(
        workflow.receipt,
        workflow.evidenceRevision,
      );
    const workflowDigest = workflow && workflowSource?.revision &&
      workflowReceipt &&
      createHash("sha256").update(JSON.stringify([
        workflowSource.revision,
        workflow.taskId,
        workflow.targetId,
        workflow.evidenceRevision,
        workflow.stepIndex,
        workflowReceipt,
      ])).digest("hex");
    const verifiedWorkflow = workflow && workflowDigest && receipt &&
      workflow.id === `workflow-observation:${workflowDigest}` &&
      workflowSource?.nodeId === task.nodeId &&
      workflowSource?.revision === task.revision &&
      task.status === "completed" && task.attempts === 0 && task.depth === 1 &&
      workflow.taskId === receipt.sourceTaskId &&
      workflow.targetId === task.nodeId &&
      workflow.evidenceRevision === view.evidenceRevision &&
      workflow.evidenceRevision === receipt.evidenceRevision &&
      workflow.receipt.resultSha256 === receipt.sourceObservationSha256 &&
      ((future && task.prerequisites.length === 0 &&
        futureWorkflowOutcomeMatches(future, workflow)) ||
        (citation && requiredOutcome &&
          workflow.id === citation.observationId &&
          workflow.taskId === citation.sourceTaskId &&
          workflow.targetId === citation.targetId &&
          workflow.evidenceRevision === citation.evidenceRevision &&
          workflow.stepIndex === citation.sourceStepIndex &&
          workflow.receipt.resultSha256 === citation.resultSha256 &&
          task.prerequisites.length === 1 &&
          task.prerequisites[0] === workflow.taskId &&
          workflowObservationMatchesOutcome(workflow, requiredOutcome)));
    if (verifiedWorkflow && future) {
      futureWorkflowSatisfactions.set(task.id, workflow.id);
    }
    const factSatisfaction =
      relationshipFact || verifiedRecheck || verifiedWorkflow
        ? receipt
        : validatedFactSatisfaction(task, assignments, view.evidenceRevision);
    if (
      factSatisfaction && !factSatisfaction.graphFactId &&
      !factSatisfaction.findingRecheckId &&
      !factSatisfaction.workflowObservationId
    ) {
      factSatisfactions.push({
        target: id,
        source: derivedRef(
          "observation",
          origin,
          factSatisfaction.sourceTaskId,
        ),
      });
    }
    index.addNode({
      id,
      sourceId,
      label: text(task.kind, "adaptive task kind"),
      origin,
      kind: "task",
      status: text(task.status, "adaptive task status"),
      ...(task.plannerRound && { plannerRound: task.plannerRound }),
      ...(factSatisfaction && { factSatisfaction }),
      ...(task.decisionHold && { decisionHold: task.decisionHold }),
      ...(task.reason !== undefined && {
        reason: text(task.reason, "adaptive task reason"),
      }),
    });
    index.addEdge(goal, id, "requests");
    const target = task.nodeId === undefined
      ? undefined
      : imported.get(task.nodeId);
    if (target?.kind === "finding") index.addEdge(target.ref, id, "prompted");
    if (task.kind === "review_incident" && task.nodeId !== undefined) {
      const source = text(task.nodeId, "adaptive incident ID");
      const candidate = derivedRef("observation", "assessment", source);
      if (index.hasNode(candidate)) index.addEdge(candidate, id, "prompted");
      else {index.addUnresolved({
          node: id,
          reference: source,
          relation: "prompted",
        });}
    }
  }

  const workflowObservations = addWorkflowObservations(
    index,
    view,
    assignments,
  );
  for (const receipt of rechecks.values()) {
    const assignment = assignments.get(receipt.taskId);
    const evidence = imported.get(receipt.evidenceId)?.ref;
    const originalFinding = imported.get(receipt.graphFindingId)?.ref;
    if (
      !/^worker-recheck:[a-f0-9]{64}$/.test(receipt.id) ||
      receipt.caseId !== view.caseId || receipt.runId !== view.goal.id ||
      receipt.evidenceRevision !== view.evidenceRevision ||
      !assignment || !evidence || !originalFinding ||
      (assignment.nodeId !== receipt.targetId &&
        assignment.nodeId !== receipt.evidenceId)
    ) continue;
    const id = derivedRef("observation", origin, receipt.id);
    index.addNode({
      id,
      sourceId: receipt.id,
      label: "Verified remediation recheck",
      kind: "observation",
      origin,
      remediationRecheck: receipt,
    });
    index.addEdge(derivedRef("task", origin, receipt.taskId), id, "produces");
    index.addEdge(id, evidence, "references");
    index.addEdge(id, originalFinding, "references");
  }
  for (const { task, receipt } of recheckSatisfactions) {
    const id = derivedRef("observation", origin, receipt.id);
    if (index.hasNode(id)) index.addEdge(task, id, "references");
  }
  const factNodes = new Map<string, SentinelWorkerGraphFact>();
  for (const fact of view.graphFacts ?? []) {
    const source = assignments.get(fact.taskId);
    const from = imported.get(fact.relationship.from)?.ref;
    const to = imported.get(fact.relationship.to)?.ref;
    if (
      !/^worker-graph-fact:[a-f0-9]{64}$/.test(fact.id) ||
      factNodes.has(fact.id) || fact.runId !== view.goal.id ||
      fact.evidenceRevision !== view.evidenceRevision ||
      (view.caseId !== undefined && fact.caseId !== view.caseId) ||
      source?.nodeId !== fact.targetId || !from || !to
    ) continue;
    const id = derivedRef("observation", origin, fact.id);
    const { requestId: _requestId, ...graphFact } = fact;
    index.addNode({
      id,
      sourceId: fact.id,
      label: fact.controlVerification
        ? "Verified control outcome"
        : "Verified graph relationship",
      kind: "observation",
      origin,
      graphFact,
    });
    index.addEdge(derivedRef("task", origin, fact.taskId), id, "produces");
    index.addEdge(id, from, "references");
    if (to !== from) index.addEdge(id, to, "references");
    factNodes.set(fact.id, fact);
  }
  const assetDiscoveries = new Map(
    (view.assetDiscoveries ?? []).map((record) => [record.id, record]),
  );
  const reviews = new Map((view.modelReviews ?? []).map((review) => [
    review.taskId,
    review,
  ]));
  const sources = new Set([
    ...reviews.keys(),
    ...view.tasks.flatMap((task) =>
      taskWorkerSources(task).filter(({ kind }) => kind === "model_review")
        .map(({ taskId }) => taskId)
    ),
  ]);
  const workerTraceEdges: { from: string; to: string }[] = [];
  for (const key of sources) {
    const source = text(key, "adaptive review source task");
    const id = derivedRef("observation", origin, `review:${source}`);
    const savedReview = reviews.get(source);
    const assignment = assignments.get(source);
    const modelReview = savedReview && {
      ...savedReview,
      steps: savedReview.steps.map((raw): ModelReview["steps"][number] => {
        const step = projectSentinelTraceMetadata(
          normalizeSentinelWorkflowReviewStep(
            raw,
            view.evidenceRevision ?? NaN,
          ) as ModelReview["steps"][number],
        );
        if (step.sharedAssetDiscovery !== undefined) {
          const { sharedAssetDiscovery: _raw, targetRef: _savedRef, ...saved } =
            step;
          const source = verifiedSharedAssetDiscovery(
            view.caseId,
            assetDiscoveries,
            step,
          );
          if (!source) return saved;
          const targetRef = derivedRef("observation", origin, source.id);
          if (!index.hasNode(targetRef)) {
            index.addNode({
              id: targetRef,
              kind: "observation",
              origin,
              sourceId: source.id,
              label: "Shared asset discovery",
              status: source.status,
              assetDiscovery: source,
            });
          }
          return {
            ...saved,
            targetRef,
            sharedAssetDiscovery: {
              id: source.id,
              version: source.version,
              sourceCaseId: source.sourceCaseId,
              taskId: source.taskId,
              evidenceRevision: source.evidenceRevision,
              sourceDigest: source.sourceDigest,
              evidenceId: source.claim.evidenceId,
            },
          };
        }
        if (step.intermediateWorkflowObservation !== undefined) {
          const {
            intermediateWorkflowObservation: citation,
            targetRef: _savedRef,
            ...saved
          } = step;
          const sourceObservation = citation &&
            workflowObservations.get(citation.observationId);
          if (
            step.tool === "sentinel_intermediate_workflow_observation" &&
            step.outcome === "returned" &&
            step.target === citation?.observationId &&
            sourceObservation &&
            sourceObservation.taskId !== source &&
            citation.sourceTaskId === sourceObservation.taskId &&
            (citation.sourceStepIndex === undefined ||
              citation.sourceStepIndex === sourceObservation.stepIndex) &&
            citation.targetId === sourceObservation.targetId &&
            citation.evidenceRevision === sourceObservation.evidenceRevision &&
            citation.resultSha256 === sourceObservation.receipt.resultSha256
          ) {
            const targetRef = derivedRef(
              "observation",
              origin,
              sourceObservation.id,
            );
            return {
              ...saved,
              targetRef,
              intermediateWorkflowObservation: {
                observationId: sourceObservation.id,
                sourceTaskId: sourceObservation.taskId,
                sourceStepIndex: sourceObservation.stepIndex,
                targetId: sourceObservation.targetId,
                evidenceRevision: sourceObservation.evidenceRevision,
                resultSha256: sourceObservation.receipt.resultSha256,
              },
            };
          }
          return saved;
        }
        if (step.tool === "sentinel_worker_trace_search") {
          const { workerTrace, targetRef: _savedRef, ...saved } = step;
          if (
            step.outcome !== "returned" || !workerTrace ||
            !/^adaptive:[a-f0-9]{64}$/.test(workerTrace.sourceTaskId) ||
            workerTrace.sourceTaskId === source ||
            !Number.isSafeInteger(workerTrace.evidenceRevision) ||
            workerTrace.evidenceRevision < 1 ||
            !Array.isArray(workerTrace.stepIndices) ||
            !workerTrace.stepIndices.length ||
            workerTrace.stepIndices.length > 16 ||
            workerTrace.stepIndices.some((index) =>
              !Number.isSafeInteger(index) || index < 0 || index >= 16
            ) ||
            new Set(workerTrace.stepIndices).size !==
              workerTrace.stepIndices.length
          ) return saved;
          const { sourceTaskId, evidenceRevision, stepIndices } = workerTrace;
          const sourceReview = reviews.get(sourceTaskId);
          if (
            evidenceRevision === view.evidenceRevision &&
            assignments.has(sourceTaskId) && sourceReview &&
            stepIndices.every((index) =>
              sourceReview.steps[index] !== undefined
            )
          ) {
            const targetRef = derivedRef(
              "observation",
              origin,
              `review:${sourceTaskId}`,
            );
            workerTraceEdges.push({ from: id, to: targetRef });
            return {
              ...saved,
              workerTrace: { sourceTaskId, evidenceRevision, stepIndices },
              targetRef,
            };
          }
          return {
            ...saved,
            workerTrace: { sourceTaskId, evidenceRevision, stepIndices },
          };
        }
        if (step.tool !== "sentinel_assigned_target") return step;
        const { assignedTarget, targetRef: _savedRef, ...saved } = step;
        const assignedId = assignment?.nodeId;
        if (
          step.outcome !== "returned" || !assignedId ||
          assignment?.kind === "review_incident" ||
          (step.target !== assignedId &&
            step.target !== assignedId.slice(0, 256))
        ) return saved;
        const target = imported.get(assignedId);
        const receipt = readSentinelAssignedTargetReceipt(
          assignedTarget,
          assignedId,
        );
        return target
          ? {
            ...saved,
            targetRef: target.ref,
            ...(receipt && { assignedTarget: receipt }),
          }
          : saved;
      }),
    };
    index.addNode({
      id,
      sourceId: source,
      label: "Model review",
      origin,
      kind: "observation",
      ...(modelReview && { modelReview }),
    });
    index.addEdge(derivedRef("task", origin, source), id, "produces");
    for (const [stepIndex, step] of (modelReview?.steps ?? []).entries()) {
      if (step.tool === "sentinel_shared_asset_discoveries") {
        if (step.targetRef && step.sharedAssetDiscovery) {
          index.addEdge(id, step.targetRef, "references");
        }
        continue;
      }
      if (step.tool === "sentinel_intermediate_workflow_observation") {
        if (step.targetRef && step.intermediateWorkflowObservation) {
          index.addEdge(id, step.targetRef, "references");
        }
        continue;
      }
      if (step.githubWorkflowRead) {
        const receipt = step.githubWorkflowRead;
        const encodedReceipt = JSON.stringify(receipt);
        const intermediate = [...workflowObservations.values()].find((
          observation,
        ) =>
          observation.taskId === source &&
          observation.stepIndex === stepIndex &&
          JSON.stringify(observation.receipt) === encodedReceipt
        );
        if (intermediate) {
          index.addEdge(
            id,
            derivedRef("observation", origin, intermediate.id),
            "references",
          );
          continue;
        }
        const digest = createHash("sha256").update(encodedReceipt)
          .digest("hex");
        const target = derivedRef(
          "observation",
          origin,
          `github-workflow:${digest}`,
        );
        if (!index.hasNode(target)) {
          index.addNode({
            id: target,
            kind: "observation",
            origin,
            sourceId: `${receipt.repository}/${receipt.workflowId}`,
            label: "GitHub workflow status",
            githubWorkflowRead: receipt,
          });
        }
        index.addEdge(id, target, "references");
        continue;
      }
      if (step.tool === "sentinel_live_workflow_status") continue;
      if (step.tool === "sentinel_worker_trace_search") continue;
      if (!step.target || step.outcome !== "returned") continue;
      if (step.tool === "sentinel_assigned_target") {
        if (step.targetRef) index.addEdge(id, step.targetRef, "references");
        continue;
      }
      if (step.tool === "sentinel_incident_alerts") {
        const candidate = derivedRef("observation", "assessment", step.target);
        if (index.hasNode(candidate)) {
          index.addEdge(id, candidate, "references");
        }
        continue;
      }
      const target = imported.get(step.target)?.ref ??
        (index.hasNode(step.target) ? step.target : undefined);
      if (target && target !== id) index.addEdge(id, target, "references");
    }
  }
  for (const { from, to } of workerTraceEdges) {
    index.addEdge(from, to, "references");
  }

  for (const task of view.tasks) {
    const citation = task.plannerRound?.committedObservation;
    const committed = citation &&
      workflowObservations.get(citation.observationId);
    if (
      citation && committed && committed.targetId === task.nodeId &&
      committed.taskId === citation.sourceTaskId &&
      committed.stepIndex === citation.sourceStepIndex &&
      committed.evidenceRevision === citation.evidenceRevision &&
      committed.receipt.resultSha256 === citation.resultSha256 &&
      task.prerequisites.includes(committed.taskId)
    ) {
      index.addEdge(
        derivedRef("task", origin, task.id),
        derivedRef("observation", origin, committed.id),
        "references",
      );
    }

    const id = derivedRef("task", origin, task.id);
    const futureReceiptId = futureWorkflowSatisfactions.get(task.id);
    if (futureReceiptId && workflowObservations.has(futureReceiptId)) {
      index.addEdge(
        id,
        derivedRef("observation", origin, futureReceiptId),
        "references",
      );
    }
    const factId = task.factSatisfaction?.graphFactId ??
      task.plannerRound?.graphFactId;
    if (factId) {
      const fact = factNodes.get(factId);
      if (
        fact && fact.targetId === task.nodeId &&
        (graphSatisfactions.get(task.id) === factId ||
          (task.plannerRound?.graphFactId === factId &&
            task.prerequisites.includes(fact.taskId)))
      ) {
        index.addEdge(
          id,
          derivedRef("observation", origin, factId),
          "references",
        );
      } else {
        index.addUnresolved({
          node: id,
          reference: factId,
          relation: "references",
        });
      }
    }
    for (
      const priorAssignedTarget
        of task.plannerRound?.priorAssignedTargetCitations ?? []
    ) {
      const key = createHash("sha256").update(
        JSON.stringify(priorAssignedTarget),
      ).digest("hex");
      const ref = derivedRef(
        "observation",
        origin,
        `prior-assigned-target:${key}`,
      );
      if (!index.hasNode(ref)) {
        index.addNode({
          id: ref,
          sourceId: priorAssignedTarget.sourceTaskId,
          origin,
          kind: "observation",
          label: "Prior assigned target evidence",
          priorAssignedTarget,
        });
      }
      index.addEdge(ref, id, "prompted");
      const target = imported.get(priorAssignedTarget.targetId);
      if (target?.kind === "evidence") {
        index.addEdge(ref, target.ref, "references");
      }
    }
    for (
      const { mappingSources: _mappingSources, ...peerFinding }
        of task.plannerRound?.peerFindingCitations ?? []
    ) {
      const key = createHash("sha256").update(JSON.stringify(peerFinding))
        .digest("hex");
      const ref = derivedRef("observation", origin, `peer-finding:${key}`);
      if (!index.hasNode(ref)) {
        index.addNode({
          id: ref,
          sourceId: peerFinding.sourceFindingId,
          kind: "observation",
          origin,
          label: "Reported peer finding",
          peerFinding,
        });
      }
      index.addEdge(ref, id, "prompted");
      const local = imported.get(peerFinding.localAssetId);
      if (local) index.addEdge(ref, local.ref, "references");
    }
    for (
      const prerequisite of list(
        task.prerequisites,
        "adaptive task prerequisites",
      )
    ) {
      index.addEdge(
        id,
        derivedRef(
          "task",
          origin,
          text(prerequisite, "adaptive prerequisite ID"),
        ),
        "requires",
      );
    }

    for (const raw of list(task.evidenceIds, "adaptive task evidence")) {
      const reference = text(raw, "adaptive task evidence ID");
      const evidence = imported.get(reference);
      if (evidence?.kind === "evidence") {
        index.addEdge(evidence.ref, id, "prompted");
      } else {
        const alert = derivedRef("observation", "assessment", reference);
        if (
          (reference.startsWith("case-alert:") ||
            reference.startsWith("incident:")) && index.hasNode(alert)
        ) {
          index.addEdge(alert, id, "prompted");
        } else {
          index.addUnresolved({ node: id, reference, relation: "prompted" });
        }
      }
    }

    if (task.status !== "completed" || task.observation === undefined) continue;
    const target = derivedRef("observation", origin, task.id);
    index.addNode({
      id: target,
      sourceId: task.id,
      label: "Adaptive worker observation",
      origin,
      kind: "observation",
    });
    index.addEdge(id, target, "produces");
    if (
      !task.observation || typeof task.observation !== "object" ||
      Array.isArray(task.observation)
    ) {
      continue;
    }
    const { relatedNodeIds } = task.observation as Record<string, unknown>;
    if (relatedNodeIds === undefined) continue;
    for (
      const raw of list(relatedNodeIds, "adaptive observation node references")
    ) {
      const reference = text(raw, "adaptive observation node reference");
      const node = imported.get(reference);
      if (node) {
        index.addEdge(target, node.ref, "references");
      } else {
        index.addUnresolved({
          node: target,
          reference,
          relation: "references",
        });
      }
    }
  }

  for (const [assignment, review] of reviews) {
    const from = derivedRef("observation", origin, `review:${assignment}`);
    for (const step of review.steps) {
      if (step.tool !== "sentinel_worker_observation" || !step.target) continue;
      const to = derivedRef("observation", origin, step.target);
      if (index.hasNode(to)) index.addEdge(from, to, "references");
    }
  }

  for (const { target, source } of factSatisfactions) {
    index.addEdge(target, source, "references");
  }
  for (
    const { sourceId, targetId, evidenceId }
      of view.verificationReviewSources ?? []
  ) {
    const source = assignments.get(sourceId);
    const target = assignments.get(targetId);
    const from = derivedRef("observation", origin, sourceId);
    const to = derivedRef("task", origin, targetId);
    if (
      source?.kind === "verify_control_coverage" &&
      source.status === "completed" &&
      target?.kind === "review_evidence" && target.nodeId === evidenceId &&
      index.hasNode(from) && index.hasNode(to)
    ) {
      index.addEdge(from, to, "prompted");
    }
  }

  for (const task of view.tasks) {
    const id = derivedRef("task", origin, task.id);
    for (const { taskId, kind } of taskWorkerSources(task)) {
      index.addEdge(
        derivedRef(
          "observation",
          origin,
          kind === "model_review" ? `review:${taskId}` : taskId,
        ),
        id,
        "prompted",
      );
    }
  }
}

/** Build a versioned graph that preserves imported edge types and records derivations separately. */
export function buildSentinelProvenance(
  assessment: unknown,
  adaptive?: AdaptiveProvenanceView,
  focusedAlert?: TelemetryAlert,
  incidentReviews: readonly SentinelIncidentReview[] = [],
  findingReviews: readonly SentinelFindingReview[] = [],
  focusedIncident?: Record<string, unknown>,
  focusedIncidentAlerts: readonly TelemetryAlert[] = [],
  focusedAlertRevisionFeed?: readonly TelemetryAlert[],
) {
  const report = object(assessment, "assessment report");
  if (report.version !== 1) {
    throw new Error("Expected a version 1 Sentinel assessment report");
  }
  const shared = object(report.sharedGraph, "assessment shared graph");
  const index = indexProvenance();
  const { imported, supportingEvidence, resolveAssetId } = importSourceGraph(
    index,
    shared.snapshot,
    findingReviews,
  );
  const selectedAlerts = new Map<string, TelemetryAlert>();
  if (focusedIncident) {
    for (const [offset, raw] of focusedIncidentAlerts.entries()) {
      const alert = parseSentinelTelemetryAlert(raw, offset + 1);
      selectedAlerts.set(sentinelAlertKey(alert), alert);
    }
  }
  if (focusedAlert) {
    selectedAlerts.set(
      sentinelAlertKey(focusedAlert),
      parseSentinelTelemetryAlert(focusedAlert, 1),
    );
  }
  addAssessment(
    index,
    report,
    shared,
    imported,
    supportingEvidence,
    resolveAssetId,
    selectedAlerts,
    focusedAlert && selectedAlerts.get(sentinelAlertKey(focusedAlert)),
  );
  for (const alert of adaptive?.assignedAlerts?.slice(0, 25) ?? []) {
    if (!index.hasNode(sentinelAlertProvenanceId(alert))) {
      addAlertNode(index, imported, alert, resolveAssetId);
    }
  }
  if (adaptive?.assignedIncidents?.length) {
    addIncidentCandidates(index, imported, undefined, {
      candidates: adaptive.assignedIncidents,
    });
  }
  if (focusedIncident) {
    addIncidentCandidates(index, imported, undefined, {
      candidates: [focusedIncident],
    });
    const incident = sentinelIncidentProvenanceId(
      text(focusedIncident.id, "incident ID"),
    );
    let added = 0;
    for (const member of focusedIncidentAlerts) {
      const alert = selectedAlerts.get(sentinelAlertKey(member))!;
      const id = sentinelAlertProvenanceId(alert);
      if (!index.hasNode(id)) {
        if (added >= 25) continue;
        addAlertNode(index, imported, alert, resolveAssetId);
        added++;
      }
      index.addEdge(incident, id, "references");
    }
  }
  if (focusedAlert && focusedAlertRevisionFeed) {
    const sibling = findFocusedAuthenticationSibling(
      focusedAlert,
      focusedAlertRevisionFeed,
    );
    if (sibling && !index.hasNode(sentinelAlertProvenanceId(sibling))) {
      addAlertNode(index, imported, sibling, resolveAssetId);
    }
  }
  linkAuthenticationFanout(index);
  if (adaptive) addAdaptive(index, adaptive, imported);
  for (const review of incidentReviews) {
    const candidate = derivedRef(
      "observation",
      "assessment",
      review.incidentId,
    );
    if (!index.hasNode(candidate)) continue;
    const sourceId = String(review.id);
    const id = `operator:incident-review:${sourceId}`;
    index.addNode({
      id,
      sourceId,
      origin: "assessment",
      kind: "observation",
      label: "Incident review",
      status: review.disposition,
      worker: "operator",
      incidentReview: review,
    });
    index.addEdge(id, candidate, "references");
  }
  return {
    snapshot: index.snapshot,
    overview: index.overview,
    trace: index.trace,
    shortestPath: index.shortestPath,
    alternatePaths: index.alternatePaths,
    inspect: index.inspect,
    searchNodes: index.searchNodes,
    searchReviewSteps: index.searchReviewSteps,
  };
}
