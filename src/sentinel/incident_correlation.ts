/** Group imported defensive signals into incident candidates for human review. */

import { createHash } from "node:crypto";
import { parseSentinelTelemetryAlert } from "./case_report.ts";
import type { loadSentinelGraph } from "./graph.ts";
import {
  isSeverityIncrease,
  sentinelAlertReference,
  sentinelSeverityRank,
  type TelemetryAlert,
} from "./telemetry.ts";

type SignalClass =
  | "authentication"
  | "authorization"
  | "endpoint"
  | "network"
  | "egress"
  | "remote_access"
  | "cloud"
  | "sensor";

const signalClasses: Record<TelemetryAlert["type"], SignalClass> = {
  authentication_failure_burst: "authentication",
  authentication_failure_fanout: "authentication",
  authentication_success_after_fanout: "authentication",
  authentication_success_after_failures: "authentication",
  privileged_authentication_without_mfa: "authentication",
  authorization_denial_burst: "authorization",
  unexpected_privilege_grant: "authorization",
  integrity_change: "endpoint",
  endpoint_execution_alert: "endpoint",
  network_security_alert: "network",
  web_multistage_activity: "network",
  egress_denied_burst: "egress",
  sensitive_egress_alert: "egress",
  unexpected_remote_access: "remote_access",
  cloud_security_alert: "cloud",
  security_sensor_alert: "sensor",
};

interface CorrelatedAlert extends TelemetryAlert {
  readonly sourceRecord: number;
  readonly signalClass: SignalClass;
}

interface TimedAlert {
  readonly alert: CorrelatedAlert;
  readonly timestamp: number;
}

export interface SentinelIncidentCorrelationOptions {
  readonly windowSeconds?: number;
  readonly graph?: ReturnType<typeof loadSentinelGraph>;
}

function adjustCount<Key>(counts: Map<Key, number>, key: Key, delta: number) {
  const next = (counts.get(key) ?? 0) + delta;
  if (next === 0) counts.delete(key);
  else counts.set(key, next);
}

function exclusiveOwner(owners: ReadonlyMap<SignalClass, number>) {
  return owners.size === 1 ? owners.keys().next().value : undefined;
}

function createEvidenceWindow() {
  const byEvidence = new Map<string, Map<SignalClass, number>>();
  const exclusive = new Map<SignalClass, number>();

  return {
    adjust(alert: CorrelatedAlert, delta: 1 | -1) {
      for (const id of alert.evidenceIds) {
        const owners = byEvidence.get(id) ?? new Map<SignalClass, number>();
        const before = exclusiveOwner(owners);
        adjustCount(owners, alert.signalClass, delta);
        const after = exclusiveOwner(owners);
        if (before !== undefined) adjustCount(exclusive, before, -1);
        if (after !== undefined) adjustCount(exclusive, after, 1);
        if (owners.size === 0) byEvidence.delete(id);
        else byEvidence.set(id, owners);
      }
    },
    hasCrossSignalEvidence: () => exclusive.size >= 2,
  };
}

function groupAssetAlerts(alerts: readonly TimedAlert[], windowMs: number) {
  const groups: CorrelatedAlert[][] = [];
  const isolated: CorrelatedAlert[] = [];
  const evidence = createEvidenceWindow();
  let start = 0;
  let end = 0;
  while (start < alerts.length) {
    const anchor = alerts[start];
    while (
      end < alerts.length &&
      alerts[end].timestamp - anchor.timestamp <= windowMs
    ) {
      evidence.adjust(alerts[end].alert, 1);
      end++;
    }

    if (evidence.hasCrossSignalEvidence()) {
      const group = alerts.slice(start, end).map(({ alert }) => alert);
      groups.push(group);
      for (const alert of group) evidence.adjust(alert, -1);
      start = end;
    } else {
      isolated.push(anchor.alert);
      evidence.adjust(anchor.alert, -1);
      start++;
    }
  }

  return { groups, isolated };
}

function stableAlertIdentity(alert: CorrelatedAlert): string {
  return JSON.stringify([alert.type, [...alert.evidenceIds].sort()]);
}

