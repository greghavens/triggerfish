/** Run bounded, deterministic defensive assessment tasks against local data. */

import { createHash } from "node:crypto";
import {
  buildSentinelCaseReport,
  parseSentinelTelemetryAlert,
} from "./case_report.ts";
import { assessSentinelDefenseCoverage } from "./defense_coverage.ts";
import { loadSentinelGraph } from "./graph.ts";
import {
  compareSentinelIncidentPriority,
  correlateSentinelIncidents,
  rankSentinelIsolatedAlerts,
  summarizeSentinelIncident,
} from "./incident_correlation.ts";
import { sentinelAlertKey } from "./telemetry.ts";

export const MAX_NODES = 2_000;
export const MAX_EDGES = 8_000;
const MAX_ALERTS = 2_000;
const MAX_SNAPSHOT_CHARACTERS = 4 * 1024 * 1024;
const MAX_DEPTH = 16;
const OBSERVATION_SAMPLE = 25;

type Graph = ReturnType<typeof loadSentinelGraph>;
type Snapshot = ReturnType<Graph["snapshot"]>;

export interface SentinelAssessmentOptions {
  readonly snapshot?: unknown;
  /** Undefined means no alert feed was supplied. An empty feed is valid evidence input. */
  readonly alerts?: readonly unknown[];
  readonly impactAsset?: string;
  readonly traceNode?: string;
  /** When supplied, case and incident tasks wait for this exact supporting graph evidence. */
  readonly evidenceNode?: string;
  readonly depth?: number;
  readonly webContainmentConfigured?: boolean;
  readonly controlEvaluationAt?: string;
  /** Prior report, used for change tracking only. Tasks always use current inputs. */
  readonly previous?: unknown;
}

const prerequisites = {
  coverage: [],
  defense_coverage: [],
  impact: ["coverage"],
  trace: ["coverage"],
  case: ["coverage", "defense_coverage"],
  incident_correlation: ["case"],
} as const;

type TaskId = keyof typeof prerequisites;
type Status = "completed" | "waiting" | "skipped";
type Facts = Readonly<Record<string, unknown>> & {
  readonly relatedNodeIds?: readonly string[];
};

interface TaskDefinition {
  readonly id: TaskId;
  readonly worker: string;
  readonly requiredInput?: string;
  readonly skippedReason?: string;
  readonly waitingReason?: string;
  readonly execute: () => Facts;
}

interface TaskStatus {
  readonly id: TaskId;
  readonly worker: string;
  readonly prerequisites: readonly TaskId[];
  readonly status: Status;
  readonly requiredInput?: string;
  readonly reason?: string;
}

function completeGraph(raw: unknown): Graph {
  if (raw !== null && typeof raw === "object") {
    const { nodes, edges } = raw as { nodes?: unknown; edges?: unknown };
    if (
      (Array.isArray(nodes) && nodes.length > MAX_NODES) ||
      (Array.isArray(edges) && edges.length > MAX_EDGES)
    ) {
      throw new Error(
        "Sentinel assessment graph exceeds 2000 nodes or 8000 edges",
      );
    }
  }
  return loadSentinelGraph(raw);
}

type VerificationEntries = ReturnType<Graph["coverage"]>["findings"];

function compareControlVerification(
  previous: unknown,
  current: VerificationEntries,
  evaluatedAt: string,
) {
  if (!previous || typeof previous !== "object") return [];
  const saved = previous as {
    controlEvaluationAt?: string;
    sharedGraph?: { snapshot?: unknown };
  };
  if (!saved.sharedGraph?.snapshot) return [];
  let earlier: VerificationEntries;
  try {
    earlier = completeGraph(saved.sharedGraph.snapshot).coverage(
      saved.controlEvaluationAt ?? evaluatedAt,
    ).findings;
  } catch {
    return [];
  }
  const entries = (findings: VerificationEntries) =>
    new Map(findings.flatMap(
      ({ id: findingId, controlVerification }) =>
        (controlVerification?.controls ?? []).map((
          { controlId, status, evidenceId },
        ) =>
          [JSON.stringify([findingId, controlId]), {
            findingId,
            controlId,
            status,
            evidenceId,
          }] as const
        ),
    ));
  const before = entries(earlier);
  const after = entries(current);
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(
    (key) => {
      const from = before.get(key);
      const to = after.get(key);
      const ids = to ?? from;
      if (
        !ids ||
        (from?.status === to?.status && from?.evidenceId === to?.evidenceId)
      ) return [];
      const { findingId, controlId } = ids;
      return [{
        findingId,
        controlId,
        before: from
          ? { status: from.status, evidenceId: from.evidenceId }
          : null,
        after: to ? { status: to.status, evidenceId: to.evidenceId } : null,
      }];
    },
  );
}

