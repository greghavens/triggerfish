import {
  type ManagedNotificationChannel,
  type ManagedNotificationChannels,
  type ManagedSentinelIncidentScope,
  type ManagedSentinelIncidentSource,
  maxManagedNotificationRetries,
} from "../../core/managed_notification_channels.ts";
import { canFlowTo } from "../../core/types/classification.ts";
import { isSentinelCaseId } from "../../sentinel/cases.ts";
import type { OperatorRunToolContext } from "../operator_run_tool.ts";
import {
  matchesSentinelIncidentSubscription,
  sentinelIncidentNotificationBody,
} from "./sentinel_incidents.ts";

export const notificationChannelActions = [
  "notification_channels",
  "set_notification_channel",
  "retire_notification_channel",
  "test_notification_channel",
  "notification_deliveries",
  "retry_notification_delivery",
] as const;
type Action = typeof notificationChannelActions[number];

export interface OperatorNotificationChannels {
  readonly store: ManagedNotificationChannels;
  readonly readSentinelIncidentScope?: (
    caseId: string,
  ) => ManagedSentinelIncidentScope | undefined;
  readonly isCurrentSentinelIncident?: (
    source: ManagedSentinelIncidentSource,
  ) => boolean;
  readonly bindWebhookDestination: (
    channel: ManagedNotificationChannel,
  ) => Promise<string | undefined>;
  readonly sendWebhook: (
    channel: ManagedNotificationChannel,
    body: string,
    authorize: () => Promise<boolean>,
  ) => Promise<"delivered" | "blocked" | "uncertain">;
}

const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const testMessage = JSON.stringify({
  type: "triggerfish.notification.test",
  message: "Triggerfish notification channel test",
});

function parseChannelSettings(raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const {
    name,
    destinationOrigin,
    endpointRef,
    classification,
    enabled,
    sentinelIncidents,
  } = raw as Record<string, unknown>;
  if (
    Object.keys(raw).length !== (sentinelIncidents === undefined ? 5 : 6) ||
    typeof name !== "string" || !/^[a-zA-Z0-9 _.-]{1,64}$/.test(name) ||
    typeof destinationOrigin !== "string" ||
    typeof endpointRef !== "string" ||
    !/^notification_[a-z0-9_]{1,64}$/.test(endpointRef) ||
    (classification !== "PUBLIC" && classification !== "INTERNAL") ||
    typeof enabled !== "boolean"
  ) return;
  try {
    const url = new URL(destinationOrigin);
    if (url.protocol !== "https:" || url.origin !== destinationOrigin) return;
  } catch {
    return;
  }
  let scope: ManagedSentinelIncidentScope | undefined;
  if (sentinelIncidents !== undefined) {
    if (!sentinelIncidents || typeof sentinelIncidents !== "object") return;
    const { caseId, runId, afterRevision } = sentinelIncidents as Record<
      string,
      unknown
    >;
    if (
      Object.keys(sentinelIncidents).length !== 3 ||
      !isSentinelCaseId(caseId) ||
      typeof runId !== "string" || !/^[a-f0-9-]{36}$/i.test(runId) ||
      typeof afterRevision !== "number" ||
      !Number.isSafeInteger(afterRevision) ||
      afterRevision < 1 || classification !== "INTERNAL"
    ) return;
    scope = { caseId, runId, afterRevision };
  }
  return {
    name,
    destinationOrigin,
    endpointRef,
    classification,
    enabled,
    ...(scope && { sentinelIncidents: scope }),
  } as const;
}

function publicChannel(channel: ManagedNotificationChannel) {
  const { endpointFingerprint: _endpointFingerprint, ...visible } = channel;
  return visible;
}