function findingIndex(graph: SentinelIncidentCorrelationOptions["graph"]) {
  const ids = new Map<string, string[]>();
  for (const finding of graph?.report() ?? []) {
    for (const asset of finding.assets) {
      const findings = ids.get(asset);
      if (findings) findings.push(finding.id);
      else ids.set(asset, [finding.id]);
    }
  }
  return ids;
}

export function compareSentinelIncidentPriority(
  left: { severity?: unknown; endedAt?: unknown },
  right: { severity?: unknown; endedAt?: unknown },
): number {
  return sentinelSeverityRank(right.severity) -
      sentinelSeverityRank(left.severity) ||
    String(right.endedAt ?? "").localeCompare(String(left.endedAt ?? ""));
}

function buildCandidate(
  asset: string,
  group: readonly CorrelatedAlert[],
  findingIds: readonly string[],
  graphProvided: boolean,
  relatedAssetIds?: readonly string[],
  linkedReference?: string,
) {
  const severity = group.reduce(
    (highest, member) =>
      isSeverityIncrease(highest, member.severity) ? member.severity : highest,
    group[0].severity,
  );
  const startedAt = group[0].observedAt;
  const endedAt = group[group.length - 1].observedAt;
  const hash = createHash("sha256")
    .update(JSON.stringify([
      asset,
      startedAt,
      endedAt,
      group.map(stableAlertIdentity).sort(),
      ...(relatedAssetIds ? [relatedAssetIds] : []),
      ...(linkedReference ? [linkedReference] : []),
    ]))
    .digest("hex");
  const gaps = [
    "source_independence_unverified",
    "sequence_and_attribution_unverified",
  ];
  if (!graphProvided) gaps.push("graph_context_not_provided");
  else if (!findingIds.length) gaps.push("no_exact_asset_finding_link");
  if (relatedAssetIds && !linkedReference) {
    gaps.push("subject_authority_unverified");
  }

  const reportedAssets = [...new Set(group.map((alert) => alert.asset))].sort();
  return {
    id: `incident:${hash}`,
    asset,
    ...(relatedAssetIds && { relatedAssetIds }),
    ...(relatedAssetIds && {
      correlationBasis: !linkedReference
        ? "shared_reported_subject" as const
        : linkedReference.startsWith("session:")
        ? "shared_session_reference" as const
        : "shared_identity_reference" as const,
    }),
    ...(reportedAssets.some((id) => id !== asset) && { reportedAssets }),
    status: "requires_review" as const,
    severity,
    startedAt,
    endedAt,
    signals: [...new Set(group.map(({ signalClass }) => signalClass))].sort(),
    alerts: group,
    findingIds,
    evidenceIds: [...new Set(group.flatMap(({ evidenceIds }) => evidenceIds))]
      .sort(),
    gaps,
  };
}

export function summarizeSentinelIncident(
  candidate: ReturnType<typeof buildCandidate>,
  limit = 25,
) {
  const { alerts, reportedAssets, findingIds, evidenceIds, ...summary } =
    candidate;
  return {
    ...summary,
    ...(reportedAssets && { reportedAssets: reportedAssets.slice(0, limit) }),
    alertCount: alerts.length,
    alertReferences: alerts.map(sentinelAlertReference),
    findingIds: findingIds.slice(0, limit),
    evidenceIds: evidenceIds.slice(0, limit),
  };
}

