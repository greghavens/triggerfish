import type {
  ManagedNotificationChannel,
  ManagedNotificationChannels,
} from "../../core/managed_notification_channels.ts";
import { canFlowTo } from "../../core/types/classification.ts";
import type { OperatorRunToolContext } from "../operator_run_tool.ts";

export const notificationChannelActions = [
  "notification_channels",
  "set_notification_channel",
  "retire_notification_channel",
  "test_notification_channel",
  "notification_deliveries",
] as const;
type Action = typeof notificationChannelActions[number];

export interface OperatorNotificationChannels {
  readonly store: ManagedNotificationChannels;
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
  const { name, destinationOrigin, endpointRef, classification, enabled } =
    raw as Record<string, unknown>;
  if (
    Object.keys(raw).length !== 5 ||
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
  return {
    name,
    destinationOrigin,
    endpointRef,
    classification,
    enabled,
  } as const;
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
  };
  if (
    Object.keys(args).some((key) =>
      key !== "action" &&
      !allowed[action].includes(key)
    )
  ) return;
  const store = config.store;
  if (action === "notification_channels") {
    return { channels: await store.channels() };
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
  if (action === "test_notification_channel") {
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
    const existing = await store.delivery(id, requestId);
    if (existing) {
      return existing.channelVersion === current.version
        ? { delivery: existing }
        : undefined;
    }
    if (
      !await confirm(
        `Send a synthetic notification to ${current.destinationOrigin} using channel ${id} at version ${expectedVersion}?`,
      ) ||
      !await authorize(args)
    ) return;
    const delivery = await store.send(
      current,
      requestId,
      (stillCurrent) =>
        config.sendWebhook(
          current,
          testMessage,
          async () =>
            await authorize(args) &&
            await authorizeOutput(
              current.destinationOrigin,
              current.classification,
              testMessage,
            ) &&
            await stillCurrent(),
        ),
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
  if (JSON.stringify(current) === JSON.stringify(channel)) return { channel };
  if (
    current?.retired || (current?.version ?? 0) !== expectedVersion ||
    !await confirm(`Approve ${action} ${JSON.stringify(channel)}?`) ||
    !await authorize(args)
  ) return;
  const updated = await store.amend(channel, expectedVersion);
  return updated ? { channel: updated } : undefined;
}
