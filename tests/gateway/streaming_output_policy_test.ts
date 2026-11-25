import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import type { OrchestratorEvent } from "../../src/agent/orchestrator/orchestrator_types.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
  type HookLogEntry,
} from "../../src/core/policy/hooks/hooks.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import type { LlmStreamChunk } from "../../src/core/types/llm.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";

const answer = "The requested control is active.";
const allowedReasoning = "Reasoning fixture ended. ";
const draft = "Internal draft before the control check.";
const fixtureTool = {
  name: "check_fixture_control",
  description: "Read a fixture control.",
  parameters: {},
};

for (
  const mode of [
    "deny_answer",
    "deny_reasoning",
    "deny_combined",
    "allow",
  ] as const
) {
  Deno.test(`Active gateway streaming applies destination policy (${mode})`, async () => {
    const marker = "Private marker across frames";
    const finalAnswer = mode === "deny_answer"
      ? `${answer} ${marker}.`
      : answer;
    const reasoning = mode === "deny_reasoning" ? marker : allowedReasoning;
    const denied = mode === "deny_combined" ? reasoning + answer : marker;
    const engine = createPolicyEngine();
    for (const rule of createDefaultRules()) engine.addRule(rule);
    engine.addRule({
      id: "fixture-deny-stream-content",
      priority: 999,
      hook: "PRE_OUTPUT",
      conditions: [{ field: "content", operator: "contains", value: denied }],
      action: "BLOCK",
    });
    const audit: HookLogEntry[] = [];
    const baseHooks = createHookRunner(engine, {
      logger: { log: (entry) => audit.push(entry) },
    });
    const enteredOutput = Promise.withResolvers<void>();
    const releaseOutput = Promise.withResolvers<void>();
    const registry = createProviderRegistry();
    let streamed = 0;
    registry.register({
      name: "stream-fixture",
      supportsStreaming: true,
      complete() {
        throw new Error("Fixture must use the streaming provider");
      },
      async *stream(): AsyncIterable<LlmStreamChunk> {
        await Promise.resolve();
        if (++streamed === 1 && mode === "allow") {
          yield { text: draft, reasoning: draft, done: false };
          yield {
            text: "",
            done: true,
            toolCalls: [{
              type: "function",
              id: "fixture-call",
              function: { name: fixtureTool.name, arguments: "{}" },
            }],
          };
          return;
        }
        const splitAnswer = mode === "deny_answer" ? answer.length + 9 : 12;
        const splitReasoning = 8;
        yield {
          text: finalAnswer.slice(0, splitAnswer),
          reasoning: reasoning.slice(0, splitReasoning),
          done: false,
        };
        yield {
          text: finalAnswer.slice(splitAnswer),
          reasoning: reasoning.slice(splitReasoning),
          done: true,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    registry.setDefault("stream-fixture");
    const storage = createMemoryStorage();
    const messages = createMessageStore(storage);
    const session = createSession({
      userId: "owner" as UserId,
      channelId: "stream-fixture" as ChannelId,
    });
    const chat = createChatSession({
      session,
      providerRegistry: registry,
      hookRunner: {
        ...baseHooks,
        async evaluateHook(hook, context) {
          if (hook === "PRE_OUTPUT" && context.input.content === finalAnswer) {
            enteredOutput.resolve();
            await releaseOutput.promise;
          }
          return await baseHooks.evaluateHook(hook, context);
        },
      },
      enableStreaming: true,
      messageStore: messages,
      tools: [fixtureTool],
      toolExecutor: () => Promise.resolve("Fixture control passed."),
    });
    const token = crypto.randomUUID();
    const server = createGatewayServer({ port: 0, token, chatSession: chat });
    const { port } = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const events: ChatEvent[] = [];
    const ended = Promise.withResolvers<void>();
    const deadline = setTimeout(() => {
      const timeout = new Error("Gateway fixture timed out");
      enteredOutput.reject(timeout);
      ended.reject(timeout);
    }, 4000);
    const visible = () =>
      events.filter(({ type }) =>
        type === "response_chunk" || type === "reasoning_chunk" ||
        type === "response"
      );
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "message",
          content: "Review the fixture control.",
        }),
      );
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      events.push(event);
      if (event.type === "turn_end") ended.resolve();
    };
    try {
      await enteredOutput.promise;
      assertEquals(
        visible(),
        [],
        "No model bytes before destination authorization",
      );
      releaseOutput.resolve();
      await ended.promise;
      assertEquals(streamed, mode === "allow" ? 2 : 1);
      assert(!JSON.stringify(events).includes(draft));
      assert(!JSON.stringify(events).includes(marker));
      assert(audit.some(({ hook }) => hook === "PRE_OUTPUT"));
      assert(!JSON.stringify(audit).includes(marker));
      if (mode === "deny_answer") {
        assertEquals(visible(), []);
        assert(events.some(({ type }) => type === "error"));
      } else {
        assertEquals(visible(), [
          ...(mode === "allow"
            ? [{
              type: "reasoning_chunk" as const,
              text: reasoning,
              done: true,
            }]
            : []),
          { type: "response_chunk", text: answer, done: false },
          { type: "response_chunk", text: "", done: true },
          { type: "response", text: answer, taint: "PUBLIC" },
        ]);
      }
      const stored = await Promise.all(
        (await storage.list("conv:")).map((key) => storage.get(key)),
      );
      if (mode === "allow") {
        assertStringIncludes(JSON.stringify(stored), allowedReasoning);
      } else {
        assert(!JSON.stringify(stored).includes(reasoning));
      }
    } finally {
      clearTimeout(deadline);
      releaseOutput.resolve();
      socket.close();
      await server.stop();
      await storage.close();
    }
  });
}

Deno.test("Iteration-limit response passes destination policy before publication", async () => {
  const denied = "Forbidden fallback fixture.";
  const engine = createPolicyEngine();
  engine.addRule({
    id: "fixture-deny-fallback",
    priority: 100,
    hook: "PRE_OUTPUT",
    conditions: [{ field: "content", operator: "contains", value: denied }],
    action: "BLOCK",
  });
  const events: OrchestratorEvent[] = [];
  const providerRegistry = createProviderRegistry();
  let calls = 0;
  providerRegistry.register({
    name: "fallback-fixture",
    supportsStreaming: false,
    complete() {
      const initial = ++calls === 1;
      return Promise.resolve({
        content: initial ? "" : denied,
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: initial
          ? [{
            type: "function",
            id: "fixture-call",
            function: { name: fixtureTool.name, arguments: "{}" },
          }]
          : [],
      });
    },
  });
  providerRegistry.setDefault("fallback-fixture");
  const orchestrator = createOrchestrator({
    providerRegistry,
    hookRunner: createHookRunner(engine),
    tools: [fixtureTool],
    toolExecutor: () => Promise.resolve("Fixture control passed."),
    onEvent: (event) => events.push(event),
    maxIterations: 1,
  });
  const result = await orchestrator.executeAgentTurn({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "fixture" as ChannelId,
    }),
    message: "Review the control.",
    targetClassification: "PUBLIC",
  });
  assertEquals(calls, 2);
  assertEquals(result, { ok: false, error: "Output blocked by policy" });
  assert(!JSON.stringify(events).includes(denied));
});
