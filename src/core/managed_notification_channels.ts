import type { StorageProvider } from "./storage/provider.ts";
import type { ClassificationLevel } from "./types/classification.ts";

export interface ManagedSentinelIncidentScope {
  readonly caseId: string;
  readonly runId: string;
  readonly afterRevision: number;
}

export interface ManagedSentinelIncidentSource {
  readonly kind: "sentinel_incident_increase";
  readonly caseId: string;
  readonly runId: string;
  readonly revision: number;
}

export interface ManagedNotificationChannel {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly provider: "webhook";
  readonly destinationOrigin: string;
  readonly endpointRef: string;
  readonly classification: ClassificationLevel;
  readonly enabled: boolean;
  readonly retired?: true;
  readonly sentinelIncidents?: ManagedSentinelIncidentScope;
}

type DeliveryState = "in_flight" | "delivered" | "blocked" | "uncertain";

interface ManagedNotificationAttempt {
  readonly requestId: string;
  readonly createdAt: string;
  readonly state: DeliveryState;
}

export const maxManagedNotificationRetries = 3;

export interface ManagedNotificationDelivery {
  readonly id: string;
  readonly channelId: string;
  readonly channelVersion: number;
  readonly createdAt: string;
  readonly source?: ManagedSentinelIncidentSource;
  readonly state: DeliveryState;
  readonly retries?: readonly ManagedNotificationAttempt[];
}

const channelPrefix = "managed-notification-channel:";
const deliveryPrefix = "managed-notification-delivery:";

/** Durable channel versions and send claims, with only metadata in the ledger. */
export function createManagedNotificationChannels(storage: StorageProvider) {
  const compareAndSet = storage.compareAndSet?.bind(storage);
  if (!compareAndSet) {
    throw new Error("Notification administration requires atomic storage.");
  }

  async function load<T>(key: string): Promise<T | undefined> {
    const raw = await storage.get(key);
    return raw === null ? undefined : JSON.parse(raw) as T;
  }

  async function list<T>(prefix: string): Promise<T[]> {
    const records = await Promise.all(
      (await storage.list(prefix)).map((key) => load<T>(key)),
    );
    return records.filter((record) => record !== undefined) as T[];
  }

  async function get(
    id: string,
  ): Promise<ManagedNotificationChannel | undefined> {
    return await load<ManagedNotificationChannel>(channelPrefix + id);
  }

  return {
    get,
    async channels(): Promise<ManagedNotificationChannel[]> {
      return (await list<ManagedNotificationChannel>(channelPrefix))
        .filter((channel) => !channel.retired);
    },
    async amend(
      channel: ManagedNotificationChannel,
      expectedVersion: number,
    ): Promise<ManagedNotificationChannel | undefined> {
      const key = channelPrefix + channel.id;
      const raw = await storage.get(key);
      const current = raw === null
        ? undefined
        : JSON.parse(raw) as ManagedNotificationChannel;
      const desired = JSON.stringify(channel);
      if (desired === raw) return channel;
      if (
        current?.retired ||
        (current?.version ?? 0) !== expectedVersion ||
        channel.version !== expectedVersion + 1
      ) return;
      return await compareAndSet(key, raw, desired) ? channel : undefined;
    },
    async deliveries(
      channelId: string,
    ): Promise<ManagedNotificationDelivery[]> {
      const deliveries = await list<ManagedNotificationDelivery>(
        deliveryPrefix + channelId + ":",
      );
      return deliveries.sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
      );
    },
    async delivery(channelId: string, id: string) {
      return await load<ManagedNotificationDelivery>(
        deliveryPrefix + channelId + ":" + id,
      );
    },
    async send(
      channel: ManagedNotificationChannel,
      id: string,
      transport: (
        stillCurrent: () => Promise<boolean>,
      ) => Promise<"delivered" | "blocked" | "uncertain">,
      options?: {
        readonly source?: ManagedNotificationDelivery["source"];
        readonly retry?: {
          readonly requestId: string;
          readonly expectedRetries: number;
        };
      },
    ): Promise<ManagedNotificationDelivery | undefined> {
      const key = deliveryPrefix + channel.id + ":" + id;
      const raw = await storage.get(key);
      const existing = raw === null
        ? undefined
        : JSON.parse(raw) as ManagedNotificationDelivery;
      const retry = options?.retry;
      if (existing && existing.channelVersion !== channel.version) return;
      if (!retry && existing) return existing;
      if (retry) {
        if (!existing) return;
        const attempts = existing.retries ?? [];
        if (attempts.some(({ requestId }) => requestId === retry.requestId)) {
          return existing;
        }
        if (
          existing.state !== "blocked" ||
          attempts.length !== retry.expectedRetries ||
          attempts.length >= maxManagedNotificationRetries
        ) return;
      }
      const stillCurrent = async () => {
        const latest = await get(channel.id);
        return latest?.version === channel.version &&
          latest.enabled && !latest.retired;
      };
      if (!await stillCurrent()) return;
      const createdAt = new Date().toISOString();
      const attempt = retry
        ? { requestId: retry.requestId, createdAt, state: "in_flight" as const }
        : undefined;
      const previous = existing?.retries ?? [];
      const claim: ManagedNotificationDelivery = existing && attempt
        ? { ...existing, state: "in_flight", retries: [...previous, attempt] }
        : {
          id,
          channelId: channel.id,
          channelVersion: channel.version,
          createdAt,
          ...(options?.source && { source: options.source }),
          state: "in_flight",
        };
      const claimed = JSON.stringify(claim);
      if (!await compareAndSet(key, raw, claimed)) {
        const completed = await load<ManagedNotificationDelivery>(key);
        return completed?.channelVersion === channel.version &&
            (!retry ||
              completed.retries?.some(({ requestId }) =>
                requestId === retry.requestId
              ))
          ? completed
          : undefined;
      }
      let state: Exclude<DeliveryState, "in_flight"> = "uncertain";
      try {
        state = await stillCurrent()
          ? await transport(stillCurrent)
          : "blocked";
      } catch {
        // Once a transport starts, an exception cannot prove it did not send.
      }
      const result: ManagedNotificationDelivery = {
        ...claim,
        state,
        ...(attempt && { retries: [...previous, { ...attempt, state }] }),
      };
      await compareAndSet(key, claimed, JSON.stringify(result));
      return result;
    },
  };
}

export type ManagedNotificationChannels = ReturnType<
  typeof createManagedNotificationChannels
>;
