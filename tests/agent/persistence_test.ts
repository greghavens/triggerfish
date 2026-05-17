/**
 * Phase 4: Agent loop persistence tests.
 *
 * Verifies messageStore and lineageStore integration in the agent loop:
 * - determineSourceType mapping
 * - restoreSessionHistoryIfEmpty with classification gating
 * - recordToolCallLineageAndPersist dispatch
 */
import { assertEquals } from "@std/assert";
import { determineSourceType } from "../../src/agent/dispatch/tool_dispatch.ts";
import { recordToolCallLineageAndPersist } from "../../src/agent/dispatch/tool_dispatch.ts";
import { restoreSessionHistoryIfEmpty } from "../../src/agent/loop/agent_turn.ts";
import type { OrchestratorConfig } from "../../src/agent/orchestrator/orchestrator_types.ts";
import type { MessageStore } from "../../src/core/conversation/mod.ts";
import type {
  ConversationAppendInput,
  ConversationRecord,
} from "../../src/core/conversation/mod.ts";
import type { LineageStore } from "../../src/core/session/lineage.ts";
import type {
  LineageCreateInput,
  LineageRecord,
} from "../../src/core/session/lineage_types.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import type { HistoryEntry } from "../../src/agent/orchestrator/orchestrator_types.ts";
import { createSession } from "../../src/core/types/session.ts";
import type {
  ChannelId,
  SessionState,
  UserId,
} from "../../src/core/types/session.ts";

// ─── Mock helpers ────────────────────────────────────────────────────────────

interface MockCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function createMockMessageStore(
  loadActiveRecords: ConversationRecord[] = [],
): MessageStore & { readonly calls: MockCall[] } {
  const calls: MockCall[] = [];
  let sequence = 0;
  return {
    calls,
    // deno-lint-ignore require-await
    async append(input: ConversationAppendInput): Promise<ConversationRecord> {
      calls.push({ method: "append", args: [input] });
      return {
        ...input,
        message_id: `mock-msg-${sequence}`,
        timestamp: new Date().toISOString(),
        sequence: sequence++,
        compacted: false,
      };
    },
    // deno-lint-ignore require-await
    async loadSession(_sessionId: string): Promise<ConversationRecord[]> {
      calls.push({ method: "loadSession", args: [_sessionId] });
      return [];
    },
    // deno-lint-ignore require-await
    async loadActive(_sessionId: string): Promise<ConversationRecord[]> {
      calls.push({ method: "loadActive", args: [_sessionId] });
      return loadActiveRecords;
    },
    // deno-lint-ignore require-await
    async markCompacted(
      _sessionId: string,
      _from: number,
      _to: number,
    ): Promise<void> {
      calls.push({ method: "markCompacted", args: [_sessionId, _from, _to] });
    },
    // deno-lint-ignore require-await
    async export(_sessionId: string): Promise<ConversationRecord[]> {
      calls.push({ method: "export", args: [_sessionId] });
      return [];
    },
    // deno-lint-ignore require-await
    async applyRetention() {
      calls.push({ method: "applyRetention", args: [] });
      return { ok: true as const, value: 0 };
    },
  };
}

