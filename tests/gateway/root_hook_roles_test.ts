import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
  type HookLogEntry,
} from "../../src/core/policy/hooks/hooks.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import {
  type ClassificationLevel,
  maxClassification,
} from "../../src/core/types/classification.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { createSchedulerService } from "../../src/scheduler/service.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";

const evidence = "private connector fixture evidence";
const name = "fixture_connector";
const finalText = "Completed fixture review.";
const prompt = "Run the fixture connector.";
const toolDefinitions = [{
  name,
  description: "Fixture connector",
  parameters: {},
}];
const usage = { inputTokens: 1, outputTokens: 1 };

function fixture(mode: "pre" | "post" | "allow") {
  const audit: HookLogEntry[] = [];
  const observed: string[] = [];
  const connectorEffects = createMemoryStorage();
  const conversations = createMemoryStorage();
  const messageStore = createMessageStore(conversations);
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  if (mode === "pre") {
    engine.addRule({
      id: "fixture-pre-denied",
      priority: 999,
      hook: "PRE_TOOL_CALL",
      conditions: [],
      action: "BLOCK",
    });
  }
  if (mode === "post") {
    engine.addRule({
      id: "fixture-post-redacted",
      priority: 999,
      hook: "POST_TOOL_RESPONSE",
      conditions: [
        { field: "tool_name", operator: "equals", value: name },
        { field: "tool_response", operator: "contains", value: evidence },
        { field: "session_taint", operator: "equals", value: "INTERNAL" },
      ],
      action: "REDACT",
    });
  }
  const hookRunner = createHookRunner(engine, {
    logger: { log: (entry) => audit.push(entry) },
  });
  const providerRegistry = createProviderRegistry();
  providerRegistry.register({
    name: "fixture",
    supportsStreaming: false,
    complete(messages) {
      const response = messages.findLast(({ role }) => role === "tool");
      if (response) observed.push(String(response.content));
      return Promise.resolve({
        content: response ? finalText : "",
        toolCalls: response ? [] : [{
          id: "fixture-call",
          type: "function",
          function: { name, arguments: "{}" },
        }],
        usage,
      });
    },
  });
  providerRegistry.setDefault("fixture");
  const config = {
    providerRegistry,
    hookRunner,
    messageStore,
    tools: toolDefinitions,
    toolClassifications: new Map([[name, "PUBLIC"]] as const),
    enableStreaming: false,
    async toolExecutor(tool: string) {
      if (tool !== name) {
        return "Fixture has no result for this service lookup.";
      }
      await connectorEffects.set("handler-executed", "true");
      return JSON.stringify({ _classification: "INTERNAL", evidence });
    },
  };
  return { audit, observed, config, conversations, connectorEffects };
}

async function runSocket(config: ReturnType<typeof fixture>["config"]) {
  const chatSession = createChatSession({
    ...config,
    session: createSession({
      userId: "owner" as UserId,
      channelId: "socket" as ChannelId,
    }),
  });
  const token = crypto.randomUUID();
  const server = createGatewayServer({ port: 0, token, chatSession });
  const { port } = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  const received = Promise.withResolvers<string[]>();
  const events: string[] = [];
  socket.addEventListener("message", ({ data }) => {
    events.push(String(data));
    if (JSON.parse(data).type === "turn_end") received.resolve(events);
  });
  const timer = setTimeout(
    () =>
      received.reject(new Error("Gateway did not complete the fixture turn")),
    3000,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({ type: "message", content: prompt }));
    return await received.promise;
  } finally {
    clearTimeout(timer);
    socket.close();
    await closed.promise;
    await server.stop();
  }
}

function backgroundFactory(
  config: ReturnType<typeof fixture>["config"],
): OrchestratorFactory {
  return {
    create(channelId, options) {
      if (channelId === "subagent") {
        assertEquals(options?.delegatedKind, "subagent");
      } else assertEquals(options?.isTrigger, true);
      const session = createSession({
        userId: "fixture" as UserId,
        channelId: channelId as ChannelId,
      });
      let taint: ClassificationLevel = "PUBLIC";
      const getSessionTaint = () => taint;
      const orchestrator = createOrchestrator({
        ...config,
        getSessionTaint,
        escalateTaint: (level) => {
          taint = maxClassification(taint, level);
        },
        getNonOwnerCeiling: () => "PUBLIC",
        isOwnerSession: () => false,
        isTriggerSession: () => options?.isTrigger === true,
      });
      return Promise.resolve({
        orchestrator,
        session,
        toolExecutor: config.toolExecutor,
        getSessionTaint,
      });
    },
  };
}

async function runTrigger(factory: OrchestratorFactory) {
  const directory = await Deno.makeTempDir();
  const triggerMdPath = join(directory, "TRIGGER.md");
  const delivered: string[] = [];
  const service = createSchedulerService({
    orchestratorFactory: factory,
    triggerMdPath,
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: "PUBLIC",
    },
    webhooks: { enabled: false, sources: {} },
    onTriggerOutput: (_source, _classification, preview) =>
      delivered.push(preview),
  });
  try {
    await Deno.writeTextFile(triggerMdPath, prompt);
    await service.runTrigger();
    return delivered;
  } finally {
    service.stop();
    await Deno.remove(directory, { recursive: true });
  }
}

for (const role of ["socket", "delegated", "scheduled"] as const) {
  Deno.test(`Root policy hook sequence reaches the real ${role} entry point`, async () => {
    for (const mode of ["pre", "post", "allow"] as const) {
      const state = fixture(mode);
      const factory = backgroundFactory(state.config);
      const output = role === "socket"
        ? (await runSocket(state.config)).join("\n")
        : role === "delegated"
        ? await buildSubagentFactory(factory)(prompt)
        : (await runTrigger(factory)).join("\n");
      const post = state.audit.find(({ hook }) =>
        hook === "POST_TOOL_RESPONSE"
      );
      const delivery = state.audit.find(({ hook }) => hook === "PRE_OUTPUT");
      const stored = await Promise.all(
        (await state.conversations.list("conv:")).map(
          (key) => state.conversations.get(key),
        ),
      );
      assertEquals(
        await state.connectorEffects.get("handler-executed"),
        mode === "pre" ? null : "true",
      );
      assert(
        state.audit.some(({ hook, result }) =>
          hook === "PRE_TOOL_CALL" && result.allowed === (mode !== "pre")
        ),
      );
      if (mode === "pre") {
        assertEquals(post, undefined);
        assert(!stored.some((entry) => /"role":"tool_call"/.test(entry ?? "")));
      } else {
        assertEquals(post?.input.session_taint, "INTERNAL");
        assertEquals(post?.result.allowed, mode === "allow");
        assert(!JSON.stringify(post).includes(evidence));
      }
      if (mode === "post") {
        assertEquals(post?.result.action, "REDACT");
        assertEquals(state.observed, ["Tool response withheld by policy."]);
        assert(!JSON.stringify(stored).includes(evidence));
        assert(!output.includes(evidence));
      }
      if (mode === "allow") {
        assertStringIncludes(state.observed[0], evidence);
      }
      if (mode !== "pre" && role !== "socket") {
        assertEquals(delivery?.result.allowed, false);
        assert(!output.includes(finalText));
      } else {
        assertEquals(delivery?.result.allowed, true);
        assertStringIncludes(output, finalText);
      }
    }
  });
}
