import { TEAM_STORAGE_PREFIX } from "../../src/agent/team/types.ts";
import type { DelegatedGoalConfig } from "../../src/core/delegated_goal_config.ts";
import {
  buildDelegatedGoalCompletion,
  delegatedGoalReportTool,
} from "../../src/gateway/startup/factory/delegated_goal_completion.ts";
import { buildManagedDelegatedObservationGrant } from "../../src/gateway/startup/factory/managed_delegated_observation_grant.ts";
import type { OrchestratorConfig } from "../../src/agent/orchestrator/orchestrator_config.ts";
import { createSavedSourceAuthorization } from "../../src/agent/dispatch/saved_source_authorization.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";
import { buildSchedulerRecoveryBindings } from "../../src/gateway/startup/factory/scheduler_recovery.ts";
import { scheduledGoalReportTool } from "../../src/gateway/startup/factory/scheduler_goal_completion.ts";
import type { SecretStore } from "../../src/core/secrets/keychain/keychain.ts";
import { createCronManager } from "../../src/scheduler/cron/cron.ts";
import { createSqliteStorage } from "../../src/core/storage/sqlite.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { buildSchedulerGoalCompletion } from "../../src/gateway/startup/factory/scheduler_goal_completion.ts";
import {
  buildManagedScheduledObservationGrant,
  managedObservationGrantDigest,
} from "../../src/gateway/startup/factory/managed_scheduled_observation_grant.ts";
import type { TriggerFishConfig } from "../../src/core/config_types.ts";
import { notifyCommittedEvidence } from "../../src/core/evidence_task_progression.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { createChatSession } from "../../src/gateway/chat.ts";
import {
  selectSentinelDelegatedObservationRead,
  selectSentinelScheduledObservationRead,
  selectSentinelTeamObservationRead,
  type SentinelScheduledObservationRead,
  type SentinelTeamObservationRead,
} from "../../src/core/config_types.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import {
  createScheduledObservationRead,
  createWorkflowObservationVerifier,
  scheduledObservationTool,
  selectAgentObservationRead,
} from "../../src/gateway/scheduled_observation_tool.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/mod.ts";
import {
  createScheduledAgent,
  recoverySessionId,
  schedulerExecutionIdentity,
  schedulerRecoveryState,
} from "../../src/scheduler/service_execution.ts";
import { buildTeamManager } from "../../src/gateway/startup/factory/team_executor.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { EnhancedSessionManager } from "../../src/gateway/sessions.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { buildOwnerSubagentRecoveryCommand } from "../../src/gateway/startup/factory/owner_subagent_recovery.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  type ChannelId,
  createSession,
  restoreSession,
  type SessionId,
  updateTaint,
  type UserId,
} from "../../src/core/types/session.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import {
  buildExecutionTracePayloadAuthorizer,
  buildWorkflowRecoveryExecutor,
} from "../../src/gateway/startup/factory/agent_recovery.ts";
import {
  computeTimestampedHmac,
  createSchedulerService,
} from "../../src/scheduler/mod.ts";
import { openSchedulerTriggerAdmissions } from "../../src/scheduler/triggers/admissions.ts";
import { openSchedulerWebhookAdmissions } from "../../src/scheduler/webhooks/admissions.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  addSentinelCaseHint,
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  createSentinelWorkerPool,
  readAdaptiveSentinel,
  readAssignedSentinelModelReview,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { createSentinelLiveWorkflowReader } from "../../src/gateway/sentinel_live_workflow.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  readSentinelAssessment,
  refreshSentinelAssessment,
  resumeSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../../src/sentinel/cases.ts";

type TraceDenial = boolean | "source" | "source-pre";

async function withOperator(
  baseDir: string,
  check: (
    call: (
      args: Record<string, unknown>,
      withhold?: TraceDenial,
    ) => Promise<string>,
    chat: (content: string) => Promise<readonly ChatEvent[]>,
  ) => Promise<void>,
  approveArchive: boolean | ((request: string) => Promise<boolean>) = false,
  readLiveWorkflow?: ReturnType<typeof createSentinelLiveWorkflowReader>,
  sentinelMode = false,
) {
  const registry = createProviderRegistry();
  let args: Record<string, unknown> | undefined;
  let result = "";
  let withhold: TraceDenial = false;
  registry.register({
    name: "intermediate-operator-fixture",
    supportsStreaming: false,
    complete(messages) {
      const next = args;
      args = undefined;
      if (!next) {
        result = String(
          messages.findLast(({ role }) => role === "tool")?.content,
        );
      }
      const ordinary = messages.findLast(({ role }) => role === "user")
        ?.content === "Continue in ordinary chat.";
      return Promise.resolve({
        usage: { inputTokens: 1, outputTokens: 1 },
        content: next
          ? ""
          : ordinary
          ? "Ordinary chat is active."
          : "Checked retained observations.",
        toolCalls: next
          ? [{
            type: "function",
            id: crypto.randomUUID(),
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(next),
            },
          }]
          : [],
      });
    },
  });
  registry.setDefault("intermediate-operator-fixture");
  const token = crypto.randomUUID();
  const server = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        channelId: "fixture" as ChannelId,
        userId: "owner" as UserId,
        bumpersEnabled: false,
      }),
      providerRegistry: registry,
      ...(sentinelMode && {
        sentinelSnapshotPath: resolveSentinelCasePath(baseDir),
        allowSentinelModelAccess: true,
        resolveSentinelChatCase: (id: string) =>
          listSentinelCaseIds(baseDir).includes(id)
            ? resolveSentinelCasePath(baseDir, id)
            : undefined,
      }),
      hookRunner: {
        evaluateHook: (hook, { input }) => {
          const retainedSource =
            input.tool_name === "sentinel_intermediate_workflow_observation" ||
            input.tool_name === "sentinel_worker_trace_search";
          const allowed = !(hook === "POST_TOOL_RESPONSE" &&
            (withhold === true || withhold === "source" && retainedSource)) &&
            !(hook === "PRE_TOOL_CALL" && withhold === "source-pre" &&
              retainedSource);
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          });
        },
      },
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        readLiveWorkflow,
        confirm: typeof approveArchive === "function"
          ? approveArchive
          : () => Promise.resolve(approveArchive),
      }),
    }),
  });
  const { port } = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = async (content: string) => {
      const frames: ChatEvent[] = [];
      const done = Promise.withResolvers<readonly ChatEvent[]>();
      const timeout = setTimeout(
        () => done.reject(new Error("Operator tool turn timed out")),
        3000,
      );
      const receive = (event: MessageEvent) => {
        const frame = JSON.parse(event.data);
        if (frame.type === "turn_end") {
          done.resolve(frames);
          return;
        }
        frames.push(frame);
        if (frame.type === "error") {
          done.reject(new Error(JSON.stringify(frame)));
        }
      };
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({
          type: "message",
          content,
        }),
      );
      try {
        return await done.promise;
      } finally {
        clearTimeout(timeout);
        socket.removeEventListener("message", receive);
      }
    };
    if (sentinelMode) await turn("/sentinel on");
    await check(async (input, deny = false) => {
      withhold = deny;
      args = input;
      await turn("Inspect committed observations.");
      return result;
    }, turn);
  } finally {
    socket.close();
    await server.stop();
  }
}

