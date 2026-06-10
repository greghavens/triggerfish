/**
 * Google Chat channel adapter types.
 *
 * Defines configuration, API shapes, and injectable abstractions
 * for Google Chat integration via PubSub pull delivery.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { GroupMode } from "../groups.ts";

/** Async token provider that returns a fresh or cached access token. */
export type AccessTokenProvider = () => Promise<string>;

/** Configuration for the Google Chat channel adapter. */
export interface GoogleChatConfig {
  /** Async provider for OAuth2 access tokens (supports refresh/caching). */
  readonly getAccessToken: AccessTokenProvider;
  /** Full PubSub subscription path (projects/PROJECT/subscriptions/SUB). */
  readonly pubsubSubscription: string;
  /** Owner's email address for isOwner checks. */
  readonly ownerEmail?: string;
  /** Classification level for this channel. Default: INTERNAL */
  readonly classification?: ClassificationLevel;
  /** Whether pairing mode is enabled. Default: false */
  readonly pairing?: boolean;
  /** Default group mode for spaces. Default: "mentioned-only" */
  readonly defaultGroupMode?: GroupMode;
  /** Per-space group mode overrides keyed by space name. */
  readonly groups?: Readonly<Record<string, { readonly mode: GroupMode }>>;
  /** Injectable fetch function for testing. */
  readonly _fetchFn?: typeof fetch;
  /** Injectable PubSub pull function for testing. */
  readonly _pullFn?: PubSubPullFn;
  /** Injectable PubSub ack function for testing. */
  readonly _ackFn?: PubSubAckFn;
}

/** A single message from a PubSub pull response. */
export interface PubSubReceivedMessage {
  /** Server-assigned acknowledgement ID. */
  readonly ackId: string;
  /** The actual PubSub message data. */
  readonly message: {
    /** Base64-encoded message data. */
    readonly data: string;
    /** Message attributes (metadata). */
    readonly attributes?: Readonly<Record<string, string>>;
    /** Server-assigned message ID. */
    readonly messageId: string;
    /** Publish timestamp. */
    readonly publishTime: string;
  };
}

/** Response from a PubSub pull request. */
export interface PubSubPullResponse {
  /** Received messages, if any. */
  readonly receivedMessages?: readonly PubSubReceivedMessage[];
}

/** Injectable PubSub pull function signature for dependency injection. */
export type PubSubPullFn = (
  subscription: string,
  maxMessages: number,
) => Promise<PubSubPullResponse>;

/** Injectable PubSub acknowledge function signature. */
export type PubSubAckFn = (
  subscription: string,
  ackIds: readonly string[],
) => Promise<void>;

/** User mention annotation in a Google Chat message. */
export interface GoogleChatAnnotation {
  /** Annotation type (e.g. "USER_MENTION"). */
  readonly type: string;
  /** User mention details, present when type is USER_MENTION. */
  readonly userMention?: {
    /** The mentioned user resource. */
    readonly user: {
      /** User resource name (e.g. "users/12345"). */
      readonly name: string;
      /** User display name. */
      readonly displayName?: string;
      /** User type (e.g. "BOT", "HUMAN"). */
      readonly type?: string;
    };
    /** Mention type (e.g. "MENTION", "ALL"). */
    readonly type?: string;
  };
}

/** Sender information from a Google Chat event. */
export interface GoogleChatSender {
  /** User resource name (e.g. "users/12345"). */
  readonly name: string;
  /** User display name. */
  readonly displayName?: string;
  /** User email address. */
  readonly email?: string;
  /** User type (e.g. "BOT", "HUMAN"). */
  readonly type?: string;
}

/** Space (room/DM) information from a Google Chat event. */
export interface GoogleChatSpace {
  /** Space resource name (e.g. "spaces/AAAA"). */
  readonly name: string;
  /** Space type: "DM" for direct messages, "ROOM" or "SPACE" for group spaces. */
  readonly type?: string;
  /** Space display name (for rooms/spaces). */
  readonly displayName?: string;
  /** Whether this is a single-user DM. */
  readonly singleUserBotDm?: boolean;
}

/** Message resource returned by the Chat API messages.get endpoint. */
export interface GoogleChatApiMessage {
  /** Message resource name. */
  readonly name?: string;
  /** Authoritative message sender. */
  readonly sender?: GoogleChatSender;
  /** Plain-text body. */
  readonly text?: string;
  /** Message text without @mentions. */
  readonly argumentText?: string;
  /** The space the message belongs to. */
  readonly space?: GoogleChatSpace;
  /** Message creation timestamp. */
  readonly createTime?: string;
}

/** Membership entry returned by the Chat API spaces.members.list endpoint. */
export interface GoogleChatMembership {
  /** The member user. */
  readonly member?: {
    /** User resource name (e.g. "users/12345"). */
    readonly name?: string;
    /** User type (e.g. "BOT", "HUMAN"). */
    readonly type?: string;
  };
}

/** Google Chat event received via PubSub. */
export interface GoogleChatEvent {
  /** Event type (e.g. "MESSAGE", "ADDED_TO_SPACE", "REMOVED_FROM_SPACE"). */
  readonly type?: string;
  /** Timestamp of the event. */
  readonly eventTime?: string;
  /** The message payload (present for MESSAGE events). */
  readonly message?: {
    /** Message resource name. */
    readonly name?: string;
    /** The plain-text body of the message. */
    readonly text?: string;
    /** Message sender. */
    readonly sender?: GoogleChatSender;
    /** Annotations (mentions, links, etc.). */
    readonly annotations?: readonly GoogleChatAnnotation[];
    /** The space the message was sent in. */
    readonly space?: GoogleChatSpace;
    /** The thread the message belongs to. */
    readonly thread?: {
      /** Thread resource name. */
      readonly name?: string;
    };
    /** Argument text (message text without @mentions). */
    readonly argumentText?: string;
  };
  /** The space associated with the event. */
  readonly space?: GoogleChatSpace;
  /** The user who triggered the event. */
  readonly user?: GoogleChatSender;
}
