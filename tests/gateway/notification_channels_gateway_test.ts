import {
  createSentinelFindingDelivery,
  isCurrentSentinelFindingNotification,
  readSentinelFindingNotificationScope,
} from "../../src/gateway/notifications/sentinel_findings.ts";
import { openSentinelWorkerFindingStore } from "../../src/sentinel/worker_finding_store.ts";
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
  const providerFixtures = [
    {
      provider: "dingtalk",
      url:
        "https://oapi.dingtalk.com/robot/send?access_token=synthetic-dingtalk-token",
      signing: "synthetic-dingtalk-signing",
    },
    {
      provider: "feishu",
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-feishu-hook",
      signing: "synthetic-feishu-signing",
    },
    {
      provider: "wecom",
      url:
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-wecom-key",
    },
  ];
  const providerDomains = providerFixtures.map(({ url }) =>
    new URL(url).hostname
  );
  const providerSecrets = new Map<string, string>(
    providerFixtures.flatMap(({ provider, url, signing }) => [
      [`notification_${provider}`, url] as const,
      ...signing
        ? [[`notification_${provider}_signing`, signing] as const]
        : [],
    ]),
  );
  let deliveryClock = Date.now();
  let providerCode = 0;
  let providerHttpStatus = 200;
  const providerRequests: { url: URL; body: Record<string, unknown> }[] = [];
  let preDenied = false;
  let outputDenied = false;
  let denyIncident = true;
  let denyAutomatic = false;
  let responseLost = false;
  let rotateDuringReview = false;
  let allowReview = true;
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
              (denyAutomatic && context.input.notification_channel_id ===
                  "scheduled-feishu") ||
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
      store: createManagedNotificationChannels(storage, () => deliveryClock),
      readSentinelFindingScope: (caseId) =>
        readSentinelFindingNotificationScope(baseDir, caseId),
      isCurrentSentinelFinding: (source) =>
        isCurrentSentinelFindingNotification(baseDir, source),
      isCurrentSentinelIncident: (source) =>
        isCurrentSentinelIncident(baseDir, source),

      readSentinelIncidentScope: (caseId) =>
        readSentinelIncidentScope(baseDir, caseId),
      ...createNotificationWebhookTransport(
        {
          getSecret(name) {
            const value = name === "notification_fixture"
              ? endpoint
              : providerSecrets.get(name);
            return Promise.resolve(
              value
                ? { ok: true, value }
                : { ok: false, error: "Fixture secret missing" },
            );
          },
        },
        createDomainPolicy({
          allowlist: ["notifications.example", ...providerDomains],
          denylist: [],
          classificationMap: ["notifications.example", ...providerDomains].map((
            pattern,
          ) => ({
            pattern,
            classification: "INTERNAL",
          })),
        }),
        () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
        (target, options) => {
          calls++;
          const url = new URL(target.url);
          assertEquals(options?.method, "POST");
          assertEquals(options?.redirect, "manual");
          const body = JSON.parse(String(options?.body));
          if (url.origin !== origin) {
            providerRequests.push({ url, body });
            const code = providerCode;
            return Promise.resolve(
              new Response(
                JSON.stringify(
                  url.hostname === "open.feishu.cn"
                    ? { StatusCode: code }
                    : { errcode: code },
                ),
                { status: providerHttpStatus },
              ),
            );
          }
          assertEquals(target.url, origin + privatePath);
          payloads.push(body);
          return responseLost
            ? Promise.reject(new Error("Synthetic response loss"))
            : Promise.resolve(new Response(null, { status: 204 }));
        },
        () => 1795708800000,
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
          confirm: () => {
            if (rotateDuringReview) {
              endpoint = origin + "/changed-during-review";
            }
            return Promise.resolve(allowReview);
          },
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
        nodes: [
          {
            id: "fixture-asset",
            kind: "asset",
            label: "Private fixture label",
          },
          {
            id: "fixture-finding",
            kind: "finding",
            label: "Private fixture finding",
            severity: "high",
          },
          {
            id: "fixture-evidence",
            kind: "evidence",
            label: "Private fixture evidence",
          },
          {
            id: "fixture-control",
            kind: "control",
            label: "Private fixture control",
          },
        ],
        edges: [
          { from: "fixture-finding", to: "fixture-asset", relation: "affects" },
          {
            from: "fixture-evidence",
            to: "fixture-finding",
            relation: "supports",
          },
          {
            from: "fixture-control",
            to: "fixture-finding",
            relation: "mitigates",
          },
        ],
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

  async function tickFindingCoordinator(path: string) {
    const done = Promise.withResolvers<void>();
    const dispatch = createSentinelFindingDelivery(baseDir, channels, hooks);
    const coordinator = startSentinelAssessmentCoordinator({
      snapshotPath: path,
      notifyManagedFindings: (caseId, current) =>
        dispatch(caseId, current).then(done.resolve, done.reject),
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
    rotateDuringReview = true;
    assertStringIncludes(await turn(mutation), "unavailable");
    rotateDuringReview = false;
    endpoint = origin + privatePath;
    assertEquals(JSON.parse(await turn(list)).channels, []);
    const create = await turn(mutation);
    assertStringIncludes(create, "channel");
    assertEquals(JSON.parse(create).channel.version, 1);
    assert(!create.includes("endpointFingerprint"));
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
    endpoint = origin + "/same-origin-different-recipient";
    assertEquals(
      JSON.parse(await turn({ ...probe, requestId: "changed-recipient" }))
        .delivery.state,
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
    assertEquals(JSON.parse(records).deliveries.length, 5);
    const filter = {
      ...history,
      notificationDeliveryState: "blocked",
      notificationEventKind: "test",
      limit: 1,
    };
    const firstPage = JSON.parse(await turn(filter));
    assertEquals(firstPage.total, 3);
    assertEquals(firstPage.deliveries.length, 1);
    const secondPage = JSON.parse(
      await turn({ ...filter, cursor: firstPage.nextCursor }),
    );
    assertEquals(secondPage.total, 3);
    assertEquals(secondPage.deliveries.length, 1);
    assert(secondPage.deliveries[0].id !== firstPage.deliveries[0].id);
    assertStringIncludes(
      await turn({
        ...filter,
        notificationDeliveryState: "delivered",
        cursor: firstPage.nextCursor,
      }),
      "unavailable",
    );
    assertEquals(
      JSON.parse(
        await turn({
          action: "notification_delivery",
          notificationChannelId: selector.notificationChannelId,
          notificationDeliveryId: secondPage.deliveries[0].id,
        }),
      ).delivery,
      secondPage.deliveries[0],
    );
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

    const findingSubscription = {
      ...mutation,
      notificationChannelId: "findings",
      notificationChannelSettings: {
        ...mutation.notificationChannelSettings,
        sentinelFindings: {
          caseId: "main",
          runId: incident.plan.runId,
          afterRevision: incident.revision,
          events: [
            "sentinel_finding_created",
            "sentinel_finding_status_changed",
          ],
        },
      },
    };
    const findingScope = {
      caseId: "main",
      runId: incident.plan.runId!,
      evidenceRevision: incident.revision,
      taskId: "finding-assignment",
      targetId: "fixture-asset",
      graphFindingId: "fixture-finding",
      controlId: "fixture-control",
      evidenceId: "fixture-evidence",
      snapshotDigest: "a".repeat(64),
      observedAt: "2026-11-24T12:00:00.000Z",
      evaluatedAt: "2026-11-24T12:01:00.000Z",
      validUntil: "2026-11-24T12:02:00.000Z",
      title: "Private finding title",
      summary: "Private finding summary",
      requestId: crypto.randomUUID(),
    };
    const journal = openSentinelWorkerFindingStore(path);
    try {
      journal.recordFinding(findingScope);
      assertEquals(
        JSON.parse(await turn(findingSubscription)).channel.version,
        1,
      );
      const record = journal.recordFinding({
        ...findingScope,
        taskId: "new-finding-assignment",
        requestId: crypto.randomUUID(),
      });
      journal.recordFinding({
        ...findingScope,
        taskId: "outside-assignment",
        targetId: "outside-case-asset",
        requestId: crypto.randomUUID(),
      });
      const amend = {
        ...findingScope,
        taskId: "operator",
        findingId: record.id,
        expectedVersion: 1,
        disposition: "confirmed" as const,
        requestId: crypto.randomUUID(),
      };
      const update = journal.updateFindingReport(amend);
      journal.updateFindingReport({
        ...amend,
        expectedVersion: 2,
        requestId: crypto.randomUUID(),
      });
      await tickFindingCoordinator(path);
      assertEquals(calls, 6);
      const [created, changed] = payloads.slice(-2);
      assertEquals(created.receiptId, record.id);
      assertEquals(created.assignmentId, "new-finding-assignment");
      assertEquals(changed.receiptId, update.id);
      assertEquals(changed.previousStatus, "open");
      assertEquals(changed.status, "confirmed");
      assert(!JSON.stringify([created, changed]).includes("Private"));
      await disconnect();
      await connect();
      await tickFindingCoordinator(path);
      assertEquals(calls, 6);
      const results = JSON.parse(
        await turn({
          action: "notification_deliveries",
          notificationChannelId: "findings",
          notificationEventKind: "sentinel_finding_status_changed",
        }),
      ).deliveries;
      assertEquals(results.length, 1);
      assertEquals(results[0].source.receiptId, update.id);
      assertEquals(results[0].source.revision, incident.revision);
      assertEquals(results[0].source.reportVersion, 2);
    } finally {
      journal.close();
    }
    assertEquals(
      JSON.parse(
        await turn({
          action: "retire_notification_channel",
          notificationChannelId: "findings",
          expectedVersion: 1,
        }),
      ).channel.retired,
      true,
    );

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
    assertEquals(calls, 6);

    for (const { provider, url, signing } of providerFixtures) {
      const add = {
        ...mutation,
        notificationChannelId: provider,
        notificationChannelSettings: {
          ...mutation.notificationChannelSettings,
          provider,
          destinationOrigin: new URL(url).origin,
          endpointRef: `notification_${provider}`,
          ...(signing &&
            { signingSecretRef: `notification_${provider}_signing` }),
        },
      };
      assertEquals(JSON.parse(await turn(add)).channel.provider, provider);
      const probeProvider = {
        action: "test_notification_channel",
        notificationChannelId: provider,
        expectedVersion: 1,
        requestId: `send-${provider}`,
      };
      const result = await turn(probeProvider);
      assertEquals(JSON.parse(result).delivery.state, "delivered");
      assertEquals(await turn(probeProvider), result);
      providerCode = 1234;
      assertEquals(
        JSON.parse(
          await turn({
            ...probeProvider,
            requestId: `reject-${provider}`,
          }),
        ).delivery.state,
        "rejected",
      );
      providerCode = 0;
    }
    assertEquals(providerRequests.length, 6);
    const dingtalk = providerRequests[0];
    assertEquals(
      dingtalk.url.searchParams.get("access_token"),
      "synthetic-dingtalk-token",
    );
    assertEquals(dingtalk.url.searchParams.get("timestamp"), "1795708800000");
    assertEquals(
      dingtalk.url.searchParams.get("sign"),
      "UuPOybReZExkz4LpJ7lIoOyxba/vbPlU5qbxRuD47nM=",
    );
    assertEquals(dingtalk.body.msgtype, "markdown");
    const feishu = providerRequests[2];
    assertEquals(feishu.url.href, providerFixtures[1].url);
    assertEquals(feishu.body.timestamp, "1795708800");
    assertEquals(
      feishu.body.sign,
      "2XZLTaiRhcdXrYektpudO2E+j1jXMamLhYXRPSHayQM=",
    );
    assertEquals(feishu.body.msg_type, "interactive");
    const wecom = providerRequests[4];
    assertEquals(wecom.url.href, providerFixtures[2].url);
    assertEquals(wecom.body.msgtype, "markdown");
    assert(!("sign" in wecom.body));
    const feishuProbe = {
      action: "test_notification_channel",
      notificationChannelId: "feishu",
      expectedVersion: 1,
    };
    const retryRateLimit = {
      action: "retry_notification_delivery",
      notificationChannelId: "feishu",
      expectedVersion: 1,
      notificationDeliveryId: "feishu-rate-limited",
      requestId: "review-feishu-rate-limit",
    };
    providerCode = 11232;
    providerHttpStatus = 429;
    assertEquals(
      JSON.parse(
        await turn({
          ...feishuProbe,
          requestId: "feishu-http-429",
        }),
      ).delivery.state,
      "uncertain",
    );
    for (const notificationDeliveryId of ["feishu-http-429", "reject-feishu"]) {
      assertStringIncludes(
        await turn({
          ...retryRateLimit,
          notificationDeliveryId,
        }),
        "unavailable",
      );
    }
    providerHttpStatus = 200;
    assertEquals(
      JSON.parse(
        await turn({
          ...feishuProbe,
          requestId: retryRateLimit.notificationDeliveryId,
        }),
      ).delivery.state,
      "rate_limited",
    );
    const requestsBeforeRetry = providerRequests.length;
    await disconnect();
    await connect();
    const deliveries = JSON.parse(
      await turn({
        action: "notification_deliveries",
        notificationChannelId: "feishu",
        notificationDeliveryState: "rate_limited",
      }),
    ).deliveries;
    assertEquals(deliveries.map(({ id }: { id: string }) => id), [
      retryRateLimit.notificationDeliveryId,
    ]);
    preDenied = true;
    assertStringIncludes(await turn(retryRateLimit), "blocked by policy");
    preDenied = false;
    assertEquals(providerRequests.length, requestsBeforeRetry);

    allowReview = false;
    assertStringIncludes(await turn(retryRateLimit), "unavailable");
    allowReview = true;
    assertEquals(providerRequests.length, requestsBeforeRetry);

    providerCode = 0;
    const retried = await turn(retryRateLimit);
    assertEquals(JSON.parse(retried).delivery.state, "delivered");
    assertEquals(
      JSON.parse(retried).delivery.retries[0].requestId,
      retryRateLimit.requestId,
    );
    assertEquals(providerRequests.length, requestsBeforeRetry + 1);
    assertEquals(await turn(retryRateLimit), retried);
    assertEquals(providerRequests.length, requestsBeforeRetry + 1);
    const autoChannel = "scheduled-feishu";
    const autoSetting = {
      ...findingSubscription,
      notificationChannelId: autoChannel,
      notificationChannelSettings: {
        ...findingSubscription.notificationChannelSettings,
        provider: "feishu",
        destinationOrigin: new URL(providerFixtures[1].url).origin,
        endpointRef: "notification_feishu",
      },
    };
    assertEquals(JSON.parse(await turn(autoSetting)).channel.version, 1);
    const autoJournal = openSentinelWorkerFindingStore(path);
    let autoReceipt: string;
    try {
      autoReceipt = autoJournal.recordFinding({
        ...findingScope,
        taskId: "scheduled-retry-assignment",
        requestId: crypto.randomUUID(),
      }).id;
    } finally {
      autoJournal.close();
    }
    const autoDelivery = async () => {
      const listing = JSON.parse(
        await turn({
          action: "notification_deliveries",
          notificationChannelId: autoChannel,
        }),
      ).deliveries;
      assertEquals(listing.length, 1);
      assertEquals(listing[0].source.receiptId, autoReceipt);
      return listing[0];
    };

    const requestsBeforeAutomatic = providerRequests.length;
    providerCode = 11232;
    await tickFindingCoordinator(path);
    assertEquals(providerRequests.length, requestsBeforeAutomatic + 1);
    const initialDelivery = await autoDelivery();
    assertEquals(initialDelivery.state, "rate_limited");
    assertEquals(initialDelivery.scheduledRetryAt, deliveryClock + 5_000);

    deliveryClock = initialDelivery.scheduledRetryAt - 1;
    await disconnect();
    await connect();
    await tickFindingCoordinator(path);
    assertEquals(providerRequests.length, requestsBeforeAutomatic + 1);
    deliveryClock++;
    await Promise.all([
      tickFindingCoordinator(path),
      tickFindingCoordinator(path),
    ]);
    assertEquals(providerRequests.length, requestsBeforeAutomatic + 2);
    const firstRetry = await autoDelivery();
    assertEquals(firstRetry.state, "rate_limited");
    assertEquals(firstRetry.retries.length, 1);
    assertEquals(firstRetry.scheduledRetryAt, deliveryClock + 30_000);

    deliveryClock = firstRetry.scheduledRetryAt;
    await tickFindingCoordinator(path);
    assertEquals(providerRequests.length, requestsBeforeAutomatic + 3);
    const exhausted = await autoDelivery();
    assertEquals(exhausted.state, "rate_limited");
    assertEquals(exhausted.retries.length, 2);
    assertEquals(exhausted.scheduledRetryAt, undefined);
    deliveryClock += 60_000;
    await tickFindingCoordinator(path);
    assertEquals(providerRequests.length, requestsBeforeAutomatic + 3);

    const deniedJournal = openSentinelWorkerFindingStore(path);
    let deniedReceipt: string;
    try {
      deniedReceipt = deniedJournal.recordFinding({
        ...findingScope,
        taskId: "scheduled-denial-assignment",
        requestId: crypto.randomUUID(),
      }).id;
    } finally {
      deniedJournal.close();
    }
    await tickFindingCoordinator(path);
    assertEquals(providerRequests.length, requestsBeforeAutomatic + 4);
    deliveryClock += 5_000;
    denyAutomatic = true;
    await tickFindingCoordinator(path);
    assertEquals(providerRequests.length, requestsBeforeAutomatic + 4);
    const deniedRetry = JSON.parse(
      await turn({
        action: "notification_delivery",
        notificationChannelId: autoChannel,
        notificationDeliveryId: deniedReceipt,
      }),
    ).delivery;
    assertEquals(deniedRetry.state, "blocked");
    assertEquals(deniedRetry.retries.length, 1);
    assertEquals(deniedRetry.scheduledRetryAt, undefined);

    for (const key of await storage.list()) {
      const value = await storage.get(key);
      assert(!value?.includes("synthetic-dingtalk-token"));
      assert(!value?.includes("synthetic-dingtalk-signing"));
      assert(!value?.includes("synthetic-feishu-hook"));
      assert(!value?.includes("synthetic-feishu-signing"));
      assert(!value?.includes("synthetic-wecom-key"));
    }
  } finally {
    await disconnect();
    await Deno.remove(baseDir, { recursive: true });
  }
});
