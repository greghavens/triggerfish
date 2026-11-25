/**
 * Chat store — messages, tool calls, thinking state, images.
 */

import type {
  ChatMessage,
  ClassificationLevel,
  TodoItem,
  ToolCall,
} from "../types.js";
import { onTopic, send } from "./websocket.svelte.js";

let nextId = 0;
function genId(): string {
  return `msg-${++nextId}`;
}

/** All chat messages. */
let _messages: ChatMessage[] = $state([]);

/** Active tool calls. */
let _toolCalls: ToolCall[] = $state([]);

/** Whether this chat connection is in Sentinel mode. */
let _sentinelMode = $state(false);
interface SideEntry {
  question: string;
  answer: string;
}
let _sideEntries: SideEntry[] = $state([]);
let _sideStatus = $state("");
let _sideVisible = $state(false);
let _sideRunning = $state(false);

export function getSideQuestions() {
  return {
    entries: _sideEntries,
    status: _sideStatus,
    visible: _sideVisible,
    running: _sideRunning,
  };
}

export function closeSideQuestions() {
  _sideVisible = false;
}

/** Whether the LLM is currently generating. */
let _thinking: boolean = $state(false);

/** Current partial assistant text being streamed. */
let _partialText: string = $state("");

/** Pending pasted images (base64). */
let _pendingImages: string[] = $state([]);

/** Current todo list items. */
let _todoItems: TodoItem[] = $state([]);

/** Whether a vision request is in progress. */
let _visionActive: boolean = $state(false);

/** Whether the user just toggled bumpers (suppresses initial status message). */
let _bumpersTogglePending = false;

const WEB_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "brave_search",
  "google_search",
]);
const TODO_TOOLS = new Set(["todo", "todo_list", "todo_update"]);

/** Get all chat messages. */
export function getMessages(): ChatMessage[] {
  return _messages;
}

export function getSentinelMode(): boolean {
  return _sentinelMode;
}

/** Get active tool calls. */
export function getToolCalls(): ToolCall[] {
  return _toolCalls;
}

/** Get whether the LLM is currently generating. */
export function getThinking(): boolean {
  return _thinking;
}

/** Get current partial assistant text being streamed. */
export function getPartialText(): string {
  return _partialText;
}

/** Get pending pasted images. */
export function getPendingImages(): string[] {
  return _pendingImages;
}

/** Get current todo list items. */
export function getTodoItems(): TodoItem[] {
  return _todoItems;
}

/** Get whether a vision request is in progress. */
export function getVisionActive(): boolean {
  return _visionActive;
}

/** Send a user message. */
export function sendMessage(text: string): void {
  if (!text.trim() && _pendingImages.length === 0) return;

  const trimmed = text.trim();
  if (/^\/btw(?:\s|$)/.test(trimmed)) {
    if (!_sideRunning && /^\/btw\s+--(?:worker|session)(?:\s|$)/.test(trimmed)) _sideEntries = [];
    _sideVisible = true;
    if (trimmed === "/btw cancel") send({ type: "side_cancel" });
    else send({ type: "message", content: trimmed });
    return;
  }
  if (/^\/sentinel\s+case\s+\S/.test(trimmed)) {
    _sideEntries = [];
    _sideStatus = "";
    _sideVisible = false;
    _sideRunning = false;
  }

  if (trimmed === "/clear") {
    clearChat();
    send({ type: "clear" });
    return;
  }

  if (_sentinelMode && (trimmed === "/bumpers" || trimmed === "/compact")) {
    _messages.push({
      id: genId(),
      role: "error",
      text: "Exit Sentinel mode to use normal chat controls.",
      timestamp: Date.now(),
    });
    return;
  }

  if (trimmed === "/bumpers") {
    _bumpersTogglePending = true;
    send({ type: "bumpers" });
    return;
  }

  if (trimmed === "/compact") {
    _messages.push({
      id: genId(),
      role: "assistant",
      text: "Compacting conversation history…",
      timestamp: Date.now(),
    });
    send({ type: "compact" });
    return;
  }

  // Build content
  let content: unknown;
  if (_pendingImages.length > 0) {
    const parts: unknown[] = [];
    for (const img of _pendingImages) {
      parts.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: img,
        },
      });
    }
    if (text.trim()) {
      parts.push({ type: "text", text: text.trim() });
    }
    content = parts;
    _pendingImages = [];
  } else {
    content = text.trim();
  }

  _messages.push({
    id: genId(),
    role: "user",
    text: typeof content === "string" ? content : text.trim(),
    timestamp: Date.now(),
  });

  _thinking = true;
  send({ type: "message", content });
}

/** Cancel the current generation. */
export function cancelGeneration(): void {
  send({ type: "cancel" });
}

/** Clear all chat state. */
export function clearChat(): void {
  _sideEntries = [];
  _sideStatus = "";
  _sideVisible = false;
  _sideRunning = false;
  _sentinelMode = false;
  _pendingImages = [];
  _messages = [];
  _toolCalls = [];
  _thinking = false;
  _partialText = "";
  _todoItems = [];
  _visionActive = false;
  _bumpersTogglePending = false;
}

/** Add a pasted image. */
export function addPendingImage(base64: string): void {
  _pendingImages = [..._pendingImages, base64];
}

/** Remove a pending image. */
export function removePendingImage(index: number): void {
  _pendingImages = _pendingImages.filter((_, i) => i !== index);
}

