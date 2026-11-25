/** Reauthorize an exact owner-bound subagent or team observation grant. */
import { join } from "@std/path";
import { createHash } from "node:crypto";
import { buildTeamRosterPrompt } from "../../../agent/team/roster.ts";
import { deserializeTeamInstance } from "../../../agent/team/serialization.ts";
import { TEAM_STORAGE_PREFIX } from "../../../agent/team/types.ts";
import {
  selectSentinelDelegatedObservationRead,
  selectSentinelTeamObservationRead,
  sentinelLocalObservationKind,
  type SentinelObservationReference,
  type TriggerFishConfig,
} from "../../../core/config_types.ts";
import type { ManagedTranscriptGrantReader } from "../../../core/conversation/managed_evidence.ts";
import type { DelegatedAgentKind } from "../../../core/delegated_goal_config.ts";
import type { ExecutionTraceScope } from "../../../core/execution_traces.ts";
import { computeContentHash } from "../../../core/session/lineage_serde.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import {
  canFlowTo,
  parseClassification,
} from "../../../core/types/classification.ts";
import type { SessionId } from "../../../core/types/session.ts";
import { readSentinelAssessment } from "../../../sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../../sentinel/cases.ts";
import {
  createScheduledObservationRead,
  matchesScheduledObservationProjection,
} from "../../scheduled_observation_tool.ts";
import {
  delegatedSubagentIdentity,
  parseTeamDeliveryTraceSource,
  teamDeliveryExecutionId,
} from "./delegated_agent_recovery.ts";
import { managedObservationGrantDigest } from "./managed_scheduled_observation_grant.ts";
import { withTeamRecoveryStore } from "./team_recovery_store.ts";

export type ResolveManagedDelegatedObservationGrant = (
  kind: DelegatedAgentKind,
  scope: ExecutionTraceScope,
  ownerSessionId: string,
) => Promise<
  { channelId: string; reader: ManagedTranscriptGrantReader } | undefined
>;

