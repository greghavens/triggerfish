import { computeContentHash } from "../../../core/session/lineage_serde.ts";
/** Reauthorize an approved local checklist read as its original machine role. */
import { createSavedSourceAuthorization } from "../../../agent/dispatch/saved_source_authorization.ts";
import type { OrchestratorConfig } from "../../../agent/orchestrator/orchestrator_config.ts";
import type { ConversationRecord } from "../../../core/conversation/mod.ts";
import {
  isManagedChecklistProof,
  isManagedObservationProof,
  type ManagedTranscriptGrantReader,
} from "../../../core/conversation/managed_evidence.ts";
import { scheduledObservationTool } from "../../scheduled_observation_tool.ts";
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
  resolveGrant?: ManagedTranscriptGrantReader,
  expectedProjectionSha256?: string,
): Promise<boolean> {
  const identity = row.managedTranscriptIdentity;
  const grantedObservation = resolveGrant &&
    isManagedObservationProof(source, row);
  if (
    !current() || !identity ||
    (!grantedObservation && !isManagedChecklistProof(source, row)) ||
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
  const tools = grantedObservation
    ? [scheduledObservationTool]
    : resolveToolsForProfile(profile).filter(({ name }) =>
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
    toolClassifications: grantedObservation
      ? new Map([...config.toolClassifications ?? [], [
        scheduledObservationTool.name,
        "INTERNAL",
      ]])
      : config.toolClassifications,
    toolFloorRegistry: config.toolFloorRegistry,
    isOwnerSession: () => false,
    isTriggerSession: () => identity.isTrigger,
    getNonOwnerCeiling: () => identity.ceiling,
    getSessionTaint: () => row.classification,
  }, session);
  const name = grantedObservation ? scheduledObservationTool.name : "todo_read";
  if (
    !await authorization.authorizeSavedCall(
      { name, args: {} },
      row.classification,
    ) || !current()
  ) return false;
  const grant = grantedObservation && identity.observationGrantDigest
    ? await resolveGrant(source, identity.observationGrantDigest, authorization)
    : undefined;
  if (grantedObservation) {
    if (!grant || !current()) return false;
    if (
      expectedProjectionSha256 === undefined
        ? grant.result !== row.content
        : await computeContentHash(grant.result) !== expectedProjectionSha256
    ) return false;
  }
  return await authorization.authorizeSavedResponse(
    name,
    grant?.result ?? row.content,
    row.classification,
  ) &&
    current() && (!grant || grant.current());
}
