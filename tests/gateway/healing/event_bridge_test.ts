import { assertEquals } from "@std/assert";
import { createHealingEventBridge } from "../../../src/gateway/healing/event_bridge.ts";
import type { RichWorkflowEvent } from "../../../src/workflow/healing/types.ts";

function makeEvent(type: RichWorkflowEvent["type"]): RichWorkflowEvent {
  const base = {
    runId: "r1",
    workflowName: "wf",
    timestamp: new Date().toISOString(),
  };
  switch (type) {
    case "STEP_STARTED":
      return {
        ...base,
        type,
        taskName: "a",
        taskIndex: 0,
        taskDef: { name: "a", task: { type: "set", set: {} } },
        input: null,
        runningTaint: "PUBLIC" as const,
      };
    case "STEP_COMPLETED":
      return {
        ...base,
        type,
        taskName: "a",
        taskIndex: 0,
        output: {},
        duration: 100,
        taintAfter: "PUBLIC" as const,
      };
    case "WORKFLOW_COMPLETED":
      return { ...base, type, output: {}, taskCount: 1 };
    case "WORKFLOW_FAULTED":
      return { ...base, type, error: "fatal" };
    default:
      return {
        ...base,
        type: "STEP_COMPLETED",
        taskName: "a",
        taskIndex: 0,
        output: {},
        duration: 0,
        taintAfter: "PUBLIC" as const,
      };
  }
}

Deno.test("EventBridge: batches events and delivers to lead", async () => {
  const delivered: RichWorkflowEvent[][] = [];
  const bridge = createHealingEventBridge({
    deliverToLead: (events) => {
      delivered.push([...events]);
      return Promise.resolve();
    },
    batchWindowMs: 50,
  });

  bridge.enqueueEvent(makeEvent("STEP_STARTED"));
  bridge.enqueueEvent(makeEvent("STEP_COMPLETED"));

  await new Promise((r) => setTimeout(r, 100));

  assertEquals(delivered.length, 1);
  assertEquals(delivered[0].length, 2);

  await bridge.teardown();
});

Deno.test("EventBridge: terminal event flushes immediately", async () => {
  const delivered: RichWorkflowEvent[][] = [];
  const bridge = createHealingEventBridge({
    deliverToLead: (events) => {
      delivered.push([...events]);
      return Promise.resolve();
    },
    batchWindowMs: 5000,
  });

  bridge.enqueueEvent(makeEvent("STEP_STARTED"));
  bridge.enqueueEvent(makeEvent("WORKFLOW_COMPLETED"));

  await new Promise((r) => setTimeout(r, 50));

  assertEquals(delivered.length, 1);
  assertEquals(delivered[0].length, 2);

  await bridge.teardown();
});

Deno.test("EventBridge: teardown flushes pending events", async () => {
  const delivered: RichWorkflowEvent[][] = [];
  const bridge = createHealingEventBridge({
    deliverToLead: (events) => {
      delivered.push([...events]);
      return Promise.resolve();
    },
    batchWindowMs: 5000,
  });

  bridge.enqueueEvent(makeEvent("STEP_STARTED"));
  await bridge.teardown();

  assertEquals(delivered.length, 1);
  assertEquals(delivered[0].length, 1);
});

Deno.test("EventBridge: no events after teardown", async () => {
  const delivered: RichWorkflowEvent[][] = [];
  const bridge = createHealingEventBridge({
    deliverToLead: (events) => {
      delivered.push([...events]);
      return Promise.resolve();
    },
    batchWindowMs: 50,
  });

  await bridge.teardown();
  bridge.enqueueEvent(makeEvent("STEP_STARTED"));

  await new Promise((r) => setTimeout(r, 100));
  assertEquals(delivered.length, 0);
});