function correlateLinkedAssets(
  graph: NonNullable<SentinelIncidentCorrelationOptions["graph"]>,
  alerts: readonly CorrelatedAlert[],
  windowMs: number,
  findings: ReadonlyMap<string, readonly string[]>,
) {
  const byAsset = new Map<string, Map<string, TimedAlert[]>>();
  for (const alert of alerts) {
    const asset = graph.resolveAssetId(alert.asset);
    if (!asset) continue;
    const subjects = byAsset.get(asset) ?? new Map<string, TimedAlert[]>();
    byAsset.set(asset, subjects);
    const key = alert.sessionReference ?? alert.identityReference ??
      `subject:${alert.subject}`;
    const records = subjects.get(key) ?? [];
    subjects.set(key, records);
    records.push({ alert, timestamp: Date.parse(alert.observedAt) });
  }
  const used = new Set<number>();
  const candidates: ReturnType<typeof buildCandidate>[] = [];
  const edges = graph.snapshot().edges.filter(({ relation }) =>
    relation === "depends_on"
  )
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  for (const { from, to } of edges) {
    if (from === to) continue;
    const left = byAsset.get(from);
    const right = byAsset.get(to);
    if (!left || !right) continue;
    for (const [key, records] of left) {
      const related = right.get(key);
      if (!related?.length) continue;
      const recordsByTime = [...records, ...related]
        .filter(({ alert }) => !used.has(alert.sourceRecord))
        .sort((a, b) =>
          a.timestamp - b.timestamp ||
          a.alert.sourceRecord - b.alert.sourceRecord
        );
      for (const group of groupAssetAlerts(recordsByTime, windowMs).groups) {
        const assets = new Set(
          group.map((alert) => graph.resolveAssetId(alert.asset)),
        );
        if (assets.size < 2) continue;
        const evidenceByAsset = new Map<string, Set<string>>();
        for (const alert of group) {
          const asset = graph.resolveAssetId(alert.asset)!;
          const evidence = evidenceByAsset.get(asset) ?? new Set<string>();
          for (const id of alert.evidenceIds) evidence.add(id);
          evidenceByAsset.set(asset, evidence);
        }
        if (
          ![...evidenceByAsset].every(([asset, evidence]) =>
            [...evidence].some((id) =>
              !evidenceByAsset.get(asset === from ? to : from)?.has(id)
            )
          )
        ) continue;
        candidates.push(buildCandidate(
          from,
          group,
          [
            ...new Set([
              ...(findings.get(from) ?? []),
              ...(findings.get(to) ?? []),
            ]),
          ].sort(),
          true,
          [from, to],
          key.startsWith("subject:") ? undefined : key,
        ));
        for (const alert of group) used.add(alert.sourceRecord);
      }
    }
  }
  return { candidates, used };
}

/**
 * Correlate by asset identity and event time. A candidate requires
 * at least two signal classes with evidence IDs exclusive to each class
 * within the window. Alert copies and shared evidence alone are insufficient.
 */
export function correlateSentinelIncidents(
  alerts: readonly unknown[],
  options: SentinelIncidentCorrelationOptions = {},
) {
  const windowSeconds = options.windowSeconds ?? 300;
  if (
    !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 ||
    windowSeconds > 86400
  ) {
    throw new Error("Sentinel incident window must be 1 to 86400 seconds");
  }

  const byAsset = new Map<string, TimedAlert[]>();
  for (const [index, raw] of alerts.entries()) {
    const sourceRecord = index + 1;
    const parsed = parseSentinelTelemetryAlert(raw, sourceRecord);
    const alert = {
      ...parsed,
      sourceRecord,
      signalClass: signalClasses[parsed.type],
    };
    const record = { alert, timestamp: Date.parse(parsed.observedAt) };
    const asset = options.graph?.resolveAssetId(alert.asset) ?? alert.asset;
    const existing = byAsset.get(asset);
    if (existing) existing.push(record);
    else byAsset.set(asset, [record]);
  }

  const graphFindings = findingIndex(options.graph);
  const candidates: ReturnType<typeof buildCandidate>[] = [];
  const uncorrelatedAlerts: CorrelatedAlert[] = [];
  const duplicateAlerts: { sourceRecord: number; duplicateOf: number }[] = [];
  for (const [asset, records] of byAsset) {
    records.sort((a, b) =>
      a.timestamp - b.timestamp || a.alert.sourceRecord - b.alert.sourceRecord
    );
    const identified = new Map<string, number>();
    const distinct = records.filter(({ alert }) => {
      const key = stableAlertIdentity(alert);
      const original = identified.get(key);
      if (original !== undefined) {
        duplicateAlerts.push({
          sourceRecord: alert.sourceRecord,
          duplicateOf: original,
        });
        return false;
      }
      identified.set(key, alert.sourceRecord);
      return true;
    });

    const { groups, isolated } = groupAssetAlerts(
      distinct,
      windowSeconds * 1000,
    );
    for (const group of groups) {
      candidates.push(buildCandidate(
        asset,
        group,
        graphFindings.get(asset) ?? [],
        options.graph !== undefined,
      ));
    }
    for (const alert of isolated) uncorrelatedAlerts.push(alert);
  }
  const linked = options.graph
    ? correlateLinkedAssets(
      options.graph,
      uncorrelatedAlerts,
      windowSeconds * 1000,
      graphFindings,
    )
    : undefined;
  if (linked) candidates.push(...linked.candidates);
  const remainingAlerts = uncorrelatedAlerts.filter(({ sourceRecord }) =>
    !linked?.used.has(sourceRecord)
  );
  candidates.sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)
  );
  remainingAlerts.sort((a, b) => a.sourceRecord - b.sourceRecord);
  duplicateAlerts.sort((a, b) => a.sourceRecord - b.sourceRecord);

  return {
    version: 1,
    windowSeconds,
    interpretation:
      "Candidates share an asset identity or an exact subject, shared identity, or shared session reference on directly dependent case assets within a bounded time window. Confirm source independence, sequence, and findings during review.",
    summary: {
      inputAlerts: alerts.length,
      distinctAlerts: alerts.length - duplicateAlerts.length,
      candidates: candidates.length,
      correlatedAlerts: candidates.reduce(
        (n, candidate) => n + candidate.alerts.length,
        0,
      ),
      uncorrelatedAlerts: remainingAlerts.length,
      duplicateAlerts: duplicateAlerts.length,
    },
    candidates,
    uncorrelatedAlerts: remainingAlerts,
    duplicateAlerts,
  };
}

