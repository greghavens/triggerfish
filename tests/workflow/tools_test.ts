import { assertEquals } from "@std/assert";
import {
  createWorkflowToolExecutor,
  getWorkflowToolDefinitions,
} from "../../src/workflow/tools.ts";
import { createWorkflowStore } from "../../src/workflow/store.ts";
import type { StorageProvider } from "../../src/core/storage/provider.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";

function createMemoryStorage(): StorageProvider {
  const data = new Map<string, string>();
  return {
    set(key: string, value: string): Promise<void> {
      data.set(key, value);
      return Promise.resolve();
    },
    get(key: string): Promise<string | null> {
      return Promise.resolve(data.get(key) ?? null);
    },
    delete(key: string): Promise<void> {
      data.delete(key);
      return Promise.resolve();
    },
    list(prefix?: string): Promise<string[]> {
      const keys: string[] = [];
      for (const k of data.keys()) {
        if (!prefix || k.startsWith(prefix)) keys.push(k);
      }
      return Promise.resolve(keys);
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

const VALID_WORKFLOW = `
document:
  dsl: "1.0"
  namespace: test
  name: sample
do:
  - greet:
      set:
        message: "hello"
`;

function createTestContext(
  taint: ClassificationLevel = "PUBLIC",
): {
  executor: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  toolCalls: { name: string; input: Record<string, unknown> }[];
} {
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  const store = createWorkflowStore(createMemoryStorage());
  const toolExecutor = (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> => {
    toolCalls.push({ name, input });
    return Promise.resolve(JSON.stringify({ ok: true }));
  };

  const executor = createWorkflowToolExecutor({
    store,
    toolExecutor,
    getSessionTaint: () => taint,
  });

  return { executor, toolCalls };
}

Deno.test("getWorkflowToolDefinitions: returns 7 tools", () => {
  const defs = getWorkflowToolDefinitions();
  assertEquals(defs.length, 7);

  const names = defs.map((d) => d.name);
  assertEquals(names.includes("workflow_run"), true);
  assertEquals(names.includes("workflow_save"), true);
  assertEquals(names.includes("workflow_list"), true);
  assertEquals(names.includes("workflow_get"), true);
  assertEquals(names.includes("workflow_delete"), true);
  assertEquals(names.includes("workflow_history"), true);
  assertEquals(names.includes("workflow_control"), true);
});

Deno.test("workflow tools: returns null for unknown tool", async () => {
  const { executor } = createTestContext();
  const result = await executor("unknown_tool", {});
  assertEquals(result, null);
});

Deno.test("workflow tools: save validates YAML before storing", async () => {
  const { executor } = createTestContext();

  const result = await executor("workflow_save", {
    name: "test-wf",
    yaml: "not valid workflow",
  });

  assertEquals(result !== null, true);
  assertEquals(result!.startsWith("WORKFLOW_SAVE_FAILED:"), true);
  assertEquals(result!.includes("Validation error"), true);
});

Deno.test("workflow tools: save + get round trip", async () => {
  const store = createWorkflowStore(createMemoryStorage());
  const executor = createWorkflowToolExecutor({
    store,
    toolExecutor: () => Promise.resolve(JSON.stringify({ ok: true })),
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
  });

  const saveResult = await executor("workflow_save", {
    name: "test-wf",
    yaml: VALID_WORKFLOW,
    description: "Test workflow",
  });
  assertEquals(saveResult !== null, true);
  const saved = JSON.parse(saveResult!);
  assertEquals(saved.saved, "test-wf");
  assertEquals(saved.taskCount, 1);

  const getResult = await executor("workflow_get", { name: "test-wf" });
  assertEquals(getResult !== null, true);
  const got = JSON.parse(getResult!);
  assertEquals(got.name, "test-wf");
  assertEquals(got.description, "Test workflow");
  assertEquals(got.yaml, VALID_WORKFLOW);
});

Deno.test("workflow tools: save + list", async () => {
  const store = createWorkflowStore(createMemoryStorage());
  const executor = createWorkflowToolExecutor({
    store,
    toolExecutor: () => Promise.resolve(JSON.stringify({ ok: true })),
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
  });

  await executor("workflow_save", { name: "wf1", yaml: VALID_WORKFLOW });
  await executor("workflow_save", { name: "wf2", yaml: VALID_WORKFLOW });

  const listResult = await executor("workflow_list", {});
  assertEquals(listResult !== null, true);
  const list = JSON.parse(listResult!);
  assertEquals(list.workflows.length, 2);
});

Deno.test("workflow tools: save + delete + get returns not found", async () => {
  const store = createWorkflowStore(createMemoryStorage());
  const executor = createWorkflowToolExecutor({
    store,
    toolExecutor: () => Promise.resolve(JSON.stringify({ ok: true })),
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
  });

  await executor("workflow_save", { name: "tmp", yaml: VALID_WORKFLOW });
  await executor("workflow_delete", { name: "tmp" });

  const getResult = await executor("workflow_get", { name: "tmp" });
  const got = JSON.parse(getResult!);
  assertEquals(got.error.includes("not found"), true);
});

Deno.test("workflow tools: run executes inline YAML", async () => {
  const store = createWorkflowStore(createMemoryStorage());
  const executor = createWorkflowToolExecutor({
    store,
    toolExecutor: () => Promise.resolve(JSON.stringify({ ok: true })),
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
  });

  const result = await executor("workflow_run", { yaml: VALID_WORKFLOW });
  assertEquals(result !== null, true);
  const run = JSON.parse(result!);
  assertEquals(run.status, "completed");
  assertEquals(run.output.message, "hello");
});

Deno.test("workflow tools: run executes saved workflow by name", async () => {
  const store = createWorkflowStore(createMemoryStorage());
  const executor = createWorkflowToolExecutor({
    store,
    toolExecutor: () => Promise.resolve(JSON.stringify({ ok: true })),
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
  });

  await executor("workflow_save", { name: "saved-wf", yaml: VALID_WORKFLOW });
  const result = await executor("workflow_run", { name: "saved-wf" });
  assertEquals(result !== null, true);
  const run = JSON.parse(result!);
  assertEquals(run.status, "completed");
  assertEquals(run.output.message, "hello");
});

Deno.test("workflow tools: run with missing name and yaml returns error", async () => {
  const { executor } = createTestContext();
  const result = await executor("workflow_run", {});
  assertEquals(result !== null, true);
  const parsed = JSON.parse(result!);
  assertEquals(parsed.error.includes("requires"), true);
});

Deno.test("workflow tools: history shows past runs", async () => {
  const store = createWorkflowStore(createMemoryStorage());
  const executor = createWorkflowToolExecutor({
    store,
    toolExecutor: () => Promise.resolve(JSON.stringify({ ok: true })),
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
  });

  await executor("workflow_run", { yaml: VALID_WORKFLOW });
  await executor("workflow_run", { yaml: VALID_WORKFLOW });

  const histResult = await executor("workflow_history", {});
  assertEquals(histResult !== null, true);
  const hist = JSON.parse(histResult!);
  assertEquals(hist.runs.length, 2);
});

Deno.test("workflow tools: save missing params returns error", async () => {
  const { executor } = createTestContext();

  const result = await executor("workflow_save", { name: "x" });
  assertEquals(result!.startsWith("WORKFLOW_SAVE_FAILED:"), true);
  assertEquals(result!.includes("Missing required parameters"), true);
});

Deno.test("workflow tools: get missing name returns error", async () => {
  const { executor } = createTestContext();

  const result = await executor("workflow_get", {});
  const parsed = JSON.parse(result!);
  assertEquals(parsed.error.includes("requires"), true);
});
