/** Combine original defensive graph records with linked assessment provenance. */

import { taskWorkerSources } from "./adaptive_store.ts";
import { parseSentinelTelemetryAlert } from "./case_report.ts";
import {
  isSentinelAlertSeverity,
  sentinelAlertKey,
  sentinelAlertReference,
  type TelemetryAlert,
} from "./telemetry.ts";
import type {
  SentinelFindingReview,
  SentinelIncidentReview,
  SentinelReviewStep,
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
  readonly steps: readonly (SentinelReviewStep & {
    /** Exact imported provenance ID resolved from the assigned task. */
    readonly targetRef?: string;
  })[];
}

import { createHash } from "node:crypto";
import type {
  AdaptivePeerFindingCitation,
  AdaptivePlannerRound,
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
    readonly peerFinding?: AdaptivePeerFindingCitation;
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

/** An adaptive goal and its current persisted task list. */
export interface AdaptiveProvenanceView {
  readonly goal: { readonly id: string; readonly label: string };
  readonly assignedIncidents?: readonly Record<string, unknown>[];
  readonly assignedAlerts?: readonly TelemetryAlert[];
  readonly modelReviews?: readonly ModelReview[];
  readonly verificationReviewSources?: readonly {
    targetId: string;
    sourceId: string;
    evidenceId: string;
  }[];
  readonly tasks: readonly {
    readonly id: string;
    readonly nodeId?: string;
    readonly kind: string;
    readonly status: string;
    readonly prerequisites: readonly string[];
    readonly evidenceIds: readonly string[];
    readonly observation?: unknown;
    readonly reviewedFrom?: string;
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
            step.resultSnapshot?.excerpt,
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
    hasNode: (id: string) => nodes.has(id),
    addEdge,
    addUnresolved,
    snapshot,
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

  for (const task of view.tasks) {
    const sourceId = text(task.id, "adaptive task ID");
    const id = derivedRef("task", origin, sourceId);
    index.addNode({
      id,
      sourceId,
      label: text(task.kind, "adaptive task kind"),
      origin,
      kind: "task",
      status: text(task.status, "adaptive task status"),
      ...(task.plannerRound && { plannerRound: task.plannerRound }),
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

  const reviews = new Map((view.modelReviews ?? []).map((review) => [
    review.taskId,
    review,
  ]));
  const assignments = new Map(view.tasks.map((task) => [task.id, task]));
  const sources = new Set([
    ...reviews.keys(),
    ...view.tasks.flatMap((task) =>
      taskWorkerSources(task).filter(({ kind }) => kind === "model_review")
        .map(({ taskId }) => taskId)
    ),
  ]);
  for (const key of sources) {
    const source = text(key, "adaptive review source task");
    const id = derivedRef("observation", origin, `review:${source}`);
    const savedReview = reviews.get(source);
    const assignment = assignments.get(source);
    const modelReview = savedReview && {
      ...savedReview,
      steps: savedReview.steps.map((step): ModelReview["steps"][number] => {
        if (step.tool !== "sentinel_assigned_target") return step;
        const { targetRef: _savedRef, ...saved } = step;
        const assignedId = assignment?.nodeId;
        if (
          step.outcome !== "returned" || !assignedId ||
          assignment?.kind === "review_incident" ||
          (step.target !== assignedId &&
            step.target !== assignedId.slice(0, 256))
        ) return saved;
        const target = imported.get(assignedId);
        return target ? { ...saved, targetRef: target.ref } : saved;
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
    for (const step of modelReview?.steps ?? []) {
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

  for (const task of view.tasks) {
    const id = derivedRef("task", origin, task.id);
    for (const peerFinding of task.plannerRound?.peerFindingCitations ?? []) {
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

  const tasksById = new Map(view.tasks.map((task) => [task.id, task]));
  for (
    const { sourceId, targetId, evidenceId }
      of view.verificationReviewSources ?? []
  ) {
    const source = tasksById.get(sourceId);
    const target = tasksById.get(targetId);
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
    trace: index.trace,
    shortestPath: index.shortestPath,
    alternatePaths: index.alternatePaths,
    inspect: index.inspect,
    searchNodes: index.searchNodes,
    searchReviewSteps: index.searchReviewSteps,
  };
}
