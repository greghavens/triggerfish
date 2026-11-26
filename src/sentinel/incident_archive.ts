/** Resolve historic incident membership within a specific case revision. */
import {
  readSentinelAssessmentAlerts,
  readSentinelAssessmentRevision,
  readSentinelIncidentReviews,
  readSentinelLatestRunRevision,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
  type SentinelIncidentReview,
} from "./assessment_store.ts";
import type { TelemetryAlert } from "./telemetry.ts";
import { loadSentinelGraph } from "./graph.ts";
import { sentinelTelemetryAssetResolver } from "./defense_coverage.ts";
import { sentinelOperatingConstraintsAllow } from "./operating_constraints.ts";
import {
  compareSentinelIncidentPriority,
  correlateSentinelIncidents,
  rankSentinelIsolatedAlerts,
  recoverSentinelIncidentAlerts,
  resolveSentinelIncidentAlerts,
  summarizeSentinelIncident,
} from "./incident_correlation.ts";

export function readSavedSentinelIncident(
  path: string,
  revision: number,
  incidentId: string,
  allowOutsideSample = false,
) {
  const saved = readSentinelAssessmentRevision(path, revision);
  const alerts = readSentinelAssessmentAlerts(path, revision);
  const snapshot = saved?.result?.sharedGraph.snapshot;
  if (!snapshot || !alerts) {
    return {
      error: "No full alert feed was saved for this evidence revision.",
    } as const;
  }
  const facts = saved?.result?.sharedGraph.observations.find(
    ({ task }) => task === "incident_correlation",
  )?.facts;
  const stored = Array.isArray(facts?.candidates)
    ? facts.candidates.find((candidate) => candidate?.id === incidentId)
    : undefined;
  if (!stored && allowOutsideSample) {
    const members = correlateSentinelIncidents(alerts, {
      graph: loadSentinelGraph(snapshot),
    })
      .candidates.find(({ id }) => id === incidentId)?.alerts;
    if (members) return { members };
  }
  if (!stored) {
    return {
      error: "The incident is unavailable in this evidence revision.",
    } as const;
  }
  let members;
  if (
    Array.isArray(stored.alertReferences) &&
    stored.alertReferences.length === stored.alertCount &&
    stored.alertReferences.every((id: unknown) => typeof id === "string")
  ) {
    members = resolveSentinelIncidentAlerts(
      alerts,
      stored.alertReferences,
    );
    if (members.length !== stored.alertReferences.length) {
      return {
        error: "Some contributing alerts are missing from this saved revision.",
      } as const;
    }
  } else {
    members = recoverSentinelIncidentAlerts(
      alerts,
      incidentId,
      loadSentinelGraph(snapshot),
    );
  }
  if (!members) {
    return {
      error: "The incident is unavailable in this evidence revision.",
    } as const;
  }
  return { members };
}

function readSavedIncidentCorrelation(path: string, revision: number) {
  const alerts = readSentinelAssessmentAlerts(path, revision);
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    ?.sharedGraph.snapshot;
  return alerts && snapshot
    ? correlateSentinelIncidents(alerts, { graph: loadSentinelGraph(snapshot) })
    : undefined;
}

/** Resolve all contributing alerts to exact case assets for scoped incident work. */
export function readSavedSentinelIncidentAssetScopes(
  path: string,
  revision: number,
) {
  const alerts = readSentinelAssessmentAlerts(path, revision);
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    ?.sharedGraph.snapshot;
  if (!alerts || !snapshot) return;
  const graph = loadSentinelGraph(snapshot);
  const scopes = new Map<string, readonly string[]>();
  for (
    const { id, alerts: contributing } of correlateSentinelIncidents(alerts, {
      graph,
    })
      .candidates
  ) {
    const members = contributing.map(({ asset }) =>
      graph.resolveAssetId(asset)
    );
    if (members.length && members.every((asset): asset is string => !!asset)) {
      scopes.set(id, [...new Set(members)]);
    }
  }
  return scopes;
}

/** Validate every member against the saved and current scope of the original run. */
/** Canonical exact-cohort page used by both root reads and retained review receipts. */
export function projectSentinelIncidentAlertPage(
  members: readonly TelemetryAlert[],
  revision: number,
  incidentId: string,
  offset: number,
  limit: number,
): string {
  const alerts = members.slice(offset, offset + limit);
  do {
    const next = offset + alerts.length;
    const result = JSON.stringify({
      revision,
      incidentId,
      offset,
      total: members.length,
      nextOffset: next < members.length ? next : null,
      alerts,
    });
    if (result.length <= 7_000) return result;
    alerts.pop();
  } while (alerts.length);
  return "Error: A provenance record exceeds the tool output limit.";
}

