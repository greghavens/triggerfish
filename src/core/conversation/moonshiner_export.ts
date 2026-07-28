/**
 * Export a persisted session transcript as OpenAI-style training messages.
 *
 * This is the shape the moonshiner distillation corpus publishes to Hugging
 * Face: one flat message list per trajectory, each message carrying
 * `role`, `content`, `reasoning_content`, `tool_calls`, `tool_call_id`, and
 * `name`. Every field is populated from {@link ConversationRecord} alone, so a
 * trace can be exported from storage after the fact with no live session.
 *
 * One stored record maps to one message, except a `tool_call` record, which
 * holds the result of a call the preceding `assistant` record requested and so
 * becomes a `tool` message.
 *
 * @module
 */

import type { ConversationRecord } from "./conversation_types.ts";

/** A tool call in OpenAI wire format. */
export interface ExportedToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

/** One training message. Absent fields are null, never empty strings. */
export interface ExportedMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly reasoning_content: string | null;
  readonly tool_calls: readonly ExportedToolCall[];
  readonly tool_call_id: string | null;
  readonly name: string | null;
}

/** A session transcript in training-corpus form. */
export interface ExportedTranscript {
  readonly session_id: string;
  readonly messages: readonly ExportedMessage[];
  /** Distinct tool names invoked, in first-call order. */
  readonly tools_used: readonly string[];
  /** Distinct provider names that served turns, in first-use order. */
  readonly providers: readonly string[];
  /** Distinct models observed serving turns, in first-use order. */
  readonly observed_models: readonly string[];
}

/** Absent fields export as null — an empty string is a value, not an absence. */
function orNull(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

/** Coerce a persisted native tool call into OpenAI wire format. */
function exportToolCall(call: unknown): ExportedToolCall | null {
  if (typeof call !== "object" || call === null) return null;
  const source = call as Record<string, unknown>;
  const fn = source.function as Record<string, unknown> | undefined;
  const name = typeof fn?.name === "string"
    ? fn.name
    : typeof source.name === "string"
    ? source.name
    : null;
  if (name === null) return null;
  const rawArgs = fn?.arguments ?? source.input ?? source.arguments ?? {};
  return {
    id: typeof source.id === "string" ? source.id : "",
    type: "function",
    function: {
      name,
      arguments: typeof rawArgs === "string"
        ? rawArgs
        : JSON.stringify(rawArgs),
    },
  };
}

/** Build the assistant message for a record, with reasoning and its tool calls. */
function exportAssistantMessage(record: ConversationRecord): ExportedMessage {
  const calls = (record.tool_calls ?? [])
    .map(exportToolCall)
    .filter((c): c is ExportedToolCall => c !== null);
  return {
    role: "assistant",
    content: orNull(record.content),
    reasoning_content: orNull(record.reasoning),
    tool_calls: calls,
    tool_call_id: null,
    name: null,
  };
}

/** Build the `tool` message carrying a tool call's result. */
function exportToolResultMessage(
  record: ConversationRecord,
): ExportedMessage {
  return {
    role: "tool",
    content: orNull(record.content),
    reasoning_content: null,
    tool_calls: [],
    tool_call_id: orNull(record.tool_call_id),
    name: orNull(record.tool_name),
  };
}

/** Map one record to its training message, or null when it carries no turn. */
function exportRecord(record: ConversationRecord): ExportedMessage | null {
  switch (record.role) {
    case "user":
      return {
        role: "user",
        content: orNull(record.content),
        reasoning_content: null,
        tool_calls: [],
        tool_call_id: null,
        name: null,
      };
    case "assistant":
      return exportAssistantMessage(record);
    case "tool_call":
      return exportToolResultMessage(record);
    case "compaction_summary":
      // A summary replaces turns that are no longer in the transcript. Keeping
      // it as a user message preserves the context the model actually saw.
      return {
        role: "user",
        content: `[CONTEXT SUMMARY]\n${record.content}`,
        reasoning_content: null,
        tool_calls: [],
        tool_call_id: null,
        name: null,
      };
  }
}

/** Collect distinct defined values in first-seen order. */
function distinctInOrder(
  values: readonly (string | undefined)[],
): readonly string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

/**
 * Export a session's stored records as a training transcript.
 *
 * Records must be supplied in storage order (`MessageStore.export` returns
 * them sequence-ordered); the message order is the order the model saw.
 */
export function exportTranscriptForTraining(
  sessionId: string,
  records: readonly ConversationRecord[],
): ExportedTranscript {
  const messages: ExportedMessage[] = [];
  for (const record of records) {
    const message = exportRecord(record);
    if (message) messages.push(message);
  }
  return {
    session_id: sessionId,
    messages,
    tools_used: distinctInOrder(
      records.filter((r) => r.role === "tool_call").map((r) => r.tool_name),
    ),
    providers: distinctInOrder(records.map((r) => r.provider)),
    observed_models: distinctInOrder(records.map((r) => r.model)),
  };
}
