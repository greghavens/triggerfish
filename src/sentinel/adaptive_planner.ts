/** Derive bounded defensive work from graph evidence and prior worker observations. */
import { createHash } from "node:crypto";
import type { readSentinelAssessment } from "./assessment_store.ts";
import {
  type AdaptiveIncidentImpactSource,
  type AdaptivePeerFindingCitation,
  type AdaptivePriorAssignedTargetCitation,
  type AdaptiveSourceKind,
  type AdaptiveTask,
  type AdaptiveTaskRequest,
  type AdaptiveVerificationReviewCandidate,
  type AdaptiveWorkerSource,
  sentinelAdaptiveTaskId,
} from "./adaptive_store.ts";
import { compareSentinelIncidentPriority } from "./incident_correlation.ts";
import { loadSentinelGraph } from "./graph.ts";
import { parseSentinelTelemetryAlert } from "./case_report.ts";
import { sentinelAlertReference } from "./telemetry.ts";
import { indexSharedSentinelTopologyEvidence } from "./shared_topology_work.ts";

type State = NonNullable<ReturnType<typeof readSentinelAssessment>>;
type Graph = ReturnType<typeof loadSentinelGraph>;
const EPOCH = "1970-01-01T00:00:00.000Z";
const FAILED_VERIFICATION_REVIEW =
  "Inspect the exact evidence of a recorded mitigation verification failure.";

export function peerFindingCitationKey(
  value: Partial<AdaptivePeerFindingCitation>,
): string {
  return JSON.stringify([
    value.localAssetId,
    value.sourceCaseId,
    value.sourceAssetId,
    value.sourceFindingId,
    value.snapshotDigest,
  ]);
}

interface Finding {
  readonly id: string;
  readonly severity: string;
  readonly assets: readonly string[];
  readonly evidence: readonly string[];
  readonly controls: readonly string[];
}

export function sentinelIncidentCandidates(
  state: State,
): Record<string, unknown>[] {
  const facts = state.result?.sharedGraph.observations.find(({ task }) =>
    task === "incident_correlation"
  )?.facts;
  return Array.isArray(facts?.candidates) ? facts.candidates : [];
}

export function sentinelIsolatedPriorityAlerts(state: State) {
  const facts = state.result?.sharedGraph.observations.find(({ task }) =>
    task === "incident_correlation"
  )?.facts;
  return Array.isArray(facts?.isolatedPriorityAlerts)
    ? facts.isolatedPriorityAlerts
    : [];
}

export function adaptiveRevision(state: State, legacy = false): string {
  return createHash("sha256").update(
    JSON.stringify([
      state.plan.runId,
      state.plan.goal,
      state.result?.revision,
      ...(legacy ? [] : [state.revision]),
    ]),
  ).digest("hex");
}

function findingInScope(finding: Finding, focus: string | undefined) {
  return !focus ||
    [finding.id, ...finding.assets, ...finding.evidence, ...finding.controls]
      .includes(focus);
}

type ControlCoverage = ReturnType<Graph["controlCoverage"]>;

function scopedVerificationEvidence(
  finding: Finding,
  coverage: ControlCoverage,
  focus: string | undefined,
) {
  const exactCheck = coverage.controls.some(({ controlId, evidenceId }) =>
    focus !== undefined && (focus === controlId || focus === evidenceId)
  );
  const entireFinding = !focus ||
    (!exactCheck &&
      [finding.id, ...finding.assets, ...finding.evidence].includes(focus));
  const failures = new Set<string>();
  const stale = new Set<string>();
  for (const { status, evidenceId, controlId } of coverage.controls) {
    if (
      evidenceId === undefined ||
      !(entireFinding || focus === controlId || focus === evidenceId)
    ) continue;
    if (status === "fail") failures.add(evidenceId);
    if (status === "stale") stale.add(evidenceId);
  }
  return { failures: [...failures], stale: [...stale] };
}

function controlEvaluationAt(state: State): string {
  return (state.result?.controlEvaluationAt ?? state.updatedAt) || EPOCH;
}

function trafficKind(id: string): "HTTP" | "DNS" | undefined {
  if (id.startsWith("har:evidence:")) return "HTTP";
  if (id.startsWith("dns:evidence:")) return "DNS";
}

function captureTime(label: string): string {
  return / at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(label)
    ?.[1] ?? "";
}

export function incidentMatchesSentinelFocus(
  incident: Record<string, unknown>,
  focus: string | undefined,
): boolean {
  return !focus || incident.asset === focus ||
    (Array.isArray(incident.relatedAssetIds) &&
      incident.relatedAssetIds.includes(focus)) ||
    (Array.isArray(incident.findingIds) && incident.findingIds.includes(focus));
}

