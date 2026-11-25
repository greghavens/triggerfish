import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { openExecutionTraces } from "../../src/core/execution_traces.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { runRecoverableAgentTurn } from "../../src/gateway/agent_recovery.ts";
import { createWorkflowRecoveryPolicy } from "../../src/gateway/workflow_recovery_policy.ts";
import { executeOperatorRunArchive } from "../../src/gateway/operator_run_archive.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  type ChannelId,
  restoreSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createSchedulerService } from "../../src/scheduler/service.ts";
import { schedulerRecoveryState } from "../../src/scheduler/service_execution.ts";
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
    const journalPath = join(directory, "scheduler-webhook-admissions.db");
    const recoveryPath = join(directory, "agent-recovery.db");
    const executionTracePath = join(directory, "execution-traces.db");
    const secret = "original-test-source-credential";
    const body = '{"event":"fixture","data":"original-sensitive-test-body"}';
    const ceiling = "INTERNAL";
    const repository = "example/actions-fixture";
    const runs = [{ id: 123, status: "completed", conclusion: "success" }];
    const repositoryId = 54321;
    const projected = JSON.stringify({ runs, repositoryId });
    const privateToolResult = "sensitive unapproved tool result field";
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
      executionTracePath,
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
                assertEquals(savedRead.content, projected);
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
                  function: {
                    name: "github_actions",
                    arguments: JSON.stringify({
                      action: "list_runs",
                      repo: repository,
                      workflow: "42",
                    }),
                  },
                }],
                usage,
              };
            },
          });
          registry.setDefault("fixture");
          const toolExecutor = () => {
            toolReads++;
            return Promise.resolve(
              JSON.stringify({
                runs,
                repositoryId,
                metadata: privateToolResult,
              }),
            );
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
                name: "github_actions",
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
          createWorkflowRecoveryPolicy({
            repositories: [repository],
            classification: () => "PUBLIC",
            authorizeRepository(repo, _level, workflow, savedRepositoryId) {
              reauthorizations++;
              return Promise.resolve(
                repo === repository && workflow === "42" &&
                  savedRepositoryId === repositoryId,
              );
            },
          }),
          orchestrator,
          options,
          {
            resumeOnly: execution.resumeOnly,
            resumePaused: execution.resumePaused,
          },
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

    const ref = { kind: "scheduled", id: executionId } as const;
    const archiveId = crypto.randomUUID();
    const confirm = () => Promise.resolve(true);
    const archived = await executeOperatorRunArchive(directory, ref, {
      action: "archive",
      ...ref,
      requestId: archiveId,
    }, confirm);
    assert(typeof archived !== "string");
    assertEquals((archived.receipt as { status: string }).status, "succeeded");
    const contents = await Deno.readTextFile(
      join(
        directory,
        "data",
        "run-archives",
        archiveId,
        "execution-trace.json",
      ),
    );
    assertFalse(contents.includes(secret));
    assertFalse(contents.includes(signature));
    assertFalse(contents.includes("original-sensitive-test-body"));
    await Deno.rename(
      journalPath,
      join(directory, "original-webhook-admission.db"),
    );
    await Deno.rename(recoveryPath, join(directory, "original-recovery.db"));
    await Deno.rename(
      executionTracePath,
      join(directory, "original-traces.db"),
    );
    const conflict = openSchedulerWebhookAdmissions(journalPath);
    const savedAdmission = JSON.parse(contents).admission;
    const conflictingAdmission = {
      ...savedAdmission,
      promptDigest: "a".repeat(64),
    };
    assert(conflict.admit(conflictingAdmission));
    const restore = () =>
      executeOperatorRunArchive(directory, ref, {
        action: "restore",
        ...ref,
        archiveId,
        requestId: crypto.randomUUID(),
      }, confirm);
    const rejected = await restore();
    assert(typeof rejected !== "string");
    assertEquals((rejected.receipt as { status: string }).status, "failed");
    assertEquals(conflict.readPending(executionId), conflictingAdmission);
    assertEquals(schedulerRecoveryState(recoveryPath, executionId), undefined);
    const rejectedTrace = openExecutionTraces(executionTracePath);
    try {
      assertEquals(
        rejectedTrace.readRun("scheduled", executionId, ceiling),
        undefined,
      );
    } finally {
      rejectedTrace.close();
    }
    await Deno.rename(
      journalPath,
      join(directory, "conflicting-webhook-admission.db"),
    );
    const restored = await restore();
    assert(typeof restored !== "string");
    assertEquals((restored.receipt as { status: string }).status, "succeeded");
    assertFalse((await restarted.resumeWebhookExecution(executionId, body)).ok);

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
    const stage = (payload: string) =>
      fetch(`${endpoint}?stage=true`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: payload,
      });
    assertEquals((await stage(body + " ")).status, 409);
    assertEquals((await stage(body)).status, 200);
    assertEquals(
      (await fetch(
        `http://127.0.0.1:${port}/recovery/scheduled/${executionId}`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      )).status,
      404,
    );

    const registry = createProviderRegistry();
    let result = "";
    let deny = true;
    let confirmed = false;
    registry.register({
      name: "webhook-owner",
      supportsStreaming: false,
      complete(messages) {
        assertFalse(
          JSON.stringify(messages).includes("original-sensitive-test-body"),
        );
        const last = messages.at(-1);
        if (last?.role === "tool") result = String(last.content);
        return Promise.resolve({
          usage,
          content: last?.role === "tool" ? "Checked." : "",
          toolCalls: last?.role === "tool" ? [] : [{
            type: "function",
            id: crypto.randomUUID(),
            function: {
              name: "operator_runs",
              arguments: JSON.stringify({
                action: "resume",
                kind: "scheduled",
                id: executionId,
              }),
            },
          }],
        });
      },
    });
    registry.setDefault("webhook-owner");
    const owner = createChatSession({
      session: restoreSession({
        id: crypto.randomUUID() as Parameters<typeof restoreSession>[0]["id"],
        userId: "owner" as UserId,
        channelId: "owner" as ChannelId,
      }),
      targetClassification: "INTERNAL",
      enableStreaming: false,
      providerRegistry: registry,
      hookRunner: {
        evaluateHook: (event) => {
          const blocked = deny && event === "PRE_TOOL_CALL";
          return Promise.resolve({
            allowed: !blocked,
            action: blocked ? "BLOCK" : "ALLOW",
            ruleId: null,
            duration: 0,
          });
        },
      },
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir: directory,
        resumeScheduledExecution: restarted.resumeScheduledExecution,
        confirm: () => {
          confirmed = true;
          return Promise.resolve(true);
        },
      }),
    });
    const control = () =>
      owner.executeAgentTurn("Resume the admitted run.", () => {});
    await control();
    assertFalse(confirmed);
    deny = false;
    const resume = control();
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
    await resume;
    assert(confirmed);
    assertEquals(JSON.parse(result).run.status, "completed");
    assertEquals((await stage(body)).status, 409);
    assertFalse(
      (await serviceFor().resumeWebhookExecution(executionId, body)).ok,
    );
    assertEquals(executions.length, 3);
    assertEquals(executions[1], { ...executions[0], resumeOnly: true });
    assertEquals(executions[2], {
      ...executions[0],
      resumeOnly: true,
      resumePaused: true,
    });
    assertEquals(delivered, ["webhook:source"]);
    assertEquals(listenerCalls, 0);
    assertEquals(toolReads, 1);
    assertEquals(reauthorizations, 1);
    const traces = openExecutionTraces(executionTracePath);
    try {
      const run = traces.readRun("scheduled", executionId, ceiling);
      assert(run);
      assertEquals(run.scope.sourceId, "source");
      assertEquals(run.status, "completed");
      const page = traces.list(run.scope, { ceiling });
      assertEquals(traces.readApprovedPayload(run.scope, 1, ceiling), {
        kind: "github_actions_status",
        repo: repository,
        repositoryId,
        workflow: "42",
        runs,
      });

      assertEquals(
        page?.steps.map(({ ordinal, tool, outcome }) => ({
          ordinal,
          tool,
          outcome,
        })),
        [
          { ordinal: 1, tool: "github_actions", outcome: "returned" },
        ],
      );
    } finally {
      traces.close();
    }
    const traceBytes = new TextDecoder().decode(
      await Deno.readFile(executionTracePath),
    );
    for (
      const privateValue of [secret, signature, body, privateToolResult]
    ) {
      assertFalse(traceBytes.includes(privateValue));
    }

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
