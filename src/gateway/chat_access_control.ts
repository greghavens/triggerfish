/**
 * Pairing verification and non-owner access control for chat sessions.
 *
 * Handles the gating logic that determines whether a non-owner message
 * should be processed: pairing code verification, paired user preloading,
 * and respondToUnclassified enforcement.
 *
 * @module
 */

import { createLogger } from "../core/logger/mod.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { ChannelMessage } from "../channels/types.ts";
import type { UserSessionManager } from "../channels/user_sessions.ts";
import type { ChatSessionConfig } from "./chat_types.ts";

const chatLog = createLogger("chat");

/** Internal per-channel state used by access control checks. */
export interface AccessControlChannelState {
  readonly userSessions: UserSessionManager;
  readonly adapter: { send(msg: { content: string; sessionId?: string }): Promise<void> };
  readonly pairingClassification: ClassificationLevel;
  readonly pairing: boolean;
  readonly respondToUnclassified: boolean;
}

/** Attempt pairing verification for a DM message containing a 6-digit code. */
async function attemptPairingVerification(
  msg: ChannelMessage,
  channelType: string,
  senderId: string,
  channelState: AccessControlChannelState,
  pairingService: ChatSessionConfig["pairingService"],
): Promise<void> {
  const isGroupMsg = msg.isGroup ??
    (msg.sessionId?.startsWith(`${channelType}-group-`) ?? false);
  if (isGroupMsg) return;

  const codeMatch = (msg.content ?? "").trim().match(/^\d{6}$/);
  if (!codeMatch || !pairingService) return;

  const result = await pairingService.verifyCode(
    codeMatch[0],
    channelType,
    senderId,
  );
  if (result.ok) {
    channelState.userSessions.addClassification(
      senderId,
      channelState.pairingClassification,
    );
    await channelState.adapter.send({
      content: "Paired successfully. You can now chat with me.",
      sessionId: msg.sessionId,
    }).catch((err: unknown) => {
      chatLog.warn("Pairing confirmation delivery failed", {
        operation: "attemptPairingVerification",
        channel: channelType,
        err,
      });
    });
  }
}

/**
 * Check non-owner access control. Returns true if the message should be
 * processed, false if it should be dropped.
 */
export async function checkNonOwnerAccess(
  msg: ChannelMessage,
  channelType: string,
  senderId: string,
  channelState: AccessControlChannelState,
  pairingService: ChatSessionConfig["pairingService"],
): Promise<boolean> {
  const hasClassification = channelState.userSessions.hasExplicitClassification(
    senderId || "unknown",
  );
  if (hasClassification) return true;

  if (channelState.pairing && senderId) {
    await attemptPairingVerification(
      msg,
      channelType,
      senderId,
      channelState,
      pairingService,
    );
    return false;
  }

  if (!channelState.respondToUnclassified) {
    chatLog.warn("Dropping message from unclassified sender", {
      operation: "checkNonOwnerAccess",
      channelType,
      senderId,
      respondToUnclassified: false,
    });
    return false;
  }

  return true;
}

/** Pre-load paired users into the user session manager. */
export async function preloadPairedUsers(
  pairingService: ChatSessionConfig["pairingService"],
  channelType: string,
  mgr: UserSessionManager,
  pairingCls: ClassificationLevel,
): Promise<void> {
  if (!pairingService) return;
  try {
    const linkedUsers = await pairingService.getLinkedUsers(channelType);
    for (const userId of linkedUsers) mgr.addClassification(userId, pairingCls);
  } catch (err) {
    chatLog.warn("Paired user preload failed", {
      operation: "preloadPairedUsers",
      channelType,
      err,
    });
  }
}