function createMockLineageStore(): LineageStore & {
  readonly calls: MockCall[];
} {
  const calls: MockCall[] = [];
  let counter = 0;

  function makeRecord(input: LineageCreateInput): LineageRecord {
    return {
      lineage_id: `lin-${counter++}`,
      content_hash: `hash-${counter}`,
      origin: input.origin,
      classification: input.classification,
      sessionId: input.sessionId,
      inputLineageIds: input.inputLineageIds,
      transformations: input.transformations,
      current_location: input.current_location,
    };
  }

  return {
    calls,
    // deno-lint-ignore require-await
    async create(input: LineageCreateInput): Promise<LineageRecord> {
      calls.push({ method: "create", args: [input] });
      return makeRecord(input);
    },
    // deno-lint-ignore require-await
    async get(_id: string): Promise<LineageRecord | null> {
      calls.push({ method: "get", args: [_id] });
      return null;
    },
    // deno-lint-ignore require-await
    async getBySession(): Promise<LineageRecord[]> {
      calls.push({ method: "getBySession", args: [] });
      return [];
    },
    // deno-lint-ignore require-await
    async trace_forward(): Promise<LineageRecord[]> {
      calls.push({ method: "trace_forward", args: [] });
      return [];
    },
    // deno-lint-ignore require-await
    async trace_forward_indexed(): Promise<LineageRecord[]> {
      calls.push({ method: "trace_forward_indexed", args: [] });
      return [];
    },
    // deno-lint-ignore require-await
    async trace_backward(): Promise<LineageRecord[]> {
      calls.push({ method: "trace_backward", args: [] });
      return [];
    },
    // deno-lint-ignore require-await
    async getByHash() {
      calls.push({ method: "getByHash", args: [] });
      return null;
    },
    // deno-lint-ignore require-await
    async export(): Promise<LineageRecord[]> {
      calls.push({ method: "export", args: [] });
      return [];
    },
    // deno-lint-ignore require-await
    async applyLineageRetention() {
      calls.push({ method: "applyLineageRetention", args: [] });
      return { ok: true as const, value: 0 };
    },
  };
}

function makeTestSession(
  taint: ClassificationLevel = "PUBLIC",
): SessionState {
  return {
    ...createSession({
      userId: "test-user" as UserId,
      channelId: "test-channel" as ChannelId,
    }),
    taint,
  };
}

function makeConversationRecord(
  overrides: Partial<ConversationRecord> & { role: ConversationRecord["role"] },
): ConversationRecord {
  return {
    message_id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    session_id: "test-session",
    role: overrides.role,
    content: overrides.content ?? "test content",
    classification: overrides.classification ?? "PUBLIC",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    sequence: overrides.sequence ?? 0,
    compacted: overrides.compacted ?? false,
    ...overrides,
  };
}

// ─── determineSourceType ─────────────────────────────────────────────────────

Deno.test("determineSourceType: maps web_ tools to web_request", () => {
  assertEquals(determineSourceType("web_search"), "web_request");
  assertEquals(determineSourceType("web_fetch"), "web_request");
});

Deno.test("determineSourceType: maps browser_ tools to browser_session", () => {
  assertEquals(determineSourceType("browser_navigate"), "browser_session");
  assertEquals(determineSourceType("browser_click"), "browser_session");
});

Deno.test("determineSourceType: maps memory_ tools to memory_access", () => {
  assertEquals(determineSourceType("memory_search"), "memory_access");
  assertEquals(determineSourceType("memory_save"), "memory_access");
});

Deno.test("determineSourceType: maps google_ tools to google_api", () => {
  assertEquals(determineSourceType("google_search"), "google_api");
  assertEquals(determineSourceType("gmail_send"), "google_api");
  assertEquals(determineSourceType("calendar_list"), "google_api");
  assertEquals(determineSourceType("drive_upload"), "google_api");
  assertEquals(determineSourceType("sheets_read"), "google_api");
  assertEquals(determineSourceType("tasks_create"), "google_api");
});

Deno.test("determineSourceType: maps github_ tools to github_api", () => {
  assertEquals(determineSourceType("github_clone_repo"), "github_api");
  assertEquals(determineSourceType("github_create_issue"), "github_api");
});

Deno.test("determineSourceType: maps file tools to filesystem", () => {
  assertEquals(determineSourceType("file_read"), "filesystem");
  assertEquals(determineSourceType("read_file"), "filesystem");
  assertEquals(determineSourceType("write_file"), "filesystem");
  assertEquals(determineSourceType("edit_file"), "filesystem");
  assertEquals(determineSourceType("list_directory"), "filesystem");
  assertEquals(determineSourceType("search_files"), "filesystem");
});

Deno.test("determineSourceType: maps mcp_ tools to mcp_server", () => {
  assertEquals(determineSourceType("mcp_call"), "mcp_server");
  assertEquals(determineSourceType("mcp_list"), "mcp_server");
});