export function buildManagedDelegatedObservationGrant(
  config: Pick<TriggerFishConfig, "sentinel" | "models" | "agent_recovery">,
  baseDir: string,
  storage: StorageProvider | undefined,
  authorize: Parameters<typeof createScheduledObservationRead>[2],
  readNativeWorkflow?: Parameters<typeof createScheduledObservationRead>[4],
): ResolveManagedDelegatedObservationGrant | undefined {
  if (
    !(config.sentinel?.delegated_observation_reads?.length ||
      config.sentinel?.team_observation_reads?.length)
  ) return;
  return async (kind, scope, ownerSessionId) => {
    if (scope.role !== "delegated") return;
    const parsed = parseTeamDeliveryTraceSource(scope.sourceId);
    const memberId = scope.sessionId as SessionId;
    const owner = ownerSessionId as SessionId;
    const source = `delegated:${kind}`;
    let selected: SentinelObservationReference | undefined;
    let channelId: string;
    let currentBinding: () => Promise<boolean>;
    if (kind === "subagent") {
      if (scope.sourceId !== owner) return;
      const matches = [];
      for (const entry of config.sentinel?.delegated_observation_reads ?? []) {
        if (entry.parent_session_id !== owner) continue;
        const identity = await delegatedSubagentIdentity(
          owner,
          entry.execution_id,
        );
        if (
          identity.executionId === scope.runId &&
          identity.sessionId === memberId
        ) {
          matches.push({ entry, identity });
        }
      }
      if (matches.length !== 1) return;
      const [{ entry, identity }] = matches;
      const binding = {
        parentSessionId: owner,
        executionId: entry.execution_id,
      };
      const currentGrant = () =>
        selectSentinelDelegatedObservationRead(
          config.sentinel?.delegated_observation_reads,
          binding,
        );
      selected = currentGrant();
      channelId = identity.channelId;
      currentBinding = () => Promise.resolve(currentGrant() === selected);
    } else {
      if (
        !storage || config.agent_recovery?.team !== true ||
        !parsed || parsed.sender !== owner ||
        await teamDeliveryExecutionId(owner, memberId, parsed.delivery) !==
          scope.runId
      ) return;
      const binding = {
        ownerSessionId: owner,
        teamId: parsed.teamId,
        memberSessionId: memberId,
        deliveryId: parsed.delivery,
      };
      const currentGrant = () =>
        selectSentinelTeamObservationRead(
          config.sentinel?.team_observation_reads,
          binding,
        );
      selected = currentGrant();
      if (!selected) return;
      const admissionGrantDigest = await computeContentHash(
        JSON.stringify(selected),
      );
      channelId = `team-recovery-${memberId}`;
      currentBinding = async () => {
        if (currentGrant() !== selected) return false;
        const raw = await storage.get(`${TEAM_STORAGE_PREFIX}${parsed.teamId}`);
        if (!raw) return false;
        const team = deserializeTeamInstance(raw);
        const member = team.members.find(({ sessionId }) =>
          sessionId === memberId
        );
        if (
          team.id !== parsed.teamId || team.createdBy !== owner ||
          team.status !== "running" ||
          Date.now() >=
            team.createdAt.getTime() + team.maxLifetimeSeconds * 1000 ||
          !member || (member.status !== "active" && member.status !== "idle") ||
          !member.classificationCeiling ||
          !parseClassification(member.currentTaint).ok ||
          !canFlowTo(member.currentTaint, "INTERNAL") ||
          !canFlowTo("INTERNAL", member.classificationCeiling)
        ) return false;
        const { context, admission } = withTeamRecoveryStore(
          join(baseDir, "team-recovery.db"),
          (store) => ({
            context: store.member(memberId),
            admission: store.delivery(parsed.delivery),
          }),
        );
        const profile = createHash("sha256")
          .update(
            JSON.stringify([
              config.models.primary.provider,
              config.models.primary.model,
            ]),
          ).digest("hex");
        if (
          !context || !admission ||
          context.teamId !== parsed.teamId ||
          context.creatorSessionId !== owner ||
          context.sessionId !== memberId || context.channelId !== channelId ||
          context.workspaceId !== `recovery-${memberId}` ||
          context.role !== member.role ||
          context.model !== member.model ||
          context.ceiling !== member.classificationCeiling ||
          context.profileBinding !== profile ||
          admission.id !== parsed.delivery ||
          admission.teamId !== parsed.teamId ||
          admission.senderSessionId !== owner ||
          admission.recipientSessionId !== memberId ||
          admission.observationGrantDigest !== admissionGrantDigest ||
          !parseClassification(admission.targetClassification).ok ||
          !canFlowTo("INTERNAL", admission.targetClassification) ||
          await computeContentHash(JSON.stringify(context)) !==
            admission.memberContextDigest
        ) return false;
        const roster = buildTeamRosterPrompt({
          teamName: team.name,
          task: team.task,
          member,
          allMembers: team.members.map((entry) => ({
            ...entry,
            sessionId: `pending-${entry.role}` as SessionId,
          })),
        });
        return await computeContentHash(roster) === context.rosterDigest;
      };
    }
    if (
      !selected ||
      (!authorize && !sentinelLocalObservationKind(selected.observation_id))
    ) {
      return;
    }
    const grant = selected;
    const reader: ManagedTranscriptGrantReader = async (
      selectedSource,
      digest,
      policy,
    ) => {
      if (
        selectedSource !== source ||
        managedObservationGrantDigest(grant) !== digest
      ) return;
      const current = async () => {
        try {
          if (policy.signal?.aborted || !await currentBinding()) return false;
          const state = readSentinelAssessment(
            resolveSentinelCasePath(baseDir, grant.case),
          );
          return !policy.signal?.aborted &&
            state?.plan.runId === grant.run_id &&
            state.revision === grant.revision;
        } catch {
          return false;
        }
      };
      if (!await current()) return;
      const text = await createScheduledObservationRead(
        baseDir,
        grant,
        authorize,
        current,
        readNativeWorkflow,
      )({}, policy);
      return text.startsWith("{") && await current()
        ? {
          result: text,
          current: async () =>
            await current() &&
            matchesScheduledObservationProjection(baseDir, grant, text),
        }
        : undefined;
    };
    return { channelId, reader };
  };
}
