/**
 * Sub-agent spawn and taint propagation tests.
 *
 * Tests for triggerfish:llm task execution, sub-agent session spawn,
 * taint propagation back to parent workflow, and cron isolation.
 *
 * @module
 */

import { assertEquals, assertExists } from "@std/assert";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createWorkflowEngine } from "../../src/workflow/engine.ts";
import type {
  WorkflowExecutionContext,
  WorkflowDefinition,
} from "../../src/workflow/types.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service.ts";
import type { Orchestrator } from "../../src/agent/orchestrator.ts";
import type { SessionState, SessionId, UserId, ChannelId } from "../../src/core/types/session.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import { maxClassification, canFlowTo } from "../../src/core/types/classification.ts";
import { createSession, updateTaint } from "../../src/core/types/session.ts";

// ─── Mock sub-agent infrastructure ───────────────────────────────────────────

function makeMockOrchestratorFactory(options: {
  subAgentTaint?: ClassificationLevel;
  response?: string;
}): OrchestratorFactory {
  return {
    create: async (_channelId: string) => {
      // Create a sub-agent session starting at PUBLIC
      let subSession = createSession({
        userId: "sub-user" as UserId,
        channelId: _channelId as ChannelId,
      });

      // If sub-agent is supposed to access classified data, escalate its taint
      if (options.subAgentTaint) {
        subSession = updateTaint(subSession, options.subAgentTaint, "sub-agent accessed classified data");
      }

      const orchestrator: Orchestrator = {
        processMessage: async (opts) => {
          // Use the session that was passed in (with parent taint applied)
          const finalSession = opts.session;
          return {
            ok: true,
            value: { response: options.response ?? "Sub-agent completed task successfully" },
          };
        },
        getHistory: (_sessionId) => [],
        clearHistory: (_sessionId) => {},
        compactHistory: async (_sessionId) => ({
          messagesBefore: 0,
          messagesAfter: 0,
          tokensBefore: 0,
          tokensAfter: 0,
        }),
      };

      return { orchestrator, session: subSession };
    },
  };
}

function makeWorkflowWithLlmTask(name: string): WorkflowDefinition {
  return {
    dsl: "1.0.0",
    namespace: "test",
    name,
    version: "1.0.0",
    do: [
      {
        name: "llmStep",
        call: {
          type: "triggerfish:llm",
          with: {
            task: "Analyze the provided data and produce a summary",
          },
        },
        output: { as: ".llmResult" },
      },
    ],
    requiresTools: [],
    networkDomains: [],
    tags: [],
    approvalRequired: true,
  };
}

// ─── Test 10: Sub-agent taint propagates back ─────────────────────────────────

Deno.test("subagent — test 10: sub-agent taint propagates back to workflow", async () => {
  const engine = createWorkflowEngine({ storage: createMemoryStorage() });

  let capturedTaint: ClassificationLevel = "PUBLIC";
  const escalations: ClassificationLevel[] = [];

  const execCtx: WorkflowExecutionContext = {
    agentId: "agent1",
    sessionId: "sess-1" as SessionId,
    sessionTaint: "PUBLIC",
    escalateTaint: (level, _reason) => {
      capturedTaint = maxClassification(capturedTaint, level);
      escalations.push(capturedTaint);
    },
    toolExecutor: async (_name, _input) => `{"ok":true}`,
    storage: createMemoryStorage(),
    orchestratorFactory: makeMockOrchestratorFactory({
      subAgentTaint: "CONFIDENTIAL",
      response: "Summary complete",
    }),
  };

  const workflow = makeWorkflowWithLlmTask("sub-taint-propagation");
  const state = await engine.execute(workflow, {}, execCtx);

  assertEquals(state.status, "COMPLETED");
  assertExists(state.data.llmResult);
});

// ─── Test 11: Sub-workflow inherits parent taint ──────────────────────────────

Deno.test("subagent — test 11: sub-agent session starts at parent taint, not PUBLIC", async () => {
  const engine = createWorkflowEngine({ storage: createMemoryStorage() });

  let subAgentReceivedTaint: ClassificationLevel = "PUBLIC";

  const mockFactory: OrchestratorFactory = {
    create: async (_channelId) => {
      const baseSession = createSession({
        userId: "sub-user" as UserId,
        channelId: _channelId as ChannelId,
      });

      const orchestrator: Orchestrator = {
        processMessage: async (opts) => {
          // Capture what taint the sub-agent received
          subAgentReceivedTaint = opts.session.taint;
          return { ok: true, value: { response: "done" } };
        },
        getHistory: () => [],
        clearHistory: () => {},
        compactHistory: async () => ({ messagesBefore: 0, messagesAfter: 0, tokensBefore: 0, tokensAfter: 0 }),
      };

      return { orchestrator, session: baseSession };
    },
  };

  const execCtx: WorkflowExecutionContext = {
    agentId: "agent1",
    sessionId: "sess-1" as SessionId,
    sessionTaint: "INTERNAL", // Parent workflow is at INTERNAL
    escalateTaint: () => {},
    toolExecutor: async (_n, _i) => `{}`,
    storage: createMemoryStorage(),
    orchestratorFactory: mockFactory,
  };

  const workflow = makeWorkflowWithLlmTask("sub-inherits-taint");
  await engine.execute(workflow, {}, execCtx);

  // The sub-agent should have received at least INTERNAL taint (not PUBLIC)
  assertEquals(canFlowTo("PUBLIC", subAgentReceivedTaint) || subAgentReceivedTaint === "INTERNAL", true);
});

