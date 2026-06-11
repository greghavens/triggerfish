import { assertEquals } from "@std/assert";
import { createWorkflowStore } from "../../src/workflow/store.ts";
import type { StorageProvider } from "../../src/core/storage/provider.ts";
import type { WorkflowRunResult } from "../../src/workflow/types.ts";

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

const SAMPLE_YAML = `
document:
  dsl: "1.0"
  namespace: test
  name: sample
do:
  - step:
      set:
        x: 1
`;

Deno.test("WorkflowStore: save and load definition", async () => {
  const store = createWorkflowStore(createMemoryStorage());

  await store.saveWorkflowDefinition(
    "my-wf",
    SAMPLE_YAML,
    "PUBLIC",
    "A test workflow",
  );
  const loaded = await store.loadWorkflowDefinition("my-wf", "PUBLIC");

  assertEquals(loaded !== null, true);
  assertEquals(loaded?.name, "my-wf");
  assertEquals(loaded?.yaml, SAMPLE_YAML);
  assertEquals(loaded?.classification, "PUBLIC");
  assertEquals(loaded?.description, "A test workflow");
});

Deno.test("WorkflowStore: load returns null for missing workflow", async () => {
  const store = createWorkflowStore(createMemoryStorage());
  const loaded = await store.loadWorkflowDefinition("nope", "PUBLIC");
  assertEquals(loaded, null);
});

Deno.test("WorkflowStore: classification gating on load", async () => {
  const store = createWorkflowStore(createMemoryStorage());

  await store.saveWorkflowDefinition("secret-wf", SAMPLE_YAML, "CONFIDENTIAL");

  const publicSession = await store.loadWorkflowDefinition(
    "secret-wf",
    "PUBLIC",
  );
  assertEquals(publicSession, null);

  const confSession = await store.loadWorkflowDefinition(
    "secret-wf",
    "CONFIDENTIAL",
  );
  assertEquals(confSession !== null, true);

  const restrictedSession = await store.loadWorkflowDefinition(
    "secret-wf",
    "RESTRICTED",
  );
  assertEquals(restrictedSession !== null, true);
});

Deno.test("WorkflowStore: list filters by classification", async () => {
  const store = createWorkflowStore(createMemoryStorage());

  await store.saveWorkflowDefinition("public-wf", SAMPLE_YAML, "PUBLIC");
  await store.saveWorkflowDefinition("conf-wf", SAMPLE_YAML, "CONFIDENTIAL");
  await store.saveWorkflowDefinition("internal-wf", SAMPLE_YAML, "INTERNAL");

  const publicList = await store.listWorkflowDefinitions("PUBLIC");
  assertEquals(publicList.length, 1);
  assertEquals(publicList[0].name, "public-wf");

  const internalList = await store.listWorkflowDefinitions("INTERNAL");
  assertEquals(internalList.length, 2); // PUBLIC + INTERNAL

  const confList = await store.listWorkflowDefinitions("CONFIDENTIAL");
  assertEquals(confList.length, 3);
});

Deno.test("WorkflowStore: delete removes definition", async () => {
  const store = createWorkflowStore(createMemoryStorage());

  await store.saveWorkflowDefinition("tmp-wf", SAMPLE_YAML, "PUBLIC");
  await store.deleteWorkflowDefinition("tmp-wf");

  const loaded = await store.loadWorkflowDefinition("tmp-wf", "PUBLIC");
  assertEquals(loaded, null);
});

Deno.test("WorkflowStore: save and load run", async () => {
  const store = createWorkflowStore(createMemoryStorage());

  const run: WorkflowRunResult = {
    runId: "run-123",
    workflowName: "test-wf",
    status: "completed",
    output: { result: "ok" },
    events: [],
    startedAt: "2026-03-09T10:00:00Z",
    completedAt: "2026-03-09T10:01:00Z",
    taskCount: 3,
  };

  await store.saveWorkflowRun(run);
  const loaded = await store.loadWorkflowRun("run-123", "RESTRICTED");

  assertEquals(loaded !== null, true);
  assertEquals(loaded?.runId, "run-123");
  assertEquals(loaded?.status, "completed");
});

