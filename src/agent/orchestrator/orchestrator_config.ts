/**
 * Orchestrator configuration types and constants.
 *
 * Defines the OrchestratorConfig interface and associated constants
 * that control the agent orchestrator's behavior: tool definitions,
 * provider selection, security hooks, classification, and streaming.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { ToolDefinition, ToolExecutor } from "../../core/types/tool.ts";
import type { SecretStore } from "../../core/secrets/keychain/keychain.ts";
import type { PathClassifier } from "../../core/security/path_classification.ts";
import type { ToolFloorRegistry } from "../../core/security/tool_floors.ts";
import type { DomainClassifier } from "../../core/types/domain.ts";
import type { HookRunner } from "../../core/policy/hooks/hooks.ts";
import type { LlmProvider, LlmProviderRegistry } from "../llm.ts";
import type { CompactorConfig } from "../compactor/compactor.ts";
import type { PlanManager } from "../plan/plan.ts";
import type { MessageStore } from "../../core/conversation/mod.ts";
import type { LineageStore } from "../../core/session/lineage.ts";
import type { OrchestratorEventCallback } from "./orchestrator_events.ts";
import type { ActiveSkillContext } from "./orchestrator_events.ts";

/** Default system prompt used when no SPINE.md is found. */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant powered by Triggerfish. " +
  "Follow the user's instructions and respond clearly and concisely.";

/** Maximum tool call iterations to prevent infinite loops. */
export const MAX_TOOL_ITERATIONS = 25;

/** Iteration at which the LLM is warned to wrap up. */
export const SOFT_LIMIT_ITERATIONS = 20;

/** Configuration for creating an orchestrator. */
export interface OrchestratorConfig {
  readonly hookRunner: HookRunner;
  readonly providerRegistry: LlmProviderRegistry;
  readonly spinePath?: string;
  /**
   * Maximum tool call iterations before stopping the agent loop.
   * Defaults to MAX_TOOL_ITERATIONS (25) when not set.
   * Use lower values for short-lived sessions like explore subagents.
   */
  readonly maxIterations?: number;
  /** Preserve short JSON objects for callers that consume structured output. */
  readonly allowJsonResponse?: boolean;
  /** Tool definitions available to the agent. */
  readonly tools?: readonly ToolDefinition[];
  /**
   * Live getter for additional tool definitions resolved at each LLM call.
   * Used for dynamically-connected sources such as MCP servers.
   */
  readonly getExtraTools?: () => readonly ToolDefinition[];
  /**
   * Live getter for additional system prompt sections resolved at each LLM call.
   * Used for dynamically-connected sources such as MCP servers.
   */
  readonly getExtraSystemPromptSections?: () =>
    | readonly string[]
    | Promise<readonly string[]>;
  /** Callback to execute tool calls. */
  readonly toolExecutor?: ToolExecutor;
  /** Observe a dispatched result only after the response policy allows it. */
  readonly onAuthorizedToolResponse?: (
    name: string,
    args: Record<string, unknown>,
    resultText: string,
  ) => void;
  /** Event callback for real-time progress reporting. */
  readonly onEvent?: OrchestratorEventCallback;
  /** Configuration for conversation compactor. */
  readonly compactorConfig?: Partial<CompactorConfig>;
  /**
   * Additional system prompt sections injected by the platform.
   * Appended AFTER SPINE.md and tool definitions. SPINE.md remains
   * the foundation — these sections layer platform behaviour on top.
   */
  readonly systemPromptSections?: readonly string[];
  /**
   * Maximum character budget for tool responses.
   * Overrides the global default (12,000) for tools without per-tool overrides.
   * Use lower values for background/trigger sessions to reduce token usage.
   */
  readonly maxToolResponseChars?: number;
  /** Plan manager for plan mode state tracking and tool execution. */
  readonly planManager?: PlanManager;
  /** Enable streaming responses from the LLM provider. Default: true. */
  readonly enableStreaming?: boolean;
  /** Enable verbose logging of LLM responses and tool calls to stderr. */
  readonly debug?: boolean;
  /** Vision-capable LLM provider for describing images when the primary model lacks vision. */
  readonly visionProvider?: LlmProvider;
  /** Tool prefix -> classification level. Enforced before every tool dispatch. */
  readonly toolClassifications?: ReadonlyMap<string, ClassificationLevel>;
  /** Integration prefix -> default resource classification. Used for write-down checks on integration tools. */
  readonly integrationClassifications?: ReadonlyMap<
    string,
    ClassificationLevel
  >;
  /** Read current session taint for canFlowTo checks. */
  readonly getSessionTaint?: () => ClassificationLevel;
  /** Escalate session taint after tool dispatch (upward only via maxClassification). */
  readonly escalateTaint?: (
    level: ClassificationLevel,
    reason: string,
  ) => void;
  /** Whether the active session belongs to the owner. */
  readonly isOwnerSession?: () => boolean;
  /**
   * Whether the active session is a trigger session.
   * Trigger sessions are not owner sessions but may call all built-in tools
   * and integration tools classified at or below their ceiling.
   * Undefined is always false — must be explicitly set to enable trigger behaviour.
   */
  readonly isTriggerSession?: () => boolean;
  /**
   * Classification ceiling for the active non-owner session.
   * null = no explicit classification -> all tools blocked.
   * Non-null = tools classified at or below this level are allowed.
   */
  readonly getNonOwnerCeiling?: () => ClassificationLevel | null;
  /** Synchronous repo classification lookup for run_command security checks. */
  readonly classifyGitHubRepo?: (
    repoFullName: string,
  ) => ClassificationLevel | null;
  /** Path classifier for filesystem tool security checks. */
  readonly pathClassifier?: PathClassifier;
  /** Returns the workspace root path for shell command classification. */
  readonly getWorkspacePath?: () => string | null;
  /** Domain classifier for URL-based tool security checks. Uses same infrastructure as pathClassifier. */
  readonly domainClassifier?: DomainClassifier;
  /** Tool floor registry for minimum classification enforcement. */
  readonly toolFloorRegistry?: ToolFloorRegistry;
  /**
   * Secret store for resolving `{{secret:name}}` references in tool arguments.
   * When provided, all tool input arguments are scanned and references substituted
   * before dispatch. The resolved values are never logged or returned to the LLM.
   */
  readonly secretStore?: SecretStore;
  /**
   * Returns the currently active skill context, or null if none.
   * When non-null and requiresTools is non-null, the tool list shown to
   * the LLM is filtered to the declared set (always preserving read_skill).
   */
  readonly getActiveSkillContext?: () => ActiveSkillContext | null;
  /**
   * Optional per-call tool list filter.
   *
   * Called once per LLM iteration after merging base tools with extra tools.
   * Use to restrict non-owner sessions to a safe tool subset.
   * The isOwner argument reflects the current session's owner status.
   */
  readonly filterTools?: (
    tools: readonly ToolDefinition[],
    isOwner: boolean,
  ) => readonly ToolDefinition[];
  /**
   * Message store for persisting conversation records.
   * When absent, conversation persistence is disabled (backward compatible).
   */
  readonly messageStore?: MessageStore;
  /**
   * Lineage store for automatic data provenance tracking.
   * When absent, lineage recording is disabled (backward compatible).
   */
  readonly lineageStore?: LineageStore;
  /**
   * Check if bumpers would block taint escalation to the given level.
   * Returns the block message if blocked, null otherwise.
   */
  readonly checkBumpersBlock?: (level: ClassificationLevel) => string | null;
}