export function planSentinelTasks(
  state: State,
  tasks: readonly AdaptiveTask[],
  revision = adaptiveRevision(state),
  shouldPlan: (task: Pick<AdaptiveTaskRequest, "kind" | "nodeId">) => boolean =
    () => true,
  incidentCandidates = sentinelIncidentCandidates(state),
  isolated = sentinelIsolatedPriorityAlerts(state),
  recordIncidentSource?: (source: AdaptiveIncidentImpactSource) => void,
  recordVerificationSource?: (
    source: AdaptiveVerificationReviewCandidate,
  ) => void,
): AdaptiveTaskRequest[] {
  const snapshot = state.result?.sharedGraph.snapshot;
  if (!snapshot) return [];
  const graph = loadSentinelGraph(snapshot);
  const goal = state.plan.goal ?? "";
  const focus = state.plan.traceNode ?? state.plan.impactAsset ??
    snapshot.nodes.find(({ id }) =>
      goal.trim() === id || goal.includes(`"${id}"`)
    )?.id;
  const findings = graph.report();
  const findingIndex = new Map(
    findings.map((finding) => [finding.id, finding]),
  );
  const evidenceTime = controlEvaluationAt(state);
  const coverageIndex = new Map<string, ControlCoverage>();
  function controlCoverage(findingId: string) {
    const saved = coverageIndex.get(findingId);
    if (saved) return saved;
    const value = graph.controlCoverage(findingId, evidenceTime);
    coverageIndex.set(findingId, value);
    return value;
  }
  const failingChecks = new Map<string, string[]>();
  const staleChecks = new Map<string, string[]>();
  if (snapshot.edges.some(({ relation }) => relation === "verifies")) {
    for (const finding of findings) {
      const { failures, stale } = scopedVerificationEvidence(
        finding,
        controlCoverage(finding.id),
        focus,
      );
      if (failures.length) failingChecks.set(finding.id, failures);
      if (stale.length) staleChecks.set(finding.id, stale);
    }
  }
  const planned = new Map<string, AdaptiveTaskRequest>();
  const existingIds = new Set(tasks.map(({ id }) => id));
  const finished = tasks.filter(({ status }) => status === "completed");
  const add = (request: AdaptiveTaskRequest) => {
    if (!shouldPlan(request)) return false;
    if (
      request.nodeId &&
      (!request.nodeId.trim() || request.nodeId.length > 4096 ||
        request.nodeId.includes("\x00"))
    ) return false;
    const id = sentinelAdaptiveTaskId(revision, request);
    if (existingIds.has(id) || planned.has(id)) return false;
    planned.set(id, request);
    return true;
  };

  // Incidents create concrete assignments for the asset and evidence they reference.
  let incidentSlots = 12 -
    tasks.filter((task) =>
      task.kind === "review_incident" &&
      (task.status === "running" ||
        (task.status === "queued" && shouldPlan(task)))
    ).length;
  for (
    const candidate of incidentCandidates.toSorted(
      compareSentinelIncidentPriority,
    )
  ) {
    if (incidentSlots <= 0) break;
    if (
      typeof candidate.id !== "string" || typeof candidate.asset !== "string"
    ) continue;
    if (!incidentMatchesSentinelFocus(candidate, focus)) continue;
    if (
      add({
        kind: "review_incident",
        nodeId: candidate.id,
        reason: Array.isArray(candidate.relatedAssetIds)
          ? "Distinct signals converged on directly related case assets within the correlation window."
          : "Distinct signals converged on this asset within the correlation window.",
        evidenceIds: Array.isArray(candidate.evidenceIds)
          ? candidate.evidenceIds.slice(0, 12)
          : [],
      })
    ) incidentSlots--;
  }

  const byAsset = new Map<string, Set<string>>();
  for (const [index, raw] of isolated.entries()) {
    const alert = parseSentinelTelemetryAlert(raw, index + 1);
    const asset = graph.resolveAssetId(alert.asset);
    if (!asset || (focus && focus !== asset)) continue;
    const references = byAsset.get(asset) ?? new Set<string>();
    references.add(sentinelAlertReference(alert));
    byAsset.set(asset, references);
  }
  let impactSlots = 6 -
    tasks.filter((task) =>
      task.kind === "impact" && task.depth === 1 && task.nodeId &&
      byAsset.has(task.nodeId) &&
      (task.status === "queued" || task.status === "running")
    ).length;
  for (const [nodeId, references] of byAsset) {
    if (impactSlots <= 0) break;
    if (
      add({
        kind: "impact",
        nodeId,
        depth: 1,
        evidenceIds: [...references].slice(0, 12),
        reason:
          "A high-priority alert on this asset warrants a review of its immediate dependent assets.",
      })
    ) impactSlots--;
  }

  let findingSlots = 18 -
    tasks.filter((task) =>
      task.kind === "review_finding" &&
      (task.status === "running" ||
        (task.status === "queued" && shouldPlan(task)))
    ).length;
  const highSeverity = ({ severity }: Finding) =>
    severity === "critical" || severity === "high";
  const priority = (finding: Finding) =>
    failingChecks.has(finding.id)
      ? 3
      : highSeverity(finding)
      ? 2
      : staleChecks.has(finding.id)
      ? 1
      : 0;
  const rankedFindings = findings.toSorted((left, right) =>
    priority(right) - priority(left)
  );
  for (const finding of rankedFindings) {
    if (findingSlots <= 0) break;
    const failureEvidence = failingChecks.get(finding.id) ?? [];
    const staleEvidence = staleChecks.get(finding.id) ?? [];
    const verificationEvidence = [...failureEvidence, ...staleEvidence];
    if (!verificationEvidence.length && !findingInScope(finding, focus)) {
      continue;
    }
    if (
      !verificationEvidence.length && !focus && !highSeverity(finding) &&
      finding.controls.length && finding.evidence.length
    ) continue;
    if (
      add({
        kind: "review_finding",
        nodeId: finding.id,
        reason: failureEvidence.length
          ? "A current mitigation verification failed for this finding."
          : staleEvidence.length
          ? "The recorded mitigation verification has expired for this finding."
          : finding.evidence.length
          ? "Prioritize the reported finding and review its linked evidence."
          : "The finding has no linked supporting evidence.",
        evidenceIds: [
          ...new Set([...verificationEvidence, ...finding.evidence]),
        ]
          .slice(0, 12),
      })
    ) findingSlots--;
  }

  const captured = new Map(snapshot.nodes.flatMap((node) => {
    const kind = node.kind === "evidence" ? trafficKind(node.id) : undefined;
    return kind ? [[node.id, { ...node, kind }] as const] : [];
  }));
  const capturedEdges = snapshot.edges.filter(({ relation, from }) =>
    relation === "observed_on" && captured.has(from)
  );
  const latestByAsset = new Map<
    string,
    { id: string; kind: "HTTP" | "DNS"; label: string }
  >();
  for (const { from, to } of capturedEdges) {
    if (focus && focus !== to && focus !== from) continue;
    const observation = captured.get(from)!;
    const key = JSON.stringify([to, observation.kind]);
    const previous = latestByAsset.get(key);
    if (
      !previous ||
      captureTime(observation.label) > captureTime(previous.label) ||
      (captureTime(observation.label) === captureTime(previous.label) &&
        observation.id < previous.id)
    ) {
      latestByAsset.set(key, observation);
    }
  }
  const selected = [...latestByAsset.values()].sort((a, b) =>
    captureTime(b.label).localeCompare(captureTime(a.label)) ||
    a.id.localeCompare(b.id)
  );
  let trafficSlots = 6 -
    tasks.filter((task) =>
      task.kind === "review_evidence" && task.nodeId &&
      captured.has(task.nodeId) &&
      (task.status === "running" ||
        (task.status === "queued" && shouldPlan(task)))
    ).length;
  for (const { id, kind } of selected) {
    if (trafficSlots <= 0) break;
    if (
      add({
        kind: "review_evidence",
        nodeId: id,
        evidenceIds: [id],
        reason: `Review recent ${kind} evidence associated with a case asset.`,
      })
    ) trafficSlots--;
  }

  const assetIds = new Set(
    snapshot.nodes.filter(({ kind }) => kind === "asset").map(({ id }) => id),
  );
  const focusAssets = focus && !assetIds.has(focus)
    ? new Set(findingIndex.get(focus)?.assets ?? [])
    : undefined;
  const sharedEvidence = indexSharedSentinelTopologyEvidence(snapshot);
  const topologyTargets = ({ id, from, to }: {
    id: string;
    from: string;
    to: string;
  }) =>
    [...new Set([from, to])].filter((asset) =>
      !focus || focus === id || focus === asset || focusAssets?.has(asset)
    );
  const topologyReviews = [...sharedEvidence.values()].filter(
    (item) => topologyTargets(item).length > 0,
  ).sort((a, b) => a.id.localeCompare(b.id));
  let topologySlots = 6 -
    tasks.filter((task) =>
      task.kind === "review_evidence" && task.nodeId &&
      sharedEvidence.has(task.nodeId) &&
      (task.status === "queued" || task.status === "running")
    ).length;
  for (const { id } of topologyReviews) {
    if (topologySlots <= 0) break;
    if (
      add({
        kind: "review_evidence",
        nodeId: id,
        evidenceIds: [id],
        reason: "Review the cited source of a shared asset relationship.",
      })
    ) topologySlots--;
  }
  // Follow-up work depends on a completed worker and on what that worker found.
  let failedEvidenceSlots = 6 -
    tasks.filter((task) =>
      task.kind === "review_evidence" &&
      task.reason === FAILED_VERIFICATION_REVIEW &&
      (task.status === "running" ||
        (task.status === "queued" && shouldPlan(task)))
    ).length;
  for (const task of finished) {
    if (!shouldPlan(task)) continue;
    const result = task.observation as Record<string, unknown> | undefined;
    if (!result) continue;
    if (task.kind === "review_finding") {
      let finding = result.finding as Finding | undefined;
      if (
        !finding && task.nodeId && task.revision === revision &&
        typeof result.resultDigest === "string" &&
        /^[a-f0-9]{64}$/.test(result.resultDigest)
      ) {
        // The runtime stores only a digest when the worker result is too large.
        // Recover facts from this pinned snapshot only if they reproduce that digest.
        const candidate = findingIndex.get(task.nodeId);
        if (
          candidate && createHash("sha256")
              .update(JSON.stringify(findingObservation(candidate)))
              .digest("hex") === result.resultDigest
        ) {
          finding = candidate;
        }
      }
      if (
        !finding || finding.id !== task.nodeId || !findingIndex.has(finding.id)
      ) continue;
      const controlEvidence = controlCoverage(finding.id);
      const failedRecords = failingChecks.get(finding.id) ?? [];
      if (controlEvidence.status !== "pass") {
        add({
          kind: "verify_control_coverage",
          nodeId: finding.id,
          prerequisites: [task.id],
          evidenceIds: [
            ...new Set([
              ...failedRecords,
              ...(staleChecks.get(finding.id) ?? []),
              ...controlEvidence.controls.flatMap(({ evidenceId }) =>
                evidenceId === undefined ? [] : [evidenceId]
              ),
            ]),
          ].slice(0, 12),
          reason: controlEvidence.status === "no_control_link"
            ? "The finding review found no linked mitigation control."
            : "Review the recorded verification status of linked mitigation controls.",
        });
      }
      for (
        const nodeId of finding.evidence.filter((id) =>
          !failedRecords.includes(id)
        ).slice(0, 3)
      ) {
        add({
          kind: "review_evidence",
          nodeId,
          prerequisites: [task.id],
          evidenceIds: [nodeId],
          reason:
            "The finding review identified supporting evidence to examine.",
        });
      }
      for (const nodeId of finding.assets.slice(0, 2)) {
        add({
          kind: "trace",
          nodeId,
          depth: 2,
          prerequisites: [task.id],
          reason: "The finding review identified this affected asset.",
        });
      }
    } else if (
      task.kind === "verify_control_coverage" &&
      task.nodeId &&
      task.revision === revision
    ) {
      const finding = findingIndex.get(task.nodeId);
      const failedRecords = failingChecks.get(task.nodeId);
      if (!finding || !failedRecords?.length) continue;
      const verification = controlCoverage(finding.id);
      // An older, replaced or oversized result cannot imply a failure here
      // unless its recorded facts match the current immutable revision.
      const matched = JSON.stringify(result.controlVerification) ===
          JSON.stringify(verification) ||
        (typeof result.resultDigest === "string" &&
          createHash("sha256")
              .update(
                JSON.stringify(verificationObservation(finding, verification)),
              )
              .digest("hex") === result.resultDigest);
      if (!matched) continue;
      const sourceObservationDigest = recordVerificationSource &&
        createHash("sha256").update(JSON.stringify(result)).digest("hex");
      for (const nodeId of failedRecords) {
        const request: AdaptiveTaskRequest = {
          kind: "review_evidence",
          nodeId,
          prerequisites: [task.id],
          evidenceIds: [nodeId],
          reason: FAILED_VERIFICATION_REVIEW,
        };
        if (!shouldPlan(request)) continue;
        const targetId = sentinelAdaptiveTaskId(revision, request);
        if (!existingIds.has(targetId) && !planned.has(targetId)) {
          if (failedEvidenceSlots <= 0 || !add(request)) continue;
          failedEvidenceSlots--;
        }
        if (sourceObservationDigest) {
          recordVerificationSource?.({
            targetId,
            sourceId: task.id,
            evidenceId: nodeId,
            sourceObservationDigest,
          });
        }
      }
    } else if (
      task.kind === "review_evidence" && task.nodeId &&
      captured.has(task.nodeId)
    ) {
      const targets = capturedEdges.filter(({ from, to }) =>
        from === task.nodeId && (!focus || focus === to || focus === from)
      ).map(({ to }) => to);
      for (const nodeId of targets.slice(0, 2)) {
        add({
          kind: "trace",
          nodeId,
          depth: 2,
          prerequisites: [task.id],
          evidenceIds: [task.nodeId],
          reason:
            "The observation review identified a captured asset with graph relationships to inspect.",
        });
      }
    } else if (task.kind === "review_evidence" && task.nodeId) {
      const topology = sharedEvidence.get(task.nodeId);
      if (!topology) continue;
      for (const nodeId of topologyTargets(topology)) {
        add({
          kind: "trace",
          nodeId,
          depth: 1,
          prerequisites: [task.id],
          evidenceIds: [task.nodeId],
          reason:
            "The shared relationship review identified this local endpoint.",
        });
      }
    } else if (
      task.kind === "review_incident" && typeof result.asset === "string"
    ) {
      const related = Array.isArray(result.relatedAssetIds)
        ? result.relatedAssetIds
        : [];
      for (const nodeId of new Set([result.asset, ...related])) {
        if (
          typeof nodeId !== "string" || !assetIds.has(nodeId) ||
          (focus && nodeId !== focus && !focusAssets?.has(nodeId))
        ) continue;
        const request: AdaptiveTaskRequest = {
          kind: "impact",
          nodeId,
          depth: 2,
          prerequisites: [task.id],
          reason:
            "The incident review identified a graph asset whose dependents need review.",
        };
        if (shouldPlan(request)) {
          recordIncidentSource?.({
            sourceId: task.id,
            targetId: sentinelAdaptiveTaskId(revision, request),
          });
          add(request);
        }
      }
    }
  }

  return [...planned.values()].slice(0, 64);
}

