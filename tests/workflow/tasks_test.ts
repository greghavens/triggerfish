/**
 * Task executor tests — all CNCF task types.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { SessionId } from "../../src/core/types/session.ts";
import { createWorkflowContext } from "../../src/workflow/context.ts";
import { executeTask, parseDurationMs } from "../../src/workflow/tasks.ts";
import type { WorkflowExecutionContext, TaskNode } from "../../src/workflow/types.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

type ToolCall = { name: string; input: Record<string, unknown> };

function makeExecCtx(toolResponses: Record<string, string> = {}): {
  execCtx: WorkflowExecutionContext;
  calls: ToolCall[];
  taintEscalations: string[];
} {
  const calls: ToolCall[] = [];
  const taintEscalations: string[] = [];

  const execCtx: WorkflowExecutionContext = {
    agentId: "test-agent",
    sessionId: "test-session" as SessionId,
    sessionTaint: "PUBLIC",
    escalateTaint: (level, reason) => {
      taintEscalations.push(`${level}:${reason}`);
    },
    toolExecutor: async (name, input) => {
      calls.push({ name, input });
      return toolResponses[name] ?? `{"ok":true,"tool":"${name}"}`;
    },
    storage: null as unknown as WorkflowExecutionContext["storage"],
  };

  return { execCtx, calls, taintEscalations };
}

function makeCtx(data: Record<string, unknown> = {}) {
  const ctx = createWorkflowContext({
    input: {},
    sessionId: "test-session" as SessionId,
    sessionTaint: "PUBLIC",
    agentId: "test-agent",
    workflowName: "test-wf",
    workflowVersion: "1.0.0",
  });
  return { ...ctx, data };
}

// ─── parseDurationMs ──────────────────────────────────────────────────────────

Deno.test("tasks — parseDurationMs: 30s → 30000", () => {
  assertEquals(parseDurationMs("30s"), 30000);
});

Deno.test("tasks — parseDurationMs: 5m → 300000", () => {
  assertEquals(parseDurationMs("5m"), 300000);
});

Deno.test("tasks — parseDurationMs: 100ms → 100", () => {
  assertEquals(parseDurationMs("100ms"), 100);
});

Deno.test("tasks — parseDurationMs: 2h → 7200000", () => {
  assertEquals(parseDurationMs("2h"), 7200000);
});

// ─── set task ─────────────────────────────────────────────────────────────────

Deno.test("tasks — set task returns set values as output", async () => {
  const { execCtx } = makeExecCtx();
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "initVars",
    set: { counter: 0, status: "active" },
  };

  const { result, nextCtx } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(result.skipped, false);
  assertEquals(result.blocked, false);
  assertEquals(result.output, { counter: 0, status: "active" });
});

// ─── switch task ──────────────────────────────────────────────────────────────

Deno.test("tasks — switch follows matching case directive", async () => {
  const { execCtx } = makeExecCtx();
  const ctx = makeCtx({ priority: "high" });
  const task: TaskNode = {
    name: "route",
    switch: [
      { name: "highPriority", when: "${ .priority == \"high\" }", then: "alertOwner" },
      { name: "default", then: "end" },
    ],
  };

  const { directive } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(directive, "alertOwner");
});

Deno.test("tasks — switch falls through to default case", async () => {
  const { execCtx } = makeExecCtx();
  const ctx = makeCtx({ priority: "low" });
  const task: TaskNode = {
    name: "route",
    switch: [
      { name: "highPriority", when: "${ .priority == \"high\" }", then: "alertOwner" },
      { name: "default", then: "end" },
    ],
  };

  const { directive } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(directive, "end");
});

// ─── if condition ─────────────────────────────────────────────────────────────

Deno.test("tasks — task is skipped when if evaluates to false", async () => {
  const { execCtx } = makeExecCtx();
  const ctx = makeCtx({ enabled: false });
  const task: TaskNode = {
    name: "conditionalTask",
    if: "${ .enabled }",
    set: { ran: true },
  };

  const { result } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(result.skipped, true);
});

Deno.test("tasks — task runs when if evaluates to true", async () => {
  const { execCtx } = makeExecCtx();
  const ctx = makeCtx({ enabled: true });
  const task: TaskNode = {
    name: "conditionalTask",
    if: "${ .enabled }",
    set: { ran: true },
  };

  const { result } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(result.skipped, false);
});

// ─── for loop ─────────────────────────────────────────────────────────────────

Deno.test("tasks — for loop executes do-block for each item", async () => {
  const { execCtx, calls } = makeExecCtx();
  const ctx = makeCtx({ items: ["a", "b", "c"] });
  const task: TaskNode = {
    name: "processItems",
    for: {
      each: "item",
      in: "${ .items }",
      do: [
        {
          name: "fetchItem",
          call: { type: "triggerfish:web_search", with: { query: "${ $item }" } },
        },
      ],
    },
  };

  const { result } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(result.skipped, false);
  // Should have made 3 web_search calls
  const searchCalls = calls.filter((c) => c.name === "web_search");
  assertEquals(searchCalls.length, 3);
});

// ─── raise task ───────────────────────────────────────────────────────────────

Deno.test("tasks — raise task returns error in result", async () => {
  const { execCtx } = makeExecCtx();
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "failTask",
    raise: {
      error: {
        type: "validation_error",
        status: 400,
        title: "Input invalid",
        detail: "Missing required field",
      },
    },
  };

  const { result } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(result.error !== undefined, true);
  assertStringIncludes(result.error!, "validation_error");
});

// ─── call: http ───────────────────────────────────────────────────────────────

Deno.test("tasks — call:http dispatches to web_fetch tool", async () => {
  const { execCtx, calls } = makeExecCtx({
    web_fetch: JSON.stringify({ status: 200, data: "result" }),
  });
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "fetchWeather",
    call: {
      type: "http",
      with: {
        method: "GET",
        endpoint: { uri: "https://api.example.com/weather" },
      },
    },
  };

  await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "web_fetch");
  assertStringIncludes(calls[0].input.url as string, "api.example.com");
});

// ─── call: triggerfish:memory ─────────────────────────────────────────────────

Deno.test("tasks — call:triggerfish:memory save dispatches to memory_save", async () => {
  const { execCtx, calls } = makeExecCtx();
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "saveData",
    call: {
      type: "triggerfish:memory",
      with: {
        operation: "save",
        key: "my-key",
        content: "my content",
      },
    },
    output: { as: ".savedResult" },
  };

  await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "memory_save");
  assertEquals(calls[0].input.key, "my-key");
});

Deno.test("tasks — call:triggerfish:web_search dispatches to web_search", async () => {
  const { execCtx, calls } = makeExecCtx();
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "search",
    call: {
      type: "triggerfish:web_search",
      with: { query: "latest AI news", maxResults: 5 },
    },
  };

  await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "web_search");
  assertEquals(calls[0].input.query, "latest AI news");
});

// ─── run: shell ───────────────────────────────────────────────────────────────

Deno.test("tasks — run:shell dispatches to run_command tool", async () => {
  const { execCtx, calls } = makeExecCtx({ run_command: "hello world" });
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "runShell",
    run: {
      type: "shell",
      with: { command: "echo hello" },
    },
  };

  await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "run_command");
  assertEquals(calls[0].input.command, "echo hello");
});

// ─── then: end ────────────────────────────────────────────────────────────────

Deno.test("tasks — then: end directive is returned", async () => {
  const { execCtx } = makeExecCtx();
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "finalTask",
    then: "end",
    set: { done: true },
  };

  const { directive } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(directive, "end");
});

// ─── output transform ─────────────────────────────────────────────────────────

Deno.test("tasks — output.as stores result in context", async () => {
  const { execCtx } = makeExecCtx({
    web_search: JSON.stringify({ results: [{ title: "Article 1" }] }),
  });
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "search",
    call: {
      type: "triggerfish:web_search",
      with: { query: "test" },
    },
    output: { as: ".searchResults" },
  };

  const { nextCtx } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(nextCtx.data.searchResults !== undefined, true);
});

// ─── call: triggerfish:tool ───────────────────────────────────────────────────

Deno.test("tasks — call:triggerfish:tool dispatches named tool directly", async () => {
  const { execCtx, calls } = makeExecCtx({
    file_read: JSON.stringify({ content: "file contents here" }),
  });
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "readFile",
    call: {
      type: "triggerfish:tool",
      with: {
        tool: "file_read",
        arguments: { path: "/workspace/output.txt" },
      },
    },
  };

  const { result } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(result.blocked, false);
  assertEquals(result.error, undefined);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "file_read");
  assertEquals(calls[0].input.path, "/workspace/output.txt");
});

Deno.test("tasks — call:triggerfish:tool passes arguments to tool", async () => {
  const { execCtx, calls } = makeExecCtx({
    browser_navigate: JSON.stringify({ ok: true }),
  });
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "navigate",
    call: {
      type: "triggerfish:tool",
      with: {
        tool: "browser_navigate",
        arguments: { url: "https://example.com", waitFor: "load" },
      },
    },
  };

  await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(calls[0].name, "browser_navigate");
  assertEquals(calls[0].input.url, "https://example.com");
  assertEquals(calls[0].input.waitFor, "load");
});

Deno.test("tasks — call:triggerfish:tool returns error when tool name is missing", async () => {
  const { execCtx } = makeExecCtx();
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "badCall",
    call: {
      type: "triggerfish:tool",
      with: {},
    },
  };

  const { result } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(result.error !== undefined, true);
  assertStringIncludes(result.error!, "with.tool");
});

Deno.test("tasks — call:triggerfish:tool with empty arguments succeeds", async () => {
  const { execCtx, calls } = makeExecCtx({
    memory_list: JSON.stringify({ items: [] }),
  });
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "listMemory",
    call: {
      type: "triggerfish:tool",
      with: {
        tool: "memory_list",
      },
    },
  };

  const { result } = await executeTask(task, ctx, execCtx, "PUBLIC");
  assertEquals(result.blocked, false);
  assertEquals(calls[0].name, "memory_list");
  assertEquals(Object.keys(calls[0].input).length, 0);
});

// ─── blocked tool response ────────────────────────────────────────────────────

Deno.test("tasks — blocked tool response sets blocked=true", async () => {
  const { execCtx } = makeExecCtx({
    web_fetch: "Error: Write-down blocked — session taint exceeds target classification",
  });
  const ctx = makeCtx();
  const task: TaskNode = {
    name: "blockedFetch",
    call: {
      type: "http",
      with: { method: "GET", endpoint: { uri: "https://example.com" } },
    },
  };

  const { result } = await executeTask(task, ctx, execCtx, "CONFIDENTIAL");
  assertEquals(result.blocked, true);
});
