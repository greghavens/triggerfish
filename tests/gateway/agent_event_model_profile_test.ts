import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { liveProviderRouteSettings } from "../../src/agent/providers/live_routes.ts";
import type { TriggerFishConfig } from "../../src/core/config.ts";
import { readAgentProfile } from "../../src/core/agent_profiles.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createOrchestratorFactory } from "../../src/gateway/startup/factory/orchestrator_factory.ts";
import { createAgentEventScheduler } from "../../src/scheduler/service_agent_events.ts";
import { parseAgentEventSubscription } from "../../src/scheduler/agent_events.ts";

Deno.test("Reviewed event recipients use the exact classified model through the scheduler and gateway", async () => {
  const dir = await Deno.makeTempDir();
  const modelRequests: { model: string; messages: unknown }[] = [];
  const model = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response(null, { status: 404 });
      }
      const body = await request.json();
      modelRequests.push({ model: body.model, messages: body.messages });
      const message = { role: "assistant", content: "NO_ACTION" };
      if (body.stream) {
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\n` +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        choices: [{ message }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  );
  const endpoint = `http://127.0.0.1:${model.addr.port}`;
  const ollama = { endpoint, model: "normal-model" };
  const lmstudio = { endpoint, model: "event-model" };
  const allowlists = { INTERNAL: ["ollama", "lmstudio"] };
  const config: TriggerFishConfig = {
    channels: {},
    classification: { mode: "strict" },
    models: {
      primary: { provider: "ollama", model: "normal-model" },
      providers: { ollama, lmstudio },
      live_route_allowlists: allowlists,
    },
  };
  await Deno.mkdir(join(dir, "data"), { mode: 0o700 });
  await Deno.writeTextFile(
    join(dir, "data", "model-routes.json"),
    JSON.stringify({ INTERNAL: { provider: "ollama", model: "normal-model" } }),
    { mode: 0o600 },
  );
  const registry = createProviderRegistry();
  let requested: Record<string, unknown> = {};
  let emitted = false;
  registry.register({
    name: "owner-fixture",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      const dispatch = last?.role === "user" && !emitted;
      if (dispatch) emitted = true;
      return Promise.resolve({
        content: dispatch ? "" : "Event operation finished.",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: dispatch
          ? [{
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(requested),
            },
          }]
          : [],
      });
    },
  });
  registry.setDefault("owner-fixture");
  registry.register({
    ...registry.getDefault()!,
    name: "lmstudio",
    model: "event-model",
  });
  const token = crypto.randomUUID();
  const reviews: string[] = [];
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "fixture" as ChannelId,
      }),
      providerRegistry: registry,
      targetClassification: "INTERNAL",
      getSessionTaint: () => "INTERNAL",
      hookRunner: {
        evaluateHook: () =>
          Promise.resolve({
            allowed: true,
            action: "ALLOW",
            ruleId: null,
            duration: 0,
          }),
      },
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir: dir,
        confirm: (question) => {
          reviews.push(question);
          return Promise.resolve(true);
        },
        liveModelRoutes: liveProviderRouteSettings(registry, dir, allowlists),
      }),
    }),
  });
  let receipt = "fixture-event-one";
  const scheduler = createAgentEventScheduler({
    orchestratorFactory: createOrchestratorFactory(config, dir),
    triggerMdPath: join(dir, "TRIGGER.md"),
    trigger: {
      enabled: false,
      intervalMinutes: 10,
      classificationCeiling: "INTERNAL",
    },
    webhooks: { enabled: false, sources: {} },
    agentEvents: {
      baseDir: dir,
      readSources(_, publish) {
        publish({ kind: "finding", caseId: "main", receipt });
      },
    },
  });
  assert(scheduler);
  let socket: WebSocket | undefined;
  try {
    const { port } = await gateway.start();
    const ws = socket = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const call = async (args: Record<string, unknown>) => {
      requested = args;
      emitted = false;
      const done = Promise.withResolvers<string>();
      let result = "";
      const listen = ({ data }: MessageEvent) => {
        const event = JSON.parse(String(data));
        if (event.type === "tool_result") result = String(event.result);
        if (event.type === "turn_end") done.resolve(result);
      };
      const timer = setTimeout(
        () => done.reject(new Error("Gateway reply timed out")),
        3500,
      );
      ws.addEventListener("message", listen);
      try {
        ws.send(
          JSON.stringify({
            type: "message",
            content: "Run the reviewed event operation.",
          }),
        );
        return await done.promise;
      } finally {
        clearTimeout(timer);
        ws.removeEventListener("message", listen);
      }
    };
    const profile = {
      action: "set_agent_profile",
      id: "fixture-event",
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      profileSettings: {
        role: "event",
        name: "Fixture event agent",
        description: "Inspect reviewed event metadata.",
        prompt: "Read the event identifiers.",
        tools: [],
        modelProfile: { provider: "lmstudio", model: "event-model" },
      },
    };
    assertEquals(JSON.parse(await call(profile)).profile.version, 1);
    assertEquals(readAgentProfile(dir, profile.id)?.definition?.role, "event");
    const args = {
      action: "set_agent_event_subscription",
      expectedVersion: 0,
      subscriptionSettings: {
        id: "fixture-event-subscription",
        agent: profile.id,
        kinds: ["finding"],
        merge: "none",
        maxConcurrent: 1,
        enabled: true,
      },
    };
    assert(parseAgentEventSubscription(args.subscriptionSettings));
    const subscription = await call(args);
    assert(
      subscription.startsWith("{"),
      `${subscription} (${reviews.length} reviews)`,
    );
    assertEquals(JSON.parse(subscription).saved.version, 1);
    const waitForDelivery = async (expected: string, count: number) => {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        const status = JSON.parse(
          await call({ action: "agent_event_subscriptions" }),
        );
        if (
          status.deliveries.length === count && status.deliveries.some(
            ({ state }: { state: string }) => state === expected,
          )
        ) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Event delivery did not reach ${expected}`);
    };
    scheduler.start();
    await waitForDelivery("completed", 1);
    scheduler.stop();
    assertEquals(modelRequests.map(({ model }) => model), ["event-model"]);
    assertStringIncludes(JSON.stringify(modelRequests[0].messages), receipt);
    receipt = "fixture-event-two";
    allowlists.INTERNAL = ["ollama"];
    scheduler.start();
    await waitForDelivery("failed", 2);
    assertEquals(modelRequests.map(({ model }) => model), ["event-model"]);
  } finally {
    scheduler.stop();
    socket?.close();
    await gateway.stop();
    await model.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
