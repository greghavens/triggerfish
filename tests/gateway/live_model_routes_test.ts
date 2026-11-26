import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { createSchedulerService } from "../../src/scheduler/service.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { enableLiveProviderRoutes } from "../../src/agent/providers/live_routes.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { LlmProvider } from "../../src/core/types/llm.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";

Deno.test("gateway pins approved classification routes for the entire model turn", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".live-provider-route-",
  });
  const data = join(baseDir, "data");
  await Deno.mkdir(data, { mode: 0o700 });
  const routeFile = join(data, "model-routes.json");
  const approvals = { INTERNAL: ["first", "second"] };
  const hooks = createHookRunner(createPolicyEngine());
  const requests: string[] = [];

  async function select(provider: string, model = provider) {
    const replacement = join(data, "replacement.json");
    await Deno.writeTextFile(
      replacement,
      JSON.stringify({ INTERNAL: { provider, model } }),
      { mode: 0o600 },
    );
    await Deno.rename(replacement, routeFile);
  }

  const provider = (name: string): LlmProvider => ({
    name,
    model: name,
    supportsStreaming: false,
    async complete(messages) {
      const input = messages.at(-1)?.content;
      requests.push(name);
      if (name === "first" && input === "Start on the current route.") {
        await select("second");
        return {
          content: "",
          toolCalls: [{
            type: "function",
            id: "route-turn-check",
            function: { name: "fixture_check", arguments: "{}" },
          }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return {
        content: `Answered by ${name}.`,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  });
  function registry() {
    const base = createProviderRegistry();
    for (const name of ["default", "first", "second", "unapproved"]) {
      base.register(provider(name));
    }
    base.setDefault("default");
    return base;
  }
  const session = createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  });
  const ownerRoutes = enableLiveProviderRoutes(registry(), baseDir, approvals);
  const backgroundRoutes = enableLiveProviderRoutes(
    registry(),
    baseDir,
    approvals,
  );
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session,
      hookRunner: hooks,
      providerRegistry: ownerRoutes,
      getSessionTaint: () => "INTERNAL",
      targetClassification: "INTERNAL",
      tools: [{ name: "fixture_check", description: "Check", parameters: {} }],
      toolExecutor: () => Promise.resolve("A completed call."),
    }),
  });
  await select("first");
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  async function turn(content: string): Promise<string> {
    const done = Promise.withResolvers<string>();
    let answer = "";
    const receive = ({ data }: MessageEvent) => {
      const event = JSON.parse(data);
      if (event.type === "response") answer = String(event.text);
      if (event.type === "error") answer = String(event.message);
      if (event.type === "turn_end") done.resolve(answer);
    };
    const timer = setTimeout(() => done.reject(new Error("No reply")), 3000);
    socket.addEventListener("message", receive);
    try {
      socket.send(JSON.stringify({ type: "message", content }));
      return await done.promise;
    } finally {
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    assertEquals(
      await turn("Start on the current route."),
      "Answered by first.",
    );
    assertEquals(requests.splice(0), ["first", "first"]);
    assertEquals(await turn("Start the next turn."), "Answered by second.");
    assertEquals(requests.splice(0), ["second"]);

    // The normal scheduler and delegated entry points share an independent
    // startup registry, and resolve the same durable source snapshot.
    const factory: OrchestratorFactory = {
      create(channelId) {
        const backgroundSession = {
          ...createSession({
            userId: "fixture" as UserId,
            channelId: channelId as ChannelId,
          }),
          taint: "INTERNAL" as const,
        };
        const getSessionTaint = () => backgroundSession.taint;
        const toolExecutor = () => Promise.resolve("No tool call expected.");
        return Promise.resolve({
          session: backgroundSession,
          toolExecutor,
          getSessionTaint,
          orchestrator: createOrchestrator({
            providerRegistry: backgroundRoutes,
            hookRunner: hooks,
            getSessionTaint,
            isOwnerSession: () => false,
            getNonOwnerCeiling: () => "INTERNAL",
          }),
        });
      },
    };
    assertEquals(
      await buildSubagentFactory(factory)(
        "Read the independently loaded route.",
      ),
      "Answered by second.",
    );
    const delivered: string[] = [];
    const triggerMdPath = join(baseDir, "TRIGGER.md");
    await Deno.writeTextFile(
      triggerMdPath,
      "Read the current scheduled route.",
    );
    const scheduler = createSchedulerService({
      orchestratorFactory: factory,
      triggerMdPath,
      trigger: {
        enabled: false,
        intervalMinutes: 30,
        classificationCeiling: "INTERNAL",
      },
      webhooks: { enabled: false, sources: {} },
      onTriggerOutput: (_source, _classification, preview) =>
        delivered.push(preview),
    });
    try {
      await scheduler.runTrigger();
    } finally {
      scheduler.stop();
    }
    assertEquals(delivered, ["Answered by second."]);

    // Unapproved providers, mismatched exact models and a revoked file cannot
    // route protected context to the startup default or a different provider.
    for (const [name, model] of [["unapproved"], ["second", "other"]]) {
      await select(name, model);
      assertEquals(
        await turn("Do not send this context."),
        "The approved model route is unavailable.",
      );
    }
    await Deno.remove(routeFile);
    assertEquals(
      await turn("Do not send this after revocation."),
      "The approved model route is unavailable.",
    );
    assertEquals(requests.splice(0), ["second", "second"]);
    assertEquals(registry().getForClassification("INTERNAL")?.name, "default");
  } finally {
    socket.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
