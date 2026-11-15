/**
 * Notification service types and interfaces.
 *
 * Extracted into core so that scheduler/ and other modules can depend
 * on the NotificationService contract without importing from gateway/.
 *
 * @module
 */

import type { UserId } from "./session.ts";
import type { ClassificationLevel } from "./classification.ts";

/** Notification priority levels. */
export type NotificationPriority = "critical" | "normal" | "low";

/** A notification to be delivered. */
export interface Notification {
  readonly id: string;
  readonly userId: UserId;
  readonly message: string;
  readonly priority: NotificationPriority;
  readonly classification?: ClassificationLevel;
  readonly createdAt: Date;
}

/** Options for delivering a notification. */
export interface DeliverOptions {
  readonly userId: UserId;
  readonly message: string;
  readonly priority: NotificationPriority;
  readonly classification?: ClassificationLevel;
}

/** A channel that can receive notification delivery. */
export interface DeliveryChannel {
  readonly name: string;
  /**
   * Highest classification this channel may receive. Fan-out suppresses
   * any notification whose classification cannot flow to this level
   * (no write-down). Owner-equivalent local channels (CLI, Tidepool)
   * register as RESTRICTED so they always deliver.
   */
  readonly classification: ClassificationLevel;
  readonly send: (message: string) => Promise<void>;
}

/** Notification service interface. */
export interface NotificationService {
  /** Deliver or queue a notification for a user. */
  deliver(options: DeliverOptions): Promise<void>;

  /** Get pending (undelivered) notifications for a user. */
  getPending(userId: UserId): Promise<Notification[]>;

  /** Acknowledge a notification as delivered. */
  acknowledge(notificationId: string): Promise<void>;

  /** Register a channel for notification delivery. */
  registerChannel(channel: DeliveryChannel): void;

  /**
   * Flush pending notifications — re-attempt delivery of queued notifications.
   * Acknowledges successfully delivered ones. Returns the count still blocked.
   */
  flushPending(userId: UserId): Promise<number>;
}
