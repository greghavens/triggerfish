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
} from "./sentinel_agent.ts";
import {
  readSentinelModelSettings,
  readSentinelWorkerSideContext,
  recordSentinelModelUsage,
} from "./sentinel_adaptive_runtime.ts";
import { createLogger } from "../core/logger/mod.ts";
import { normalizeApprovedPayload } from "../core/execution_traces.ts";
import { createOrchestrator } from "../agent/orchestrator/orchestrator.ts";
import type { SessionState } from "../core/types/session.ts";
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
import { readSentinelAssessment } from "../sentinel/assessment_store.ts";
import { isSentinelCaseId } from "../sentinel/cases.ts";
import { loadChatHistoryEntries } from "./chat_history.ts";
import {
  createSideQuestionService,
  loadCommittedSideChatContext,
  loadCommittedSideRunContext,
} from "./side_question.ts";
import {
  operatorRunTool,
  type OperatorRunToolContext,
  sentinelOperatorCaseConstraintActions,
  sentinelOperatorCaseConstraintParameters,
  sentinelOperatorCaseReadActions,
  sentinelOperatorCaseReadParameters,
} from "./operator_run_tool.ts";
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
              const selectedRouteClass = typeof action === "string" &&
                  [
                    "live_model_route",
                    "set_live_model_route",
                    "reset_live_model_route",
                  ].includes(action) &&
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
                      "inspect",
                      "graph",
                      "findings",
                      "discovery_proposals",
                      "facts",
                      "list_digests",
                      "expand_digest",
                      "node",
                      "traces",
                      "tasks",
                      "worker_limit",
                      "assessment_concurrency",
                      "live_model_route",
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
                      "archive_history",
                      "approval_history",
                      "profiles",
                      "execution_traces",
                      "execution_trace_payload",
                      "case_execution_evidence",
                      "finding_recheck_candidates",
                      "finding_recheck_sources",
                      "defense_coverage",
                      "incident_alerts",
                      "case_alert",
                      "incidents",
                      "decision_history",
                      "finding_receipt",
                      "finding_receipts",
                      "finding_report",
                      "finding_report_history",
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
                ...((action === "narrow_constraints" ||
                  action === "constraints") && {
                  case_id: typeof call.args?.id === "string" &&
                      isSentinelCaseId(call.args.id)
                    ? call.args.id
                    : null,
                  evidence_revision: typeof call.args?.revision === "number" &&
                      Number.isSafeInteger(call.args.revision) &&
                      call.args.revision > 0
                    ? call.args.revision
                    : null,
                }),
              };
              return config.hookRunner.evaluateHook(hook, {
                ...context,
                input: { ...context.input, ...meta },
                auditInput: { ...context.auditInput, ...meta },
              });
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
        if (customTools && name === customToolManage.name) {
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
        if (customTools && isCustomToolName(name) && !existingTool(name)) {
          const binding =
            owner && permitsDiagnostics && !Object.keys(input).length
              ? customTools.read(name)
              : undefined;
          if (!binding) {
            return Promise.resolve(
              "Error: The custom tool binding is unavailable.",
            );
          }
          return orchestrator.executeOperatorTool({
            name: "healthcheck",
            args: { components: [binding.component] },
          }, {
            session: getSession(),
            targetClassification: ownerTargetClassification,
            suppressToolEvents: true,
          }).then((result) => result.ok
            ? result.value
            : "Error: The underlying operation is blocked."
          );
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
  const orchestrator = createOrchestrator({
    ...orchestratorConfig,
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
          "Read saved Sentinel evidence. In the selected active case, inspect restrictions or propose additional task-kind restrictions for operator review.",
        parameters: {
          ...Object.fromEntries(
            [
              ...sentinelOperatorCaseReadParameters,
              ...sentinelOperatorCaseConstraintParameters,
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
              ...sentinelOperatorCaseConstraintActions,
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
      async execute(args: Record<string, unknown>, signal: AbortSignal) {
        const { action, kind, id, revision, runId } = args;
        const constraintAction = sentinelOperatorCaseConstraintActions.some((
          allowed,
        ) => allowed === action);
        const unavailable =
          "Error: The selected Sentinel case revision is unavailable.";
        if (
          kind !== "sentinel" || typeof action !== "string" ||
          (!constraintAction &&
            !sentinelOperatorCaseReadActions.some((allowed) =>
              allowed === action
            )) ||
          typeof id !== "string" ||
          typeof revision !== "number" || !Number.isSafeInteger(revision) ||
          revision < 1 ||
          Object.keys(args).some((key) =>
            !sentinelOperatorCaseReadParameters.some((allowed) =>
              allowed === key
            ) &&
            (!constraintAction ||
              !sentinelOperatorCaseConstraintParameters.some((allowed) =>
                allowed === key
              ))
          )
        ) return unavailable;
        const owner = state.sessionStates.get(state.ownerSessionId);
        if (!owner) return unavailable;
        const current = () => {
          if (
            signal.aborted ||
            state.activeSessionId !== state.ownerSessionId ||
            state.sessionStates.get(state.ownerSessionId) !== owner
          ) return false;
          const casePath = id === "main"
            ? snapshotPath
            : config.resolveSentinelChatCase?.(id);
          if (!constraintAction) return !!casePath;
          if (casePath !== selectedPath) return false;
          const assessment = readSentinelAssessment(selectedPath);
          return assessment?.active === true &&
            assessment.revision === revision &&
            assessment.plan.runId === runId;
        };
        if (!current()) return unavailable;
        const authority = savedToolAuthorization(
          owner,
          () => "INTERNAL",
          current,
        );
        if (
          constraintAction && !await authority.authorizeOwnerRunCall?.(args)
        ) return unavailable;
        const result = await execute(args, {
          ...authority,
          ...(constraintAction &&
            { authorizeSentinelConstraintNarrowing: current }),
          authorizeSentinelCaseRead: (caseId, evidenceRevision) =>
            caseId === id && evidenceRevision === revision && current(),
        });
        return current() ? result : unavailable;
      },
    };
  }
  const session: ChatSession = {
    approvalInbox: config.hookRunner.toolApprovalInbox,
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
        if (!config.allowSentinelModelAccess) return undefined;
        const { path, caseId, worker } = selection;
        const authorizedPath = caseId === "main"
          ? snapshotPath
          : config.resolveSentinelChatCase?.(caseId);
        if (authorizedPath !== path) return undefined;
        const context = readSentinelWorkerSideContext(
          path,
          worker.revision,
          worker.taskId,
        );
        return context && {
          key: [
            owner,
            "sentinel",
            caseId,
            context.adaptiveRevision,
            worker.taskId,
          ],
          taint: maxClassification(ownerTaint, "INTERNAL"),
          ceiling: ownerTargetClassification,
          context,
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
      ? (worker = false, caseSnapshotPath = snapshotPath) =>
        (worker ? createSentinelSubagent : createSentinelAgent)({
          snapshotPath: caseSnapshotPath,
          sharedInventoryBaseDir: config.sentinelSharedInventoryBaseDir,
          webContainmentConfigured: config.sentinelWebContainmentConfigured,
          ...sentinelAssessmentModelRouting(
            config.providerRegistry,
            config.sentinelModelProfileAllowlists,
          ).interactiveOptions(
            caseSnapshotPath,
            worker ? "worker" : "interactive",
          ),
          hookRunner: config.hookRunner,
          ...(!worker &&
            { operatorRunReader: operatorRunReaderForCase(caseSnapshotPath) }),
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
        typeof content === "string" &&
        /^\/sentinel-recheck(?:\s|$)/.test(content)
      ) {
        const args =
          /^\/sentinel-recheck ([a-zA-Z0-9_-]+) ([1-9][0-9]*) (worker-finding:[a-f0-9]{64})(?: ([0-9]+)| queue ((?:execution-evidence|native-workflow-evidence):[a-f0-9]{64}) ([a-f0-9-]{36}) ([a-f0-9]{64}) ([a-f0-9-]{36}))?$/
            .exec(content);
        if (!args || !config.operatorRunExecutor) {
          sendEvent({
            type: "error",
            message:
              "Use /sentinel-recheck <case> <revision> <finding ID> [offset | queue <evidence ID> <run ID> <adaptive revision> <request ID>].",
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
          if (result.ok) {
            sendEvent({
              type: "response",
              text: result.value,
              sentinelRecheckCommand: content,
              taint: getSessionTaint(),
            });
          } else {
            sendEvent({
              type: "error",
              message: result.error,
              sentinelRecheckCommand: content,
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
