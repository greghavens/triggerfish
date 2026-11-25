/**
 * ChatSessionConfig and channel registration config types.
 *
 * Contains the configuration interfaces for creating a chat session
 * and registering messaging channels. Separated from the ChatSession
 * interface for lighter imports.
 *
 * @module
 */

import type { SentinelOutputLanguage } from "../core/config_types.ts";
import type { ManagedGoalTraceAccess } from "../core/goal_completion.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { HookRunner } from "../core/policy/hooks/hooks.ts";
import type { SessionState } from "../core/types/session.ts";
import type { SecretStore } from "../core/secrets/keychain/keychain.ts";
import type { LlmProvider, LlmProviderRegistry } from "../core/types/llm.ts";
import type { PlanManager } from "../agent/plan/plan.ts";
import type { PathClassifier } from "../core/security/path_classification.ts";
import type { DomainClassifier } from "../core/types/domain.ts";
import type { ToolFloorRegistry } from "../core/security/tool_floors.ts";
import type { CompactorConfig } from "../agent/compactor/compactor.ts";
import type { ActiveSkillContext } from "../agent/orchestrator/orchestrator_types.ts";
import type { ChannelAdapter } from "../channels/types.ts";
import type { PairingService } from "../channels/pairing.ts";
import type { ToolDefinition, ToolExecutor } from "../core/types/tool.ts";
import type { TriggerStore } from "../scheduler/triggers/store.ts";
import type { MessageStore } from "../core/conversation/mod.ts";
import type { LineageStore } from "../core/session/lineage.ts";
import type { ChatEvent } from "../core/types/chat_event.ts";
import type { AgentRecoveryExecutor } from "../core/agent_recovery.ts";
import type { AuthorizeGitHubCancellationReconciliation } from "./github_cancellation_recovery.ts";
import type { OperatorRunToolExecutor } from "./operator_run_tool.ts";

/**
 * Per-channel classification config for non-owner user sessions.
 *
 * @deprecated Use ChannelRegistrationConfig instead.
 */
export type OwnerAgentRecoveryExecutor = (
  ...args: [
    ...Parameters<AgentRecoveryExecutor>,
    context?:
      & import("./operator_run_tool.ts").OperatorRunToolContext
      & {
        readonly authorizeCancellation?:
          AuthorizeGitHubCancellationReconciliation;
      },
  ]
) => ReturnType<AgentRecoveryExecutor>;

export interface ChannelClassificationConfig {
  /** Default classification ceiling for non-owner users on this channel. */
  readonly classification: ClassificationLevel;
  /** Optional per-user classification overrides keyed by platform-native ID. */
  readonly userClassifications?: Record<string, string>;
  /** Whether to respond to users not listed in userClassifications. Default: true. */
  readonly respondToUnclassified?: boolean;
}

/** Full channel registration config including adapter and access control. */
export interface ChannelRegistrationConfig {
  /** The channel adapter instance. */
  readonly adapter: ChannelAdapter;
  /** Human-readable channel name (e.g. "Signal", "Telegram"). */
  readonly channelName: string;
  /** Default classification ceiling for non-owner users on this channel. */
  readonly classification: ClassificationLevel;
  /** Optional per-user classification overrides keyed by platform-native ID. */
  readonly userClassifications?: Record<string, string>;
  /** Whether to respond to users not listed in userClassifications. Default: true. */
  readonly respondToUnclassified?: boolean;
  /** Whether pairing is required for this channel. Default: false. */
  readonly pairing?: boolean;
  /** Classification level assigned to paired users. Default: INTERNAL. */
  readonly pairingClassification?: ClassificationLevel;
  /**
   * Optional per-user rate limiting for non-owner senders.
   * When set, individual senders exceeding maxRequests/windowMs are silently dropped.
   */
  readonly nonOwnerRateLimit?: {
    readonly maxRequests: number;
    readonly windowMs?: number;
  };
}

