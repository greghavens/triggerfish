import { backgroundGoalStateTool } from "../../src/gateway/startup/factory/background_goal_state.ts";
import { readRecoveredGoalState } from "../../src/gateway/startup/factory/recovered_goal_state.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";
import { schedulerAdmissionArchive } from "../../src/scheduler/admission_archive.ts";
import { createCronManager } from "../../src/scheduler/cron/cron.ts";
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

async function verifyRecoveredScheduledGoal(
  kind: "webhook" | "trigger" | "cron",
) {
  const directory = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const messages = createMessageStore(storage);
  const keychain = createMemorySecretStore();
  assert((await keychain.setSecret("github-pat", "scheduled-goal-fixture")).ok);
  const userId = "owner" as UserId;
  const owner = createSession({ userId, channelId: "owner" as ChannelId });
  const repo = "fixture/security";
  const cronManager = createCronManager();
  const cron = cronManager.create({
    expression: "* * * * *",
    task: "Report the exact retained pipeline result.",
    classificationCeiling: "INTERNAL",
  });
  assert(cron.ok);
  const sourceId = kind === "cron"
    ? cron.value.id
    : kind === "trigger"
    ? "trigger"
    : "ci-report";
  const triggerMdPath = join(directory, "TRIGGER.md");
  await Deno.writeTextFile(
    triggerMdPath,
    "Report the exact retained pipeline result.",
  );
  const paused = Promise.withResolvers<{ id: string; sessionId: string }>();
  const hookEvents: string[] = [];
  let denySourceCall = false;
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
      kind,
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
  let statusCalls = 0;
  let sourceAllowed = true;
  let interruptAfterSource = true;
  let interruptAfterReport = kind === "webhook";
  let interruptAfterStatus = true;
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
  let scheduler: ReturnType<typeof createSchedulerService> | undefined;
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
        assertEquals(execution.kind, kind);
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
            if (prior.length === 1) {
              assertEquals(prior[0].content, JSON.stringify(output));
              if (interruptAfterSource) {
                if (kind !== "webhook") {
                  const store = new AgentRecoveryStore(
                    join(directory, "agent-recovery.db"),
                  );
                  try {
                    const key = assignmentRecoveryKey(session.id, execution.id);
                    assert(store.pause(key));
                    paused.resolve({ id: execution.id, sessionId: session.id });
                  } finally {
                    store.close();
                  }
                }
                throw new Error(
                  "Gateway disconnected after the source result.",
                );
              }
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
            if (prior.length === 3) {
              observed = String(prior[1].content);
              const status = JSON.parse(String(prior[2].content));
              assertEquals(status.satisfied, [request.criterion]);
              assertEquals(status.open, []);
              assertEquals(
                status.criteria[0].evidence.reference,
                JSON.parse(observed).evidenceReference,
              );
              assertEquals(status._classification, "INTERNAL");
              return Promise.resolve({
                content: "Published exact scheduler evidence.",
                toolCalls: [],
                usage: { inputTokens: 1, outputTokens: 1 },
              });
            }
            const next = prior.length === 2
              ? {
                name: backgroundGoalStateTool.name,
                args: { scope: request.scope },
              }
              : prior.length
              ? report
              : sourceRead;
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
        const hooks = createHookRunner(createPolicyEngine());
        const orchestration: OrchestratorConfig = {
          providerRegistry: registry,
          enableStreaming: false,
          hookRunner: {
            ...hooks,
            evaluateHook(hook, context) {
              if (
                context.input.tool_name === sourceRead.name ||
                context.input.tool_name === scheduledGoalReportTool.name ||
                context.input.tool_name === backgroundGoalStateTool.name
              ) {
                hookEvents.push(`${hook}:${context.input.tool_name}`);
              }
              if (
                denySourceCall && hook === "PRE_TOOL_CALL" &&
                context.input.tool_name === sourceRead.name
              ) {
                return Promise.resolve({
                  allowed: false,
                  action: "BLOCK",
                  ruleId: null,
                  duration: 0,
                });
              }
              return hooks.evaluateHook(hook, context);
            },
          },
          tools: [
            {
              name: sourceRead.name,
              description: "Approved status",
              parameters: {},
            },
            scheduledGoalReportTool,
            backgroundGoalStateTool,
          ],
          getSessionTaint: () => taint,
          escalateTaint: (level) => {
            taint = level;
          },
          async toolExecutor(name, args) {
            if (name === "memory_get") return '{"found":false}';
            if (name === "memory_save") return "Stored.";
            if (name === sourceRead.name) {
              sourceCalls++;
              return JSON.stringify({ ...output, _classification: "INTERNAL" });
            }
            if (name === backgroundGoalStateTool.name) {
              statusCalls++;
              return await readRecoveredGoalState(
                args,
                createSavedSourceAuthorization(orchestration, session),
              );
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
                  if (interruptAfterStatus && batch.completedIterations === 3) {
                    interruptAfterStatus = false;
                    throw new Error(
                      "Gateway disconnected after checkpointing goal status.",
                    );
                  }
                },
              });
            },
          },
        });
      },
    };
    scheduler = createSchedulerService({
      ...buildSchedulerRecoveryBindings(config, directory, keychain, probe),
      goalCompletion: completion,
      orchestratorFactory: factory,
      executionTracePath: join(directory, "execution-traces.db"),
      triggerMdPath,
      cronManager,
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
    let executionId: string;
    if (kind === "webhook") {
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
      const admitted = await initial.json();
      assert(!admitted.delivered);
      executionId = admitted.executionId;
    } else {
      if (kind === "cron") scheduler?.start();
      else {
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
      const timeout = setTimeout(
        () => paused.reject(new Error("Scheduled fixture did not pause")),
        3000,
      );
      const selected = await paused.promise.finally(() =>
        clearTimeout(timeout)
      );
      executionId = selected.id;
      scheduler?.stop();
      const admission = schedulerAdmissionArchive(directory, {
        role: "scheduled",
        runId: executionId,
        sessionId: selected.sessionId,
        sourceId,
        classification: "INTERNAL",
      });
      assert(admission);
      const deadline = Date.now() + 2000;
      while (admission.liveLease() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assertEquals(admission.liveLease(), undefined);
    }
    assertStringIncludes(executionId, `scheduler-${kind}-`);
    assertEquals(sourceCalls, 1);
    interruptAfterSource = false;
    await gateway?.stop();
    port = await start();
    const resume = async () => {
      const reply = await fetch(
        `http://127.0.0.1:${port}/recovery/${
          kind === "webhook" ? "webhooks" : "scheduled"
        }/${executionId}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          ...(kind === "webhook" && { body }),
        },
      );
      await reply.text();
      return reply.status;
    };
    if (kind === "webhook") {
      sourceAllowed = false;
      assertEquals(await resume(), 409);
      assertEquals(reportCalls, 0);
      sourceAllowed = true;
      expireLease = true;
      assertEquals(await resume(), 409);
      assertEquals(expireLease, false);
    } else {
      hookEvents.length = 0;
      denySourceCall = true;
      assertEquals(await resume(), 409);
      assert(hookEvents.includes("PRE_TOOL_CALL:github_actions"));
      denySourceCall = false;
      hookEvents.length = 0;
    }
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
        `scheduler-trace:${kind}:${sourceId}`,
      );
      assertStringIncludes(
        receipt.receipt.proof.reference,
        `${executionId}:1:`,
      );
      if (kind === "webhook") {
        sourceAllowed = false;
        assertEquals(await resume(), 409);
        assertEquals(observed, undefined);
        sourceAllowed = true;
        assertEquals(await resume(), 409);
      } else {
        assert(hookEvents.includes("PRE_TOOL_CALL:github_actions"));
        assert(hookEvents.includes("POST_TOOL_RESPONSE:github_actions"));
        assert(hookEvents.includes("PRE_TOOL_CALL:scheduled_goal_report"));
        assert(hookEvents.includes("POST_TOOL_RESPONSE:scheduled_goal_report"));
      }
      assertEquals(interruptAfterStatus, false);
      assertEquals(observed, undefined);
      assertEquals(statusCalls, 1);
      scheduler?.stop();
      await gateway?.stop();
      port = await start();
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
      assertEquals(statusCalls, 1);
      assert(hookEvents.includes("PRE_TOOL_CALL:background_goal_state"));
      assert(hookEvents.includes("POST_TOOL_RESPONSE:background_goal_state"));
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
    scheduler?.stop();
    await gateway?.stop();
    await storage.close();
    await Deno.remove(directory, { recursive: true });
  }
}

for (const kind of ["webhook", "cron", "trigger"] as const) {
  Deno.test(`Recovered scheduled ${kind} proves one exact goal result without replaying either call`, () =>
    verifyRecoveredScheduledGoal(kind));
}
