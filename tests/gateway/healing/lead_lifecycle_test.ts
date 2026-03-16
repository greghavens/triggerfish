import { assertEquals } from "@std/assert";
import { spawnHealingLead } from "../../../src/gateway/healing/lead_lifecycle.ts";
import type { SessionId } from "../../../src/core/types/session.ts";

Deno.test("spawnHealingLead: spawns with correct context bundle", async () => {
  let spawnedPrompt = "";
  let spawnedTaint = "";
  let terminated = false;

  const handle = await spawnHealingLead({
    workflowDefinition:
      "document:\n  dsl: '1.0'\n  namespace: test\n  name: wf",
    workflowName: "test-wf",
    runInput: { invoiceId: "inv-123" },
    runHistory: [{ status: "completed", output: { result: "ok" } }],
    lastSuccessfulRun: { status: "completed", output: { result: "ok" } },
    rejectedProposals: [],
    config: {
      enabled: true,
      pause_on_intervention: "blocking_only",
      pause_timeout_seconds: 300,
      pause_timeout_policy: "escalate_and_halt",
      retry_budget: 3,
      approval_required: true,
      notify_on: [],
      run_history_window: 10,
    },
    initialTaint: "PUBLIC",
    spawnSession: (opts) => {
      spawnedPrompt = opts.systemPrompt;
      spawnedTaint = opts.taint;
      return Promise.resolve("session-1" as SessionId);
    },
    terminateSession: () => {
      terminated = true;
      return Promise.resolve();
    },
  });

  assertEquals(handle.sessionId, "session-1");
  assertEquals(spawnedTaint, "PUBLIC");
  assertEquals(
    spawnedPrompt.includes("Self-Healing Workflow Lead Agent"),
    true,
  );
  assertEquals(spawnedPrompt.includes("name: wf"), true);
  assertEquals(spawnedPrompt.includes("inv-123"), true);
  assertEquals(spawnedPrompt.includes("Retry budget: 3"), true);

  await handle.teardown();
  assertEquals(terminated, true);
});

Deno.test("spawnHealingLead: includes rejected proposals in prompt", async () => {
  let spawnedPrompt = "";

  await spawnHealingLead({
    workflowDefinition: "yaml",
    workflowName: "wf",
    runInput: {},
    runHistory: [],
    rejectedProposals: [{
      versionId: "v1",
      workflowName: "wf",
      agentId: "a1",
      versionNumber: 1,
      definition: "yaml",
      diff: "diff",
      status: "REJECTED",
      source: "self_healing",
      authorReasoning: "Fix step X",
      proposedAt: "2026-01-01T00:00:00Z",
      resolvedBy: "reviewer-1",
    }],
    config: {
      enabled: true,
      pause_on_intervention: "blocking_only",
      pause_timeout_seconds: 300,
      pause_timeout_policy: "escalate_and_halt",
      retry_budget: 3,
      approval_required: true,
      notify_on: [],
      run_history_window: 10,
    },
    initialTaint: "INTERNAL",
    spawnSession: (opts) => {
      spawnedPrompt = opts.systemPrompt;
      return Promise.resolve("session-2" as SessionId);
    },
    terminateSession: () => Promise.resolve(),
  });

  assertEquals(spawnedPrompt.includes("Fix step X"), true);
  assertEquals(spawnedPrompt.includes("Do NOT re-propose"), true);
});
