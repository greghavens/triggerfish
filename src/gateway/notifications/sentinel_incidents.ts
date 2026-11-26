import type {
  ManagedSentinelIncidentScope,
  ManagedSentinelIncidentSource,
} from "../../core/managed_notification_channels.ts";
import type { HookRunner } from "../../core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../core/types/session.ts";
import { resolveSentinelCasePath } from "../../sentinel/cases.ts";
import {
  readSentinelAssessment,
  readSentinelNotificationState,
} from "../../sentinel/assessment_store.ts";
import type { OperatorNotificationChannels } from "./operator_channels.ts";

export function readSentinelIncidentScope(
  baseDir: string,
  caseId: string,
): ManagedSentinelIncidentScope | undefined {
  const path = resolveSentinelCasePath(baseDir, caseId);
  const state = readSentinelAssessment(path);
  if (
    !state?.active || !state.plan.runId || state.paused ||
    readSentinelNotificationState(path).enabled === false
  ) return;
  return { caseId, runId: state.plan.runId, afterRevision: state.revision };
}

/** Fan out one committed, currently authorized event to reviewed subscriptions. */
export function createSentinelIncidentDelivery(
  baseDir: string,
  channels: OperatorNotificationChannels,
  hooks: HookRunner,
) {
  const session = {
    ...createSession({
      userId: "owner" as UserId,
      channelId: "sentinel-notification" as ChannelId,
    }),
    taint: "INTERNAL" as const,
  };
  return async (
    source: ManagedSentinelIncidentSource,
    coordinatorCurrent: () => boolean,
  ): Promise<void> => {
    const isCurrent = () => {
      if (!coordinatorCurrent()) return false;
      const scope = readSentinelIncidentScope(baseDir, source.caseId);
      if (
        scope?.runId !== source.runId ||
        scope.afterRevision !== source.revision
      ) return false;
      const receipt = readSentinelNotificationState(
        resolveSentinelCasePath(baseDir, source.caseId),
      ).latest;
      return receipt?.revision === source.revision &&
        receipt.state !== "disabled" && receipt.state !== "pending";
    };
    if (!isCurrent()) return;
    const id = `incident:${source.caseId}:${source.runId}:${source.revision}`;
    const body = JSON.stringify({
      type: "triggerfish.sentinel.incident_increase",
      caseId: source.caseId,
      runId: source.runId,
      revision: source.revision,
      message: "Sentinel detected an increase in incident candidates.",
    });
    const eligible = (await channels.store.channels()).filter((channel) => {
      const scope = channel.sentinelIncidents;
      return channel.enabled && channel.classification === "INTERNAL" &&
        scope?.caseId === source.caseId && scope.runId === source.runId &&
        scope.afterRevision < source.revision;
    });
    await Promise.all(eligible.map(async (channel) => {
      if (!isCurrent()) return;
      const metadata = {
        destination: channel.destinationOrigin,
        notification_channel_id: channel.id,
        target_classification: channel.classification,
        case_id: source.caseId,
        run_id: source.runId,
        evidence_revision: source.revision,
      };
      await channels.store.send(
        channel,
        id,
        (stillCurrent) =>
          channels.sendWebhook(channel, body, async () => {
            if (!isCurrent()) return false;
            const decision = await hooks.evaluateHook("PRE_OUTPUT", {
              session,
              input: { ...metadata, content: body },
              auditInput: metadata,
            });
            return decision.allowed && await stillCurrent() && isCurrent();
          }),
        source,
      );
    }));
  };
}
