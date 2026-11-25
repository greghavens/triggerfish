/** Reauthorize an approved local checklist read as its original machine role. */
import { createSavedSourceAuthorization } from "../../../agent/dispatch/saved_source_authorization.ts";
import type { OrchestratorConfig } from "../../../agent/orchestrator/orchestrator_config.ts";
import type { ConversationRecord } from "../../../core/conversation/mod.ts";
import { isManagedChecklistProof } from "../../../core/conversation/managed_evidence.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../../../core/types/classification.ts";
import type {
  ChannelId,
  SessionId,
  SessionState,
  UserId,
} from "../../../core/types/session.ts";
import { resolveToolsForProfile } from "../../tools/agent_tools.ts";
import { TOOL_PROFILES } from "../../tools/defs/tool_profiles.ts";

export async function authorizeManagedTranscript(
  config: OrchestratorConfig,
  current: () => boolean,
  taint: ClassificationLevel,
  source: string,
  row: ConversationRecord,
): Promise<boolean> {
  const identity = row.managedTranscriptIdentity;
  if (
    !current() || !identity || !isManagedChecklistProof(source, row) ||
    !/^[a-f0-9-]{36}$/i.test(row.session_id) ||
    !canFlowTo(row.classification, taint) ||
    (identity.ceiling !== null &&
      !canFlowTo(row.classification, identity.ceiling))
  ) return false;
  const profile = source.startsWith("delegated:")
    ? TOOL_PROFILES.subagent
    : source.startsWith("scheduler:trigger:")
    ? TOOL_PROFILES.triggerSession
    : TOOL_PROFILES.cronJob;
  const tools = resolveToolsForProfile(profile).filter(({ name }) =>
    name === "todo_read"
  );
  const session: SessionState = {
    id: row.session_id as SessionId,
    userId: "owner" as UserId,
    channelId: identity.channelId as ChannelId,
    taint: row.classification,
    createdAt: new Date(identity.createdAt),
    history: [],
    bumpersEnabled: true,
  };
  const authorization = createSavedSourceAuthorization({
    hookRunner: config.hookRunner,
    providerRegistry: config.providerRegistry,
    tools,
    toolClassifications: config.toolClassifications,
    toolFloorRegistry: config.toolFloorRegistry,
    isOwnerSession: () => false,
    isTriggerSession: () => identity.isTrigger,
    getNonOwnerCeiling: () => identity.ceiling,
    getSessionTaint: () => row.classification,
  }, session);
  return await authorization.authorizeSavedCall(
    { name: "todo_read", args: {} },
    row.classification,
  ) && current() && await authorization.authorizeSavedResponse(
    "todo_read",
    row.content,
    row.classification,
  ) && current();
}