function requireGraph(state: State): Graph {
  const snapshot = state.result?.sharedGraph.snapshot;
  if (!snapshot) throw new Error("Assessment graph unavailable");
  return loadSentinelGraph(snapshot);
}

type ReportedFinding = ReturnType<Graph["report"]>[number];

function findingObservation(finding: ReportedFinding) {
  return {
    relatedNodeIds: [
      finding.id,
      ...finding.assets,
      ...finding.controls,
      ...finding.evidence,
    ].slice(0, 50),
    finding,
  };
}

function verificationObservation(
  finding: ReportedFinding,
  verification: ControlCoverage,
) {
  const observation = findingObservation(finding);
  return {
    ...observation,
    relatedNodeIds: [
      ...new Set([
        finding.id,
        ...verification.controls.flatMap(({ controlId, evidenceId }) =>
          evidenceId === undefined ? [controlId] : [controlId, evidenceId]
        ),
        ...observation.relatedNodeIds,
      ]),
    ].slice(0, 50),
    coverage: verification.status,
    controlVerification: verification,
  };
}

const MAX_OBSERVATION_NODES = 24;
const MAX_OBSERVATION_EDGES = 40;
// Reserve room inside the gateway's 12,000-character worker observation limit.
const GRAPH_OBSERVATION_SAMPLE_CHARS = 11_000;

