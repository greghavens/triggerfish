import type { StorageProvider } from "./storage/provider.ts";
import type { ClassificationLevel } from "./types/classification.ts";

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
}

export interface ManagedNotificationDelivery {
  readonly id: string;
  readonly channelId: string;
  readonly channelVersion: number;
  readonly createdAt: string;
  readonly state: "in_flight" | "delivered" | "blocked" | "uncertain";
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
    ): Promise<ManagedNotificationDelivery | undefined> {
      const key = deliveryPrefix + channel.id + ":" + id;
      const existing = await load<ManagedNotificationDelivery>(key);
      if (existing) {
        return existing.channelVersion === channel.version
          ? existing
          : undefined;
      }
      const stillCurrent = async () => {
        const latest = await get(channel.id);
        return latest?.version === channel.version &&
          latest.enabled && !latest.retired;
      };
      if (!await stillCurrent()) return;
      const claim: ManagedNotificationDelivery = {
        id,
        channelId: channel.id,
        channelVersion: channel.version,
        createdAt: new Date().toISOString(),
        state: "in_flight",
      };
      const claimed = JSON.stringify(claim);
      if (!await compareAndSet(key, null, claimed)) {
        const completed = await load<ManagedNotificationDelivery>(key);
        return completed?.channelVersion === channel.version
          ? completed
          : undefined;
      }
      let state: "delivered" | "blocked" | "uncertain" = "uncertain";
      try {
        state = await stillCurrent()
          ? await transport(stillCurrent)
          : "blocked";
      } finally {
        await compareAndSet(key, claimed, JSON.stringify({ ...claim, state }));
      }
      return { ...claim, state };
    },
  };
}

export type ManagedNotificationChannels = ReturnType<
  typeof createManagedNotificationChannels
>;
