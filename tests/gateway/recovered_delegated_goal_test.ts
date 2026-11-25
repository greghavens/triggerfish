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

Deno.test("Recovered subagent submits one exact goal proof and reconciles a lost checkpoint through gateway", async () => {
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
      kind: "subagent",
      tool: "github_actions",
      result_sha256: resultSha256,
    }],
  } as const;
  const config: Pick<
    TriggerFishConfig,
    "agent_recovery" | "delegated_goal_completion"
  > = {
    agent_recovery: { github_repositories: [repo], github_run_status: true },
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
  const command =
    `/recover-subagent ${execution} Review the pipeline result and report the exact evidence.`;
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

  const turn = async (content = command) => {
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
        assert(options?.recoverySessionId && options.executionChecklistRunId);
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
              throw new Error("Interrupted after the source checkpoint.");
            }
            if (prior.length === 2) {
              const projection = JSON.parse(String(prior[1].content));
              assertEquals(projection.verified, true);
              assertEquals(projection._classification, "INTERNAL");
              return Promise.resolve({
                content: "Published exact goal evidence.",
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
        const orchestratorConfig: OrchestratorConfig = {
          providerRegistry: registry,
          enableStreaming: false,
          hookRunner: createHookRunner(createPolicyEngine()),
          tools: [{
            name: sourceRead.name,
            description: "Read the exact approved source",
            parameters: {},
          }, delegatedGoalReportTool],
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
              options.executionChecklistRunId!,
              session.id,
              owner.id,
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
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: owner,
        targetClassification: "INTERNAL",
        getSessionTaint: () => "INTERNAL",
        providerRegistry: createProviderRegistry(),
        hookRunner: createHookRunner(createPolicyEngine()),
        goalCompletionPath: join(directory, "goal-completion.db"),
        messageStore: messages,
        tools: [{
          name: sourceRead.name,
          description: "Approved status",
          parameters: {},
        }],
        runManagedGoalCommand: completion.runCommand,
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
      socket.send(JSON.stringify({ type: "message", content }));
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
      assertStringIncludes(
        receipt.receipt.proof.reference,
        `${identity.executionId}:1:`,
      );
      sourceAllowed = false;
      assertStringIncludes(await turn(), "no longer authorized");
      assertEquals(reportCalls, 1);
      sourceAllowed = true;
      assertEquals(await turn(), "Published exact goal evidence.");
      assertEquals(sourceCalls, 1);
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
    } finally {
      store.close();
    }
  } finally {
    await storage.close();
    await Deno.remove(directory, { recursive: true });
  }
});