Deno.test("determineSourceType: maps unknown tools to tool_response", () => {
  assertEquals(determineSourceType("todo_add"), "tool_response");
  assertEquals(determineSourceType("healthcheck"), "tool_response");
  assertEquals(determineSourceType("some_random_tool"), "tool_response");
});

Deno.test("determineSourceType: maps obsidian_ tools to obsidian_vault", () => {
  assertEquals(determineSourceType("obsidian_read"), "obsidian_vault");
  assertEquals(determineSourceType("obsidian_write"), "obsidian_vault");
});

Deno.test("determineSourceType: maps skill tools to skill_execution", () => {
  assertEquals(determineSourceType("skill_run"), "skill_execution");
  assertEquals(determineSourceType("read_skill"), "skill_execution");
});

Deno.test("determineSourceType: maps scheduler tools to scheduler", () => {
  assertEquals(determineSourceType("cron_list"), "scheduler");
  assertEquals(determineSourceType("trigger_check"), "scheduler");
});

// ─── restoreSessionHistoryIfEmpty ────────────────────────────────────────────

Deno.test("restoreSessionHistoryIfEmpty: restores records from messageStore when history empty", async () => {
  const records: ConversationRecord[] = [
    makeConversationRecord({ role: "user", content: "hello", sequence: 0 }),
    makeConversationRecord({
      role: "assistant",
      content: "hi there",
      sequence: 1,
    }),
  ];
  const store = createMockMessageStore(records);

  const config = { messageStore: store } as unknown as OrchestratorConfig;
  const histories = new Map<string, HistoryEntry[]>();
  const sessionKey = "test-session";

  await restoreSessionHistoryIfEmpty(config, histories, sessionKey, "PUBLIC");

  const restored = histories.get(sessionKey);
  assertEquals(restored !== undefined, true);
  assertEquals(restored!.length, 2);
  assertEquals(restored![0].role, "user");
  assertEquals(restored![0].content, "hello");
  assertEquals(restored![1].role, "assistant");
  assertEquals(restored![1].content, "hi there");

  const loadActiveCalls = store.calls.filter((c) => c.method === "loadActive");
  assertEquals(loadActiveCalls.length, 1);
});

Deno.test("restoreSessionHistoryIfEmpty: skips restoration when messageStore absent", async () => {
  const config = {} as unknown as OrchestratorConfig;
  const histories = new Map<string, HistoryEntry[]>();

  await restoreSessionHistoryIfEmpty(config, histories, "s1", "PUBLIC");

  assertEquals(histories.has("s1"), false);
});

Deno.test("restoreSessionHistoryIfEmpty: does not overwrite existing history", async () => {
  const records: ConversationRecord[] = [
    makeConversationRecord({ role: "user", content: "from store" }),
  ];
  const store = createMockMessageStore(records);
  const config = { messageStore: store } as unknown as OrchestratorConfig;

  const histories = new Map<string, HistoryEntry[]>();
  histories.set("s1", [{ role: "user", content: "already here" }]);

  await restoreSessionHistoryIfEmpty(config, histories, "s1", "PUBLIC");

  assertEquals(histories.get("s1")!.length, 1);
  assertEquals(histories.get("s1")![0].content, "already here");
  // loadActive should not have been called since history was non-empty
  const loadActiveCalls = store.calls.filter((c) => c.method === "loadActive");
  assertEquals(loadActiveCalls.length, 0);
});

