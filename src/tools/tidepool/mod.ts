/**
 * Tide Pool / A2UI module.
 *
 * Provides the agent-driven visual workspace using the A2UI
 * (Agent-to-UI) protocol. Includes component tree definitions,
 * a WebSocket host for broadcasting trees and canvas messages to
 * clients, and agent-facing tools for canvas render/update/clear.
 *
 * Legacy HTML push/eval/reset/snapshot tools are also exported
 * for backward compatibility.
 *
 * @module
 */

// Component tree types and helper constructors
export type {
  A2UIComponent,
  ComponentTree,
  ComponentType,
} from "./components.ts";
export {
  card,
  chart,
  form,
  image,
  layout,
  markdown,
  table,
} from "./components.ts";

// Canvas protocol types
export type {
  CanvasClearMessage,
  CanvasMessage,
  CanvasRenderComponentMessage,
  CanvasRenderFileMessage,
  CanvasRenderHtmlMessage,
  CanvasUpdateMessage,
} from "./canvas_protocol.ts";
export { generateRenderId } from "./canvas_protocol.ts";

// A2UI WebSocket host
export type { A2UIHost, A2UIHostOptions } from "./host/mod.ts";
export { createA2UIHost } from "./host/mod.ts";

// Tidepool browser HTML compositor
export { buildTidepoolHtml } from "./ui.ts";

// A2UI canvas tools (Result-based)
export type { RenderFileOptions, TidePoolTools } from "./tools/mod.ts";
export { createTidePoolTools } from "./tools/mod.ts";

// Tool definitions and system prompt
export {
  buildTidepoolToolDefinitions,
  getTidepoolToolDefinitions,
  TIDEPOOL_SYSTEM_PROMPT,
} from "./tools/mod.ts";

// Executor
export { createTidepoolToolExecutor } from "./tools/mod.ts";

// Shell types
export type {
  NavBadge,
  NavBadgeState,
  NavItem,
  ScreenId,
  ScreenLifecycle,
  ShellTopic,
  TopicMessage,
  TopicOutboundMessage,
} from "./shell/mod.ts";
export {
  createEmptyBadgeState,
  DEFAULT_SCREEN,
  isValidScreen,
  isValidTopic,
  NAV_ITEMS,
  resolveMessageTopic,
  resolveScreenFromHash,
  SCREEN_IDS,
  SHELL_TOPICS,
} from "./shell/mod.ts";

// UI Components
export type {
  ChatComponentConfig,
  ChatSessionEvent,
  ChatSubscriptionRequest,
} from "./components/mod.ts";
export type { StatusDotConfig, StatusLevel } from "./components/mod.ts";
export type { TaintBadgeColors } from "./components/mod.ts";
export {
  resolveStatusLevel,
  resolveTaintBadgeClass,
  TAINT_BADGE_MAP,
} from "./components/mod.ts";

// Screen types
export type {
  AgentDetailData,
  AgentEventType,
  AgentSessionCard,
  AgentTeamCard,
  ChatScreenConfig,
  HealthCardId,
  HealthMetricCard,
  HealthSnapshot,
  HealthStatus,
  LiveMetricEvent,
  LogEntry,
  LogFilter,
  LogLevel,
  LogSubscription,
  MemoryBrowserEntry,
  MemorySearchFilter,
  MemorySearchResult,
  RunTreeNode,
  SessionGroup,
  SettingsField,
  SettingsFieldType,
  SettingsFieldValue,
  SettingsFormState,
  SettingsSection,
  WorkflowActiveRun,
  WorkflowListEntry,
  WorkflowRunTree,
  WorkflowScreenEventType,
} from "./screens/mod.ts";
export {
  createChatScreenLifecycle,
  createDefaultLogFilter,
  HEALTH_CARD_IDS,
  LOG_LEVEL_COLORS,
  LOG_LEVELS,
  resolveHealthStatusLevel,
  SETTINGS_SECTIONS,
} from "./screens/mod.ts";

// Host handlers for screens
export type {
  TidepoolAgentsHandler,
  TidepoolConfigHandler,
  TidepoolHealthHandler,
  TidepoolLogSink,
  TidepoolMemoryHandler,
  TidepoolWorkflowsHandler,
} from "./host/mod.ts";
export {
  createTidepoolAgentsHandler,
  createTidepoolHealthHandler,
  createTidepoolLogSink,
  createTidepoolMemoryHandler,
  createTidepoolWorkflowsHandler,
} from "./host/mod.ts";

// Legacy callback-based host and tools (backward compatibility)
export type { TidepoolHost, TidepoolHostOptions } from "./host/mod.ts";
export { createTidepoolHost } from "./host/mod.ts";

export type { TidepoolTools } from "./tools/mod.ts";
export { createTidepoolTools } from "./tools/mod.ts";
