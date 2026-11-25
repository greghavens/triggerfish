import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { runRecoverableAgentTurn } from "../../src/core/agent_recovery.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import {
  type ExecutionTraceApprovedPayload,
  executionTracePayloadResponse,
  type ExecutionTraceReceipt,
  openExecutionTraces,
} from "../../src/core/execution_traces.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { createMemorySecretStore } from "../../src/core/secrets/keychain/keychain.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { StorageProvider } from "../../src/core/storage/provider.ts";
import type { EnhancedSessionManager } from "../../src/gateway/sessions.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import {
  type ChannelId,
  createSession,
  restoreSession,
  type SessionId,
  type SessionState,
  updateTaint,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildExecutionTracePayloadAuthorizer } from "../../src/gateway/startup/factory/agent_recovery.ts";
import {
  delegatedSubagentIdentity,
  teamDeliveryExecutionId,
  teamDeliveryTraceSource,
} from "../../src/gateway/startup/factory/delegated_agent_recovery.ts";
import { buildTeamManager } from "../../src/gateway/startup/factory/team_executor.ts";
import { buildDelegatedGoalCompletion } from "../../src/gateway/startup/factory/delegated_goal_completion.ts";
import { buildSchedulerGoalCompletion } from "../../src/gateway/startup/factory/scheduler_goal_completion.ts";
import { schedulerExecutionIdentity } from "../../src/scheduler/service_execution.ts";
import { createWorkflowRecoveryPolicy } from "../../src/gateway/workflow_recovery_policy.ts";

