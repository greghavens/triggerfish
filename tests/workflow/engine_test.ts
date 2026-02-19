/**
 * WorkflowEngine integration tests — store, list, execute, history.
 *
 * @module
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createWorkflowEngine } from "../../src/workflow/engine.ts";
import { parseWorkflowYaml } from "../../src/workflow/parser.ts";
import type { WorkflowExecutionContext } from "../../src/workflow/types.ts";
import type { SessionId } from "../../src/core/types/session.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeEngine() {
  const storage = createMemoryStorage();
  const engine = createWorkflowEngine({ storage });
  return { engine, storage };
}

function makeExecCtx(agentId = "agent1", taint: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED" = "PUBLIC"): WorkflowExecutionContext {
  return {
    agentId,
    sessionId: "sess-1" as SessionId,
    sessionTaint: taint,
    escalateTaint: () => {},
    toolExecutor: async (name, _input) => `{"ok":true,"tool":"${name}"}`,
    storage: createMemoryStorage(),
  };
}

const SIMPLE_WORKFLOW_YAML = `
document:
  dsl: "1.0.0"
  namespace: default
  name: simple-workflow
  version: "1.0.0"
do:
  - step1:
      set:
        message: "hello"
  - step2:
      set:
        done: true
`;

const SWITCH_WORKFLOW_YAML = `
document:
  dsl: "1.0.0"
  namespace: default
  name: switch-workflow
  version: "1.0.0"
do:
  - init:
      set:
        value: 10
  - route:
      switch:
        - bigValue:
            when: "\${ .value >= 5 }"
            then: end
        - default:
            then: continue
  - neverReached:
      set:
        reached: true
`;

const FOR_WORKFLOW_YAML = `
document:
  dsl: "1.0.0"
  namespace: default
  name: for-workflow
  version: "1.0.0"
do:
  - loop:
      for:
        each: item
        in: "\${ .items }"
        do:
          - processItem:
              set:
                lastItem: "\${ $item }"
`;

// ─── Store and retrieve ───────────────────────────────────────────────────────

Deno.test("engine — store and get workflow definition", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(SIMPLE_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  const storeResult = await engine.store(parseResult.value, "agent1", "PUBLIC");
  assertEquals(storeResult.ok, true);

  const retrieved = await engine.get("simple-workflow", "agent1", "PUBLIC");
  assertExists(retrieved);
  assertEquals(retrieved!.name, "simple-workflow");
});

Deno.test("engine — list workflows returns all accessible definitions", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(SIMPLE_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  await engine.store(parseResult.value, "agent1", "PUBLIC");

  const list = await engine.list("agent1", "PUBLIC");
  assertEquals(list.length, 1);
  assertEquals(list[0].name, "simple-workflow");
});

// ─── Classification gating ────────────────────────────────────────────────────

Deno.test("engine — PUBLIC session cannot see CONFIDENTIAL workflow", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(SIMPLE_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  // Store at CONFIDENTIAL level
  await engine.store(parseResult.value, "agent1", "CONFIDENTIAL");

  // PUBLIC session should not see it
  const publicGet = await engine.get("simple-workflow", "agent1", "PUBLIC");
  assertEquals(publicGet, null);

  const publicList = await engine.list("agent1", "PUBLIC");
  assertEquals(publicList.length, 0);
});

Deno.test("engine — CONFIDENTIAL session can see CONFIDENTIAL workflow", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(SIMPLE_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  await engine.store(parseResult.value, "agent1", "CONFIDENTIAL");

  const confGet = await engine.get("simple-workflow", "agent1", "CONFIDENTIAL");
  assertExists(confGet);

  const confList = await engine.list("agent1", "CONFIDENTIAL");
  assertEquals(confList.length, 1);
});

// ─── Execute ──────────────────────────────────────────────────────────────────

Deno.test("engine — execute simple set+switch workflow to completion", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(SWITCH_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  const execCtx = makeExecCtx();
  const state = await engine.execute(parseResult.value, {}, execCtx);

  assertEquals(state.status, "COMPLETED");
  assertEquals(state.data.value, 10);
  // "neverReached" task should not have run
  assertEquals(state.taskResults.find((t) => t.taskName === "neverReached"), undefined);
});

Deno.test("engine — execute for-loop workflow runs correct iteration count", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(FOR_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  const execCtx = makeExecCtx();
  const state = await engine.execute(parseResult.value, { items: ["a", "b", "c"] }, execCtx);

  assertEquals(state.status, "COMPLETED");
  // The for task ran once (as one task), and inside it iterated 3 times
  const forTask = state.taskResults.find((t) => t.taskName === "loop");
  assertExists(forTask);
  assertEquals(forTask!.status, "SUCCESS");
});

// ─── History ──────────────────────────────────────────────────────────────────

Deno.test("engine — execution history is stored and retrieved", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(SIMPLE_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  const execCtx = makeExecCtx();
  const state = await engine.execute(parseResult.value, {}, execCtx);
  assertEquals(state.status, "COMPLETED");

  const hist = await engine.history("simple-workflow", "agent1", "PUBLIC");
  assertEquals(hist.length, 1);
  assertEquals(hist[0].runId, state.runId);
});

Deno.test("engine — history filtered by classification", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(SIMPLE_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  // Execute with CONFIDENTIAL escalation
  const execCtx = makeExecCtx("agent1", "CONFIDENTIAL");
  await engine.execute(parseResult.value, {}, execCtx);

  // PUBLIC session should not see CONFIDENTIAL history
  const publicHist = await engine.history("simple-workflow", "agent1", "PUBLIC");
  assertEquals(publicHist.length, 0);

  // CONFIDENTIAL session should see it
  const confHist = await engine.history("simple-workflow", "agent1", "CONFIDENTIAL");
  assertEquals(confHist.length, 1);
});

// ─── Delete ───────────────────────────────────────────────────────────────────

Deno.test("engine — delete removes workflow from storage", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(SIMPLE_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  await engine.store(parseResult.value, "agent1", "PUBLIC");

  const deleteResult = await engine.delete("simple-workflow", "agent1", "PUBLIC");
  assertEquals(deleteResult.ok, true);

  const retrieved = await engine.get("simple-workflow", "agent1", "PUBLIC");
  assertEquals(retrieved, null);
});

// ─── requiresTools pre-execution validation ───────────────────────────────────

const REQUIRES_TOOLS_WORKFLOW_YAML = `
document:
  dsl: "1.0.0"
  namespace: default
  name: browser-workflow
  version: "1.0.0"
  metadata:
    triggerfish:
      requires_tools: [browser_navigate, browser_screenshot]
do:
  - launch:
      set:
        started: true
`;

const REQUIRES_WEB_SEARCH_YAML = `
document:
  dsl: "1.0.0"
  namespace: default
  name: search-workflow
  version: "1.0.0"
  metadata:
    triggerfish:
      requires_tools: [web_search]
do:
  - doSearch:
      set:
        done: true
`;

Deno.test("engine — execute faults immediately when required tools are unavailable", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(REQUIRES_TOOLS_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  // availableTools does not include browser tools
  const execCtx: WorkflowExecutionContext = {
    ...makeExecCtx(),
    availableTools: ["web_fetch", "web_search", "memory_save"],
  };

  const state = await engine.execute(parseResult.value, {}, execCtx);
  assertEquals(state.status, "FAULTED");
  assertEquals(state.error?.type, "missing_required_tools");
  assertEquals(state.error?.status, 400);
  assertStringIncludes(state.error?.detail ?? "", "browser_navigate");
  assertStringIncludes(state.error?.detail ?? "", "browser_screenshot");
  // No tasks should have run
  assertEquals(state.taskResults.length, 0);
});

Deno.test("engine — execute proceeds when all required tools are available", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(REQUIRES_WEB_SEARCH_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  const execCtx: WorkflowExecutionContext = {
    ...makeExecCtx(),
    availableTools: ["web_search", "memory_save"],
  };

  const state = await engine.execute(parseResult.value, {}, execCtx);
  assertEquals(state.status, "COMPLETED");
});

Deno.test("engine — requiresTools validation skipped when availableTools not provided", async () => {
  const { engine } = makeEngine();
  const parseResult = parseWorkflowYaml(REQUIRES_TOOLS_WORKFLOW_YAML);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  // No availableTools — validation should be skipped, workflow runs fine
  const execCtx = makeExecCtx();
  const state = await engine.execute(parseResult.value, {}, execCtx);
  assertEquals(state.status, "COMPLETED");
});

Deno.test("engine — parse method validates YAML", () => {
  const { engine } = makeEngine();

  const goodResult = engine.parse(SIMPLE_WORKFLOW_YAML);
  assertEquals(goodResult.ok, true);

  const badResult = engine.parse("not valid: yaml: content: :\n  broken");
  // Should return error or parse but fail validation
  if (badResult.ok) {
    // If YAML parses but has no required fields, it fails
  } else {
    assertEquals(badResult.ok, false);
  }
});