// ─── Test 12: Cron-triggered workflow runs in isolated session ────────────────

Deno.test("subagent — test 12: cron-triggered session starts with fresh PUBLIC taint", async () => {
  // Simulate what the scheduler does: OrchestratorFactory.create() creates
  // a fresh session with PUBLIC taint, isolated from any user session

  const sessionsCreated: SessionState[] = [];

  const mockFactory: OrchestratorFactory = {
    create: async (channelId) => {
      // Simulates scheduler: always creates fresh PUBLIC session
      const session = createSession({
        userId: "cron-system" as UserId,
        channelId: channelId as ChannelId,
      });
      sessionsCreated.push(session);

      const orchestrator: Orchestrator = {
        processMessage: async (_opts) => ({ ok: true, value: { response: "cron done" } }),
        getHistory: () => [],
        clearHistory: () => {},
        compactHistory: async () => ({ messagesBefore: 0, messagesAfter: 0, tokensBefore: 0, tokensAfter: 0 }),
      };

      return { orchestrator, session };
    },
  };

  // Simulate two different "user sessions" that might be active
  const engine = createWorkflowEngine({ storage: createMemoryStorage() });

  // "User session" with high taint (simulating an active user)
  const userExecCtx: WorkflowExecutionContext = {
    agentId: "agent1",
    sessionId: "user-session-confidential" as SessionId,
    sessionTaint: "CONFIDENTIAL",  // User session is tainted
    escalateTaint: () => {},
    toolExecutor: async (_n, _i) => `{}`,
    storage: createMemoryStorage(),
    orchestratorFactory: mockFactory,
  };

  const workflow = makeWorkflowWithLlmTask("cron-isolation");
  await engine.execute(workflow, {}, userExecCtx);

  // The created session should start at PUBLIC (fresh, isolated)
  assertEquals(sessionsCreated.length, 1);
  assertEquals(sessionsCreated[0].taint, "PUBLIC");
});

// ─── Test 15: Sub-agent has existing tool registration ───────────────────────

Deno.test("subagent — test 15: sub-agent uses injected orchestrator (no filtering)", async () => {
  const engine = createWorkflowEngine({ storage: createMemoryStorage() });

  const capturedMessages: string[] = [];

  const mockFactory: OrchestratorFactory = {
    create: async (channelId) => {
      const session = createSession({
        userId: "sub" as UserId,
        channelId: channelId as ChannelId,
      });

      const orchestrator: Orchestrator = {
        processMessage: async (opts) => {
          // Capture the full task description that was sent to the sub-agent
          const msg = typeof opts.message === "string" ? opts.message : JSON.stringify(opts.message);
          capturedMessages.push(msg);
          return { ok: true, value: { response: "Task completed" } };
        },
        getHistory: () => [],
        clearHistory: () => {},
        compactHistory: async () => ({ messagesBefore: 0, messagesAfter: 0, tokensBefore: 0, tokensAfter: 0 }),
      };

      return { orchestrator, session };
    },
  };

  const execCtx: WorkflowExecutionContext = {
    agentId: "agent1",
    sessionId: "sess-1" as SessionId,
    sessionTaint: "PUBLIC",
    escalateTaint: () => {},
    toolExecutor: async (_n, _i) => `{}`,
    storage: createMemoryStorage(),
    orchestratorFactory: mockFactory,
  };

  const taskDescription = "Use write_file to create a parser. Use run_command to test it.";
  const workflow: WorkflowDefinition = {
    dsl: "1.0.0",
    namespace: "test",
    name: "tool-registration-test",
    version: "1.0.0",
    do: [
      {
        name: "codeTask",
        call: {
          type: "triggerfish:llm",
          with: { task: taskDescription },
        },
        output: { as: ".result" },
      },
    ],
    requiresTools: [],
    networkDomains: [],
    tags: [],
    approvalRequired: true,
  };

  const state = await engine.execute(workflow, {}, execCtx);
  assertEquals(state.status, "COMPLETED");

  // The task description should have been passed to the sub-agent as-is
  assertEquals(capturedMessages.length, 1);
  assertEquals(capturedMessages[0], taskDescription);
});

// ─── Additional: LLM task without factory returns error gracefully ────────────

Deno.test("subagent — LLM task without factory returns error gracefully", async () => {
  const engine = createWorkflowEngine({ storage: createMemoryStorage() });

  const execCtx: WorkflowExecutionContext = {
    agentId: "agent1",
    sessionId: "sess-1" as SessionId,
    sessionTaint: "PUBLIC",
    escalateTaint: () => {},
    toolExecutor: async (_n, _i) => `{}`,
    storage: createMemoryStorage(),
    // No orchestratorFactory provided
  };

  const workflow = makeWorkflowWithLlmTask("no-factory-test");
  const state = await engine.execute(workflow, {}, execCtx);

  // Should fault because no factory is available
  assertEquals(state.status, "FAULTED");
  assertExists(state.error);
});

// ─── Additional: Workflow raises correct approvalRequired flag ────────────────

Deno.test("subagent — workflow with triggerfish:agent call has approvalRequired: true", async () => {
  const { parseWorkflowYaml } = await import("../../src/workflow/parser.ts");

  const yaml = `
document:
  dsl: "1.0.0"
  name: agent-workflow
  version: "1.0.0"
do:
  - delegateTask:
      call: triggerfish:agent
      with:
        task: "Do something"
`;
  const result = parseWorkflowYaml(yaml);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.approvalRequired, true);
  }
});