/** Resolve saved membership in its original order without running correlation again. */
/** Rank scoped alerts, giving each asset one slot before additional alerts. */
export function rankSentinelIsolatedAlerts(
  report: ReturnType<typeof correlateSentinelIncidents>,
  graph: ReturnType<typeof loadSentinelGraph>,
) {
  const rankedAlerts = report.uncorrelatedAlerts
    .filter(({ severity }) =>
      sentinelSeverityRank(severity) >=
        sentinelSeverityRank("high")
    )
    .sort((a, b) =>
      sentinelSeverityRank(b.severity) -
        sentinelSeverityRank(a.severity) ||
      b.observedAt.localeCompare(a.observedAt) ||
      a.sourceRecord - b.sourceRecord
    );
  const firstByAsset = new Map<string, typeof rankedAlerts[number]>();
  const additionalAlerts = [];
  for (const alert of rankedAlerts) {
    const asset = graph.resolveAssetId(alert.asset);
    if (!asset) continue;
    if (firstByAsset.has(asset)) additionalAlerts.push(alert);
    else firstByAsset.set(asset, alert);
  }
  return [
    ...firstByAsset.values(),
    ...additionalAlerts,
  ];
}

export function resolveSentinelIncidentAlerts(
  alerts: readonly TelemetryAlert[],
  references: readonly string[],
) {
  const wanted = new Set(references);
  const matches = new Map<string, CorrelatedAlert>();
  for (const [index, alert] of alerts.entries()) {
    const key = sentinelAlertReference(alert);
    if (!wanted.has(key)) continue;
    const prior = matches.get(key);
    if (!prior || Date.parse(alert.observedAt) < Date.parse(prior.observedAt)) {
      matches.set(key, {
        ...alert,
        sourceRecord: index + 1,
        signalClass: signalClasses[alert.type],
      });
    }
  }
  return references.flatMap((key) => {
    const match = matches.get(key);
    return match ? [match] : [];
  });
}

/** Rebuild membership for revisions saved before alert references were recorded. */
export function recoverSentinelIncidentAlerts(
  alerts: readonly TelemetryAlert[],
  incidentId: string,
  graph: ReturnType<typeof loadSentinelGraph>,
) {
  return (
    correlateSentinelIncidents(alerts, { graph }).candidates.find(({ id }) =>
      id === incidentId
    ) ??
      correlateSentinelIncidents(alerts).candidates.find(({ id }) =>
        id === incidentId
      )
  )?.alerts;
}
