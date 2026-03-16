/**
 * Agent orchestrator — factory and public API.
 *
 * Creates an Orchestrator instance that implements the agent loop:
 * receive messages, fire enforcement hooks, build LLM context with SPINE.md,
 * call the LLM provider, execute tool calls, and return policy-checked responses.
 *
 * Implementation is split across domain-specific modules:
 * - tool_format.ts: Tool definition conversion and call parsing
 * - access_control.ts: Tool access enforcement and executor wrapping
 * - security_context.ts: PRE_TOOL_CALL hook input assembly
 * - system_prompt.ts: SPINE.md loading and prompt assembly
 * - vision_fallback.ts: Image description for non-vision models
 * - response_handling.ts: Response quality and final response processing
 * - tool_dispatch.ts: Full tool call dispatch pipeline
 * - agent_loop.ts: Main LLM iteration cycle
 * - agent_turn.ts: Turn entry point and preconditions
 * - history_compaction.ts: Session history compaction
 *
 * @module
 */

import { createLogger } from "../../core/logger/mod.ts";
import type { LlmProvider } from "../llm.ts";
import { createCompactor } from "../compactor/compactor.ts";
import type { Compactor } from "../compactor/compactor.ts";
import type { PlanManager } from "../plan/plan.ts";
import { wrapToolExecutorWithEnforcement } from "../dispatch/access_control.ts";
import {
  buildReadMoreToolDefinition,
  ResponseCache,
} from "../dispatch/response_cap.ts";
import { orchestrateAgentTurn } from "../loop/agent_turn.ts";
import { compactSessionHistory } from "../compactor/history_compaction.ts";
import type {
  ActiveSkillContext,
  HistoryEntry,
  Orchestrator,
  OrchestratorConfig,
  OrchestratorEventCallback,
  ToolDefinition,
  ToolExecutor,
} from "./orchestrator_types.ts";

// Re-export full public API from types module for backward compatibility
export type {
  ActiveSkillContext,
  ClassificationMapConfig,
  HistoryEntry,
  Orchestrator,
  OrchestratorConfig,
  OrchestratorEvent,
  OrchestratorEventCallback,
  ParsedToolCall,
  ProcessMessageOptions,
  ProcessMessageResult,
  ToolDefinition,
  ToolExecutor,
} from "./orchestrator_types.ts";

export {
  DEFAULT_SYSTEM_PROMPT,
  LEAKED_INTENT_PATTERN,
  mapToolPrefixClassifications,
  MAX_TOOL_ITERATIONS,
  SOFT_LIMIT_ITERATIONS,
} from "./orchestrator_types.ts";

// ─── Shared internal types ───────────────────────────────────────────────────

/** Mutable per-iteration token accumulator. */
export interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
}

/** Shared orchestrator state passed to extracted helpers. */
export interface OrchestratorState {
  readonly config: OrchestratorConfig;
  readonly baseTools: readonly ToolDefinition[];
  readonly getExtraTools: (() => readonly ToolDefinition[]) | undefined;
  readonly getExtraSystemPromptSections:
    | (() => readonly string[] | Promise<readonly string[]>)
    | undefined;
  readonly baseSystemPromptSections: readonly string[];
  readonly planManager: PlanManager | undefined;
  readonly visionProvider: LlmProvider | undefined;
  readonly emit: OrchestratorEventCallback;
  readonly debug: boolean;
  readonly orchLog: ReturnType<typeof createLogger>;
  readonly compactor: Compactor;
  readonly histories: Map<string, HistoryEntry[]>;
  readonly toolExecutor: ToolExecutor | undefined;
  /** Returns the currently active skill context for tool filtering. */
  readonly getActiveSkillContext: (() => ActiveSkillContext | null) | undefined;
  /** Per-session cache for truncated tool responses (read_more pagination). */
  readonly responseCache: ResponseCache;
}

// ─── Orchestrator factory ────────────────────────────────────────────────────

/**
 * Create the compactor with the default provider's context window as the
 * initial budget. The budget is updated dynamically per-session based on
 * the provider selected for that session's taint level, so the initial
 * value here is a reasonable starting point rather than a global minimum.
 */
function initializeCompactor(config: OrchestratorConfig): Compactor {
  const defaultProvider = config.providerRegistry.getDefault();
  const defaultWindow = defaultProvider?.contextWindow;
  const effectiveBudget = config.compactorConfig?.contextBudget ??
    defaultWindow ?? 100_000;
  return createCompactor({
    ...config.compactorConfig,
    contextBudget: effectiveBudget,
  });
}

/** Build the shared orchestrator state from config. */
function buildOrchestratorState(
  config: OrchestratorConfig,
  compactor: Compactor,
  histories: Map<string, HistoryEntry[]>,
): OrchestratorState {
  const responseCache = new ResponseCache();
  const readMoreTool = buildReadMoreToolDefinition();
  return {
    config,
    baseTools: [...(config.tools ?? []), readMoreTool],
    getExtraTools: config.getExtraTools,
    getExtraSystemPromptSections: config.getExtraSystemPromptSections,
    baseSystemPromptSections: config.systemPromptSections ?? [],
    planManager: config.planManager,
    visionProvider: config.visionProvider,
    emit: config.onEvent ?? (() => {}),
    debug: config.debug ?? false,
    orchLog: createLogger("orchestrator"),
    compactor,
    histories,
    toolExecutor: config.toolExecutor
      ? wrapToolExecutorWithEnforcement(config.toolExecutor, config)
      : undefined,
    getActiveSkillContext: config.getActiveSkillContext,
    responseCache,
  };
}

/**
 * Create an agent orchestrator.
 *
 * The orchestrator implements the agent loop:
 * 1. Receive message from channel
 * 2. Fire PRE_CONTEXT_INJECTION hook
 * 3. Build LLM context with SPINE.md as system prompt
 * 4. Send to LLM provider with native tool definitions
 * 5. Parse native tool calls from provider response
 * 6. If tool calls found: execute each, append results, call LLM again
 * 7. Repeat until no more tool calls (or max iterations)
 * 8. Fire PRE_OUTPUT on final text response
 * 9. Return response
 *
 * @param config - Orchestrator configuration
 * @returns An Orchestrator instance
 */
export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  const histories = new Map<string, HistoryEntry[]>();
  const compactor = initializeCompactor(config);
  const state = buildOrchestratorState(config, compactor, histories);

  return {
    executeAgentTurn: (options) => orchestrateAgentTurn(state, options),
    getHistory: (id) => histories.get(id as string) ?? [],
    clearHistory: (id) => histories.delete(id as string),
    compactHistory: (id) => {
      const taint = config.getSessionTaint?.() ?? "PUBLIC";
      return compactSessionHistory(
        id,
        histories,
        config.providerRegistry,
        compactor,
        taint,
      );
    },
  };
}