export async function executeOperatorNotificationChannel(
  config: OperatorNotificationChannels,
  confirm: (question: string) => Promise<boolean>,
  action: Action,
  args: Record<string, unknown>,
  context: OperatorRunToolContext | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (
    !context?.authenticatedOwnerSessionId || context.ceiling !== "RESTRICTED"
  ) return;
  const authorize = context.authorizeOwnerRunCall;
  if (!authorize || !await authorize(args)) return;
  const allowed: Record<Action, readonly string[]> = {
    notification_channels: [],
    set_notification_channel: [
      "notificationChannelId",
      "expectedVersion",
      "notificationChannelSettings",
    ],
    retire_notification_channel: ["notificationChannelId", "expectedVersion"],
    test_notification_channel: [
      "notificationChannelId",
      "expectedVersion",
      "requestId",
    ],
    notification_deliveries: ["notificationChannelId"],
    retry_notification_delivery: [
      "notificationChannelId",
      "notificationDeliveryId",
      "requestId",
      "expectedVersion",
      "kind",
      "id",
      "runId",
      "revision",
    ],
  };
  if (
    Object.keys(args).some((key) =>
      key !== "action" &&
      !allowed[action].includes(key)
    )
  ) return;
  const store = config.store;
  if (action === "notification_channels") {
    return { channels: (await store.channels()).map(publicChannel) };
  }
  const { notificationChannelId: id, expectedVersion, requestId } = args;
  if (typeof id !== "string" || !idPattern.test(id)) return;
  if (action === "notification_deliveries") {
    return { deliveries: (await store.deliveries(id)).slice(0, 100) };
  }
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
    expectedVersion >= Number.MAX_SAFE_INTEGER
  ) return;
  const current = await store.get(id);
  if (
    action === "test_notification_channel" ||
    action === "retry_notification_delivery"
  ) {
    const authorizeOutput = context.authorizeNotificationOutput;
    if (
      !current?.enabled || current.retired ||
      current.version !== expectedVersion || typeof requestId !== "string" ||
      !idPattern.test(requestId) || !authorizeOutput ||
      !canFlowTo(
        context.inputClassification ?? "RESTRICTED",
        current.classification,
      )
    ) return;

    const retrying = action === "retry_notification_delivery";
    const deliveryId = retrying ? args.notificationDeliveryId : requestId;
    if (
      typeof deliveryId !== "string" ||
      !/^[a-z0-9][a-z0-9:_-]{0,159}$/.test(deliveryId)
    ) return;
    const existing = await store.delivery(id, deliveryId);
    if (existing && existing.channelVersion !== current.version) return;
    const source = existing?.source;
    const sourceCurrent = () =>
      !source ||
      (context.authorizeSentinelCaseRead?.(source.caseId, source.revision) !==
          false &&
        matchesSentinelIncidentSubscription(
          current.sentinelIncidents,
          source,
        ) &&
        config.isCurrentSentinelIncident?.(source) === true);
    if (
      source
        ? args.kind !== "sentinel" || args.id !== source.caseId ||
          args.runId !== source.runId || args.revision !== source.revision ||
          !sourceCurrent()
        : [args.kind, args.id, args.runId, args.revision].some((value) =>
          value !== undefined
        )
    ) return;
    const attempts = existing?.retries ?? [];
    if (
      existing &&
      (!retrying || attempts.some((attempt) => attempt.requestId === requestId))
    ) {
      return { delivery: existing };
    }
    if (
      retrying && (existing?.state !== "blocked" ||
        attempts.length >= maxManagedNotificationRetries)
    ) return;

    const body = source
      ? sentinelIncidentNotificationBody(source)
      : testMessage;
    const exactDelivery = retrying
      ? `Retry delivery ${deliveryId} (attempt ${attempts.length + 2})`
      : "Send a synthetic notification";
    if (
      !await confirm(
        `${exactDelivery} to ${current.destinationOrigin} using channel ${id} at version ${expectedVersion}?`,
      ) ||
      !await authorize(args) || !sourceCurrent()
    ) return;
    const delivery = await store.send(
      current,
      deliveryId,
      (stillCurrent) =>
        config.sendWebhook(
          current,
          body,
          async () =>
            sourceCurrent() && await authorize(args) &&
            await authorizeOutput(
              current.id,
              current.destinationOrigin,
              current.classification,
              body,
              source,
            ) &&
            await stillCurrent() && sourceCurrent(),
        ),
      retrying
        ? { retry: { requestId, expectedRetries: attempts.length } }
        : undefined,
    );
    return delivery ? { delivery } : undefined;
  }
  let channel: ManagedNotificationChannel;
  if (action === "set_notification_channel") {
    const settings = parseChannelSettings(args.notificationChannelSettings);
    if (!settings) return;
    channel = {
      id,
      version: expectedVersion + 1,
      provider: "webhook",
      ...settings,
    };
  } else {
    if (!current) return;
    channel = {
      ...current,
      version: expectedVersion + 1,
      enabled: false,
      retired: true,
    };
  }
  const visible = publicChannel(channel);
  if (
    current &&
    JSON.stringify(publicChannel(current)) === JSON.stringify(visible)
  ) {
    return { channel: visible };
  }
  if (current?.retired || (current?.version ?? 0) !== expectedVersion) return;
  const scopeCurrent = () => {
    const scope = action === "set_notification_channel"
      ? channel.sentinelIncidents
      : undefined;
    if (!scope) return true;
    const observed = config.readSentinelIncidentScope?.(scope.caseId);
    return observed?.runId === scope.runId &&
      observed.afterRevision === scope.afterRevision &&
      context.authorizeSentinelCaseRead?.(scope.caseId, scope.afterRevision) !==
        false;
  };
  if (!scopeCurrent()) return;
  const fingerprint = channel.enabled
    ? await config.bindWebhookDestination(channel)
    : undefined;
  if (channel.enabled && !fingerprint) return;
  if (
    !await confirm(`Approve ${action} ${JSON.stringify(visible)}?`) ||
    !await authorize(args) || !scopeCurrent()
  ) return;
  if (fingerprint) {
    if (
      await config.bindWebhookDestination(channel) !== fingerprint ||
      !await authorize(args) || !scopeCurrent()
    ) return;
    channel = { ...channel, endpointFingerprint: fingerprint };
  }
  const updated = await store.amend(channel, expectedVersion);
  return updated ? { channel: publicChannel(updated) } : undefined;
}
