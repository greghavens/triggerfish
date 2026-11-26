import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { sentinelAgentEventSources } from "../../src/gateway/sentinel_agent_event_sources.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createAgentEventScheduler } from "../../src/scheduler/service_agent_events.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { dirname } from "@std/path";

Deno.test("Reviewed event subscription dispatches committed case metadata only once across restart", async () => {
  const baseDir = await Deno.makeTempDir();
  const registry = createProviderRegistry();
  const token = crypto.randomUUID();
  let requested: Record<string, unknown> = {};
  let result = "";
  let approve = true;
  let rootCalls = 0;
  registry.register({
    name: "agent-event-fixture",
    supportsStreaming: false,
    complete(messages) {
      const usage = { inputTokens: 1, outputTokens: 1 };
      const last = messages.at(-1);
      if (last?.role === "tool") {
        result = String(last.content);
        return Promise.resolve({ content: "Done.", usage, toolCalls: [] });
      }
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          id: crypto.randomUUID(),
          type: "function",
          function: {
            name: "operator_runs",
            arguments: JSON.stringify(requested),
          },
        }],
      });
    },
  });
  registry.setDefault("agent-event-fixture");
  const owner = "owner" as UserId;
  const gateway = createGatewayServer({
    token,
    port: 0,
    chatSession: createChatSession({
      session: createSession({
        userId: owner,
        channelId: "owner-event" as ChannelId,
      }),
      providerRegistry: registry,
      toolExecutor: () => Promise.resolve("Unexpected tool"),
      hookRunner: {
        evaluateHook(hook, context) {
          if (
            hook === "PRE_TOOL_CALL" &&
            context.input.tool_name === "operator_runs"
          ) rootCalls++;
          return Promise.resolve({
            allowed: true,
            action: "ALLOW",
            ruleId: null,
            duration: 0,
          });
        },
      },
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        confirm: () => Promise.resolve(approve),
      }),
    }),
  });
  let socket: WebSocket | undefined;
  const messages: string[] = [];
  const scheduler = createAgentEventScheduler({
    agentEvents: sentinelAgentEventSources(baseDir),
    orchestratorFactory: {
      create(channel, options) {
        assert(options?.eventRecipient);
        assert(options.eventRecipient.isCurrent());
        assertEquals(options.eventRecipient.tools, ["list_directory"]);
        assertEquals(options.systemPromptSections, ["Review new assessments."]);
        const session = createSession({
          userId: owner,
          channelId: channel as ChannelId,
        });
        return Promise.resolve({
          session,
          toolExecutor: () =>
            Promise.resolve("No tools in the scheduler fixture."),
          getSessionTaint: () => "INTERNAL" as const,
          orchestrator: {
            getHistory: () => [],
            clearHistory() {},
            compactHistory: () =>
              Promise.resolve({
                messagesBefore: 0,
                messagesAfter: 0,
                tokensBefore: 0,
                tokensAfter: 0,
              }),
            executeAgentTurn({ message }) {
              messages.push(String(message));
              return Promise.resolve({
                ok: true as const,
                value: {
                  response: "NO_ACTION",
                  tokenUsage: { inputTokens: 1, outputTokens: 1 },
                },
              });
            },
          },
        });
      },
    },
    triggerMdPath: "/does-not-exist",
    trigger: {
      enabled: false,
      intervalMinutes: 10,
      classificationCeiling: "INTERNAL",
    },
    webhooks: { enabled: false, sources: {} },
  });
  assert(scheduler);
  try {
    const { port } = await gateway.start();
    const ws = socket = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const manage = async (args: Record<string, unknown>) => {
      requested = args;
      result = "";
      const done = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => done.reject(new Error("No owner turn result")),
        5000,
      );
      const listener = ({ data }: MessageEvent) => {
        if (JSON.parse(String(data)).type === "turn_end") done.resolve();
      };
      ws.addEventListener("message", listener);
      try {
        ws.send(
          JSON.stringify({
            type: "message",
            content: "Perform the reviewed operation.",
          }),
        );
        await done.promise;
        return result;
      } finally {
        clearTimeout(timer);
        ws.removeEventListener("message", listener);
      }
    };

    const agent = await manage({
      action: "set_agent_profile",
      id: "review-agent",
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      profileSettings: {
        name: "Review agent",
        description: "Review requested cases.",
        role: "event",
        prompt: "Review new assessments.",
        tools: ["list_directory"],
      },
    });
    assertEquals(JSON.parse(agent).profile.version, 1);
    const subscription = {
      action: "set_agent_event_subscription",
      expectedVersion: 0,
      subscriptionSettings: {
        id: "new-main-review",
        agent: "review-agent",
        kinds: ["task_created"],
        caseId: "main",
        merge: "by_case",
        maxConcurrent: 1,
        enabled: true,
      },
    };
    approve = false;
    assertStringIncludes(await manage(subscription), "declined");
    approve = true;
    assertEquals(JSON.parse(await manage(subscription)).saved.version, 1);
    assertStringIncludes(await manage(subscription), "unavailable");
    assert(rootCalls >= 4);
    const path = resolveSentinelCasePath(baseDir);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: "local",
          kind: "asset",
          label: "private case asset label",
        }],
        edges: [],
      }),
    );
    const started = startSentinelAssessment(path);
    scheduler.start();
    const seen = await manage({ action: "agent_event_subscriptions" });
    assertEquals(
      JSON.parse(seen).deliveries.map(({ state }: { state: string }) => state),
      ["completed"],
    );
    assertEquals(messages.length, 1);
    assertStringIncludes(messages[0], '"kind":"task_created"');
    assertStringIncludes(messages[0], started.plan.runId!);
    assert(!messages[0].includes("private case asset label"));
    scheduler.stop();
    scheduler.start();
    assertEquals(messages.length, 1);
    const final = await manage({ action: "agent_event_subscriptions" });
    assertEquals(JSON.parse(final).deliveries.length, 1);
    assertEquals(messages.length, 1);
  } finally {
    scheduler.stop();
    socket?.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