function graphObservationSample<
  Node extends { readonly id: string; readonly distance: number },
  Edge extends { readonly from: string; readonly to: string },
>(
  nodes: readonly Node[],
  edges: readonly Edge[],
  direction: "both" | "reverse",
) {
  const candidates = nodes.slice(0, MAX_OBSERVATION_NODES);
  const distances = new Map(
    candidates.map(({ id, distance }) => [id, distance]),
  );
  const induced = edges.filter(({ from, to }) =>
    distances.has(from) && distances.has(to)
  );
  const predecessor = new Map<string, Edge>();
  for (const edge of induced) {
    const from = distances.get(edge.from)!;
    const to = distances.get(edge.to)!;
    const child = from === to + 1
      ? edge.from
      : direction === "both" && to === from + 1
      ? edge.to
      : undefined;
    if (child && !predecessor.has(child)) predecessor.set(child, edge);
  }

  // Budget the duplicate ID list too. It backs exact graph citations from
  // worker observations; IDs and node metadata are retained without edits.
  const sample: Node[] = [];
  const selected = new Set<Edge>();
  let characters = 0;
  for (const node of candidates) {
    const edge = predecessor.get(node.id);
    const cost = JSON.stringify(node).length + JSON.stringify(node.id).length +
      2 + (edge ? JSON.stringify(edge).length + 1 : 0);
    if (characters + cost > GRAPH_OBSERVATION_SAMPLE_CHARS) break;
    sample.push(node);
    if (edge) selected.add(edge);
    characters += cost;
  }

  const retained = new Set(sample.map(({ id }) => id));
  for (const edge of induced) {
    if (selected.size === MAX_OBSERVATION_EDGES) break;
    if (
      selected.has(edge) || !retained.has(edge.from) || !retained.has(edge.to)
    ) {
      continue;
    }
    const cost = JSON.stringify(edge).length + 1;
    if (characters + cost <= GRAPH_OBSERVATION_SAMPLE_CHARS) {
      selected.add(edge);
      characters += cost;
    }
  }
  return {
    relatedNodeIds: sample.map(({ id }) => id),
    nodes: sample,
    edges: induced.filter((edge) => selected.has(edge)),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    truncated: sample.length !== nodes.length || selected.size !== edges.length,
  };
}

