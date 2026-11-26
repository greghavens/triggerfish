import { isDeepStrictEqual } from "node:util";
import {
  canRetryManagedNotificationDelivery,
  managedFindingEvents,
  type ManagedNotificationChannel,
  type ManagedNotificationChannels,
  type ManagedNotificationOutcome,
  managedNotificationProviders,
  type ManagedSentinelFindingSource,
  type ManagedSentinelIncidentScope,
  type ManagedSentinelIncidentSource,
  maxManagedNotificationRetries,
} from "../../core/managed_notification_channels.ts";
import { canFlowTo } from "../../core/types/classification.ts";
import { isSentinelCaseId } from "../../sentinel/cases.ts";
import type { OperatorRunToolContext } from "../operator_run_tool.ts";
import {
  matchesSentinelFindingSubscription,
  sentinelFindingNotificationBody,
} from "./sentinel_findings.ts";
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
  "notification_delivery",
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
  readonly readSentinelFindingScope?: (
    caseId: string,
  ) =>
    | (ManagedSentinelIncidentScope & { readonly afterSequence: number })
    | undefined;
  readonly isCurrentSentinelFinding?: (
    source: ManagedSentinelFindingSource,
  ) => boolean;
  readonly bindWebhookDestination: (
    channel: ManagedNotificationChannel,
  ) => Promise<string | undefined>;
  readonly sendWebhook: (
    channel: ManagedNotificationChannel,
    body: string,
    authorize: () => Promise<boolean>,
  ) => Promise<ManagedNotificationOutcome>;
}

const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const secretRefPattern = /^notification_[a-z0-9_]{1,64}$/;
const deliveryIdPattern = /^[a-z0-9][a-z0-9:_-]{0,159}$/;
export const managedDeliveryStates = [
  "in_flight",
  "delivered",
  "blocked",
  "rejected",
  "rate_limited",
  "uncertain",
] as const;
export const managedEventKinds = [
  "test",
  "sentinel_incident_increase",
  ...managedFindingEvents,
] as const;
const testMessage = JSON.stringify({
  type: "triggerfish.notification.test",
  message: "Triggerfish notification channel test",
});

function parseSentinelSubscription(value: unknown, finding: boolean) {
  if (!value || typeof value !== "object") return;
  const { caseId, runId, afterRevision, events } = value as Record<
    string,
    unknown
  >;
  if (
    Object.keys(value).length !== (finding ? 4 : 3) ||
    !isSentinelCaseId(caseId) || typeof runId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(runId) || typeof afterRevision !== "number" ||
    !Number.isSafeInteger(afterRevision) || afterRevision < 1
  ) return;
  if (!finding) return { caseId, runId, afterRevision };
  if (!Array.isArray(events)) return;
  const selected = managedFindingEvents.filter((kind) => events.includes(kind));
  if (!selected.length || selected.length !== events.length) return;
  return { caseId, runId, afterRevision, events: selected };
}

function parseChannelSettings(raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const {
    name,
    destinationOrigin,
    endpointRef,
    provider: rawProvider,
    signingSecretRef,
    classification,
    enabled,
    sentinelIncidents,
    sentinelFindings,
  } = raw as Record<string, unknown>;
  const provider = managedNotificationProviders.find((name) =>
    name === (rawProvider ?? "webhook")
  );
  if (
    Object.keys(raw).length !== 5 +
        Number(rawProvider !== undefined) +
        Number(signingSecretRef !== undefined) +
        Number(sentinelIncidents !== undefined) +
        Number(sentinelFindings !== undefined) ||
    typeof name !== "string" || !/^[a-zA-Z0-9 _.-]{1,64}$/.test(name) ||
    typeof destinationOrigin !== "string" ||
    typeof endpointRef !== "string" ||
    !secretRefPattern.test(endpointRef) || !provider ||
    (signingSecretRef !== undefined && (
      (provider !== "dingtalk" && provider !== "feishu") ||
      typeof signingSecretRef !== "string" ||
      !secretRefPattern.test(signingSecretRef) ||
      signingSecretRef === endpointRef
    )) ||
    (classification !== "PUBLIC" && classification !== "INTERNAL") ||
    typeof enabled !== "boolean"
  ) return;
  try {
    const url = new URL(destinationOrigin);
    if (url.protocol !== "https:" || url.origin !== destinationOrigin) return;
  } catch {
    return;
  }
  const incidentScope = sentinelIncidents === undefined
    ? undefined
    : parseSentinelSubscription(sentinelIncidents, false);
  const findingScope = sentinelFindings === undefined
    ? undefined
    : parseSentinelSubscription(sentinelFindings, true);
  if (
    (sentinelIncidents !== undefined && !incidentScope) ||
    (sentinelFindings !== undefined && !findingScope?.events) ||
    ((incidentScope || findingScope) && classification !== "INTERNAL")
  ) return;
  return {
    name,
    destinationOrigin,
    endpointRef,
    provider,
    ...(typeof signingSecretRef === "string" && { signingSecretRef }),
    classification,
    enabled,
    ...(incidentScope && { sentinelIncidents: incidentScope }),
    ...(findingScope?.events && {
      sentinelFindings: { ...findingScope, events: findingScope.events },
    }),
  } as const;
}

