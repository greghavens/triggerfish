import { schedulerAdmissionArchive } from "../../../scheduler/admission_archive.ts";
/** Build recovery dispatch and admission scopes for trusted scheduler sources. */
import { join } from "@std/path";
import {
  type ScheduledObservationSource,
  selectSentinelScheduledObservationRead,
  sentinelLocalObservationKind,
  type TriggerFishConfig,
} from "../../../core/config_types.ts";
import type { SecretStore } from "../../../core/secrets/keychain/keychain.ts";
import { openSchedulerCronAdmissions } from "../../../scheduler/cron/admissions.ts";
import { schedulerRecoveryState } from "../../../scheduler/service_execution.ts";
import type { SchedulerServiceConfig } from "../../../scheduler/service_types.ts";
import { openSchedulerTriggerAdmissions } from "../../../scheduler/triggers/admissions.ts";
import { openSchedulerWebhookAdmissions } from "../../../scheduler/webhooks/admissions.ts";
import { buildWorkflowRecoveryExecutor } from "./agent_recovery.ts";

export function buildSchedulerRecoveryBindings(
  config: Pick<
    TriggerFishConfig,
    "agent_recovery" | "github" | "sentinel" | "scheduler"
  >,
  baseDir: string,
  secrets: SecretStore,
  githubFetch?: typeof fetch,
): Pick<
  SchedulerServiceConfig,
  | "recoverTurn"
  | "recoveryEnabledForSource"
  | "recoveryState"
  | "cronAdmissions"
  | "triggerAdmissions"
  | "webhookAdmissions"
> {
  if (config.agent_recovery?.scheduler !== true) return {};
  const recoveryOptions = { checklistRole: "scheduled" as const, githubFetch };
  const defaultRecovery = buildWorkflowRecoveryExecutor(
    config,
    baseDir,
    secrets,
    undefined,
    undefined,
    false,
    recoveryOptions,
  );
  const selectGrant = (source: ScheduledObservationSource) =>
    selectSentinelScheduledObservationRead(
      config.sentinel?.scheduled_observation_reads,
      source,
    );
  return {
    recoveryEnabledForSource(source) {
      if (defaultRecovery) return true;
      const grant = selectGrant(source);
      return !!grant &&
        sentinelLocalObservationKind(grant.observation_id) !== undefined;
    },
    recoveryState: (id) =>
      schedulerRecoveryState(join(baseDir, "agent-recovery.db"), id),
    recoverTurn(execution, orchestrator, options) {
      const configuredProof =
        config.agent_recovery?.github_repositories?.length &&
        config.scheduler?.goal_completion?.some(({ criteria, policy }) =>
          policy === "operator" &&
          criteria.some((criterion) =>
            criterion.kind === execution.kind &&
            criterion.source_id === execution.sourceId
          )
        );
      const admission = configuredProof
        ? schedulerAdmissionArchive(baseDir, {
          role: "scheduled",
          runId: execution.id,
          sessionId: options.session.id,
          sourceId: execution.sourceId,
          classification: options.targetClassification,
        })
        : undefined;
      const lease = admission?.liveLease();
      const authorizeScheduledGoalScope = lease && admission
        ? () =>
          Promise.resolve(
            !options.signal?.aborted && admission.liveLease() === lease,
          )
        : undefined;
      const recover = selectGrant(execution) || authorizeScheduledGoalScope
        ? buildWorkflowRecoveryExecutor(
          config,
          baseDir,
          secrets,
          undefined,
          execution,
          false,
          { ...recoveryOptions, authorizeScheduledGoalScope },
        )
        : defaultRecovery;
      if (!recover) {
        return Promise.resolve({
          ok: false,
          error: "This execution has no recovery grant.",
        });
      }
      return recover(execution.id, orchestrator, options, {
        resumeOnly: execution.resumeOnly,
        resumePaused: execution.resumePaused,
      });
    },
    cronAdmissions: openSchedulerCronAdmissions(
      join(baseDir, "scheduler-cron-admissions.db"),
    ),
    triggerAdmissions: openSchedulerTriggerAdmissions(
      join(baseDir, "scheduler-trigger-admissions.db"),
    ),
    webhookAdmissions: openSchedulerWebhookAdmissions(
      join(baseDir, "scheduler-webhook-admissions.db"),
    ),
  };
}