Deno.test("Gateway workers cite an intermediate observation while its source review stays open", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "workflow-evidence";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const database = join(dirname(path), "sentinel-adaptive.db");
  const pool = createSentinelWorkerPool(2);
  const published = Promise.withResolvers<void>();
  const releaseSource = Promise.withResolvers<void>();
  let transportCalls = 0;
  let metadataAllowed = true;
  let metadataChecks = 0;
  let received = "";
  let peerProgress: unknown;
  let expectedGateOutcome: "success" | "failure" = "success";
  let rewrite: { id: string; prerequisites: string[] } | undefined;
  const allowPublication = Promise.withResolvers<void>();
  const allowPeerRead = Promise.withResolvers<void>();
  const scopes = [{
    case: caseId,
    asset: "delivery",
    owner: "owner",
    repo: "pipeline",
    workflow_id: 17,
  }, {
    case: caseId,
    asset: "dependent",
    owner: "owner",
    repo: "pipeline",
    workflow_id: 28,
  }];
  const selector = {
    repository: "owner/pipeline",
    workflowId: 17,
    outcome: "failure",
  };
  let dependentRuns = 0;
  let blockedSettlement = 0;
  let blockedClassification = 0;
  let settlementPolicy: "pre" | "post" | "allow" = "pre";
  const reader = createSentinelLiveWorkflowReader({
    scopes,
    resolveToken: () => Promise.resolve("fixture-token"),
    ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
    verifyAccess: () => {
      metadataChecks++;
      return Promise.resolve(metadataAllowed);
    },
    readRuns: () => {
      transportCalls++;
      return Promise.resolve([{
        id: 51,
        repositoryId: 420,
        status: "completed",
        conclusion: "failure",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00Z",
      }]);
    },
  });
  const hookRunner: HookRunner = {
    evaluateHook: (hook, { input }) => {
      const url = input.url;
      const reopensStatus = hook === "PRE_TOOL_CALL" &&
        input.tool_name === "sentinel_live_workflow_status" &&
        typeof url === "string" && url.endsWith("/workflows/17");
      const blocksDestination = reopensStatus && settlementPolicy === "pre";
      const blocksResponse = hook === "POST_TOOL_RESPONSE" &&
        input.tool_name === "sentinel_live_workflow_status" &&
        settlementPolicy === "post";
      if (blocksDestination) blockedSettlement++;
      if (blocksResponse) blockedClassification++;
      const blocked = blocksDestination || blocksResponse;
      return Promise.resolve({
        allowed: !blocked,
        action: blocked ? "BLOCK" : "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const registry = createProviderRegistry();
  const usage = { inputTokens: 1, outputTokens: 1 };
  function call(name: string, args: object = {}) {
    return {
      content: "",
      usage,
      toolCalls: [{
        type: "function",
        id: name + JSON.stringify(args),
        function: { name, arguments: JSON.stringify(args) },
      }],
    };
  }
  function summary(text: string) {
    return {
      content: JSON.stringify({ summary: text, followUps: [] }),
      usage,
      toolCalls: [],
    };
  }
  registry.register({
    name: "intermediate-workflow-fixture",
    supportsStreaming: false,
    async complete(messages) {
      const source = messages.some(({ role, content }) =>
        role === "user" && typeof content === "string" &&
        content.includes('"kind":"impact"')
      );
      const results = messages.filter(({ role }) => role === "tool");
      if (
        messages.some(({ role, content }) =>
          role === "user" && typeof content === "string" &&
          content.includes('"target":"dependent"')
        )
      ) {
        dependentRuns++;
        return summary("Future workflow dependency released.");
      }
      if (source) {
        if (!results.length) return call("sentinel_live_workflow_status");
        if (results.length === 1) {
          assert(String(results[0].content).includes('"id":51'));
          await allowPublication.promise;
          return call("sentinel_publish_workflow_observation");
        }
        assert(String(results[1].content).includes("workflow-observation:"));
        published.resolve();
        await releaseSource.promise;
        return summary("Source was released.");
      }
      await published.promise;
      await allowPeerRead.promise;
      if (!results.length) {
        return call("sentinel_worker_trace_search", {
          liveProgress: true,
          query: "sentinel_publish_workflow_observation",
        });
      }
      if (results.length === 1) {
        const page = JSON.parse(String(results[0].content));
        peerProgress = page;
        assertEquals(page.steps.length, 1);
        const [step] = page.steps;
        assertEquals(step.tool, "sentinel_publish_workflow_observation");
        assertEquals(Object.keys(step).toSorted(), [
          "index",
          "outcome",
          "reviewId",
          "target",
          "taskId",
          "tool",
        ]);
        return call("sentinel_worker_trace_search", {
          liveProgress: true,
          task: step.taskId,
          stepIndices: [step.index],
        });
      }
      if (results.length === 2) {
        const earlier = JSON.parse(String(results[0].content)).steps;
        assertEquals(JSON.parse(String(results[1].content)).steps, earlier);
        return call("sentinel_intermediate_workflow_observation");
      }
      if (results.length === 3) {
        const id = String(results[2].content).match(
          /workflow-observation:[a-f0-9]{64}/,
        )?.[0];
        assert(id);
        received = id;
        return call("sentinel_intermediate_workflow_observation", { id });
      }
      const receipt = String(results[3].content);
      assert(
        receipt.includes(received) && receipt.includes('"id":51') &&
          receipt.includes('"failure"'),
      );
      return summary("Peer cited the exact failed run.");
    },
  });
  registry.setDefault("intermediate-workflow-fixture");
  let planningClock = Date.now();
  let presentedObservation: unknown;
  const planner = createSentinelModelPlanner(
    path,
    (state, taskId, token) => {
      if (!taskId || !token) {
        let actual: ReturnType<typeof createSentinelSubagent> | undefined;
        const scopeAgent = createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          plannerExecutionEvidenceRunId: state.plan.runId,
          allowModelAccess: true,
          providerRegistry: registry,
          readRetainedWorkflow: reader,
          futureWorkflowScopes: scopes,
          hookRunner,
        });
        return {
          futureWorkflowTargets: scopeAgent.futureWorkflowTargets,
          permitsFutureWorkflow: scopeAgent.permitsFutureWorkflow,
          authorizeFutureWorkflow: scopeAgent.authorizeFutureWorkflow,
          execute(
            ...args: Parameters<
              ReturnType<typeof createSentinelSubagent>["execute"]
            >
          ) {
            const [message, send] = args;
            const input = JSON.parse(String(message).split("\n").at(-1)!);
            if (input.committedObservations?.length) {
              presentedObservation = input.committedObservations[0];
              const id = input.committedObservations[0].id;
              const providerRegistry = createProviderRegistry();
              providerRegistry.register({
                name: "cite-committed-observation",
                supportsStreaming: false,
                complete(messages) {
                  const result = messages.findLast(({ role }) =>
                    role === "tool"
                  );
                  if (!result) {
                    return Promise.resolve(call(
                      "sentinel_intermediate_workflow_observation",
                      { id },
                    ));
                  }
                  assertEquals(JSON.parse(String(result.content)).id, id);
                  if (rewrite) {
                    return Promise.resolve({
                      content: JSON.stringify({
                        assignments: [{
                          kind: "trace",
                          depth: 1,
                          nodeId: "dependent",
                          futureWorkflowOutcome: {
                            ...selector,
                            workflowId: 28,
                          },
                        }],
                        prioritize: [],
                        dependencies: [{
                          id: rewrite.id,
                          prerequisites: [...rewrite.prerequisites, "new:0"],
                          reason:
                            "The observed failure warrants waiting for the dependent workflow outcome.",
                        }],
                      }),
                      usage,
                      toolCalls: [],
                    });
                  }
                  return Promise.resolve({
                    content: JSON.stringify([{
                      kind: "trace",
                      depth: 1,
                      nodeId: "delivery",
                      committedObservationId: "workflow-observation:" +
                        "0".repeat(64),
                      requiredWorkflowOutcome: "failure",
                    }, {
                      kind: "trace",
                      depth: 1,
                      nodeId: "delivery",
                      committedObservationId: id,
                      requiredWorkflowOutcome: expectedGateOutcome,
                    }, {
                      kind: "trace",
                      depth: 1,
                      nodeId: "delivery",
                      committedObservationId: id,
                      dependsOn: [1],
                    }, {
                      kind: "impact",
                      depth: 1,
                      nodeId: "delivery",
                      committedObservationId: id,
                    }]),
                    usage,
                    toolCalls: [],
                  });
                },
              });
              providerRegistry.setDefault("cite-committed-observation");
              actual = createSentinelSubagent({
                snapshotPath: path,
                assessmentRevision: state.revision,
                plannerExecutionEvidenceRunId: state.plan.runId,
                allowModelAccess: true,
                providerRegistry,
                readRetainedWorkflow: reader,
                hookRunner,
              });
              return actual.execute(...args);
            }
            assertEquals(input.futureWorkflowTargets, [{
              assetId: "delivery",
              repository: "owner/pipeline",
              workflowId: 17,
            }, {
              assetId: "dependent",
              repository: "owner/pipeline",
              workflowId: 28,
            }]);
            send({
              type: "response",
              taint: "INTERNAL",
              text: JSON.stringify([
                { kind: "impact", nodeId: "delivery" },
                { kind: "trace", nodeId: "delivery" },
                {
                  kind: "trace",
                  nodeId: "delivery",
                  depth: 1,
                  futureWorkflowOutcome: selector,
                },
                {
                  kind: "trace",
                  nodeId: "delivery",
                  depth: 1,
                  futureWorkflowOutcome: { ...selector, outcome: "success" },
                },
                {
                  kind: "trace",
                  nodeId: "delivery",
                  depth: 1,
                  futureWorkflowOutcome: { ...selector, workflowId: 999 },
                },
                { kind: "trace", nodeId: "dependent", dependsOn: [2] },
                {
                  kind: "impact",
                  depth: 1,
                  nodeId: "delivery",
                  dependsOn: [0, 3],
                },
              ]),
            });
            return Promise.resolve();
          },
          clear() {
            actual?.clear();
          },
        };
      }
      const withStore = <T>(
        operation: (store: ReturnType<typeof openSentinelAdaptiveStore>) => T,
      ) => {
        const store = openSentinelAdaptiveStore(database);
        try {
          return operation(store);
        } finally {
          store.close();
        }
      };
      return createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        assignedTaskId: taskId,
        assignedTaskLeaseToken: token,
        hookRunner,
        providerRegistry: registry,
        allowModelAccess: true,
        readLiveWorkflowStatus: (
          { task, evidenceRevision, signal, authorize, resumeOnly },
        ) =>
          reader({
            caseId,
            assetId: task.nodeId!,
            evidenceRevision,
            signal,
            authorize,
            resumeOnly,
            isCurrent: () =>
              !!readAssignedSentinelModelReview(
                path,
                evidenceRevision,
                taskId,
                token,
              ),
            loadSaved: () =>
              withStore((store) =>
                store.readLeasedGitHubWorkflowResult(
                  task.revision,
                  task.id,
                  token,
                  evidenceRevision,
                )
              ),
            saveResult: (receipt) =>
              withStore((store) =>
                store.recordLeasedGitHubWorkflowResult(
                  task.revision,
                  task.id,
                  token,
                  evidenceRevision,
                  receipt,
                )
              ),
          }),
      });
    },
    () => pool(path),
    () => planningClock,
  );

  async function waitFor(condition: () => boolean) {
    for (let attempt = 0; attempt < 160 && !condition(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(condition());
  }
  let coordinator:
    | ReturnType<typeof startSentinelAssessmentCoordinator>
    | undefined;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "delivery", kind: "asset", label: "Delivery pipeline" },
          { id: "dependent", kind: "asset", label: "Dependency fixture" },
        ],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    coordinator = startSentinelAssessmentCoordinator({
      snapshotPath: path,
      advanceAdaptive: (current) => planner.advance(current),
    });
    planner.advance(state);
    const futureGate = () =>
      readAdaptiveSentinel(path, state)?.tasks.find(
        ({ plannerRound }) =>
          plannerRound?.futureWorkflowOutcome?.outcome === "failure",
      );
    await waitFor(() => futureGate()?.status === "queued");
    const pending = readAdaptiveSentinel(path, state)!;
    const dependent = pending.tasks.find(({ nodeId }) =>
      nodeId === "dependent"
    )!;
    const futureGateId = futureGate()!.id;
    const heldImpact = pending.tasks.find(({ kind, depth }) =>
      kind === "impact" && depth === 1
    )!;
    assertEquals(heldImpact.status, "queued");
    assertEquals(heldImpact.prerequisites.length, 2);
    assertEquals(heldImpact.plannerRound?.committedObservation, undefined);
    assertEquals(dependent.prerequisites, [futureGateId]);
    assertEquals(dependent.status, "queued");
    assertEquals(futureGate()?.attempts, 0);
    assertEquals(
      pending.tasks.filter(({ plannerRound }) =>
        plannerRound?.futureWorkflowOutcome
      ).length,
      2,
    );
    await withOperator(
      baseDir,
      async (_read, chat) => {
        const selected = await chat(`/sentinel case ${caseId}`);
        assertStringIncludes(
          JSON.stringify(selected),
          `Sentinel case: ${caseId}.`,
        );
        const source = readAdaptiveSentinel(path, state)?.tasks.find((
          { kind, depth },
        ) => kind === "impact" && depth === 2);
        assert(source);
        const live = () =>
          readAdaptiveSentinel(path, state)?.modelReviewStates.find(
            ({ taskId }) => taskId === source.id,
          );
        await waitFor(() =>
          live()?.status === "running" && transportCalls === 1
        );
        const exited = await chat("/sentinel off");
        assert(
          exited.some((event) =>
            event.type === "sentinel_mode" && !event.active
          ),
        );
        const ordinary = await chat("Continue in ordinary chat.");
        assert(ordinary.some((event) =>
          event.type === "response" &&
          event.text === "Ordinary chat is active."
        ));
        assertEquals(live()?.status, "running");
        assertEquals(readSentinelAssessment(path)?.active, true);
        assertEquals(
          readAdaptiveSentinel(path, state)?.workflowObservations.length,
          0,
        );

        assertEquals(presentedObservation, undefined);
        planningClock += 61_000;
        allowPublication.resolve();
        await published.promise;
        allowPeerRead.resolve();
        await waitFor(() => presentedObservation !== undefined);
        const [committed] =
          readAdaptiveSentinel(path, state)!.workflowObservations;
        assertEquals(presentedObservation, {
          id: committed.id,
          taskId: source.id,
          targetId: committed.targetId,
          evidenceRevision: state.revision,
          stepIndex: committed.stepIndex,
          resultSha256: committed.receipt.resultSha256,
        });
        assert(
          readAdaptiveSentinel(path, state)?.modelPlannerHistory.some(
            ({ inputManifest }) =>
              inputManifest?.committedObservationIds?.includes(committed.id),
          ),
        );
        assertEquals(live()?.status, "running");
      },
      false,
      reader,
      true,
    );
    await waitFor(() => blockedSettlement > 0);
    assertEquals(futureGate()?.status, "queued");
    assertEquals(dependentRuns, 0);
    const committed =
      readAdaptiveSentinel(path, state)!.workflowObservations[0];
    const wake = {
      case: caseId,
      run_id: state.plan.runId!,
      revision: state.revision,
      observation_id: committed.id,
    };
    settlementPolicy = "post";
    planningClock += 2_001;
    notifyCommittedEvidence(wake);
    await waitFor(() => blockedClassification > 0);
    assertEquals(futureGate()?.status, "queued");
    assertEquals(dependentRuns, 0);
    settlementPolicy = "allow";
    planningClock += 2_001;
    notifyCommittedEvidence(wake);
    notifyCommittedEvidence(wake);
    await waitFor(() => futureGate()?.status === "completed");
    const futureProof = futureGate()!.factSatisfaction!;
    assertEquals(futureProof, {
      sourceTaskId: committed.taskId,
      sourceObservationSha256: committed.receipt.resultSha256,
      workflowObservationId: committed.id,
      evidenceRevision: state.revision,
    });
    await waitFor(() => dependentRuns === 1);
    const released = readAdaptiveSentinel(path, state)!;
    assertEquals(
      released.tasks.find(({ plannerRound }) =>
        plannerRound?.futureWorkflowOutcome?.outcome === "success"
      )?.status,
      "queued",
    );
    assertEquals(
      released.history.filter(({ taskId, event }) =>
        taskId === futureGateId && event === "fact_satisfied"
      ).length,
      1,
    );
    assert(
      !released.history.some(({ taskId, event }) =>
        taskId === futureGateId &&
        (event === "claimed" || event === "model_review_claimed")
      ),
    );
    coordinator.stop();
    await waitFor(() =>
      !!readAdaptiveSentinel(path, state)?.modelReviews.some(({ summary }) =>
        summary === "Peer cited the exact failed run."
      )
    );
    const view = readAdaptiveSentinel(path, state)!;
    const [observation] = view.workflowObservations;
    const source = view.tasks.find(({ kind, depth }) =>
      kind === "impact" && depth === 2
    )!;
    const peer = view.tasks.find(({ kind, nodeId, plannerRound }) =>
      kind === "trace" && nodeId === "delivery" &&
      !plannerRound?.futureWorkflowOutcome
    )!;
    assertEquals(observation.id, received);
    assertEquals(observation.taskId, source.id);
    assertEquals(observation.evidenceRevision, state.revision);
    assertEquals(observation.stepIndex, 0);
    assertEquals(
      view.modelReviewStates.find(({ taskId }) => taskId === source.id)?.status,
      "running",
    );
    assert(!view.modelReviews.some(({ taskId }) => taskId === source.id));
    planningClock += 61_000;
    planner.advance(state);
    await waitFor(() => presentedObservation !== undefined);
    assertEquals(presentedObservation, {
      id: observation.id,
      taskId: source.id,
      targetId: observation.targetId,
      evidenceRevision: state.revision,
      stepIndex: observation.stepIndex,
      resultSha256: observation.receipt.resultSha256,
    });
    assertEquals(
      readAdaptiveSentinel(path, state)?.modelReviewStates.find(({ taskId }) =>
        taskId === source.id
      )?.status,
      "running",
    );
    await waitFor(() =>
      readAdaptiveSentinel(path, state)?.modelPlannerHistory.some((
        { outcome },
      ) => outcome === "proposal_rejected") === true
    );
    assert(
      !readAdaptiveSentinel(path, state)?.tasks.some(({ plannerRound }) =>
        plannerRound?.requiredWorkflowOutcome !== undefined
      ),
    );
    expectedGateOutcome = "failure";
    addSentinelCaseHint(path, "Use the verified failed workflow outcome.");
    planningClock += 61_000;
    planner.advance(state);
    const citedTask = () =>
      readAdaptiveSentinel(path, state)?.tasks.find(
        (task) =>
          task.kind === "trace" &&
          task.plannerRound?.committedObservation?.observationId ===
            observation.id &&
          !task.plannerRound.requiredWorkflowOutcome,
      );
    await waitFor(() => !!citedTask());
    const afterGate = readAdaptiveSentinel(path, state)!;
    const updatedImpact = afterGate.tasks.find(({ id }) =>
      id === heldImpact.id
    )!;
    assertEquals(updatedImpact.status, "queued");
    assertEquals(updatedImpact.attempts, 0);
    assertEquals(updatedImpact.prerequisites, heldImpact.prerequisites);
    assertEquals(updatedImpact.plannerRound?.committedObservation, {
      observationId: observation.id,
      sourceTaskId: source.id,
      sourceStepIndex: observation.stepIndex,
      targetId: observation.targetId,
      evidenceRevision: observation.evidenceRevision,
      resultSha256: observation.receipt.resultSha256,
    });
    assertEquals(
      afterGate.history.filter(({ event, taskId }) =>
        event === "evidence_attached" && taskId === heldImpact.id
      ).length,
      1,
    );
    const workflowGates = afterGate.tasks.filter(({ plannerRound }) =>
      plannerRound?.requiredWorkflowOutcome !== undefined
    );
    assertEquals(workflowGates.length, 1);
    const [gate] = workflowGates;
    assertEquals(gate.status, "completed");
    assertEquals(gate.attempts, 0);
    assertEquals(gate.factSatisfaction, {
      sourceTaskId: source.id,
      sourceObservationSha256: observation.receipt.resultSha256,
      workflowObservationId: observation.id,
      evidenceRevision: state.revision,
    });
    assertEquals(
      afterGate.modelReviewStates.find(({ taskId }) => taskId === source.id)
        ?.status,
      "running",
    );
    assertEquals(citedTask()?.prerequisites, [source.id, gate.id].sort());
    assertEquals(
      citedTask()?.plannerRound?.committedObservation?.sourceStepIndex,
      observation.stepIndex,
    );
    const followUpId = citedTask()!.id;
    await waitFor(() =>
      !!readAdaptiveSentinel(path, state)?.modelReviews
        .find(({ taskId, steps }) =>
          taskId === followUpId && steps.some(
            (step) =>
              step.intermediateWorkflowObservation?.observationId ===
                observation.id,
          )
        )
    );
    const completed = readAdaptiveSentinel(path, state)!;
    const queueForRewrite = () => readAdaptiveSentinel(path, state);
    const heldTask = () =>
      queueForRewrite()?.tasks.find(({ id }) => id === heldImpact.id);
    const rewriteGate = () =>
      queueForRewrite()?.tasks.find(({ plannerRound }) =>
        plannerRound?.futureWorkflowOutcome?.workflowId === 28
      );
    const planRevision = async (prerequisites: string[]) => {
      const previous = queueForRewrite()?.modelPlannerHistory.length ?? 0;
      rewrite = { id: heldImpact.id, prerequisites };
      addSentinelCaseHint(
        path,
        "Consider the committed failure when revising queued work.",
      );
      planningClock += 61_000;
      planner.advance(state);
      await waitFor(() =>
        (queueForRewrite()?.modelPlannerHistory.length ?? 0) > previous
      );
    };
    const dependentChain: { id: string; prerequisites: readonly string[] }[] =
      [];
    const queueStore = openSentinelAdaptiveStore(database);
    try {
      let prerequisite = heldImpact.id;
      for (const depth of [7, 8]) {
        const task = queueStore.sync(
          completed.revision,
          [{
            kind: "trace",
            nodeId: "dependent",
            depth,
            prerequisites: [prerequisite],
          }],
          completed.revision,
        ).find((task) =>
          task.kind === "trace" && task.nodeId === "dependent" &&
          task.depth === depth
        );
        assert(task);
        dependentChain.push(task);
        prerequisite = task.id;
      }
    } finally {
      queueStore.close();
    }
    await planRevision(
      heldImpact.prerequisites.filter((id) => id !== source.id),
    );
    assertEquals(heldTask()?.dependencyRecommendation, undefined);
    assertEquals(rewriteGate(), undefined);
    await planRevision([...heldImpact.prerequisites]);
    await waitFor(() => heldTask()?.dependencyRecommendation !== undefined);
    for (const entry of dependentChain) {
      const current = queueForRewrite()?.tasks.find(({ id }) =>
        id === entry.id
      );
      assertEquals(current?.status, "queued");
      assertEquals(current?.prerequisites, entry.prerequisites);
      assertEquals(current?.dependencyRecommendation?.affectedOnly, true);
    }
    const request = (proposalId: string) => ({
      action: "apply_task_dependencies",
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      taskId: heldImpact.id,
      proposalId,
    });
    const apply = request(heldTask()!.dependencyRecommendation!.id);
    assertEquals(heldTask()?.prerequisites, heldImpact.prerequisites);
    assertEquals(rewriteGate(), undefined);
    await withOperator(baseDir, async (turn) => {
      assertStringIncludes(await turn(apply), "declined");
      assertEquals(heldTask()?.prerequisites, heldImpact.prerequisites);
      assertEquals(rewriteGate(), undefined);
    });
    await withOperator(baseDir, async (turn) => {
      assertStringIncludes(await turn(apply), "unavailable");
      assertEquals(heldTask()?.prerequisites, heldImpact.prerequisites);
      assertEquals(rewriteGate(), undefined);
      for (const entry of dependentChain) {
        assertEquals(
          queueForRewrite()?.tasks.find(({ id }) => id === entry.id)
            ?.dependencyRecommendation,
          undefined,
        );
      }
    }, () => {
      addSentinelCaseHint(path, "New evidence changed the approval context.");
      return Promise.resolve(true);
    });
    await planRevision([...heldImpact.prerequisites]);
    await waitFor(() => heldTask()?.dependencyRecommendation !== undefined);
    const approvedPlan = heldTask()!.dependencyRecommendation!;
    const current = request(approvedPlan.id);
    const approvalRead = { ...current, action: "tasks" };
    assert(current.proposalId !== apply.proposalId);
    await withOperator(baseDir, async (turn) => {
      const applied = JSON.parse(await turn(current));
      assertEquals(applied.decision, "applied");
      assertStringIncludes(await turn(current), "unavailable");
    }, (prompt) => {
      const approval = JSON.parse(prompt.split("\n").at(-1)!);
      const affected = approval.changes.filter((
        { proposal }: { proposal: { affectedOnly?: boolean } },
      ) => proposal.affectedOnly);
      assertEquals(
        affected.map(({ taskId }: { taskId: string }) => taskId).sort(),
        dependentChain.map(({ id }) => id).sort(),
      );
      for (const { taskId, proposal } of affected) {
        assertEquals(
          proposal.prerequisites,
          dependentChain.find(({ id }) => id === taskId)?.prerequisites,
        );
      }
      return Promise.resolve(true);
    });
    for (const entry of dependentChain) {
      const current = queueForRewrite()?.tasks.find(({ id }) =>
        id === entry.id
      );
      assertEquals(current?.prerequisites, entry.prerequisites);
      assertEquals(current?.status, "queued");
      assertEquals(current?.dependencyRecommendation, undefined);
    }
    const dependentWorkflowGate = rewriteGate()!;
    assertEquals(dependentWorkflowGate.status, "queued");
    assertEquals(dependentWorkflowGate.attempts, 0);
    assertEquals(heldTask()?.status, "queued");
    assertEquals(heldTask()?.attempts, 0);
    assertEquals(
      heldTask()?.prerequisites,
      [...heldImpact.prerequisites, dependentWorkflowGate.id].sort(),
    );
    assertEquals(
      heldTask()?.plannerRound?.committedObservation,
      updatedImpact.plannerRound?.committedObservation,
    );
    assert(approvedPlan.planningIdentity && state.plan.runId);
    const expectedApproval = {
      _classification: "INTERNAL" as const,
      proposalId: approvedPlan.id,
      planningIdentity: approvedPlan.planningIdentity,
      runId: state.plan.runId,
      evidenceRevision: state.revision,
      adaptiveRevision: completed.revision,
      changes: [{
        taskId: heldImpact.id,
        before: heldImpact.prerequisites,
        after: heldTask()!.prerequisites,
      }],
      affected: dependentChain.map(({ id, prerequisites }) => ({
        taskId: id,
        prerequisites,
      })),
    };
    const appliedEvent = queueForRewrite()?.history.find(({ event, taskId }) =>
      event === "dependency_change_applied" && taskId === heldImpact.id
    );
    assertEquals(appliedEvent?.note, approvedPlan.reason);
    assertEquals(appliedEvent?.dependencyApproval, expectedApproval);
    const affectedApprovalRead = {
      ...approvalRead,
      taskId: dependentChain.at(-1)!.id,
    };
    await withOperator(baseDir, async (turn) => {
      assertEquals(
        JSON.parse(await turn(approvalRead)).dependencyApproval,
        expectedApproval,
      );
      assertEquals(
        JSON.parse(await turn(affectedApprovalRead)).dependencyApproval,
        expectedApproval,
      );
      assertStringIncludes(
        await turn({ ...approvalRead, taskId: dependentWorkflowGate.id }),
        "unavailable",
      );
      assertStringIncludes(
        await turn({ ...approvalRead, proposalId: apply.proposalId }),
        "unavailable",
      );
      assertStringIncludes(
        await turn({ ...approvalRead, revision: state.revision + 1 }),
        "unavailable",
      );
      assert(!String(await turn(approvalRead, true)).includes(approvedPlan.id));
    });

    assertEquals(
      completed.history.filter(({ taskId, event }) =>
        taskId === gate.id && event === "fact_satisfied"
      ).length,
      1,
    );
    assert(
      !completed.history.some(({ taskId, event }) =>
        taskId === gate.id &&
        (event === "claimed" || event === "model_review_claimed")
      ),
    );
    assertEquals(
      completed.history.filter(({ taskId, event }) =>
        taskId === followUpId && event === "claimed"
      ).length,
      1,
    );
    const runId = state.plan.runId;
    assert(runId);
    const grant = {
      cron_job_id: crypto.randomUUID(),
      case: caseId,
      run_id: runId,
      revision: state.revision,
      observation_id: observation.id,
    };
    assertEquals(
      selectSentinelScheduledObservationRead([grant], grant.cron_job_id),
      grant,
    );
    assertEquals(
      selectSentinelScheduledObservationRead(
        [grant, grant],
        grant.cron_job_id,
      ),
      undefined,
    );
    assertEquals(
      selectSentinelScheduledObservationRead([grant], crypto.randomUUID()),
      undefined,
    );
    let scheduledAllowed = true;
    let scheduledChecks = 0;
    const scheduled = createScheduledObservationRead(
      baseDir,
      grant,
      (payload, classification) => {
        scheduledChecks++;
        assertEquals(classification, "INTERNAL");
        assertEquals(payload, {
          kind: "github_actions_status",
          repo: "owner/pipeline",
          workflow: "17",
          repositoryId: 420,
          runs: [{
            id: 51,
            status: "completed",
            conclusion: "failure",
            created_at: "2026-01-01T00:00:00.000Z",
          }],
        });
        return Promise.resolve(scheduledAllowed);
      },
    );
    assertEquals(JSON.parse(await scheduled({})), {
      _classification: "INTERNAL",
      caseId,
      runId,
      observation,
    });
    assert(
      (await scheduled({ observationId: observation.id })).startsWith("Error:"),
    );
    assertEquals(scheduledChecks, 1);
    scheduledAllowed = false;
    assert((await scheduled({})).startsWith("Error:"));
    assertEquals(scheduledChecks, 2);
    let foreignChecks = 0;
    const foreign = createScheduledObservationRead(
      baseDir,
      { ...grant, run_id: crypto.randomUUID() },
      () => {
        foreignChecks++;
        return Promise.resolve(true);
      },
    );
    assert((await foreign({})).startsWith("Error:"));
    assertEquals(foreignChecks, 0);
    let workflowEvidenceChecks = 0;
    const verifyWorkflowEvidence = createWorkflowObservationVerifier(
      baseDir,
      () => {
        workflowEvidenceChecks++;
        return Promise.resolve(true);
      },
    );
    const workflowRequirement = { ...grant, workflow_run_id: 51 };
    // The exact GitHub run failed. Current repository access does not qualify it.
    assertEquals(await verifyWorkflowEvidence(workflowRequirement), undefined);
    assertEquals(workflowEvidenceChecks, 1);
    assertEquals(
      await verifyWorkflowEvidence({
        ...workflowRequirement,
        revision: state.revision - 1,
      }),
      undefined,
    );
    assertEquals(workflowEvidenceChecks, 1);
    const toolName = scheduledObservationTool.name;
    scheduledAllowed = true;
    for (
      const denied of [
        undefined,
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
        "PRE_OUTPUT",
      ]
    ) {
      const hooks: string[] = [];
      let modelResult = "";
      let outputTaint: unknown;
      const providers = createProviderRegistry();
      providers.register({
        name: "scheduled-observation-fixture",
        supportsStreaming: false,
        complete(messages) {
          const result = messages.findLast(({ role }) => role === "tool");
          if (result) modelResult = String(result.content);
          return Promise.resolve(
            result ? summary("Checked observation.") : call(toolName),
          );
        },
      });
      providers.setDefault("scheduled-observation-fixture");
      const config = {
        triggerMdPath: join(baseDir, "TRIGGER.md"),
        trigger: {
          enabled: false,
          intervalMinutes: 30,
          classificationCeiling: "INTERNAL" as const,
        },
        webhooks: { enabled: false, sources: {} },
        executionTracePath: join(baseDir, "scheduled-observation-traces.db"),
        orchestratorFactory: {
          create(channelId: string) {
            const session = createSession({
              userId: "scheduled-fixture" as UserId,
              channelId: channelId as ChannelId,
            });
            let taint: ClassificationLevel = "PUBLIC";
            const toolExecutor = (
              name: string,
              args: Record<string, unknown>,
            ) =>
              name === toolName
                ? scheduled(args)
                : Promise.resolve("Unavailable");
            const orchestrator = createOrchestrator({
              providerRegistry: providers,
              enableStreaming: false,
              isOwnerSession: () => false,
              getNonOwnerCeiling: () => "INTERNAL",
              getSessionTaint: () => taint,
              escalateTaint: (level) => {
                taint = level;
              },
              toolClassifications: new Map([[toolName, "INTERNAL"]]),
              tools: [scheduledObservationTool],
              toolExecutor,
              hookRunner: {
                evaluateHook(hook, { session }) {
                  hooks.push(hook);
                  if (hook === "PRE_OUTPUT") outputTaint = session.taint;
                  const allowed = hook !== denied;
                  return Promise.resolve({
                    allowed,
                    action: allowed ? "ALLOW" : "BLOCK",
                    ruleId: null,
                    duration: 0,
                  });
                },
              },
            });
            return Promise.resolve({
              session,
              toolExecutor,
              orchestrator,
              getSessionTaint: () => taint,
            });
          },
        },
      };
      const before = scheduledChecks;
      const { session, orchestrator } = await createScheduledAgent(
        config,
        "cron",
        { ceiling: "INTERNAL", cronJobId: grant.cron_job_id },
        schedulerExecutionIdentity(
          "cron",
          grant.cron_job_id,
          denied ?? "allowed",
        ),
      );
      const outcome = await orchestrator.executeAgentTurn({
        session,
        message: "Read the granted observation.",
        targetClassification: "INTERNAL",
      });
      assert(hooks.includes("PRE_TOOL_CALL"));
      assertEquals(
        scheduledChecks - before,
        denied === "PRE_TOOL_CALL" ? 0 : 1,
      );
      if (denied !== "PRE_TOOL_CALL") {
        assert(hooks.includes("POST_TOOL_RESPONSE"));
      }
      if (denied === "PRE_TOOL_CALL" || denied === "POST_TOOL_RESPONSE") {
        assert(!modelResult.includes(observation.id));
      } else {
        assertEquals(JSON.parse(modelResult).observation, observation);
        assertEquals(outputTaint, "INTERNAL");
      }
      assert(hooks.includes("PRE_OUTPUT"));
      assertEquals(outcome.ok, denied !== "PRE_OUTPUT");
    }
    await verifyScheduledObservationSources(baseDir, {
      case: caseId,
      run_id: runId,
      revision: state.revision,
      observation_id: observation.id,
    }, observation);
    const trace = {
      action: "worker_trace_result",
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      taskId: source.id,
      stepIndices: [1],
    };
    const peerStep = view.modelReviews.find(({ taskId }) => taskId === peer.id)
      ?.steps.findIndex(({ intermediateWorkflowObservation }) =>
        intermediateWorkflowObservation?.observationId === observation.id
      );
    assert(peerStep !== undefined && peerStep > 0);
    const peerTrace = { ...trace, taskId: peer.id, stepIndices: [peerStep] };
    const peerPage = { ...peerTrace, stepIndices: [peerStep - 1] };
    const exactPeerProgress = { ...peerTrace, stepIndices: [0] };
    const expectedPeerPage = {
      evidenceRevision: state.revision,
      targetId: observation.targetId,
      observations: [{
        id: observation.id,
        sourceTaskId: source.id,
        observedAt: observation.receipt.observedAt,
      }],
      nextOffset: null,
    };
    const expectedPublication = {
      id: observation.id,
      targetId: observation.targetId,
      evidenceRevision: state.revision,
    };
    await withOperator(
      baseDir,
      async (turn) => {
        const query = {
          action: "intermediate_observations",
          kind: "sentinel",
          id: caseId,
          revision: state.revision,
        };
        const publication = JSON.parse(await turn(trace));
        assertEquals(
          JSON.parse(await turn(exactPeerProgress)).result,
          peerProgress,
        );
        assertStringIncludes(
          await turn(exactPeerProgress, "source-pre"),
          "unavailable",
        );
        assertStringIncludes(
          await turn(exactPeerProgress, "source"),
          "unavailable",
        );
        assertEquals(JSON.parse(await turn(peerTrace)).result, observation);
        assert((await turn(peerTrace, "source")).includes("unavailable"));
        assertEquals(
          await turn(peerTrace, true),
          "Tool response withheld by policy.",
        );
        assertEquals(JSON.parse(await turn(peerPage)).result, expectedPeerPage);
        assert((await turn(peerPage, "source")).includes("unavailable"));
        assertEquals(publication.result, expectedPublication);
        assertEquals(
          await turn(trace, true),
          "Tool response withheld by policy.",
        );
        assert(
          (await turn({ ...trace, taskId: peer.id, stepIndices: [9] }))
            .includes(
              "unavailable",
            ),
        );
        const listed = JSON.parse(await turn(query)).page;
        assertEquals(listed.observations.map(({ id }: { id: string }) => id), [
          observation.id,
        ]);
        const exact = { ...query, observationId: observation.id };
        assertEquals(
          JSON.parse(await turn(exact)).page.observation,
          observation,
        );
        assertEquals(
          await turn(exact, true),
          "Tool response withheld by policy.",
        );
        assert(
          (await turn({ ...exact, id: "unpublished-case" })).includes(
            "unavailable",
          ),
        );
        assert(
          (await turn({ ...exact, revision: state.revision + 1 })).includes(
            "unavailable",
          ),
        );
      },
      false,
      reader,
    );
    assertEquals(
      readAdaptiveSentinel(path, state)?.modelReviewStates.find(({ taskId }) =>
        taskId === source.id
      )?.status,
      "running",
    );
    assertEquals(transportCalls, 1);

    let originalPlannerResults: string[] = [];
    const plannerRegistry = createProviderRegistry();
    plannerRegistry.register({
      name: "planner-intermediate-fixture",
      supportsStreaming: false,
      complete(messages) {
        originalPlannerResults = messages.filter(({ role }) => role === "tool")
          .map(({ content }) => String(content));
        const selectors = [{ id: observation.id }, { limit: 1 }, {
          offset: 1,
          limit: 1,
        }];
        const selector = selectors[originalPlannerResults.length];
        return Promise.resolve(
          selector
            ? call("sentinel_intermediate_workflow_observation", selector)
            : { content: "[]", usage, toolCalls: [] },
        );
      },
    });
    plannerRegistry.setDefault("planner-intermediate-fixture");
    const readerAgent = createSentinelSubagent({
      snapshotPath: path,
      assessmentRevision: state.revision,
      plannerExecutionEvidenceRunId: state.plan.runId,
      readRetainedWorkflow: reader,
      providerRegistry: plannerRegistry,
      allowModelAccess: true,
      hookRunner,
    });
    const journal = openSentinelAdaptiveStore(
      database,
      () => planningClock + 61_000,
    );
    let plannerIdentity: string;
    try {
      const mapped = journal.forEvidence(state.revision);
      assert(mapped);
      plannerIdentity = `${mapped.revision}:obs:planner-intermediate`;
      assertEquals(journal.claimModelPlan(plannerIdentity), 1);
      assert(journal.recordModelPlanInputManifest(plannerIdentity, 1, {
        promptSha256: "a".repeat(64),
        hintIds: [],
        findingReviewIds: [],
        incidentReviewIds: [],
        incidentCandidateIds: [],
        investigationIds: [],
        inventoryNodeIds: [],
        workerObservations: [],
      }));
      await readerAgent.execute(
        "Read the committed workflow observation.",
        () => {},
        undefined,
        (step) => {
          assert(
            (step.intermediateWorkflowObservation ||
              step.intermediateWorkflowPage) && step.goalReceiptRead,
          );
          assert(journal.recordModelPlanRead(plannerIdentity, 1, step));
        },
      );
      journal.completeModelPlan(plannerIdentity, 1, "no_new_assignments");
    } finally {
      journal.close();
    }
    assertEquals(JSON.parse(originalPlannerResults[0]), observation);
    const page = JSON.parse(originalPlannerResults[1]);
    assertEquals(page.observations[0].id, observation.id);
    assertEquals(page.observations[0].receipt, undefined);
    assertEquals(JSON.parse(originalPlannerResults[2]).observations, []);
    assertEquals(transportCalls, 1);
    assertEquals(
      readAdaptiveSentinel(path, state)?.modelReviewStates.find(({ taskId }) =>
        taskId === source.id
      )?.status,
      "running",
    );
    planner.stop();
    releaseSource.resolve();
    await waitFor(() => !planner.hasInFlightWork());
    assert(stopSentinelAssessment(path));
    const ref = {
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      runId: state.plan.runId,
    };
    const archiveId = crypto.randomUUID();
    await withOperator(baseDir, async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt?.status,
        "succeeded",
      );
    }, true);
    const archiveDir = join(baseDir, "data", "run-archives", archiveId);
    for await (const entry of Deno.readDir(archiveDir)) {
      if (!entry.isFile) continue;
      const bytes = await Deno.readFile(join(archiveDir, entry.name));
      assert(!new TextDecoder().decode(bytes).includes("fixture-token"));
    }
    await Deno.rename(dirname(path), join(baseDir, "stopped-fixture"));
    await withOperator(
      baseDir,
      async (turn) => {
        assertEquals(
          JSON.parse(
            await turn({
              ...ref,
              action: "restore",
              archiveId,
              requestId: crypto.randomUUID(),
            }),
          ).receipt?.status,
          "succeeded",
        );
        const restored = readSentinelAssessment(path);
        assert(restored?.paused);
        assertEquals(restored.plan.runId, state.plan.runId);
        assertEquals(
          JSON.parse(await turn(approvalRead)).dependencyApproval,
          expectedApproval,
        );
        assertEquals(
          JSON.parse(await turn(affectedApprovalRead)).dependencyApproval,
          expectedApproval,
        );
        const plannerRead = {
          action: "planner_reads",
          kind: ref.kind,
          id: caseId,
          revision: state.revision,
          plannerIdentity,
          attempt: 1,
          ordinal: 1,
          includeResult: true,
        };
        assertEquals(
          JSON.stringify(JSON.parse(await turn(plannerRead)).result),
          originalPlannerResults[0],
        );
        assert((await turn(plannerRead, "source")).includes("unavailable"));
        for (const ordinal of [2, 3]) {
          const read = { ...plannerRead, ordinal };
          assertEquals(
            JSON.stringify(JSON.parse(await turn(read)).result),
            originalPlannerResults[ordinal - 1],
          );
          assert((await turn(read, "source")).includes("unavailable"));
        }
        metadataAllowed = false;
        assert((await turn(plannerRead)).includes("unavailable"));
        metadataAllowed = true;
        assertEquals(transportCalls, 1);
        assertEquals(JSON.parse(await turn(trace)).result, expectedPublication);
        assertEquals(JSON.parse(await turn(peerTrace)).result, observation);
        assertEquals(JSON.parse(await turn(peerPage)).result, expectedPeerPage);
        const exact = {
          action: "intermediate_observations",
          kind: ref.kind,
          id: caseId,
          revision: state.revision,
          observationId: observation.id,
        };
        assertEquals(
          JSON.parse(await turn(exact)).page.observation,
          observation,
        );
        metadataAllowed = false;
        assertStringIncludes(await turn(exact), "unavailable");
        metadataAllowed = true;
        assert(
          !readAdaptiveSentinel(path, restored)?.modelReviews.some((
            { taskId },
          ) => taskId === source.id),
        );
      },
      true,
      reader,
    );
    await withOperator(
      baseDir,
      async (turn) => {
        const current = {
          kind: "sentinel",
          id: caseId,
          revision: state.revision,
        };
        const listed = JSON.parse(
          await turn({
            ...current,
            action: "list_trace_workers",
            query: source.id,
          }),
        ).page;
        assertEquals(listed.workers.length, 1);
        assertEquals(listed.workers[0].taskId, source.id);
        assertEquals(listed.workers[0].status, "interrupted");
        assertEquals(listed.workers[0].archived, true);
        const progress = JSON.parse(
          await turn({
            ...trace,
            action: "worker_trace_progress",
          }),
        );
        assertEquals(progress.archived, true);
        assertEquals(progress.page.steps, [{
          index: 1,
          target: observation.id,
          tool: "sentinel_publish_workflow_observation",
          outcome: "returned",
        }]);
        const finished = JSON.parse(
          await turn({
            ...current,
            action: "traces",
            taskId: peer.id,
            stepIndices: [peerStep],
          }),
        ).page;
        assertEquals(finished.totalSteps, 1);
        assertEquals(finished.steps[0].taskId, peer.id);
        assertEquals(JSON.parse(await turn(peerTrace)).result, observation);
        const metadataBeforeDenial = metadataChecks;
        assertStringIncludes(
          await turn(peerTrace, "source-pre"),
          "unavailable",
        );
        assertEquals(metadataChecks, metadataBeforeDenial);
        assertStringIncludes(await turn(peerTrace, "source"), "unavailable");
        assertEquals(
          await turn(peerTrace, true),
          "Tool response withheld by policy.",
        );
        metadataAllowed = false;
        assertStringIncludes(await turn(peerTrace), "unavailable");
        metadataAllowed = true;
        assertStringIncludes(
          await turn({ ...peerTrace, revision: ref.revision + 1 }),
          "unavailable",
        );
        assertStringIncludes(
          await turn({ ...peerTrace, id: "another-case" }),
          "unavailable",
        );
        assertStringIncludes(
          await turn({
            ...peerTrace,
            action: "attach_native_workflow_control",
          }),
          "unavailable",
        );
        assertEquals(JSON.parse(await turn(peerTrace)).result, observation);
      },
      false,
      reader,
      true,
    );
    assertEquals(transportCalls, 1);
    const fixture = fromFileUrl(
      new URL(
        "./fixtures/intermediate_workflow_export_process.ts",
        import.meta.url,
      ),
    );
    const reloaded = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", fixture, baseDir, String(state.revision), caseId],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(reloaded.success, new TextDecoder().decode(reloaded.stderr));
    const frame = JSON.parse(new TextDecoder().decode(reloaded.stdout));
    const graph = JSON.parse(frame.content).provenance;
    const saved = graph.nodes.find((node: { sourceId?: string }) =>
      node.sourceId === received
    );
    assert(saved);
    assert(
      graph.edges.some((
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from.endsWith(peer.id) && to === saved.id && relation === "references"
      ),
    );
    assert(graph.edges.some(
      (
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from.endsWith(followUpId) && to === saved.id &&
        relation === "references",
    ));
    const gateNode = graph.nodes.find((node: { sourceId?: string }) =>
      node.sourceId === gate.id
    );
    assertEquals(gateNode?.factSatisfaction, gate.factSatisfaction);
    const futureNode = graph.nodes.find((node: { sourceId?: string }) =>
      node.sourceId === futureGateId
    );
    const heldNode = graph.nodes.find((node: { sourceId?: string }) =>
      node.sourceId === heldImpact.id
    );
    assertEquals(
      heldNode?.plannerRound?.committedObservation,
      updatedImpact.plannerRound?.committedObservation,
    );
    const retainedDependency = graph.nodes.find((node: { sourceId?: string }) =>
      node.sourceId === dependentWorkflowGate.id
    );
    assert(graph.edges.some(
      (
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from === heldNode.id && to === retainedDependency.id &&
        relation === "requires",
    ));

    assert(graph.edges.some(
      (
        { from, to, relation }: { from: string; to: string; relation: string },
      ) => from === heldNode.id && to === saved.id && relation === "references",
    ));

    assertEquals(futureNode?.factSatisfaction, futureProof);
    assert(graph.edges.some(
      (
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from === futureNode.id && to === saved.id && relation === "references",
    ));
    assert(
      graph.edges.some((
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from === gateNode.id && to === saved.id && relation === "references"
      ),
    );
    assert(
      graph.edges.some((
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from.endsWith(followUpId) && to === gateNode.id &&
        relation === "requires"
      ),
    );

    planner.stop();
    await waitFor(() => !planner.hasInFlightWork());
    assert(resumeSentinelAssessment(path, undefined, state.revision));
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "delivery", kind: "asset", label: "Revised pipeline" }],
        edges: [],
      }),
    );
    const revised = refreshSentinelAssessment(path);
    assert(revised && revised.revision > state.revision);
    advanceAdaptiveSentinel(path, revised);
    let staleResult: string | undefined;
    const staleRegistry = createProviderRegistry();
    staleRegistry.register({
      name: "stale-workflow-gate",
      supportsStreaming: false,
      complete(messages) {
        const prior = messages.findLast(({ role }) => role === "tool");
        if (!prior) {
          return Promise.resolve(
            call("sentinel_intermediate_workflow_observation", {
              id: observation.id,
            }),
          );
        }
        staleResult = String(prior.content);
        return Promise.resolve({
          content: JSON.stringify([{
            kind: "trace",
            depth: 1,
            nodeId: "delivery",
            committedObservationId: observation.id,
            requiredWorkflowOutcome: "failure",
          }, {
            kind: "trace",
            depth: 1,
            nodeId: "delivery",
            futureWorkflowOutcome: selector,
          }]),
          usage,
          toolCalls: [],
        });
      },
    });
    staleRegistry.setDefault("stale-workflow-gate");
    const stalePlanner = createSentinelModelPlanner(
      path,
      (current, taskId) =>
        taskId
          ? { execute: () => Promise.resolve(), clear() {} }
          : createSentinelSubagent({
            snapshotPath: path,
            assessmentRevision: current.revision,
            plannerExecutionEvidenceRunId: current.plan.runId,
            providerRegistry: staleRegistry,
            hookRunner,
            readRetainedWorkflow: reader,
            futureWorkflowScopes: scopes,
            allowModelAccess: true,
          }),
      undefined,
      () => planningClock,
    );
    const restarted = startSentinelAssessmentCoordinator({
      snapshotPath: path,
      advanceAdaptive: (current) => stalePlanner.advance(current),
    });
    try {
      stalePlanner.advance(revised);
      const revisedGate = () =>
        readAdaptiveSentinel(path, revised)?.tasks.find(
          ({ plannerRound }) => plannerRound?.futureWorkflowOutcome,
        );
      await waitFor(() => revisedGate()?.status === "queued");
      assert(staleResult?.includes("unavailable"));
      const revisedView = readAdaptiveSentinel(path, revised)!;
      assert(
        !revisedView.tasks.some(({ plannerRound }) =>
          plannerRound?.requiredWorkflowOutcome !== undefined
        ),
      );
      assert(
        revisedView.modelPlannerHistory.every(({ inputManifest }) =>
          !inputManifest?.committedObservationIds?.includes(observation.id)
        ),
      );
      notifyCommittedEvidence(wake);
      notifyCommittedEvidence({ ...wake, revision: revised.revision });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      assertEquals(revisedGate()?.attempts, 0);
      assertEquals(revisedGate()?.factSatisfaction, undefined);
      assertEquals(revisedGate()?.status, "queued");
    } finally {
      restarted.stop();
      stalePlanner.stop();
      await waitFor(() => !stalePlanner.hasInFlightWork());
    }
    assertEquals(transportCalls, 1);
  } finally {
    coordinator?.stop();
    planner.stop();
    allowPublication.resolve();
    allowPeerRead.resolve();
    published.resolve();
    releaseSource.resolve();
    await waitFor(() => !planner.hasInFlightWork());
    await Deno.remove(baseDir, { recursive: true });
  }
});