Deno.test("restoreSessionHistoryIfEmpty: skips records above session taint", async () => {
  const records: ConversationRecord[] = [
    makeConversationRecord({
      role: "user",
      content: "public msg",
      classification: "PUBLIC",
      sequence: 0,
    }),
    makeConversationRecord({
      role: "assistant",
      content: "confidential msg",
      classification: "CONFIDENTIAL",
      sequence: 1,
    }),
    makeConversationRecord({
      role: "user",
      content: "internal msg",
      classification: "INTERNAL",
      sequence: 2,
    }),
  ];
  const store = createMockMessageStore(records);
  const config = { messageStore: store } as unknown as OrchestratorConfig;
  const histories = new Map<string, HistoryEntry[]>();

  // Session taint is PUBLIC — only PUBLIC records can flow to PUBLIC
  await restoreSessionHistoryIfEmpty(config, histories, "s1", "PUBLIC");

  const restored = histories.get("s1")!;
  // Only the PUBLIC record should be restored
  assertEquals(restored.length, 1);
  assertEquals(restored[0].content, "public msg");
});

Deno.test("restoreSessionHistoryIfEmpty: drops tool_call records on restore", async () => {
  // Tool results live in the lineage store, not the message store, so the
  // assistant→tool pairing cannot be reconstructed. Previously we emitted
  // a synthetic "(result not available)" placeholder, which the model
  // learned to mimic on fresh turns. Now we drop tool_call records on
  // restore — the user-facing messages around them still get restored.
  const records: ConversationRecord[] = [
    makeConversationRecord({
      role: "user",
      content: "do a search",
      sequence: 0,
    }),
    makeConversationRecord({
      role: "tool_call",
      content: "",
      tool_name: "web_search",
      tool_args: { query: "test" },
      lineage_id: "lin-123",
      sequence: 1,
    }),
    makeConversationRecord({
      role: "assistant",
      content: "Here is what I found.",
      sequence: 2,
    }),
  ];
  const store = createMockMessageStore(records);
  const config = { messageStore: store } as unknown as OrchestratorConfig;
  const histories = new Map<string, HistoryEntry[]>();

  await restoreSessionHistoryIfEmpty(config, histories, "s1", "PUBLIC");

  const restored = histories.get("s1")!;
  assertEquals(restored.length, 2);
  assertEquals(restored[0].role, "user");
  assertEquals(restored[1].role, "assistant");
  assertEquals(restored[1].content, "Here is what I found.");
});

// ─── recordToolCallLineageAndPersist ─────────────────────────────────────────

Deno.test("recordToolCallLineageAndPersist: creates lineage and message records", async () => {
  const lineageStore = createMockLineageStore();
  const messageStore = createMockMessageStore();
  const session = makeTestSession("INTERNAL");

  const config = {
    lineageStore,
    messageStore,
    getSessionTaint: () => "INTERNAL" as ClassificationLevel,
  } as unknown as OrchestratorConfig;

  const call = { name: "web_search", args: { query: "test query" } };

  await recordToolCallLineageAndPersist(
    call,
    "search results here",
    false,
    config,
    session,
    "session-key-1",
  );

  // Lineage store should have been called with correct source_type
  const lineageCreates = lineageStore.calls.filter((c) =>
    c.method === "create"
  );
  assertEquals(lineageCreates.length, 1);
  const lineageInput = lineageCreates[0].args[0] as LineageCreateInput;
  assertEquals(lineageInput.origin.source_type, "web_request");
  assertEquals(lineageInput.origin.source_name, "web_search");
  assertEquals(lineageInput.classification.level, "INTERNAL");
  assertEquals(lineageInput.content, "search results here");

  // Message store should have been called with tool_call role
  const messageAppends = messageStore.calls.filter((c) =>
    c.method === "append"
  );
  assertEquals(messageAppends.length, 1);
  const appendInput = messageAppends[0].args[0] as ConversationAppendInput;
  assertEquals(appendInput.role, "tool_call");
  assertEquals(appendInput.tool_name, "web_search");
  assertEquals(appendInput.classification, "INTERNAL");
  assertEquals(appendInput.session_id, "session-key-1");
  assertEquals(appendInput.lineage_id !== undefined, true);
});

