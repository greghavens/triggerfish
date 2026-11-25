/** Derive recovery identities from trusted delegated dispatch anchors. */
import { computeContentHash } from "../../../core/session/lineage_serde.ts";
import type { SessionId } from "../../../core/types/session.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { AgentRecoveryExecutor } from "../../../core/agent_recovery.ts";

export interface DelegatedSubagentRecovery {
  readonly parentSessionId: SessionId;
  readonly executionId: string;
  readonly run: AgentRecoveryExecutor;
  readonly targetClassification?: ClassificationLevel;
}

export interface TeamDeliveryRecovery {
  readonly deliveryId: string;
  readonly run: AgentRecoveryExecutor;
  readonly senderTaint?: ClassificationLevel;
  readonly targetClassification?: ClassificationLevel;
  readonly signal?: AbortSignal;
}

export async function delegatedSubagentIdentity(
  parentSessionId: SessionId,
  executionId: string,
): Promise<{ channelId: string; sessionId: SessionId; executionId: string }> {
  const digest = await delegatedIdentityDigest(
    "subagent",
    parentSessionId,
    executionId,
  );
  return {
    channelId: `subagent-recovery-${digest}`,
    sessionId: delegatedSubagentSessionId(digest),
    executionId: digest,
  };
}

/** Read the deterministic child session embedded in a trusted execution digest. */
export function delegatedSubagentSessionId(digest: string): SessionId {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Invalid delegated execution digest");
  }
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-") as SessionId;
}

export function teamDeliveryExecutionId(
  sender: SessionId,
  recipient: SessionId,
  deliveryId: string,
): Promise<string> {
  return delegatedIdentityDigest("team", sender, recipient, deliveryId);
}

function delegatedIdentityDigest(kind: "subagent" | "team", ...ids: string[]) {
  if (
    ids.some((id) =>
      typeof id !== "string" || !id.trim() || id.length > 256 ||
      id.includes("\x00")
    )
  ) throw new Error("Invalid trusted delegated recovery identity");
  return computeContentHash(JSON.stringify([kind, ...ids]));
}
