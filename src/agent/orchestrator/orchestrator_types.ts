/**
 * Orchestrator types, events, and classification map builder.
 *
 * Defines the public API surface for the agent orchestrator:
 * tool definitions, config, events, and the prefix-to-classification
 * mapping used for integration security enforcement.
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
import type { LlmProviderRegistry, LlmProvider } from "../llm.ts";
import type { CompactorConfig } from "../compactor/compactor.ts";
import type { PlanManager } from "../plan/plan.ts";

/** Default system prompt used when no SPINE.md is found. */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant powered by Triggerfish. " +
  "Follow the user's instructions and respond clearly and concisely.";

/** Maximum tool call iterations to prevent infinite loops. */
export const MAX_TOOL_ITERATIONS = 25;

/** Iteration at which the LLM is warned to wrap up. */
export const SOFT_LIMIT_ITERATIONS = 20;

/**
 * Pattern detecting leaked tool-intent narration in LLM responses.
 * Matches phrases like "I'll search", "Let me fetch", "I need to look up", etc.
 * Used as a defense-in-depth guard — the primary fix is prompt hardening.
 */
export const LEAKED_INTENT_PATTERN =
  /\b(?:(?:I(?:'ll| will| need to| should| can| am going to)\s+(?:search|fetch|look up|find|check|browse|retrieve|use web_))|(?:(?:Let|let) me (?:search|fetch|look|find|check|browse|retrieve|use))|(?:(?:We|I) need to (?:fetch|search|look up|find|check|browse|retrieve)))/i;

export type { ToolDefinition, ToolExecutor } from "../../core/types/tool.ts";

/**
 * Structural snapshot of an active skill's capability declarations.
 *
 * Defined here (not in tools/) to avoid layer violations per dependency-layers.md.
 * Satisfied by Skill from src/tools/skills/loader.ts at the gateway wiring layer.
 */
export interface ActiveSkillContext {
  readonly name: string;
  /**
   * Tools the skill declared it needs.
   * null = not declared (unrestricted). [] = declared empty (no tool access).
   */
  readonly requiresTools: readonly string[] | null;
  /**
   * Network domains the skill declared it needs.
   * null = not declared (unrestricted). [] = declared empty (no network access).
   */
  readonly networkDomains: readonly string[] | null;
  readonly classificationCeiling: ClassificationLevel;
}

/** Configuration for creating an orchestrator. */
export interface OrchestratorConfig {
  readonly hookRunner: HookRunner;
  readonly providerRegistry: LlmProviderRegistry;
  readonly spinePath?: string;
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
  readonly getExtraSystemPromptSections?: () => readonly string[];
  /** Callback to execute tool calls. */
  readonly toolExecutor?: ToolExecutor;
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
  /** Plan manager for plan mode state tracking and tool execution. */
  readonly planManager?: PlanManager;
  /** Enable streaming responses from the LLM provider. Default: true. */
  readonly enableStreaming?: boolean;
  /** Enable verbose logging of LLM responses and tool calls to stderr. */
  readonly debug?: boolean;
  /** Vision-capable LLM provider for describing images when the primary model lacks vision. */
  readonly visionProvider?: LlmProvider;
  /** Tool prefix → classification level. Enforced before every tool dispatch. */
  readonly toolClassifications?: ReadonlyMap<string, ClassificationLevel>;
  /** Read current session taint for canFlowTo checks. */
  readonly getSessionTaint?: () => ClassificationLevel;
  /** Escalate session taint after tool dispatch (upward only via maxClassification). */
  readonly escalateTaint?: (level: ClassificationLevel, reason: string) => void;
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
   * null = no explicit classification → all tools blocked.
   * Non-null = tools classified at or below this level are allowed.
   */
  readonly getNonOwnerCeiling?: () => ClassificationLevel | null;
  /** Path classifier for filesystem tool security checks. */
  readonly pathClassifier?: PathClassifier;
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
}

/** Config shape for building integration/plugin/channel classification map. */
export interface ClassificationMapConfig {
  /** Google Workspace classification. */
  readonly google?: { readonly classification?: string };
  /** GitHub integration classification. */
  readonly github?: { readonly classification?: string };
  /** Plugins keyed by name — each with enabled + classification. */
  readonly plugins?: Readonly<Record<string, { readonly enabled?: boolean; readonly classification?: string } | undefined>>;
}

/**
 * Hardcoded classification levels for built-in tools.
 *
 * Entries are ordered from most-specific to least-specific so that
 * the prefix-matching loop in enforceNonOwnerToolCeiling hits the
 * right entry first. More-specific names (e.g. "memory_save") must
 * appear before group prefixes (e.g. "memory_").
 *
 * PUBLIC    — safe for any non-owner with a PUBLIC ceiling
 * INTERNAL  — read-only local operations, trusted non-owners
 * RESTRICTED — owner-only operations, never reachable by non-owners
 */
const BUILTIN_TOOL_CLASSIFICATIONS: ReadonlyArray<readonly [string, ClassificationLevel]> = [
  // Memory — specific names before group prefix
  ["memory_save", "RESTRICTED"],
  ["memory_delete", "RESTRICTED"],
  ["memory_search", "PUBLIC"],
  ["memory_get", "PUBLIC"],
  ["memory_list", "PUBLIC"],
  // Filesystem — writes/exec owner-only, reads INTERNAL
  ["write_file", "RESTRICTED"],
  ["edit_file", "RESTRICTED"],
  ["run_command", "RESTRICTED"],
  ["read_file", "INTERNAL"],
  ["list_directory", "INTERNAL"],
  ["search_files", "INTERNAL"],
  // Browser — owner-only
  ["browser_", "RESTRICTED"],
  // Secrets — owner-only
  ["secret_", "RESTRICTED"],
  // Scheduling — owner-only
  ["cron_", "RESTRICTED"],
  ["trigger_", "RESTRICTED"],
  // Skills — INTERNAL (read_skill is read-only)
  ["read_skill", "INTERNAL"],
  // Subagent / agents — owner-only
  ["subagent", "RESTRICTED"],
  ["agents_", "RESTRICTED"],
  // Claude sessions — owner-only
  ["claude_", "RESTRICTED"],
  // Session management — owner-only
  ["sessions_", "RESTRICTED"],
  ["session_", "RESTRICTED"],
  ["message", "RESTRICTED"],
  ["signal_", "RESTRICTED"],
  ["channels_", "PUBLIC"],
  // Plan mode — owner-only
  ["plan_", "RESTRICTED"],
  // Tidepool canvas — owner-only
  ["tidepool_", "RESTRICTED"],
  // Obsidian — reads PUBLIC, writes RESTRICTED
  ["obsidian_write", "RESTRICTED"],
  ["obsidian_daily", "RESTRICTED"],
  ["obsidian_read", "INTERNAL"],
  ["obsidian_search", "INTERNAL"],
  ["obsidian_list", "INTERNAL"],
  ["obsidian_links", "INTERNAL"],
  // Safe for non-owners
  ["web_", "PUBLIC"],
  ["todo_", "PUBLIC"],
  ["healthcheck", "PUBLIC"],
  ["summarize", "PUBLIC"],
  ["image_", "INTERNAL"],
  ["explore", "INTERNAL"],
  ["llm_task", "INTERNAL"],
  ["log_read", "INTERNAL"],
];

/**
 * Build tool prefix → classification map for integrations, plugins, channels,
 * and built-in tools.
 *
 * Integration-specific overrides (Google, GitHub, plugins) are inserted first.
 * Built-in tool classifications are appended afterward so that explicit
 * integration config always takes precedence.
 */
export function mapToolPrefixClassifications(config: ClassificationMapConfig): Map<string, ClassificationLevel> {
  const m = new Map<string, ClassificationLevel>();

  // Google Workspace — gmail_, calendar_, drive_, sheets_, tasks_
  const googleClassification = (config.google?.classification ?? "PUBLIC") as ClassificationLevel;
  for (const prefix of ["gmail_", "calendar_", "drive_", "sheets_", "tasks_"]) {
    m.set(prefix, googleClassification);
  }

  // GitHub — all tools start with github_
  m.set("github_", (config.github?.classification ?? "PUBLIC") as ClassificationLevel);

  // Plugins — each plugin's tools use {pluginName}_ prefix convention
  if (config.plugins) {
    for (const [name, pluginConfig] of Object.entries(config.plugins)) {
      const cfg = pluginConfig as { enabled?: boolean; classification?: string } | undefined;
      if (cfg?.enabled) {
        m.set(`${name}_`, (cfg.classification ?? "INTERNAL") as ClassificationLevel);
      }
    }
  }

  // Built-in tool classifications (not user-configurable)
  for (const [prefix, level] of BUILTIN_TOOL_CLASSIFICATIONS) {
    if (!m.has(prefix)) m.set(prefix, level);
  }

  return m;
}

export type {
  Orchestrator,
  ProcessMessageOptions,
  ProcessMessageResult,
  HistoryEntry,
  CompactResult,
} from "../../core/types/orchestrator.ts";

/** Events emitted by the orchestrator during message processing. */
export type OrchestratorEvent =
  | { readonly type: "llm_start"; readonly iteration: number; readonly maxIterations: number }
  | {
    readonly type: "llm_complete";
    readonly iteration: number;
    readonly hasToolCalls: boolean;
  }
  | {
    readonly type: "tool_call";
    readonly name: string;
    readonly args: Record<string, unknown>;
  }
  | {
    readonly type: "tool_result";
    readonly name: string;
    readonly result: string;
    readonly blocked: boolean;
  }
  | { readonly type: "response"; readonly text: string }
  | { readonly type: "response_chunk"; readonly text: string; readonly done: boolean }
  | { readonly type: "vision_start"; readonly imageCount: number }
  | { readonly type: "vision_complete"; readonly imageCount: number };

/** Callback for real-time orchestrator event reporting. */
export type OrchestratorEventCallback = (event: OrchestratorEvent) => void;

/** A parsed tool call from LLM text output. */
export interface ParsedToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}
