/** Resolve a retained defensive-alert observation within its exact saved asset scope. */
import {
  readSentinelAssessmentAlerts,
  readSentinelAssessmentRevision,
  readSentinelLatestRunRevision,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
} from "./assessment_store.ts";
import {
  projectSentinelExactUpstreamAlert,
  sentinelTelemetryAssetResolver,
} from "./defense_coverage.ts";

export function resolveWorkerNarrativeAlert(
  path: string,
  runId: string,
  revision: number,
  asset: string,
  evidenceId: string,
  checkId: string,
  archived = false,
) {
  if (readSentinelRunIdForRevision(path, revision) !== runId) return;
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  if (!snapshot) return;
  const saved = readSentinelOperatingConstraints(path, runId, revision)
    ?.constraints;
  const resolveSaved = sentinelTelemetryAssetResolver(snapshot, saved);
  const alerts = readSentinelAssessmentAlerts(path, revision);
  const projection = projectSentinelExactUpstreamAlert(
    alerts,
    revision,
    checkId,
    evidenceId,
    (alert) => resolveSaved(alert) === asset,
  );
  const alert = projection && alerts?.[projection.matches[0].sourceRecord - 1];
  if (!alert) return;
  if (!archived) {
    const currentRevision = readSentinelLatestRunRevision(path, runId);
    const current = currentRevision &&
      readSentinelAssessmentRevision(path, currentRevision)?.result
        .sharedGraph.snapshot;
    const policy = readSentinelOperatingConstraints(path, runId);
    if (
      !current ||
      sentinelTelemetryAssetResolver(current, policy?.constraints)(alert) !==
        asset
    ) {
      return;
    }
    return {
      alert,
      projection,
      constraintsVersion: policy?.version,
      constraintsDigest: policy?.digest,
    };
  }
  return { alert, projection };
}
