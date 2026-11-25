import {
  authorizeSavedToolCalls,
  enforcePostToolResponse,
} from "../agent/dispatch/security_pipeline.ts";
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
import { createOrchestrator } from "../agent/orchestrator/orchestrator.ts";
import type { SessionState } from "../core/types/session.ts";
import {
  canFlowTo,
  type ClassificationLevel,
  maxClassification,
} from "../core/types/classification.ts";
import type {
  ChatEventSender,
  ChatSession,
  ChatSessionConfig,
} from "./chat_types.ts";
import type { ChatHistoryEntry } from "./chat_session_interface.ts";
import { loadChatHistoryEntries } from "./chat_history.ts";
import {
  createSideQuestionService,
  loadCommittedSideChatContext,
  loadCommittedSideRunContext,
} from "./side_question.ts";
import {
  operatorRunTool,
  type OperatorRunToolContext,
} from "./operator_run_tool.ts";
import {
  CHAT_GOAL_REPORT_TOOL,
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
): Promise<void> {
  sendEvent({ type: "compact_start" });
  try {
    const result = await orchestrator.compactHistory(getSession().id);

    if (config.messageStore && result.messagesAfter > 0) {
      const sessionId = getSession().id as string;
      const sessionTaint = config.getSessionTaint?.() ??
        "PUBLIC" as ClassificationLevel;
      // Mark all prior records as compacted
      await config.messageStore.markCompacted(
        sessionId,
        0,
        result.messagesBefore - 1,
      );
      await config.messageStore.append({
        session_id: sessionId,
        role: "compaction_summary",
        content:
          `[Compaction] ${result.messagesBefore} → ${result.messagesAfter} messages, ${result.tokensBefore} → ${result.tokensAfter} tokens`,
        classification: sessionTaint,
      });
    }

    sendEvent({
      type: "compact_complete",
      messagesBefore: result.messagesBefore,
      messagesAfter: result.messagesAfter,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    });
  } catch (err: unknown) {
    sendEvent({
      type: "error",
      message: `Compact failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
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
  const ownerTools = [
    ...(goalPath && goalMessages ? [CHAT_GOAL_REPORT_TOOL] : []),
    ...(config.operatorRunExecutor ? [operatorRunTool] : []),
  ];
  const enabledConfig: ChatSessionConfig = ownerTools.length
    ? {
      ...config,
      tools: [...config.tools ?? [], ...ownerTools],
      hookRunner: {
        ...config.hookRunner,
        evaluateHook(hook, context) {
          if (config.operatorRunExecutor && hook === "PRE_TOOL_CALL") {
            const call = context.input.tool_call as
              | {
                readonly name?: string;
                readonly args?: Record<string, unknown>;
              }
              | undefined;
            if (call?.name === operatorRunTool.name) {
              const action = call.args?.action;
              const meta = {
                tool_name: operatorRunTool.name,
                resource_classification: "INTERNAL",
                operation_type: typeof action === "string" &&
                    [
                      "list",
                      "profiles",
                      "inspect",
                      "graph",
                      "findings",
                      "facts",
                      "list_digests",
                      "expand_digest",
                      "node",
                      "traces",
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
                      "profiles",
                      "execution_traces",
                      "execution_trace_payload",
                      "case_execution_evidence",
                      "finding_recheck_candidates",
                      "defense_coverage",
                      "incident_alerts",
                      "case_alert",
                      "incidents",
                      "decision_history",
                      "finding_traffic",
                      "finding_traffic_candidates",
                      "traffic_search",
                      "traffic_get",
                      "traffic_blob",
                    ]
                      .includes(action)
                  ? "read"
                  : "write",
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
              input.criterion,
            )
            : Promise.resolve("Goal reporting requires the owner session.");
        }
        return config.toolExecutor?.(name, input, context) ??
          Promise.resolve(`Unknown tool: ${name}`);
      },
    }
    : config;
  const orchestratorConfig = assembleOrchestratorConfig(
    enabledConfig,
    state,
    getSessionTaint,
    escalateTaint,
  );
  function savedToolAuthorization(
    session: SessionState,
    taint: () => ClassificationLevel,
    isCurrent: () => boolean,
  ): OperatorRunToolContext {
    const policy = { ...orchestratorConfig, getSessionTaint: taint };
    return {
      ceiling: ownerTargetClassification,
      ...(config.recoverAgentTurn && { ownerRecoverySessionId: session.id }),
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
  const session: ChatSession = {
    approvalInbox: config.hookRunner.toolApprovalInbox,
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
            reopen && (async (ordinal) => {
              const result = await reopen(
                {
                  action: "execution_trace_payload",
                  traceRole: selection.role,
                  id: selection.id,
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
              if (
                typeof step?.id === "string" &&
                (payload?.kind === "github_actions_status" ||
                  payload?.kind === "github_repository_status" ||
                  payload?.kind === "github_pull_status" ||
                  payload?.kind === "github_release_status" ||
                  payload?.kind === "github_branch_protection")
              ) {
                return { id: step.id, payload };
              }
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
          providerRegistry: config.providerRegistry,
          hookRunner: config.hookRunner,
          allowModelAccess: true,
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
            run: config.recoverAgentTurn,
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
          const taint = getSessionTaint();
          const result = await config.runManagedGoalCommand?.(content) ??
            await runChatGoalCommand(
              goalPath,
              goalMessages,
              state.ownerSessionId,
              taint,
              content,
            );
          sendEvent({ type: "response", text: result, taint });
        } catch (err) {
          sendEvent({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
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
    compact: (sendEvent) =>
      compactChatHistory(orchestrator, getSession, sendEvent, config),
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