async function verifyScheduledObservationGoal(
  baseDir: string,
  observation: Pick<
    SentinelScheduledObservationRead,
    "case" | "run_id" | "revision" | "observation_id"
  >,
  authorize: NonNullable<Parameters<typeof createScheduledObservationRead>[2]>,
  setRepositoryAccess: (allowed: boolean) => void,
  recovery?: {
    keychain: SecretStore;
    fetchMetadata: typeof fetch;
    kind?: "cron" | "trigger" | "webhook";
  },
) {
  const kind = recovery?.kind ?? "cron";
  const scope = recovery
    ? `recovered-${kind}-observation-proof`
    : "observation-proof";
  const webhookBody = '{"review":"verify-observation"}';
  const webhookSecret = "managed-observation-fixture";
  const paused = Promise.withResolvers<string>();
  const cronManager = createCronManager();
  const registered = cronManager.create({
    expression: "* * * * *",
    task: "Verify the granted observation.",
    classificationCeiling: "INTERNAL",
  });
  assert(registered.ok);
  const job = registered.value;
  const sourceId = kind === "cron"
    ? job.id
    : kind === "trigger"
    ? "trigger"
    : "managed-grant";
  const grant: SentinelScheduledObservationRead = kind === "cron"
    ? { ...observation, cron_job_id: sourceId }
    : kind === "trigger"
    ? { ...observation, trigger: true }
    : { ...observation, webhook_source_id: sourceId };
  const expected = await createScheduledObservationRead(
    baseDir,
    grant,
    authorize,
  )({});
  assert(expected.startsWith("{"));
  const source = `scheduler:${kind}:${sourceId}`;
  const config = {
    sentinel: { scheduled_observation_reads: [grant] },
    ...(recovery && {
      agent_recovery: {
        scheduler: true,
        github_repositories: ["owner/pipeline"],
      },
    }),
    scheduler: {
      trigger: {
        enabled: kind === "trigger",
        classification_ceiling: "INTERNAL",
      },
      webhooks: {
        enabled: kind === "webhook",
        sources: {
          "managed-grant": {
            secret: webhookSecret,
            classification: "INTERNAL",
          },
        },
      },
      goal_completion: [{
        scope,
        goal: "Verify the authorized retained observation.",
        policy: "operator",
        criteria: [{
          id: "observation",
          description: "Use the original committed observation.",
          kind,
          source_id: sourceId,
          tool: scheduledObservationTool.name,
          result_sha256: await computeContentHash(expected),
        }],
      }],
    },
  } satisfies Pick<
    TriggerFishConfig,
    "sentinel" | "scheduler" | "agent_recovery"
  >;
  const storagePath = join(baseDir, `managed-${scope}.db`);
  const triggerPath = join(baseDir, `managed-${scope}-trigger.md`);
  await Deno.writeTextFile(
    triggerPath,
    "Verify the granted workflow observation.",
  );
  let storage = createSqliteStorage(storagePath);
  const owner = createSession({
    channelId: "owner" as ChannelId,
    userId: "owner" as UserId,
  });
  let calls = 0;
  let allowSource = true;
  let disconnected = false;
  const reportRequest = {
    scope,
    criterion: "observation",
    sourceCallId: "1:0",
    requestId: crypto.randomUUID(),
  };
  const ownerHooks: HookRunner = {
    evaluateHook(hook, context) {
      const denied = hook === "PRE_TOOL_CALL" &&
        context.input.tool_name === scheduledObservationTool.name &&
        !allowSource;
      return Promise.resolve({
        allowed: !denied,
        action: denied ? "BLOCK" : "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const withGateway = async <T>(
    run: (
      request: (command: string) => Promise<string>,
      startSource: () => Promise<void>,
      resumeSource: (id: string) => Promise<number>,
    ) => Promise<T>,
  ) => {
    const messages = createMessageStore(storage);
    const resolver = buildManagedScheduledObservationGrant(
      config,
      baseDir,
      cronManager,
      authorize,
    );
    assert(resolver);
    const goals = buildSchedulerGoalCompletion(
      config,
      baseDir,
      messages,
      resolver,
    );
    assert(goals);
    const schedulerService = createSchedulerService({
      cronManager,
      goalCompletion: goals,
      ...(recovery && {
        executionTracePath: join(baseDir, "execution-traces.db"),
        ...buildSchedulerRecoveryBindings(
          config,
          baseDir,
          recovery.keychain,
          recovery.fetchMetadata,
        ),
      }),
      triggerMdPath: triggerPath,
      trigger: {
        enabled: false,
        intervalMinutes: 1,
        classificationCeiling: "INTERNAL",
      },
      webhooks: {
        enabled: kind === "webhook",
        sources: {
          "managed-grant": {
            secret: webhookSecret,
            classification: "INTERNAL",
          },
        },
      },
      orchestratorFactory: {
        create(channelId, options) {
          const execution = options?.scheduledGoalRecovery;
          assertEquals(
            execution?.sourceId ?? options?.scheduledGoalSource?.sourceId,
            sourceId,
          );
          const bound = selectAgentObservationRead(config.sentinel, options);
          assertEquals(bound, grant);
          const sessionOptions = {
            channelId: channelId as ChannelId,
            userId: "owner" as UserId,
          };
          const session = options?.recoverySessionId
            ? restoreSession({
              ...sessionOptions,
              id: options.recoverySessionId,
            })
            : createSession(sessionOptions);
          const providerRegistry = createProviderRegistry();
          providerRegistry.register({
            name: "ordinary-cron-observation-fixture",
            supportsStreaming: false,
            complete(history) {
              const responses = history.filter(({ role }) => role === "tool");
              if (responses.length) {
                assertEquals(responses[0].content, expected);
              }
              if (execution && responses.length === 1 && !disconnected) {
                disconnected = true;
                const store = new AgentRecoveryStore(
                  join(baseDir, "agent-recovery.db"),
                );
                try {
                  assert(
                    store.pause(
                      assignmentRecoveryKey(session.id, execution.id),
                    ),
                  );
                  paused.resolve(execution.id);
                } finally {
                  store.close();
                }
                throw new Error(
                  "Interrupted the cron worker after its observation committed.",
                );
              }
              if (execution && responses.length === 2) {
                assertEquals(
                  JSON.parse(String(responses[1].content)).verified,
                  true,
                );
              }
              const call = !responses.length
                ? { name: scheduledObservationTool.name, arguments: "{}" }
                : execution && responses.length === 1
                ? {
                  name: scheduledGoalReportTool.name,
                  arguments: JSON.stringify(reportRequest),
                }
                : undefined;
              return Promise.resolve({
                content: call ? "" : "Exact observation verified.",
                usage: { inputTokens: 1, outputTokens: 1 },
                toolCalls: call
                  ? [{
                    id: crypto.randomUUID(),
                    type: "function",
                    function: call,
                  }]
                  : [],
              });
            },
          });
          providerRegistry.setDefault("ordinary-cron-observation-fixture");
          const reader = createScheduledObservationRead(
            baseDir,
            grant,
            authorize,
          );
          const orchestration: OrchestratorConfig = {
            hookRunner: ownerHooks,
            providerRegistry,
            tools: [
              scheduledObservationTool,
              ...(execution ? [scheduledGoalReportTool] : []),
            ],
            messageStore: messages,
            getSessionTaint: () => "INTERNAL",
            getNonOwnerCeiling: () => "INTERNAL",
            isTriggerSession: () => true,
            managedTranscriptIdentity: {
              source,
              channelId: session.channelId,
              createdAt: session.createdAt.toISOString(),
              ceiling: "INTERNAL",
              isTrigger: true,
              observationGrantDigest: managedObservationGrantDigest(bound!),
            },
            toolExecutor(name, args) {
              if (execution && name === scheduledGoalReportTool.name) {
                return goals.reportRecovered(
                  args,
                  execution,
                  session.id,
                  createSavedSourceAuthorization(orchestration, session),
                );
              }
              calls++;
              return reader(args);
            },
          } satisfies OrchestratorConfig;
          return Promise.resolve({
            orchestrator: createOrchestrator(orchestration),
            session,
            getSessionTaint: () => "INTERNAL",
            toolExecutor: () => Promise.resolve('{"found":false}'),
          });
        },
      },
    });
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      schedulerService,
      chatSession: createChatSession({
        session: owner,
        providerRegistry: createProviderRegistry(),
        messageStore: messages,
        goalCompletionPath: join(baseDir, "goal-completion.db"),
        getSessionTaint: () => "INTERNAL",
        targetClassification: "INTERNAL",
        hookRunner: ownerHooks,
        runManagedGoalCommand: goals.runCommand,
      }),
    });
    const { port } = await gateway.start();
    const request = (command: string) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/chat?token=${token}`,
      );
      const response = Promise.withResolvers<string>();
      const timer = setTimeout(
        () => response.reject(new Error("No managed goal response")),
        3000,
      );
      socket.onopen = () =>
        socket.send(JSON.stringify({ type: "message", content: command }));
      socket.onmessage = ({ data }) => {
        const event = JSON.parse(data);
        if (event.type === "response") response.resolve(event.text);
        if (event.type === "error") response.reject(new Error(event.message));
      };
      return response.promise.finally(() => {
        clearTimeout(timer);
        socket.close();
      });
    };
    try {
      return await run(request, async () => {
        if (kind === "cron") {
          schedulerService.start();
          return;
        }
        if (kind === "trigger") {
          const result = await fetch(
            `http://127.0.0.1:${port}/debug/run-triggers`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
            },
          );
          assertEquals(result.status, 200);
          await result.body?.cancel();
          return;
        }
        const timestamp = String(Date.now());
        const signature = await computeTimestampedHmac(
          timestamp,
          webhookBody,
          webhookSecret,
        );
        const result = await fetch(
          `http://127.0.0.1:${port}/webhooks/${sourceId}`,
          {
            method: "POST",
            body: webhookBody,
            headers: { "x-timestamp": timestamp, "x-signature": signature },
          },
        );
        assertEquals(result.status, 200);
        await result.body?.cancel();
      }, async (id) => {
        const path = kind === "webhook"
          ? `/recovery/webhooks/${id}?resume_paused=true`
          : `/recovery/scheduled/${id}`;
        const result = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          ...(kind === "webhook" && { body: webhookBody }),
        });
        await result.body?.cancel();
        return result.status;
      });
    } finally {
      schedulerService.stop();
      await gateway.stop();
    }
  };

  const status = `/goal scheduler status ${scope}`;
  try {
    let pending = await withGateway(
      async (request, startSource) => {
        await startSource();
        const deadline = Date.now() + 3000;
        while (
          kind === "cron" && !cronManager.history(job.id).length &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const record = JSON.parse(await request(status));
        if (recovery) {
          assertEquals(record.status, "open");
          return undefined;
        }
        assertEquals(record.status, "awaiting_confirmation");
        assertEquals(record.satisfied, ["observation"]);
        assertEquals(record.observations[0].evidence[0].source, source);
        return record;
      },
    );
    await storage.close();
    storage = createSqliteStorage(storagePath);
    await withGateway(async (request, _startSource, resumeSource) => {
      if (recovery) {
        const { promise, reject } = paused;
        const timeout = setTimeout(
          () => reject(new Error("No paused observation run")),
          3000,
        );
        let id;
        try {
          id = await promise;
        } finally {
          clearTimeout(timeout);
        }
        setRepositoryAccess(false);
        assertEquals(await resumeSource(id), 409);
        assertEquals(calls, 1);
        setRepositoryAccess(true);
        assertEquals(await resumeSource(id), 200);
        pending = JSON.parse(await request(status));
        assertEquals(pending.status, "awaiting_confirmation");
        assertStringIncludes(
          pending.observations[0].evidence[0].reference,
          `${id}:1:0:`,
        );
        assertEquals(
          pending.observations[0].evidence[0].source,
          `scheduler-observation:${kind}:${sourceId}`,
        );
        const recoveryStore = new AgentRecoveryStore(
          join(baseDir, "agent-recovery.db"),
        );
        try {
          const retired = recoveryStore.read(
            assignmentRecoveryKey(recoverySessionId(id), id),
          );
          assertEquals(retired?.status, "finished");
          assert(!Object.hasOwn(retired!, "checkpoint"));
          assert(!JSON.stringify(pending).includes(observation.observation_id));
          assert(!JSON.stringify(pending).includes("owner/pipeline"));
        } finally {
          recoveryStore.close();
        }
      }
      assert(pending);
      const confirm =
        `/goal scheduler confirm ${scope} ${pending.confirmation.decisionSha256}`;
      assertEquals(JSON.parse(await request(status)), pending);
      allowSource = false;
      const denied = JSON.parse(await request(status));
      assertEquals(denied.inaccessible, ["observation"]);
      assertEquals(denied.observations, pending.observations);
      await assertRejects(
        () => request(confirm),
        Error,
        "evidence could not be reverified",
      );
      allowSource = true;
      setRepositoryAccess(false);
      assertEquals(JSON.parse(await request(status)).inaccessible, [
        "observation",
      ]);
      await assertRejects(
        () => request(confirm),
        Error,
        "evidence could not be reverified",
      );
      setRepositoryAccess(true);
      config.sentinel.scheduled_observation_reads.length = 0;
      assertEquals(JSON.parse(await request(status)).inaccessible, [
        "observation",
      ]);
      await assertRejects(
        () => request(confirm),
        Error,
        "evidence could not be reverified",
      );
      config.sentinel.scheduled_observation_reads.push(grant);
      if (kind !== "cron") {
        const sourceSettings = kind === "trigger"
          ? config.scheduler.trigger
          : config.scheduler.webhooks;
        sourceSettings.enabled = false;
        assertEquals(JSON.parse(await request(status)).inaccessible, [
          "observation",
        ]);
        await assertRejects(
          () => request(confirm),
          Error,
          "evidence could not be reverified",
        );
        sourceSettings.enabled = true;
      }
      assertEquals(JSON.parse(await request(status)), pending);
      const completed = JSON.parse(await request(confirm));
      assertEquals(completed.status, "completed");
      assertEquals(completed.observations, pending.observations);
    });
    assertEquals(calls, 1);
  } finally {
    await storage.close();
  }
}