export function executeSentinelTask(
  state: State,
  task: AdaptiveTask,
  readIncident?: (id: string) => Record<string, unknown> | undefined,
) {
  const graph = requireGraph(state);
  const target = task.nodeId ?? "";
  switch (task.kind) {
    case "review_finding":
    case "verify_control_coverage": {
      const finding = graph.report().find(({ id }) => id === target);
      if (!finding) throw new Error("The selected finding is unavailable");
      if (task.kind === "review_finding") return findingObservation(finding);
      return verificationObservation(
        finding,
        graph.controlCoverage(target, controlEvaluationAt(state)),
      );
    }
    case "review_evidence":
    case "trace": {
      const trace = graph.trace(target, task.depth ?? 1);
      const { relatedNodeIds, ...result } = graphObservationSample(
        trace.nodes,
        trace.edges,
        "both",
      );
      return {
        relatedNodeIds,
        trace: result,
      };
    }
    case "impact": {
      const impact = graph.impact(target, task.depth ?? 2);
      const {
        relatedNodeIds,
        nodes: assets,
        nodeCount: assetCount,
        ...result
      } = graphObservationSample(impact.assets, impact.edges, "reverse");
      return {
        relatedNodeIds,
        impact: { assets, assetCount, ...result },
      };
    }
    case "review_incident": {
      const candidate =
        sentinelIncidentCandidates(state).find(({ id }) => id === target) ??
          readIncident?.(target);
      if (!candidate) throw new Error("The selected incident is unavailable");
      const findings = Array.isArray(candidate.findingIds)
        ? candidate.findingIds
        : [];
      return {
        ...candidate,
        relatedNodeIds: [
          ...new Set([
            candidate.asset,
            ...(Array.isArray(candidate.relatedAssetIds)
              ? candidate.relatedAssetIds
              : []),
            ...findings,
          ]),
        ].filter((
          id,
        ): id is string => typeof id === "string").slice(0, 24),
      };
    }
    default: {
      const facts = state.result?.sharedGraph.observations.find((
        { task: id },
      ) => id === task.kind)?.facts;
      if (!facts) {
        throw new Error("The selected assessment observation is unavailable");
      }
      return facts;
    }
  }
}

