import { recoverSentinelArchiveQuarantines } from "./operator_run_archive_purge.ts";
import { reviewedRuleActions } from "./operator_reviewed_rules.ts";
import { namedConversations } from "../core/named_records.ts";
import { namedRecordActions } from "./operator_named_records.ts";
import { startNamedConversationTurn } from "./named_conversation_turns.ts";
import { inventoryConnectorTools } from "./operator_scopesentry_import.ts";
import { openAgentProfiles } from "../core/agent_profiles.ts";
import { withAgentProfileRuntime } from "../agent/orchestrator/agent_profile_runtime.ts";
import { withReviewedAgentModel } from "../agent/providers/reviewed_agent_model.ts";
import { isAgentProfileAction } from "./operator_agent_profiles.ts";
import { namedModelProfileActions } from "./operator_model_profiles.ts";
import { repositoryVisibilityDestinationMetadata } from "./sentinel_repository_visibility.ts";
import { createHash } from "node:crypto";
import {
  checkpointOwnerCompaction,
  compactOwnerContext,
  ownerCompactionRequested,
} from "./chat_compaction.ts";
import { sentinelAssessmentModelRouting } from "./sentinel_model_routing.ts";
import type { ManagedGoalTraceAccess } from "../core/goal_completion.ts";
import type { ManagedTranscriptGrantReader } from "../core/conversation/managed_evidence.ts";
import { authorizeManagedTranscript } from "./startup/factory/managed_transcript_authorization.ts";
import {
  authorizeApprovedToolReconciliation,
  createSavedSourceAuthorization,
} from "../agent/dispatch/saved_source_authorization.ts";
import {
  createCustomToolBindings,
  customToolManage,
} from "./custom_tool_bindings.ts";
import { isCustomToolName } from "../core/custom_tool_intent.ts";
import {
  authorizeSavedToolCalls,
  enforcePostToolResponse,
} from "../agent/dispatch/security_pipeline.ts";
import { evaluatePreOutputHook } from "../agent/dispatch/response_handling.ts";
/**
 * Chat session factory — creates and returns the ChatSession interface.
 *
 * Owns the shared orchestrator and serializes access via a processing
 * mutex. Both CLI (via gateway WebSocket) and Tidepool (via browser
 * WebSocket) call into the same ChatSession instance.
 *
 * Types and interfaces live in `chat_types.ts`.
 *
 * @module
 */