/** Configuration for creating a ChatSession. */
export interface ChatSessionConfig {
  readonly customToolsBaseDir?: string;
  readonly sideQuestionTracePath?: string;
  readonly ownerRecoveryTracePath?: string;
  readonly resolveSideQuestionSession?: (
    id: string,
  ) => Promise<SessionState | null>;
  readonly operatorRunExecutor?: OperatorRunToolExecutor;
  readonly recoverAgentTurn?: OwnerAgentRecoveryExecutor;
  readonly runSubagentRecoveryCommand?: (
    command: string,
    parent: SessionState,
    signal?: AbortSignal,
    targetClassification?: ClassificationLevel,
  ) => Promise<string | undefined>;
  readonly runTeamRecoveryCommand?:
    ChatSessionConfig["runSubagentRecoveryCommand"];
  readonly goalCompletionPath?: string;
  readonly runManagedGoalCommand?: (
    command: string,
    ceiling: ClassificationLevel,
    traceAccess?: ManagedGoalTraceAccess,
  ) => Promise<string | undefined>;
  readonly sentinelSnapshotPath?: string;
  readonly sentinelSharedInventoryBaseDir?: string;
  readonly resolveSentinelChatCase?: (caseId: string) => string | undefined;
  readonly allowSentinelModelAccess?: boolean;
  readonly sentinelOutputLanguage?: SentinelOutputLanguage;
  readonly sentinelWebContainmentConfigured?: boolean;
  readonly hookRunner: HookRunner;
  readonly providerRegistry: LlmProviderRegistry;
  readonly spinePath?: string;
  readonly tools?: readonly ToolDefinition[];
  /** Live getter for extra tools resolved at each LLM call (e.g. MCP servers). */
  readonly getExtraTools?: () => readonly ToolDefinition[];
  /** Live getter for extra system prompt sections resolved at each LLM call (e.g. MCP servers). */
  readonly getExtraSystemPromptSections?: () =>
    | readonly string[]
    | Promise<readonly string[]>;
  readonly toolExecutor?: ToolExecutor;
  readonly systemPromptSections?: readonly string[];
  readonly compactorConfig?: Partial<CompactorConfig>;
  readonly session: SessionState;
  readonly targetClassification?: ClassificationLevel;
  /** Plan manager for plan mode state tracking. */
  readonly planManager?: PlanManager;
  /** Enable streaming responses from the LLM provider. Default: true. */
  readonly enableStreaming?: boolean;
  /** Enable verbose logging of LLM responses to stderr. */
  readonly debug?: boolean;
  /** Vision-capable LLM provider for image fallback. */
  readonly visionProvider?: LlmProvider;
  /** Tool prefix → classification level. Enforced before every tool dispatch. */
  readonly toolClassifications?: ReadonlyMap<string, ClassificationLevel>;
  /** Integration prefix → default resource classification. Used for write-down checks on integration tools. */
  readonly integrationClassifications?: ReadonlyMap<
    string,
    ClassificationLevel
  >;
  /** Read current session taint for canFlowTo checks. */
  readonly getSessionTaint?: () => ClassificationLevel;
  /** Escalate session taint after tool dispatch. */
  readonly escalateTaint?: (level: ClassificationLevel, reason: string) => void;
  /** Reset session state (taint back to PUBLIC). Called on /clear. */
  readonly resetSession?: () => void;
  /** Pairing service for verifying channel pairing codes. */
  readonly pairingService?: PairingService;
  /** Return the current owner session state (tracks taint reassignment in main.ts). */
  readonly getSession?: () => SessionState;
  /** Synchronous repo classification lookup for run_command security checks. */
  readonly classifyGitHubRepo?: (
    repoFullName: string,
  ) => ClassificationLevel | null;
  /** Path classifier for filesystem tool security checks. */
  readonly pathClassifier?: PathClassifier;
  /** Domain classifier for URL-based tool security checks. */
  readonly domainClassifier?: DomainClassifier;
  /** Tool floor registry for minimum classification enforcement. */
  readonly toolFloorRegistry?: ToolFloorRegistry;
  /** Primary model identifier (e.g. "gpt-5.2-codex") for display. */
  readonly primaryModelName?: string;
  /**
   * Secret store for resolving `{{secret:name}}` references in tool arguments.
   * Passed through to the orchestrator for substitution below the LLM layer.
   */
  readonly secretStore?: SecretStore;
  /**
   * Callback invoked when a `secret_prompt` response arrives from the browser.
   * Used by the Tidepool WebSocket handler to route browser responses to the
   * waiting `secret_save` tool executor.
   */
  readonly onSecretPromptResponse?: (
    nonce: string,
    value: string | null,
  ) => void;
  /**
   * Returns the currently active skill context for tool filtering.
   * When non-null, the LLM tool list is filtered to the skill's requiresTools.
   */
  readonly getActiveSkillContext?: () => ActiveSkillContext | null;
  /**
   * Trigger store for retrieving trigger results on prompt acceptance.
   * Required for handleTriggerPromptResponse to function.
   */
  readonly triggerStore?: TriggerStore;
  /**
   * Broadcast a chat event to all connected sockets (CLI, Tidepool).
   * Used to push trigger prompt responses to all clients.
   */
  readonly broadcastChatEvent?: (event: ChatEvent) => void;
  /** Workspace directory path for display in client banners. */
  readonly workspacePath?: string;
  /** Returns the taint-aware workspace path for shell command classification. */
  readonly getWorkspacePath?: () => string | null;
  /**
   * Mutable ref toggled by non-owner turn wrappers.
   * When false, persona context is suppressed in the system prompt.
   * Default: true (owner turns).
   */
  readonly isOwnerTurnRef?: { value: boolean };
  /** Message store for conversation persistence. */
  readonly messageStore?: MessageStore;
  /** Lineage store for automatic data provenance tracking. */
  readonly lineageStore?: LineageStore;
  /**
   * Check if bumpers would block taint escalation to the given level.
   * Returns the block message if blocked, null otherwise.
   */
  readonly checkBumpersBlock?: (level: ClassificationLevel) => string | null;
  /** Toggle session bumpers on/off. Returns the new enabled state. */
  readonly toggleSessionBumpers?: () => boolean;
  /** Read whether bumpers are currently enabled. */
  readonly getBumpersEnabled?: () => boolean;
}
