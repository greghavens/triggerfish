import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { TriggerFishConfig } from "../../src/core/config_types.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createSqliteStorage } from "../../src/core/storage/sqlite.ts";
import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createOrchestratorFactory } from "../../src/gateway/startup/factory/orchestrator_factory.ts";
import { buildSchedulerGoalCompletion } from "../../src/gateway/startup/factory/scheduler_goal_completion.ts";
import { createSchedulerService } from "../../src/scheduler/service.ts";
import { createCronManager } from "../../src/scheduler/cron/cron.ts";
import { computeTimestampedHmac } from "../../src/scheduler/mod.ts";

async function readStatus(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const reply = Promise.withResolvers<string>();
  const timeout = setTimeout(
    () => reply.reject(new Error("Goal status timed out")),
    3000,
  );
  socket.onopen = () =>
    socket.send(JSON.stringify({
      type: "message",
      content: "/goal scheduler status review",
    }));
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "response") reply.resolve(event.text);
    if (event.type === "error") reply.reject(new Error(event.message));
  };
  try {
    return JSON.parse(await reply.promise);
  } finally {
    socket.close();
    clearTimeout(timeout);
  }
}

async function testScheduledReport(
  deny: boolean,
  kind: "trigger" | "cron" | "webhook" = "trigger",
) {
  const baseDir = await Deno.makeTempDir();
  const storagePath = join(baseDir, "storage.db");
  let storage = createSqliteStorage(storagePath);
  const expected =
    "No todos. Use todo_write to create your task list. Revision: empty";
  const cronManager = createCronManager();
  const cron = cronManager.create({
    expression: "* * * * *",
    task: "Report the scheduled goal criterion.",
    classificationCeiling: "PUBLIC",
  });
  assert(cron.ok);
  const sourceId = kind === "cron"
    ? cron.value.id
    : kind === "webhook"
    ? "control"
    : "trigger";
  const webhookSecret = "fixture-scheduler-signed-webhook";
  const webhookSources = {
    control: { secret: webhookSecret, classification: "PUBLIC" as const },
    "unrelated-source": {
      secret: "another-fixture-webhook",
      classification: "PUBLIC" as const,
    },
  };
  const lastResult = Promise.withResolvers<string>();
  const finishTurn = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const report = (criterion: string) => ({
    name: "scheduled_goal_report",
    arguments: JSON.stringify({ scope: "review", criterion }),
  });
  const model = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      try {
        if (new URL(request.url).pathname !== "/v1/chat/completions") {
          return new Response(null, { status: 404 });
        }
        const body = await request.json();
        assert(
          body.tools.some((
            { function: tool }: { function: { name: string } },
          ) => tool.name === "scheduled_goal_report"),
        );
        const history = body.messages.filter(({ role }: { role: string }) =>
          role === "tool"
        ).map(({ content }: { content: string }) => content);
        let call;
        switch (history.length) {
          case 0:
            call = report("exact");
            break;
          case 1:
            assertStringIncludes(history[0], deny ? "approval" : "unavailable");
            call = { name: "todo_read", arguments: "{}" };
            break;
          case 2:
            assertEquals(history[1], expected);
            call = report("wrong-source");
            break;
          case 3:
            assertStringIncludes(history[2], deny ? "approval" : "unavailable");
            call = report("exact");
            break;
          default:
            lastResult.resolve(history[3]);
            await finishTurn.promise;
        }
        const message = call
          ? {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: crypto.randomUUID(),
              type: "function",
              function: call,
            }],
          }
          : { role: "assistant", content: "Scheduled review finished." };
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
      } catch (error) {
        lastResult.reject(error);
        return new Response(null, { status: 500 });
      }
    },
  );
  const provider = {
    model: "fixture",
    endpoint: `http://127.0.0.1:${model.addr.port}`,
  };
  const resultSha256 = await computeContentHash(expected);
  const config: TriggerFishConfig = {
    models: {
      primary: { provider: "ollama", model: "fixture" },
      providers: { ollama: provider },
    },
    channels: {},
    classification: { mode: "strict" },
    ...(deny && { tool_approval: ["scheduled_goal_report"] }),
    scheduler: {
      webhooks: { enabled: kind === "webhook", sources: webhookSources },
      goal_completion: [{
        scope: "review",
        goal: "Verify evidence from the exact configured scheduler source.",
        policy: "operator",
        criteria: ["exact", "wrong-source"].map((id) => ({
          id,
          description: `Check the ${id} result.`,
          kind: id === "wrong-source" && kind === "trigger" ? "cron" : kind,
          source_id: id === "exact" ? sourceId : "unrelated-source",
          tool: "todo_read",
          result_sha256: resultSha256,
        })),
      }],
    },
  };
  const triggerMdPath = join(baseDir, "TRIGGER.md");
  await Deno.writeTextFile(triggerMdPath, "Report the trigger goal criterion.");
  const owner = createSession({
    userId: "owner" as UserId,
    channelId: "owner" as ChannelId,
  });
  const token = crypto.randomUUID();
  const open = () => {
    const messages = createMessageStore(storage);
    const goals = buildSchedulerGoalCompletion(config, baseDir, messages);
    assert(goals);
    const factory = createOrchestratorFactory(
      config,
      baseDir,
      undefined,
      storage,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      goals,
    );
    const schedulerService = createSchedulerService({
      orchestratorFactory: factory,
      goalCompletion: goals,
      triggerMdPath,
      cronManager,
      trigger: {
        enabled: false,
        intervalMinutes: 1,
        classificationCeiling: "PUBLIC",
      },
      webhooks: {
        enabled: kind === "webhook",
        sources: {
          control: { secret: webhookSecret, classification: "PUBLIC" },
        },
      },
      onTriggerOutput: () => {
        returned.resolve();
      },
    });
    const gateway = createGatewayServer({
      port: 0,
      token,
      schedulerService,
      chatSession: createChatSession({
        session: owner,
        providerRegistry: createProviderRegistry(),
        hookRunner: createHookRunner(createPolicyEngine()),
        goalCompletionPath: join(baseDir, "goal-completion.db"),
        messageStore: messages,
        runManagedGoalCommand: goals.runCommand,
      }),
    });
    return { gateway, schedulerService };
  };
  let { gateway, schedulerService } = open();
  const inbox = createToolApprovalService(join(baseDir, "tool-approvals.db"));
  const denialTimer = deny
    ? setInterval(() => {
      for (const request of inbox.list().records) {
        if (
          request.tool === "scheduled_goal_report" &&
          request.status === "pending"
        ) {
          inbox.decide(request.id, "denied");
        }
      }
    }, 5)
    : undefined;
  const timeout = setTimeout(() => {
    const error = new Error("Scheduled report did not reach the model");
    lastResult.reject(error);
    returned.reject(error);
  }, 4500);
  void returned.promise.catch(() => {});
  try {
    const { port } = await gateway.start();
    let webhookDelivery: Promise<Response> | undefined;
    if (kind === "cron") {
      schedulerService.start();
    } else if (kind === "webhook") {
      const body = '{"event":"review.cloud.control"}';
      const timestamp = String(Date.now());
      const signature = await computeTimestampedHmac(
        timestamp,
        body,
        webhookSecret,
      );
      const url = `http://127.0.0.1:${port}/webhooks/${sourceId}`;
      const send = (value: string) =>
        fetch(url, {
          method: "POST",
          body,
          headers: { "x-timestamp": timestamp, "x-signature": value },
        });
      const rejected = await send("0".repeat(signature.length));
      assertEquals(rejected.status, 401);
      await rejected.body?.cancel();
      assertEquals((await readStatus(port, token)).satisfied, []);
      webhookDelivery = send(signature);
    } else {
      const response = await fetch(
        `http://127.0.0.1:${port}/debug/run-triggers`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      assertEquals(response.status, 200);
      await response.body?.cancel();
    }
    const observed = await lastResult.promise;
    const status = await readStatus(port, token);
    assertEquals(status.status, "open");
    if (deny) {
      assertStringIncludes(observed, "approval");
      assertEquals(status.satisfied, []);
    } else {
      const evidence = JSON.parse(observed);
      assertEquals(evidence.verified, true);
      assertEquals(evidence._classification, "PUBLIC");
      assertEquals(status.satisfied, ["exact"]);
      assertEquals(
        status.observations[0].evidence[0].source,
        `scheduler:${kind}:${sourceId}`,
      );
      assertEquals(
        status.observations[0].evidence[0].reference,
        evidence.evidenceReference,
      );
    }
    finishTurn.resolve();
    if (kind === "cron") {
      const deadline = Date.now() + 2_000;
      while (!cronManager.history(sourceId).length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assertEquals(cronManager.history(sourceId).at(-1)?.success, true);
    } else if (webhookDelivery) {
      const completed = await webhookDelivery;
      assertEquals(completed.status, 200);
      await completed.body?.cancel();
    } else {
      await returned.promise;
    }
    schedulerService.stop();
    await gateway.stop();
    await storage.close();
    storage = createSqliteStorage(storagePath);
    ({ gateway, schedulerService } = open());
    const restarted = await gateway.start();
    const saved = await readStatus(restarted.port, token);
    assertEquals(saved.satisfied, ["exact"]);
    assertEquals(saved.open, ["wrong-source"]);
    const [sourceSession, messageId] = saved.observations[0].evidence[0]
      .reference.split(":");
    const rows = await createMessageStore(storage).loadSession(sourceSession);
    const original = rows.find((row) => row.message_id === messageId);
    assertEquals(original?.content, expected);
    assertEquals(original?.tool_name, "todo_read");
    if (!deny) assertEquals(saved, status);
  } finally {
    finishTurn.resolve();
    clearTimeout(timeout);
    clearInterval(denialTimer);
    schedulerService.stop();
    await gateway.stop();
    await model.shutdown();
    await storage.close();
    await Deno.remove(baseDir, { recursive: true });
  }
}

Deno.test("An authenticated gateway trigger commits exact goal evidence before it finishes", () =>
  testScheduledReport(false));
Deno.test("Root approval denial blocks a scheduled model's goal report while it is running", () =>
  testScheduledReport(true));

Deno.test("A configured cron occurrence reports only its exact goal criterion through the gateway", () =>
  testScheduledReport(false, "cron"));
Deno.test("A signed webhook reports only its authorized source goal criterion through the gateway", () =>
  testScheduledReport(false, "webhook"));
Deno.test("Root approval denial blocks goal reporting on a configured cron occurrence", () =>
  testScheduledReport(true, "cron"));
Deno.test("Root approval denial blocks goal reporting on a signed webhook", () =>
  testScheduledReport(true, "webhook"));