function publicChannel(channel: ManagedNotificationChannel) {
  const {
    endpointFingerprint: _endpointFingerprint,
    sentinelFindings,
    ...visible
  } = channel;
  if (!sentinelFindings) return visible;
  const { afterSequence: _afterSequence, ...scope } = sentinelFindings;
  return { ...visible, sentinelFindings: scope };
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
    notification_deliveries: [
      "notificationChannelId",
      "notificationDeliveryState",
      "notificationEventKind",
      "limit",
      "cursor",
    ],
    notification_delivery: ["notificationChannelId", "notificationDeliveryId"],
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
  if (action === "notification_delivery") {
    const deliveryId = args.notificationDeliveryId;
    if (typeof deliveryId !== "string" || !deliveryIdPattern.test(deliveryId)) {
      return;
    }
    const delivery = await store.delivery(id, deliveryId);
    return delivery && await authorize(args) ? { delivery } : undefined;
  }
  if (action === "notification_deliveries") {
    const {
      notificationDeliveryState: state,
      notificationEventKind: kind,
      limit = 25,
      cursor,
    } = args;
    if (
      (state !== undefined &&
        !managedDeliveryStates.some((value) => value === state)) ||
      (kind !== undefined &&
        !managedEventKinds.some((value) => value === kind)) ||
      typeof limit !== "number" || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > 100
    ) return;
    const prefix = `${id}:${state ?? "all"}:${kind ?? "all"}:`;
    if (
      cursor !== undefined && (
        typeof cursor !== "string" || !cursor.startsWith(prefix) ||
        !deliveryIdPattern.test(cursor.slice(prefix.length))
      )
    ) return;
    const rows = (await store.deliveries(id)).filter((delivery) =>
      (state === undefined || delivery.state === state) &&
      (kind === undefined || (delivery.source?.kind ?? "test") === kind)
    );
    const previous = cursor === undefined
      ? -1
      : rows.findIndex((row) => row.id === cursor.slice(prefix.length));
    if ((cursor !== undefined && previous < 0) || !await authorize(args)) {
      return;
    }
    const start = previous + 1;
    const deliveries = [];
    let remaining = 6500;
    for (const row of rows.slice(start, start + limit)) {
      remaining -= JSON.stringify(row).length + 1;
      if (remaining < 0) break;
      deliveries.push(row);
    }
    const last = deliveries.at(-1);
    return {
      deliveries,
      total: rows.length,
      ...(last && start + deliveries.length < rows.length &&
        { nextCursor: prefix + last.id }),
    };
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
      !deliveryIdPattern.test(deliveryId)
    ) return;
    const existing = await store.delivery(id, deliveryId);
    if (existing && existing.channelVersion !== current.version) return;
    const source = existing?.source;
    const sourceCurrent = () =>
      !source ||
      (context.authorizeSentinelCaseRead?.(source.caseId, source.revision) !==
          false &&
        (source.kind === "sentinel_incident_increase"
          ? matchesSentinelIncidentSubscription(
            current.sentinelIncidents,
            source,
          ) &&
            config.isCurrentSentinelIncident?.(source) === true
          : matchesSentinelFindingSubscription(
            current.sentinelFindings,
            source,
          ) &&
            config.isCurrentSentinelFinding?.(source) === true));
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
      retrying && (!canRetryManagedNotificationDelivery(existing?.state) ||
        attempts.length >= maxManagedNotificationRetries)
    ) return;

    const body = source
      ? source.kind === "sentinel_incident_increase"
        ? sentinelIncidentNotificationBody(source)
        : sentinelFindingNotificationBody(source)
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
    isDeepStrictEqual(publicChannel(current), visible)
  ) {
    return { channel: visible };
  }
  if (current?.retired || (current?.version ?? 0) !== expectedVersion) return;
  const findingScope = action === "set_notification_channel"
    ? channel.sentinelFindings
    : undefined;
  const findingBaseline = findingScope &&
    config.readSentinelFindingScope?.(findingScope.caseId);
  const sameCase = (
    scope: ManagedSentinelIncidentScope,
    observed: ManagedSentinelIncidentScope | undefined,
  ) =>
    observed?.runId === scope.runId &&
    observed.afterRevision === scope.afterRevision &&
    context.authorizeSentinelCaseRead?.(scope.caseId, scope.afterRevision) !==
      false;
  const scopeCurrent = () => {
    const incident = action === "set_notification_channel"
      ? channel.sentinelIncidents
      : undefined;
    if (
      incident &&
      !sameCase(incident, config.readSentinelIncidentScope?.(incident.caseId))
    ) return false;
    if (!findingScope) return true;
    const observed = config.readSentinelFindingScope?.(findingScope.caseId);
    return !!findingBaseline && sameCase(findingScope, observed) &&
      observed?.afterSequence === findingBaseline.afterSequence;
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
  if (findingScope && findingBaseline) {
    channel = {
      ...channel,
      sentinelFindings: {
        ...findingScope,
        afterSequence: findingBaseline.afterSequence,
      },
    };
  }
  const updated = await store.amend(channel, expectedVersion);
  return updated ? { channel: publicChannel(updated) } : undefined;
}