function selectedId(value: unknown, field: string): string | undefined {
  if (value === undefined) return;
  if (
    typeof value !== "string" || value.trim().length === 0 ||
    value.length > 4096
  ) {
    throw new Error(`Invalid Sentinel assessment ${field}`);
  }
  return value;
}

function stateFromPrevious(previous: unknown) {
  const statuses = new Map<TaskId, Status>();
  if (previous === undefined || previous === null) return { statuses };
  if (typeof previous !== "object") {
    throw new Error("Invalid prior Sentinel assessment");
  }
  const source = previous as {
    version?: unknown;
    revision?: unknown;
    tasks?: unknown;
  };
  const { revision, tasks } = source;
  if (
    source.version !== 1 || typeof revision !== "string" ||
    !/^assessment:[a-f0-9]{64}$/.test(revision) ||
    !Array.isArray(tasks) ||
    tasks.length > Object.keys(prerequisites).length
  ) {
    throw new Error("Invalid prior Sentinel assessment");
  }
  for (const task of tasks) {
    if (
      !task || typeof task !== "object" || typeof task.id !== "string" ||
      !Object.hasOwn(prerequisites, task.id) || statuses.has(task.id) ||
      (task.status !== "completed" && task.status !== "waiting" &&
        task.status !== "skipped")
    ) {
      throw new Error("Invalid prior Sentinel assessment task");
    }
    statuses.set(task.id, task.status);
  }
  return { revision, statuses };
}

function selectTask(
  definition: TaskDefinition,
  completed: ReadonlySet<TaskId>,
): TaskStatus {
  const { id, worker, requiredInput, skippedReason, waitingReason } =
    definition;
  const dependencies: readonly TaskId[] = prerequisites[id];
  const base = {
    id,
    worker,
    prerequisites: dependencies,
    ...(requiredInput !== undefined && { requiredInput }),
  };
  if (skippedReason) {
    return { ...base, status: "skipped", reason: skippedReason };
  }
  if (dependencies.some((dependency) => !completed.has(dependency))) {
    return { ...base, status: "waiting", reason: "prerequisite_pending" };
  }
  return waitingReason
    ? { ...base, status: "waiting", reason: waitingReason }
    : { ...base, status: "completed" };
}

