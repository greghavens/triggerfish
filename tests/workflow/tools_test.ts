/**
 * Workflow tool executor tests — 6 agent-facing tools.
 *
 * @module
 */

import { assertEquals, assertStringIncludes, assertExists } from "@std/assert";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createWorkflowEngine } from "../../src/workflow/engine.ts";
import {
  getWorkflowToolDefinitions,
  createWorkflowToolExecutor,
  WORKFLOW_SYSTEM_PROMPT,
} from "../../src/workflow/tools.ts";
import type { WorkflowExecutionContext } from "../../src/workflow/types.ts";
import type { SessionId } from "../../src/core/types/session.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const SIMPLE_WORKFLOW_YAML = `
document:
  dsl: "1.0.0"
  namespace: default
  name: test-workflow
  version: "1.0.0"
do:
  - step1:
      set:
        message: "hello"
  - step2:
      set:
        done: true
`;

function makeToolContext(): {
  executor: (name: string, input: Record<string, unknown>) => Promise<string | null>;
  execCtx: WorkflowExecutionContext;
} {
  const storage = createMemoryStorage();
  const engine = createWorkflowEngine({ storage });

  const execCtx: WorkflowExecutionContext = {
    agentId: "agent1",
    sessionId: "sess-1" as SessionId,
    sessionTaint: "PUBLIC",
    escalateTaint: () => {},
    toolExecutor: async (_name, _input) => `{"ok":true}`,
    storage,
  };

  const executor = createWorkflowToolExecutor(engine, execCtx);
  return { executor, execCtx };
}

// ─── workflow_save ────────────────────────────────────────────────────────────

Deno.test("tools — workflow_save saves valid workflow", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_save", { yaml: SIMPLE_WORKFLOW_YAML });
  assertExists(result);
  const parsed = JSON.parse(result!);
  assertEquals(parsed.saved, true);
  assertEquals(parsed.name, "test-workflow");
  assertEquals(parsed.classification, "PUBLIC");
});

Deno.test("tools — workflow_save validates YAML and returns error for invalid", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_save", { yaml: "dsl: nope\nname: broken\n" });
  assertExists(result);
  assertStringIncludes(result!, "Error");
});

Deno.test("tools — workflow_save requires yaml argument", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_save", {});
  assertStringIncludes(result!, "Error");
});

// ─── workflow_run ─────────────────────────────────────────────────────────────

Deno.test("tools — workflow_run executes saved workflow", async () => {
  const { executor } = makeToolContext();

  // First save it
  await executor("workflow_save", { yaml: SIMPLE_WORKFLOW_YAML });

  // Then run it
  const result = await executor("workflow_run", { name: "test-workflow" });
  assertExists(result);
  const parsed = JSON.parse(result!);
  assertEquals(parsed.status, "COMPLETED");
  assertExists(parsed.runId);
});

Deno.test("tools — workflow_run returns error for unknown workflow", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_run", { name: "nonexistent" });
  assertStringIncludes(result!, "Error");
  assertStringIncludes(result!, "nonexistent");
});

Deno.test("tools — workflow_run requires name argument", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_run", {});
  assertStringIncludes(result!, "Error");
});

// ─── workflow_list ────────────────────────────────────────────────────────────

Deno.test("tools — workflow_list returns classification-filtered list", async () => {
  const { executor } = makeToolContext();

  await executor("workflow_save", { yaml: SIMPLE_WORKFLOW_YAML });

  const result = await executor("workflow_list", {});
  assertExists(result);
  const parsed = JSON.parse(result!);
  assertExists(parsed.workflows);
  assertEquals(parsed.workflows.length, 1);
  assertEquals(parsed.workflows[0].name, "test-workflow");
});

Deno.test("tools — workflow_list returns 'No workflows' when empty", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_list", {});
  assertExists(result);
  assertEquals(result, "No workflows found.");
});

// ─── workflow_get ─────────────────────────────────────────────────────────────

Deno.test("tools — workflow_get returns workflow definition", async () => {
  const { executor } = makeToolContext();

  await executor("workflow_save", { yaml: SIMPLE_WORKFLOW_YAML });

  const result = await executor("workflow_get", { name: "test-workflow" });
  assertExists(result);
  const parsed = JSON.parse(result!);
  assertEquals(parsed.name, "test-workflow");
  assertExists(parsed.do);
});

Deno.test("tools — workflow_get returns error for unknown workflow", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_get", { name: "no-such-workflow" });
  assertStringIncludes(result!, "Error");
});

Deno.test("tools — workflow_get requires name argument", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_get", {});
  assertStringIncludes(result!, "Error");
});

// ─── workflow_delete ──────────────────────────────────────────────────────────

Deno.test("tools — workflow_delete removes workflow", async () => {
  const { executor } = makeToolContext();

  await executor("workflow_save", { yaml: SIMPLE_WORKFLOW_YAML });

  const deleteResult = await executor("workflow_delete", { name: "test-workflow" });
  assertExists(deleteResult);
  const parsed = JSON.parse(deleteResult!);
  assertEquals(parsed.deleted, true);

  // Verify it's gone
  const getResult = await executor("workflow_get", { name: "test-workflow" });
  assertStringIncludes(getResult!, "Error");
});

Deno.test("tools — workflow_delete requires name argument", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_delete", {});
  assertStringIncludes(result!, "Error");
});

// ─── workflow_history ─────────────────────────────────────────────────────────

Deno.test("tools — workflow_history returns execution history", async () => {
  const { executor } = makeToolContext();

  // Save and run
  await executor("workflow_save", { yaml: SIMPLE_WORKFLOW_YAML });
  await executor("workflow_run", { name: "test-workflow" });

  const histResult = await executor("workflow_history", { name: "test-workflow" });
  assertExists(histResult);
  const parsed = JSON.parse(histResult!);
  assertEquals(parsed.workflow, "test-workflow");
  assertEquals(parsed.runs.length, 1);
  assertExists(parsed.runs[0].runId);
});

Deno.test("tools — workflow_history returns empty message when no runs", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_history", { name: "test-workflow" });
  assertExists(result);
  assertStringIncludes(result!, "No execution history");
});

Deno.test("tools — workflow_history requires name argument", async () => {
  const { executor } = makeToolContext();

  const result = await executor("workflow_history", {});
  assertStringIncludes(result!, "Error");
});

// ─── Tool definitions and system prompt ───────────────────────────────────────

Deno.test("tools — getWorkflowToolDefinitions returns 6 tools", () => {
  const defs = getWorkflowToolDefinitions();
  assertEquals(defs.length, 6);

  const names = defs.map((d) => d.name);
  assertEquals(names.includes("workflow_save"), true);
  assertEquals(names.includes("workflow_run"), true);
  assertEquals(names.includes("workflow_list"), true);
  assertEquals(names.includes("workflow_get"), true);
  assertEquals(names.includes("workflow_delete"), true);
  assertEquals(names.includes("workflow_history"), true);
});

Deno.test("tools — all tool definitions have non-empty descriptions", () => {
  const defs = getWorkflowToolDefinitions();
  for (const def of defs) {
    assertEquals(def.description.length > 0, true, `${def.name} has empty description`);
  }
});

Deno.test("tools — WORKFLOW_SYSTEM_PROMPT is non-empty", () => {
  assertEquals(WORKFLOW_SYSTEM_PROMPT.length > 100, true);
  assertStringIncludes(WORKFLOW_SYSTEM_PROMPT, "workflow");
});

// ─── Non-workflow tool returns null ───────────────────────────────────────────

Deno.test("tools — returns null for unknown tool names", async () => {
  const { executor } = makeToolContext();

  const result = await executor("some_other_tool", { arg: "value" });
  assertEquals(result, null);
});
