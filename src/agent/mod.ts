/**
 * Agent module — orchestrator and LLM provider abstraction.
 *
 * @module
 */

export type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmProviderRegistry,
  LlmUsage,
} from "./llm.ts";

export { createProviderRegistry } from "./llm.ts";

export type { ModelInfo } from "./models.ts";
export { getModelInfo, resolveModelInfo } from "./models.ts";

export type {
  HistoryEntry,
  Orchestrator,
  OrchestratorConfig,
  ProcessMessageOptions,
  ProcessMessageResult,
} from "./orchestrator/orchestrator.ts";

export type { CompactorConfig, CompactResult } from "./compactor/compactor.ts";

export { createOrchestrator } from "./orchestrator/orchestrator.ts";

// Provider implementations
export {
  createAnthropicProvider,
  createGoogleProvider,
  createLocalProvider,
  createOpenAiProvider,
  createOpenRouterProvider,
  createZaiProvider,
} from "./providers/mod.ts";

export type {
  AnthropicConfig,
  GoogleConfig,
  LocalConfig,
  OpenAiConfig,
  OpenRouterConfig,
  ZaiConfig,
} from "./providers/mod.ts";

export { loadProvidersFromConfig } from "./providers/config.ts";
export type {
  ModelsConfig,
  PrimaryModelRef,
  ProvidersConfig,
} from "./providers/config.ts";

// Rate limiting
export {
  createRateLimitedProvider,
  createRateLimiter,
} from "./rate_limiter/rate_limiter.ts";
export type {
  RateLimiter,
  RateLimiterConfig,
  RateLimiterSnapshot,
} from "./rate_limiter/rate_limiter.ts";

// OpenAI rate limit constants
export {
  getOpenAiLimits,
  resolveOpenAiLimits,
} from "./providers/openai_limits.ts";
export type {
  OpenAiModelLimits,
  OpenAiTier,
} from "./providers/openai_limits.ts";
export {
  GPT4O_FREE,
  GPT4O_MINI_FREE,
  GPT4O_MINI_TIER1,
  GPT4O_MINI_TIER2,
  GPT4O_MINI_TIER3,
  GPT4O_MINI_TIER4,
  GPT4O_MINI_TIER5,
  GPT4O_TIER1,
  GPT4O_TIER2,
  GPT4O_TIER3,
  GPT4O_TIER4,
  GPT4O_TIER5,
  O1_TIER1,
  O1_TIER2,
  O1_TIER3,
  O1_TIER4,
  O1_TIER5,
  O3_MINI_TIER1,
  O3_MINI_TIER2,
  O3_MINI_TIER3,
  O3_MINI_TIER4,
  O3_MINI_TIER5,
} from "./providers/openai_limits.ts";

// Plan mode
export type { PlanManager, PlanManagerOptions } from "./plan/mod.ts";

export { createPlanManager, createPlanToolExecutor } from "./plan/mod.ts";

export type {
  ActivePlan,
  AgentMode,
  ImplementationPlan,
  PlanComplexity,
  PlanModeState,
  PlanRecord,
  PlanStatus,
  PlanStep,
} from "./plan/mod.ts";

export {
  DEFAULT_PLAN_STATE,
  PLAN_ALLOWED_TOOLS,
  PLAN_BLOCKED_TOOLS,
} from "./plan/mod.ts";

export {
  buildAwaitingApprovalPrompt,
  buildPlanExecutionPrompt,
  buildPlanModePrompt,
  formatPlanAsMarkdown,
} from "./plan/mod.ts";

export {
  buildPlanToolDefinitions,
  getPlanToolDefinitions,
  PLAN_SYSTEM_PROMPT,
} from "./plan/mod.ts";

// Agent teams
export type {
  TeamDefinition,
  TeamId,
  TeamInstance,
  TeamManager,
  TeamManagerDeps,
  TeamMemberDefinition,
  TeamMemberInstance,
  TeamMemberStatus,
  TeamStatus,
  TeamToolContext,
} from "./team/mod.ts";

export {
  buildTeamRosterPrompt,
  buildTeamToolDefinitions,
  createTeamManager,
  createTeamToolExecutor,
  getTeamToolDefinitions,
  TEAM_SYSTEM_PROMPT,
} from "./team/mod.ts";
