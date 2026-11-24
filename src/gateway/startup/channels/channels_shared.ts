/**
 * Shared types and config validation for channel adapter wiring during
 * gateway startup.
 *
 * @module
 */

import type { ChatSession } from "../../chat.ts";
import type { RegisteredChannel } from "../../tools/session/session_tools.ts";
import type { NotificationService } from "../../notifications/notifications.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import { parseClassification } from "../../../core/types/classification.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("startup-channels");

/** Shared dependencies for channel wiring. */
export interface ChannelWiringDeps {
  readonly chatSession: ChatSession;
  readonly notificationService: NotificationService;
  readonly channelAdapters: Map<string, RegisteredChannel>;
}

/**
 * Resolve a channel classification level from raw config at the trust
 * boundary.
 *
 * An absent value uses the channel's documented fallback. A present value
 * is validated via `parseClassification`; an unparseable level (e.g. a typo
 * like "CONFIDENTAL") fails closed to PUBLIC — the most restrictive flow
 * target and non-owner ceiling — and is logged at WARN so the operator can
 * fix the config. Never trusts an unchecked cast.
 */
export function resolveChannelClassification(opts: {
  readonly channel: string;
  readonly field: string;
  readonly raw: string | undefined;
  readonly fallback: ClassificationLevel;
}): ClassificationLevel {
  if (opts.raw === undefined) return opts.fallback;
  const parsed = parseClassification(opts.raw);
  if (parsed.ok) return parsed.value;
  log.warn(
    "Channel classification unparseable — failing closed to PUBLIC",
    {
      operation: "resolveChannelClassification",
      channel: opts.channel,
      field: opts.field,
      value: opts.raw,
    },
  );
  return "PUBLIC";
}
