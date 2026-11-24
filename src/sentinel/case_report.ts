/** Assemble evidence for a defensive investigation from local Sentinel data. */

import type { loadSentinelGraph } from "./graph.ts";
import {
  AUTH_FANOUT_LIMIT,
  isSentinelAlertSeverity,
  isSentinelIdentityReference,
  isSentinelSessionReference,
  isSentinelSourceReference,
  isSentinelTelemetryAction,
  parseEntraRoleGrantContext,
  type TelemetryAlert,
  telemetryAlertSeverities as alertSeverities,
} from "./telemetry.ts";

const canonicalUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 &&
    value.trim().length > 0;
}

function isAlertType(value: unknown): value is TelemetryAlert["type"] {
  return typeof value === "string" && Object.hasOwn(alertSeverities, value);
}

export function parseSentinelTelemetryAlert(
  raw: unknown,
  sourceRecord: number,
): TelemetryAlert {
  const invalid = new Error(`Invalid Sentinel alert at record ${sourceRecord}`);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid;
  }
  const alert = raw as Record<string, unknown>;
  const {
    type,
    severity,
    asset,
    subject,
    observedAt,
    evidenceIds,
    triggeringAction,
    sessionReference,
    identityReference,
  } = alert;
  const usesSource = type === "authentication_failure_fanout" ||
    type === "authentication_success_after_fanout";
  const sourceReference = usesSource ? alert.sourceReference : undefined;
  if (
    !isAlertType(type) || !isSentinelAlertSeverity(severity) ||
    (type !== "security_sensor_alert" && severity !== alertSeverities[type]) ||
    !isIdentifier(asset) || !isIdentifier(subject) ||
    (identityReference !== undefined &&
      !isSentinelIdentityReference(identityReference)) ||
    (sessionReference !== undefined &&
      !isSentinelSessionReference(sessionReference)) ||
    (triggeringAction !== undefined &&
      !isSentinelTelemetryAction(triggeringAction)) ||
    typeof observedAt !== "string" || !canonicalUtc.test(observedAt) ||
    !Array.isArray(evidenceIds) || evidenceIds.length < 1 ||
    evidenceIds.length > 6 || !evidenceIds.every(isIdentifier) ||
    new Set(evidenceIds).size !== evidenceIds.length ||
    (usesSource &&
      (!isSentinelSourceReference(sourceReference) ||
        (type === "authentication_failure_fanout" &&
          subject !== sourceReference) ||
        sessionReference !== undefined || identityReference !== undefined ||
        triggeringAction !== undefined ||
        evidenceIds.length !== AUTH_FANOUT_LIMIT +
            (type === "authentication_success_after_fanout" ? 1 : 0)))
  ) {
    throw invalid;
  }
  const time = Date.parse(observedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== observedAt) {
    throw invalid;
  }
  const entraRoleGrant = parseEntraRoleGrantContext(
    alert.entraRoleGrant,
    type,
    triggeringAction,
  );
  return {
    type,
    severity,
    asset,
    subject,
    observedAt,
    evidenceIds: [...evidenceIds],
    ...(triggeringAction !== undefined && { triggeringAction }),
    ...(sessionReference && { sessionReference }),
    ...(identityReference && { identityReference }),
    ...(isSentinelSourceReference(sourceReference) && { sourceReference }),
    ...(entraRoleGrant && { entraRoleGrant }),
  };
}

function appendReference<T>(
  references: Map<string, T[]>,
  key: string,
  value: T,
) {
  const existing = references.get(key);
  if (existing) existing.push(value);
  else references.set(key, [value]);
}

/**
 * Relate telemetry to findings by exact asset IDs or unique asset aliases.
 * This establishes shared asset context. Only explicit graph evidence links
 * are counted as supporting evidence for a finding.
 */
export function buildSentinelCaseReport(
  graph: ReturnType<typeof loadSentinelGraph>,
  alerts: readonly unknown[] = [],
) {
  const findings = graph.report();
  const findingsByAsset = new Map<string, string[]>();
  for (const finding of findings) {
    for (const asset of finding.assets) {
      appendReference(findingsByAsset, asset, finding.id);
    }
  }

  const alertRecordsByAsset = new Map<string, number[]>();
  const matchedAlerts = [];
  const unmatchedAlerts = [];
  for (const [index, raw] of alerts.entries()) {
    const sourceRecord = index + 1;
    const alert = parseSentinelTelemetryAlert(raw, sourceRecord);
    const matchedAsset = graph.resolveAssetId(alert.asset);
    const affectedFindingIds = matchedAsset
      ? findingsByAsset.get(matchedAsset)
      : undefined;
    if (matchedAsset && affectedFindingIds) {
      appendReference(alertRecordsByAsset, matchedAsset, sourceRecord);
      matchedAlerts.push({
        sourceRecord,
        ...alert,
        affectedFindingIds,
        ...(matchedAsset !== alert.asset && { matchedAsset }),
      });
    } else {
      unmatchedAlerts.push({
        sourceRecord,
        ...alert,
        reason: "no_finding_with_matching_asset" as const,
      });
    }
  }

  const assessments = findings.map((finding) => {
    const relatedAlertRecords = finding.assets.flatMap((asset) =>
      alertRecordsByAsset.get(asset) ?? []
    ).sort((a, b) => a - b);
    const gaps = [];
    if (finding.assets.length === 0) gaps.push("no_affected_asset_link");
    if (finding.evidence.length === 0) gaps.push("no_supporting_evidence_link");
    if (finding.controls.length === 0) gaps.push("no_mitigation_control_link");
    if (relatedAlertRecords.length === 0) gaps.push("no_related_alert");
    return {
      ...finding,
      evidenceStatus: finding.evidence.length
        ? "supporting_evidence_linked"
        : "supporting_evidence_missing",
      relatedAlertRecords,
      gaps,
    };
  });

  return {
    version: 1,
    summary: {
      findings: assessments.length,
      findingsWithEvidence:
        assessments.filter((finding) => finding.evidence.length > 0).length,
      findingsWithRelatedAlerts:
        assessments.filter((finding) => finding.relatedAlertRecords.length > 0)
          .length,
      matchedAlerts: matchedAlerts.length,
      unmatchedAlerts: unmatchedAlerts.length,
    },
    findings: assessments,
    matchedAlerts,
    unmatchedAlerts,
  };
}