export function readSentinelIncidentReviewScope(
  path: string,
  revision: number,
  incidentId: string,
) {
  const runId = readSentinelRunIdForRevision(path, revision);
  const latestRevision = runId && readSentinelLatestRunRevision(path, runId);
  const incident = readSavedSentinelIncident(path, revision, incidentId, true);
  if (
    !runId || !latestRevision || "error" in incident || !incident.members.length
  ) return;
  const saved = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  const latest = latestRevision === revision
    ? saved
    : readSentinelAssessmentRevision(path, latestRevision)?.result.sharedGraph
      .snapshot;
  if (!saved || !latest) return;
  const before = readSentinelOperatingConstraints(path, runId, revision);
  const current = readSentinelOperatingConstraints(path, runId);
  const savedAsset = sentinelTelemetryAssetResolver(saved, before?.constraints);
  const currentAsset = sentinelTelemetryAssetResolver(
    latest,
    current?.constraints,
  );
  const assetIds = new Set<string>();
  for (const member of incident.members) {
    const nodeId = savedAsset(member);
    if (
      !nodeId || currentAsset(member) !== nodeId ||
      !sentinelOperatingConstraintsAllow(before?.constraints, {
        kind: "review_incident",
        nodeId,
      }, saved) ||
      !sentinelOperatingConstraintsAllow(current?.constraints, {
        kind: "review_incident",
        nodeId,
      }, latest)
    ) return;
    assetIds.add(nodeId);
  }
  return {
    runId,
    latestRevision,
    assetIds: [...assetIds].sort(),
    savedDigest: before?.digest,
    currentDigest: current?.digest,
    currentVersion: current?.version,
  };
}

export function readSavedSentinelPlanningEvidence(
  path: string,
  revision: number,
) {
  const alerts = readSentinelAssessmentAlerts(path, revision);
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    ?.sharedGraph.snapshot;
  if (!alerts || !snapshot) return undefined;
  const graph = loadSentinelGraph(snapshot);
  const report = correlateSentinelIncidents(alerts, { graph });
  return {
    incidents: report.candidates.map((candidate) =>
      summarizeSentinelIncident(candidate)
    ),
    isolated: rankSentinelIsolatedAlerts(report, graph),
  };
}

interface SentinelIncidentReadScope {
  allowAlert: (alert: TelemetryAlert) => boolean;
  allowFinding: (id: string) => boolean;
}

export function renderSavedSentinelIncidentJson(
  path: string,
  caseId: string,
  revision: number,
  scope?: SentinelIncidentReadScope & {
    readonly allowReview: (review: SentinelIncidentReview) => boolean;
  },
) {
  const report = readSavedIncidentCorrelation(path, revision);
  if (!report) return undefined;
  const candidates = scope
    ? report.candidates.filter(({ alerts }) => alerts.every(scope.allowAlert))
    : report.candidates;
  const latest = new Map(
    readSentinelIncidentReviews(path, revision)
      .filter((review) => !scope || scope.allowReview(review))
      .toReversed().map((review) => [review.incidentId, review]),
  );
  return JSON.stringify(
    {
      version: 1,
      caseId,
      revision,
      windowSeconds: report.windowSeconds,
      ...(scope && { scopeRestricted: true }),
      summary: scope
        ? {
          candidates: candidates.length,
          correlatedAlerts: candidates.reduce(
            (total, { alerts }) => total + alerts.length,
            0,
          ),
        }
        : report.summary,
      incidents: candidates.toSorted(compareSentinelIncidentPriority)
        .map((candidate) => {
          const findingIds = scope
            ? candidate.findingIds.filter(scope.allowFinding)
            : candidate.findingIds;
          const projected = scope ? { ...candidate, findingIds } : candidate;
          return {
            ...summarizeSentinelIncident(projected),
            findingCount: findingIds.length,
            evidenceCount: candidate.evidenceIds.length,
            latestReview: latest.get(candidate.id) ?? null,
          };
        }),
    },
    null,
    2,
  ) + "\n";
}

/** Page candidates reconstructed from a retained revision's full alert feed. */
export function readSavedSentinelIncidentPage(
  path: string,
  revision: number,
  offset: number,
  scope?: SentinelIncidentReadScope,
) {
  const report = readSavedIncidentCorrelation(path, revision);
  if (!report) return undefined;
  const candidates = scope
    ? report.candidates.filter(({ alerts }) => alerts.every(scope.allowAlert))
    : report.candidates;
  const page = candidates.toSorted(compareSentinelIncidentPriority).slice(
    offset,
    offset + 10,
  );
  return {
    offset,
    total: candidates.length,
    nextOffset: offset + page.length < candidates.length
      ? offset + page.length
      : null,
    incidents: page.map((
      { id, alerts, reportedAssets, findingIds, evidenceIds, ...incident },
    ) => ({
      sourceId: id,
      incident: {
        ...incident,
        alertCount: alerts.length,
        reportedAssets: (reportedAssets ?? []).slice(0, 25),
        findingIds: (scope ? findingIds.filter(scope.allowFinding) : findingIds)
          .slice(0, 25),
        evidenceIds: evidenceIds.slice(0, 25),
      },
    })),
  };
}

/** Resolve candidates from the saved case feed, optionally limited to exact IDs. */
export function readSavedSentinelIncidentCandidates(
  path: string,
  revision: number,
  ids?: ReadonlySet<string>,
) {
  if (ids?.size === 0) return [];
  return (readSavedIncidentCorrelation(path, revision)?.candidates ?? [])
    .filter(({ id }) => !ids || ids.has(id)).map((candidate) =>
      summarizeSentinelIncident(candidate)
    );
}

export function readSavedSentinelIncidentCandidate(
  path: string,
  revision: number,
  id: string,
) {
  if (!/^incident:[a-f0-9]{64}$/.test(id)) return undefined;
  return readSavedSentinelIncidentCandidates(path, revision, new Set([id]))[0];
}
