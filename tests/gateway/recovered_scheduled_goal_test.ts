import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createSavedSourceAuthorization } from "../../src/agent/dispatch/saved_source_authorization.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import type { OrchestratorConfig } from "../../src/agent/orchestrator/orchestrator_config.ts";
import type { TriggerFishConfig } from "../../src/core/config_types.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { GoalCompletionStore } from "../../src/core/goal_completion.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import {
  type ChannelId,
  createSession,
  restoreSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildExecutionTracePayloadAuthorizer } from "../../src/gateway/startup/factory/agent_recovery.ts";
import {
  buildSchedulerGoalCompletion,
  scheduledGoalReportTool,
} from "../../src/gateway/startup/factory/scheduler_goal_completion.ts";
import { buildSchedulerRecoveryBindings } from "../../src/gateway/startup/factory/scheduler_recovery.ts";
import { createSchedulerService } from "../../src/scheduler/service.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";
import { computeHmac } from "../../src/scheduler/webhooks/webhooks.ts";

Deno.test("Recovered scheduled webhook proves one exact goal result without replaying either call", async () => {
  const directory = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const messages = createMessageStore(storage);
  const keychain = createMemorySecretStore();
  assert((await keychain.setSecret("github-pat", "scheduled-goal-fixture")).ok);
  const userId = "owner" as UserId;
  const owner = createSession({ userId, channelId: "owner" as ChannelId });
  const repo = "fixture/security";
  const sourceId = "ci-report";
  const secret = "fixture-webhook-secret";
  const body = '{"event":"pipeline_complete"}';
  const webhook = { secret, classification: "INTERNAL" as const };
  const output = {
    id: 12,
    repositoryId: 42,
    attempt: 2,
    status: "completed",
    conclusion: "success",
  };
  const resultSha256 = await computeContentHash(JSON.stringify(output));
  const goal = {
    scope: "pipeline",
    goal: "Verify the retained pipeline result.",
    policy: "operator",
    criteria: [{
      id: "status",
      description: "Verify the retained result.",
      kind: "webhook",
      source_id: sourceId,
      tool: "github_actions",
      result_sha256: resultSha256,
    }],
  } as const;
  const config: Pick<TriggerFishConfig, "agent_recovery" | "scheduler"> = {
    agent_recovery: {
      scheduler: true,
      github_repositories: [repo],
      github_run_status: true,
    },
    scheduler: {
      webhooks: { enabled: true, sources: { [sourceId]: webhook } },
      goal_completion: [goal],
    },
  };
  const request = {
    scope: goal.scope,
    criterion: "status",
    sourceCallId: "1:0",
    requestId: crypto.randomUUID(),
  };
  const sourceRead = {
    name: "github_actions",
    args: {
      action: "get_run",
      repo,
      run_id: output.id,
      attempt: output.attempt,
    },
  };
  const report = { name: scheduledGoalReportTool.name, args: request };
  let sourceCalls = 0;
  let reportCalls = 0;
  let sourceAllowed = true;
  let interruptAfterSource = true;
  let interruptAfterReport = true;
  let expireLease = false;
  const probe: typeof fetch = (url) => {
    if (new URL(String(url)).pathname === `/repos/${repo}`) {
      return Promise.resolve(
        Response.json({
          id: output.repositoryId,
          full_name: repo,
          visibility: "public",
        }),
      );
    }
    assertEquals(
      new URL(String(url)).pathname,
      `/repos/${repo}/actions/workflows`,
    );
    return Promise.resolve(
      new Response(null, { status: sourceAllowed ? 200 : 403 }),
    );
  };
  let observed: string | undefined;
  let gateway: ReturnType<typeof createGatewayServer> | undefined;
  const token = crypto.randomUUID();
  const start = async () => {
    const completion = buildSchedulerGoalCompletion(
      config,
      directory,
      messages,
    );
    assert(completion);
    const factory: OrchestratorFactory = {
      create(channel, options) {
        assert(options?.recoverySessionId && options.scheduledGoalRecovery);
        const execution = options.scheduledGoalRecovery;
        assertEquals(execution.sourceId, sourceId);
        assertEquals(execution.kind, "webhook");
        const session = restoreSession({
          id: options.recoverySessionId,
          channelId: channel as ChannelId,
          userId,
        });
        let taint: ClassificationLevel = "PUBLIC";
        const registry = createProviderRegistry();
        registry.register({
          name: "fixture",
          supportsStreaming: false,
          complete(history) {
            const prior = history.filter(({ role }) => role === "tool");
            if (prior.length === 1 && interruptAfterSource) {
              throw new Error("Gateway disconnected after the source result.");
            }
            if (prior.length === 1 && expireLease) {
              expireLease = false;
              const db = new DatabaseSync(
                join(directory, "scheduler-webhook-admissions.db"),
              );
              try {
                assertEquals(
                  db.prepare(
                    "UPDATE webhook_admissions SET leaseUntil = 0 WHERE id = ?",
                  ).run(execution.id).changes,
                  1,
                );
              } finally {
                db.close();
              }
            }
            if (prior.length === 2) {
              observed = String(prior[1].content);
              return Promise.resolve({
                content: "Published exact scheduler evidence.",
                toolCalls: [],
                usage: { inputTokens: 1, outputTokens: 1 },
              });
            }
            const next = prior.length ? report : sourceRead;
            return Promise.resolve({
              content: "",
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: [{
                type: "function",
                id: crypto.randomUUID(),
                function: {
                  name: next.name,
                  arguments: JSON.stringify(next.args),
                },
              }],
            });
          },
        });
        registry.setDefault("fixture");
        const orchestration: OrchestratorConfig = {
          providerRegistry: registry,
          enableStreaming: false,
          hookRunner: createHookRunner(createPolicyEngine()),
          tools: [{
            name: sourceRead.name,
            description: "Approved status",
            parameters: {},
          }, scheduledGoalReportTool],
          getSessionTaint: () => taint,
          escalateTaint: (level) => {
            taint = level;
          },
          async toolExecutor(name, args) {
            if (name === sourceRead.name) {
              sourceCalls++;
              return JSON.stringify({ ...output, _classification: "INTERNAL" });
            }
            reportCalls++;
            return await completion.reportRecovered(
              args,
              execution,
              session.id,
              createSavedSourceAuthorization(orchestration, session),
            );
          },
        };
        const agent = createOrchestrator(orchestration);
        return Promise.resolve({
          session,
          toolExecutor: orchestration.toolExecutor!,
          getSessionTaint: () => taint,
          orchestrator: {
            ...agent,
            executeAgentTurn(turn) {
              return agent.executeAgentTurn({
                ...turn,
                async onToolBatchCheckpoint(batch) {
                  if (interruptAfterReport && batch.completedIterations === 2) {
                    interruptAfterReport = false;
                    throw new Error(
                      "Gateway disconnected after committing the goal report.",
                    );
                  }
                  await turn.onToolBatchCheckpoint?.(batch);
                },
              });
            },
          },
        });
      },
    };
    const scheduler = createSchedulerService({
      ...buildSchedulerRecoveryBindings(config, directory, keychain, probe),
      goalCompletion: completion,
      orchestratorFactory: factory,
      executionTracePath: join(directory, "execution-traces.db"),
      triggerMdPath: join(directory, "TRIGGER.md"),
      trigger: {
        enabled: false,
        intervalMinutes: 30,
        classificationCeiling: "INTERNAL",
      },
      webhooks: { enabled: true, sources: { [sourceId]: webhook } },
    });
    gateway = createGatewayServer({
      port: 0,
      token,
      schedulerService: scheduler,
      chatSession: createChatSession({
        session: owner,
        targetClassification: "INTERNAL",
        getSessionTaint: () => "INTERNAL",
        providerRegistry: createProviderRegistry(),
        hookRunner: createHookRunner(createPolicyEngine()),
        goalCompletionPath: join(directory, "goal-completion.db"),
        messageStore: messages,
        runManagedGoalCommand: completion.runCommand,
        tools: [{
          name: sourceRead.name,
          description: "Approved status",
          parameters: {},
        }],
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir: directory,
          confirm: () => Promise.resolve(true),
          authorizeExecutionTracePayload: buildExecutionTracePayloadAuthorizer(
            config,
            keychain,
            probe,
          ),
        }),
      }),
    });
    return (await gateway.start()).port;
  };
  const chat = async (port: number, content: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const done = Promise.withResolvers<string>();
    const timeout = setTimeout(
      () => done.reject(new Error("Scheduled goal chat timed out")),
      3000,
    );
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "message", content }));
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.type === "response" || event.type === "error") {
        done.resolve(event.text ?? event.message);
      }
    };
    try {
      return await done.promise;
    } finally {
      clearTimeout(timeout);
      socket.close();
    }
  };

  try {
    let port = await start();
    const timestamp = String(Date.now());
    const signature = await computeHmac(`${timestamp}.${body}`, secret);
    const initial = await fetch(
      `http://127.0.0.1:${port}/webhooks/${sourceId}`,
      {
        method: "POST",
        headers: { "x-timestamp": timestamp, "x-signature": signature },
        body,
      },
    );
    assertEquals(initial.status, 200);
    const { executionId, delivered } = await initial.json();
    assert(!delivered);
    assertStringIncludes(executionId, "scheduler-webhook-");
    assertEquals(sourceCalls, 1);
    interruptAfterSource = false;
    await gateway?.stop();
    port = await start();
    const resume = async () => {
      const reply = await fetch(
        `http://127.0.0.1:${port}/recovery/webhooks/${executionId}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body,
        },
      );
      await reply.text();
      return reply.status;
    };
    sourceAllowed = false;
    assertEquals(await resume(), 409);
    assertEquals(reportCalls, 0);
    sourceAllowed = true;
    expireLease = true;
    assertEquals(await resume(), 409);
    assertEquals(expireLease, false);
    assertEquals(reportCalls, 0);
    const store = new GoalCompletionStore(
      join(directory, "goal-completion.db"),
    );
    try {
      const scope = "scheduler:pipeline";
      assertEquals(store.read(scope)?.status, "open");
      assertEquals(await resume(), 409);
      assertEquals(reportCalls, 1);
      const receipt = store.readEvidenceSubmission(scope, request.requestId);
      assert(receipt);
      assertEquals(receipt.receipt.status, "awaiting_confirmation");
      assertEquals(
        receipt.receipt.proof.source,
        `scheduler-trace:webhook:${sourceId}`,
      );
      assertStringIncludes(
        receipt.receipt.proof.reference,
        `${executionId}:1:`,
      );
      sourceAllowed = false;
      assertEquals(await resume(), 409);
      assertEquals(observed, undefined);
      sourceAllowed = true;
      assertEquals(await resume(), 200);
      assert(observed);
      assertEquals(
        JSON.parse(observed).evidenceReference,
        receipt.receipt.proof.reference,
      );
      assertEquals(JSON.parse(observed)._classification, "INTERNAL");
      assertEquals(sourceCalls, 1);
      assertEquals(reportCalls, 1);
      assertEquals(
        store.readEvidenceSubmission(scope, request.requestId),
        receipt,
      );
      const pending = JSON.parse(
        await chat(port, "/goal scheduler status pipeline"),
      );
      const command =
        `/goal scheduler confirm pipeline ${pending.confirmation.decisionSha256}`;
      sourceAllowed = false;
      assertStringIncludes(
        await chat(port, command),
        "could not be reverified",
      );
      sourceAllowed = true;
      const completed = JSON.parse(await chat(port, command));
      assertEquals(completed.status, "completed");
      assertEquals(completed.observations, pending.observations);
    } finally {
      store.close();
    }
  } finally {
    await gateway?.stop();
    await storage.close();
    await Deno.remove(directory, { recursive: true });
  }
});
