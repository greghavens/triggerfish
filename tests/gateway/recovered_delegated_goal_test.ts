import { backgroundGoalStateTool } from "../../src/gateway/startup/factory/background_goal_state.ts";
import { readRecoveredGoalState } from "../../src/gateway/startup/factory/recovered_goal_state.ts";
import { TEAM_STORAGE_PREFIX } from "../../src/agent/team/types.ts";
import { buildTeamManager } from "../../src/gateway/startup/factory/team_executor.ts";
import type { EnhancedSessionManager } from "../../src/gateway/sessions.ts";
import type { SessionId } from "../../src/core/types/session.ts";
import { teamDeliveryExecutionId } from "../../src/gateway/startup/factory/delegated_agent_recovery.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
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
import {
  buildExecutionTracePayloadAuthorizer,
  buildWorkflowRecoveryExecutor,
} from "../../src/gateway/startup/factory/agent_recovery.ts";
import { delegatedSubagentIdentity } from "../../src/gateway/startup/factory/delegated_agent_recovery.ts";
import {
  buildDelegatedGoalCompletion,
  delegatedGoalReportTool,
} from "../../src/gateway/startup/factory/delegated_goal_completion.ts";
import { buildOwnerSubagentRecoveryCommand } from "../../src/gateway/startup/factory/owner_subagent_recovery.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";

