import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { runRecoverableAgentTurn } from "../../src/gateway/agent_recovery.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  type ChannelId,
  restoreSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createSchedulerService } from "../../src/scheduler/service.ts";
import type {
  SchedulerExecutionIdentity,
  SchedulerServiceConfig,
} from "../../src/scheduler/service_types.ts";
import { openSchedulerWebhookAdmissions } from "../../src/scheduler/webhooks/admissions.ts";
import { createReplayGuard } from "../../src/scheduler/webhooks/replay_guard.ts";
import { computeHmac } from "../../src/scheduler/webhooks/webhooks.ts";

Deno.test("webhook recovery requires exact signed admission and current authorization across restart", async () => {
  const directory = await Deno.makeTempDir();
  let gateway: ReturnType<typeof createGatewayServer> | undefined;
  try {
    const journalPath = join(directory, "webhooks.db");
    const recoveryPath = join(directory, "recovery.db");
    const secret = "original-test-source-credential";
    const body = '{"event":"fixture","data":"original-sensitive-test-body"}';
    const ceiling = "INTERNAL";
    const executions: SchedulerExecutionIdentity[] = [];
    const delivered: string[] = [];
    let listenerCalls = 0;
    let toolReads = 0;
    let reauthorizations = 0;
    const resumeStarted = Promise.withResolvers<void>();
    const finishResume = Promise.withResolvers<void>();
    const usage = { inputTokens: 1, outputTokens: 1 };
    let readyToResume = false;
    const base: SchedulerServiceConfig = {
      orchestratorFactory: {
        create(channel, options) {
          assert(options?.recoverySessionId);
          assertEquals(options.ceiling, ceiling);
          const session = restoreSession({
            id: options.recoverySessionId,
            userId: "owner" as UserId,
            channelId: channel as ChannelId,
          });
          const registry = createProviderRegistry();
          registry.register({
            name: "fixture",
            supportsStreaming: false,
            async complete(messages) {
              const savedRead = messages.find(({ role }) => role === "tool");
              if (savedRead) {
                assertEquals(savedRead.content, "Verified fixture result");
                if (!readyToResume) {
                  throw new Error("Interrupted after tool batch commit");
                }
                resumeStarted.resolve();
                await finishResume.promise;
                return {
                  content: "Recovered with shared runner",
                  toolCalls: [],
                  usage,
                };
              }
              return {
                content: "",
                toolCalls: [{
                  id: "read",
                  type: "function",
                  function: { name: "fixture_read", arguments: "{}" },
                }],
                usage,
              };
            },
          });
          registry.setDefault("fixture");
          const toolExecutor = () => {
            toolReads++;
            return Promise.resolve("Verified fixture result");
          };
          return Promise.resolve({
            session,
            getSessionTaint: () => ceiling,
            toolExecutor,
            orchestrator: createOrchestrator({
              providerRegistry: registry,
              hookRunner: {
                evaluateHook: () =>
                  Promise.resolve({
                    allowed: true,
                    action: "ALLOW",
                    ruleId: null,
                    duration: 0,
                  }),
              },
              tools: [{
                name: "fixture_read",
                description: "Read fixed fixture.",
                parameters: {},
              }],
              toolExecutor,
            }),
          });
        },
      },
      recoverTurn(execution, orchestrator, options) {
        executions.push(execution);
        assertEquals(options.session.channelId, execution.id);
        assertEquals(options.targetClassification, ceiling);
        assertEquals(
          options.message,
          `Webhook event from source: fixture\n\nPayload:\n${body}`,
        );
        return runRecoverableAgentTurn(
          recoveryPath,
          execution.id,
          {
            version: "fixture-read",
            projectCall: (call) =>
              call.name === "fixture_read" ? {} : undefined,
            projectResult: (_, text) =>
              text === "Verified fixture result" ? text : undefined,
            authorize(receipt) {
              reauthorizations++;
              return Promise.resolve(receipt.name === "fixture_read");
            },
            classification: () => "PUBLIC",
          },
          orchestrator,
          options,
          { resumeOnly: execution.resumeOnly },
        );
      },
      triggerMdPath: "/unused",
      trigger: {
        enabled: false,
        intervalMinutes: 30,
        classificationCeiling: ceiling,
      },
      webhooks: {
        enabled: true,
        maxAgeMs: 60_000,
        sources: { source: { secret, classification: ceiling } },
      },
      onTriggerOutput: (source) => delivered.push(source),
    };
    const serviceFor = (webhooks = base.webhooks) => {
      const service = createSchedulerService({
        ...base,
        webhooks,
        webhookAdmissions: openSchedulerWebhookAdmissions(journalPath),
      });
      service.webhookHandler.on("fixture", () => {
        listenerCalls++;
        return Promise.resolve();
      });
      return service;
    };
    const original = serviceFor();
    const stale = String(Date.now() - 61_000);
    const timestamp = String(Date.now());
    const signature = await computeHmac(`${timestamp}.${body}`, secret);
    assertFalse(
      (await original.handleWebhookRequest("source", body, {
        timestamp: stale,
        signature: await computeHmac(`${stale}.${body}`, secret),
      })).ok,
    );
    assertFalse(
      (await original.handleWebhookRequest("source", body, {
        timestamp,
        signature: await computeHmac(
          `${timestamp}.${body}`,
          "incorrect-secret",
        ),
      })).ok,
    );
    assertEquals(executions, []);
    const accepted = await original.handleWebhookRequest("source", body, {
      timestamp,
      signature,
    });
    assert(accepted.ok && accepted.executionId);
    const { executionId } = accepted;
    assertMatch(executionId, /^scheduler-webhook-[a-f0-9]{64}$/);
    assertEquals(executions, [{
      kind: "webhook",
      sourceId: "source",
      id: executionId,
    }]);
    const journal = new TextDecoder().decode(await Deno.readFile(journalPath));
    assertFalse(journal.includes(secret));
    assertFalse(journal.includes(signature));
    assertFalse(journal.includes("original-sensitive-test-body"));

    const restarted = serviceFor();
    assertFalse(
      (await restarted.handleWebhookRequest("source", body, {
        timestamp,
        signature,
      })).ok,
    );
    assertFalse(
      (await restarted.resumeWebhookExecution(executionId, body + " ")).ok,
    );
    assertFalse((await restarted.resumeWebhookExecution("missing", body)).ok);
    assertFalse(
      (await serviceFor({
        ...base.webhooks,
        sources: {
          source: { secret: "rotated-credential", classification: ceiling },
        },
      }).resumeWebhookExecution(executionId, body)).ok,
    );
    assertFalse(
      (await serviceFor({
        ...base.webhooks,
        sources: { source: { secret, classification: "PUBLIC" } },
      }).resumeWebhookExecution(executionId, body)).ok,
    );
    assertFalse(
      (await serviceFor({
        ...base.webhooks,
        maxAgeMs: 120_000,
      }).resumeWebhookExecution(executionId, body)).ok,
    );
    assertFalse(
      (await serviceFor({
        ...base.webhooks,
        sources: {},
      }).resumeWebhookExecution(executionId, body)).ok,
    );
    assertEquals(executions.length, 1);

    readyToResume = true;
    const token = crypto.randomUUID();
    gateway = createGatewayServer({
      port: 0,
      token,
      schedulerService: restarted,
    });
    const { port } = await gateway.start();
    const endpoint =
      `http://127.0.0.1:${port}/recovery/webhooks/${executionId}`;
    assertEquals(
      (await fetch(`${endpoint}?token=${token}`, { method: "POST", body }))
        .status,
      401,
    );
    const resume = fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    });
    try {
      await Promise.race([
        resumeStarted.promise,
        resume.then(() => {
          throw new Error(
            "Recovery ended before the provider saw saved history",
          );
        }),
      ]);
      assertFalse(
        (await serviceFor().resumeWebhookExecution(executionId, body)).ok,
      );
    } finally {
      finishResume.resolve();
    }
    const response = await resume;
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { ok: true });
    assertFalse(
      (await serviceFor().resumeWebhookExecution(executionId, body)).ok,
    );
    assertEquals(executions.length, 2);
    assertEquals(executions[1], { ...executions[0], resumeOnly: true });
    assertEquals(delivered, ["webhook:source"]);
    assertEquals(listenerCalls, 0);
    assertEquals(toolReads, 1);
    assertEquals(reauthorizations, 1);
    const recovery = new TextDecoder().decode(
      await Deno.readFile(recoveryPath),
    );
    assertFalse(recovery.includes("original-sensitive-test-body"));
  } finally {
    await gateway?.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("persistent webhook replay guard writes opaque keys and respects legacy signatures", async () => {
  const storage = createMemoryStorage();
  const signature = "sha256=fixture-signature";
  const legacy = "sha256=legacy-signature";
  await storage.set(`webhook:replay:${legacy}`, String(Date.now()));
  const replay = createReplayGuard({ storage });
  assertFalse(await replay.claimSignature(legacy));
  assert(await replay.claimSignature(signature));
  const keys = await storage.list("webhook:replay:");
  assertEquals(keys.length, 2);
  assertFalse(keys.some((key) => key.includes(signature)));
  assertFalse(await createReplayGuard({ storage }).claimSignature(signature));
});
