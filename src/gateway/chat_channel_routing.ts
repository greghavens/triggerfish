/**
 * Channel message routing and registration for chat sessions.
 *
 * Manages per-channel state (user sessions, adapters, rate limiters)
 * and routes incoming messages to owner or non-owner turn handlers.
 *
 * @module
 */

import { createLogger } from "../core/logger/mod.ts";
import type { Orchestrator } from "../agent/orchestrator/orchestrator.ts";
import type { SessionState } from "../core/types/session.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { ChannelAdapter, ChannelMessage } from "../channels/types.ts";
import {
  createUserSessionManager,
  parseUserOverrides,
} from "../channels/user_sessions.ts";
import type { UserSessionManager } from "../channels/user_sessions.ts";
import { createUserRateLimiter } from "../channels/rate_limiter.ts";
import type { UserRateLimiter } from "../channels/rate_limiter.ts";
import type {
  ChannelRegistrationConfig,
  ChatSessionConfig,
} from "./chat_types.ts";
import { buildSendEvent } from "./chat_event_sender.ts";
import {
  enforceNonOwnerAccessControl,
  preloadPairedUsers,
} from "./chat_access_control.ts";
import {
  orchestrateNonOwnerAgentTurn,
  orchestrateOwnerAgentTurn,
} from "./chat_turn_execution.ts";
import type { ChatSessionMutableState } from "./chat_turn_execution.ts";

const chatLog = createLogger("chat");

/** Internal per-channel state tracked by ChatSession. */
export interface ChannelState {
  readonly userSessions: UserSessionManager;
  readonly adapter: ChannelAdapter;
  readonly channelName: string;
  readonly respondToUnclassified: boolean;
  readonly pairing: boolean;
  readonly pairingClassification: ClassificationLevel;
  readonly rateLimiter?: UserRateLimiter;
}

/** Build a ChannelState from registration config and persist it. */
export async function registerChannelState(
  channelStates: Map<string, ChannelState>,
  pairingService: ChatSessionConfig["pairingService"],
  channelType: string,
  channelConfig: ChannelRegistrationConfig,
): Promise<void> {
  const mgr = createUserSessionManager({
    channelDefault: channelConfig.classification,
    userOverrides: parseUserOverrides(channelConfig.userClassifications),
  });
  const pairingCls = channelConfig.pairingClassification ??
    "INTERNAL" as ClassificationLevel;
  if (channelConfig.pairing) {
    await preloadPairedUsers(pairingService, channelType, mgr, pairingCls);
  }
  const rateLimiter = channelConfig.nonOwnerRateLimit
    ? createUserRateLimiter(channelConfig.nonOwnerRateLimit)
    : undefined;
  channelStates.set(channelType, {
    userSessions: mgr,
    adapter: channelConfig.adapter,
    channelName: channelConfig.channelName,
    respondToUnclassified: channelConfig.respondToUnclassified ?? true,
    pairing: channelConfig.pairing ?? false,
    pairingClassification: pairingCls,
    rateLimiter,
  });
}

/** Route a channel message to the owner or non-owner turn handler. */
export async function routeChannelMessage(
  state: ChatSessionMutableState,
  orchestrator: Orchestrator,
  getSession: () => SessionState,
  ownerTargetClassification: ClassificationLevel,
  channelStates: Map<string, ChannelState>,
  pairingService: ChatSessionConfig["pairingService"],
  msg: ChannelMessage,
  channelType: string,
  signal?: AbortSignal,
  isOwnerTurnRef?: { value: boolean },
): Promise<void> {
  const channelState = channelStates.get(channelType);
  if (!channelState) {
    chatLog.error("Channel config not registered for routing", {
      operation: "routeChannelMessage",
      channelType,
    });
    return;
  }

  if (msg.isOwner !== false) {
    return orchestrateOwnerAgentTurn(
      state,
      orchestrator,
      getSession,
      msg.content,
      ownerTargetClassification,
      buildSendEvent(channelState.adapter, channelState.channelName, msg),
      signal,
    );
  }

  const senderId = msg.senderId ?? "";
  const effectiveSenderId = senderId || "unknown";
  if (
    channelState.rateLimiter &&
    !channelState.rateLimiter.isAllowed(effectiveSenderId)
  ) {
    chatLog.warn("Rate limit exceeded for non-owner sender", {
      operation: "routeChannelMessage",
      channelType,
      senderId: effectiveSenderId,
    });
    return;
  }

  const allowed = await enforceNonOwnerAccessControl(
    msg,
    channelType,
    senderId,
    channelState,
    pairingService,
  );
  if (!allowed) return;

  if (isOwnerTurnRef) isOwnerTurnRef.value = false;
  try {
    await orchestrateNonOwnerAgentTurn(
      state,
      orchestrator,
      msg,
      channelType,
      channelState,
      signal,
    );
  } finally {
    if (isOwnerTurnRef) isOwnerTurnRef.value = true;
  }
}