Deno.test("recordToolCallLineageAndPersist: skips when call is blocked", async () => {
  const lineageStore = createMockLineageStore();
  const messageStore = createMockMessageStore();
  const session = makeTestSession();

  const config = {
    lineageStore,
    messageStore,
  } as unknown as OrchestratorConfig;

  await recordToolCallLineageAndPersist(
    { name: "web_search", args: {} },
    "blocked result",
    true, // blocked
    config,
    session,
    "s1",
  );

  assertEquals(lineageStore.calls.length, 0);
  assertEquals(messageStore.calls.length, 0);
});

Deno.test("recordToolCallLineageAndPersist: skips read_more calls", async () => {
  const lineageStore = createMockLineageStore();
  const messageStore = createMockMessageStore();
  const session = makeTestSession();

  const config = {
    lineageStore,
    messageStore,
  } as unknown as OrchestratorConfig;

  await recordToolCallLineageAndPersist(
    { name: "read_more", args: { cache_id: "abc" } },
    "cached content",
    false,
    config,
    session,
    "s1",
  );

  assertEquals(lineageStore.calls.length, 0);
  assertEquals(messageStore.calls.length, 0);
});

Deno.test("recordToolCallLineageAndPersist: works without lineageStore", async () => {
  const messageStore = createMockMessageStore();
  const session = makeTestSession();

  const config = {
    messageStore,
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
  } as unknown as OrchestratorConfig;

  await recordToolCallLineageAndPersist(
    { name: "memory_search", args: { query: "test" } },
    "memory results",
    false,
    config,
    session,
    "s1",
  );

  // No lineage, but message should still be appended
  const appends = messageStore.calls.filter((c) => c.method === "append");
  assertEquals(appends.length, 1);
  const input = appends[0].args[0] as ConversationAppendInput;
  assertEquals(input.lineage_id, undefined);
});

Deno.test("recordToolCallLineageAndPersist: works without messageStore", async () => {
  const lineageStore = createMockLineageStore();
  const session = makeTestSession();

  const config = {
    lineageStore,
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
  } as unknown as OrchestratorConfig;

  await recordToolCallLineageAndPersist(
    { name: "browser_navigate", args: { url: "https://example.com" } },
    "page content",
    false,
    config,
    session,
    "s1",
  );

  // Lineage should be created even without messageStore
  const creates = lineageStore.calls.filter((c) => c.method === "create");
  assertEquals(creates.length, 1);
  const input = creates[0].args[0] as LineageCreateInput;
  assertEquals(input.origin.source_type, "browser_session");
});

Deno.test("recordToolCallLineageAndPersist: uses session taint from getSessionTaint", async () => {
  const lineageStore = createMockLineageStore();
  const messageStore = createMockMessageStore();
  const session = makeTestSession("PUBLIC");

  const config = {
    lineageStore,
    messageStore,
    // getSessionTaint returns escalated taint
    getSessionTaint: () => "CONFIDENTIAL" as ClassificationLevel,
  } as unknown as OrchestratorConfig;

  await recordToolCallLineageAndPersist(
    { name: "github_list_repos", args: {} },
    "repo list",
    false,
    config,
    session,
    "s1",
  );

  const lineageInput = (lineageStore.calls[0].args[0]) as LineageCreateInput;
  assertEquals(lineageInput.classification.level, "CONFIDENTIAL");

  const messageInput =
    (messageStore.calls[0].args[0]) as ConversationAppendInput;
  assertEquals(messageInput.classification, "CONFIDENTIAL");
});

Deno.test("recordToolCallLineageAndPersist: falls back to session.taint when getSessionTaint absent", async () => {
  const lineageStore = createMockLineageStore();
  const messageStore = createMockMessageStore();
  const session = makeTestSession("INTERNAL");

  const config = {
    lineageStore,
    messageStore,
    // No getSessionTaint
  } as unknown as OrchestratorConfig;

  await recordToolCallLineageAndPersist(
    { name: "file_read", args: { path: "/tmp/test" } },
    "file content",
    false,
    config,
    session,
    "s1",
  );

  const lineageInput = (lineageStore.calls[0].args[0]) as LineageCreateInput;
  assertEquals(lineageInput.classification.level, "INTERNAL");
});
