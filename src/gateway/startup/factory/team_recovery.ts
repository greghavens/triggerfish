/** Owner-authorized admission and reattachment for previously captured team scopes. */
import { dirname, join } from "@std/path";
import type {
  SentinelObservationReference,
  TeamObservationSource,
} from "../../../core/config_types.ts";
import { buildTeamRosterPrompt } from "../../../agent/team/roster.ts";
import { deserializeTeamInstance } from "../../../agent/team/serialization.ts";
import { TEAM_STORAGE_PREFIX, type TeamId } from "../../../agent/team/types.ts";
import { computeContentHash } from "../../../core/session/lineage_serde.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import {
  canFlowTo,
  CLASSIFICATION_ORDER,
  type ClassificationLevel,
  maxClassification,
} from "../../../core/types/classification.ts";
import type { SessionId, SessionState } from "../../../core/types/session.ts";
import type { OrchestratorFactory } from "../../../scheduler/service_types.ts";
import type { AgentRecoveryExecutor } from "../../../core/agent_recovery.ts";
import type {
  buildSendMessage,
  createSessionRegistry,
} from "./team_session_registry.ts";
import { withTeamRecoveryStore } from "./team_recovery_store.ts";

export interface TeamRecoveryOptions {
  readonly path: string;
  readonly profileBinding: string;
  readonly run: AgentRecoveryExecutor;
  readonly observationGrant?: (
    source: TeamObservationSource,
  ) => SentinelObservationReference | undefined;
  readonly bindObservationRun?: (
    source: TeamObservationSource,
    authorizeScope: () => Promise<boolean>,
  ) => AgentRecoveryExecutor | undefined;
}

const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const commandPattern = new RegExp(
  `^/recover-team (${uuid}) (${uuid}) (${uuid}) ([\\s\\S]+)$`,
  "i",
);
const unavailable =
  "The team member is not available in the trusted recovery scope.";

