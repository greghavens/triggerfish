import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createManagedNotificationChannels } from "../../src/core/managed_notification_channels.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { createSqliteStorage } from "../../src/core/storage/sqlite.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createNotificationWebhookTransport } from "../../src/gateway/notifications/webhook_transport.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createDomainPolicy } from "../../src/tools/web/policy.ts";

Deno.test("gateway reviews notification channels and durably deduplicates policy-gated webhook tests", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".notification-channels-",
  });
  const token = crypto.randomUUID();
  const session = createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  });
  const origin = "https://notifications.example";
  const privatePath = "/synthetic-credential";
  let endpoint = origin + privatePath;
  let preDenied = false;
  let outputDenied = false;
  let responseLost = false;
  let classified = 0;
  let calls = 0;
  const policy = createHookRunner(createPolicyEngine());
  let storage!: ReturnType<typeof createSqliteStorage>;
  let gateway: ReturnType<typeof createGatewayServer>;
  let socket: WebSocket;

  async function connect() {
    storage = createSqliteStorage(`${baseDir}/channels.db`);
    const registry = createProviderRegistry();
    registry.register({
      name: "fixture",
      model: "fixture-v1",
      supportsStreaming: false,
      complete(messages) {
        const last = messages.at(-1);
        return Promise.resolve({
          content: last?.role === "tool"
            ? String(last.content)
            : "fixture answered",
          toolCalls:
            last?.role === "user" && String(last.content).startsWith("{")
              ? [{
                type: "function",
                id: "notification-operation",
                function: {
                  name: "operator_runs",
                  arguments: String(last.content),
                },
              }]
              : [],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    });
    registry.setDefault("fixture");
    gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session,
        targetClassification: "RESTRICTED",
        providerRegistry: registry,
        hookRunner: {
          ...policy,
          evaluateHook(hook, context) {
            if (
              (hook === "PRE_TOOL_CALL" && preDenied) ||
              (hook === "PRE_OUTPUT" && outputDenied &&
                context.input.destination === origin)
            ) {
              return Promise.resolve({
                allowed: false,
                action: "BLOCK",
                ruleId: null,
                duration: 0,
              });
            }
            if (
              hook === "POST_TOOL_RESPONSE" &&
              context.input.tool_name === "operator_runs"
            ) classified++;
            return policy.evaluateHook(hook, context);
          },
        },
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          confirm: () => Promise.resolve(true),
          notificationChannels: {
            store: createManagedNotificationChannels(storage),
            sendWebhook: createNotificationWebhookTransport(
              {
                getSecret(name) {
                  assertEquals(name, "notification_fixture");
                  return Promise.resolve({ ok: true, value: endpoint });
                },
              },
              createDomainPolicy({
                allowlist: ["notifications.example"],
                denylist: [],
                classificationMap: [{
                  pattern: "notifications.example",
                  classification: "INTERNAL",
                }],
              }),
              () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
              (target, options) => {
                calls++;
                assertEquals(target.url, origin + privatePath);
                assertEquals(options?.redirect, "manual");
                assertStringIncludes(
                  String(options?.body),
                  "notification.test",
                );
                return responseLost
                  ? Promise.reject(new Error("Synthetic response loss"))
                  : Promise.resolve(new Response(null, { status: 204 }));
              },
            ),
          },
        }),
      }),
    });
    const { port } = await gateway.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    socket = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
  }

  async function disconnect() {
    const ws = socket;
    const closed = new Promise<void>((resolve) =>
      ws.addEventListener("close", () => resolve(), { once: true })
    );
    ws.close();
    await closed;
    await gateway.stop();
    await storage.close();
  }

  async function turn(args: Record<string, unknown>) {
    const done = Promise.withResolvers<string>();
    let result = "";
    const listen = ({ data }: MessageEvent) => {
      const event = JSON.parse(data);
      if (event.type === "tool_result") result = String(event.result);
      if (event.type === "error") result ||= String(event.message);
      if (event.type === "turn_end" || event.type === "error") {
        done.resolve(result);
      }
    };
    const timer = setTimeout(
      () => done.reject(new Error("No gateway response")),
      4000,
    );
    socket.addEventListener("message", listen);
    try {
      socket.send(
        JSON.stringify({ type: "message", content: JSON.stringify(args) }),
      );
      return await done.promise;
    } finally {
      clearTimeout(timer);
      socket.removeEventListener("message", listen);
    }
  }

  try {
    await connect();
    const selector = { notificationChannelId: "fixture", expectedVersion: 1 };
    const mutation = {
      action: "set_notification_channel",
      ...selector,
      expectedVersion: 0,
      notificationChannelSettings: {
        name: "Fixture",
        destinationOrigin: origin,
        endpointRef: "notification_fixture",
        classification: "INTERNAL",
        enabled: true,
      },
    };
    const probe = { action: "test_notification_channel", ...selector };
    const list = { action: "notification_channels" };
    const history = {
      action: "notification_deliveries",
      notificationChannelId: selector.notificationChannelId,
    };
    const create = await turn(mutation);
    assertStringIncludes(create, "channel");
    assertEquals(JSON.parse(create).channel.version, 1);
    assertEquals(JSON.parse(create)._classification, "INTERNAL");
    assertEquals(JSON.parse(await turn(list)).channels.length, 1);
    preDenied = true;
    await turn({ ...probe, requestId: "pre-denial" });
    preDenied = false;
    assertEquals(JSON.parse(await turn(history)).deliveries, []);

    outputDenied = true;
    const denied = await turn({ ...probe, requestId: "output-denial" });
    assertEquals(JSON.parse(denied).delivery.state, "blocked");
    outputDenied = false;
    endpoint = "https://unapproved.example" + privatePath;
    assertEquals(
      JSON.parse(await turn({ ...probe, requestId: "changed-origin" })).delivery
        .state,
      "blocked",
    );
    endpoint = origin + privatePath;
    assertEquals(calls, 0);

    const send = { ...probe, requestId: "delivered" };
    const first = await turn(send);
    assertEquals(JSON.parse(first).delivery.state, "delivered");
    assertEquals(await turn(send), first);
    responseLost = true;
    const interrupted = { ...probe, requestId: "uncertain" };
    assertEquals(
      JSON.parse(await turn(interrupted)).delivery.state,
      "uncertain",
    );
    assertEquals(calls, 2);
    await disconnect();
    await connect();
    assertEquals(await turn(send), first);
    assertEquals(
      JSON.parse(await turn(interrupted)).delivery.state,
      "uncertain",
    );
    assertEquals(calls, 2);
    const records = await turn(history);
    assertEquals(JSON.parse(records).deliveries.length, 4);
    assert(!records.includes(privatePath));
    for (const key of await storage.list()) {
      assert(!(await storage.get(key))?.includes(privatePath));
    }
    assert(classified > 0);
    const retire = { action: "retire_notification_channel", ...selector };
    assertEquals(JSON.parse(await turn(retire)).channel.retired, true);
    assertEquals(JSON.parse(await turn(list)).channels, []);
    assertStringIncludes(
      await turn({ ...probe, requestId: "stale" }),
      "unavailable",
    );
    assertEquals(calls, 2);
  } finally {
    await disconnect();
    await Deno.remove(baseDir, { recursive: true });
  }
});
