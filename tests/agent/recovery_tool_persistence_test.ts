import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { createMessageStore } from "../../src/core/conversation/conversation_store.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createHookRunner,
  type HookLogEntry,
} from "../../src/core/policy/hooks/hooks.ts";
import { createMemorySecretStore } from "../../src/core/secrets/backends/memory_store.ts";
import { createLineageStore } from "../../src/core/session/lineage_store.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { AgentTurnCheckpoint } from "../../src/core/types/orchestrator.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";

const tools = ["echo_fixture", "throw_fixture", "unsafe_fixture"].map((
  name,
) => ({
  name,
  description: "Exercise protected tool handling.",
  parameters: { input: { type: "string", description: "Fixture input" } },
}));

function invocation(name: string, input: string) {
  return {
    id: name,
    type: "function",
    function: { name, arguments: JSON.stringify({ input }) },
  };
}

function session() {
  return createSession({
    userId: "fixture" as UserId,
    channelId: "test" as ChannelId,
  });
}

Deno.test("Recovery records every tool batch before dispatch and keeps resolved secrets out of durable and visible output", async () => {
  const syntheticSecret = "fixture-only-value-80c91fe46";
  const reference = "{{secret:fixture}}";
  const unapprovedInput = "unapproved input literal";
  const unapprovedOutput = "unapproved server response";
  const intermediateReasoning = "private interim provider reasoning";
  const prompt =
    "Run the protected fixture with an unpersisted initiating prompt.";
  const finalResponse = "Completed the protected review.";
  const secretStore = createMemorySecretStore();
  assert((await secretStore.setSecret("fixture", syntheticSecret)).ok);
  const messageStore = createMessageStore(createMemoryStorage());
  const lineageStore = createLineageStore(createMemoryStorage());
  const lineageInputs: unknown[] = [];
  const audit: HookLogEntry[] = [];
  const hookInputs: unknown[] = [];
  const events: unknown[] = [];
  const execution: string[] = [];
  const providerRegistry = createProviderRegistry();
  let providerCalls = 0;
  let replayedResults: unknown;
  let checkpoint: AgentTurnCheckpoint | undefined;
  providerRegistry.register({
    name: "fixture",
    supportsStreaming: false,
    complete(messages) {
      const toolCalls = ++providerCalls === 1
        ? [
          invocation("echo_fixture", reference),
          invocation("throw_fixture", reference),
          invocation("unsafe_fixture", unapprovedInput),
        ]
        : [];
      if (!toolCalls.length) {
        replayedResults = messages.filter(({ role }) => role === "tool");
      }
      return Promise.resolve({
        content: toolCalls.length
          ? "Intermediate provider prose."
          : finalResponse,
        reasoning: intermediateReasoning,
        toolCalls,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  });
  providerRegistry.setDefault("fixture");
  const hooks = createHookRunner(createPolicyEngine(), {
    logger: { log: (entry) => audit.push(entry) },
  });
  const agent = createOrchestrator({
    providerRegistry,
    secretStore,
    messageStore,
    lineageStore: {
      ...lineageStore,
      create(input) {
        lineageInputs.push(input);
        return lineageStore.create(input);
      },
    },
    isOwnerSession: () => true,
    getSessionTaint: () => "INTERNAL",
    hookRunner: {
      evaluateHook(hook, context) {
        if (hook === "PRE_TOOL_CALL") hookInputs.push(context.input);
        return hooks.evaluateHook(hook, context);
      },
    },
    tools,
    onEvent: (event) => events.push(event),
    toolExecutor(name, { input }) {
      assertEquals(execution[0], "marked");
      execution.push(name);
      if (name === "unsafe_fixture") return Promise.resolve(unapprovedOutput);
      assertEquals(input, syntheticSecret);
      if (name === "throw_fixture") throw new Error(`Private error: ${input}`);
      return Promise.resolve(`Private response: ${input}`);
    },
  });
  const currentSession = session();
  const result = await agent.executeAgentTurn({
    session: currentSession,
    message: prompt,
    targetClassification: "INTERNAL",
    beforeToolBatch(batch, calls) {
      assertEquals(batch, 1);
      assertEquals(
        calls.map(({ name }) => name),
        tools.map(({ name }) => name),
      );
      assertEquals(calls[2].args.input, unapprovedInput);
      execution.push("marked");
      return Promise.resolve();
    },
    toolPersistence: {
      projectCall: ({ name }) =>
        name === "unsafe_fixture" ? undefined : { input: "Approved metadata" },
      projectResult: (_call, { text }) => text,
    },
    onToolBatchCheckpoint(value) {
      checkpoint = value;
      return Promise.resolve();
    },
  });
  assert(result.ok);
  assertEquals(result.value.response, finalResponse);
  assertEquals(execution, [
    "marked",
    "echo_fixture",
    "throw_fixture",
    "unsafe_fixture",
  ]);
  assert(checkpoint);
  assertEquals(checkpoint.history[0].content, prompt);
  assertStringIncludes(JSON.stringify(hookInputs), reference);
  assertStringIncludes(JSON.stringify(hookInputs), unapprovedInput);
  assert(!JSON.stringify(hookInputs).includes(syntheticSecret));
  const transcript = await messageStore.loadSession(currentSession.id);
  const durable = JSON.stringify([audit, transcript, lineageInputs]);
  assert(!durable.includes(prompt));
  assert(!durable.includes(finalResponse));
  const projected = JSON.stringify([
    audit.filter(({ hook }) => hook === "PRE_TOOL_CALL"),
    transcript,
    events,
    lineageInputs,
    replayedResults,
    checkpoint.history.filter(({ role }) => role === "tool"),
  ]);
  assertStringIncludes(projected, "Approved metadata");
  assertStringIncludes(projected, "protected arguments were used");
  assertStringIncludes(projected, "protected tool invocation failed");
  for (
    const withheld of [
      syntheticSecret,
      reference,
      unapprovedInput,
      unapprovedOutput,
      intermediateReasoning,
      prompt,
    ]
  ) {
    assert(!projected.includes(withheld));
  }
});

Deno.test("Classified recovery rechecks current tool policy and restores taint before provider or persistence", async () => {
  const message = "Read an already-approved saved result.";
  const savedCall = invocation("echo_fixture", "Unprojected audit fixture");
  const checkpoint: AgentTurnCheckpoint = {
    history: [
      { role: "user", content: "Earlier conversation." },
      { role: "assistant", content: "Earlier reply." },
      { role: "user", content: message },
      { role: "assistant", content: " ", tool_calls: [savedCall] },
      {
        role: "tool",
        content: "Approved saved output.",
        tool_call_id: savedCall.id,
      },
    ],
    completedIterations: 1,
    tokenUsage: { inputTokens: 1, outputTokens: 2 },
    nudgeCount: 0,
    eosRetries: 0,
    toolCallCounts: [],
  };
  const registry = createProviderRegistry();
  let wrongProvider = 0;
  let classifiedCalls = 0;
  let invoked = 0;
  let bumpersDeny = false;
  let policyDeny = false;
  const restored: string[] = [];
  const audit: HookLogEntry[] = [];
  registry.register({
    name: "public",
    supportsStreaming: false,
    complete() {
      wrongProvider++;
      return Promise.resolve({
        content: "Unexpected.",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  });
  registry.setDefault("public");
  registry.registerClassificationOverride("INTERNAL", {
    name: "internal",
    supportsStreaming: false,
    complete(messages) {
      classifiedCalls++;
      assertEquals(restored, ["INTERNAL"]);
      assertStringIncludes(JSON.stringify(messages), "Approved saved output.");
      return Promise.resolve({
        content: "Reviewed the approved saved result.",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  });
  const hookRunner = createHookRunner(createPolicyEngine(), {
    logger: { log: (entry) => audit.push(entry) },
  });
  const messageStore = createMessageStore(createMemoryStorage());
  const agent = createOrchestrator({
    providerRegistry: registry,
    messageStore,
    tools,
    escalateTaint: (level) => restored.push(level),
    checkBumpersBlock: () => bumpersDeny ? "Blocked fixture" : null,
    hookRunner: {
      evaluateHook(name, context) {
        assertEquals(context.session.taint, "INTERNAL");
        if (name === "PRE_TOOL_CALL") {
          assertStringIncludes(
            JSON.stringify(context.input),
            "Unprojected audit fixture",
          );
          if (policyDeny) {
            return Promise.resolve({
              allowed: false,
              action: "BLOCK",
              ruleId: "fixture",
              duration: 0,
            });
          }
        }
        return hookRunner.evaluateHook(name, context);
      },
    },
    toolExecutor() {
      invoked++;
      return Promise.resolve("Saved tools must not run again.");
    },
  });
  const current = session();
  const options = {
    session: current,
    message,
    targetClassification: "INTERNAL" as const,
    resume: checkpoint,
    resumeMessageIndex: 2,
    resumeClassification: "INTERNAL" as const,
    resumeToolCalls: [{
      name: "echo_fixture",
      id: savedCall.id,
      args: { input: "Unprojected audit fixture" },
    }],
    toolPersistence: {
      projectCall: () => ({ input: "Audited projection" }),
      projectResult: () => undefined,
    },
  };
  assert(
    !(await agent.executeAgentTurn({
      ...options,
      targetClassification: "PUBLIC",
    })).ok,
  );
  bumpersDeny = true;
  assert(!(await agent.executeAgentTurn(options)).ok);
  bumpersDeny = false;
  policyDeny = true;
  assert(!(await agent.executeAgentTurn(options)).ok);
  assertEquals(restored, []);
  assertEquals(classifiedCalls, 0);
  policyDeny = false;
  assert((await agent.executeAgentTurn(options)).ok);
  assertEquals(invoked, 0);
  assertEquals(wrongProvider, 0);
  assertEquals(classifiedCalls, 1);
  const records = await messageStore.loadSession(current.id);
  assertEquals(records, []);
  const pretoolAudit = JSON.stringify(
    audit.find(({ hook }) => hook === "PRE_TOOL_CALL"),
  );
  assertStringIncludes(pretoolAudit, "Audited projection");
  assert(!pretoolAudit.includes("Unprojected audit fixture"));
});

Deno.test("An unsuccessful recovery uncertainty write prevents dispatch of an unapproved tool", async () => {
  const registry = createProviderRegistry();
  registry.register({
    name: "fixture",
    supportsStreaming: false,
    complete: () =>
      Promise.resolve({
        content: "",
        toolCalls: [invocation("unsafe_fixture", "unapproved")],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
  });
  registry.setDefault("fixture");
  let invoked = 0;
  const agent = createOrchestrator({
    providerRegistry: registry,
    hookRunner: createHookRunner(createPolicyEngine()),
    tools,
    toolExecutor() {
      invoked++;
      return Promise.resolve("Should never run.");
    },
  });
  const result = await agent.executeAgentTurn({
    session: session(),
    message: "Run the protected fixture.",
    targetClassification: "INTERNAL",
    beforeToolBatch(_batch, calls) {
      assertEquals(calls[0].name, "unsafe_fixture");
      return Promise.reject(new Error("Pending record storage failed."));
    },
    toolPersistence: {
      projectCall: () => undefined,
      projectResult: () => undefined,
    },
  });
  assertEquals(invoked, 0);
  assertEquals(result, {
    ok: false,
    error: "The agent tool batch could not be recorded before dispatch",
  });
});