async function prepareTeamTrace(
  directory: string,
  storage: StorageProvider,
  owner: SessionState,
  payload: ExecutionTraceApprovedPayload,
) {
  assert(payload.kind === "github_actions_run_status");
  const request = "Review the exact release.";
  const recoveryPath = join(directory, "agent-recovery.db");
  let mayFinish = false;
  let authorized = true;
  let allowResponse = true;
  let dispatches = 0;
  const tools = [{
    name: "github_actions",
    description: "Read the approved attempt",
    parameters: {},
  }];
  const policy = createWorkflowRecoveryPolicy({
    repositories: [payload.repo],
    runStatus: true,
    classification: () => "INTERNAL",
    authorizeRepository: () => Promise.resolve(authorized),
  });
  const factory: OrchestratorFactory = {
    create(channelId, options) {
      assert(options?.recoverySessionId);
      const session = updateTaint(
        restoreSession({
          id: options.recoverySessionId,
          userId: owner.userId,
          channelId: channelId as ChannelId,
        }),
        "INTERNAL",
        "Test member scope",
      );
      const registry = createProviderRegistry();
      registry.register({
        name: "team-recovery-fixture",
        supportsStreaming: false,
        complete(messages) {
          const usage = { inputTokens: 1, outputTokens: 1 };
          const inDelivery = messages.some(({ role, content }) =>
            role === "user" && content === request
          );
          if (!inDelivery) {
            return Promise.resolve({
              content: "Team ready.",
              toolCalls: [],
              usage,
            });
          }
          if (messages.some(({ role }) => role === "tool")) {
            return mayFinish
              ? Promise.resolve({
                content: "Recorded the exact release result.",
                toolCalls: [],
                usage,
              })
              : Promise.reject(
                new Error("Interrupted after the result checkpoint"),
              );
          }
          return Promise.resolve({
            content: "",
            toolCalls: [{
              id: "exact-release-attempt",
              type: "function",
              function: {
                name: "github_actions",
                arguments: JSON.stringify({
                  action: "get_run",
                  repo: payload.repo,
                  run_id: payload.id,
                  attempt: payload.attempt,
                }),
              },
            }],
            usage,
          });
        },
      });
      registry.setDefault("team-recovery-fixture");
      const hooks = createHookRunner(createPolicyEngine());
      const toolExecutor = (): Promise<string> => {
        dispatches++;
        return Promise.resolve(executionTracePayloadResponse(payload));
      };
      const orchestrator = createOrchestrator({
        providerRegistry: registry,
        tools,
        enableStreaming: false,
        hookRunner: {
          ...hooks,
          evaluateHook(hook, context) {
            if (
              !allowResponse && hook === "POST_TOOL_RESPONSE" &&
              context.input.tool_name === "github_actions"
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
        toolExecutor,
        getSessionTaint: () => session.taint,
      });
      return Promise.resolve({
        orchestrator,
        session,
        toolExecutor,
        getSessionTaint: () => session.taint,
      });
    },
  };
  const manager = buildTeamManager({
    storage,
    orchestratorFactory: factory,
    callerSessionId: owner.id,
    sessionManager: {
      get: (id: SessionId) =>
        Promise.resolve(id === owner.id ? owner : undefined),
    } as unknown as EnhancedSessionManager,
    recovery: {
      path: join(directory, "team-recovery.db"),
      profileBinding: "a".repeat(64),
      run: (id, orchestrator, options) =>
        runRecoverableAgentTurn(
          recoveryPath,
          id,
          policy,
          orchestrator,
          options,
        ),
    },
  });
  const created = await manager.createTeam({
    name: "Release review",
    task: "Review an approved release attempt.",
    members: [{
      role: "reviewer",
      description: "Review release verification",
      isLead: true,
      classificationCeiling: "INTERNAL",
    }],
  }, owner.id);
  assert(created.ok);
  manager.stopLifecycleMonitor(created.value.id);
  const teamId = created.value.id;
  const member = created.value.members[0].sessionId;
  const delivery = crypto.randomUUID();
  const runId = await teamDeliveryExecutionId(owner.id, member, delivery);
  return {
    runId,
    teamId,
    member,
    delivery,
    command: `/recover-team ${delivery} ${teamId} ${member} ${request}`,
    runner: manager.runRecoveryCommand,
    recoveryPath,
    dispatchCount: () => dispatches,
    allowSource: (allowed: boolean) => {
      authorized = allowed;
    },
    allowResponse: (allowed: boolean) => {
      allowResponse = allowed;
    },
    finish: () => {
      mayFinish = true;
    },
    source: teamDeliveryTraceSource(owner.id, teamId, delivery),
  };
}

async function testGoalTraceArchive(mode: "scheduled" | "subagent" | "team") {
  const role = mode === "scheduled" ? "scheduled" : "delegated";
  const directory = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const messages = createMessageStore(storage);
  try {
    const repo = "fixture-owner/fixture-project";
    const payload = {
      kind: "github_actions_run_status",
      repo,
      repositoryId: 9021,
      id: 2024,
      attempt: 3,
      status: "completed",
      conclusion: "success",
    } as const;
    const resultSha256 = await computeContentHash(
      executionTracePayloadResponse(payload),
    );
    const criterion = {
      id: "approved-attempt",
      description: "Match the exact approved release attempt",
      tool: "github_actions",
      result_sha256: resultSha256,
    } as const;
    const release = {
      scope: "release",
      goal: "Verify the retained release attempt",
      policy: "operator",
    } as const;
    const wrongResult = {
      scope: "wrong-result",
      goal: "Require a different result",
      policy: "operator",
    } as const;
    const managed = role === "scheduled"
      ? buildSchedulerGoalCompletion(
        {
          scheduler: {
            goal_completion: [
              {
                ...release,
                criteria: [{
                  ...criterion,
                  kind: "trigger",
                  source_id: "trigger",
                }],
              },
              {
                ...wrongResult,
                criteria: [{
                  ...criterion,
                  kind: "trigger",
                  source_id: "trigger",
                  result_sha256: "1".repeat(64),
                }],
              },
            ],
          },
        },
        directory,
        messages,
      )
      : buildDelegatedGoalCompletion(directory, [
        {
          ...release,
          criteria: [{
            ...criterion,
            kind: mode === "team" ? "team" : "subagent",
          }],
        },
        {
          ...wrongResult,
          criteria: [{
            ...criterion,
            kind: mode === "team" ? "team" : "subagent",
            result_sha256: "1".repeat(64),
          }],
        },
        {
          ...release,
          scope: "team",
          criteria: [{ ...criterion, kind: "team" }],
        },
      ], messages);
    assert(managed);
    const owner = createSession({
      userId: "owner" as UserId,
      channelId: "owner" as ChannelId,
    });
    const team = mode === "team"
      ? await prepareTeamTrace(directory, storage, owner, payload)
      : undefined;
    const tracePath = join(directory, "execution-traces.db");
    const saved = async (sourceId: string, wrongChild = false) => {
      const uuid = crypto.randomUUID();
      const identity = mode === "subagent"
        ? await delegatedSubagentIdentity(sourceId as SessionId, uuid)
        : undefined;
      const teamRunId = team
        ? await teamDeliveryExecutionId(
          sourceId as SessionId,
          uuid as SessionId,
          uuid,
        )
        : undefined;
      const repoTrace = openExecutionTraces(tracePath);
      try {
        const scope = {
          role,
          runId: identity?.executionId ?? teamRunId ??
            schedulerExecutionIdentity("trigger", sourceId, "fixture").id,
          sourceId: team
            ? teamDeliveryTraceSource(sourceId as SessionId, team.teamId, uuid)
            : sourceId,
          sessionId: wrongChild
            ? crypto.randomUUID()
            : identity?.sessionId ?? uuid,
          classification: "INTERNAL",
        } as const;
        assert(repoTrace.admit(scope));
        const receipt = repoTrace.append(scope, {
          ordinal: 1,
          tool: "github_actions",
          outcome: "returned",
          classification: "INTERNAL",
        }, payload);
        assert(receipt);
        assert(repoTrace.finish(scope, "completed", "INTERNAL"));
        return receipt;
      } finally {
        repoTrace.close();
      }
    };
    let correctStep: ExecutionTraceReceipt | undefined = team
      ? undefined
      : await saved(role === "scheduled" ? "trigger" : owner.id);
    const correct = () => {
      assert(correctStep);
      return correctStep;
    };
    const wrong = await saved(
      role === "scheduled" ? "other-source" : crypto.randomUUID(),
    );
    const wrongChild = mode !== "scheduled"
      ? await saved(owner.id, true)
      : undefined;
    const keychain = createMemorySecretStore();
    assert((await keychain.setSecret("github-pat", "synthetic-goal-token")).ok);
    let permission = true;
    const probed: string[] = [];
    const checkFetch: typeof fetch = (url, options) => {
      const target = new URL(url.toString());
      assertEquals(target.origin, "https://api.github.com");
      assertEquals(options?.method ?? "GET", "GET");
      assertEquals(
        new Headers(options?.headers).get("authorization"),
        "Bearer synthetic-goal-token",
      );
      probed.push(target.pathname);
      if (target.pathname === `/repos/${repo}`) {
        return Promise.resolve(Response.json({
          id: payload.repositoryId,
          full_name: repo,
          visibility: "public",
        }));
      }
      assertEquals(target.pathname, `/repos/${repo}/actions/workflows`);
      return Promise.resolve(
        new Response("", { status: permission ? 200 : 403 }),
      );
    };
    const authorize = buildExecutionTracePayloadAuthorizer(
      {
        agent_recovery: {
          github_repositories: [repo],
          github_run_status: true,
        },
      },
      keychain,
      checkFetch,
    );
    assert(authorize);
    const registry = createProviderRegistry();
    let operation: Record<string, unknown> | undefined;
    let operationName = "operator_runs";
    registry.register({
      name: "goal-trace-fixture",
      supportsStreaming: false,
      complete() {
        const read = operation;
        operation = undefined;
        return Promise.resolve({
          content: read ? "" : "Run control finished.",
          toolCalls: read
            ? [{
              id: crypto.randomUUID(),
              type: "function",
              function: {
                name: operationName,
                arguments: JSON.stringify(read),
              },
            }]
            : [],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    });
    registry.setDefault("goal-trace-fixture");
    let taint: ClassificationLevel = "INTERNAL";
    let deny: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
    const sourceHooks: string[] = [];
    const managedHooks: string[] = [];
    let denyManaged: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
    let denyGoalOutput = false;
    let deniedGoalOutput = false;
    const withGateway = async <T>(
      run: (turn: (content: string) => Promise<string>) => Promise<T>,
    ): Promise<T> => {
      const hooks = createHookRunner(createPolicyEngine());
      const chat = createChatSession({
        session: owner,
        providerRegistry: registry,
        getSessionTaint: () => taint,
        targetClassification: "INTERNAL",
        goalCompletionPath: join(directory, "goal-completion.db"),
        messageStore: messages,
        tools: [{
          name: "github_actions",
          description: "Fixture GitHub Actions tool schema",
          parameters: {},
        }],
        hookRunner: {
          ...hooks,
          evaluateHook(hook, context) {
            if (
              denyGoalOutput && hook === "PRE_OUTPUT" &&
              typeof context.input.content === "string" &&
              context.input.content.includes(correct().id)
            ) {
              deniedGoalOutput = true;
              return Promise.resolve({
                allowed: false,
                action: "BLOCK",
                ruleId: null,
                duration: 0,
              });
            }
            if (
              context.input.tool_name === "managed_goal_state" &&
              (hook === "PRE_TOOL_CALL" || hook === "POST_TOOL_RESPONSE")
            ) {
              managedHooks.push(hook);
              assertEquals(
                context.input.operation_type,
                hook === "PRE_TOOL_CALL" ? "write" : "read",
              );
              assertEquals(context.input.resource_classification, "INTERNAL");
              assert(!Object.hasOwn(context.auditInput ?? {}, "tool_call"));
              if (denyManaged === hook) {
                return Promise.resolve({
                  allowed: false,
                  action: "BLOCK",
                  ruleId: null,
                  duration: 0,
                });
              }
            }
            if (
              (hook === "PRE_TOOL_CALL" || hook === "POST_TOOL_RESPONSE") &&
              context.input.tool_name === "github_actions"
            ) {
              sourceHooks.push(hook);
              assert(!Object.hasOwn(context.auditInput ?? {}, "tool_response"));
              if (deny === hook) {
                return Promise.resolve({
                  allowed: false,
                  action: "BLOCK",
                  ruleId: null,
                  duration: 0,
                });
              }
            }
            return hooks.evaluateHook(hook, context);
          },
        },
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir: directory,
          authorizeExecutionTracePayload: authorize,
          confirm: () => Promise.resolve(true),
        }),
        runManagedGoalCommand: managed.runCommand,
        runTeamRecoveryCommand: team?.runner,
      });
      const token = crypto.randomUUID();
      const server = createGatewayServer({ port: 0, token, chatSession: chat });
      const { port } = await server.start();
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/chat?token=${token}`,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        return await run((content) => {
          const done = Promise.withResolvers<string>();
          let response = "";
          let toolResult: string | undefined;
          let error: string | undefined;
          const timer = setTimeout(
            () => done.reject(new Error("No turn_end")),
            3_000,
          );
          function receive({ data }: MessageEvent) {
            const event = JSON.parse(data);
            if (event.type === "response") response = event.text;
            if (event.type === "tool_result") toolResult = event.result;
            if (event.type === "error") error = event.message;
            if (event.type === "turn_end") {
              if (error) done.reject(new Error(error));
              else done.resolve(toolResult ?? response);
            }
          }
          socket.addEventListener("message", receive);
          socket.send(JSON.stringify({ type: "message", content }));
          return done.promise.finally(() => {
            clearTimeout(timer);
            socket.removeEventListener("message", receive);
          });
        });
      } finally {
        socket.close();
        await server.stop();
      }
    };
    const commandRole = role === "scheduled" ? "scheduler" : "delegated";
    const citation = (
      runId = correct().scope.runId,
      scope = "release",
      teamId: string | undefined = team?.teamId,
    ) =>
      `/goal ${commandRole} cite ${
        JSON.stringify({
          scope,
          criterion: criterion.id,
          runId,
          ordinal: correct().ordinal,
          ...(teamId && { teamId }),
        })
      }`;
    const unavailable = `${role} goal evidence is unavailable`;
    const archiveId = crypto.randomUUID();
    await withGateway(async (turn) => {
      if (team) {
        assert((await turn(team.command)) !== "Team delivery completed.");
        assertEquals(team.dispatchCount(), 1);
        const recovery = new AgentRecoveryStore(team.recoveryPath);
        let originalAt: number;
        try {
          const saved = recovery.read(
            assignmentRecoveryKey(team.member, team.runId),
          );
          assert(saved?.status === "ready");
          assert(saved.checkpoint);
          assert(saved.tools[0].recordedAt !== undefined);
          originalAt = saved.tools[0].recordedAt;
        } finally {
          recovery.close();
        }
        const interrupted = openExecutionTraces(tracePath);
        try {
          assertEquals(
            interrupted.readRun("delegated", team.runId, "INTERNAL"),
            undefined,
          );
        } finally {
          interrupted.close();
        }
        team.finish();
        team.allowSource(false);
        assert((await turn(team.command)) !== "Team delivery completed.");
        team.allowSource(true);
        team.allowResponse(false);
        assert((await turn(team.command)) !== "Team delivery completed.");
        team.allowResponse(true);
        assertEquals(await turn(team.command), "Team delivery completed.");
        assertEquals(team.dispatchCount(), 1);
        const traces = openExecutionTraces(tracePath);
        try {
          const run = traces.readRun("delegated", team.runId, "INTERNAL");
          assert(run);
          assertEquals(run.scope.sourceId, team.source);
          assertEquals(run.scope.sessionId, team.member);
          correctStep = traces.inspect(run.scope, 1, "INTERNAL");
          assert(correctStep);
          assertEquals(Date.parse(correctStep.recordedAt), originalAt);
          assertEquals(traces.inspect(run.scope, 2, "INTERNAL"), undefined);
          assertEquals(run.status, "completed");
        } finally {
          traces.close();
        }
        await assertRejects(
          () => turn(citation(team.runId, "release", crypto.randomUUID())),
          Error,
          unavailable,
        );
      }
      operation = {
        action: "archive",
        kind: team ? "team_delivery" : role,
        id: team
          ? `${team.teamId}:${team.member}:${team.delivery}`
          : correct().scope.runId,
        requestId: archiveId,
      };
      assertEquals(
        JSON.parse(await turn("Archive this completed scheduled run.")).receipt
          .status,
        "succeeded",
      );
      await assertRejects(
        () => turn(citation(wrong.scope.runId)),
        Error,
        unavailable,
      );
      if (wrongChild) {
        await assertRejects(
          () => turn(citation(wrongChild.scope.runId)),
          Error,
          unavailable,
        );
        if (!team) {
          await assertRejects(
            () => turn(citation(correct().scope.runId, "team")),
            Error,
            unavailable,
          );
        }
      }
    });
    await Deno.remove(tracePath);
    await withGateway(async (turn) => {
      await assertRejects(
        () => turn(citation()),
        Error,
        unavailable,
      );
      operation = {
        action: "restore",
        kind: team ? "team_delivery" : role,
        id: team
          ? `${team.teamId}:${team.member}:${team.delivery}`
          : correct().scope.runId,
        archiveId,
        requestId: crypto.randomUUID(),
      };
      assertEquals(
        JSON.parse(await turn("Restore the exact saved scheduled run.")).receipt
          .status,
        "succeeded",
      );
      await assertRejects(
        () => turn(citation(correct().scope.runId, "wrong-result")),
        Error,
        unavailable,
      );
      taint = "PUBLIC";
      await assertRejects(
        () => turn(citation()),
        Error,
        unavailable,
      );
      taint = "INTERNAL";
      deny = "PRE_TOOL_CALL";
      const previousRequests = probed.length;
      await assertRejects(
        () => turn(citation()),
        Error,
        unavailable,
      );
      assertEquals(probed.length, previousRequests);
      deny = undefined;
      const citeFromModel = () => {
        operationName = "managed_goal_state";
        operation = {
          role: commandRole,
          action: "cite",
          scope: "release",
          criterion: criterion.id,
          runId: correct().scope.runId,
          ordinal: correct().ordinal,
          ...(team && { teamId: team.teamId }),
        };
        return turn(
          "Use the exact retained trace to report the release criterion.",
        );
      };
      denyManaged = "PRE_TOOL_CALL";
      await citeFromModel();
      assertEquals(probed.length, previousRequests);
      assertEquals(
        JSON.parse(await turn(`/goal ${commandRole} status release`)).status,
        "open",
      );
      denyManaged = undefined;
      deny = "POST_TOOL_RESPONSE";
      assert((await citeFromModel()).includes("unavailable"));
      assertEquals(
        JSON.parse(await turn(`/goal ${commandRole} status release`)).status,
        "open",
      );
      deny = undefined;
      denyManaged = "POST_TOOL_RESPONSE";
      assert(!(await citeFromModel()).includes(correct().id));
      denyManaged = undefined;
      denyGoalOutput = true;
      assert(!(await citeFromModel()).includes(correct().id));
      assert(deniedGoalOutput);
      denyGoalOutput = false;
      const proof = JSON.parse(await citeFromModel());
      assertEquals(proof._classification, "INTERNAL");
      delete proof._classification;
      assert(
        managedHooks.filter((hook) => hook === "PRE_TOOL_CALL").length >= 4,
      );
      assert(managedHooks.includes("POST_TOOL_RESPONSE"));
      assertEquals(proof.status, "awaiting_confirmation");
      assertEquals(proof.observations[0].evidence[0], {
        source: role === "scheduled"
          ? "scheduler-trace:trigger:trigger"
          : team
          ? `delegated-trace:team:${team.teamId}`
          : "delegated-trace:subagent",
        reference: `${correct().scope.runId}:1:${correct().id}`,
        detail: `${
          role === "scheduled" ? "trigger:trigger" : mode
        }:github_actions:${resultSha256}`,
        classification: "INTERNAL",
      });
      assert(!JSON.stringify(proof).includes(repo));
      assertEquals(JSON.parse(await turn(citation())), proof);
      assertEquals(await messages.loadSession(correct().scope.sessionId), []);
      const confirm =
        `/goal ${commandRole} confirm release ${proof.confirmation.decisionSha256}`;
      permission = false;
      await assertRejects(
        () => turn(confirm),
        Error,
        "evidence could not be reverified",
      );
      permission = true;
      deny = "POST_TOOL_RESPONSE";
      await assertRejects(
        () => turn(confirm),
        Error,
        "evidence could not be reverified",
      );
      deny = undefined;
      const result = JSON.parse(await turn(confirm));
      assertEquals(result.status, "completed");
      assertEquals(result.observations, proof.observations);
      assertEquals(JSON.parse(await turn(confirm)), result);
      assert(sourceHooks.includes("PRE_TOOL_CALL"));
      assert(sourceHooks.includes("POST_TOOL_RESPONSE"));
      assert(probed.length > previousRequests);
    });
  } finally {
    await storage.close();
    await Deno.remove(directory, { recursive: true });
  }
}
Deno.test("Owner gateway cites an exact restored scheduled GitHub attempt", () =>
  testGoalTraceArchive("scheduled"));
Deno.test("Owner gateway cites an exact restored subagent GitHub attempt anchored to its parent", () =>
  testGoalTraceArchive("subagent"));
Deno.test("Owner gateway archives a reauthorized team tool result without replaying the handler", () =>
  testGoalTraceArchive("team"));
