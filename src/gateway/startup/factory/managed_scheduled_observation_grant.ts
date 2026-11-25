/** Reopen a pinned scheduled observation with the original grant policy. */
import { createHash } from "node:crypto";
import {
  selectSentinelScheduledObservationRead,
  sentinelLocalObservationKind,
  type SentinelObservationReference,
  type TriggerFishConfig,
} from "../../../core/config_types.ts";
import type { ManagedTranscriptGrantReader } from "../../../core/conversation/managed_evidence.ts";
import {
  canFlowTo,
  parseClassification,
} from "../../../core/types/classification.ts";
import type { CronManager } from "../../../scheduler/cron/parser.ts";
import { readSentinelAssessment } from "../../../sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../../sentinel/cases.ts";
import {
  createScheduledObservationRead,
  matchesScheduledObservationProjection,
} from "../../scheduled_observation_tool.ts";

export function managedObservationGrantDigest(
  grant: SentinelObservationReference,
) {
  return createHash("sha256").update(JSON.stringify([
    grant.case,
    grant.run_id,
    grant.revision,
    grant.observation_id,
  ])).digest("hex");
}

export function buildManagedScheduledObservationGrant(
  config: Pick<TriggerFishConfig, "sentinel" | "scheduler">,
  baseDir: string,
  jobs: Pick<CronManager, "list">,
  authorize: Parameters<typeof createScheduledObservationRead>[2],
): ManagedTranscriptGrantReader | undefined {
  if (!authorize || !config.sentinel?.scheduled_observation_reads?.length) {
    return;
  }
  return async (source, digest, policy) => {
    const match = /^scheduler:(cron|trigger|webhook):([a-zA-Z0-9_.:-]{1,120})$/
      .exec(source);
    if (!match || policy.signal?.aborted) return;
    const kind = match[1] as "cron" | "trigger" | "webhook";
    const sourceId = match[2];
    const selector = { kind, sourceId };
    const ceiling = () => {
      if (kind === "cron") {
        return jobs.list().find(({ id }) => id === sourceId)
          ?.classificationCeiling;
      }
      if (kind === "trigger") {
        const trigger = config.scheduler?.trigger;
        return sourceId === "trigger" && trigger?.enabled !== false &&
            trigger?.interval_minutes !== 0
          ? trigger?.classification_ceiling ?? "CONFIDENTIAL"
          : undefined;
      }
      const webhooks = config.scheduler?.webhooks;
      const configured = webhooks?.sources?.[sourceId];
      return webhooks?.enabled && configured?.secret
        ? configured.classification
        : undefined;
    };
    const grant = selectSentinelScheduledObservationRead(
      config.sentinel?.scheduled_observation_reads,
      selector,
    );
    if (
      !grant || sentinelLocalObservationKind(grant.observation_id) ||
      managedObservationGrantDigest(grant) !== digest
    ) return;
    const current = () => {
      try {
        const currentCeiling = parseClassification(ceiling() ?? "");
        const state = readSentinelAssessment(
          resolveSentinelCasePath(baseDir, grant.case),
        );
        const selected = selectSentinelScheduledObservationRead(
          config.sentinel?.scheduled_observation_reads,
          selector,
        );
        return !policy.signal?.aborted && selected && currentCeiling.ok &&
          canFlowTo("INTERNAL", currentCeiling.value) &&
          state?.plan.runId === grant.run_id &&
          state.revision === grant.revision &&
          managedObservationGrantDigest(selected) === digest;
      } catch {
        return false;
      }
    };
    if (!current()) return;
    const reader = createScheduledObservationRead(baseDir, grant, authorize);
    const text = await reader({}, policy);
    return current() && text.startsWith("{")
      ? {
        result: text,
        current: () =>
          !!current() &&
          matchesScheduledObservationProjection(baseDir, grant, text),
      }
      : undefined;
  };
}