function buildAssessmentTasks(
  graph: Graph | undefined,
  snapshot: Snapshot | null,
  alerts: readonly unknown[] | undefined,
  options: {
    impactAsset?: string | undefined;
    traceNode?: string | undefined;
    evidenceNode?: string | undefined;
    webContainmentConfigured?: boolean | undefined;
    depth: number;
    coverage?: ReturnType<Graph["coverage"]>;
  },
): readonly TaskDefinition[] {
  const { impactAsset, traceNode, evidenceNode, depth } = options;
  const impactTarget = snapshot?.nodes.find((node) =>
    node.id === impactAsset && node.kind === "asset"
  );
  const traceTarget = snapshot?.nodes.find((node) => node.id === traceNode);
  const hasSupportingEvidence = evidenceNode === undefined ||
    snapshot?.edges.some(
      ({ relation, from }) => relation === "supports" && from === evidenceNode,
    );
  return [
    {
      id: "coverage",
      worker: "graph",
      requiredInput: "graph_snapshot",
      ...(graph === undefined && { waitingReason: "graph_snapshot_required" }),
      execute: () => {
        const report = options.coverage ?? graph!.coverage();
        const findings = report.findings.slice(0, OBSERVATION_SAMPLE);
        return {
          summary: report.summary,
          findings,
          relatedNodeIds: findings.flatMap(({ id, controlVerification }) => [
            id,
            ...(controlVerification?.controls.flatMap((
              { controlId, evidenceId },
            ) =>
              evidenceId === undefined ? [controlId] : [controlId, evidenceId]
            ) ?? []),
          ]),
        };
      },
    },
    {
      id: "defense_coverage",
      worker: "telemetry",
      requiredInput: "alert_feed",
      ...(alerts === undefined && { waitingReason: "alert_feed_required" }),
      execute: () => {
        const report = assessSentinelDefenseCoverage({
          alerts: alerts!,
          ...(options.webContainmentConfigured !== undefined && {
            webContainmentConfigured: options.webContainmentConfigured,
          }),
        });
        return {
          webContainment: report.webContainment,
          behaviors: report.behaviors.map(({ signals, ...behavior }) => ({
            ...behavior,
            signals: signals.map(({ records, ...signal }) => ({
              ...signal,
              alertCount: records.length,
            })),
          })),
          upstreamChecks: report.upstreamChecks.map((
            { records, ...check },
          ) => ({
            ...check,
            alertCount: records.length,
            sample: records.slice(0, OBSERVATION_SAMPLE).map((
              { sourceRecord, asset, observedAt },
            ) => ({
              asset,
              observedAt,
              focusAlertKey: sentinelAlertKey(
                parseSentinelTelemetryAlert(
                  alerts![sourceRecord - 1],
                  sourceRecord,
                ),
              ),
            })),
          })),
          interpretation: report.interpretation,
        };
      },
    },
    {
      id: "impact",
      worker: "dependency",
      ...(impactAsset === undefined
        ? { skippedReason: "no_impact_asset_selected" }
        : { requiredInput: impactAsset }),
      ...(!impactTarget && { waitingReason: "selected_asset_missing" }),
      execute: () => {
        const result = graph!.impact(impactAsset!, depth);
        return {
          root: impactAsset,
          depth,
          assetCount: result.assets.length,
          edgeCount: result.edges.length,
          assets: result.assets.slice(0, OBSERVATION_SAMPLE),
          relatedNodeIds: result.assets.slice(0, OBSERVATION_SAMPLE).map((
            { id },
          ) => id),
        };
      },
    },
    {
      id: "trace",
      worker: "investigation",
      ...(traceNode === undefined
        ? { skippedReason: "no_trace_node_selected" }
        : { requiredInput: traceNode }),
      ...(!traceTarget && { waitingReason: "selected_node_missing" }),
      execute: () => {
        const result = graph!.trace(traceNode!, depth);
        return {
          root: traceNode,
          depth,
          nodeCount: result.nodes.length,
          edgeCount: result.edges.length,
          nodes: result.nodes.slice(0, OBSERVATION_SAMPLE),
          relatedNodeIds: result.nodes.slice(0, OBSERVATION_SAMPLE).map((
            { id },
          ) => id),
        };
      },
    },
    {
      id: "case",
      worker: "incident_review",
      ...(evidenceNode !== undefined && { requiredInput: evidenceNode }),
      ...(!hasSupportingEvidence &&
        { waitingReason: "supporting_evidence_missing" }),
      execute: () => {
        const report = buildSentinelCaseReport(graph!, alerts!);
        const rankedAlerts = [
          ...report.matchedAlerts,
          ...report.unmatchedAlerts,
        ]
          .sort((left, right) =>
            right.observedAt.localeCompare(left.observedAt) ||
            left.sourceRecord - right.sourceRecord
          );
        const alertSample = [];
        const observedKeys = new Set<string>();
        for (const alert of rankedAlerts) {
          const key = sentinelAlertKey(alert);
          if (observedKeys.has(key)) continue;
          observedKeys.add(key);
          alertSample.push(alert);
          if (alertSample.length >= OBSERVATION_SAMPLE) break;
        }
        return {
          summary: report.summary,
          alerts: alertSample,
          relatedNodeIds: [
            ...alertSample.map(({ asset }) => asset),
            ...report.findings.slice(0, OBSERVATION_SAMPLE).flatMap(
              ({ id, evidence }) => [id, ...evidence.slice(0, 10)],
            ),
          ],
          findings: report.findings.slice(0, OBSERVATION_SAMPLE).map(
            ({ relatedAlertRecords, ...finding }) => ({
              ...finding,
              relatedAlertCount: relatedAlertRecords.length,
              relatedAlertRecords: relatedAlertRecords.slice(
                0,
                OBSERVATION_SAMPLE,
              ),
            }),
          ),
        };
      },
    },
    {
      id: "incident_correlation",
      worker: "incident_review",
      execute: () => {
        const report = correlateSentinelIncidents(alerts!, { graph: graph! });
        const prioritized = report.candidates.toSorted(
          compareSentinelIncidentPriority,
        ).slice(0, OBSERVATION_SAMPLE);
        const isolatedPriorityAlerts = rankSentinelIsolatedAlerts(
          report,
          graph!,
        ).slice(0, OBSERVATION_SAMPLE);
        return {
          summary: report.summary,
          ...(isolatedPriorityAlerts.length && { isolatedPriorityAlerts }),
          relatedNodeIds: prioritized
            .flatMap((
              { asset, findingIds },
            ) => [asset, ...findingIds.slice(0, OBSERVATION_SAMPLE)]),
          candidates: prioritized.map((candidate) =>
            summarizeSentinelIncident(candidate, OBSERVATION_SAMPLE)
          ),
        };
      },
    },
  ];
}