Deno.test("WorkflowStore: list runs sorted by date descending", async () => {
  const store = createWorkflowStore(createMemoryStorage());

  const run1: WorkflowRunResult = {
    runId: "run-1",
    workflowName: "wf",
    status: "completed",
    output: {},
    events: [],
    startedAt: "2026-03-09T10:00:00Z",
    completedAt: "2026-03-09T10:01:00Z",
    taskCount: 1,
  };

  const run2: WorkflowRunResult = {
    ...run1,
    runId: "run-2",
    startedAt: "2026-03-09T11:00:00Z",
    completedAt: "2026-03-09T11:01:00Z",
  };

  await store.saveWorkflowRun(run1);
  await store.saveWorkflowRun(run2);

  const runs = await store.listWorkflowRuns("RESTRICTED");
  assertEquals(runs.length, 2);
  assertEquals(runs[0].runId, "run-2"); // Most recent first
  assertEquals(runs[1].runId, "run-1");
});

Deno.test("WorkflowStore: list runs filtered by workflow name", async () => {
  const store = createWorkflowStore(createMemoryStorage());

  const baseRun: WorkflowRunResult = {
    runId: "run-a",
    workflowName: "alpha",
    status: "completed",
    output: {},
    events: [],
    startedAt: "2026-03-09T10:00:00Z",
    completedAt: "2026-03-09T10:01:00Z",
    taskCount: 1,
  };

  await store.saveWorkflowRun(baseRun);
  await store.saveWorkflowRun({
    ...baseRun,
    runId: "run-b",
    workflowName: "beta",
  });

  const alphaRuns = await store.listWorkflowRuns("RESTRICTED", {
    workflowName: "alpha",
  });
  assertEquals(alphaRuns.length, 1);
  assertEquals(alphaRuns[0].workflowName, "alpha");
});

Deno.test("WorkflowStore: list runs with limit", async () => {
  const store = createWorkflowStore(createMemoryStorage());

  const baseRun: WorkflowRunResult = {
    runId: "run-1",
    workflowName: "wf",
    status: "completed",
    output: {},
    events: [],
    startedAt: "2026-03-09T10:00:00Z",
    completedAt: "2026-03-09T10:01:00Z",
    taskCount: 1,
  };

  for (let i = 0; i < 5; i++) {
    await store.saveWorkflowRun({
      ...baseRun,
      runId: `run-${i}`,
      startedAt: `2026-03-09T1${i}:00:00Z`,
    });
  }

  const limited = await store.listWorkflowRuns("RESTRICTED", { limit: 3 });
  assertEquals(limited.length, 3);
});

// --- Unclassified runs fail closed (INTEGRATIONS-CLI-4) ---

Deno.test("WorkflowStore: unclassified run is RESTRICTED for load", async () => {
  const store = createWorkflowStore(createMemoryStorage());

  const run: WorkflowRunResult = {
    runId: "run-unclassified",
    workflowName: "wf",
    status: "completed",
    output: { secret: "data" },
    events: [],
    startedAt: "2026-03-09T10:00:00Z",
    completedAt: "2026-03-09T10:01:00Z",
    taskCount: 1,
    // classification deliberately omitted
  };
  await store.saveWorkflowRun(run);

  // Lower-taint sessions must never read an unclassified run down.
  assertEquals(await store.loadWorkflowRun("run-unclassified", "PUBLIC"), null);
  assertEquals(
    await store.loadWorkflowRun("run-unclassified", "CONFIDENTIAL"),
    null,
  );

  // A RESTRICTED session can still read it.
  const loaded = await store.loadWorkflowRun("run-unclassified", "RESTRICTED");
  assertEquals(loaded?.runId, "run-unclassified");
});

Deno.test("WorkflowStore: unclassified run is RESTRICTED for listing", async () => {
  const store = createWorkflowStore(createMemoryStorage());

  await store.saveWorkflowRun({
    runId: "run-open",
    workflowName: "wf",
    status: "completed",
    output: {},
    events: [],
    startedAt: "2026-03-09T10:00:00Z",
    completedAt: "2026-03-09T10:01:00Z",
    taskCount: 1,
    classification: "PUBLIC",
  });
  await store.saveWorkflowRun({
    runId: "run-unclassified",
    workflowName: "wf",
    status: "completed",
    output: {},
    events: [],
    startedAt: "2026-03-09T11:00:00Z",
    completedAt: "2026-03-09T11:01:00Z",
    taskCount: 1,
  });

  const publicRuns = await store.listWorkflowRuns("PUBLIC");
  assertEquals(publicRuns.length, 1);
  assertEquals(publicRuns[0].runId, "run-open");

  const restrictedRuns = await store.listWorkflowRuns("RESTRICTED");
  assertEquals(restrictedRuns.length, 2);
});