export function buildOwnerTeamRecoveryCommand(options: {
  readonly recovery: TeamRecoveryOptions;
  readonly factory: OrchestratorFactory;
  readonly storage: StorageProvider;
  readonly registry: ReturnType<typeof createSessionRegistry>;
  readonly send: ReturnType<typeof buildSendMessage>;
}) {
  const { recovery, factory, storage, registry, send } = options;
  if (!/^[a-f0-9]{64}$/.test(recovery.profileBinding)) {
    throw new Error("Invalid trusted team recovery profile digest");
  }
  type CurrentScope = {
    teamId: TeamId;
    memberId: SessionId;
    owner: SessionState;
    target: ClassificationLevel;
    minimumTaint?: ClassificationLevel;
  };

  async function readScope(
    { teamId, memberId, owner, target, minimumTaint }: CurrentScope,
  ) {
    const raw = await storage.get(`${TEAM_STORAGE_PREFIX}${teamId}`);
    if (!raw) return;
    const team = deserializeTeamInstance(raw);
    const member = team.members.find(({ sessionId }) => sessionId === memberId);
    if (
      team.id !== teamId || team.createdBy !== owner.id ||
      team.status !== "running" ||
      Date.now() >=
        team.createdAt.getTime() + team.maxLifetimeSeconds * 1_000 ||
      !member || (member.status !== "active" && member.status !== "idle")
    ) return;
    const context = withTeamRecoveryStore(
      recovery.path,
      (store) => store.member(memberId),
    );
    const memberTaint = registry.get(memberId)?.getTaint() ??
      member.currentTaint;
    if (!Object.hasOwn(CLASSIFICATION_ORDER, memberTaint)) return;
    const taint = minimumTaint
      ? maxClassification(memberTaint, minimumTaint)
      : memberTaint;
    if (
      !context || context.teamId !== teamId ||
      context.creatorSessionId !== owner.id ||
      context.sessionId !== memberId ||
      context.channelId !== `team-recovery-${memberId}` ||
      context.workspaceId !== `recovery-${memberId}` ||
      context.role !== member.role ||
      context.model !== member.model ||
      context.ceiling !== member.classificationCeiling ||
      context.profileBinding !== recovery.profileBinding ||
      !Object.hasOwn(CLASSIFICATION_ORDER, context.ceiling) ||
      !Object.hasOwn(CLASSIFICATION_ORDER, target) ||
      !canFlowTo(owner.taint, taint)
    ) return;
    const effectiveTarget = canFlowTo(context.ceiling, target)
      ? context.ceiling
      : target;
    if (!canFlowTo(taint, effectiveTarget)) return;
    const roster = buildTeamRosterPrompt({
      teamName: team.name,
      task: team.task,
      member,
      allMembers: team.members.map((entry) => ({
        ...entry,
        sessionId: `pending-${entry.role}` as SessionId,
      })),
    });
    if (await computeContentHash(roster) !== context.rosterDigest) return;
    return { context, roster, taint, target: effectiveTarget };
  }

  return async (
    command: string,
    parent: SessionState,
    signal?: AbortSignal,
    targetClassification: ClassificationLevel = parent.taint,
  ): Promise<string | undefined> => {
    if (!/^\/recover-team(?:\s|$)/.test(command)) return;
    const match = commandPattern.exec(command);
    if (
      !match || !match[4].trim() || match[4].length > 8_000 ||
      match[4].includes("\x00")
    ) {
      return "Usage: /recover-team <delivery UUID> <team UUID> <member session UUID> <request>";
    }
    if (signal?.aborted) return "Operation cancelled by user.";
    const [, deliveryId, rawTeamId, rawMemberId, request] = match;
    const teamId = rawTeamId.toLowerCase() as TeamId;
    const memberId = rawMemberId.toLowerCase() as SessionId;
    try {
      const source = {
        ownerSessionId: parent.id,
        teamId,
        memberSessionId: memberId,
        deliveryId: deliveryId.toLowerCase(),
      };
      const grant = recovery.observationGrant?.(source);
      const scope: CurrentScope = {
        teamId,
        memberId,
        owner: parent,
        target: targetClassification,
        ...(grant && { minimumTaint: "INTERNAL" }),
      };
      const selected = await readScope(scope);
      if (!selected) return unavailable;
      const memberContextDigest = await computeContentHash(
        JSON.stringify(selected.context),
      );
      if (grant && !canFlowTo("INTERNAL", selected.target)) return unavailable;
      const observationGrantDigest = grant &&
        await computeContentHash(JSON.stringify(grant));
      const authorizeScope = async () => {
        if (signal?.aborted) return false;
        const current = await readScope(scope);
        const currentGrant = recovery.observationGrant?.(source);
        return !!current && !!currentGrant &&
          current.target === selected.target &&
          current.taint === selected.taint &&
          await computeContentHash(JSON.stringify(current.context)) ===
            memberContextDigest &&
          await computeContentHash(JSON.stringify(currentGrant)) ===
            observationGrantDigest &&
          !signal?.aborted;
      };
      const admission = {
        id: deliveryId.toLowerCase(),
        teamId,
        senderSessionId: parent.id,
        recipientSessionId: memberId,
        requestDigest: await computeContentHash(request),
        memberContextDigest,
        ...(observationGrantDigest && { observationGrantDigest }),
        senderTaint: parent.taint,
        memberTaint: selected.taint,
        ownerTargetClassification: targetClassification,
        targetClassification: selected.target,
      };
      if (
        !withTeamRecoveryStore(recovery.path, (store) => store.admit(admission))
      ) {
        return "The trusted team delivery scope or request changed.";
      }
      const run = grant
        ? recovery.bindObservationRun?.(source, authorizeScope)
        : recovery.run;
      if (!run) return unavailable;
      if (!registry.get(memberId) && !grant) {
        const restored = await factory.create(selected.context.channelId, {
          delegatedKind: "team",
          ceiling: selected.context.ceiling,
          recoverySessionId: memberId,
          recoverySessionTaint: selected.taint,
          systemPromptSections: [selected.roster],
        });
        if (
          restored.session.id !== memberId ||
          restored.session.channelId !== selected.context.channelId ||
          restored.getSessionTaint() !== selected.taint
        ) return unavailable;
        const current = await readScope(scope);
        if (
          !current || current.taint !== selected.taint ||
          await computeContentHash(JSON.stringify(current.context)) !==
            memberContextDigest
        ) return unavailable;
        if (!registry.get(memberId)) {
          registry.register(
            memberId,
            restored.orchestrator,
            restored.session,
            restored.getSessionTaint,
          );
        }
      }
      if (signal?.aborted) return "Operation cancelled by user.";
      const current = await readScope(scope);
      if (
        !current || current.taint !== selected.taint ||
        await computeContentHash(JSON.stringify(current.context)) !==
          memberContextDigest
      ) return unavailable;
      let deliverySession;
      if (grant) {
        const restored = await factory.create(selected.context.channelId, {
          delegatedKind: "team",
          ceiling: selected.context.ceiling,
          recoverySessionId: memberId,
          recoverySessionTaint: selected.taint,
          systemPromptSections: [selected.roster],
          teamObservation: { source, authorizeScope },
        });
        if (
          restored.session.id !== memberId ||
          restored.session.channelId !== selected.context.channelId ||
          restored.getSessionTaint() !== selected.taint ||
          !await authorizeScope()
        ) return unavailable;
        deliverySession = {
          orchestrator: restored.orchestrator,
          session: restored.session,
          getTaint: restored.getSessionTaint,
        };
      }
      const result = await send(parent.id, memberId, request, {
        deliveryId: admission.id,
        run,
        deliverySession,
        authorizeScope: grant ? authorizeScope : undefined,
        senderTaint: parent.taint,
        targetClassification: admission.targetClassification,
        signal,
        trace: {
          path: join(dirname(recovery.path), "execution-traces.db"),
          teamId: admission.teamId,
        },
      });
      return result.ok ? "Team delivery completed." : result.error;
    } catch {
      return signal?.aborted
        ? "Operation cancelled by user."
        : "Durable team delivery failed.";
    }
  };
}
