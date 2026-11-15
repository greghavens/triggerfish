/**
 * Training-transcript export tests — verifies a full turn (reasoning,
 * assistant tool calls, paired tool results) survives a round trip through
 * the MessageStore and exports in OpenAI training-message shape.
 */
import { assertEquals } from "@std/assert";
import { createMemoryStorage } from "../../../src/core/storage/memory.ts";
import {
  createMessageStore,
  exportTranscriptForTraining,
} from "../../../src/core/conversation/mod.ts";

Deno.test("exportTranscriptForTraining: round-trips a full tool-calling turn", async () => {
  const store = createMessageStore(createMemoryStorage());
  await store.append({
    session_id: "sess-1",
    role: "user",
    content: "What is in README.md?",
    classification: "PUBLIC",
  });
  await store.append({
    session_id: "sess-1",
    role: "assistant",
    content: " ",
    classification: "PUBLIC",
    reasoning: "The user wants the file contents, so I should read it.",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"README.md"}' },
    }],
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
  });
  await store.append({
    session_id: "sess-1",
    role: "tool_call",
    content: "# Triggerfish",
    classification: "PUBLIC",
    tool_name: "read_file",
    tool_args: { path: "README.md" },
    tool_call_id: "call_1",
  });
  await store.append({
    session_id: "sess-1",
    role: "assistant",
    content: "It is the Triggerfish readme.",
    classification: "PUBLIC",
    reasoning: "I have the contents; answer directly.",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
  });

  const transcript = exportTranscriptForTraining(
    "sess-1",
    await store.export("sess-1"),
  );

  assertEquals(transcript.messages.length, 4);
  assertEquals(transcript.messages[0].role, "user");

  const call = transcript.messages[1];
  assertEquals(call.role, "assistant");
  assertEquals(
    call.reasoning_content,
    "The user wants the file contents, so I should read it.",
  );
  assertEquals(call.tool_calls.length, 1);
  assertEquals(call.tool_calls[0].id, "call_1");
  assertEquals(call.tool_calls[0].function.name, "read_file");
  assertEquals(call.tool_calls[0].function.arguments, '{"path":"README.md"}');

  const result = transcript.messages[2];
  assertEquals(result.role, "tool");
  assertEquals(result.tool_call_id, "call_1");
  assertEquals(result.name, "read_file");
  assertEquals(result.content, "# Triggerfish");

  const answer = transcript.messages[3];
  assertEquals(answer.role, "assistant");
  assertEquals(answer.content, "It is the Triggerfish readme.");
  assertEquals(
    answer.reasoning_content,
    "I have the contents; answer directly.",
  );
  assertEquals(answer.tool_calls, []);

  assertEquals(transcript.tools_used, ["read_file"]);
  assertEquals(transcript.providers, ["anthropic"]);
  assertEquals(transcript.observed_models, ["claude-sonnet-4-5-20250929"]);
});

Deno.test("exportTranscriptForTraining: absent fields export as null, not empty string", () => {
  const transcript = exportTranscriptForTraining("sess-2", [{
    message_id: "m1",
    session_id: "sess-2",
    role: "user",
    content: "hi",
    classification: "PUBLIC",
    timestamp: new Date().toISOString(),
    sequence: 0,
    compacted: false,
  }]);
  const message = transcript.messages[0];
  assertEquals(message.reasoning_content, null);
  assertEquals(message.tool_call_id, null);
  assertEquals(message.name, null);
  assertEquals(message.tool_calls, []);
});

Deno.test("exportTranscriptForTraining: normalizes Anthropic-style tool_use blocks", () => {
  const transcript = exportTranscriptForTraining("sess-3", [{
    message_id: "m1",
    session_id: "sess-3",
    role: "assistant",
    content: "",
    classification: "PUBLIC",
    timestamp: new Date().toISOString(),
    sequence: 0,
    compacted: false,
    tool_calls: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "web_fetch",
        input: { url: "x" },
      },
    ],
  }]);
  const call = transcript.messages[0].tool_calls[0];
  assertEquals(call.id, "toolu_1");
  assertEquals(call.type, "function");
  assertEquals(call.function.name, "web_fetch");
  assertEquals(call.function.arguments, '{"url":"x"}');
  assertEquals(transcript.messages[0].content, null);
});

Deno.test("exportTranscriptForTraining: compaction summary keeps the context the model saw", () => {
  const transcript = exportTranscriptForTraining("sess-4", [{
    message_id: "m1",
    session_id: "sess-4",
    role: "compaction_summary",
    content: "Earlier the user asked about README.md.",
    classification: "PUBLIC",
    timestamp: new Date().toISOString(),
    sequence: 0,
    compacted: false,
  }]);
  assertEquals(transcript.messages[0].role, "user");
  assertEquals(
    transcript.messages[0].content,
    "[CONTEXT SUMMARY]\nEarlier the user asked about README.md.",
  );
});
