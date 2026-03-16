/**
 * Core types module — classification levels, session state, and taint management.
 *
 * @module
 */

export type { ClassificationLevel, Result } from "./classification.ts";

export {
  canFlowTo,
  CLASSIFICATION_ORDER,
  compareClassification,
  maxClassification,
  minClassification,
  parseClassification,
} from "./classification.ts";

export type {
  ChannelId,
  CreateSessionOptions,
  SessionId,
  SessionState,
  TaintEvent,
  UserId,
} from "./session.ts";

export {
  canOutput,
  createSession,
  escalateTaint,
  OWNER_MEMORY_AGENT_ID,
  resetSession,
  updateTaint,
} from "./session.ts";

export type { ToolDefinition, ToolExecutor } from "./tool.ts";

export type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmProviderRegistry,
  LlmStreamChunk,
  LlmUsage,
} from "./llm.ts";

export type { DomainClassificationResult, DomainClassifier } from "./domain.ts";

export type {
  CompactResult,
  HistoryEntry,
  Orchestrator,
  ProcessMessageOptions,
  ProcessMessageResult,
} from "./orchestrator.ts";

export type {
  DeliverOptions,
  DeliveryChannel,
  Notification,
  NotificationPriority,
  NotificationService,
} from "./notification.ts";

export type {
  ChatClientMessage,
  ChatEvent,
  ChatEventSender,
} from "./chat_event.ts";

export type {
  DiscoveredSkill,
  ReefRegistry,
  ReefSearchOptions,
  ReefSkillListing,
  SkillLoader,
  SkillSource,
} from "./skills.ts";

export type {
  HealingEventType,
  HealingNotifyEvent,
  HealingPhase,
  InterventionCategory,
  PauseOnIntervention,
  PauseTimeoutPolicy,
  SelfHealingConfig,
  SoftSignalConfig,
  WorkflowHealth,
} from "./healing.ts";