async function checkRecoveredGoal(kind: "subagent" | "team") {
  const directory = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const messages = createMessageStore(storage);
  const keychain = createMemorySecretStore();
  assert((await keychain.setSecret("github-pat", "recovered-goal-fixture")).ok);
  const userId = "owner" as UserId;
  const owner = createSession({ userId, channelId: "owner" as ChannelId });
  const repo = "fixture/security";
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
    goal: "Verify the approved pipeline attempt.",
    policy: "operator",
    criteria: [{
      id: "status",
      description: "Verify the retained pipeline result.",
      kind,
      tool: "github_actions",
      result_sha256: resultSha256,
    }],
  } as const;
  const config: Pick<
    TriggerFishConfig,
    "agent_recovery" | "delegated_goal_completion"
  > = {
    agent_recovery: {
      github_repositories: [repo],
      github_run_status: true,
      team: kind === "team",
      background_checklists: kind === "team",
    },
    delegated_goal_completion: [goal],
  };
  const request = {
    scope: goal.scope,
    criterion: "status",
    sourceCallId: "1:0",
    requestId: crypto.randomUUID(),
  };
  const execution = crypto.randomUUID();
  const identity = await delegatedSubagentIdentity(owner.id, execution);
  const subagentCommand =
    `/recover-subagent ${execution} Review the pipeline result and report the exact evidence.`;
  let team: { id: string; member: SessionId } | undefined;
  const sourceRead = {
    name: "github_actions",
    args: {
      action: "get_run",
      repo,
      run_id: output.id,
      attempt: output.attempt,
    },
  };
  const report = { name: delegatedGoalReportTool.name, args: request };
  let sourceCalls = 0;
  let reportCalls = 0;
  let sourceAllowed = true;
  let interruptAfterSource = true;
  let interruptAfterReport = true;
  let interruptAfterStatus = true;
  let statusCalls = 0;
  let seenStatus: string | undefined;
  const probe: typeof fetch = (url) => {
    const path = new URL(String(url)).pathname;
    if (path === `/repos/${repo}`) {
      return Promise.resolve(
        Response.json({
          id: output.repositoryId,
          full_name: repo,
          visibility: "public",
        }),
      );
    }
    assertEquals(path, `/repos/${repo}/actions/workflows`);
    return Promise.resolve(
      new Response(null, { status: sourceAllowed ? 200 : 403 }),
    );
  };

  const turn = async (
    content?: string,
    operatorRequest?: Record<string, unknown>,
    actor = owner,
  ) => {
    const completion = buildDelegatedGoalCompletion(
      directory,
      [goal],
      messages,
    );
    assert(completion);
    const recovery = buildWorkflowRecoveryExecutor(
      config,
      directory,
      keychain,
      undefined,
      undefined,
      false,
      {
        githubFetch: probe,
        checklistRole: "delegated",
      },
    );
    assert(recovery);
    const factory: OrchestratorFactory = {
      create(channel, options) {
        const sessionInput = { channelId: channel as ChannelId, userId };
        const session = options?.recoverySessionId
          ? restoreSession({ ...sessionInput, id: options.recoverySessionId })
          : createSession(sessionInput);
        let taint: ClassificationLevel = options?.recoverySessionTaint ??
          "PUBLIC";
        const registry = createProviderRegistry();
        registry.register({
          name: "fixture",
          supportsStreaming: false,
          complete(history) {
            if (!options?.executionChecklistRunId) {
              return Promise.resolve({
                content: "Team ready.",
                toolCalls: [],
                usage: { inputTokens: 1, outputTokens: 1 },
              });
            }
            const prior = history.filter(({ role }) => role === "tool");
            if (prior.length === 1 && interruptAfterSource) {
              throw new Error("Interrupted after the source checkpoint.");
            }
            if (prior.length === 3) {
              const projection = JSON.parse(String(prior[1].content));
              assertEquals(projection.verified, true);
              assertEquals(projection._classification, "INTERNAL");
              const status = String(prior[2].content);
              const state = JSON.parse(status);
              assertEquals(state.satisfied, [request.criterion]);
              assertEquals(state.open, []);
              assertEquals(
                state.criteria[0].evidence.reference,
                projection.evidenceReference,
              );
              assertEquals(state._classification, "INTERNAL");
              if (interruptAfterStatus) {
                interruptAfterStatus = false;
                seenStatus = status;
                throw new Error("Interrupted after status checkpoint.");
              }
              assertEquals(status, seenStatus);
              return Promise.resolve({
                content: "Published exact goal evidence.",
                toolCalls: [],
                usage: { inputTokens: 1, outputTokens: 1 },
              });
            }
            const next = prior.length === 2
              ? {
                name: backgroundGoalStateTool.name,
                args: { scope: goal.scope },
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
        const orchestratorConfig: OrchestratorConfig = {
          providerRegistry: registry,
          enableStreaming: false,
          hookRunner: createHookRunner(createPolicyEngine()),
          tools: [
            {
              name: sourceRead.name,
              description: "Read the exact approved source",
              parameters: {},
            },
            delegatedGoalReportTool,
            backgroundGoalStateTool,
          ],
          getSessionTaint: () => taint,
          escalateTaint: (level) => {
            taint = level;
          },
          async toolExecutor(name, args) {
            if (name === sourceRead.name) {
              sourceCalls++;
              return JSON.stringify({ ...output, _classification: "INTERNAL" });
            }
            if (name === backgroundGoalStateTool.name) {
              statusCalls++;
              return await readRecoveredGoalState(
                args,
                createSavedSourceAuthorization(orchestratorConfig, session),
              );
            }
            reportCalls++;
            return await completion.reportRecovered(
              args,
              options?.executionChecklistRunId!,
              session.id,
              options?.teamGoalRecovery
                ? { kind: "team", ...options.teamGoalRecovery }
                : { kind: "subagent", parentSessionId: owner.id },
              createSavedSourceAuthorization(orchestratorConfig, session),
            );
          },
        };
        const agent = createOrchestrator(orchestratorConfig);
        return Promise.resolve({
          orchestrator: {
            ...agent,
            executeAgentTurn(input) {
              return agent.executeAgentTurn({
                ...input,
                async onToolBatchCheckpoint(batch) {
                  if (interruptAfterReport && batch.completedIterations === 2) {
                    interruptAfterReport = false;
                    throw new Error("Interrupted after the report committed.");
                  }
                  await input.onToolBatchCheckpoint?.(batch);
                },
              });
            },
          },
          session,
          toolExecutor: orchestratorConfig.toolExecutor!,
          getSessionTaint: () => taint,
        });
      },
    };
    const manager = kind === "team"
      ? buildTeamManager({
        storage,
        orchestratorFactory: factory,
        callerSessionId: owner.id,
        sessionManager: {
          get: (id: SessionId) =>
            Promise.resolve(id === owner.id ? owner : null),
        } as unknown as EnhancedSessionManager,
        recovery: {
          path: join(directory, "team-recovery.db"),
          profileBinding: "a".repeat(64),
          exactChecklists: true,
          run: recovery,
          bindObservationRun: (source, authorizeObservationScope) =>
            buildWorkflowRecoveryExecutor(
              config,
              directory,
              keychain,
              undefined,
              source,
              false,
              {
                githubFetch: probe,
                checklistRole: "team",
                authorizeObservationScope,
              },
            ),
        },
      })
      : undefined;
    if (manager && !team) {
      const created = await manager.createTeam({
        name: "Pipeline review",
        task: "Review the pipeline.",
        members: [{
          role: "reviewer",
          description: "Review the evidence.",
          isLead: true,
          classificationCeiling: "INTERNAL",
        }],
      }, owner.id);
      assert(created.ok);
      manager.stopLifecycleMonitor(created.value.id);
      team = {
        id: created.value.id,
        member: created.value.members[0].sessionId,
      };
    }
    const command = content ??
      (team
        ? `/recover-team ${execution} ${team.id} ${team.member} Review the pipeline result and report the exact evidence.`
        : subagentCommand);
    const ownerProviders = createProviderRegistry();
    if (operatorRequest) {
      ownerProviders.register({
        name: "team-history-reader",
        supportsStreaming: false,
        complete(context, tools) {
          assert(
            tools?.some((tool) =>
              (tool as { function?: { name: string } }).function?.name ===
                "operator_runs"
            ),
          );
          const result = context.at(-1);
          if (result?.role === "tool") {
            return Promise.resolve({
              content: String(result.content),
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1 },
            });
          }
          return Promise.resolve({
            content: "",
            toolCalls: [{
              type: "function",
              id: crypto.randomUUID(),
              function: {
                name: "operator_runs",
                arguments: JSON.stringify(operatorRequest),
              },
            }],
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        },
      });
      ownerProviders.setDefault("team-history-reader");
    }
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: actor,
        targetClassification: "INTERNAL",
        getSessionTaint: () => "INTERNAL",
        providerRegistry: ownerProviders,
        hookRunner: createHookRunner(createPolicyEngine()),
        goalCompletionPath: join(directory, "goal-completion.db"),
        messageStore: messages,
        tools: [{
          name: sourceRead.name,
          description: "Approved status",
          parameters: {},
        }],
        runManagedGoalCommand: completion.runCommand,
        runTeamRecoveryCommand: manager?.runRecoveryCommand,
        runSubagentRecoveryCommand: buildOwnerSubagentRecoveryCommand(
          buildSubagentFactory(factory, {
            executionTracePath: join(directory, "execution-traces.db"),
          }),
          recovery,
        ),
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
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const result = Promise.withResolvers<string>();
    const timer = setTimeout(
      () => result.reject(new Error("Recovered goal gateway timed out")),
      3000,
    );
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "message", content: command }));
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.type === "response" || event.type === "error") {
        result.resolve(event.text ?? event.message);
      }
    };
    try {
      return await result.promise;
    } finally {
      clearTimeout(timer);
      socket.close();
      await gateway.stop();
    }
  };

  try {
    assertStringIncludes(await turn(), "failed");
    assertEquals(sourceCalls, 1);
    interruptAfterSource = false;
    const checkRevokedMembership = async () => {
      if (!team) return;
      const key = `${TEAM_STORAGE_PREFIX}${team.id}`;
      const active = await storage.get(key);
      assert(active);
      await storage.set(
        key,
        JSON.stringify({ ...JSON.parse(active), status: "disbanded" }),
      );
      try {
        assertStringIncludes(
          await turn(),
          "not available in the trusted recovery scope",
        );
      } finally {
        await storage.set(key, active);
      }
    };
    await checkRevokedMembership();
    sourceAllowed = false;
    assertStringIncludes(await turn(), "no longer authorized");
    assertEquals(reportCalls, 0);
    sourceAllowed = true;
    assertStringIncludes(await turn(), "checkpoint");
    assertEquals(reportCalls, 1);
    const store = new GoalCompletionStore(
      join(directory, "goal-completion.db"),
    );
    try {
      const scope = "delegated:pipeline";
      const receipt = store.readEvidenceSubmission(scope, request.requestId);
      assert(receipt);
      assertEquals(receipt.receipt.status, "awaiting_confirmation");
      const runId = team
        ? await teamDeliveryExecutionId(owner.id, team.member, execution)
        : identity.executionId;
      assertStringIncludes(receipt.receipt.proof.reference, `${runId}:1:`);
      assertEquals(
        receipt.receipt.proof.source,
        team ? `delegated-trace:team:${team.id}` : "delegated-trace:subagent",
      );
      await checkRevokedMembership();
      assertEquals(reportCalls, 1);
      sourceAllowed = false;
      assertStringIncludes(await turn(), "no longer authorized");
      assertEquals(reportCalls, 1);
      sourceAllowed = true;
      assertStringIncludes(await turn(), "failed");
      assertEquals(statusCalls, 1);
      assert(seenStatus);
      await checkRevokedMembership();
      sourceAllowed = false;
      assertStringIncludes(await turn(), "no longer authorized");
      sourceAllowed = true;
      assertEquals(
        await turn(),
        kind === "team"
          ? "Team delivery completed."
          : "Published exact goal evidence.",
      );
      assertEquals(sourceCalls, 1);
      assertEquals(statusCalls, 1);
      assertEquals(reportCalls, 1);
      assertEquals(
        store.readEvidenceSubmission(scope, request.requestId),
        receipt,
      );
      const pending = JSON.parse(await turn("/goal delegated status pipeline"));
      assertEquals(pending.observations[0].evidence[0], receipt.receipt.proof);
      const confirm =
        `/goal delegated confirm pipeline ${pending.confirmation.decisionSha256}`;
      sourceAllowed = false;
      assertStringIncludes(await turn(confirm), "could not be reverified");
      sourceAllowed = true;
      const completed = JSON.parse(await turn(confirm));
      assertEquals(completed.status, "completed");
      assertEquals(completed.observations, pending.observations);
      if (team) {
        const target = {
          traceRole: "team_delivery",
          id: [team.id, team.member, execution].join(":"),
        };
        const lookup = (args: Record<string, unknown>) =>
          turn("Read the retained execution history.", { ...target, ...args });
        const history = JSON.parse(
          await lookup({ action: "execution_traces", limit: 1 }),
        );
        assertEquals(history.run.scope, {
          role: "team_delivery",
          runId: target.id,
        });
        assertEquals(history.page.steps[0].scope, history.run.scope);
        assert(history.page.nextCursor);
        const next = JSON.parse(
          await lookup({
            action: "execution_traces",
            limit: 1,
            cursor: history.page.nextCursor,
          }),
        );
        assertEquals(next.page.steps[0].ordinal, 2);
        assertEquals(next.page.steps[0].scope, history.run.scope);
        assertStringIncludes(
          await turn(
            "Read another owner's history.",
            { ...target, action: "execution_traces" },
            createSession({ userId: owner.userId, channelId: owner.channelId }),
          ),
          "unavailable",
        );
        const step = JSON.parse(
          await lookup({ action: "execution_traces", ordinal: 1 }),
        );
        assertEquals(step.step.tool, sourceRead.name);
        assertEquals(step.step, history.page.steps[0]);
        const search = JSON.parse(
          await lookup({ action: "execution_traces", query: "github_actions" }),
        );
        assertEquals(search.page.matches[0].runId, target.id);
        assertEquals(search.page.matches[0].role, "team_delivery");

        const action = { action: "execution_trace_payload", ordinal: 1 };
        sourceAllowed = false;
        assertStringIncludes(await lookup(action), "unavailable");
        sourceAllowed = true;
        const exact = JSON.parse(await lookup(action));
        assertEquals(exact.run.scope, history.run.scope);
        assertEquals(exact.step, step.step);
        assertEquals(exact.payload, {
          kind: "github_actions_run_status",
          repo,
          repositoryId: output.repositoryId,
          id: output.id,
          attempt: output.attempt,
          status: output.status,
          conclusion: output.conclusion,
        });
        assertStringIncludes(
          await lookup({
            ...action,
            id: [crypto.randomUUID(), team.member, execution].join(":"),
          }),
          "unavailable",
        );
        assertEquals(sourceCalls, 1);
      }
    } finally {
      store.close();
    }
  } finally {
    await storage.close();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("Recovered subagent submits one exact goal proof and reconciles a lost checkpoint through gateway", () =>
  checkRecoveredGoal("subagent"));
Deno.test("Recovered team submits one membership-scoped goal proof and reconciles a lost checkpoint through gateway", () =>
  checkRecoveredGoal("team"));
