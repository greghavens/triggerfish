/**
 * Scheduler service configuration builder.
 *
 * Transforms the YAML config's scheduler section into a typed
 * SchedulerServiceConfig with sensible defaults.
 * @module
 */

import { join } from "@std/path";
import type { TriggerFishConfig } from "../../../core/config.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type {
  OrchestratorFactory,
  SchedulerServiceConfig,
  WebhookSourceConfig,
} from "../../../scheduler/service_types.ts";

/** Build webhook sources map from config. */
function buildWebhookSources(
  config: TriggerFishConfig,
): Record<string, WebhookSourceConfig> {
  const sources: Record<string, WebhookSourceConfig> = {};
  const webhookSources = config.scheduler?.webhooks?.sources;
  if (!webhookSources) return sources;

  for (const [id, src] of Object.entries(webhookSources)) {
    sources[id] = {
      secret: src.secret,
      classification: src.classification as ClassificationLevel,
    };
  }
  return sources;
}

/** Determine whether triggers are enabled from config. */
function resolveTriggerEnabled(config: TriggerFishConfig): boolean {
  const trigger = config.scheduler?.trigger;
  const enabled = trigger?.enabled ?? true;
  const interval = trigger?.interval_minutes ?? 30;
  return enabled && interval !== 0;
}

/**
 * Build a SchedulerServiceConfig from the YAML config with defaults.
 */
export function buildSchedulerConfig(
  config: TriggerFishConfig,
  baseDir: string,
  factory: OrchestratorFactory,
): SchedulerServiceConfig {
  const sched = config.scheduler;

  return {
    orchestratorFactory: factory,
    triggerMdPath: join(baseDir, "TRIGGER.md"),
    trigger: {
      enabled: resolveTriggerEnabled(config),
      intervalMinutes: sched?.trigger?.interval_minutes ?? 30,
      quietHours: sched?.trigger?.quiet_hours
        ? {
          start: sched.trigger.quiet_hours.start ?? 22,
          end: sched.trigger.quiet_hours.end ?? 7,
        }
        : { start: 22, end: 7 },
      classificationCeiling: (sched?.trigger?.classification_ceiling ??
        "CONFIDENTIAL") as ClassificationLevel,
    },
    webhooks: {
      enabled: sched?.webhooks?.enabled ?? false,
      sources: buildWebhookSources(config),
      maxAgeMs: sched?.webhooks?.max_age_ms,
      replayGuardSize: sched?.webhooks?.replay_guard_size,
    },
  };
}
