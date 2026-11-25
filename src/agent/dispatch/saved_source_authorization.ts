/** Re-authorize an original, typed tool exchange without calling its handler. */
import {
  canFlowTo,
  type ClassificationLevel,
  maxClassification,
} from "../../core/types/classification.ts";
import type {
  RecoveryToolCall,
  SavedSourceAuthorization,
} from "../../core/types/orchestrator.ts";
import type { SessionState } from "../../core/types/session.ts";
import type { OrchestratorConfig } from "../orchestrator/orchestrator_config.ts";
import {
  authorizeSavedToolCalls,
  enforcePostToolResponse,
} from "./security_pipeline.ts";

export function createSavedSourceAuthorization(
  config: OrchestratorConfig,
  session: SessionState,
  signal?: AbortSignal,
): SavedSourceAuthorization {
  return {
    signal,
    async authorizeWorkflowDestination(destination) {
      const ceiling = config.getNonOwnerCeiling?.();
      if (signal?.aborted || (ceiling && !canFlowTo("INTERNAL", ceiling))) {
        return false;
      }
      const tool = "sentinel_live_workflow_status";
      const input = {
        tool_name: tool,
        tool_call: { name: tool, args: { url: destination.url } },
        operation_type: "read",
        resource_classification: "INTERNAL",
        is_outbound_request: true,
        is_owner: config.isOwnerSession?.() === true,
        is_trigger: config.isTriggerSession?.() === true,
        url: destination.url,
        sentinel_case_id: destination.caseId,
        sentinel_evidence_revision: destination.evidenceRevision,
        sentinel_task_id: destination.taskId,
        repository: destination.repository,
        workflow_id: destination.workflowId,
      };
      const result = await config.hookRunner.evaluateHook("PRE_TOOL_CALL", {
        session: {
          ...session,
          taint: maxClassification(
            config.getSessionTaint?.() ?? session.taint,
            "INTERNAL",
          ),
        },
        input,
        auditInput: input,
      });
      return result.allowed && result.action === "ALLOW" && !signal?.aborted;
    },
    authorizeSavedCall(call, classification) {
      const current = config.getSessionTaint?.() ?? session.taint;
      const ceiling = config.getNonOwnerCeiling?.();
      if (
        (ceiling && !canFlowTo(classification, ceiling)) ||
        !config.tools?.some(({ name }) => name === call.name)
      ) return Promise.resolve(false);
      return authorizeSavedToolCalls(
        [call],
        {
          ...config,
          getSessionTaint: () => maxClassification(current, classification),
        },
        session,
        undefined,
        signal,
      );
    },
    async authorizeSavedResponse(name, text, classification) {
      if (signal?.aborted) return false;
      const request = await enforcePostToolResponse(
        name,
        {
          ...config,
          getSessionTaint: () =>
            maxClassification(
              config.getSessionTaint?.() ?? session.taint,
              classification,
            ),
        },
        session,
        { resultText: text, blocked: false },
      );
      return !request.blocked && !signal?.aborted;
    },
  };
}

/** Revalidate an exact saved approval around its read-only outcome poll. */
export async function authorizeApprovedToolReconciliation(
  config: OrchestratorConfig,
  session: SessionState,
  scope: {
    readonly call: RecoveryToolCall;
    readonly classification: ClassificationLevel;
    readonly approvedRuleId: string;
    readonly ceiling: ClassificationLevel;
    readonly isCurrent: () => boolean;
  },
  readOutcome: () => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const { call, classification, approvedRuleId, ceiling, isCurrent } = scope;
  const authorizedConfig = {
    ...config,
    getSessionTaint: () =>
      maxClassification(
        config.getSessionTaint?.() ?? session.taint,
        classification,
      ),
  };
  const current = () =>
    isCurrent() && !signal?.aborted &&
    config.isOwnerSession?.() === true &&
    config.isTriggerSession?.() !== true &&
    canFlowTo(authorizedConfig.getSessionTaint(), ceiling);
  const authorizeCall = () =>
    authorizeSavedToolCalls(
      [call],
      authorizedConfig,
      session,
      {
        projectCall: () => call.args,
        acceptsSavedApproval: (candidate, ruleId) =>
          candidate === call && ruleId === approvedRuleId,
      },
      signal,
    );
  if (
    !current() || !config.tools?.some(({ name }) => name === call.name) ||
    !await authorizeCall() || !current()
  ) return;
  const result = await readOutcome();
  if (result === undefined || !current()) return;
  const source = createSavedSourceAuthorization(
    authorizedConfig,
    session,
    signal,
  );
  if (
    await source.authorizeSavedResponse(call.name, result, classification) &&
    current() && await authorizeCall() && current()
  ) return result;
}