/** Extract todo items from tool args/result. */
function extractTodos(
  name: string,
  args: string,
  result?: string,
): TodoItem[] {
  const source = result ?? args;
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) {
      return parsed.map((item: { text?: string; status?: string }) => ({
        text: item.text ?? String(item),
        status: (item.status as TodoItem["status"]) ?? "pending",
      }));
    }
    if (parsed.items && Array.isArray(parsed.items)) {
      return parsed.items.map((item: { text?: string; status?: string }) => ({
        text: item.text ?? String(item),
        status: (item.status as TodoItem["status"]) ?? "pending",
      }));
    }
  } catch {
    // Not JSON, ignore
  }
  void name;
  return [];
}

/** Hydrate messages from server-sent chat history on reconnect. */
function hydrateChatHistory(
  messages: Array<{
    role: string;
    text: string;
    taint?: string;
    timestamp: number;
  }>,
): void {
  // Only hydrate if the client has no messages (fresh page load)
  if (_messages.length > 0) return;
  for (const entry of messages) {
    const role = entry.role as ChatMessage["role"];
    if (role !== "user" && role !== "assistant") continue;
    _messages.push({
      id: genId(),
      role,
      text: entry.text,
      taint: entry.taint as ClassificationLevel | undefined,
      timestamp: entry.timestamp,
    });
  }
}

/** Handle inbound chat events. */
function handleMessage(msg: Record<string, unknown>): void {
  const type = msg.type as string;

  switch (type) {
    case "side_started":
      _sideVisible = true;
      _sideRunning = true;
      _sideStatus = "Side question running…";
      break;
    case "side_answer":
      _sideVisible = true;
      _sideEntries = [..._sideEntries, msg.entry as SideEntry].slice(-30);
      _sideRunning = false;
      _sideStatus = "";
      break;
    case "side_history":
      _sideVisible = true;
      _sideEntries = (msg.entries as SideEntry[]).slice(-30);
      _sideStatus = _sideEntries.length ? "" : "No side questions in this session.";
      break;
    case "side_error":
    case "side_cancelled":
      _sideVisible = true;
      _sideRunning = false;
      _sideStatus = type === "side_cancelled" ? "Side question cancelled." : String(msg.message);
      break;
    case "sentinel_mode":
      clearChat();
      _sentinelMode = msg.active === true;
      break;

    case "chat_history": {
      const messages = msg.messages as Array<{
        role: string;
        text: string;
        taint?: string;
        timestamp: number;
      }>;
      if (Array.isArray(messages)) {
        hydrateChatHistory(messages);
      }
      break;
    }

    case "llm_start":
      _thinking = true;
      _partialText = "";
      break;

    case "tool_call": {
      const name = msg.name as string;
      const args =
        typeof msg.args === "string"
          ? msg.args
          : JSON.stringify(msg.args ?? {});
      _toolCalls.push({
        id: genId(),
        name,
        args,
        state: "running",
        isWeb: WEB_TOOLS.has(name),
      });
      break;
    }

    case "tool_result": {
      const name = msg.name as string;
      const result = msg.result as string;
      const idx = _toolCalls.findLastIndex(
        (t) => t.name === name && t.state === "running",
      );
      if (idx >= 0) {
        _toolCalls[idx].state = "done";
        _toolCalls[idx].result = result;
      }

      if (TODO_TOOLS.has(name)) {
        const todos = extractTodos(name, "", result);
        if (todos.length > 0) {
          _todoItems = todos;
        }
      }
      break;
    }

    case "response": {
      const text = msg.text as string;
      _thinking = false;
      _partialText = "";
      // Preserve tool calls from this turn on the message
      const turnTools = _toolCalls.length > 0 ? [..._toolCalls] : undefined;
      _messages.push({
        id: genId(),
        role: "assistant",
        text,
        taint: msg.taint as ClassificationLevel | undefined,
        timestamp: Date.now(),
        toolCalls: turnTools,
      });
      // Reset tool calls for next turn
      _toolCalls = [];
      break;
    }

    case "vision_start":
      _visionActive = true;
      break;

    case "vision_complete":
      _visionActive = false;
      break;

    case "cancelled": {
      _thinking = false;
      _partialText = "";
      // Fold pending tool calls into a status message so they don't linger
      if (_toolCalls.length > 0) {
        _messages.push({
          id: genId(),
          role: "assistant",
          text: "Generation cancelled.",
          timestamp: Date.now(),
          toolCalls: [..._toolCalls],
        });
        _toolCalls = [];
      }
      break;
    }

    case "bumpers_status": {
      if (!_bumpersTogglePending) break;
      _bumpersTogglePending = false;
      const enabled = msg.enabled as boolean;
      _messages.push({
        id: genId(),
        role: "assistant",
        text: enabled
          ? "Bumpers **enabled** — tool calls that would escalate taint will be blocked."
          : "Bumpers **disabled** — taint will escalate freely.",
        timestamp: Date.now(),
      });
      break;
    }

    case "error": {
      _thinking = false;
      _bumpersTogglePending = false;
      _partialText = "";
      const errorTools = _toolCalls.length > 0 ? [..._toolCalls] : undefined;
      _messages.push({
        id: genId(),
        role: "error",
        text: msg.message as string,
        timestamp: Date.now(),
        toolCalls: errorTools,
      });
      _toolCalls = [];
      break;
    }
  }
}

onTopic("chat", handleMessage);

/** Reset thinking and pending flags when the WebSocket disconnects. */
function handleShellMessage(msg: Record<string, unknown>): void {
  if (msg.type === "ws_disconnected") {
    if (_sentinelMode) clearChat();
    _thinking = false;
    _bumpersTogglePending = false;
  }
}

onTopic("shell", handleShellMessage);