/** Run all tasks whose prerequisites are available and describe blocked tasks. */
export function runSentinelAssessment(options: SentinelAssessmentOptions = {}) {
  const depth = options.depth ?? 2;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
    throw new Error(
      "Sentinel assessment depth must be an integer from 0 to 16",
    );
  }
  const impactAsset = selectedId(options.impactAsset, "impact asset");
  const traceNode = selectedId(options.traceNode, "trace node");
  const evidenceNode = selectedId(options.evidenceNode, "evidence node");
  if (
    options.alerts !== undefined &&
    (!Array.isArray(options.alerts) || options.alerts.length > MAX_ALERTS)
  ) {
    throw new Error(
      "Sentinel assessment requires an alert array of at most 2000 records",
    );
  }
  const alerts = options.alerts?.map((raw, index) =>
    parseSentinelTelemetryAlert(raw, index + 1)
  );
  const graph = options.snapshot === undefined
    ? undefined
    : completeGraph(options.snapshot);
  const snapshot = graph?.snapshot() ?? null;
  if (snapshot && snapshot.edges.length > MAX_EDGES) {
    throw new Error("Sentinel assessment graph exceeds 8000 canonical edges");
  }
  const original = JSON.stringify(snapshot);
  if (original.length > MAX_SNAPSHOT_CHARACTERS) {
    throw new Error(
      "Sentinel assessment graph exceeds four million serialized characters",
    );
  }
  const hash = createHash("sha256").update(original).update(JSON.stringify([
    alerts,
    impactAsset,
    traceNode,
    evidenceNode,
    depth,
    options.webContainmentConfigured,
  ]));

  const { revision: previousRevision, statuses: previousStatuses } =
    stateFromPrevious(options.previous);
  const controlEvaluationAt =
    snapshot?.edges.some(({ relation }) => relation === "verifies")
      ? options.controlEvaluationAt ?? new Date().toISOString()
      : undefined;
  const controlCoverage = controlEvaluationAt === undefined
    ? undefined
    : graph?.coverage(controlEvaluationAt);
  if (controlCoverage) {
    hash.update(
      JSON.stringify(
        controlCoverage.findings.map(({ id, controlVerification }) => {
          if (!controlVerification) return [id];
          const { asOf: _asOf, ...facts } = controlVerification;
          return [id, facts];
        }),
      ),
    );
  }
  const priorControlTime = typeof options.previous === "object" &&
    options.previous !== null &&
    "controlEvaluationAt" in options.previous;
  const controlChanges = controlCoverage || priorControlTime
    ? compareControlVerification(
      options.previous,
      controlCoverage?.findings ??
        graph?.coverage(options.controlEvaluationAt ?? new Date().toISOString())
          .findings ??
        [],
      controlEvaluationAt ?? options.controlEvaluationAt ??
        new Date().toISOString(),
    )
    : [];
  const definitions = buildAssessmentTasks(graph, snapshot, alerts, {
    impactAsset,
    traceNode,
    evidenceNode,
    webContainmentConfigured: options.webContainmentConfigured,
    depth,
    coverage: controlCoverage,
  });
  const tasks: TaskStatus[] = [];
  const completed = new Set<TaskId>();
  const observations = [];
  const observationLinks = [];
  const graphNodes = new Set(snapshot?.nodes.map(({ id }) => id));
  const transitions = [];
  for (const definition of definitions) {
    const task = selectTask(definition, completed);
    tasks.push(task);
    if (task.status === "completed") {
      const { relatedNodeIds, ...facts } = definition.execute();
      const id = `assessment:${task.id}`;
      observations.push({ id, task: task.id, worker: task.worker, facts });
      for (const node of new Set(relatedNodeIds)) {
        if (graphNodes.has(node)) {
          observationLinks.push({ observation: id, node });
        }
      }
      completed.add(task.id);
    }
    const prior = previousStatuses.get(task.id);
    if (prior !== undefined && prior !== task.status) {
      transitions.push({ task: task.id, from: prior, to: task.status });
    }
  }

  if (observations.some(({ facts }) => "isolatedPriorityAlerts" in facts)) {
    hash.update("isolated-priority-alerts-v2");
  }
  const revision = `assessment:${hash.digest("hex")}`;

  return {
    version: 1 as const,
    revision,
    previousRevision: previousRevision ?? null,
    ...(controlEvaluationAt && { controlEvaluationAt }),
    ...(controlChanges.length && { controlChanges }),
    summary: {
      completed: completed.size,
      waiting: tasks.filter((task) => task.status === "waiting").length,
      skipped: tasks.filter((task) => task.status === "skipped").length,
    },
    tasks,
    transitions,
    // Derived observations belong to the assessment. They never become
    // supports edges, which represent evidence from the original graph.
    sharedGraph: { snapshot, observations, observationLinks },
  };
}