async function verifyScheduledObservationSources(
  baseDir: string,
  observation: Pick<
    SentinelScheduledObservationRead,
    "case" | "run_id" | "revision" | "observation_id"
  >,
  expectedObservation: { readonly id: string },
) {
  const grants = [
    { ...observation, trigger: true },
    { ...observation, webhook_source_id: "granted" },
    { ...observation, webhook_source_id: "public" },
  ] as const;
  assertEquals(
    selectSentinelScheduledObservationRead([...grants, grants[0]], {
      kind: "trigger",
      sourceId: "trigger",
    }),
    undefined,
  );
  const parent = createSession({
    channelId: "owner" as ChannelId,
    userId: "owner" as UserId,
    bumpersEnabled: false,
  });
  const childId = crypto.randomUUID();
  const delegatedGrant = {
    ...observation,
    parent_session_id: parent.id,
    execution_id: childId,
  };
  assertEquals(
    selectSentinelDelegatedObservationRead([delegatedGrant], {
      parentSessionId: crypto.randomUUID(),
      executionId: childId,
    }),
    undefined,
  );
  assertEquals(
    selectSentinelDelegatedObservationRead(
      [delegatedGrant, delegatedGrant],
      { parentSessionId: parent.id, executionId: childId },
    ),
    undefined,
  );
  const deliveryId = crypto.randomUUID();
  const preDeniedDelivery = crypto.randomUUID();
  const postDeniedDelivery = crypto.randomUUID();
  const teamGrants: SentinelTeamObservationRead[] = [];
  const runtimeConfig = {
    sentinel: {
      scheduled_observation_reads: grants,
      delegated_observation_reads: [delegatedGrant],
      team_observation_reads: teamGrants,
    },
    agent_recovery: {
      github_repositories: ["owner/pipeline"],
      team: true,
      background_checklists: false,
    },
    delegated_goal_completion: [] as DelegatedGoalConfig[],
    models: {
      primary: { provider: "ollama", model: "scoped-observation-fixture" },
      providers: {},
    },
  };
  const triggerMdPath = join(baseDir, "TRIGGER.md");
  const recoveryPath = join(baseDir, "agent-recovery.db");
  const keychain = createMemorySecretStore();
  assert(
    (await keychain.setSecret("github-pat", "fixture-current-credential")).ok,
  );
  let allowed = true;
  const fetchMetadata: typeof fetch = (request) => {
    const url = new URL(String(request));
    assertEquals(url.origin, "https://api.github.com");
    if (url.pathname === "/repos/owner/pipeline") {
      return Promise.resolve(Response.json({
        id: 420,
        full_name: "owner/pipeline",
        visibility: "public",
      }));
    }
    assertEquals(url.pathname, "/repos/owner/pipeline/actions/workflows/17");
    return Promise.resolve(new Response("", { status: allowed ? 200 : 403 }));
  };
  const authorize = buildExecutionTracePayloadAuthorizer(
    runtimeConfig,
    keychain,
    fetchMetadata,
  );
  assert(authorize);
  await verifyScheduledObservationGoal(
    baseDir,
    observation,
    authorize,
    (accessible) => {
      allowed = accessible;
    },
  );
  await verifyScheduledObservationGoal(
    baseDir,
    observation,
    authorize,
    (accessible) => {
      allowed = accessible;
    },
    { keychain, fetchMetadata },
  );
  for (const kind of ["trigger", "webhook"] as const) {
    await verifyScheduledObservationGoal(
      baseDir,
      observation,
      authorize,
      (accessible) => {
        allowed = accessible;
      },
      { keychain, fetchMetadata, kind },
    );
  }
  const toolName = scheduledObservationTool.name;
  const expected = await createScheduledObservationRead(
    baseDir,
    delegatedGrant,
    authorize,
  )({});
  assert(expected.startsWith("{"));
  const projectionDigest = await computeContentHash(expected);
  for (const kind of ["subagent", "team"] as const) {
    runtimeConfig.delegated_goal_completion.push({
      scope: `observation-${kind}`,
      goal: "Verify a granted case observation.",
      policy: "operator",
      criteria: [{
        id: "observation",
        description: "Read the exact observation granted to this execution.",
        kind,
        tool: toolName,
        result_sha256: projectionDigest,
      }],
    });
  }
  const reportRequests = {
    subagent: {
      scope: "observation-subagent",
      criterion: "observation",
      sourceCallId: "1:0",
      requestId: crypto.randomUUID(),
    },
    team: {
      scope: "observation-team",
      criterion: "observation",
      sourceCallId: "1:0",
      requestId: crypto.randomUUID(),
    },
  };
  let denyHook:
    | "PRE_TOOL_CALL"
    | "POST_TOOL_RESPONSE"
    | "PRE_OUTPUT"
    | undefined;
  let interrupt = true;
  const actualReads = new Map<string, number>();
  const modelReads = new Map<string, number>();
  const sourceTools = new Map<string, boolean>();
  const secret = "scheduled-observation-hmac-fixture";
  const orchestratorFactory: OrchestratorFactory = {
    create(channelId, options) {
      assert(options?.recoverySessionId);
      const source = options.teamObservation?.source.deliveryId ??
        options.delegatedObservationSource?.executionId ??
        options.scheduledObservationSource?.sourceId ??
        (options.delegatedKind === "team" ? "ordinary-team" : undefined);
      assert(source);
      let session = restoreSession({
        id: options.recoverySessionId,
        userId: "scheduler-fixture" as UserId,
        channelId: channelId as ChannelId,
      });
      if (options.recoverySessionTaint !== undefined) {
        session = updateTaint(
          session,
          options.recoverySessionTaint,
          "Fixture team scope",
        );
      }
      const scoped = selectAgentObservationRead(
        runtimeConfig.sentinel,
        options,
      );
      const read = scoped &&
        createScheduledObservationRead(
          baseDir,
          scoped,
          authorize,
          options.teamObservation?.authorizeScope,
        );
      sourceTools.set(source, !!read);
      const reportKind =
        (source === childId && options.executionChecklistRunId &&
            options.delegatedObservationSource)
          ? "subagent" as const
          : source === deliveryId && options.executionChecklistRunId &&
              options.teamGoalRecovery
          ? "team" as const
          : undefined;
      const registry = createProviderRegistry();
      registry.register({
        name: "scheduled-commit-fixture",
        supportsStreaming: false,
        complete(messages, tools) {
          assertEquals(
            tools?.some((tool) =>
              (tool as { function?: { name: string } }).function?.name ===
                toolName
            ) ?? false,
            !!read,
          );
          const last = messages.findLast(({ role }) => role === "tool");
          const text = String(last?.content ?? "");
          if (
            reportKind &&
            messages.filter(({ role }) => role === "tool").length > 1
          ) {
            assertEquals(JSON.parse(text).verified, true);
            return Promise.resolve({
              content: "Scheduled observation turn complete.",
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: [],
            });
          }
          if (text.startsWith("{")) {
            const receipt = JSON.parse(text);
            assertEquals(receipt.caseId, observation.case);
            assertEquals(receipt.runId, observation.run_id);
            assertEquals(receipt.observation, expectedObservation);
            modelReads.set(
              source,
              (modelReads.get(source) ?? 0) + 1,
            );
            if (
              (source === "granted" || source === childId ||
                source === deliveryId) && interrupt
            ) {
              throw new Error(
                "Interrupted after committing the approved receipt",
              );
            }
          }
          if (reportKind && last && text.startsWith("{") && !denyHook) {
            return Promise.resolve({
              content: "",
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: [{
                type: "function",
                id: "report-observation-proof",
                function: {
                  name: delegatedGoalReportTool.name,
                  arguments: JSON.stringify(reportRequests[reportKind]),
                },
              }],
            });
          }
          const complete = !!last || !read;
          return Promise.resolve({
            content: complete ? "Scheduled observation turn complete." : "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: complete ? [] : [{
              type: "function",
              id: toolName,
              function: { name: toolName, arguments: "{}" },
            }],
          });
        },
      });
      registry.setDefault("scheduled-commit-fixture");
      const toolExecutor = (
        name: string,
        args: Record<string, unknown>,
      ): Promise<string> => {
        if (name === "memory_get") return Promise.resolve('{"found":false}');
        if (name === "memory_save") return Promise.resolve("Saved.");
        if (reportKind && name === delegatedGoalReportTool.name) {
          return delegatedGoals!.reportRecovered(
            args,
            options.executionChecklistRunId!,
            session.id,
            reportKind === "team"
              ? { kind: "team", ...options.teamGoalRecovery! }
              : { kind: "subagent", parentSessionId: parent.id },
            createSavedSourceAuthorization(orchestration, session),
          );
        }
        assertEquals(name, toolName);
        assert(read);
        actualReads.set(
          source,
          (actualReads.get(source) ?? 0) + 1,
        );
        return read(args);
      };
      const orchestration: OrchestratorConfig = {
        providerRegistry: registry,
        enableStreaming: false,
        getSessionTaint: () => options.ceiling ?? "PUBLIC",
        tools: read
          ? [
            scheduledObservationTool,
            ...(reportKind ? [delegatedGoalReportTool] : []),
          ]
          : [],
        toolExecutor,
        hookRunner: {
          evaluateHook(hook, context) {
            const blocked = hook === denyHook &&
              (hook === "PRE_OUTPUT"
                ? source === childId || source === deliveryId
                : context.input.tool_name === toolName);
            return Promise.resolve({
              allowed: !blocked,
              action: blocked ? "BLOCK" : "ALLOW",
              ruleId: null,
              duration: 0,
            });
          },
        },
      };
      return Promise.resolve({
        session,
        toolExecutor,
        getSessionTaint: () =>
          options.delegatedKind === "team"
            ? session.taint
            : options.ceiling ?? "PUBLIC",
        orchestrator: createOrchestrator(orchestration),
      });
    },
  };
  const scheduler = createSchedulerService({
    triggerMdPath,
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: "INTERNAL",
    },
    triggerAdmissions: openSchedulerTriggerAdmissions(
      join(baseDir, "scheduler-trigger-admissions.db"),
    ),
    webhooks: {
      enabled: true,
      sources: {
        granted: { secret, classification: "INTERNAL" },
        foreign: { secret, classification: "INTERNAL" },
        public: { secret, classification: "PUBLIC" },
      },
    },
    webhookAdmissions: openSchedulerWebhookAdmissions(
      join(baseDir, "scheduler-webhook-admissions.db"),
    ),
    executionTracePath: join(baseDir, "execution-traces.db"),
    recoveryState: (id) => schedulerRecoveryState(recoveryPath, id),
    recoverTurn(execution, orchestrator, options) {
      const recover = buildWorkflowRecoveryExecutor(
        runtimeConfig,
        baseDir,
        keychain,
        undefined,
        execution,
        false,
        { githubFetch: fetchMetadata },
      );
      assert(recover);
      return recover(execution.id, orchestrator, options, {
        resumeOnly: execution.resumeOnly,
        resumePaused: execution.resumePaused,
      });
    },
    orchestratorFactory,
  });
  const teamStorage = createMemoryStorage();
  const goalMessages = createMessageStore(teamStorage);
  const delegatedGoals = buildDelegatedGoalCompletion(
    baseDir,
    runtimeConfig.delegated_goal_completion,
    goalMessages,
    buildManagedDelegatedObservationGrant(
      runtimeConfig,
      baseDir,
      teamStorage,
      authorize,
    ),
  );
  assert(delegatedGoals);
  const defaultRecovery = buildWorkflowRecoveryExecutor(
    runtimeConfig,
    baseDir,
    keychain,
  );
  assert(defaultRecovery);
  const profileBinding = await computeContentHash(JSON.stringify([
    runtimeConfig.models.primary.provider,
    runtimeConfig.models.primary.model,
  ]));
  const makeTeamManager = () =>
    buildTeamManager({
      storage: teamStorage,
      orchestratorFactory,
      callerSessionId: parent.id,
      sessionManager: {
        get: (id: SessionId) =>
          Promise.resolve(id === parent.id ? parent : null),
      } as unknown as EnhancedSessionManager,
      recovery: {
        path: join(baseDir, "team-recovery.db"),
        profileBinding: profileBinding,
        observationGoalProof: true,
        run: defaultRecovery,
        observationGrant: (source) =>
          selectSentinelTeamObservationRead(teamGrants, source),
        bindObservationRun: (source, authorizeObservationScope) =>
          buildWorkflowRecoveryExecutor(
            runtimeConfig,
            baseDir,
            keychain,
            undefined,
            source,
            false,
            {
              githubFetch: fetchMetadata,
              authorizeObservationScope,
              checklistRole: "team",
            },
          ),
      },
    });
  let teamManager = makeTeamManager();
  const created = await teamManager.createTeam({
    name: "Evidence review",
    task: "Review a scoped defensive observation.",
    members: [{
      role: "reviewer",
      description: "Review a pipeline observation.",
      isLead: true,
      classificationCeiling: "INTERNAL",
    }],
  }, parent.id);
  assert(created.ok);
  const teamId = created.value.id;
  teamManager.stopLifecycleMonitor(teamId);
  const memberId = created.value.members[0].sessionId;
  for (const id of [deliveryId, preDeniedDelivery, postDeniedDelivery]) {
    teamGrants.push({
      ...observation,
      owner_session_id: parent.id,
      team_id: teamId,
      member_session_id: memberId,
      delivery_id: id,
    });
  }
  assertEquals(
    selectSentinelTeamObservationRead(teamGrants, {
      ownerSessionId: parent.id,
      teamId,
      memberSessionId: crypto.randomUUID(),
      deliveryId,
    }),
    undefined,
  );
  const token = crypto.randomUUID();
  let inspectProofs = false;
  const createOwnerChat = (session = parent) =>
    createChatSession({
      session,
      targetClassification: "INTERNAL",
      getSessionTaint: () => inspectProofs ? "INTERNAL" : session.taint,
      providerRegistry: createProviderRegistry(),
      hookRunner: {
        evaluateHook: () =>
          Promise.resolve({
            allowed: true,
            action: "ALLOW",
            ruleId: null,
            duration: 0,
          }),
      },
      runTeamRecoveryCommand: teamManager.runRecoveryCommand,
      runManagedGoalCommand: delegatedGoals.runCommand,
      goalCompletionPath: join(baseDir, "goal-completion.db"),
      messageStore: goalMessages,
      runSubagentRecoveryCommand: buildOwnerSubagentRecoveryCommand(
        buildSubagentFactory(orchestratorFactory, {
          executionTracePath: join(baseDir, "execution-traces.db"),
        }),
        buildWorkflowRecoveryExecutor(runtimeConfig, baseDir, keychain),
        (source) =>
          selectSentinelDelegatedObservationRead([delegatedGrant], source)
            ? buildWorkflowRecoveryExecutor(
              runtimeConfig,
              baseDir,
              keychain,
              undefined,
              source,
              false,
              { githubFetch: fetchMetadata, checklistRole: "delegated" },
            )
            : undefined,
      ),
    });
  let gateway = createGatewayServer({
    port: 0,
    token,
    schedulerService: scheduler,
    chatSession: createOwnerChat(),
  });
  try {
    await Deno.writeTextFile(
      triggerMdPath,
      "Read the exact authorized Sentinel observation.",
    );
    const { port } = await gateway.start();
    denyHook = "PRE_TOOL_CALL";
    await scheduler.runTrigger();
    assertEquals(actualReads.get("trigger"), undefined);
    denyHook = "POST_TOOL_RESPONSE";
    await scheduler.runTrigger();
    assertEquals(actualReads.get("trigger"), 1);
    assertEquals(modelReads.get("trigger"), undefined);
    denyHook = undefined;
    await scheduler.runTrigger();
    assertEquals(actualReads.get("trigger"), 2);
    assertEquals(modelReads.get("trigger"), 1);
    const signed = async (source: string, secret: string) => {
      const timestamp = String(Date.now());
      const body = `{"event":"check","fixture":"${source}"}`;
      const signature = await computeTimestampedHmac(timestamp, body, secret);
      const response = await fetch(
        `http://127.0.0.1:${port}/webhooks/${source}`,
        {
          method: "POST",
          headers: { "x-timestamp": timestamp, "x-signature": signature },
          body,
        },
      );
      return { status: response.status, result: await response.json(), body };
    };
    assertEquals(
      (await signed("granted", "wrong fixture signature")).status,
      401,
    );
    assertEquals(actualReads.get("granted"), undefined);
    assertEquals((await signed("foreign", secret)).status, 200);
    assertEquals((await signed("public", secret)).status, 200);
    assertEquals(sourceTools.get("foreign"), false);
    assertEquals(sourceTools.get("public"), false);
    assert(!actualReads.has("foreign") && !actualReads.has("public"));
    const webhook = await signed("granted", secret);
    assertEquals(webhook.status, 200);
    const { executionId } = webhook.result;
    assert(/^scheduler-webhook-[a-f0-9]{64}$/.test(executionId));
    assertEquals(actualReads.get("granted"), 1);
    assertEquals(modelReads.get("granted"), 1);
    interrupt = false;
    const resume = () =>
      fetch(`http://127.0.0.1:${port}/recovery/webhooks/${executionId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: webhook.body,
      });
    allowed = false;
    const refused = await resume();
    assertEquals(refused.status, 409);
    await refused.body?.cancel();
    assertEquals(actualReads.get("granted"), 1);
    assertEquals(modelReads.get("granted"), 1);
    allowed = true;
    const resumed = await resume();
    assertEquals(resumed.status, 200);
    await resumed.body?.cancel();
    assertEquals(actualReads.get("granted"), 1);
    assertEquals(modelReads.get("granted"), 2);

    const connect = async (port: number) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/chat?token=${token}`,
      );
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      return socket;
    };
    let socket = await connect(port);
    try {
      const send = async (content: string) => {
        const done = Promise.withResolvers<string>();
        const timer = setTimeout(
          () => done.reject(new Error("Delegated observation turn timed out")),
          3000,
        );
        const receive = ({ data }: MessageEvent) => {
          const frame = JSON.parse(data);
          if (frame.type === "response") done.resolve(frame.text);
          if (frame.type === "error") done.reject(new Error(frame.message));
        };
        socket.addEventListener("message", receive);
        socket.send(JSON.stringify({
          type: "message",
          content,
        }));
        try {
          return await done.promise;
        } finally {
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
        }
      };
      const child = (id: string) =>
        send(
          `/recover-subagent ${id} Read the assigned case observation.`,
        );
      const deliver = (
        id: string,
        member: string = memberId,
        request = "Read the assigned case observation.",
      ) => send(`/recover-team ${id} ${teamId} ${member} ${request}`);
      assertEquals(
        await deliver(crypto.randomUUID()),
        "Team delivery completed.",
      );
      assertEquals(sourceTools.get("ordinary-team"), false);
      assertEquals(
        await deliver(deliveryId, crypto.randomUUID()),
        "The team member is not available in the trusted recovery scope.",
      );
      denyHook = "PRE_TOOL_CALL";
      await deliver(preDeniedDelivery);
      assertEquals(actualReads.get(preDeniedDelivery), undefined);
      denyHook = "POST_TOOL_RESPONSE";
      await deliver(postDeniedDelivery);
      assertEquals(actualReads.get(postDeniedDelivery), 1);
      assertEquals(modelReads.get(postDeniedDelivery), undefined);
      denyHook = undefined;
      interrupt = true;
      assert((await deliver(deliveryId)) !== "Team delivery completed.");
      assertEquals(actualReads.get(deliveryId), 1);
      assertEquals(modelReads.get(deliveryId), 1);
      interrupt = false;
      const unrelated = crypto.randomUUID();
      assertEquals(
        await child(unrelated),
        "Scheduled observation turn complete.",
      );
      assertEquals(sourceTools.get(unrelated), false);
      assert(!actualReads.has(unrelated));
      interrupt = true;
      assertEquals(await child(childId), "Durable subagent execution failed.");
      assertEquals(actualReads.get(childId), 1);
      assertEquals(modelReads.get(childId), 1);
      interrupt = false;
      socket.close();
      await gateway.stop();
      teamManager = makeTeamManager();
      gateway = createGatewayServer({
        port: 0,
        token,
        chatSession: createOwnerChat(restoreSession({
          id: parent.id,
          channelId: parent.channelId,
          userId: parent.userId,
          bumpersEnabled: false,
        })),
      });
      socket = await connect((await gateway.start()).port);

      assertEquals(
        await deliver(deliveryId, memberId, "A different request."),
        "The trusted team delivery scope or request changed.",
      );
      const [removedGrant] = teamGrants.splice(0, 1);
      assertEquals(
        await deliver(deliveryId),
        "The trusted team delivery scope or request changed.",
      );
      teamGrants.unshift(removedGrant);
      allowed = false;
      assert((await deliver(deliveryId)) !== "Team delivery completed.");
      allowed = true;
      denyHook = "PRE_TOOL_CALL";
      assert((await deliver(deliveryId)) !== "Team delivery completed.");
      denyHook = "POST_TOOL_RESPONSE";
      assert((await deliver(deliveryId)) !== "Team delivery completed.");
      assertEquals(actualReads.get(deliveryId), 1);
      assertEquals(modelReads.get(deliveryId), 1);
      denyHook = "PRE_OUTPUT";
      assert((await deliver(deliveryId)) !== "Team delivery completed.");
      assertEquals(modelReads.get(deliveryId), 2);
      denyHook = undefined;
      assertEquals(await deliver(deliveryId), "Team delivery completed.");
      assertEquals(actualReads.get(deliveryId), 1);
      assertEquals(modelReads.get(deliveryId), 3);
      assertEquals(
        await deliver(deliveryId),
        "This execution already finished.",
      );
      assertEquals(actualReads.get(deliveryId), 1);
      assertEquals(modelReads.get(deliveryId), 3);

      allowed = false;
      assert((await child(childId)).startsWith("Sub-agent error:"));
      assertEquals(actualReads.get(childId), 1);
      assertEquals(modelReads.get(childId), 1);
      allowed = true;
      denyHook = "PRE_TOOL_CALL";
      assert((await child(childId)).startsWith("Sub-agent error:"));
      assertEquals(actualReads.get(childId), 1);
      assertEquals(modelReads.get(childId), 1);
      denyHook = "POST_TOOL_RESPONSE";
      assert((await child(childId)).startsWith("Sub-agent error:"));
      assertEquals(actualReads.get(childId), 1);
      assertEquals(modelReads.get(childId), 1);
      denyHook = "PRE_OUTPUT";
      assert((await child(childId)).startsWith("Sub-agent error:"));
      assertEquals(actualReads.get(childId), 1);
      assertEquals(modelReads.get(childId), 2);
      denyHook = undefined;
      assertEquals(
        await child(childId),
        "Scheduled observation turn complete.",
      );
      assertEquals(actualReads.get(childId), 1);
      assertEquals(modelReads.get(childId), 3);
      inspectProofs = true;
      for (const kind of ["team", "subagent"] as const) {
        const status = () => send(`/goal delegated status observation-${kind}`);
        const pending = JSON.parse(await status());
        assertEquals(pending.status, "awaiting_confirmation");
        assertEquals(pending.satisfied, ["observation"]);
        assertEquals(
          pending.observations[0].evidence[0].source,
          `delegated-observation:${kind}`,
        );
        assertStringIncludes(
          pending.observations[0].evidence[0].reference,
          ":1:0:",
        );
        assert(!JSON.stringify(pending).includes(observation.observation_id));
        const confirm = () =>
          send(
            `/goal delegated confirm observation-${kind} ${pending.confirmation.decisionSha256}`,
          );
        const assertInaccessible = async () => {
          const denied = JSON.parse(await status());
          assertEquals(denied.inaccessible, ["observation"]);
          assertEquals(denied.observations, pending.observations);
          await assertRejects(
            confirm,
            Error,
            "evidence could not be reverified",
          );
        };
        allowed = false;
        await assertInaccessible();
        allowed = true;
        if (kind === "team") {
          const membershipKey = `${TEAM_STORAGE_PREFIX}${teamId}`;
          const saved = await teamStorage.get(membershipKey);
          assert(saved);
          await teamStorage.set(
            membershipKey,
            JSON.stringify({ ...JSON.parse(saved), status: "disbanded" }),
          );
          await assertInaccessible();
          await teamStorage.set(membershipKey, saved);
        } else {
          const [saved] = runtimeConfig.sentinel.delegated_observation_reads
            .splice(0, 1);
          await assertInaccessible();
          runtimeConfig.sentinel.delegated_observation_reads.push(saved);
        }
        assertEquals(JSON.parse(await status()), pending);
        const completed = JSON.parse(await confirm());
        assertEquals(completed.status, "completed");
        assertEquals(completed.observations, pending.observations);
      }
      assertEquals(actualReads.get(childId), 1);
      assertEquals(actualReads.get(deliveryId), 1);
    } finally {
      socket.close();
    }
  } finally {
    scheduler.stop();
    await gateway.stop();
    await teamStorage.close();
  }
}
