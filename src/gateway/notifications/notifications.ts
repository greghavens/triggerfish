/**
 * Notification Service — queues and delivers notifications across channels.
 *
 * Provides first-class notification delivery with priority levels,
 * queuing for offline users, and quiet hours support.
 * Notifications are persisted via StorageProvider (namespace: `notifications:`).
 *
 * @module
 */

import type { UserId } from "../../core/types/session.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import { canFlowTo } from "../../core/types/classification.ts";
import type { StorageProvider } from "../../core/storage/provider.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("notifications");

export type {
  DeliverOptions,
  DeliveryChannel,
  Notification,
  NotificationPriority,
  NotificationService,
} from "../../core/types/notification.ts";

import type {
  DeliverOptions,
  DeliveryChannel,
  Notification,
  NotificationPriority,
  NotificationService,
  SentinelNotificationReceipt,
} from "../../core/types/notification.ts";

/** Serialized notification shape for storage. */
interface StoredNotification {
  readonly id: string;
  readonly userId: string;
  readonly message: string;
  readonly priority: NotificationPriority;
  readonly classification?: ClassificationLevel;
  readonly createdAt: string;
  readonly sentinelReceipt?: SentinelNotificationReceipt;
}

/**
 * Create a notification service backed by a StorageProvider.
 *
 * Each notification is stored as a separate key:
 *   `notifications:<userId>:<notificationId>`
 *
 * This ensures notifications survive restarts.
 */
export function createNotificationService(
  storage: StorageProvider,
  sentinel?: {
    readonly canRetry: (receipt: SentinelNotificationReceipt) => boolean;
    readonly onRetryDelivered: (receipt: SentinelNotificationReceipt) => void;
  },
): NotificationService {
  const keyPrefix = "notifications:";
  const channels: DeliveryChannel[] = [];
  const inFlight = new Set<string>();

  function notificationKey(userId: string, id: string): string {
    return `${keyPrefix}${userId}:${id}`;
  }

  function serialize(
    n: Notification,
    sentinelReceipt?: SentinelNotificationReceipt,
  ): string {
    const stored: StoredNotification = {
      id: n.id,
      userId: n.userId as string,
      message: n.message,
      priority: n.priority,
      classification: n.classification,
      createdAt: n.createdAt.toISOString(),
      ...(sentinelReceipt && { sentinelReceipt }),
    };
    return JSON.stringify(stored);
  }

  function deserialize(raw: string): Notification {
    const stored: StoredNotification = JSON.parse(raw);
    return {
      id: stored.id,
      userId: stored.userId as UserId,
      message: stored.message,
      priority: stored.priority,
      classification: stored.classification,
      createdAt: new Date(stored.createdAt),
    };
  }

  /**
   * Check the no-write-down gate for one channel, logging suppressions.
   *
   * A notification with no classification is treated as RESTRICTED (fail
   * closed — unknown sensitivity must not reach lower-classified channels).
   */
  function permitChannelDelivery(
    notification: Notification,
    channel: DeliveryChannel,
  ): boolean {
    const effective = notification.classification ?? "RESTRICTED";
    const allowed = canFlowTo(effective, channel.classification);
    if (!allowed) {
      log.warn("Notification suppressed for channel: write-down blocked", {
        operation: "fanOut",
        channel: channel.name,
        notificationClassification: notification.classification ??
          "(unset → RESTRICTED)",
        channelClassification: channel.classification,
        notificationId: notification.id,
      });
    }
    return allowed;
  }

  /**
   * Attempt delivery to all registered channels the notification may flow
   * to. Returns true if at least one delivery succeeded. Channels below
   * the notification's classification are skipped (no write-down); a
   * suppressed-everywhere notification stays queued.
   */
  async function fanOut(
    notification: Notification,
    channelName?: string,
  ): Promise<boolean> {
    const eligible = channels.filter((ch) =>
      (channelName === undefined || ch.name === channelName) &&
      permitChannelDelivery(notification, ch)
    );
    if (eligible.length === 0) return false;
    const results = await Promise.allSettled(
      eligible.map((ch) => ch.send(notification.message)),
    );
    return results.some((r) => r.status === "fulfilled");
  }

  return {
    async deliver(options: DeliverOptions): Promise<void> {
      const notification: Notification = {
        id: crypto.randomUUID(),
        userId: options.userId,
        message: options.message,
        priority: options.priority,
        classification: options.classification,
        createdAt: new Date(),
      };

      const key = notificationKey(
        options.userId as string,
        notification.id,
      );
      inFlight.add(key);
      try {
        await storage.set(
          key,
          serialize(notification, options.sentinelReceipt),
        );

        // Attempt immediate delivery to all permitted channels
        let delivered = false;
        try {
          delivered = await fanOut(notification);
          if (delivered) {
            await storage.delete(key);
          }
        } catch (err) {
          // Delivery failure must not prevent storage — notification stays queued
          log.warn("Notification immediate delivery failed — kept pending", {
            operation: "deliver",
            notificationId: notification.id,
            err,
          });
        }
        options.onImmediateOutcome?.(delivered ? "delivered" : "queued");
      } finally {
        inFlight.delete(key);
      }
    },

    async getPending(userId: UserId): Promise<Notification[]> {
      const prefix = `${keyPrefix}${userId as string}:`;
      const keys = await storage.list(prefix);
      const results: Notification[] = [];

      for (const key of keys) {
        const raw = await storage.get(key);
        if (raw !== null) {
          results.push(deserialize(raw));
        }
      }

      // Sort by creation time, oldest first
      results.sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      return results;
    },

    async acknowledge(notificationId: string): Promise<void> {
      const keys = await storage.list(keyPrefix);
      for (const key of keys) {
        if (key.endsWith(`:${notificationId}`)) {
          await storage.delete(key);
          return;
        }
      }
    },

    registerChannel(channel: DeliveryChannel): void {
      channels.push(channel);
    },

    async flushPending(
      userId: UserId,
      options?: { sentinelTidepoolOnly: boolean },
    ): Promise<number> {
      try {
        const pending = await this.getPending(userId);
        let remaining = 0;
        for (const notification of pending) {
          const key = notificationKey(userId, notification.id);
          if (inFlight.has(key)) {
            remaining++;
            continue;
          }
          inFlight.add(key);
          try {
            const raw = await storage.get(key);
            if (raw === null) continue;
            const receipt =
              (JSON.parse(raw) as StoredNotification).sentinelReceipt;
            if (
              (options?.sentinelTidepoolOnly && !receipt) ||
              (receipt && sentinel && !sentinel.canRetry(receipt))
            ) {
              remaining++;
              continue;
            }
            const delivered = await fanOut(
              notification,
              options?.sentinelTidepoolOnly ? "tidepool" : undefined,
            );
            if (!delivered) {
              remaining++;
              continue;
            }
            if (receipt) sentinel?.onRetryDelivered(receipt);
            await storage.delete(key);
          } finally {
            inFlight.delete(key);
          }
        }
        return remaining;
      } catch (err) {
        log.warn("Notification flush failed — pending queue unchanged", {
          operation: "flushPending",
          userId,
          err,
        });
        return 0;
      }
    },
  };
}
