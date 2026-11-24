import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createProviderRegistry,
  type LlmProvider,
} from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import type { AgentTurnCheckpoint } from "../../src/core/types/orchestrator.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";

const usage = { inputTokens: 3, outputTokens: 2 };
const message = "Read the approved evidence.";
const toolCalls = ["first", "second"].map((id) => ({
  id,
  type: "function",
  function: { name: "read_evidence", arguments: JSON.stringify({ id }) },
}));

function fixture(
  complete: LlmProvider["complete"],
  runTool: (id: unknown) => string,
  preContext = () => {},
  iterations = 2,
) {
  const providerRegistry = createProviderRegistry();
  providerRegistry.register({
    name: "fixture",
    supportsStreaming: false,
    complete,
  });
  providerRegistry.setDefault("fixture");
  return createOrchestrator({
    providerRegistry,
    hookRunner: {
      evaluateHook(hook) {
        if (hook === "PRE_CONTEXT_INJECTION") preContext();
        return Promise.resolve({
          allowed: true,
          action: "ALLOW",
          ruleId: null,
          duration: 0,
        });
      },
    },
    tools: [{
      name: "read_evidence",
      description: "Read evidence.",
      parameters: { id: { type: "string", description: "Evidence ID" } },
    }],
    toolExecutor: (_name, args) => Promise.resolve(runTool(args.id)),
    maxIterations: iterations,
  });
}

function input() {
  return {
    session: createSession({
      userId: "fixture" as UserId,
      channelId: "test" as ChannelId,
    }),
    message,
    targetClassification: "INTERNAL" as const,
  };
}

Deno.test("Orchestrator awaits a full-batch checkpoint and resumes without resending the user or tool calls", async () => {
  const transportStarted = Promise.withResolvers<AgentTurnCheckpoint>();
  const releaseSave = Promise.withResolvers<void>();
  const controller = new AbortController();
  const executed: unknown[] = [];
  let initialProviderCalls = 0;
  const first = fixture(() => {
    initialProviderCalls++;
    return Promise.resolve({ content: "", toolCalls, usage });
  }, (id) => {
    executed.push(id);
    return `Exact result for ${id}`;
  });
  const original = first.executeAgentTurn({
    ...input(),
    signal: controller.signal,
    onToolBatchCheckpoint: async (checkpoint) => {
      transportStarted.resolve(checkpoint);
      await releaseSave.promise;
    },
  });
  const checkpoint = await Promise.race([
    transportStarted.promise,
    original.then(() => {
      throw new Error("Expected completed tool batch.");
    }),
  ]);
  assertEquals(initialProviderCalls, 1);
  assertEquals(executed, ["first", "second"]);
  assertEquals(checkpoint.completedIterations, 1);
  assertEquals(checkpoint.tokenUsage, usage);
  assertEquals(checkpoint.history.slice(0, 4).map(({ role }) => role), [
    "user",
    "assistant",
    "tool",
    "tool",
  ]);
  assertEquals(checkpoint.history[1].tool_calls, toolCalls);
  assertEquals(
    checkpoint.history.slice(2, 4).map(({ tool_call_id }) => tool_call_id),
    ["first", "second"],
  );
  assertStringIncludes(
    String(checkpoint.history[4].content),
    "remaining iterations",
  );
  controller.abort();
  releaseSave.resolve();
  assertEquals(await original, {
    ok: false,
    error: "Operation cancelled by user",
  });

  let resumedProviderCalls = 0;
  let guardCalls = 0;
  const resumed = fixture((messages) => {
    resumedProviderCalls++;
    assertEquals(messages.slice(1), [...checkpoint.history]);
    assertEquals(
      messages.filter(({ content }) => content === message).length,
      1,
    );
    return Promise.resolve({
      content: "Reviewed the exact saved evidence.",
      toolCalls: [],
      usage,
    });
  }, () => {
    throw new Error("Saved tool calls must not be re-executed");
  }, () => {
    guardCalls++;
  });
  const reply = await resumed.executeAgentTurn({
    ...input(),
    resume: checkpoint,
  });
  assert(reply.ok);
  assertEquals(reply.value.tokenUsage, { inputTokens: 6, outputTokens: 4 });
  assertEquals(resumedProviderCalls, 1);
  assertEquals(guardCalls, 1);
  const invalid = await resumed.executeAgentTurn({
    ...input(),
    message: "Different prompt",
    resume: checkpoint,
  });
  assertEquals(invalid, { ok: false, error: "Invalid agent turn checkpoint" });
  assertEquals(resumedProviderCalls, 1);
});

Deno.test("Orchestrator stops before the next model call if checkpoint persistence fails", async () => {
  let providerCalls = 0;
  const orchestrator = fixture(() => {
    providerCalls++;
    return Promise.resolve({ content: "", toolCalls, usage });
  }, () => "result");
  const result = await orchestrator.executeAgentTurn({
    ...input(),
    onToolBatchCheckpoint: () => Promise.reject(new Error("private failure")),
  });
  assertEquals(result, {
    ok: false,
    error: "The agent tool batch checkpoint could not be saved",
  });
  assertEquals(providerCalls, 1);
});

Deno.test("Orchestrator resume preserves the original hard iteration budget", async () => {
  const sample = fixture(
    () => Promise.resolve({ content: "", toolCalls, usage }),
    () => "result",
    undefined,
    1,
  );
  let checkpoint: AgentTurnCheckpoint | undefined;
  await sample.executeAgentTurn({
    ...input(),
    onToolBatchCheckpoint: (snapshot) => {
      checkpoint = snapshot;
      return Promise.reject(new Error("Interrupted before forced response"));
    },
  });
  assert(checkpoint);
  let calls = 0;
  const resumed = fixture(
    (messages, tools) => {
      calls++;
      assertEquals(tools, []);
      assertStringIncludes(
        String(messages.at(-1)?.content),
        "Iteration limit reached",
      );
      return Promise.resolve({
        content: "Reviewed saved results.",
        toolCalls: [],
        usage,
      });
    },
    () => {
      throw new Error("Remaining tool budget is exhausted");
    },
    undefined,
    1,
  );
  const result = await resumed.executeAgentTurn({
    ...input(),
    resume: checkpoint,
  });
  assert(result.ok);
  assertEquals(calls, 1);
});