export const MODEL_ASSIGNMENT_REASON =
  "The planner selected this graph record for the operator's defensive goal.";

/** Accept only known defensive analyses against IDs present in this revision. */
export function acceptSentinelPlanSuggestions(
  state: State,
  response: string,
  revision = adaptiveRevision(state),
  supplementalIncident?: Record<string, unknown>,
): AdaptiveTaskRequest[] {
  return validateSentinelPlanSuggestions(
    state,
    response,
    revision,
    supplementalIncident,
  ) ?? [];
}

/** Undefined identifies malformed output or a nonempty plan with no valid tasks. */
export function validateSentinelPlanSuggestions(
  state: State,
  response: string,
  revision = adaptiveRevision(state),
  supplementalIncident?: Record<string, unknown>,
  incidentContext = sentinelIncidentCandidates(state),
  observationSources: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  reviewSources: ReadonlySet<string> = new Set(),
  upstreamAlerts: ReadonlyMap<string, string> = new Map(),
  peerFindings: ReadonlyMap<string, AdaptivePeerFindingCitation> = new Map(),
  modelReviewEvidence: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  carriedEvidence: ReadonlyMap<
    string,
    readonly AdaptivePriorAssignedTargetCitation[]
  > = new Map(),
):
  | (AdaptiveTaskRequest & {
    sourceKind?: AdaptiveSourceKind;
    workerSources?: readonly AdaptiveWorkerSource[];
    upstreamCheckId?: string;
    peerFindingCitations?: readonly AdaptivePeerFindingCitation[];
  })[]
  | undefined {
  if (response.length > 8_000) return undefined;
  const snapshot = state.result?.sharedGraph.snapshot;
  if (!snapshot) return undefined;
  const text = response.trim().replace(
    /^```(?:json)?\s*([\s\S]*?)\s*```$/i,
    "$1",
  );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length > 8) return undefined;
  const nodeKinds = new Map(snapshot.nodes.map(({ id, kind }) => [id, kind]));
  const incidents = new Map(
    incidentContext.map((
      candidate,
    ) => [candidate.id, candidate]),
  );
  if (supplementalIncident) {
    incidents.set(supplementalIncident.id, supplementalIncident);
  }
  const explicitScope = state.plan.traceNode ?? state.plan.impactAsset;
  const tasks: (AdaptiveTaskRequest & {
    sourceKind?: AdaptiveSourceKind;
    workerSources?: readonly AdaptiveWorkerSource[];
    upstreamCheckId?: string;
    peerFindingCitations?: readonly AdaptivePeerFindingCitation[];
  })[] = [];
  const accepted = new Map<number, string>();
  for (const [index, item] of raw.entries()) {
    if (
      !item || typeof item !== "object" || typeof item.nodeId !== "string" ||
      (!item.nodeId.trim() || item.nodeId.length > 4096 ||
        item.nodeId.includes("\x00"))
    ) continue;
    const { nodeId, kind } = item;
    const incident = kind === "review_incident"
      ? incidents.get(nodeId)
      : undefined;
    if (
      explicitScope && nodeId !== explicitScope &&
      (!incident || !incidentMatchesSentinelFocus(incident, explicitScope))
    ) continue;
    const dependencies: unknown = item.dependsOn ?? [];
    if (
      !Array.isArray(dependencies) || dependencies.length > 4 ||
      dependencies.some((dependency) =>
        !Number.isSafeInteger(dependency) || !accepted.has(dependency)
      )
    ) continue;
    const source = item.sourceTaskId;
    const sourceKind = item.sourceKind;
    const carried = item.priorAssignedTargetCitation;
    const exactCarriedCitation = (
      taskId: unknown,
      kind: unknown,
      value: unknown,
    ) =>
      typeof taskId === "string" && kind === "worker_result" && value &&
        typeof value === "object"
        ? carriedEvidence.get(taskId)?.find((citation) => {
          const carried = value as Partial<AdaptivePriorAssignedTargetCitation>;
          return (
            citation.targetId === nodeId &&
            citation.targetId === carried.targetId &&
            citation.sourceTaskId === carried.sourceTaskId &&
            citation.evidenceRevision === carried.evidenceRevision &&
            citation.stepIndex === carried.stepIndex
          );
        })
        : undefined;
    const carriedCitation = exactCarriedCitation(source, sourceKind, carried);
    if (carried !== undefined && !carriedCitation) continue;
    const supports = (taskId: string, kind: unknown) =>
      observationSources.get(taskId)?.has(nodeId) ||
      (kind === "model_review" &&
        modelReviewEvidence.get(taskId)?.has(nodeId));
    if (
      sourceKind !== undefined &&
      (typeof source !== "string" ||
        (sourceKind !== "worker_result" && sourceKind !== "model_review") ||
        (sourceKind === "model_review" && !reviewSources.has(source)))
    ) continue;
    if (
      source !== undefined &&
      (typeof source !== "string" ||
        !supports(source, sourceKind) ||
        dependencies.length === 4)
    ) continue;
    const workerSources: (AdaptiveWorkerSource & {
      priorAssignedTargetCitation?: unknown;
    })[] | undefined = item.workerSources;
    if (
      workerSources !== undefined && (
        source !== undefined || sourceKind !== undefined ||
        !Array.isArray(workerSources) || !workerSources.length ||
        dependencies.length + workerSources.length > 4 ||
        workerSources.some((citation) =>
          !citation || typeof citation.taskId !== "string" ||
          !supports(citation.taskId, citation.kind) ||
          (citation.priorAssignedTargetCitation !== undefined &&
            !exactCarriedCitation(
              citation.taskId,
              citation.kind,
              citation.priorAssignedTargetCitation,
            )) ||
          (citation.kind !== "worker_result" &&
            citation.kind !== "model_review") ||
          (citation.kind === "model_review" &&
            !reviewSources.has(citation.taskId))
        ) || new Set(workerSources.map(({ taskId }) =>
            taskId
          )).size !== workerSources.length
      )
    ) continue;
    const { upstreamCheckId, sourceAlertId } = item;
    if (
      (upstreamCheckId !== undefined || sourceAlertId !== undefined) &&
      (nodeKinds.get(nodeId) !== "asset" ||
        typeof upstreamCheckId !== "string" ||
        typeof sourceAlertId !== "string" ||
        (kind !== "trace" && kind !== "impact") ||
        upstreamAlerts.get(JSON.stringify([upstreamCheckId, sourceAlertId])) !==
          nodeId)
    ) continue;
    const nodeKind = nodeKinds.get(nodeId);
    const peerFinding = item.peerFinding && typeof item.peerFinding === "object"
      ? peerFindings.get(peerFindingCitationKey(item.peerFinding))
      : undefined;
    if (
      item.peerFinding !== undefined &&
      (!peerFinding || peerFinding.localAssetId !== nodeId ||
        nodeKind !== "asset" || (kind !== "trace" && kind !== "impact"))
    ) continue;
    const reason = MODEL_ASSIGNMENT_REASON;
    const prerequisites = [
      ...new Set([
        ...dependencies.map((dependency) => accepted.get(dependency)!),
        ...(typeof source === "string" ? [source] : []),
        ...(workerSources?.map(({ taskId }) => taskId) ?? []),
      ]),
    ];
    let task: AdaptiveTaskRequest | undefined;
    if (kind === "review_incident" && incident) {
      task = {
        kind,
        nodeId,
        reason,
        prerequisites,
        evidenceIds: Array.isArray(incident.evidenceIds)
          ? incident.evidenceIds.slice(0, 12)
          : [],
      };
    } else if (
      (kind === "review_finding" || kind === "verify_control_coverage") &&
      nodeKind === "finding"
    ) {
      task = { kind, nodeId, reason, prerequisites };
    } else if (kind === "review_evidence" && nodeKind === "evidence") {
      task = { kind, nodeId, reason, prerequisites, evidenceIds: [nodeId] };
    } else if (
      (kind === "trace" && nodeKind) ||
      (kind === "impact" && nodeKind === "asset")
    ) {
      task = { kind, nodeId, reason, prerequisites, depth: 2 };
    }
    if (task) {
      if (typeof source === "string") task = { ...task, reviewedFrom: source };
      const id = sentinelAdaptiveTaskId(revision, task);
      if (prerequisites.includes(id)) continue;
      accepted.set(index, id);
      const citesDeliveredEvidence =
        (sourceKind === "model_review" && typeof source === "string" &&
          modelReviewEvidence.get(source)?.has(nodeId)) ||
        workerSources?.some(({ taskId, kind }) =>
          kind === "model_review" &&
          modelReviewEvidence.get(taskId)?.has(nodeId)
        );
      const carriedAssignments = workerSources?.flatMap(
        ({ taskId, kind, priorAssignedTargetCitation }) => {
          const citation = exactCarriedCitation(
            taskId,
            kind,
            priorAssignedTargetCitation,
          );
          return citation ? [{ carrierTaskId: taskId, citation }] : [];
        },
      ) ?? [];
      if (carriedCitation && typeof source === "string") {
        carriedAssignments.push({
          carrierTaskId: source,
          citation: carriedCitation,
        });
      }
      tasks.push({
        ...task,
        ...((citesDeliveredEvidence || carriedAssignments.length > 0) &&
          { evidenceIds: [nodeId] }),
        ...(carriedAssignments.length && {
          carriedAssignedTargetCitations: carriedAssignments,
        }),
        ...(peerFinding && { peerFindingCitations: [peerFinding] }),
        ...(sourceKind && { sourceKind }),
        ...(workerSources &&
          {
            workerSources: workerSources.map(({ taskId, kind }) => ({
              taskId,
              kind,
            })),
          }),
        ...(typeof upstreamCheckId === "string" &&
          typeof sourceAlertId === "string" &&
          { upstreamCheckId, evidenceIds: [sourceAlertId] }),
      });
    }
  }
  return tasks.length || !raw.length ? tasks : undefined;
}