import {
  createSentinelAgent,
  createSentinelSubagent,
  isSentinelNativeGraphRead,
  readScopedSentinelConsoleGraph,
  SENTINEL_ASSESSMENT_READ,
  sentinelScopedGraphReadActions,
} from "./sentinel_agent.ts";
import {
  parseSentinelPinnedFindingRead,
  SENTINEL_SHARED_ASSET_LINKS_READ,
} from "../sentinel/worker_goal_recovery.ts";
import {
  readSentinelModelSettings,
  readSentinelWorkerSideContext,
  recordSentinelModelUsage,
} from "./sentinel_adaptive_runtime.ts";
import { createLogger } from "../core/logger/mod.ts";
import { normalizeApprovedPayload } from "../core/execution_traces.ts";
import { createOrchestrator } from "../agent/orchestrator/orchestrator.ts";
import { restoreSession, type SessionState } from "../core/types/session.ts";
import {
  canFlowTo,
  type ClassificationLevel,
  maxClassification,
  parseClassification,
} from "../core/types/classification.ts";
import type {
  ChatEventSender,
  ChatSession,
  ChatSessionConfig,
} from "./chat_types.ts";
import type { ChatHistoryEntry } from "./chat_session_interface.ts";
import {
  readSentinelAssessment,
  readSentinelGitHubWorkflowReadReceipt,
  readSentinelLinkedSourcesForRevision,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
} from "../sentinel/assessment_store.ts";
import { listSentinelFindingTrafficLinks } from "../sentinel/finding_traffic_links.ts";
import {
  isSentinelCaseId,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import { loadChatHistoryEntries } from "./chat_history.ts";
import {
  createSideQuestionService,
  loadCommittedSideChatContext,
  loadCommittedSideRunContext,
} from "./side_question.ts";
import {
  operatorRunTool,
  type OperatorRunToolContext,
  sentinelOperatorCaseControlActions,
  sentinelOperatorCaseControlParameters,
  sentinelOperatorCaseReadActions,
  sentinelOperatorCaseReadParameterAllowed,
  sentinelOperatorCaseReadParameters,
  sentinelScopedTelemetryReadActions,
} from "./operator_run_tool.ts";
import { currentOperatorSentinelFindingAmendment } from "./sentinel_worker_findings.ts";
import {
  CHAT_GOAL_REPORT_TOOL,
  executeManagedChatGoal,
  MANAGED_GOAL_STATE_TOOL,
  reportChatGoal,
  runChatGoalCommand,
} from "./chat_goal_completion.ts";

import {
  acquireTurnMutex,
  applyTaintEscalation,
  assembleOrchestratorConfig,
  orchestrateOwnerAgentTurn,
  resolveSessionTaint,
} from "./chat_turn_execution.ts";
import { dispatchOwnerRecoveryChecklist } from "./execution_checklist_recovery.ts";
import type { ChatSessionMutableState } from "./chat_turn_execution.ts";
import {
  buildTidepoolConfirmPrompt,
  buildTidepoolCredentialPrompt,
  buildTidepoolSecretPrompt,
  createPromptRegistry,
  resolveConfirmPrompt,
  resolveCredentialPrompt,
  resolveSecretPrompt,
} from "./chat_prompt_helpers.ts";
import type { CredentialResult } from "./chat_prompt_helpers.ts";
import { acceptTriggerResult } from "./chat_trigger_helpers.ts";
import {
  type ChannelState,
  registerChannelState,
  routeChannelMessage,
} from "./chat_channel_routing.ts";
// ─── Barrel re-exports from chat_types.ts ───────────────────────────────────

export type {
  ChannelClassificationConfig,
  ChannelRegistrationConfig,
  ChatClientMessage,
  ChatEvent,
  ChatEventSender,
  ChatHistoryEntry,
  ChatSession,
  ChatSessionConfig,
} from "./chat_types.ts";

export { buildSendEvent } from "./chat_event_sender.ts";

const chatLog = createLogger("chat");

/** Compact conversation history and emit status events. */
async function compactChatHistory(
  orchestrator: ReturnType<typeof createOrchestrator>,
  getSession: () => SessionState,
  sendEvent: ChatEventSender,
  config: ChatSessionConfig,
  getTaint: () => ClassificationLevel,
): Promise<void> {
  sendEvent({ type: "compact_start" });
  try {
    const session = getSession();
    const id = session.id;
    let result;
    if (config.messageStore) {
      const registry = config.providerRegistry;
      const checkpoint = await checkpointOwnerCompaction(
        {
          ...config,
          providerRegistry: registry.snapshotForTurn?.() ?? registry,
        },
        session,
        getTaint(),
        config.messageStore,
      );
      if (checkpoint.saved) orchestrator.clearHistory(id);
      result = checkpoint.result;
    } else {
      result = await orchestrator.compactHistory(id);
    }

    sendEvent({
      type: "compact_complete",
      messagesBefore: result.messagesBefore,
      messagesAfter: result.messagesAfter,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    });
  } catch {
    sendEvent({ type: "error", message: "Chat compaction failed." });
  }
}

/**
 * Create a chat session that owns the orchestrator and serializes access.
 *
 * The orchestrator's `onEvent` callback forwards events to whichever
 * client is currently being served. A promise-chain mutex ensures only
 * one message is processed at a time.
 */
export function createChatSession(config: ChatSessionConfig): ChatSession {
  const ownerSessionId = config.session.id as string;
  const ownerTargetClassification = config.targetClassification ??
    "INTERNAL" as ClassificationLevel;
  const channelStates = new Map<string, ChannelState>();
  const pairingService = config.pairingService;
  const ownerGetTaint = config.getSessionTaint;
  const ownerEscalateTaint = config.escalateTaint;

  const state: ChatSessionMutableState = {
    activeSend: null,
    activeSessionId: ownerSessionId,
    activeNonOwnerCeiling: null,
    mutex: Promise.resolve(),
    ownerSessionId,
    sessionStates: new Map<string, SessionState>([
      [ownerSessionId, config.session],
    ]),
  };

  const getSessionTaint = (): ClassificationLevel =>
    resolveSessionTaint(state, ownerGetTaint);
  const escalateTaint = (level: ClassificationLevel, reason: string): void =>
    applyTaintEscalation(
      state,
      level,
      reason,
      ownerGetTaint,
      ownerEscalateTaint,
    );

  const initialSession = config.session;
  const getSession = (): SessionState =>
    config.getSession?.() ?? initialSession;
  const goalPath = config.goalCompletionPath;
  const goalMessages = config.messageStore;
  const customTools = config.customToolsBaseDir
    ? createCustomToolBindings(config.customToolsBaseDir)
    : undefined;
  const permitsDiagnostics = config.tools?.some(({ name }) =>
    name === "healthcheck"
  );
  const existingTool = (name: string) =>
    config.tools?.some((tool) => tool.name === name) ||
    config.getExtraTools?.().some((tool) => tool.name === name);
  const ownerTools = [
    ...(customTools ? [customToolManage] : []),
    ...(goalPath && goalMessages ? [CHAT_GOAL_REPORT_TOOL] : []),
    ...(config.runManagedGoalCommand ? [MANAGED_GOAL_STATE_TOOL] : []),
    ...(config.operatorRunExecutor ? [operatorRunTool] : []),
  ];
  const compactionStore = config.enableOwnerContextCompaction === true &&
      !existingTool(compactOwnerContext.name)
    ? config.messageStore
    : undefined;
  const canCompact = compactionStore !== undefined;
  const enabledConfig: ChatSessionConfig = ownerTools.length || canCompact
    ? {
      ...config,
      tools: [...config.tools ?? [], ...ownerTools],
      ...(customTools || canCompact
        ? {
          getExtraTools: () => {
            const extra = config.getExtraTools?.() ?? [];
            const owner = state.activeSessionId === state.ownerSessionId;
            const tools = canCompact && state.ownerCompactionActive && owner
              ? [...extra, compactOwnerContext]
              : extra;
            if (!customTools || !permitsDiagnostics || !owner) return tools;
            const names = new Set(
              [...config.tools ?? [], ...tools].map(({ name }) => name),
            );
            return [
              ...tools,
              ...customTools.definitions().filter(({ name }) =>
                !names.has(name)
              ),
            ];
          },
        }
        : {}),
      hookRunner: {
        ...config.hookRunner,
        async evaluateHook(hook, context) {
          if (
            config.runManagedGoalCommand && (
              (hook === "PRE_TOOL_CALL" &&
                (context.input.tool_call as { name?: string } | undefined)
                    ?.name === MANAGED_GOAL_STATE_TOOL.name) ||
              (hook === "POST_TOOL_RESPONSE" &&
                context.input.tool_name === MANAGED_GOAL_STATE_TOOL.name)
            )
          ) {
            const taint = getSessionTaint();
            let label = taint;
            if (
              hook === "POST_TOOL_RESPONSE" &&
              typeof context.input.tool_response === "string" &&
              context.input.tool_response.startsWith("{")
            ) {
              const parsed = parseClassification(
                JSON.parse(context.input.tool_response)._classification,
              );
              label = parsed.ok ? parsed.value : "RESTRICTED";
            }
            const meta = {
              tool_name: MANAGED_GOAL_STATE_TOOL.name,
              resource_classification: label,
              operation_type: hook === "PRE_TOOL_CALL" &&
                  ["cite", "confirm"].includes(
                    String(
                      (context.input.tool_call as {
                        args?: Record<string, unknown>;
                      })?.args?.action,
                    ),
                  )
                ? "write"
                : "read",
            };
            const owner = state.ownerSessionId;
            const decision = await config.hookRunner.evaluateHook(hook, {
              ...context,
              input: { ...context.input, ...meta },
              auditInput: meta,
            });
            if (
              state.activeSessionId !== owner ||
              state.ownerSessionId !== owner ||
              !canFlowTo(label, getSessionTaint()) ||
              !canFlowTo(getSessionTaint(), ownerTargetClassification)
            ) {
              return { ...decision, allowed: false, action: "BLOCK" };
            }
            return decision;
          }
          if (config.operatorRunExecutor && hook === "PRE_TOOL_CALL") {
            const call = context.input.tool_call as
              | {
                readonly name?: string;
                readonly args?: Record<string, unknown>;
              }
              | undefined;
            if (call?.name === operatorRunTool.name) {
              const action = call.args?.action;
              const namedModelProfile = namedModelProfileActions.some((name) =>
                name === action
              );
              const selectedRouteClass = typeof action === "string" &&
                  (namedModelProfile || [
                    "live_model_route",
                    "set_live_model_route",
                    "reset_live_model_route",
                    "model_usage_totals",
                    "tool_usage_totals",
                  ].includes(action)) &&
                  typeof call.args?.modelRouteClassification === "string"
                ? parseClassification(call.args.modelRouteClassification)
                : undefined;
              const meta = {
                tool_name: operatorRunTool.name,
                resource_classification: selectedRouteClass?.ok
                  ? maxClassification("INTERNAL", selectedRouteClass.value)
                  : "INTERNAL",
                operation_type: typeof action === "string" &&
                    [
                      "list",
                      "profiles",
                      "model_route",
                      "named_conversations",
                      "agent_profiles",
                      "agent_profile",
                      "agent_profile_history",
                      "preview_agent_prompt",
                      "agent_event_subscriptions",
                      "sentinel_tool_configuration",
                      "inspect",
                      "graph",
                      "findings",
                      "discovery_proposals",
                      "facts",
                      "list_digests",
                      "case_local_tool_usage",
                      "expand_digest",
                      "node",
                      "traces",
                      "tasks",
                      "worker_limit",
                      "assessment_concurrency",
                      "live_model_route",
                      "model_profiles",
                      "model_profile",
                      "model_usage_totals",
                      "tool_usage_totals",
                      "finding_groups",
                      "finding_asset_tree",
                      "search_case_traces",
                      "list_trace_workers",
                      "worker_trace_progress",
                      "worker_trace_result",
                      "constraints",
                      "goals",
                      "goal_proposals",
                      "inventory",
                      "preview_membership",
                      "preview_discovery_withdrawal",
                      "preview_inventory_withdrawal",
                      "preview_inventory_affiliation",
                      "archive_history",
                      "archive_catalog",
                      "interactive_turns",
                      "assessment_templates",
                      "approval_history",
                      "profiles",
                      "execution_traces",
                      "execution_trace_payload",
                      "case_execution_evidence",
                      "finding_recheck_candidates",
                      "finding_recheck_attempts",
                      "active_finding_rechecks",
                      "finding_recheck_sources",
                      "defense_coverage",
                      "incident_alerts",
                      "case_alert",
                      "incidents",
                      "decision_history",
                      "list_companies",
                      "company_scope",
                      "company_assets",
                      "finding_receipt",
                      "finding_receipts",
                      "finding_report",
                      "finding_report_history",
                      "goals",
                      "finding_lineage",
                      "linked_finding",
                      "linked_findings",
                      "linked_worker_review",
                      "reviewed_tool_rules",
                      "reviewed_tool_reviewer",
                      "reviewed_tool_advice",
                      "finding_traffic",
                      "finding_traffic_set_receipt",
                      "finding_traffic_candidates",
                      "traffic_search",
                      "traffic_get",
                      "traffic_blob",
                    ]
                      .includes(action)
                  ? "read"
                  : "write",
                ...(call.args?.kind === "sentinel" &&
                  (action === "narrow_constraints" ||
                    action === "constraints" || action === "steer" ||
                    action === "hint_batch" || action === "assign_batch" ||
                    action === "preview_inventory_affiliation" ||
                    action === "affiliate_inventory_asset" ||
                    action === "append_goals" || action === "withdraw_goal" ||
                    action === "goals" ||
                    action === "confirm_goal_completion" ||
                    action === "preview_membership" ||
                    action === "set_case_membership" ||
                    action === "add_case_membership" ||
                    action === "record_analyst_finding" ||
                    action === "amend_finding_report") &&
                  {
                    case_id: typeof call.args?.id === "string" &&
                        isSentinelCaseId(call.args.id)
                      ? call.args.id
                      : null,
                    evidence_revision:
                      typeof call.args?.revision === "number" &&
                        Number.isSafeInteger(call.args.revision) &&
                        call.args.revision > 0
                        ? call.args.revision
                        : null,
                  }),
              };
              return config.hookRunner.evaluateHook(hook, {
                ...context,
                input: { ...context.input, ...meta },
                auditInput: action === "set_agent_event_subscription" ||
                    namedRecordActions.some((name) => name === action) ||
                    reviewedRuleActions.some((name) => name === action) ||
                    isAgentProfileAction(action) ||
                    namedModelProfile ||
                    action === "set_sentinel_tool_configuration" ||
                    action === "reset_sentinel_tool_configuration" ||
                    action === "set_company_scope" ||
                    action === "delete_company" ||
                    action === "preview_membership" ||
                    action === "set_case_membership" ||
                    action === "add_case_membership" ||
                    action === "preview_inventory_affiliation" ||
                    action === "affiliate_inventory_asset" ||
                    action === "amend_finding_report" ||
                    action === "confirm_goal_completion"
                  ? meta
                  : { ...context.auditInput, ...meta },
              });
            }
          }
          if (
            config.operatorRunExecutor && hook === "POST_TOOL_RESPONSE" &&
            context.input.tool_name === operatorRunTool.name &&
            typeof context.input.tool_response === "string" &&
            context.input.tool_response.includes('"kind":"report_amendment"')
          ) {
            const text = context.input.tool_response;
            const receipt = JSON.parse(text).amendment;
            if (receipt?.kind === "report_amendment") {
              const allowed = () => {
                if (
                  state.activeSessionId !== state.ownerSessionId ||
                  typeof receipt.caseId !== "string" ||
                  !isSentinelCaseId(receipt.caseId)
                ) return false;
                const path = receipt.caseId === "main"
                  ? config.sentinelSnapshotPath ??
                    (config.sentinelSharedInventoryBaseDir &&
                      resolveSentinelCasePath(
                        config.sentinelSharedInventoryBaseDir,
                      ))
                  : config.resolveSentinelChatCase?.(receipt.caseId) ??
                    (config.sentinelSharedInventoryBaseDir &&
                      resolveSentinelCasePath(
                        config.sentinelSharedInventoryBaseDir,
                        receipt.caseId,
                      ));
                return !path || currentOperatorSentinelFindingAmendment(
                  path,
                  receipt.evidenceRevision,
                  text,
                );
              };
              const decision = await config.hookRunner.evaluateHook(
                hook,
                context,
              );
              return allowed()
                ? decision
                : { ...decision, allowed: false, action: "BLOCK" };
            }
          }
          return config.hookRunner.evaluateHook(hook, context);
        },
      },
      toolExecutor: (name, input, context) => {
        const owner = state.activeSessionId === state.ownerSessionId;
        if (canCompact && name === compactOwnerContext.name) {
          return Promise.resolve(
            owner && state.ownerCompactionActive &&
              canFlowTo(getSessionTaint(), ownerTargetClassification) &&
              Object.keys(input).length === 0
              ? ownerCompactionRequested
              : "Error: Owner context compaction is unavailable.",
          );
        }
        const testCustomTool = name === customToolManage.name &&
          input.action === "test";
        if (customTools && name === customToolManage.name && !testCustomTool) {
          if (
            owner && (input.action === "inspect" || input.action === "apply") &&
            isCustomToolName(input.name) && existingTool(input.name)
          ) {
            return Promise.resolve(
              "Error: An existing tool already has this name.",
            );
          }
          return Promise.resolve(customTools.manage(input, context));
        }
        if (
          customTools &&
          (testCustomTool || (isCustomToolName(name) && !existingTool(name)))
        ) {
          const binding = () => {
            if (!owner || !permitsDiagnostics) return;
            if (testCustomTool) {
              return isCustomToolName(input.name) && !existingTool(input.name)
                ? customTools.reviewedDiagnostic(input, context)
                : undefined;
            }
            if (Object.keys(input).length === 0) return customTools.read(name);
          };
          const selected = binding();
          if (!selected) {
            return Promise.resolve(
              testCustomTool
                ? "Error: The reviewed diagnostic proposal is unavailable."
                : "Error: The custom tool binding is unavailable.",
            );
          }
          return orchestrator.executeOperatorTool({
            name: "healthcheck",
            args: { components: [selected.component] },
          }, {
            session: getSession(),
            targetClassification: ownerTargetClassification,
            suppressToolEvents: true,
          }).then((result) => {
            if (testCustomTool && !binding()) {
              return "Error: The reviewed diagnostic proposal changed during testing.";
            }
            return result.ok
              ? result.value
              : "Error: The underlying operation is blocked.";
          });
        }
        if (name === operatorRunTool.name && config.operatorRunExecutor) {
          return owner
            ? config.operatorRunExecutor(
              input,
              savedToolAuthorization(
                getSession(),
                getSessionTaint,
                () => state.activeSessionId === state.ownerSessionId,
              ),
            )
            : Promise.resolve("Run control requires the owner session.");
        }
        if (name === CHAT_GOAL_REPORT_TOOL.name && goalPath && goalMessages) {
          return owner
            ? reportChatGoal(
              goalPath,
              goalMessages,
              state.ownerSessionId,
              getSessionTaint(),
              input,
              context,
              (input.action === "evidence" || input.action === "status" ||
                  input.action === "confirm" ||
                  (!input.action && !input.criterion))
                ? {
                  current: () =>
                    context?.isCurrentInteractiveOwner?.() === true &&
                    state.activeSessionId === state.ownerSessionId &&
                    canFlowTo(getSessionTaint(), ownerTargetClassification),
                  authorization: createSavedSourceAuthorization(
                    orchestratorConfig,
                    getSession(),
                  ),
                }
                : undefined,
            )
            : Promise.resolve("Goal reporting requires the owner session.");
        }
        if (
          name === MANAGED_GOAL_STATE_TOOL.name && config.runManagedGoalCommand
        ) {
          const taint = getSessionTaint();
          const session = getSession();
          const confirm = input.action === "confirm";
          const needsTrace = input.action === "cite" ||
            input.action === "status" || confirm;
          const reauthorize = context?.reauthorizeOwnerApproval;
          const current = () =>
            (!confirm || (context?.ownerSessionId === session.id &&
              !!context.toolApprovalRequestId && !!reauthorize)) &&
            (!needsTrace || context?.isCurrentInteractiveOwner?.() === true) &&
            state.activeSessionId === session.id &&
            state.ownerSessionId === session.id &&
            canFlowTo(taint, getSessionTaint()) &&
            canFlowTo(getSessionTaint(), ownerTargetClassification);
          if (!owner || !current()) {
            return Promise.resolve("Error: Managed goal state is unavailable.");
          }
          return executeManagedChatGoal(
            config.runManagedGoalCommand,
            input,
            taint,
            needsTrace
              ? managedGoalTraceAccess(
                session,
                current,
                confirm ? reauthorize : undefined,
              )
              : undefined,
          ).then((result) =>
            current() ? result : "Error: Managed goal state is unavailable."
          );
        }
        return config.toolExecutor?.(name, input, context) ??
          Promise.resolve(`Unknown tool: ${name}`);
      },
    }
    : config;
  const orchestratorConfig = assembleOrchestratorConfig(
    {
      ...enabledConfig,
      toolExecutor(name, input, context) {
        if (state.activeSessionId === state.ownerSessionId) {
          const scoped = dispatchOwnerRecoveryChecklist(
            getSession().id,
            name,
            input,
            context,
            getSessionTaint,
          );
          if (scoped) return scoped.then((result) => result ?? "Unknown tool");
        }
        return enabledConfig.toolExecutor?.(name, input, context) ??
          Promise.resolve(`Unknown tool: ${name}`);
      },
    },
    state,
    getSessionTaint,
    escalateTaint,
  );
  function managedGoalTraceAccess(
    session: SessionState,
    current: () => boolean,
    reauthorizeDecision?: () => Promise<boolean>,
  ): ManagedGoalTraceAccess | undefined {
    const execute = config.operatorRunExecutor;
    if (!current()) return;
    return {
      ownerSessionId: session.id,
      current,
      authorizeTranscript(
        source: string,
        row: import("../core/conversation/mod.ts").ConversationRecord,
        resolveGrant?: ManagedTranscriptGrantReader,
      ) {
        return authorizeManagedTranscript(
          orchestratorConfig,
          current,
          getSessionTaint(),
          source,
          row,
          resolveGrant,
        );
      },
      ...(reauthorizeDecision && { reauthorizeDecision }),
      authorizeRecoveryObservation(proof, resolveGrant) {
        return authorizeManagedTranscript(
          orchestratorConfig,
          current,
          getSessionTaint(),
          proof.source,
          {
            message_id: "",
            session_id: proof.sessionId,
            content: "",
            role: "tool_call",
            tool_name: "read_committed_observation",
            tool_args: {},
            classification: proof.classification,
            timestamp: proof.admittedAt,
            sequence: 0,
            compacted: false,
            managedTranscriptIdentity: {
              source: proof.source,
              channelId: proof.channelId ?? proof.executionId,
              createdAt: proof.admittedAt,
              ceiling: proof.ceiling,
              isTrigger: true,
              observationGrantDigest: proof.grantDigest,
            },
          },
          resolveGrant,
          proof.resultSha256,
        );
      },
      reopen(role: "scheduled" | "delegated", runId: string, ordinal: number) {
        return execute?.({
          action: "execution_trace_payload",
          traceRole: role,
          id: runId,
          ordinal,
        }, savedToolAuthorization(session, getSessionTaint, current)) ??
          Promise.resolve("");
      },
    };
  }

  function savedToolAuthorization(
    session: SessionState,
    taint: () => ClassificationLevel,
    isCurrent: () => boolean,
  ): OperatorRunToolContext {
    const policy = { ...orchestratorConfig, getSessionTaint: taint };
    return {
      ceiling: ownerTargetClassification,
      inputClassification: taint(),
      authenticatedOwnerSessionId: session.id,
      async authorizeOwnerRunCall(args) {
        if (!isCurrent()) return false;
        const allowed = await authorizeSavedToolCalls(
          [{ name: operatorRunTool.name, args }],
          policy,
          session,
        );
        return allowed && isCurrent();
      },
      async authorizeNotificationOutput(
        channelId,
        origin,
        classification,
        body,
        source,
      ) {
        const outputTaint = () =>
          source ? maxClassification("INTERNAL", taint()) : taint();
        if (!isCurrent() || !canFlowTo(outputTaint(), classification)) {
          return false;
        }
        const metadata = {
          destination: origin,
          notification_channel_id: channelId,
          target_classification: classification,
          ...(source && {
            case_id: source.caseId,
            run_id: source.runId,
            evidence_revision: source.revision,
            ...(source.kind !== "sentinel_incident_increase" && {
              finding_id: source.findingId,
              source_receipt_id: source.receiptId,
            }),
          }),
        };
        const decision = await config.hookRunner.evaluateHook("PRE_OUTPUT", {
          session: { ...session, taint: outputTaint() },
          input: { ...metadata, content: body },
          auditInput: metadata,
        });
        return decision.allowed && isCurrent() &&
          canFlowTo(outputTaint(), classification);
      },
      ...(config.recoverAgentTurn && { ownerRecoverySessionId: session.id }),
      ...(config.runSubagentRecoveryCommand && {
        delegatedRecovery: {
          parent: session.id,
          async resume(executionId: string, task: string) {
            if (!isCurrent()) return;
            await config.runSubagentRecoveryCommand?.(
              `/recover-subagent --resume-paused ${executionId} ${task}`,
              session,
              undefined,
              ownerTargetClassification,
            );
          },
        },
      }),
      ...(config.runTeamRecoveryCommand && {
        async resumeTeamDelivery(deliveryId, teamId, memberSessionId, task) {
          if (!isCurrent()) return;
          await config.runTeamRecoveryCommand?.(
            `/recover-team --resume-paused ${deliveryId} ${teamId} ${memberSessionId} ${task}`,
            session,
            undefined,
            ownerTargetClassification,
          );
        },
      }),
      async authorizeSentinelTraceRead(scope, tool, call, result) {
        if (!isCurrent()) return false;
        const metadata = {
          tool_name: tool,
          case_id: scope.caseId,
          evidence_revision: scope.revision,
          ...(scope.taskId === undefined
            ? {
              planner_identity: scope.plannerIdentity,
              planner_attempt: scope.attempt,
            }
            : { assignment_id: scope.taskId }),
          resource_classification: "INTERNAL",
          operation_type: "read",
        };
        if (result === undefined) {
          const decision = await config.hookRunner.evaluateHook(
            "PRE_TOOL_CALL",
            {
              session: { ...session, taint: taint() },
              input: {
                ...metadata,
                tool_call: { name: tool, args: call },
              },
              auditInput: metadata,
            },
          );
          return decision.allowed && isCurrent();
        }
        const response = await enforcePostToolResponse(
          tool,
          {
            ...policy,
            getSessionTaint: () => maxClassification(taint(), "INTERNAL"),
            hookRunner: {
              ...policy.hookRunner,
              evaluateHook(hook, hookContext) {
                return policy.hookRunner.evaluateHook(hook, {
                  ...hookContext,
                  input: { ...hookContext.input, ...metadata },
                  auditInput: { ...hookContext.auditInput, ...metadata },
                });
              },
            },
          },
          session,
          { resultText: result, blocked: false },
        );
        return !response.blocked && isCurrent();
      },
      async authorizeRepositoryVisibilityDestination(
        destination,
        revision,
        taskId,
      ) {
        if (!isCurrent()) return false;
        const metadata = repositoryVisibilityDestinationMetadata(
          destination,
          revision,
          taskId,
          true,
        );
        const outcome = await config.hookRunner.evaluateHook("PRE_TOOL_CALL", {
          session: { ...session, taint: taint() },
          input: {
            ...metadata,
            tool_call: {
              name: metadata.tool_name,
              args: { url: destination.url },
            },
          },
          auditInput: metadata,
        });
        return outcome.allowed && outcome.action === "ALLOW" && isCurrent();
      },
      async authorizeWorkflowDestination(destination, revision, taskId) {
        if (!isCurrent()) return false;
        const input = {
          tool_name: "sentinel_live_workflow_status",
          tool_call: {
            name: "sentinel_live_workflow_status",
            args: { url: destination.url },
          },
          operation_type: "read",
          resource_classification: "INTERNAL",
          is_outbound_request: true,
          is_owner: true,
          url: destination.url,
          sentinel_case_id: destination.caseId,
          sentinel_evidence_revision: revision,
          sentinel_task_id: taskId,
          repository: destination.repository,
          workflow_id: destination.workflowId,
        };
        const outcome = await config.hookRunner.evaluateHook("PRE_TOOL_CALL", {
          session: { ...session, taint: taint() },
          input,
          auditInput: input,
        });
        return outcome.allowed && isCurrent();
      },
      async authorizeInventoryConnectorCall(call) {
        if (
          !isCurrent() ||
          !inventoryConnectorTools.some((name) => call.name === name) ||
          !existingTool(call.name)
        ) return false;
        return await authorizeSavedToolCalls([call], policy, session) &&
          isCurrent();
      },
      authorizeSavedCall(call) {
        if (
          !isCurrent() || !config.tools?.some(({ name }) => name === call.name)
        ) {
          return Promise.resolve(false);
        }
        return authorizeSavedToolCalls([call], policy, session);
      },
      async authorizeSavedResponse(name, text, classification) {
        if (!isCurrent()) return false;
        const permitted = await enforcePostToolResponse(
          name,
          {
            ...policy,
            getSessionTaint: () => maxClassification(taint(), classification),
          },
          session,
          { resultText: text, blocked: false },
        );
        return !permitted.blocked && isCurrent();
      },
    };
  }
  const reservedAgentProfiles = new Set([
    "sentinel-goals",
    "sentinel-reporter",
    "sentinel-recheck",
  ]);
  const agentProfiles = config.customToolsBaseDir
    ? openAgentProfiles(config.customToolsBaseDir)
    : undefined;
  const readActiveAgentProfile = () => {
    if (
      !agentProfiles ||
      state.activeSessionId !== state.ownerSessionId
    ) return;
    try {
      return agentProfiles.selectedForSession(state.ownerSessionId);
    } catch {
      return null;
    }
  };
  const runtimeConfig = withAgentProfileRuntime({
    ...orchestratorConfig,
    providerRegistry: withReviewedAgentModel(
      orchestratorConfig.providerRegistry,
      readActiveAgentProfile,
      config.agentModelProfileAllowlists,
    ),
  }, readActiveAgentProfile);
  const orchestrator = createOrchestrator({
    ...runtimeConfig,
    toolApprovalContext: {
      isCurrent: (id) =>
        state.activeSessionId === id && state.sessionStates.has(id),
    },
  });

  const providerName = config.providerRegistry.getDefault()?.name ?? "unknown";
  const modelName = config.primaryModelName ??
    config.providerRegistry.getDefault()?.name ?? "unknown";
  const pendingSecretPrompts = createPromptRegistry<string | null>("Secret");
  const pendingCredentialPrompts = createPromptRegistry<
    CredentialResult | null
  >("Credential");
  const pendingConfirmPrompts = createPromptRegistry<boolean>("Confirm");

  let mcpStatusConnected = -1;
  let mcpStatusConfigured = 0;

  const snapshotPath = config.sentinelSnapshotPath;
  const runCaseRead = config.operatorRunExecutor;
  function operatorRunReaderForCase(selectedPath: string) {
    if (
      !runCaseRead || !snapshotPath ||
      !canFlowTo("INTERNAL", ownerTargetClassification)
    ) return;
    const execute = runCaseRead;
    return {
      definition: {
        ...operatorRunTool,
        description:
          "Read saved Sentinel evidence. In the selected active case, inspect restrictions or request reviewed formal goals, task-kind restrictions, planner hints, local graph assignments, or targeted worker guidance.",
        parameters: {
          ...Object.fromEntries(
            [
              ...sentinelOperatorCaseReadParameters,
              ...sentinelOperatorCaseControlParameters,
            ]
              .map((key) => [
                key,
                operatorRunTool.parameters[key],
              ]),
          ),
          action: {
            ...operatorRunTool.parameters.action,
            enum: [
              ...sentinelOperatorCaseReadActions,
              ...sentinelOperatorCaseControlActions,
            ],
          },
          kind: {
            ...operatorRunTool.parameters.kind,
            enum: ["sentinel"],
            required: true,
          },
          id: { ...operatorRunTool.parameters.id, required: true },
          revision: {
            ...operatorRunTool.parameters.revision,
            required: true,
          },
        },
      },
      async execute(
        args: Record<string, unknown>,
        signal: AbortSignal,
        retainTelemetryFence?: (
          fence: {
            key: string;
            isCurrent: () => boolean;
            authorize: () => Promise<boolean>;
          },
        ) => void,
        directRead?: { name: string; args: Record<string, unknown> },
      ) {
        const { action, kind, id, revision, runId } = args;
        const linkedReview = action === "linked_worker_review";
        const linkedFinding = action === "linked_finding" &&
            args.linkedFinding && typeof args.linkedFinding === "object" &&
            !Array.isArray(args.linkedFinding)
          ? parseSentinelPinnedFindingRead(
            args.linkedFinding as Record<string, unknown>,
          )
          : undefined;
        const linkedCase = linkedReview || action === "linked_findings"
          ? args.sourceCase
          : linkedFinding?.sourceCase;
        const linkedRead = linkedReview || action === "linked_findings" ||
          action === "linked_finding";
        const goalRead = action === "goals";
        const goalConfirmation = action === "confirm_goal_completion";
        const selectedReport = action === "finding_report" ||
          action === "finding_report_history";
        const exactHistory = action === "decision_history" ||
          action === "finding_lineage";
        const previewMembership = action === "preview_membership";
        const setMembership = action === "set_case_membership";
        const selectedControl = sentinelOperatorCaseControlActions.some((
          allowed,
        ) => allowed === action);
        const unavailable =
          "Error: The selected Sentinel case revision is unavailable.";
        if (
          kind !== "sentinel" || typeof action !== "string" ||
          (!selectedControl &&
            !sentinelOperatorCaseReadActions.some((allowed) =>
              allowed === action
            )) ||
          typeof id !== "string" ||
          typeof revision !== "number" || !Number.isSafeInteger(revision) ||
          revision < 1 ||
          Object.keys(args).some((key) =>
            !sentinelOperatorCaseReadParameterAllowed(action, key) &&
            (!selectedControl ||
              !sentinelOperatorCaseControlParameters.some((allowed) =>
                allowed === key
              ))
          )
        ) return unavailable;
        const owner = state.sessionStates.get(state.ownerSessionId);
        if (!owner) return unavailable;
        const resolveCase = () =>
          id === "main" ? snapshotPath : config.resolveSentinelChatCase?.(id);
        const current = () => {
          if (
            signal.aborted ||
            state.activeSessionId !== state.ownerSessionId ||
            state.sessionStates.get(state.ownerSessionId) !== owner
          ) return false;
          const casePath = resolveCase();
          if (!selectedControl) {
            return directRead || linkedRead || selectedReport ||
                exactHistory || goalRead ||
                previewMembership
              ? casePath === selectedPath
              : !!casePath;
          }
          if (casePath !== selectedPath) return false;
          const assessment = readSentinelAssessment(selectedPath);
          if (!assessment || assessment.plan.runId !== runId) return false;
          if (goalConfirmation) {
            return (assessment.active || !!assessment.completion) &&
              assessment.revision === revision;
          }
          // Goal edits commit a new revision. Only an exact saved receipt
          // can replay an older request, and only append can reopen a run.
          return action === "append_goals" || action === "withdraw_goal"
            ? (assessment.active || assessment.completion !== undefined) &&
              assessment.revision >= revision
            : assessment.active && assessment.revision === revision;
        };
        if (!current()) return unavailable;
        const scopedDecision = action === "review_incident";
        const amendReport = action === "amend_finding_report";
        const scopedRead = scopedDecision || exactHistory || amendReport ||
          goalRead ||
          goalConfirmation ||
          sentinelScopedTelemetryReadActions.some(
            (allowed) => allowed === action,
          ) ||
          sentinelScopedGraphReadActions.some((allowed) => allowed === action);
        const sourcePath = scopedRead ? resolveCase() : undefined;
        const sourceRun = sourcePath &&
          readSentinelRunIdForRevision(sourcePath, revision);
        const sourcePolicy = sourcePath && sourceRun
          ? readSentinelOperatingConstraints(sourcePath, sourceRun)
          : undefined;
        let membershipReceipt: {
          readonly version: number;
          readonly digest: string;
          readonly sourceDigest: string;
        } | undefined;
        let amendmentResult: string | undefined;
        const sourceIsCurrent = () => {
          if (
            !sourcePath || !sourceRun || !current() ||
            resolveCase() !== sourcePath ||
            (directRead?.name === SENTINEL_ASSESSMENT_READ &&
              readSentinelAssessment(sourcePath)?.revision !== revision) ||
            readSentinelRunIdForRevision(sourcePath, revision) !==
              sourceRun
          ) return false;
          if (previewMembership) return true;
          if (amendReport) {
            return !!amendmentResult && currentOperatorSentinelFindingAmendment(
              sourcePath,
              revision,
              amendmentResult,
            );
          }
          const latest = readSentinelOperatingConstraints(
            sourcePath,
            sourceRun,
          );
          if (setMembership) {
            return !!membershipReceipt && !!latest &&
              latest.evidenceRevision === revision &&
              typeof args.requestId === "string" &&
              latest.requestId === args.requestId.toLowerCase() &&
              latest.version === membershipReceipt.version &&
              latest.digest === membershipReceipt.digest &&
              latest.membership?.snapshotDigest ===
                membershipReceipt.sourceDigest;
          }
          return latest?.version === sourcePolicy?.version &&
            latest?.digest === sourcePolicy?.digest;
        };
        const authority = savedToolAuthorization(
          owner,
          () => "INTERNAL",
          current,
        );
        if (
          selectedControl && !await authority.authorizeOwnerRunCall?.(args)
        ) return unavailable;
        const nativeGraph = directRead &&
          isSentinelNativeGraphRead(directRead.name);
        const read = (readSettled = false) =>
          execute(args, {
            ...authority,
            ...(readSettled && { requireSettledGoalConfirmation: true }),
            ...((selectedControl || previewMembership || goalRead) && {
              authorizeSelectedSentinelCase: current,
            }),
            authorizeSentinelCaseRead: (caseId, evidenceRevision) =>
              current() &&
              ((caseId === id && evidenceRevision === revision) ||
                (linkedRead && caseId === linkedCase &&
                  readSentinelLinkedSourcesForRevision(selectedPath, revision)
                      ?.some((source) =>
                        source.caseId === caseId &&
                        source.revision === evidenceRevision &&
                        (!linkedReview || source.workerReviews?.some(
                          ({ taskId }) => taskId === args.taskId,
                        ))
                      ) === true)),
          });
        const result = nativeGraph && sourcePath
          ? await readScopedSentinelConsoleGraph(
            sourcePath,
            revision,
            directRead.name,
            directRead.args,
            { baseDir: config.sentinelSharedInventoryBaseDir, signal },
          )
          : await read();
        if (!current()) return unavailable;
        if (scopedRead && result.startsWith("{")) {
          if (amendReport) amendmentResult = result;
          if (setMembership) membershipReceipt = JSON.parse(result);
          if (!sourceIsCurrent()) return unavailable;
          const source = directRead ??
            { name: operatorRunTool.name, args };
          const text = directRead && !nativeGraph
            ? JSON.stringify(JSON.parse(result).evidence)
            : result;
          if (!text) return unavailable;
          const metadata = {
            tool_name: source.name,
            case_id: id,
            evidence_revision: revision,
            resource_classification: "INTERNAL",
            operation_type: setMembership || amendReport || goalConfirmation
              ? "write"
              : "read",
          };
          const policy: typeof orchestratorConfig = {
            ...orchestratorConfig,
            getSessionTaint: () => "INTERNAL",
            hookRunner: {
              ...orchestratorConfig.hookRunner,
              evaluateHook(hook, context) {
                return orchestratorConfig.hookRunner.evaluateHook(hook, {
                  ...context,
                  input: { ...context.input, ...metadata },
                  auditInput: { ...context.auditInput, ...metadata },
                });
              },
            },
          };
          retainTelemetryFence?.({
            key: createHash("sha256").update(JSON.stringify([
              id,
              revision,
              sourceRun,
              sourcePolicy?.version,
              source,
              text,
            ])).digest("hex"),
            isCurrent: sourceIsCurrent,
            async authorize() {
              if (
                !sourceIsCurrent() ||
                !await authorizeSavedToolCalls([source], policy, owner) ||
                !sourceIsCurrent()
              ) return false;
              const approved = await enforcePostToolResponse(
                source.name,
                policy,
                owner,
                { resultText: text, blocked: false },
              );
              if (approved.blocked || !sourceIsCurrent()) return false;
              if (previewMembership) {
                // Publishing the reviewed membership changes the preview version
                // without necessarily changing its authorized exact assets.
                const reopened = await read();
                return sourceIsCurrent() && reopened.startsWith("{") &&
                  JSON.stringify(JSON.parse(reopened).membership) ===
                    JSON.stringify(JSON.parse(text).membership);
              }
              if (
                linkedRead || selectedReport || scopedDecision ||
                exactHistory || goalRead ||
                goalConfirmation
              ) {
                return await read(goalConfirmation) === text &&
                  sourceIsCurrent();
              }
              if (source.name !== SENTINEL_SHARED_ASSET_LINKS_READ) return true;
              return !!sourcePath && await readScopedSentinelConsoleGraph(
                    sourcePath,
                    revision,
                    source.name,
                    source.args,
                    { baseDir: config.sentinelSharedInventoryBaseDir, signal },
                  ) === text &&
                sourceIsCurrent();
            },
          });
          return text;
        }
        return result;
      },
    };
  }
  const archiveRecoveryBaseDir = config.operatorRunExecutor &&
    config.customToolsBaseDir;
  const session: ChatSession = {
    ...(archiveRecoveryBaseDir && {
      async recoverRunArchiveQuarantines() {
        const { authorizeOwnerRunCall } = savedToolAuthorization(
          config.session,
          () => config.session.taint,
          () => true,
        );
        if (authorizeOwnerRunCall) {
          await recoverSentinelArchiveQuarantines(
            archiveRecoveryBaseDir,
            authorizeOwnerRunCall,
          );
        }
      },
    }),
    approvalInbox: config.hookRunner.toolApprovalInbox,
    async readSentinelTrafficDownloadPage(request) {
      if (!config.operatorRunExecutor) return;
      const {
        caseId,
        revision,
        currentRevision,
        findingId,
        trafficLinkId,
        payloadPart,
        offset,
      } = request;
      const owner = getSession();
      const path = caseId === "main"
        ? snapshotPath
        : config.resolveSentinelChatCase?.(caseId);
      if (!path) return;
      const runId = readSentinelRunIdForRevision(path, revision);
      const activeRunId = readSentinelAssessment(path)?.plan.runId;
      if (!activeRunId) return;
      const readScopeVersion = () =>
        readSentinelOperatingConstraints(path, activeRunId)?.version ?? 0;
      const scopeVersion = readScopeVersion();
      const current = () => {
        if (
          !runId || state.activeSessionId !== state.ownerSessionId ||
          getSession().id !== owner.id || owner.id !== state.ownerSessionId ||
          !canFlowTo(
            maxClassification(getSessionTaint(), "INTERNAL"),
            ownerTargetClassification,
          )
        ) return false;
        const assessment = readSentinelAssessment(path);
        return assessment?.revision === currentRevision &&
          assessment.plan.runId === activeRunId &&
          readScopeVersion() === scopeVersion &&
          readSentinelRunIdForRevision(path, revision) === runId;
      };
      if (!current()) return;
      const result = await orchestrator.executeOperatorTool({
        name: operatorRunTool.name,
        args: {
          action: "finding_traffic",
          kind: "sentinel",
          id: caseId,
          revision,
          receiptId: findingId,
          trafficLinkId,
          payloadPart,
          offset,
          byteLength: 1024,
        },
      }, {
        session: owner,
        targetClassification: ownerTargetClassification,
        suppressToolEvents: true,
      });
      if (!result.ok || !result.value.startsWith("{") || !current()) return;
      const page = JSON.parse(result.value);
      const [link] = listSentinelFindingTrafficLinks(path, {
        id: trafficLinkId,
        evidenceRevision: revision,
        findingId,
        limit: 1,
      });
      if (
        !link || page.link?.id !== link.id ||
        page.link.trafficDigest !== link.trafficDigest || !current()
      ) return;
      return { ...page, runId, currentRevision, scopeVersion };
    },
    async readSentinelWorkerNarrative(caseId, revision, currentRevision, node) {
      const owner = getSession();
      const path = caseId === "main"
        ? snapshotPath
        : config.resolveSentinelChatCase?.(caseId);
      if (!path) return;
      const activeRun = readSentinelAssessment(path)?.plan.runId;
      const scope = activeRun &&
        readSentinelOperatingConstraints(path, activeRun)?.digest;
      const current = () =>
        state.activeSessionId === state.ownerSessionId &&
        getSession().id === owner.id && owner.id === state.ownerSessionId &&
        canFlowTo(
          maxClassification(getSessionTaint(), "INTERNAL"),
          ownerTargetClassification,
        ) &&
        readSentinelAssessment(path)?.revision === currentRevision &&
        readSentinelAssessment(path)?.plan.runId === activeRun &&
        !!activeRun &&
        readSentinelOperatingConstraints(path, activeRun)?.digest === scope;
      if (!current()) return;
      const result = await orchestrator.executeOperatorTool({
        name: operatorRunTool.name,
        args: { action: "node", kind: "sentinel", id: caseId, revision, node },
      }, {
        session: owner,
        targetClassification: ownerTargetClassification,
        suppressToolEvents: true,
      });
      if (!result.ok || !result.value.startsWith("{") || !current()) return;
      return JSON.parse(result.value).page?.node?.workerNarrative;
    },
    async readSentinelDiscoverySource(request) {
      if (!config.operatorRunExecutor) return;
      const owner = getSession();
      const isCurrent = () =>
        getSession().id === owner.id &&
        state.ownerSessionId === owner.id;
      const taint = () => getSessionTaint();
      if (
        !isCurrent() ||
        !canFlowTo(
          maxClassification(taint(), "INTERNAL"),
          ownerTargetClassification,
        )
      ) return;
      const {
        caseId,
        revision,
        traceKind,
        traceId,
        stepIndex,
        attempt,
        sourceCase,
        snapshotDigest,
        evidenceId,
      } = request;
      const result = await config.operatorRunExecutor({
        kind: "sentinel",
        id: caseId,
        revision,
        sourceCase,
        snapshotDigest,
        evidenceId,
        ...(traceKind === "worker"
          ? {
            action: "worker_trace_source",
            taskId: traceId,
            stepIndices: [stepIndex],
          }
          : {
            action: "planner_reads",
            plannerIdentity: traceId,
            ordinal: stepIndex + 1,
            attempt,
          }),
      }, savedToolAuthorization(owner, taint, isCurrent));
      if (!result.startsWith("{") || !isCurrent()) return;
      const outputTaint = maxClassification(taint(), "INTERNAL");
      if (!canFlowTo(outputTaint, ownerTargetClassification)) return;
      const metadata = {
        target_classification: ownerTargetClassification,
        case_id: caseId,
        evidence_revision: revision,
      };
      const decision = await config.hookRunner.evaluateHook("PRE_OUTPUT", {
        session: { ...owner, taint: outputTaint },
        input: { ...metadata, content: result },
        auditInput: metadata,
      });
      if (!decision.allowed || !isCurrent()) return;
      return JSON.parse(result).source;
    },
    sideQuestions: createSideQuestionService({
      providers: config.providerRegistry,
      messages: config.messageStore,
      isCurrentOwner: (id) => id === state.ownerSessionId,
      async context(selection) {
        const owner = state.ownerSessionId;
        const ownerSession = state.sessionStates.get(owner) ?? initialSession;
        const ownerTaint = state.activeSessionId === owner
          ? ownerGetTaint?.() ?? ownerSession.taint
          : ownerSession.taint;
        if (selection.kind === "chat") {
          return await loadCommittedSideChatContext(
            config.messageStore,
            owner,
            ownerTargetClassification,
            ownerTaint,
          );
        }
        if (selection.kind === "run") {
          if (!config.sideQuestionTracePath) return;
          const reopen = config.operatorRunExecutor;
          return loadCommittedSideRunContext(
            config.sideQuestionTracePath,
            selection,
            owner,
            ownerTargetClassification,
            ownerTaint,
            reopen && (async (ordinal, role, id) => {
              const result = await reopen(
                {
                  action: "execution_trace_payload",
                  traceRole: role,
                  id,
                  ordinal,
                },
                savedToolAuthorization(
                  ownerSession,
                  () => ownerTaint,
                  () => state.ownerSessionId === owner,
                ),
              );
              if (!result.startsWith("{")) return;
              const { step, payload } = JSON.parse(result);
              const approved = normalizeApprovedPayload(payload);
              return typeof step?.id === "string" && approved
                ? { id: step.id, payload: approved }
                : undefined;
            }),
          );
        }
        if (selection.kind === "session") {
          const target = await config.resolveSideQuestionSession?.(
            selection.id,
          );
          if (
            !target || target.id !== selection.id ||
            target.userId !== ownerSession.userId ||
            !canFlowTo(target.taint, ownerTargetClassification)
          ) return undefined;
          const result = await loadCommittedSideChatContext(
            config.messageStore,
            target.id,
            ownerTargetClassification,
            maxClassification(ownerTaint, target.taint),
          );
          return {
            ...result,
            key: [owner, "session", target.id, target.channelId],
          };
        }
        const taint = maxClassification(ownerTaint, "INTERNAL");
        if (
          !config.allowSentinelModelAccess ||
          !canFlowTo(taint, ownerTargetClassification)
        ) return;
        const { path, caseId, worker } = selection;
        const authorizedPath = () =>
          caseId === "main"
            ? snapshotPath
            : config.resolveSentinelChatCase?.(caseId);
        if (authorizedPath() !== path) return undefined;
        const readContext = () =>
          readSentinelWorkerSideContext(
            path,
            worker.revision,
            worker.taskId,
          );
        const context = readContext();
        if (!context) return;
        const {
          constraintsKey,
          referenceKey,
          runId,
          steps,
          ...committedContext
        } = context;
        const isCurrent = () => {
          if (state.ownerSessionId !== owner || authorizedPath() !== path) {
            return false;
          }
          const latest = readContext();
          return latest?.runId === runId &&
            latest.adaptiveRevision === context.adaptiveRevision &&
            latest.constraintsKey === constraintsKey &&
            latest.referenceKey === referenceKey;
        };
        const resultKeys: string[] = [];
        const approvedSteps = [];
        const authority = savedToolAuthorization(
          ownerSession,
          () => ownerTaint,
          isCurrent,
        );
        for (const { workflowReference, ...step } of steps) {
          if (step.tool !== "sentinel_live_workflow_status") {
            approvedSteps.push(step);
            continue;
          }
          if (!workflowReference || !runCaseRead) continue;
          const { index, digest } = workflowReference;
          const call = {
            action: "worker_trace_result",
            kind: "sentinel",
            id: caseId,
            revision: worker.revision,
            taskId: worker.taskId,
            stepIndices: [index],
          };
          if (!await authority.authorizeOwnerRunCall?.(call)) continue;
          const text = await runCaseRead(call, authority);
          if (!text.startsWith("{") || !isCurrent()) continue;
          const result = JSON.parse(text);
          const receipt = readSentinelGitHubWorkflowReadReceipt(
            result.result,
            worker.revision,
          );
          if (
            !receipt || result.run?.kind !== "sentinel" ||
            result.run.id !== caseId ||
            result.run.revision !== worker.revision ||
            result.runId !== runId || result.taskId !== worker.taskId ||
            result.index !== index ||
            result.result.targetId !== context.nodeId ||
            createHash("sha256").update(JSON.stringify(receipt)).digest(
                "hex",
              ) !==
              digest
          ) continue;
          resultKeys.push(`${index}:${digest}`);
          approvedSteps.push({
            ...step,
            workflow: {
              repository: receipt.repository,
              workflowId: receipt.workflowId,
              runs: receipt.runs.slice(0, 5).map(
                ({ id, status, conclusion }) => ({ id, status, conclusion }),
              ),
            },
          });
        }
        if (!isCurrent()) return;
        return {
          key: [
            owner,
            "sentinel",
            caseId,
            context.adaptiveRevision,
            worker.taskId,
            "authorized-worker-evidence",
            ...(constraintsKey ? [constraintsKey] : []),
            ...(referenceKey ? [`evidence-refs:${referenceKey}`] : []),
            ...resultKeys,
          ],
          taint,
          ceiling: ownerTargetClassification,
          context: { ...committedContext, steps: approvedSteps },
        };
      },
      async approveInput(text, taint) {
        const owner = state.sessionStates.get(state.ownerSessionId) ??
          initialSession;
        const result = await config.hookRunner.evaluateHook(
          "PRE_CONTEXT_INJECTION",
          {
            session: { ...owner, taint },
            input: { content: text, source_type: "OWNER" },
            auditInput: { source_type: "OWNER" },
          },
        );
        return result.allowed;
      },
      async approveOutput(text, taint, ceiling) {
        const owner = state.sessionStates.get(state.ownerSessionId) ??
          initialSession;
        const result = await config.hookRunner.evaluateHook("PRE_OUTPUT", {
          session: { ...owner, taint },
          input: { content: text, target_classification: ceiling },
          auditInput: { target_classification: ceiling },
        });
        return result.allowed;
      },
    }),
    sentinelSnapshotPath: snapshotPath,
    resolveSentinelChatCase: config.resolveSentinelChatCase,
    sentinelWebContainmentConfigured: config.sentinelWebContainmentConfigured,
    readSentinelOutputLanguage(path) {
      try {
        return readSentinelModelSettings(path)?.outputLanguage ??
          config.sentinelOutputLanguage;
      } catch {
        chatLog.warn("Sentinel case output language could not be read");
        return config.sentinelOutputLanguage;
      }
    },
    createSentinelAgent: snapshotPath && config.allowSentinelModelAccess
      ? (worker = false, caseSnapshotPath = snapshotPath, role) =>
        (worker ? createSentinelSubagent : createSentinelAgent)({
          snapshotPath: caseSnapshotPath,
          goalsOnly: role === "goals",
          sharedInventoryBaseDir: config.sentinelSharedInventoryBaseDir,
          webContainmentConfigured: config.sentinelWebContainmentConfigured,
          ...sentinelAssessmentModelRouting(
            config.providerRegistry,
            config.sentinelModelProfileAllowlists,
          ).interactiveOptions(
            caseSnapshotPath,
            role ?? (worker ? "worker" : "interactive"),
          ),
          hookRunner: config.hookRunner,
          operatorRunReader: operatorRunReaderForCase(caseSnapshotPath),
          allowUnleasedInteractiveTelemetry: worker,
          outputLanguage: config.sentinelOutputLanguage,
          readOutputLanguage: () =>
            readSentinelModelSettings(caseSnapshotPath)?.outputLanguage,
          onUsage(usage) {
            try {
              recordSentinelModelUsage(caseSnapshotPath, "interactive", usage);
            } catch {
              chatLog.warn("Sentinel chat model usage could not be recorded");
            }
          },
        })
      : undefined,
    async clearForSentinelMode() {
      const release = await acquireTurnMutex(state);
      try {
        session.clear();
      } finally {
        release();
      }
    },
    async executeAgentTurn(content, sendEvent, signal) {
      if (
        typeof content === "string" && /^\/conversation(?:\s|$)/.test(content)
      ) {
        const release = await acquireTurnMutex(state);
        const unavailable = () =>
          sendEvent({
            type: "error",
            message: "The named conversation is unavailable.",
          });
        let turn: ReturnType<typeof startNamedConversationTurn> | undefined;
        try {
          const selected =
            /^\/conversation ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}) ([\s\S]+)$/
              .exec(content);
          if (
            signal?.aborted || !selected || !selected[2].trim() ||
            !config.customToolsBaseDir || !config.messageStore ||
            state.activeSessionId !== state.ownerSessionId
          ) return unavailable();
          const [, id, prompt] = selected;
          const store = namedConversations(config.customToolsBaseDir);
          const isCurrent = () => {
            const record = store.read(id);
            return !!record && !record.deleted && !signal?.aborted;
          };
          const taint = maxClassification("INTERNAL", getSessionTaint());
          if (!isCurrent() || !canFlowTo(taint, ownerTargetClassification)) {
            return unavailable();
          }
          const owner = getSession();
          const conversation = restoreSession({
            id: `named-conversation-${id}` as SessionState["id"],
            userId: owner.userId,
            channelId: owner.channelId,
          });
          const child = createChatSession({
            session: { ...conversation, taint },
            getSessionTaint: () => taint,
            targetClassification: ownerTargetClassification,
            providerRegistry: config.providerRegistry,
            messageStore: config.messageStore,
            enableStreaming: false,
            hookRunner: {
              ...config.hookRunner,
              async evaluateHook(hook, context) {
                const decision = await config.hookRunner.evaluateHook(
                  hook,
                  context,
                );
                return isCurrent()
                  ? decision
                  : { ...decision, allowed: false, action: "BLOCK" };
              },
            },
          });
          turn = startNamedConversationTurn(config.customToolsBaseDir, id);
          const turnSignal = signal
            ? AbortSignal.any([signal, turn.signal])
            : turn.signal;
          await child.executeAgentTurn(prompt, (event) => {
            if (isCurrent()) sendEvent(event);
          }, turnSignal);
        } catch {
          unavailable();
        } finally {
          turn?.finish();
          release();
        }
        return;
      }

      if (
        typeof content === "string" && /^\/agent-profile(?:\s|$)/.test(content)
      ) {
        const release = await acquireTurnMutex(state);
        try {
          if (signal?.aborted) return;
          const command = /^\/agent-profile ([a-z][a-z0-9_-]{0,63})$/.exec(
            content,
          );
          const id = command?.[1];
          if (
            !agentProfiles || !id ||
            state.activeSessionId !== state.ownerSessionId
          ) {
            sendEvent({
              type: "error",
              message: "Use /agent-profile <id> or /agent-profile off.",
            });
            return;
          }
          const selected = id === "off" ? undefined : id;
          if (
            reservedAgentProfiles.has(id) ||
            !agentProfiles.selectForSession(state.ownerSessionId, selected)
          ) {
            sendEvent({
              type: "error",
              message: "The agent profile is unavailable.",
            });
            return;
          }
          sendEvent({
            type: "response",
            text: selected
              ? "Agent profile selected."
              : "Agent profile cleared.",
            taint: getSessionTaint(),
          });
        } catch {
          sendEvent({
            type: "error",
            message: "The agent profile is unavailable.",
          });
        } finally {
          release();
        }
        return;
      }
      if (
        typeof content === "string" &&
        /^\/sentinel-recheck(?:\s|$)/.test(content)
      ) {
        const args =
          /^\/sentinel-recheck ([a-zA-Z0-9_-]+) ([1-9][0-9]*) (worker-finding:[a-f0-9]{64})(?: ([0-9]+)| queue ((?:execution-evidence|native-workflow-evidence):[a-f0-9]{64}) ([a-f0-9-]{36}) ([a-f0-9]{64}) ([a-f0-9-]{36})(?: (.{1,1000}))?)?$/
            .exec(content);
        if (!args || !config.operatorRunExecutor) {
          sendEvent({
            type: "error",
            message:
              "Use /sentinel-recheck <case> <revision> <finding ID> [offset | queue <evidence ID> <run ID> <adaptive revision> <request ID> [note]].",
          });
          return;
        }
        const release = await acquireTurnMutex(state);
        state.activeSessionId = state.ownerSessionId;
        try {
          const [
            ,
            id,
            revision,
            finding,
            offset,
            node,
            runId,
            adaptiveRevision,
            requestId,
            note,
          ] = args;
          const scope = { kind: "sentinel", id, revision: Number(revision) };
          const result = await orchestrator.executeOperatorTool({
            name: operatorRunTool.name,
            args: node
              ? {
                ...scope,
                action: "assign",
                taskKind: "review_evidence",
                node,
                runId,
                adaptiveRevision,
                requestId,
                recheckFindingId: finding,
                ...(note !== undefined && { note }),
              }
              : {
                ...scope,
                action: "finding_recheck_candidates",
                receiptId: finding,
                offset: Number(offset ?? 0),
              },
          }, {
            session: getSession(),
            targetClassification: ownerTargetClassification,
            signal,
          });
          if (signal?.aborted) return;
          const command = note === undefined
            ? content
            : content.slice(0, -note.length - 1);
          if (result.ok) {
            sendEvent({
              type: "response",
              text: result.value,
              sentinelRecheckCommand: command,
              taint: getSessionTaint(),
            });
          } else {
            sendEvent({
              type: "error",
              message: result.error,
              sentinelRecheckCommand: command,
            });
          }
        } finally {
          release();
        }
        return;
      }
      const delegatedRecovery = typeof content === "string"
        ? /^\/recover-subagent(?:\s|$)/.test(content)
          ? config.runSubagentRecoveryCommand
          : /^\/recover-team(?:\s|$)/.test(content)
          ? config.runTeamRecoveryCommand
          : undefined
        : undefined;
      if (delegatedRecovery && typeof content === "string") {
        const release = await acquireTurnMutex(state);
        try {
          if (signal?.aborted) return;
          const text = await delegatedRecovery(
            content,
            getSession(),
            signal,
            ownerTargetClassification,
          );
          if (text !== undefined && !signal?.aborted) {
            sendEvent({
              type: "response",
              text,
              taint: ownerTargetClassification,
            });
          }
        } catch {
          sendEvent({ type: "error", message: "Delegated recovery failed." });
        } finally {
          release();
        }
        return;
      }
      if (typeof content === "string" && content.startsWith("/recover ")) {
        const request =
          /^\/recover (?:(--resume-paused) )?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}) ([\s\S]+)$/i
            .exec(content);
        if (!config.recoverAgentTurn || !request) {
          sendEvent({
            type: "error",
            message: config.recoverAgentTurn
              ? "Usage: /recover [--resume-paused] <execution UUID> <request>"
              : "Durable chat execution is unavailable.",
          });
          return;
        }
        await orchestrateOwnerAgentTurn(
          state,
          orchestrator,
          getSession,
          request[3],
          ownerTargetClassification,
          sendEvent,
          signal,
          {
            id: request[2].toLowerCase(),
            tracePath: config.ownerRecoveryTracePath,
            getTaint: getSessionTaint,
            run: (id, runner, options, control) => {
              const isCurrent = () =>
                !options.signal?.aborted &&
                getSession().id === options.session.id;
              return config.recoverAgentTurn!(
                id,
                runner,
                options,
                control,
                {
                  ...savedToolAuthorization(
                    options.session,
                    getSessionTaint,
                    isCurrent,
                  ),
                  authorizeCancellation: (
                    { name, args, classification, approvedRuleId },
                    poll,
                  ) =>
                    authorizeApprovedToolReconciliation(
                      orchestratorConfig,
                      options.session,
                      {
                        call: { name, args: { ...args } },
                        classification,
                        approvedRuleId,
                        ceiling: options.targetClassification,
                        isCurrent,
                      },
                      poll,
                      options.signal,
                    ),
                },
              );
            },
            ...(request[1] && { resumePaused: true }),
          },
        );
        return;
      }
      if (
        goalPath && goalMessages && typeof content === "string" &&
        (content === "/goal" || content.startsWith("/goal "))
      ) {
        const release = await acquireTurnMutex(state);
        try {
          if (signal?.aborted) return;
          const session = getSession();
          const taint = getSessionTaint();
          if (!canFlowTo(taint, ownerTargetClassification)) {
            sendEvent({ type: "error", message: "Output blocked by policy" });
            return;
          }
          let result: string;
          let failed = false;
          try {
            const owner = state.ownerSessionId;
            const current = () =>
              !signal?.aborted &&
              state.activeSessionId === owner &&
              state.ownerSessionId === owner &&
              getSession().id === session.id &&
              canFlowTo(taint, getSessionTaint()) &&
              canFlowTo(getSessionTaint(), ownerTargetClassification);
            const traceAccess = (content.startsWith("/goal scheduler ") ||
                content.startsWith("/goal delegated "))
              ? managedGoalTraceAccess(session, current)
              : undefined;
            result = await config.runManagedGoalCommand?.(
              content,
              taint,
              traceAccess,
            ) ??
              await runChatGoalCommand(
                goalPath,
                goalMessages,
                state.ownerSessionId,
                taint,
                content,
                {
                  current,
                  authorization: createSavedSourceAuthorization(
                    orchestratorConfig,
                    session,
                    signal,
                  ),
                },
              );
          } catch (error) {
            failed = true;
            result = error instanceof SyntaxError
              ? "Invalid goal registration JSON"
              : error instanceof Error
              ? error.message
              : "Goal command failed";
          }
          if (signal?.aborted || getSession().id !== session.id) return;
          const outputTaint = maxClassification(taint, getSessionTaint());
          if (!canFlowTo(outputTaint, ownerTargetClassification)) {
            sendEvent({ type: "error", message: "Output blocked by policy" });
            return;
          }
          const output = await evaluatePreOutputHook(
            {
              ...orchestratorConfig,
              isOwnerSession: undefined,
              getSessionTaint: () => outputTaint,
            },
            session,
            result,
            ownerTargetClassification,
            true,
          );
          if (signal?.aborted || getSession().id !== session.id) return;
          if (!canFlowTo(getSessionTaint(), outputTaint)) {
            sendEvent({ type: "error", message: "Output blocked by policy" });
            return;
          }
          if (!output.ok) {
            sendEvent({ type: "error", message: output.error });
            return;
          }
          sendEvent(
            failed
              ? { type: "error", message: result }
              : { type: "response", text: result, taint: outputTaint },
          );
        } catch {
          sendEvent({ type: "error", message: "Goal command failed" });
        } finally {
          release();
        }
        return;
      }
      await orchestrateOwnerAgentTurn(
        state,
        orchestrator,
        getSession,
        content,
        ownerTargetClassification,
        sendEvent,
        signal,
        undefined,
        compactionStore
          ? async (results, providerRegistry) => {
            if (
              signal?.aborted || !results.some((result) =>
                result.toolName === compactOwnerContext.name &&
                !result.blocked && result.content === ownerCompactionRequested
              )
            ) return;
            const taint = getSessionTaint();
            if (!canFlowTo(taint, ownerTargetClassification)) return;
            try {
              const checkpoint = await checkpointOwnerCompaction(
                { ...config, providerRegistry },
                getSession(),
                taint,
                compactionStore,
                { signal },
              );
              return checkpoint.replacement;
            } catch {
              chatLog.warn("Owner context could not be compacted");
            }
          }
          : undefined,
      );
    },
    registerChannel: (channelType, channelConfig) =>
      registerChannelState(
        channelStates,
        pairingService,
        channelType,
        channelConfig,
      ),
    handleChannelMessage: (msg, channelType, signal) =>
      routeChannelMessage(
        state,
        orchestrator,
        getSession,
        ownerTargetClassification,
        channelStates,
        pairingService,
        msg,
        channelType,
        signal,
        config.isOwnerTurnRef,
      ),
    clear() {
      orchestrator.clearHistory(getSession().id);
      if (config.resetSession) config.resetSession();
      // Update mutable state to track the new session ID after reset.
      // clear() is only callable when the turn mutex is idle (no active
      // tool dispatch), so no sub-agent sessions are in flight here.
      const newSessionId = getSession().id as string;
      state.ownerSessionId = newSessionId;
      state.activeSessionId = newSessionId;
      state.sessionStates.clear();
      state.sessionStates.set(newSessionId, getSession());
      if (config.broadcastChatEvent) {
        config.broadcastChatEvent({
          type: "taint_changed",
          level: "PUBLIC" as ClassificationLevel,
        });
      }
    },
    async compact(sendEvent) {
      const release = await acquireTurnMutex(state);
      try {
        if (
          state.activeSessionId !== state.ownerSessionId ||
          !canFlowTo(getSessionTaint(), ownerTargetClassification)
        ) {
          sendEvent({
            type: "error",
            message: "Chat compaction is unavailable.",
          });
          return;
        }
        await compactChatHistory(
          orchestrator,
          getSession,
          sendEvent,
          config,
          getSessionTaint,
        );
      } finally {
        release();
      }
    },
    handleTriggerPromptResponse(source, accepted, sendEvent) {
      if (!accepted) {
        chatLog.debug("Trigger prompt declined", {
          operation: "handleTriggerPromptResponse",
          source,
        });
        return Promise.resolve();
      }
      return acceptTriggerResult({
        source,
        config,
        state,
        orchestrator,
        getSession,
        ownerTargetClassification,
        sendEvent,
      });
    },
    handleSecretPromptResponse: (nonce, value) =>
      resolveSecretPrompt(pendingSecretPrompts, nonce, value),
    handleCredentialPromptResponse: (nonce, username, password) =>
      resolveCredentialPrompt(
        pendingCredentialPrompts,
        nonce,
        username,
        password,
      ),
    createTidepoolSecretPrompt: (sendEvent) =>
      buildTidepoolSecretPrompt(pendingSecretPrompts, sendEvent),
    createTidepoolCredentialPrompt: (sendEvent) =>
      buildTidepoolCredentialPrompt(pendingCredentialPrompts, sendEvent),
    createTidepoolConfirmPrompt: (sendEvent) =>
      buildTidepoolConfirmPrompt(pendingConfirmPrompts, sendEvent),
    handleConfirmPromptResponse: (nonce, approved) =>
      resolveConfirmPrompt(pendingConfirmPrompts, nonce, approved),
    getMcpStatus() {
      if (mcpStatusConnected < 0 || mcpStatusConfigured === 0) return null;
      return { connected: mcpStatusConnected, configured: mcpStatusConfigured };
    },
    setMcpStatus(connected, configured) {
      mcpStatusConnected = connected;
      mcpStatusConfigured = configured;
    },
    get providerName() {
      return providerName;
    },
    get modelName() {
      return modelName;
    },
    get workspacePath() {
      return config.getWorkspacePath?.() ?? config.workspacePath ?? "";
    },
    get sessionTaint() {
      return getSessionTaint();
    },
    toggleBumpers() {
      if (config.toggleSessionBumpers) return config.toggleSessionBumpers();
      return false;
    },
    get bumpersEnabled() {
      return config.getBumpersEnabled?.() ?? true;
    },
    loadChatHistory(): Promise<readonly ChatHistoryEntry[]> {
      if (!config.messageStore) return Promise.resolve([]);
      return loadChatHistoryEntries(config.messageStore, state.ownerSessionId);
    },
  };
  return session;
}
