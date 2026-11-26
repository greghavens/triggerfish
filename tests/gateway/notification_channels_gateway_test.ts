import { dirname } from "@std/path";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { OperatorNotificationChannels } from "../../src/gateway/notifications/operator_channels.ts";
import {
  createSentinelIncidentDelivery,
  isCurrentSentinelIncident,
  readSentinelIncidentScope,
} from "../../src/gateway/notifications/sentinel_incidents.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import {
  refreshSentinelAssessment,
  setSentinelIncidentNotifications,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
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

Deno.test("gateway reviews notification subscriptions and durably deduplicates scoped policy-gated delivery", async () => {
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
  let denyIncident = true;
  let responseLost = false;
  let classified = 0;
  let calls = 0;
  const payloads: Record<string, unknown>[] = [];
  const policy = createHookRunner(createPolicyEngine());
  let storage!: ReturnType<typeof createSqliteStorage>;
  let gateway: ReturnType<typeof createGatewayServer>;
  let socket: WebSocket;
  let channels!: OperatorNotificationChannels;
  let hooks!: HookRunner;

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
    hooks = {
      ...policy,
      evaluateHook(hook, context) {
        if (
          (hook === "PRE_TOOL_CALL" && preDenied) ||
          (hook === "PRE_OUTPUT" &&
            ((outputDenied && context.input.destination === origin) ||
              (denyIncident &&
                context.input.notification_channel_id ===
                  "blocked-subscription")))
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
    };
    channels = {
      store: createManagedNotificationChannels(storage),
      isCurrentSentinelIncident: (source) =>
        isCurrentSentinelIncident(baseDir, source),

      readSentinelIncidentScope: (caseId) =>
        readSentinelIncidentScope(baseDir, caseId),
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
          payloads.push(JSON.parse(String(options?.body)));
          return responseLost
            ? Promise.reject(new Error("Synthetic response loss"))
            : Promise.resolve(new Response(null, { status: 204 }));
        },
      ),
    };
    gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session,
        targetClassification: "RESTRICTED",
        providerRegistry: registry,
        hookRunner: hooks,
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          confirm: () => Promise.resolve(true),
          notificationChannels: channels,
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

  async function prepareCase(caseId: string) {
    const path = resolveSentinelCasePath(baseDir, caseId);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: "fixture-asset",
          kind: "asset",
          label: "Private fixture label",
        }],
        edges: [],
      }),
    );
    const initial = startSentinelAssessment(path);
    return { path, initial };
  }

  async function createIncident(path: string) {
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify(
        ["security_sensor_alert", "authorization_denial_burst"].map((type) => ({
          type,
          severity: "medium",
          asset: "fixture-asset",
          subject: "Private fixture subject",
          observedAt: "2026-11-24T12:00:00.000Z",
          evidenceIds: [type],
        })),
      ),
    );
    const result = refreshSentinelAssessment(path);
    assert(result);
    return result;
  }

  async function tickCoordinator(path: string) {
    const done = Promise.withResolvers<void>();
    const dispatch = createSentinelIncidentDelivery(baseDir, channels, hooks);
    const coordinator = startSentinelAssessmentCoordinator({
      snapshotPath: path,
      notifyIncidentIncrease: () => Promise.resolve("delivered"),
      notifyManagedIncidentIncrease: (source, current) =>
        dispatch(source, current).then(done.resolve, done.reject),
      onError: done.reject,
    });
    try {
      await done.promise;
    } finally {
      coordinator.stop();
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
    const retryUnknown = {
      action: "retry_notification_delivery",
      ...selector,
      notificationDeliveryId: "uncertain",
      requestId: "retry-uncertain",
    };
    assertStringIncludes(await turn(retryUnknown), "unavailable");
    const records = await turn(history);
    assertEquals(JSON.parse(records).deliveries.length, 4);
    assert(!records.includes(privatePath));
    for (const key of await storage.list()) {
      assert(!(await storage.get(key))?.includes(privatePath));
    }
    assert(classified > 0);
    const { path, initial } = await prepareCase("main");
    const subscription = {
      ...mutation,
      expectedVersion: 1,
      notificationChannelSettings: {
        ...mutation.notificationChannelSettings,
        sentinelIncidents: {
          caseId: "main",
          runId: initial.plan.runId,
          afterRevision: initial.revision,
        },
      },
    };
    const invalidSubscription = {
      ...subscription,
      notificationChannelSettings: {
        ...subscription.notificationChannelSettings,
        sentinelIncidents: {
          ...subscription.notificationChannelSettings.sentinelIncidents,
          afterRevision: initial.revision + 1,
        },
      },
    };
    assertStringIncludes(await turn(invalidSubscription), "unavailable");
    assertEquals(JSON.parse(await turn(subscription)).channel.version, 2);
    const blockedSubscription = {
      ...subscription,
      expectedVersion: 0,
      notificationChannelId: "blocked-subscription",
    };
    assertEquals(
      JSON.parse(await turn(blockedSubscription)).channel.version,
      1,
    );
    responseLost = false;
    const incident = await createIncident(path);
    const { path: otherPath } = await prepareCase("other");
    await createIncident(otherPath);
    await tickCoordinator(otherPath);
    assertEquals(calls, 2);

    await tickCoordinator(path);
    assertEquals(calls, 3);
    assertEquals(payloads.at(-1), {
      type: "triggerfish.sentinel.incident_increase",
      caseId: "main",
      runId: incident.plan.runId,
      revision: incident.revision,
      message: "Sentinel detected an increase in incident candidates.",
    });
    await disconnect();
    await connect();
    await tickCoordinator(path);
    assertEquals(calls, 3);
    const blocked = JSON.parse(
      await turn({
        ...history,
        notificationChannelId: "blocked-subscription",
      }),
    ).deliveries;
    assertEquals(blocked.length, 1);
    assertEquals(blocked[0].state, "blocked");
    assertEquals(blocked[0].source.revision, incident.revision);
    const retryIncident = {
      action: "retry_notification_delivery",
      notificationChannelId: "blocked-subscription",
      notificationDeliveryId: blocked[0].id,
      expectedVersion: 1,
      requestId: "retry-blocked-incident",
      kind: "sentinel",
      id: "main",
      runId: incident.plan.runId,
      revision: incident.revision,
    };
    denyIncident = false;
    assertStringIncludes(
      await turn({ ...retryIncident, id: "other" }),
      "unavailable",
    );
    setSentinelIncidentNotifications(path, false);
    assertStringIncludes(await turn(retryIncident), "unavailable");
    assertEquals(calls, 3);
    setSentinelIncidentNotifications(path, true);
    const retry = await turn(retryIncident);
    assertEquals(JSON.parse(retry).delivery.state, "delivered");
    assertEquals(
      JSON.parse(retry).delivery.retries[0].requestId,
      retryIncident.requestId,
    );
    assertEquals(await turn(retryIncident), retry);
    assertEquals(calls, 4);
    assertStringIncludes(
      await turn({ ...retryIncident, requestId: "second-retry" }),
      "unavailable",
    );
    await disconnect();
    await connect();
    assertEquals(await turn(retryIncident), retry);
    assertEquals(calls, 4);
    const deliveredIncident = JSON.parse(await turn(history)).deliveries.find(
      (row: { source?: { kind: string } }) =>
        row.source?.kind === "sentinel_incident_increase",
    );
    assertEquals(deliveredIncident.state, "delivered");
    assertEquals(deliveredIncident.source, {
      kind: "sentinel_incident_increase",
      caseId: "main",
      runId: incident.plan.runId,
      revision: incident.revision,
    });

    const retire = {
      action: "retire_notification_channel",
      ...selector,
      expectedVersion: 2,
    };
    assertEquals(JSON.parse(await turn(retire)).channel.retired, true);
    assertEquals(
      JSON.parse(
        await turn({
          action: "retire_notification_channel",
          notificationChannelId: "blocked-subscription",
          expectedVersion: 1,
        }),
      ).channel.retired,
      true,
    );
    assertEquals(JSON.parse(await turn(list)).channels, []);
    assertStringIncludes(
      await turn({ ...probe, requestId: "stale" }),
      "unavailable",
    );
    assertEquals(calls, 4);
  } finally {
    await disconnect();
    await Deno.remove(baseDir, { recursive: true });
  }
});
