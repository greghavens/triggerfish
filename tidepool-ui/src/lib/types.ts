/** Classification levels mirroring server-side types. */
export type ClassificationLevel =
  | "PUBLIC"
  | "INTERNAL"
  | "CONFIDENTIAL"
  | "RESTRICTED";

/** Screen identifiers matching server-side ScreenId. */
export type ScreenId =
  | "chat"
  | "agents"
  | "sentinel"
  | "workflows"
  | "health"
  | "settings"
  | "logs"
  | "memory";

/** WebSocket connection state. */
export type ConnectionState = "connected" | "connecting" | "disconnected";

/** Status dot color. */
export type StatusColor = "green" | "yellow" | "red" | "gray";

/** Health overall status. */
export type HealthStatus = "HEALTHY" | "WARNING" | "CRITICAL";

/** Time-series data point. */
export interface TimeSeriesPoint {
  t: string;
  v: number;
}

/** Named time-series for charts. */
export interface TimeSeries {
  id: string;
  label: string;
  points: TimeSeriesPoint[];
}

/** Log level. */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** Chat message role. */
export type MessageRole = "user" | "assistant" | "error";

/** Tool call state. */
export type ToolState = "running" | "done" | "error";

/** Map status strings to colors. */
export function statusToColor(status: string): StatusColor {
  switch (status.toLowerCase()) {
    case "active":
    case "running":
    case "connected":
    case "healthy":
    case "online":
    case "green":
      return "green";
    case "idle":
    case "waiting":
    case "degraded":
    case "connecting":
    case "warning":
    case "yellow":
      return "yellow";
    case "error":
    case "failed":
    case "critical":
    case "disconnected":
    case "offline":
    case "red":
      return "red";
    default:
      return "gray";
  }
}

/** Classification level to CSS color variable name. */
export function classificationColor(level: ClassificationLevel): string {
  switch (level) {
    case "PUBLIC":
      return "var(--taint-public)";
    case "INTERNAL":
      return "var(--taint-internal)";
    case "CONFIDENTIAL":
      return "var(--taint-confidential)";
    case "RESTRICTED":
      return "var(--taint-restricted)";
  }
}

/** Inbound chat event from server. */
export interface ChatEvent {
  type: string;
  topic?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** A chat message for display. */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  taint?: ClassificationLevel;
  timestamp: number;
  toolCalls?: ToolCall[];
}

/** A tool call for display. */
export interface ToolCall {
  id: string;
  name: string;
  args: string;
  result?: string;
  state: ToolState;
  isWeb: boolean;
}

/** Canvas render history entry. */
export interface CanvasRender {
  id: string;
  label: string;
  payload: ChatEvent;
}

/** A2UI component node. */
export interface A2UIComponent {
  type: string;
  id: string;
  props: Record<string, unknown>;
  children?: A2UIComponent[];
}

/** Health metric card. */
export interface HealthCard {
  cardId: string;
  label: string;
  status: StatusColor;
  value: string;
  detail: string;
}

/** Log entry. */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
}

/** Memory entry. */
export interface MemoryEntry {
  id: string;
  content: string;
  classification: ClassificationLevel;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
}

/** Agent session card. */
export interface AgentSession {
  sessionId: string;
  label: string;
  model?: string;
  taint: ClassificationLevel;
  status: StatusColor;
  group: "main" | "teams" | "background" | "history";
  lastActivity?: string;
  lastOutput?: string;
  teamId?: string;
  teamRole?: string;
  channel?: string;
  role?: string;
  createdAt?: string;
  taintHistory?: TaintEvent[];
}

/** Agent team card. */
export interface AgentTeam {
  teamId: string;
  name: string;
  status: StatusColor;
  taint: ClassificationLevel;
  members: AgentSession[];
}

/** Taint timeline event. */
export interface TaintEvent {
  previous: ClassificationLevel;
  current: ClassificationLevel;
  reason: string;
  timestamp: string;
}

/** Workflow list entry. */
export interface WorkflowListEntry {
  name: string;
  description?: string;
  classification: ClassificationLevel;
  savedAt: string;
}

/** Workflow active run. */
export interface WorkflowActiveRun {
  runId: string;
  workflowName: string;
  status: "running" | "paused" | "cancelled";
  currentTaskIndex: number;
  currentTaskName: string;
  startedAt: string;
  paused: boolean;
  taint?: ClassificationLevel;
}

/** Workflow run tree node. */
export interface RunTreeNode {
  taskIndex: number;
  taskName: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
}

/** Settings section. */
export type SettingsSection =
  | "general"
  | "providers"
  | "channels"
  | "classification"
  | "scheduler"
  | "integrations"
  | "advanced";

/** Todo item. */
export interface TodoItem {
  text: string;
  status: "done" | "active" | "pending";
}
