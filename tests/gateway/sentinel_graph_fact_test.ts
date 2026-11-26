import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";
import {
  buildDelegatedGoalCompletion,
  delegatedGoalReportTool,
} from "../../src/gateway/startup/factory/delegated_goal_completion.ts";
import { buildManagedDelegatedObservationGrant } from "../../src/gateway/startup/factory/managed_delegated_observation_grant.ts";
import { createSavedSourceAuthorization } from "../../src/agent/dispatch/saved_source_authorization.ts";
import type { OrchestratorConfig } from "../../src/agent/orchestrator/orchestrator_config.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createCronManager } from "../../src/scheduler/cron/cron.ts";
import {
  buildSchedulerGoalCompletion,
  scheduledGoalReportTool,
} from "../../src/gateway/startup/factory/scheduler_goal_completion.ts";
import { buildManagedScheduledObservationGrant } from "../../src/gateway/startup/factory/managed_scheduled_observation_grant.ts";
import { createHash } from "node:crypto";
import type { AgentTurnCheckpoint } from "../../src/core/types/orchestrator.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  restoreSession,
  type SessionId,
  updateTaint,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorWorkflowRuns } from "../../src/gateway/operator_workflow_runs.ts";
import {
  createScheduledObservationRead,
  createWorkflowObservationVerifier,
  scheduledObservationTool,
  selectAgentObservationRead,
} from "../../src/gateway/scheduled_observation_tool.ts";
import {
  selectSentinelDelegatedObservationRead,
  selectSentinelTeamObservationRead,
  type SentinelScheduledObservationRead,
  type SentinelTeamObservationRead,
} from "../../src/core/config_types.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { EnhancedSessionManager } from "../../src/gateway/sessions.ts";
import { buildTeamManager } from "../../src/gateway/startup/factory/team_executor.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/mod.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { buildOwnerSubagentRecoveryCommand } from "../../src/gateway/startup/factory/owner_subagent_recovery.ts";
import { buildWorkflowRecoveryExecutor } from "../../src/gateway/startup/factory/agent_recovery.ts";
import { buildSchedulerRecoveryBindings } from "../../src/gateway/startup/factory/scheduler_recovery.ts";
import {
  computeTimestampedHmac,
  createSchedulerService,
} from "../../src/scheduler/mod.ts";
import { schedulerExecutionIdentity } from "../../src/scheduler/service_execution.ts";

import { createWorkflowRunRegistry } from "../../src/workflow/registry.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readHistoricalAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  createSentinelSubagent,
  type SentinelReadTrace,
} from "../../src/gateway/sentinel_agent.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
  validateSentinelPlanSuggestions,
} from "../../src/sentinel/adaptive_planner.ts";
import {
  ensureSentinelFormalGoalContract,
  readSentinelGoalCompletionAtRevision,
  registerSentinelGoalCompletion,
} from "../../src/gateway/sentinel_goal_completion.ts";
import { type SentinelFormalGoal } from "../../src/sentinel/formal_goals.ts";
import {
  openSentinelAdaptiveStore,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";
import {
  readSentinelAssessment,
  recordSentinelOperatingConstraints,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { digestSentinelSnapshot } from "../../src/sentinel/shared_inventory.ts";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../../src/sentinel/cases.ts";
import { listSentinelPlannerGraphFacts } from "../../src/sentinel/worker_graph_facts.ts";
import type {
  SentinelWorkerFindingRecheckRecord,
  SentinelWorkerFindingRecord,
} from "../../src/sentinel/worker_finding_store.ts";

const assigned = "sentinel_assigned_target";
const publish = "sentinel_publish_graph_fact";
const read = "sentinel_graph_facts";
const propose = "sentinel_propose_goal";
const observation = "sentinel_worker_observation";
const prove = "sentinel_prove_goal";
const call = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  args,
});

async function ownerFacts(
  baseDir: string,
  run: (
    query: (input: Record<string, unknown>) => Promise<string>,
  ) => Promise<void>,
  approve: boolean | (() => boolean) = false,
  denyPublicationRead?: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE",
  workflows?: ReturnType<typeof createOperatorWorkflowRuns>,
  sentinelMode = false,
  authorizeCompletion?: () => boolean,
) {
  const registry = createProviderRegistry();
  let result = "";
  let input: Record<string, unknown>;
  registry.register({
    name: "owner-fact-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      const last = messages.at(-1);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (last?.role === "tool") {
        result = String(last.content);
        return Promise.resolve({
          usage,
          content: "The fact lookup finished.",
          toolCalls: [],
        });
      }
      if (input.action === "append_goals") {
        const definition = tools?.map((item) =>
          (item as { function?: { name: string; parameters: unknown } })
            .function
        ).find((item) => item?.name === "operator_runs");
        const schema = JSON.stringify(definition?.parameters);
        assertStringIncludes(schema, '"graph_fact"');
        assertStringIncludes(schema, '"finding_recheck"');
      }
      return Promise.resolve({
        usage,
        content: "",
        toolCalls: [{
          id: crypto.randomUUID(),
          type: "function",
          function: {
            name: "operator_runs",
            arguments: JSON.stringify({
              action: "facts",
              kind: "sentinel",
              ...input,
            }),
          },
        }],
      });
    },
  });
  registry.setDefault("owner-fact-fixture");
  const chatSession = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "daemon" as ChannelId,
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
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir,
      workflows,
      confirm: () =>
        Promise.resolve(typeof approve === "function" ? approve() : approve),
    }),
    hookRunner: {
      evaluateHook(hook, { input }) {
        const toolCall = input.tool_call as {
          name?: string;
          args?: Record<string, unknown>;
        } | undefined;
        const completionAllowed = hook !== "PRE_TOOL_CALL" ||
          toolCall?.name !== "operator_runs" ||
          toolCall.args?.action !== "confirm_goal_completion" ||
          authorizeCompletion?.() !== false;
        const publicationAllowed = hook !== denyPublicationRead ||
          ![publish, propose, prove, read, observation].includes(
            String(input.tool_name),
          );
        const allowed = completionAllowed && publicationAllowed;
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          ruleId: null,
          duration: 0,
        });
      },
    },
    enableStreaming: false,
  });
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ port: 0, token, chatSession });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = async (content: string) => {
      result = "";
      const ended = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => ended.reject(new Error("Missing gateway turn end")),
        2000,
      );
      const receive = ({ data }: MessageEvent) => {
        if (JSON.parse(data).type === "turn_end") ended.resolve();
      };
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({
          type: "message",
          content,
        }),
      );
      try {
        await ended.promise;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    };
    if (sentinelMode) await turn("/sentinel on");
    await run(async (args) => {
      input = args;
      await turn("Read the requested exact graph fact or finding.");
      assert(result);
      return result;
    });
  } finally {
    if (socket.readyState < WebSocket.CLOSING) {
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve(), { once: true })
      );
      socket.close();
      await closed;
    }
    await gateway.stop();
  }
}

async function verifyDelegatedObservationGrant(
  baseDir: string,
  grant: {
    case: string;
    run_id: string;
    revision: number;
    observation_id: string;
  },
  verify: (projection: Record<string, unknown>) => void,
  revoke: () => void,
  restore: () => void,
) {
  const parent = createSession({
    userId: "owner" as UserId,
    channelId: "owner" as ChannelId,
  });
  const id = crypto.randomUUID();
  const grants = [{ ...grant, parent_session_id: parent.id, execution_id: id }];
  const teamGrants: SentinelTeamObservationRead[] = [];
  const expected = await createScheduledObservationRead(
    baseDir,
    grant,
    undefined,
  )({});
  assert(expected.startsWith("{"));
  const digest = await computeContentHash(expected);
  const prefix = `local-delegated-${
    (await computeContentHash(grant.observation_id)).slice(0, 12)
  }`;
  const kinds = ["team", "subagent"] as const;
  const config = {
    agent_recovery: { team: true },
    models: {
      primary: { provider: "ollama", model: "local-observation" },
      providers: {},
    },
    delegated_goal_completion: kinds.map((kind) => ({
      scope: `${prefix}-${kind}`,
      goal: "Verify the exact granted local observation.",
      policy: "operator" as const,
      criteria: [{
        id: "observation",
        description: "Read the configured case evidence.",
        kind,
        tool: scheduledObservationTool.name,
        result_sha256: digest,
      }],
    })),
    sentinel: {
      delegated_observation_reads: grants,
      team_observation_reads: teamGrants,
    },
  };
  const secrets = createMemorySecretStore();
  let interrupt = true;
  let dispatches = 0;
  let delivered = 0;
  let inspectProofs = false;
  const requests = new Map(kinds.map((kind) => [kind, {
    scope: `${prefix}-${kind}`,
    criterion: "observation",
    sourceCallId: "1:0",
    requestId: crypto.randomUUID(),
  }]));
  const factory: OrchestratorFactory = {
    create(channelId, options) {
      assert(options?.recoverySessionId);
      let session = restoreSession({
        id: options.recoverySessionId,
        userId: parent.userId,
        channelId: channelId as ChannelId,
      });
      if (options.recoverySessionTaint) {
        session = updateTaint(
          session,
          options.recoverySessionTaint,
          "Fixture team delivery",
        );
      }
      const selected = selectAgentObservationRead(config.sentinel, options);
      const read = selected &&
        createScheduledObservationRead(
          baseDir,
          selected,
          undefined,
          options.teamObservation?.authorizeScope,
        );
      const kind = options.delegatedKind;
      const report = kind && requests.get(kind);
      const registry = createProviderRegistry();
      registry.register({
        name: "delegated-fact-fixture",
        supportsStreaming: false,
        complete(messages) {
          const responses = messages.filter(({ role }) => role === "tool");
          const text = String(responses.at(-1)?.content ?? "");
          if (responses.length === 1 && text.startsWith("{")) {
            verify(JSON.parse(text));
            delivered++;
            if (interrupt) {
              throw new Error("Interrupted after the committed fact.");
            }
            if (report) {
              return Promise.resolve({
                content: "",
                usage: { inputTokens: 1, outputTokens: 1 },
                toolCalls: [{
                  id: "report-fact",
                  type: "function",
                  function: {
                    name: delegatedGoalReportTool.name,
                    arguments: JSON.stringify(report),
                  },
                }],
              });
            }
          }
          if (report && responses.length === 2) {
            assertEquals(JSON.parse(text).verified, true);
          }
          return Promise.resolve({
            content: text || !read ? "Fact review complete." : "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: text || !read ? [] : [{
              id: "exact-fact",
              type: "function",
              function: {
                name: scheduledObservationTool.name,
                arguments: "{}",
              },
            }],
          });
        },
      });
      registry.setDefault("delegated-fact-fixture");
      const toolExecutor = (
        name: string,
        args: Record<string, unknown>,
      ): Promise<string> => {
        if (
          report && options.executionChecklistRunId &&
          name === delegatedGoalReportTool.name
        ) {
          return goals!.reportRecovered(
            args,
            options.executionChecklistRunId,
            session.id,
            kind === "team"
              ? { kind, ...options.teamGoalRecovery! }
              : { kind: "subagent", parentSessionId: parent.id },
            createSavedSourceAuthorization(orchestration, session),
          );
        }
        assertEquals(name, scheduledObservationTool.name);
        assert(read);
        dispatches++;
        return read(args);
      };
      const orchestration: OrchestratorConfig = {
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
        tools: read
          ? [
            scheduledObservationTool,
            ...(report ? [delegatedGoalReportTool] : []),
          ]
          : [],
        toolExecutor,
        getSessionTaint: () => "INTERNAL",
      };
      return Promise.resolve({
        session,
        toolExecutor,
        getSessionTaint: () =>
          options.delegatedKind === "team" ? session.taint : "INTERNAL",
        orchestrator: createOrchestrator(orchestration),
      });
    },
  };
  const teamStorage = createMemoryStorage();
  const goalMessages = createMessageStore(teamStorage);
  const goals = buildDelegatedGoalCompletion(
    baseDir,
    config.delegated_goal_completion,
    goalMessages,
    buildManagedDelegatedObservationGrant(
      config,
      baseDir,
      teamStorage,
      undefined,
    ),
  );
  assert(goals);
  const profileBinding = await computeContentHash(JSON.stringify([
    config.models.primary.provider,
    config.models.primary.model,
  ]));
  const makeManager = () =>
    buildTeamManager({
      storage: teamStorage,
      orchestratorFactory: factory,
      callerSessionId: parent.id,
      sessionManager: {
        get: (sessionId: SessionId) =>
          Promise.resolve(sessionId === parent.id ? parent : null),
      } as unknown as EnhancedSessionManager,
      recovery: {
        path: join(baseDir, "team-recovery.db"),
        profileBinding,
        observationGoalProof: true,
        observationGrant: (source) =>
          selectSentinelTeamObservationRead(teamGrants, source),
        bindObservationRun: (source, authorizeObservationScope) =>
          buildWorkflowRecoveryExecutor(
            config,
            baseDir,
            secrets,
            undefined,
            source,
            false,
            { authorizeObservationScope, checklistRole: "team" },
          ),
      },
    });
  let manager = makeManager();
  const team = await manager.createTeam({
    name: "Graph evidence reviewers",
    task: "Review the authorized case fact.",
    members: [{
      role: "reviewer",
      description: "Read the exact relationship.",
      isLead: true,
      classificationCeiling: "INTERNAL",
    }],
  }, parent.id);
  assert(team.ok);
  manager.stopLifecycleMonitor(team.value.id);
  const deliveryId = crypto.randomUUID();
  const member = team.value.members[0].sessionId;
  teamGrants.push({
    ...grant,
    owner_session_id: parent.id,
    team_id: team.value.id,
    member_session_id: member,
    delivery_id: deliveryId,
  });
  const teamCommand =
    `/recover-team ${deliveryId} ${team.value.id} ${member} Read the committed case fact.`;
  const childCommand = (executionId: string) =>
    `/recover-subagent ${executionId} Read the committed case fact.`;
  const token = crypto.randomUUID();
  const start = async () => {
    const chatSession = createChatSession({
      session: parent,
      targetClassification: "INTERNAL",
      getSessionTaint: () => inspectProofs ? "INTERNAL" : parent.taint,
      goalCompletionPath: join(baseDir, "goal-completion.db"),
      messageStore: goalMessages,
      runManagedGoalCommand: goals.runCommand,
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
      runTeamRecoveryCommand: manager.runRecoveryCommand,
      runSubagentRecoveryCommand: buildOwnerSubagentRecoveryCommand(
        buildSubagentFactory(factory, {
          executionTracePath: join(baseDir, "execution-traces.db"),
        }),
        undefined,
        (source) =>
          selectSentinelDelegatedObservationRead(grants, source)
            ? buildWorkflowRecoveryExecutor(
              config,
              baseDir,
              secrets,
              undefined,
              source,
              false,
              { checklistRole: "delegated" },
            )
            : undefined,
      ),
    });
    const gateway = createGatewayServer({ port: 0, token, chatSession });
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return {
      async turn(content: string) {
        const result = Promise.withResolvers<string>();
        const timer = setTimeout(
          () => result.reject(new Error("No gateway response")),
          3000,
        );
        const receive = ({ data }: MessageEvent) => {
          const frame = JSON.parse(data);
          if (frame.type === "response") result.resolve(frame.text);
          if (frame.type === "error") result.reject(new Error(frame.message));
        };
        socket.addEventListener("message", receive);
        socket.send(JSON.stringify({
          type: "message",
          content,
        }));
        try {
          return await result.promise;
        } finally {
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
        }
      },
      async stop() {
        if (socket.readyState < WebSocket.CLOSING) {
          const closed = new Promise<void>((resolve) =>
            socket.addEventListener("close", () => resolve(), { once: true })
          );
          socket.close();
          await closed;
        }
        await gateway.stop();
      },
    };
  };
  let gateway = await start();
  try {
    assertEquals(
      await gateway.turn(childCommand(crypto.randomUUID())),
      "Durable subagent execution is unavailable.",
    );
    assertEquals(
      await gateway.turn(childCommand(id)),
      "Durable subagent execution failed.",
    );
    assert((await gateway.turn(teamCommand)) !== "Team delivery completed.");
    assertEquals([dispatches, delivered], [2, 2]);
    interrupt = false;
    revoke();
    await gateway.stop();
    manager = makeManager();
    gateway = await start();
    assert(
      (await gateway.turn(childCommand(id))).startsWith("Sub-agent error:"),
    );
    assert((await gateway.turn(teamCommand)) !== "Team delivery completed.");
    assertEquals([dispatches, delivered], [2, 2]);
    restore();
    assertEquals(await gateway.turn(childCommand(id)), "Fact review complete.");
    assertEquals(await gateway.turn(teamCommand), "Team delivery completed.");
    assertEquals([dispatches, delivered], [2, 4]);
    inspectProofs = true;
    for (const kind of kinds) {
      const scope = `${prefix}-${kind}`;
      const status = () => gateway.turn(`/goal delegated status ${scope}`);
      const pending = JSON.parse(await status());
      assertEquals(pending.status, "awaiting_confirmation");
      assertEquals(pending.satisfied, ["observation"]);
      assertEquals(
        pending.observations[0].evidence[0].source,
        `delegated-observation:${kind}`,
      );
      assert(!JSON.stringify(pending).includes(grant.observation_id));
      const confirm = () =>
        gateway.turn(
          `/goal delegated confirm ${scope} ${pending.confirmation.decisionSha256}`,
        );
      revoke();
      const denied = JSON.parse(await status());
      assertEquals(denied.inaccessible, ["observation"]);
      assertEquals(denied.observations, pending.observations);
      await assertRejects(confirm, Error, "evidence could not be reverified");
      restore();
      assertEquals(JSON.parse(await confirm()).status, "completed");
    }
    assertEquals([dispatches, delivered], [2, 4]);
  } finally {
    await gateway.stop();
    await teamStorage.close();
  }
}

async function verifyScheduledObservationGrant(
  baseDir: string,
  grant: Pick<
    SentinelScheduledObservationRead,
    "case" | "run_id" | "revision" | "observation_id"
  >,
  verify: (projection: Record<string, unknown>) => void,
  kind: "webhook" | "cron" | "trigger" = "webhook",
) {
  const cronManager = createCronManager();
  const job = kind === "cron"
    ? cronManager.create({
      expression: "* * * * *",
      task: "Review the granted local observation.",
      classificationCeiling: "INTERNAL",
    })
    : undefined;
  assert(job === undefined || job.ok);
  const sourceId = job?.ok
    ? job.value.id
    : kind === "trigger"
    ? "trigger"
    : "scoped";
  const scoped: SentinelScheduledObservationRead = kind === "cron"
    ? { ...grant, cron_job_id: sourceId }
    : kind === "trigger"
    ? { ...grant, trigger: true }
    : { ...grant, webhook_source_id: sourceId };
  const grants: SentinelScheduledObservationRead[] = [scoped];
  const expected = await createScheduledObservationRead(
    baseDir,
    scoped,
    undefined,
  )({});
  assert(expected.startsWith("{"));
  const scope = `local-proof-${kind}-${
    (await computeContentHash(grant.observation_id)).slice(0, 12)
  }`;
  const webhookSecret = "scheduler-fact-fixture-secret";
  const config = {
    agent_recovery: { scheduler: true },
    sentinel: { scheduled_observation_reads: grants },
    scheduler: {
      trigger: {
        enabled: kind === "trigger",
        classification_ceiling: "INTERNAL",
      },
      webhooks: {
        enabled: true,
        sources: {
          scoped: { secret: webhookSecret, classification: "INTERNAL" },
        },
      },
      goal_completion: [{
        scope,
        goal: "Verify the granted local observation.",
        policy: "operator" as const,
        criteria: [{
          id: "observation",
          description: "Read exact current case evidence.",
          kind,
          source_id: sourceId,
          tool: scheduledObservationTool.name,
          result_sha256: await computeContentHash(expected),
        }],
      }],
    },
  };
  const token = crypto.randomUUID();
  let storage = createMemoryStorage();
  const toolName = scheduledObservationTool.name;
  const sources: string[] = [];
  let calls = 0;
  let deliveries = 0;
  let interrupt = true;
  const paused = Promise.withResolvers<string>();
  let denySource = false;
  const owner = createSession({
    userId: "owner" as UserId,
    channelId: "owner" as ChannelId,
  });
  const reportRequest = {
    scope,
    criterion: "observation",
    sourceCallId: "1:0",
    requestId: crypto.randomUUID(),
  };
  let goals: NonNullable<ReturnType<typeof buildSchedulerGoalCompletion>>;
  const hookRunner: HookRunner = {
    evaluateHook(hook, context) {
      const denied = denySource && hook === "PRE_TOOL_CALL" &&
        context.input.tool_name === toolName;
      return Promise.resolve({
        allowed: !denied,
        action: denied ? "BLOCK" : "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const factory: OrchestratorFactory = {
    create(channelId, options) {
      const sessionOptions = {
        channelId: channelId as ChannelId,
        userId: "scheduler" as UserId,
      };
      const session = options?.recoverySessionId
        ? restoreSession({ ...sessionOptions, id: options.recoverySessionId })
        : createSession(sessionOptions);
      const exact = selectAgentObservationRead(config.sentinel, options);
      assertEquals(
        !!exact,
        options?.scheduledObservationSource?.sourceId === sourceId,
      );
      const read = exact &&
        createScheduledObservationRead(baseDir, exact, undefined);
      const execution = options?.scheduledGoalRecovery;
      const providers = createProviderRegistry();
      providers.register({
        name: "scheduled-fact-fixture",
        supportsStreaming: false,
        complete(messages) {
          if (!read) sources.push(channelId);
          const responses = messages.filter(({ role }) => role === "tool");
          const result = String(responses.at(-1)?.content ?? "");
          if (responses.length === 1 && result.startsWith("{")) {
            verify(JSON.parse(result));
            deliveries++;
            if (interrupt) {
              if (execution && kind !== "webhook") {
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
              }
              throw new Error("Interrupted after committed local observation");
            }
            if (execution) {
              return Promise.resolve({
                content: "",
                usage: { inputTokens: 1, outputTokens: 1 },
                toolCalls: [{
                  id: "report-fact",
                  type: "function",
                  function: {
                    name: scheduledGoalReportTool.name,
                    arguments: JSON.stringify(reportRequest),
                  },
                }],
              });
            }
          }
          if (execution && responses.length === 2) {
            assertEquals(JSON.parse(result).verified, true);
          }
          return Promise.resolve({
            content: result || !read ? "Review finished." : "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: result || !read ? [] : [{
              id: "read-fact",
              type: "function",
              function: { name: toolName, arguments: "{}" },
            }],
          });
        },
      });
      providers.setDefault("scheduled-fact-fixture");
      const toolExecutor = (
        name: string,
        args: Record<string, unknown>,
      ): Promise<string> => {
        if (execution && name === scheduledGoalReportTool.name) {
          return goals.reportRecovered(
            args,
            execution,
            session.id,
            createSavedSourceAuthorization(orchestration, session),
          );
        }
        if (name === "memory_get") return Promise.resolve('{"found":false}');
        if (name === "memory_save") return Promise.resolve("Saved.");
        assertEquals(name, toolName);
        assert(read);
        calls++;
        return read(args);
      };
      const orchestration: OrchestratorConfig = {
        providerRegistry: providers,
        hookRunner,
        tools: read
          ? [
            scheduledObservationTool,
            ...(execution ? [scheduledGoalReportTool] : []),
          ]
          : [],
        toolExecutor,
        getSessionTaint: () => options?.ceiling ?? "PUBLIC",
      };
      return Promise.resolve({
        session,
        toolExecutor,
        getSessionTaint: () => options?.ceiling ?? "PUBLIC",
        orchestrator: createOrchestrator(orchestration),
      });
    },
  };
  const secrets = createMemorySecretStore();
  const triggerMdPath = join(baseDir, "TRIGGER.md");
  await Deno.writeTextFile(triggerMdPath, "Review defensive evidence.");
  const start = async () => {
    const bindings = buildSchedulerRecoveryBindings(config, baseDir, secrets);
    const messages = createMessageStore(storage);
    goals = buildSchedulerGoalCompletion(
      config,
      baseDir,
      messages,
      buildManagedScheduledObservationGrant(
        config,
        baseDir,
        cronManager,
        undefined,
      ),
    )!;
    assert(goals);
    const scheduler = createSchedulerService({
      ...bindings,
      cronManager,
      executionTracePath: join(baseDir, "execution-traces.db"),
      goalCompletion: goals,
      orchestratorFactory: factory,
      triggerMdPath,
      trigger: {
        enabled: false,
        intervalMinutes: 30,
        classificationCeiling: "INTERNAL",
      },
      webhooks: {
        enabled: true,
        replayStorage: storage,
        sources: {
          scoped: { secret: webhookSecret, classification: "INTERNAL" },
          ordinary: { secret: webhookSecret, classification: "INTERNAL" },
        },
      },
    });
    const gateway = createGatewayServer({
      port: 0,
      token,
      schedulerService: scheduler,
      chatSession: createChatSession({
        session: owner,
        providerRegistry: createProviderRegistry(),
        hookRunner,
        messageStore: messages,
        targetClassification: "INTERNAL",
        getSessionTaint: () => "INTERNAL",
        runManagedGoalCommand: goals.runCommand,
        goalCompletionPath: join(baseDir, "goal-completion.db"),
      }),
    });
    const { port } = await gateway.start();
    const turn = (command: string) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/chat?token=${token}`,
      );
      const result = Promise.withResolvers<string>();
      const timer = setTimeout(
        () => result.reject(new Error("Local goal command timed out")),
        3000,
      );
      socket.onopen = () =>
        socket.send(JSON.stringify({ type: "message", content: command }));
      socket.onmessage = ({ data }) => {
        const event = JSON.parse(data);
        if (event.type === "response") result.resolve(event.text);
        if (event.type === "error") result.reject(new Error(event.message));
      };
      return result.promise.finally(() => {
        clearTimeout(timer);
        socket.close();
      });
    };
    return {
      turn,
      scheduler,
      port,
      async stop() {
        scheduler.stop();
        await gateway.stop();
      },
    };
  };
  let gateway = await start();
  try {
    const body = '{"event":"graph.review"}';
    const timestamp = String(Date.now());
    const signature = await computeTimestampedHmac(
      timestamp,
      body,
      webhookSecret,
    );
    const deliver = async (source: string, text: string, hmac: string) => {
      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/webhooks/${source}`,
        {
          method: "POST",
          headers: { "x-timestamp": timestamp, "x-signature": hmac },
          body: text,
        },
      );
      return { status: response.status, data: await response.json() };
    };
    let executionId: string;
    if (kind === "webhook") {
      const ordinaryBody = '{"event":"regular.review"}';
      const ordinarySig = await computeTimestampedHmac(
        timestamp,
        ordinaryBody,
        webhookSecret,
      );
      const ordinary = await deliver("ordinary", ordinaryBody, ordinarySig);
      assertEquals(ordinary.status, 200);
      assertEquals(ordinary.data.executionId, undefined);
      await gateway.scheduler.runTrigger();
      assertEquals(sources, ["webhook-ordinary", "trigger"]);
      assertEquals(calls, 0);
      const sent = await deliver(sourceId, body, signature);
      assertEquals(sent.status, 200);
      executionId = sent.data.executionId;
      assertEquals(
        executionId,
        schedulerExecutionIdentity("webhook", sourceId, signature).id,
      );
    } else {
      if (kind === "trigger") {
        const response = await fetch(
          `http://127.0.0.1:${gateway.port}/debug/run-triggers`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          },
        );
        assertEquals(response.status, 200);
        await response.body?.cancel();
      } else {
        gateway.scheduler.start();
      }
      const timer = setTimeout(
        () => paused.reject(new Error("Missing local proof checkpoint")),
        3000,
      );
      try {
        executionId = await paused.promise;
      } finally {
        clearTimeout(timer);
      }
      assert(executionId.startsWith(`scheduler-${kind}-`));
    }
    assertEquals([calls, deliveries], [1, 1]);
    if (kind === "webhook") {
      assertEquals((await deliver(sourceId, body, signature)).status, 409);
    }
    await gateway.stop();
    interrupt = false;
    grants.pop();
    await storage.close();
    storage = createMemoryStorage();
    gateway = await start();
    if (kind === "webhook") {
      assertEquals((await deliver(sourceId, body, signature)).status, 409);
    }
    const resume = async () => {
      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/recovery/${
          kind === "webhook" ? "webhooks" : "scheduled"
        }/${executionId}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          ...(kind === "webhook" && { body }),
        },
      );
      await response.body?.cancel();
      return response.status;
    };
    assertEquals(await resume(), 409);
    assertEquals([calls, deliveries], [1, 1]);
    grants.push(scoped);
    await gateway.stop();
    gateway = await start();
    assertEquals(await resume(), 200);
    assertEquals([calls, deliveries], [1, 2]);
    const status = `/goal scheduler status ${scope}`;
    const pending = JSON.parse(await gateway.turn(status));
    assertEquals(pending.status, "awaiting_confirmation");
    assertEquals(pending.satisfied, ["observation"]);
    assertStringIncludes(
      pending.observations[0].evidence[0].reference,
      `${executionId}:1:0:`,
    );
    assert(!JSON.stringify(pending).includes(grant.observation_id));
    const confirm = () =>
      gateway.turn(
        `/goal scheduler confirm ${scope} ${pending.confirmation.decisionSha256}`,
      );
    denySource = true;
    const denied = JSON.parse(await gateway.turn(status));
    assertEquals(denied.inaccessible, ["observation"]);
    assertEquals(denied.observations, pending.observations);
    await assertRejects(confirm, Error, "evidence could not be reverified");
    denySource = false;
    assertEquals(JSON.parse(await confirm()).status, "completed");
    assertEquals(await resume(), 409);
    if (kind === "webhook") {
      assertEquals((await deliver(sourceId, body, signature)).status, 409);
    }
    assertEquals([calls, deliveries], [1, 2]);
  } finally {
    await gateway.stop();
    await storage.close();
  }
}

type Lease = {
  readonly assessmentRevision: number;
  readonly assignedTaskId: string;
  readonly assignedTaskLeaseToken: string;
};

async function worker(
  snapshotPath: string,
  lease: Lease,
  batches: readonly (readonly ReturnType<typeof call>[])[],
  deny?:
    | "publish"
    | "assigned"
    | "propose"
    | "prove"
    | "observation"
    | "fact-read",
  beforeTool?: (name: string) => void,
  saveCheckpoint?: (
    checkpoint: AgentTurnCheckpoint,
    trace: readonly SentinelReadTrace[],
  ) => void,
) {
  const results: string[][] = [];
  const trace: SentinelReadTrace[] = [];
  const hooks: string[] = [];
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input, session, auditInput }) {
      const name = String(
        input.tool_name ??
          (input.tool_call as { name?: string } | undefined)?.name,
      );
      if (
        [assigned, publish, read, propose, prove, observation].includes(name)
      ) {
        assertEquals(session.taint, "INTERNAL");
        hooks.push(`${hook}:${name}`);
        if (hook === "POST_TOOL_RESPONSE") {
          assert(!Object.hasOwn(auditInput ?? {}, "tool_response"));
          if (
            name !== assigned && typeof input.tool_response === "string" &&
            input.tool_response.startsWith("{")
          ) {
            assertEquals(
              JSON.parse(input.tool_response)._classification,
              "INTERNAL",
            );
          }
        }
      }
      if (hook === "PRE_TOOL_CALL") beforeTool?.(name);
      const allowed =
        !(hook === "PRE_TOOL_CALL" && name === propose && deny === "propose") &&
        !(hook === "PRE_TOOL_CALL" && name === prove && deny === "prove") &&
        !(hook === "PRE_TOOL_CALL" && name === publish && deny === "publish") &&
        !(hook === "POST_TOOL_RESPONSE" && name === read &&
          deny === "fact-read") &&
        !(hook === "POST_TOOL_RESPONSE" && name === observation &&
          deny === "observation") &&
        !(hook === "POST_TOOL_RESPONSE" && name === assigned &&
          deny === "assigned");
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const providerRegistry = createProviderRegistry();
  let iteration = 0;
  providerRegistry.register({
    name: "graph-fact-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      for (const name of [assigned, publish, read]) {
        assert(
          tools?.some((tool) =>
            (tool as { function?: { name?: string } }).function?.name === name
          ),
        );
      }
      if (iteration > 0) {
        const size = batches[iteration - 1].length;
        results.push(
          messages.filter(({ role }) => role === "tool").slice(-size)
            .map(({ content }) => String(content)),
        );
      }
      const batch = batches[iteration++];
      return Promise.resolve({
        usage: { inputTokens: 1, outputTokens: 1 },
        content: batch
          ? ""
          : '{"summary":"Reviewed the published defensively scoped relationship.","followUps":[]}',
        toolCalls: batch?.map(({ name, args }, index) => ({
          id: `graph-fact-${iteration}-${index}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        })) ?? [],
      });
    },
  });
  providerRegistry.setDefault("graph-fact-fixture");
  const agent = createSentinelSubagent({
    snapshotPath,
    providerRegistry,
    hookRunner,
    allowModelAccess: true,
    ...lease,
  });
  try {
    await agent.execute(
      "Read and record the exact assigned relationship.",
      () => {},
      undefined,
      (step) => trace.push(step),
      true,
      saveCheckpoint && {
        onToolBatchCheckpoint(checkpoint) {
          saveCheckpoint(checkpoint, trace);
          return Promise.resolve();
        },
      },
    );
    assertEquals(results.length, batches.length);
    return { results, trace, hooks };
  } finally {
    agent.clear();
  }
}

Deno.test("Only a post-authorized exact leased graph edge can be published and reopened by a same-target peer", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const relationship = {
    from: "approved-record",
    to: "assigned-finding",
    relation: "supports",
  };
  const foreign = {
    from: "foreign-record",
    to: "other-app",
    relation: "observed_on",
  };
  const raw = JSON.stringify({
    version: 1,
    nodes: [
      { id: "app", kind: "asset", label: "Assigned asset" },
      { id: "other-app", kind: "asset", label: "Different assignment asset" },
      { id: "dependent-app", kind: "asset", label: "Dependency follow-up" },
      { id: "approved-record", kind: "evidence", label: "Local record" },
      {
        id: "assigned-finding",
        kind: "finding",
        label: "Assigned finding",
        severity: "low",
      },
      {
        id: "foreign-record",
        kind: "evidence",
        label: "Separate target record",
      },
    ],
    edges: [
      relationship,
      foreign,
      { from: "approved-record", to: "app", relation: "observed_on" },
      { from: "assigned-finding", to: "app", relation: "affects" },
      { from: "foreign-record", to: "assigned-finding", relation: "supports" },
    ],
  });
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, raw);
    const state = startSentinelAssessment(path);
    assert(state.plan.runId);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const assignedLease = (kind: "impact" | "trace", nodeId: string): Lease => {
      const lease = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.kind === kind && task.nodeId === nodeId,
      );
      assert(lease);
      return {
        assessmentRevision: state.revision,
        assignedTaskId: lease.task.id,
        assignedTaskLeaseToken: lease.token,
      };
    };
    try {
      store.sync(revision, [
        {
          kind: "impact",
          depth: 7,
          nodeId: "app",
          reason: MODEL_ASSIGNMENT_REASON,
        },
        {
          kind: "trace",
          nodeId: "app",
          depth: 7,
          reason: MODEL_ASSIGNMENT_REASON,
        },
        {
          kind: "impact",
          nodeId: "other-app",
          depth: 7,
          reason: MODEL_ASSIGNMENT_REASON,
        },
      ], revision);
      advanceAdaptiveSentinel(path, state);
      const producer = assignedLease("impact", "app");
      const peer = assignedLease("trace", "app");
      const other = assignedLease("impact", "other-app");
      const args = { ...relationship, requestId: crypto.randomUUID() };
      const scope = {
        caseId: "main",
        runId: state.plan.runId,
        evidenceRevision: state.revision,
      };
      const registered = registerSentinelGoalCompletion(path, [{
        id: "verified-relationship",
        description: "Verify the exact committed relationship",
        source: "graph_fact",
        reference: JSON.stringify([
          relationship.from,
          relationship.relation,
          relationship.to,
        ]),
      }], "operator");
      assertEquals(registered.status, "open");
      const deniedRead = await worker(path, producer, [
        [call(assigned)],
        [call(publish, args)],
      ], "assigned");
      assertEquals(
        deniedRead.results[0][0],
        "Tool response withheld by policy.",
      );
      assertStringIncludes(deniedRead.results[1][0], "unavailable");
      assertEquals(listSentinelPlannerGraphFacts(path, scope), []);

      const deniedPublish = await worker(path, producer, [
        [call(assigned)],
        [call(publish, args)],
      ], "publish");
      assert(deniedPublish.hooks.includes(`PRE_TOOL_CALL:${publish}`));
      assert(!deniedPublish.hooks.includes(`POST_TOOL_RESPONSE:${publish}`));
      assertEquals(listSentinelPlannerGraphFacts(path, scope), []);

      const preview = await worker(path, producer, [
        [call(publish, args)],
        [call(assigned)],
      ]);
      const previewStep = preview.trace.findIndex(({ tool }) =>
        tool === assigned
      );
      const resultSha256 = preview.trace[previewStep]?.resultSha256;
      assert(resultSha256 && state.result?.sharedGraph.snapshot);
      const factId = "worker-graph-fact:" +
        createHash("sha256").update(JSON.stringify({
          ...scope,
          taskId: producer.assignedTaskId,
          targetId: "app",
          snapshotDigest: digestSentinelSnapshot(
            state.result.sharedGraph.snapshot,
          ),
          resultSha256,
          relationship,
          sourceStepIndex: previewStep,
          requestId: args.requestId,
        })).digest("hex");
      const waitingPlan = {
        id: "wait-for-fact",
        classification: "INTERNAL" as const,
        steps: [{
          id: "wait",
          evidenceWaitSeconds: 20,
          satisfiedBy: {
            case: scope.caseId,
            run_id: scope.runId,
            revision: scope.evidenceRevision,
            graph_fact_id: factId,
          },
        }, { id: "dependent" }],
      };
      const liveJournal = join(baseDir, "live-fact-wait.db");
      const restartJournal = join(baseDir, "restarted-fact-wait.db");
      const liveProbed = Promise.withResolvers<void>();
      const verify = createWorkflowObservationVerifier(baseDir);
      const initial = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [waitingPlan],
        liveJournal,
        async (requirement) => {
          const verified = await verify(requirement);
          assertEquals(verified, undefined);
          liveProbed.resolve();
          return verified;
        },
      );
      let waitingId = "";
      let deadline: string | undefined;
      await ownerFacts(
        baseDir,
        async (query) => {
          const { run } = JSON.parse(
            await query({
              action: "start",
              kind: "workflow",
              id: waitingPlan.id,
              requestId: crypto.randomUUID(),
            }),
          );
          waitingId = run.ref.id;
          await liveProbed.promise;
          const traces = JSON.parse(
            await query({
              action: "traces",
              kind: "workflow",
              id: waitingId,
            }),
          ).page.events;
          deadline = traces.find(({ event }: { event: string }) =>
            event === "step_waiting"
          )?.deadlineAt;
          assert(deadline);
          await Deno.copyFile(liveJournal, restartJournal);
          await query({ action: "cancel", kind: "workflow", id: waitingId });
        },
        true,
        undefined,
        initial,
      );
      const restartProbed = Promise.withResolvers<void>();
      const recovered = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [waitingPlan],
        restartJournal,
        async (requirement) => {
          const verified = await verify(requirement);
          restartProbed.resolve();
          return verified;
        },
      );
      assertEquals(recovered.inspect(waitingId)?.status, "interrupted");
      assertEquals(recovered.recoverWaiting(), [waitingId]);
      await restartProbed.promise;
      assertEquals(
        recovered.inspect(waitingId)?.steps.map(({ status }) => status),
        ["pending", "pending"],
      );
      const produced = await worker(path, producer, [
        [call(publish, args)],
        [call(assigned)],
        [
          call(publish, { ...foreign, requestId: crypto.randomUUID() }),
          call(publish, { ...args, from: "foreign-record" }),
          call(publish, args),
          call(publish, args),
        ],
      ]);
      assertStringIncludes(produced.results[0][0], "unavailable");
      assertEquals(JSON.parse(produced.results[1][0]).supportingRelationships, [
        relationship,
      ]);
      const [outside, forged, committed, duplicate] = produced.results[2];
      assertStringIncludes(outside, "unavailable");
      assertStringIncludes(forged, "unavailable");
      const { _classification, ...fact } = JSON.parse(committed);
      assertEquals(fact.id, factId);
      await ownerFacts(
        baseDir,
        async (query) => {
          for (
            let attempt = 0;
            attempt < 100 &&
            recovered.inspect(waitingId)?.status !== "completed";
            attempt++
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assertEquals(recovered.inspect(waitingId)?.status, "completed");
          assertEquals(recovered.recoverWaiting(), []);
          const traces = JSON.parse(
            await query({
              action: "traces",
              kind: "workflow",
              id: waitingId,
            }),
          ).page.events;
          const events = traces.map(({ event }: { event: string }) => event);
          assertEquals(
            events.filter((event: string) => event === "step_waiting").length,
            1,
          );
          assertEquals(
            traces[events.indexOf("step_waiting")].deadlineAt,
            deadline,
          );
          assertEquals(
            events.filter((event: string) => event === "step_satisfied").length,
            1,
          );
          assertEquals(
            traces[events.indexOf("step_satisfied")].evidence.graphFactId,
            fact.id,
          );
          assert(
            events.indexOf("step_satisfied") < events.indexOf("step_started"),
          );
        },
        false,
        undefined,
        recovered,
      );
      assertEquals(_classification, "INTERNAL");
      assertEquals(JSON.parse(duplicate), JSON.parse(committed));
      assertEquals(fact.relationship, relationship);
      assertEquals(fact.taskId, producer.assignedTaskId);
      assertEquals(fact.sourceTool, assigned);
      const source = produced.trace.at(fact.sourceStepIndex);
      assertEquals(source?.tool, assigned);
      assertEquals(source?.resultSha256, fact.resultSha256);
      assertEquals(listSentinelPlannerGraphFacts(path, scope), [fact]);
      const evidenceRequirement = {
        case: scope.caseId,
        run_id: scope.runId,
        revision: scope.evidenceRevision,
        graph_fact_id: fact.id as string,
      };
      const plan = (id: string, satisfiedBy: typeof evidenceRequirement) => ({
        id,
        classification: "INTERNAL" as const,
        steps: [
          { id: "verify", satisfiedBy, waitSeconds: 30 },
          { id: "dependent" },
        ],
      });
      const plans = [
        plan("fact-proof", evidenceRequirement),
        plan("stale-fact-proof", {
          ...evidenceRequirement,
          revision: scope.evidenceRevision + 1,
        }),
      ];
      const journal = join(baseDir, "graph-fact-workflows.db");
      const workflows = () =>
        createOperatorWorkflowRuns(
          createWorkflowRunRegistry(),
          plans,
          journal,
          createWorkflowObservationVerifier(baseDir),
        );
      const adapter = workflows();
      let completed: string | undefined;
      await ownerFacts(
        baseDir,
        async (query) => {
          for (const entry of plans) {
            const { run } = JSON.parse(
              await query({
                action: "start",
                kind: "workflow",
                id: entry.id,
                requestId: crypto.randomUUID(),
              }),
            );
            const id = run.ref.id;
            const expected = entry.id === "fact-proof" ? "completed" : "failed";
            for (
              let attempt = 0;
              attempt < 100 &&
              adapter.inspect(id)?.status !== expected;
              attempt++
            ) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assertEquals(adapter.inspect(id)?.status, expected);
            assertEquals(
              adapter.inspect(id)?.steps.map(({ status }) => status),
              expected === "completed"
                ? ["completed", "completed"]
                : ["pending", "pending"],
            );
            if (expected === "completed") completed = id;
          }
        },
        true,
        undefined,
        adapter,
      );
      assert(completed);
      await ownerFacts(
        baseDir,
        async (query) => {
          const traces = JSON.parse(
            await query({
              action: "traces",
              kind: "workflow",
              id: completed,
            }),
          ).page.events;
          assertEquals(
            traces.find(({ event }: { event: string }) =>
              event === "step_satisfied"
            )?.evidence,
            {
              graphFactId: fact.id,
              caseId: scope.caseId,
              runId: scope.runId,
              revision: scope.evidenceRevision,
              sourceTaskId: fact.taskId,
              sourceStepIndex: fact.sourceStepIndex,
              resultSha256: fact.resultSha256,
            },
          );
        },
        false,
        undefined,
        workflows(),
      );
      assert(!store.modelReviewNotes(revision).length);

      assert(store.recordModelReviewProgress(
        revision,
        producer.assignedTaskId,
        producer.assignedTaskLeaseToken,
        produced.trace,
      ));
      const publicationIndex = produced.trace.findIndex((
        { tool, target, outcome },
      ) => tool === publish && target === fact.id && outcome === "returned");
      assert(publicationIndex >= 0);
      const traceResult = {
        action: "worker_trace_result",
        id: "main",
        revision: state.revision,
        taskId: producer.assignedTaskId,
        stepIndices: [publicationIndex],
      };
      await ownerFacts(baseDir, async (query) => {
        const reopened = JSON.parse(await query(traceResult));
        assertEquals(reopened.result, JSON.parse(committed));
        assertStringIncludes(
          await query({ ...traceResult, taskId: peer.assignedTaskId }),
          "unavailable",
        );
      });
      for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
        await ownerFacts(
          baseDir,
          async (query) => {
            assertStringIncludes(await query(traceResult), "unavailable");
          },
          false,
          hook,
        );
      }
      const readByPeer = await worker(path, peer, [[
        call(read),
        call(read, { id: fact.id }),
      ]]);
      assertEquals(JSON.parse(readByPeer.results[0][0]).facts, [fact]);
      assertEquals(JSON.parse(readByPeer.results[0][1]), {
        _classification: "INTERNAL",
        ...fact,
      });
      assert(store.recordModelReviewProgress(
        revision,
        peer.assignedTaskId,
        peer.assignedTaskLeaseToken,
        readByPeer.trace,
      ));
      const peerTrace = {
        ...traceResult,
        taskId: peer.assignedTaskId,
        stepIndices: [1],
      };
      await ownerFacts(baseDir, async (query) => {
        assertEquals(
          JSON.parse(await query(peerTrace)).result,
          JSON.parse(readByPeer.results[0][1]),
        );
        assertEquals(
          JSON.parse(await query({ ...peerTrace, stepIndices: [0] })).result,
          JSON.parse(readByPeer.results[0][0]),
        );
        assertStringIncludes(
          await query({ ...peerTrace, taskId: other.assignedTaskId }),
          "unavailable",
        );
      });
      await ownerFacts(
        baseDir,
        async (query) => {
          assertStringIncludes(await query(peerTrace), "unavailable");
        },
        false,
        "POST_TOOL_RESPONSE",
      );
      const blockedPeer = await worker(path, other, [[
        call(read),
        call(read, { id: fact.id }),
      ]]);
      assertEquals(JSON.parse(blockedPeer.results[0][0]).facts, []);
      assertStringIncludes(blockedPeer.results[0][1], "unavailable");
      assertEquals(await Deno.readTextFile(path), raw);
      const observed = Promise.withResolvers<unknown>();
      const interruptedRead = Promise.withResolvers<string>();
      const released = Promise.withResolvers<void>();
      const resumedRead = Promise.withResolvers<string>();
      const plannerHooks: string[] = [];
      let plannerDispatched = 0;
      let plannerNow = Date.now();
      function plannerFactory(interrupt: boolean) {
        return createSentinelModelPlanner(
          path,
          (_case, assignment) => {
            if (assignment) {
              return { execute: () => Promise.resolve(), clear() {} };
            }
            const providerRegistry = createProviderRegistry();
            providerRegistry.register({
              name: "durable-planner-fact",
              supportsStreaming: false,
              async complete(messages) {
                const user = messages.find(({ role }) => role === "user");
                const received = messages.find(({ role }) => role === "tool");
                if (!received) {
                  assert(
                    interrupt,
                    "The recovered planner repeated its tool request",
                  );
                  return {
                    content: "",
                    toolCalls: [{
                      id: "exact-first-read",
                      type: "function",
                      function: {
                        name: read,
                        arguments: JSON.stringify({ id: fact.id }),
                      },
                    }],
                    usage: { inputTokens: 1, outputTokens: 1 },
                  };
                }
                if (interrupt) {
                  interruptedRead.resolve(String(received.content));
                  await released.promise;
                  return {
                    content: "{}",
                    toolCalls: [],
                    usage: { inputTokens: 1, outputTokens: 1 },
                  };
                }
                resumedRead.resolve(String(received.content));
                observed.resolve(
                  JSON.parse(String(user?.content).split("\n").at(-1)!)
                    .graphFacts,
                );
                return {
                  content: JSON.stringify({
                    assignments: [
                      {
                        kind: "trace",
                        nodeId: "other-app",
                        graphFactId: fact.id,
                      },
                      {
                        kind: "trace",
                        nodeId: "app",
                        depth: 1,
                        graphFactId: fact.id,
                        graphFactOnly: true,
                      },
                      {
                        kind: "impact",
                        nodeId: "dependent-app",
                        dependsOn: [1],
                      },
                    ],
                    prioritize: [],
                    goalObservations: [{
                      criterionId: "verified-relationship",
                      evidence: [
                        {
                          source: "graph_fact",
                          reference: "worker-graph-fact:" + "0".repeat(64),
                          detail: "",
                        },
                        {
                          source: "graph_fact",
                          reference: fact.id,
                          detail: "",
                        },
                      ],
                    }],
                  }),
                  toolCalls: [],
                  usage: { inputTokens: 1, outputTokens: 1 },
                };
              },
            });
            providerRegistry.setDefault("durable-planner-fact");
            const agent = createSentinelSubagent({
              snapshotPath: path,
              providerRegistry,
              assessmentRevision: _case.revision,
              plannerExecutionEvidenceRunId: _case.plan.runId,
              allowModelAccess: true,
              hookRunner: {
                evaluateHook(hook, { input }) {
                  const name = input.tool_name ??
                    (input.tool_call as { name?: string } | undefined)?.name;
                  if (name === read) {
                    plannerHooks.push(
                      `${interrupt ? "initial" : "resumed"}:${hook}`,
                    );
                  }
                  return Promise.resolve({
                    allowed: true,
                    action: "ALLOW",
                    ruleId: null,
                    duration: 0,
                  });
                },
              },
            });
            return {
              ...agent,
              execute(prompt, send, signal, onTrace, enabled, options) {
                return agent.execute(
                  prompt,
                  send,
                  signal,
                  (step) => {
                    if (step.tool === read) plannerDispatched++;
                    onTrace?.(step);
                  },
                  enabled,
                  options,
                );
              },
            };
          },
          undefined,
          () => plannerNow,
        );
      }
      const firstPlanner = plannerFactory(true);
      let firstResult: string;
      try {
        firstPlanner.advance(state);
        const timeout = setTimeout(
          () =>
            interruptedRead.reject(
              new Error("First planner did not commit its tool exchange"),
            ),
          3000,
        );
        try {
          firstResult = await interruptedRead.promise;
        } finally {
          clearTimeout(timeout);
        }
        assertEquals(JSON.parse(firstResult).id, fact.id);
      } finally {
        firstPlanner.stop();
        released.resolve();
      }
      plannerNow += 4 * 60_000;
      const planner = plannerFactory(false);
      try {
        planner.advance(state);
        const deadline = setTimeout(
          () =>
            observed.reject(
              new Error("Planner did not receive the committed graph fact"),
            ),
          2000,
        );
        try {
          assertEquals(await observed.promise, [{
            id: fact.id,
            targetId: "app",
            taskId: fact.taskId,
            relationship,
            resultSha256: fact.resultSha256,
          }]);
        } finally {
          clearTimeout(deadline);
        }
        assertEquals(await resumedRead.promise, firstResult);
        assertEquals(plannerDispatched, 1);
        assert(plannerHooks.includes("resumed:PRE_TOOL_CALL"));
        assert(plannerHooks.includes("resumed:POST_TOOL_RESPONSE"));
        assertEquals(
          store.modelPlanHistory(revision, true).at(-1)?.inputManifest
            ?.graphFactIds,
          [fact.id],
        );
        const expires = Date.now() + 2000;
        while (
          !store.list(revision).some((task) =>
            task.plannerRound?.graphFactId
          ) && Date.now() < expires
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const verifiedGoal = readSentinelGoalCompletionAtRevision(
          path,
          state.revision,
        );
        assertEquals(verifiedGoal?.status, "awaiting_confirmation");
        assertEquals(
          verifiedGoal?.observations[0].evidence.map(({ reference }) =>
            reference
          ),
          [fact.id],
        );
        const cited = store.list(revision).filter((task) =>
          task.plannerRound?.graphFactId
        );
        assertEquals(cited[0]?.status, "completed");
        assertEquals(cited[0]?.attempts, 0);
        assertEquals(cited[0]?.factSatisfaction?.graphFactId, fact.id);
        assertEquals(
          cited[0]?.factSatisfaction?.evidenceRevision,
          state.revision,
        );

        const dependent = store.list(revision).find(({ nodeId }) =>
          nodeId === "dependent-app"
        );
        assertEquals(dependent?.prerequisites, [cited[0].id]);
        assertEquals(dependent?.status, "completed");
        assertEquals(
          cited.map(({ nodeId, prerequisites, plannerRound }) => ({
            nodeId,
            prerequisites,
            factId: plannerRound?.graphFactId,
          })),
          [{
            nodeId: "app",
            prerequisites: [producer.assignedTaskId],
            factId: fact.id,
          }],
        );
        const historical = readHistoricalAdaptiveSentinel(path, state.revision);
        assert(historical);
        assertEquals(historical.modelPlanner?.status, "completed");
        const provenance = buildSentinelProvenance(state.result, historical)
          .snapshot();
        const factNode = provenance.nodes.find((node) =>
          node.sourceId === fact.id
        );
        assert(factNode && "graphFact" in factNode);
        const assignmentNode = provenance.nodes.find((node) =>
          node.sourceId === cited[0].id
        );
        assert(assignmentNode && "factSatisfaction" in assignmentNode);
        assertEquals(
          assignmentNode.factSatisfaction,
          cited[0].factSatisfaction,
        );
        const foreignGraph = buildSentinelProvenance(state.result, {
          ...historical,
          graphFacts: historical.graphFacts.map((record) =>
            record.id === fact.id
              ? { ...record, runId: crypto.randomUUID() }
              : record
          ),
        }).snapshot();
        const foreignAssignment = foreignGraph.nodes.find((node) =>
          node.sourceId === cited[0].id
        );
        assert(foreignAssignment && !("factSatisfaction" in foreignAssignment));
        assert(
          !foreignGraph.edges.some(({ from, to, relation }) =>
            from === foreignAssignment.id && to === factNode.id &&
            relation === "references"
          ),
        );

        assert(
          provenance.edges.some(({ from, to, relation }) =>
            from === assignmentNode.id && to === factNode.id &&
            relation === "references"
          ),
        );
      } finally {
        planner.stop();
      }
      const additional = await worker(path, other, [
        [call(assigned)],
        [call(publish, { ...foreign, requestId: crypto.randomUUID() })],
      ]);
      const laterFact = JSON.parse(additional.results[1][0]);
      assertEquals(laterFact.relationship, foreign);
      const policyPlan = {
        ...waitingPlan,
        id: "fact-policy-wait",
        steps: [
          { ...waitingPlan.steps[0], evidenceWaitSeconds: 2 },
          waitingPlan.steps[1],
        ],
      };
      const verifierEntered = Promise.withResolvers<void>();
      const checkCurrentPolicy = Promise.withResolvers<void>();
      let sawPolicyDenial = false;
      const priorProof = await verify(waitingPlan.steps[0].satisfiedBy!);
      assert(priorProof && "graphFactId" in priorProof);
      assertEquals(priorProof.graphFactId, factId);
      const policyWorkflow = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [policyPlan],
        join(baseDir, "graph-fact-policy-wait.db"),
        async (requirement) => {
          verifierEntered.resolve();
          await checkCurrentPolicy.promise;
          const proof = await verify(requirement);
          sawPolicyDenial ||= proof === undefined;
          return proof;
        },
      );
      await ownerFacts(
        baseDir,
        async (query) => {
          const { run } = JSON.parse(
            await query({
              action: "start",
              kind: "workflow",
              id: policyPlan.id,
              requestId: crypto.randomUUID(),
            }),
          );
          const ref = { kind: "workflow", id: run.ref.id };
          try {
            await verifierEntered.promise;
            const narrowed = JSON.parse(
              await query({
                action: "narrow_constraints",
                id: scope.caseId,
                revision: scope.evidenceRevision,
                runId: scope.runId,
                expectedVersion: 0,
                requestId: crypto.randomUUID(),
                deniedKinds: ["review_evidence"],
              }),
            );
            assertEquals(narrowed.record.version, 1);
            checkCurrentPolicy.resolve();
            for (
              let attempt = 0;
              attempt < 300 &&
              policyWorkflow.inspect(ref.id)?.status !== "failed";
              attempt++
            ) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(sawPolicyDenial);
            assertEquals(policyWorkflow.inspect(ref.id)?.status, "failed");
            assertEquals(
              policyWorkflow.inspect(ref.id)?.steps.map(({ status }) => status),
              ["pending", "pending"],
            );
            const traces =
              JSON.parse(await query({ action: "traces", ...ref })).page.events;
            assert(
              traces.some(({ event }: { event: string }) =>
                event === "step_waiting"
              ),
            );
            assert(
              !traces.some((
                { event, stepId }: { event: string; stepId?: string },
              ) => event === "step_satisfied" || stepId === "dependent"),
            );
          } finally {
            checkCurrentPolicy.resolve();
            policyWorkflow.cancel(ref.id);
          }
        },
        true,
        undefined,
        policyWorkflow,
      );
      const updateEvidencePolicy = (
        expectedVersion: number,
        deniedKinds: readonly ("review_evidence")[],
      ) => {
        assert(recordSentinelOperatingConstraints(path, {
          runId: scope.runId,
          evidenceRevision: scope.evidenceRevision,
          expectedVersion,
          requestId: crypto.randomUUID(),
          operatorScope: "owner",
          constraints: { deniedKinds },
        }));
      };
      updateEvidencePolicy(1, []);
      const factGrant = {
        case: scope.caseId,
        run_id: scope.runId,
        revision: scope.evidenceRevision,
        observation_id: factId,
      };
      const verifyFact = (projection: Record<string, unknown>) => {
        const expected = { ...fact };
        delete expected.requestId;
        assertEquals(projection, { _classification: "INTERNAL", ...expected });
      };
      let policyVersion = 2;
      await verifyDelegatedObservationGrant(
        baseDir,
        factGrant,
        verifyFact,
        () => updateEvidencePolicy(policyVersion++, ["review_evidence"]),
        () => updateEvidencePolicy(policyVersion++, []),
      );
      for (const kind of ["webhook", "cron", "trigger"] as const) {
        await verifyScheduledObservationGrant(
          baseDir,
          factGrant,
          verifyFact,
          kind,
        );
      }
      const otherCase = resolveSentinelCasePath(baseDir, "different-case");
      await Deno.mkdir(dirname(otherCase), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(otherCase, raw);
      const different = startSentinelAssessment(otherCase);
      const latestGraph = { ...JSON.parse(raw), edges: [foreign] };
      await Deno.writeTextFile(path, JSON.stringify(latestGraph));
      const latest = refreshSentinelAssessment(path);
      assert(latest && latest.revision > state.revision);
      assertStringIncludes(
        await createScheduledObservationRead(baseDir, factGrant, undefined)({}),
        "unavailable",
      );
      await ownerFacts(baseDir, async (query) => {
        const ref = { id: "main", revision: state.revision };
        const listed = JSON.parse(await query({ ...ref, limit: 1 }));
        assertEquals(
          JSON.parse(await query({ ...peerTrace, stepIndices: [0] })).result,
          JSON.parse(readByPeer.results[0][0]),
        );
        assertEquals(listed.page.facts.map(({ id }: { id: string }) => id), [
          laterFact.id,
        ]);
        assert(!Object.hasOwn(listed.page.facts[0], "requestId"));
        const filtered = JSON.parse(
          await query({ ...ref, query: "  SUPPORTS  ", limit: 1 }),
        ).page;
        assertEquals(filtered.facts.map(({ id }: { id: string }) => id), [
          fact.id,
        ]);
        assertEquals(filtered.nextOffset, null);
        assertEquals(filtered.total, 1);
        const beyondMatch = JSON.parse(
          await query({ ...ref, query: "other-app", offset: 1 }),
        ).page;
        assertEquals(beyondMatch.facts, []);
        assertEquals(beyondMatch.total, 1);
        assertEquals(listed.page.total, 2);
        assertStringIncludes(
          await query({ ...ref, factId: fact.id, query: "supports" }),
          "unavailable",
        );
        const exact =
          JSON.parse(await query({ ...ref, factId: fact.id })).page.fact;
        assertEquals(exact.id, fact.id);
        assert(!Object.hasOwn(exact, "requestId"));
        for (
          const field of [
            "snapshotDigest",
            "resultSha256",
            "taskId",
            "targetId",
            "evidenceRevision",
            "sourceStepIndex",
            "relationship",
          ] as const
        ) {
          assertEquals(exact[field], fact[field]);
        }
        const newer = JSON.parse(
          await query({ id: "main", revision: latest.revision }),
        );
        assertEquals(newer.page.facts, []);
        assert(
          (await query({ ...ref, factId: fact.id, offset: 1 })).startsWith(
            "Error:",
          ),
        );
        for (
          const target of [
            { id: "different-case", revision: different.revision },
            { id: "main", revision: latest.revision },
          ]
        ) {
          const denied = await query({ ...target, factId: fact.id });
          assert(denied.startsWith("Error:"));
          assert(!denied.includes(fact.id));
        }
      });
      await ownerFacts(
        baseDir,
        async (query) => {
          const ref = { id: "main", revision: state.revision };
          const factPage =
            JSON.parse(await query({ ...ref, query: "supports" })).page;
          assertEquals(factPage.facts.map(({ id }: { id: string }) => id), [
            fact.id,
          ]);
          const record =
            JSON.parse(await query({ ...ref, factId: fact.id })).page.fact;
          assertEquals(record.taskId, fact.taskId);
          assertEquals(record.sourceStepIndex, fact.sourceStepIndex);
          assertEquals(record.resultSha256, fact.resultSha256);
          assertStringIncludes(
            await query({ ...ref, factId: fact.id, revision: latest.revision }),
            "unavailable",
          );
        },
        false,
        undefined,
        undefined,
        true,
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Leased worker proposals require assigned evidence and exact owner approval", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, "goal-proposals");
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Assigned asset" },
          { id: "approved-record", kind: "evidence", label: "Assigned record" },
          { id: "foreign-record", kind: "evidence", label: "Unlinked record" },
        ],
        edges: [{
          from: "approved-record",
          to: "app",
          relation: "observed_on",
        }],
      }),
    );
    const state = startSentinelAssessment(path);
    assert(state.plan.runId);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      store.sync(revision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.kind === "impact" && task.nodeId === "app",
      );
      assert(claim);
      const lease = {
        assessmentRevision: state.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
      };
      const offer = {
        goalId: "verify-assigned",
        title: "Verify the assigned control",
        criterion: "Check the exact retained record",
        evidenceId: "approved-record",
        requestId: crypto.randomUUID(),
      };
      const blocked = await worker(path, lease, [[call(assigned)], [
        call(propose, offer),
      ]], "propose");
      assert(blocked.hooks.includes(`PRE_TOOL_CALL:${propose}`));
      assert(!blocked.hooks.includes(`POST_TOOL_RESPONSE:${propose}`));
      const response = await worker(path, lease, [
        [call(propose, offer)],
        [call(assigned)],
        [
          call(propose, { ...offer, evidenceId: "foreign-record" }),
          call(propose, offer),
          call(propose, offer),
        ],
      ]);
      assertStringIncludes(response.results[0][0], "exact evidence");
      assertStringIncludes(response.results[2][0], "exact evidence");
      const proposal = JSON.parse(response.results[2][1]).proposal;
      assertEquals(JSON.parse(response.results[2][2]).proposal, proposal);
      assertEquals(proposal.assignmentId, claim.task.id);
      assertEquals(proposal.targetId, "app");
      assertEquals(proposal.revision, state.revision);
      assertEquals(readSentinelAssessment(path)?.plan.formalGoals, undefined);
      const ref = {
        id: "goal-proposals",
        revision: state.revision,
        runId: state.plan.runId,
      };
      assert(
        store.recordModelReviewProgress(
          revision,
          claim.task.id,
          claim.token,
          response.trace,
        ),
      );
      const traceIndex = response.trace.findIndex(({ tool, target, outcome }) =>
        tool === propose && target === proposal.id && outcome === "returned"
      );
      assert(traceIndex >= 0);
      const proposalTrace = {
        action: "worker_trace_result",
        id: ref.id,
        revision: ref.revision,
        taskId: claim.task.id,
        stepIndices: [traceIndex],
      };
      const originalResponse = JSON.parse(response.results[2][1]);
      await ownerFacts(baseDir, async (turn) => {
        assertEquals(
          JSON.parse(await turn(proposalTrace)).result,
          originalResponse,
        );
        assertStringIncludes(
          await turn({
            ...proposalTrace,
            taskId: `adaptive:${"0".repeat(64)}`,
          }),
          "unavailable",
        );
      });
      for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
        await ownerFacts(
          baseDir,
          async (turn) => {
            assertStringIncludes(await turn(proposalTrace), "unavailable");
          },
          false,
          hook,
        );
      }
      const list = { action: "goal_proposals", ...ref };
      const approve = {
        action: "approve_goal_proposal",
        ...ref,
        proposalId: proposal.id,
        requestId: crypto.randomUUID(),
      };
      await ownerFacts(baseDir, async (turn) => {
        const pending = JSON.parse(await turn(list)).proposals;
        assertEquals(pending, [{ ...proposal, acceptedRevision: null }]);
        assertStringIncludes(await turn(approve), "operator declined");
      });
      const originalGraph = await Deno.readTextFile(path);
      const newerGraph = JSON.parse(originalGraph);
      newerGraph.nodes.find(({ id }: { id: string }) =>
        id === "approved-record"
      ).label = "Changed retained record";
      await Deno.writeTextFile(path, JSON.stringify(newerGraph));
      await ownerFacts(baseDir, async (turn) => {
        assertStringIncludes(await turn(approve), "unavailable");
        assertEquals(readSentinelAssessment(path)?.revision, state.revision);
      }, true);
      await Deno.writeTextFile(path, originalGraph);
      await ownerFacts(baseDir, async (turn) => {
        const accepted = JSON.parse(await turn(approve)).receipt;
        assertEquals(accepted.appliedRevision, state.revision + 1);
        assertEquals(
          JSON.parse(await turn(proposalTrace)).result,
          originalResponse,
        );
        assertEquals(readSentinelAssessment(path)?.plan.formalGoals, [
          proposal.goal,
        ]);
      }, true);
      const updated = readSentinelAssessment(path);
      assert(updated?.active);
      const updatedRevision = adaptiveRevision(updated);
      store.sync(updatedRevision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], updatedRevision);
      advanceAdaptiveSentinel(path, updated);
      const proofClaim = store.claimModelReview(
        updatedRevision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.kind === "impact" && task.nodeId === "app",
      );
      assert(proofClaim);
      const proofLease = {
        assessmentRevision: updated.revision,
        assignedTaskId: proofClaim.task.id,
        assignedTaskLeaseToken: proofClaim.token,
      };
      const offeredProof = {
        goalId: proposal.goal.id,
        criterionId: "evidence",
        evidenceId: "approved-record",
      };
      const deniedProof = await worker(path, proofLease, [
        [call(assigned)],
        [call(prove, offeredProof)],
      ], "prove");
      assert(deniedProof.hooks.includes(`PRE_TOOL_CALL:${prove}`));
      assert(!deniedProof.hooks.includes(`POST_TOOL_RESPONSE:${prove}`));
      const proof = await worker(path, proofLease, [
        [call(prove, offeredProof)],
        [call(assigned)],
        [
          call(prove, { ...offeredProof, criterionId: "wrong" }),
          call(prove, offeredProof),
          call(prove, offeredProof),
        ],
      ]);
      assertStringIncludes(proof.results[0][0], "exact evidence");
      assertStringIncludes(proof.results[2][0], "unavailable");
      const receipt = JSON.parse(proof.results[2][1]);
      assertEquals(JSON.parse(proof.results[2][2]), receipt);
      assertEquals(receipt.status, "awaiting_confirmation");
      assertEquals(receipt.evidenceRevision, updated.revision);
      assertStringIncludes(receipt.proof.detail, proofClaim.task.id);
      const goalLookup = {
        action: "goals",
        id: ref.id,
        revision: updated.revision,
        goalId: proposal.goal.id,
        includeProof: true,
      };
      let completionRequest: Record<string, unknown> = {};
      await ownerFacts(baseDir, async (turn) => {
        assertEquals(JSON.parse(await turn(approve)).receipt.duplicate, true);
        assertEquals(
          JSON.parse(await turn(list)).proposals[0].acceptedRevision,
          state.revision + 1,
        );
        const savedProof = JSON.parse(await turn(goalLookup)).proof;
        completionRequest = {
          action: "confirm_goal_completion",
          id: ref.id,
          revision: updated.revision,
          runId: ref.runId,
          goalProofDigest: savedProof.digest,
        };
        assertStringIncludes(
          await turn({ ...completionRequest, goalProofDigest: "0".repeat(64) }),
          "unavailable",
        );
        assertStringIncludes(
          await turn(completionRequest),
          "operator declined",
        );
        assertEquals(savedProof.status, "awaiting_confirmation");
        assertEquals(savedProof.observations, [{
          criterionId: receipt.criterionId,
          evidence: [receipt.proof],
        }]);
        assertStringIncludes(
          await turn({ ...approve, requestId: crypto.randomUUID() }),
          "unavailable",
        );
      });
      let completionAuthorized = true;
      await ownerFacts(
        baseDir,
        async (turn) => {
          const pending = JSON.parse(await turn(goalLookup)).proof;
          assertStringIncludes(await turn(completionRequest), "unavailable");
          assertEquals(JSON.parse(await turn(goalLookup)).proof, pending);
          assertEquals(pending.status, "awaiting_confirmation");
          assert(readSentinelAssessment(path)?.active);
        },
        () => {
          completionAuthorized = false;
          return true;
        },
        undefined,
        undefined,
        false,
        () => completionAuthorized,
      );
      await ownerFacts(baseDir, async (turn) => {
        assertStringIncludes(await turn(completionRequest), "unavailable");
        assert(readSentinelAssessment(path)?.active);
      }, () => {
        Deno.writeTextFileSync(path, JSON.stringify(newerGraph));
        return true;
      });
      await Deno.writeTextFile(path, originalGraph);
      let completion: unknown;
      await ownerFacts(baseDir, async (turn) => {
        completion = JSON.parse(await turn(completionRequest));
        assertEquals((completion as { status: string }).status, "completed");
        assertEquals(readSentinelAssessment(path)?.active, false);
      }, true);
      await ownerFacts(baseDir, async (turn) => {
        assertEquals(JSON.parse(await turn(completionRequest)), completion);
        const saved = JSON.parse(await turn(goalLookup)).proof;
        assertEquals(saved.status, "completed");
        assertEquals(saved.observations, [{
          criterionId: receipt.criterionId,
          evidence: [receipt.proof],
        }]);
      });
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Leased proof binds post-authorized same-target task results to formal criteria", async () => {
  const baseDir = await Deno.makeTempDir();
  const id = "task-proof";
  const path = resolveSentinelCasePath(baseDir, id);
  const relationship = { from: "record", relation: "observed_on", to: "app" };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          ...["app", "peer"].map((id) => ({ id, kind: "asset", label: id })),
          { id: "record", kind: "evidence", label: "Verified record" },
        ],
        edges: [relationship],
      }),
    );
    const initial = startSentinelAssessment(path, { goal: "Review controls" });
    const sources = ["app", "peer"].map((nodeId) => ({
      kind: "trace" as const,
      nodeId,
      depth: 1,
    }));
    const criteria = sources.map((task) => ({
      id: task.nodeId,
      description: "Review the committed control observation",
      source: "adaptive_task" as const,
      reference: `task:${task.kind}:${task.depth}:${task.nodeId}`,
    }));
    const goals: SentinelFormalGoal[] = [{
      id: "controls",
      title: "Verify controls",
      criteria: [...criteria, {
        id: "edge",
        description: "Verify the retained relationship",
        source: "graph_fact",
        reference: JSON.stringify([
          relationship.from,
          relationship.relation,
          relationship.to,
        ]),
      }],
      policy: "operator",
    }];
    const append = {
      action: "append_goals",
      id,
      revision: initial.revision,
      requestId: crypto.randomUUID(),
      runId: initial.plan.runId,
      goals,
    };
    await ownerFacts(baseDir, async (turn) => {
      assertStringIncludes(await turn(append), "operator declined");
      assertEquals(readSentinelAssessment(path)?.revision, initial.revision);
    });
    await ownerFacts(baseDir, async (turn) => {
      const result = JSON.parse(await turn(append)).receipt;
      assertEquals(result.appliedRevision, initial.revision + 1);
    }, true);
    const state = readSentinelAssessment(path);
    assert(state);
    assertEquals(state.plan.formalGoals, goals);
    const revision = adaptiveRevision(state);
    ensureSentinelFormalGoalContract(path, state);
    advanceAdaptiveSentinel(path, state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      const wrongDepth = { ...sources[0], depth: 2 };
      const requested = validateSentinelPlanSuggestions(
        state,
        JSON.stringify([...sources, wrongDepth]),
      );
      assertEquals(requested?.map(({ depth }) => depth), [1, 1, 2]);
      assert(requested);
      store.sync(revision, [...requested, {
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.nodeId === "app",
      );
      assert(claim);
      const lease = {
        assessmentRevision: state.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
      };
      const [own, peer] = sources.map((task) =>
        sentinelAdaptiveTaskId(revision, task)
      );
      const wrong = sentinelAdaptiveTaskId(revision, wrongDepth);
      const open = (task: string) => call(observation, { task });
      const proof = (criterionId: string, evidenceId: string) =>
        call(prove, {
          goalId: "controls",
          criterionId,
          evidenceId,
          source: "adaptive_task",
          requestId: crypto.randomUUID(),
        });
      const denied = await worker(path, lease, [[open(own)], [
        proof("app", own),
      ]], "observation");
      assert(denied.hooks.includes(`POST_TOOL_RESPONSE:${observation}`));
      assertStringIncludes(denied.results[1][0], "exact evidence");
      const actual = await worker(path, lease, [
        [open(own), open(peer), open(wrong)],
        [proof("app", wrong), proof("app", own), proof("peer", peer)],
      ]);
      const opened = JSON.parse(actual.results[0][0]);
      assertStringIncludes(actual.results[1][0], "unavailable");
      const receipt = JSON.parse(actual.results[1][1]);
      assertEquals(receipt.proof.reference, own);
      assertStringIncludes(receipt.proof.detail, opened.observationSha256);
      assertStringIncludes(actual.results[0][1], "unavailable");
      assertEquals(JSON.parse(actual.results[0][2]).task, wrong);
      assertStringIncludes(actual.results[1][2], "exact evidence");
      assert(
        store.recordModelReviewProgress(
          revision,
          claim.task.id,
          claim.token,
          actual.trace,
        ),
      );
      const proofIndex = actual.trace.findIndex(({ tool, target, outcome }) =>
        tool === prove && target === own && outcome === "returned"
      );
      assert(proofIndex >= 0);
      const proofTrace = {
        action: "worker_trace_result",
        id,
        revision: state.revision,
        taskId: claim.task.id,
        stepIndices: [proofIndex],
      };
      const sameTargetReadIndex = actual.trace.findIndex((step) =>
        step.taskObservationPage?.task === wrong
      );
      assert(sameTargetReadIndex >= 0);
      assert(
        !actual.trace.some((step) => step.taskObservationPage?.task === peer),
      );
      const sameTargetReadTrace = {
        ...proofTrace,
        stepIndices: [sameTargetReadIndex],
      };
      await ownerFacts(baseDir, async (turn) => {
        assertEquals(
          JSON.parse(await turn(sameTargetReadTrace)).result,
          JSON.parse(actual.results[0][2]),
        );
      });
      await ownerFacts(
        baseDir,
        async (turn) => {
          assertStringIncludes(await turn(sameTargetReadTrace), "unavailable");
        },
        false,
        "POST_TOOL_RESPONSE",
      );
      await ownerFacts(baseDir, async (turn) => {
        assertEquals(JSON.parse(await turn(proofTrace)).result, receipt);
        assertStringIncludes(
          await turn({ ...proofTrace, taskId: peer }),
          "unavailable",
        );
      });
      for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
        await ownerFacts(
          baseDir,
          async (turn) => {
            assertStringIncludes(await turn(proofTrace), "unavailable");
          },
          false,
          hook,
        );
      }
      await ownerFacts(baseDir, async (turn) => {
        const saved = JSON.parse(
          await turn({
            action: "goals",
            id,
            revision: state.revision,
            goalId: "controls",
            includeProof: true,
          }),
        ).proof;
        assertEquals(saved.status, "open");
        assertEquals(saved.observations, [{
          criterionId: receipt.criterionId,
          evidence: [receipt.proof],
        }]);
      });
      const published = await worker(path, lease, [[call(assigned)], [
        call(publish, {
          ...relationship,
          requestId: crypto.randomUUID(),
        }),
      ]]);
      const fact = JSON.parse(published.results[1][0]);
      const offer = call(prove, {
        goalId: "controls",
        criterionId: "edge",
        source: "graph_fact",
        evidenceId: fact.id,
      });
      const lookup = call(read, { id: fact.id });
      const withheld = await worker(
        path,
        lease,
        [[lookup], [offer]],
        "fact-read",
      );
      assertStringIncludes(withheld.results[0][0], "withheld by policy");
      assertStringIncludes(withheld.results[1][0], "exact evidence");
      const filed = await worker(path, lease, [[lookup], [offer, offer]]);
      const verified = JSON.parse(filed.results[1][0]);
      assertEquals(verified.proof.source, "graph_fact");
      assertEquals(verified.proof.reference, fact.id);
      assertEquals(JSON.parse(filed.results[1][1]), verified);
      await ownerFacts(baseDir, async (turn) => {
        assertEquals(JSON.parse(await turn(proofTrace)).result, receipt);
      });
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("A queued current-pass requirement releases dependent work only for valid passing evidence", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, "wait-for-fact");
  const expected = {
    from: "verified",
    to: "control",
    relation: "verifies",
    requireCurrentPass: true,
  };
  const now = Date.now();
  const verification = (valid: boolean) => ({
    outcome: "pass",
    observedAt: new Date(now - 60_000).toISOString(),
    validUntil: new Date(now + (valid ? 30_000 : -1000)).toISOString(),
  });
  const unrelated = { ...expected, from: "other-record" };
  const failed = { ...expected, from: "failed-record" };
  const future = { ...expected, from: "future-record" };
  const wildcard = {
    to: "control",
    relation: "verifies",
    requireCurrentPass: true,
  };
  const older = { ...expected, from: "older-pass" };
  const renewal = { ...expected, from: "renewal-pass" };
  const outcomes = {
    [expected.from]: verification(true),
    [unrelated.from]: {
      ...verification(false),
      observedAt: new Date(now - 120_000).toISOString(),
    },
    [older.from]: {
      ...verification(true),
      observedAt: new Date(now - 90_000).toISOString(),
    },
    [failed.from]: {
      ...verification(true),
      outcome: "fail",
      observedAt: new Date(now - 80_000).toISOString(),
    },
    [renewal.from]: {
      ...verification(true),
      observedAt: new Date(now + 15_000).toISOString(),
      validUntil: new Date(now + 120_000).toISOString(),
    },
    [future.from]: {
      ...verification(true),
      observedAt: new Date(now + 10_000).toISOString(),
    },
  };
  const planner = createSentinelModelPlanner(path, (_state, assignment) => ({
    execute(_prompt, send) {
      if (!assignment) {
        send({
          type: "response",
          taint: "INTERNAL",
          text: JSON.stringify([
            {
              kind: "trace",
              nodeId: "app",
              depth: 1,
              graphFactOnly: true,
              graphRelationship: expected,
            },
            { kind: "impact", nodeId: "follow-up", dependsOn: [0] },
            {
              kind: "trace",
              nodeId: "app",
              depth: 1,
              graphFactOnly: true,
              graphRelationship: unrelated,
            },
            { kind: "impact", nodeId: "other-follow-up", dependsOn: [2] },
            ...[failed, future].map((graphRelationship) => ({
              kind: "trace",
              nodeId: "app",
              depth: 1,
              graphFactOnly: true,
              graphRelationship,
            })),
            {
              kind: "trace",
              nodeId: "app",
              depth: 1,
              graphFactOnly: true,
              graphRelationship: wildcard,
            },
            { kind: "impact", nodeId: "wildcard-child", dependsOn: [6] },
          ]),
        });
      }
      return Promise.resolve();
    },
    clear() {},
  }));
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Application" },
          { id: "follow-up", kind: "asset", label: "Follow up asset" },
          { id: "wildcard-child", kind: "asset", label: "Renewable follow-up" },
          {
            id: "other-follow-up",
            kind: "asset",
            label: "Other follow up asset",
          },
          { id: "finding", kind: "finding", label: "Finding", severity: "low" },
          { id: "control", kind: "control", label: "Control" },
          ...Object.keys(outcomes).map((id) => ({
            id,
            kind: "evidence",
            label: id,
            controlVerification: outcomes[id],
          })),
        ],
        edges: [
          ...Object.keys(outcomes).flatMap((from) => [
            { from, to: "control", relation: "verifies" },
            { from, to: "app", relation: "observed_on" },
          ]),
          { from: "finding", to: "app", relation: "affects" },
          { from: "control", to: "finding", relation: "mitigates" },
        ],
      }),
    );
    const state = startSentinelAssessment(path);
    const revision = adaptiveRevision(state);
    advanceAdaptiveSentinel(path, state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      store.sync(revision, [{
        kind: "impact",
        depth: 7,
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        ({ nodeId }) => nodeId === "app",
      );
      assert(claim);
      const lease = {
        assessmentRevision: state.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
      };
      const ownerRequest = {
        action: "assign",
        id: "wait-for-fact",
        revision: state.revision,
        runId: state.plan.runId,
        adaptiveRevision: revision,
        taskKind: "trace",
        node: "app",
        graphRelationship: expected,
        requestId: crypto.randomUUID(),
      };
      await ownerFacts(baseDir, async (turn) => {
        assertStringIncludes(await turn(ownerRequest), "declined");
      });
      assert(
        !store.list(revision).some(({ plannerRound }) =>
          plannerRound?.graphRelationship
        ),
      );
      let ownerTaskId: string | undefined;
      await ownerFacts(baseDir, async (turn) => {
        const receipt = JSON.parse(await turn(ownerRequest)).receipt;
        assertEquals(receipt.graphRelationship, expected);
        ownerTaskId = receipt.taskId;
        assertEquals(JSON.parse(await turn(ownerRequest)).receipt, receipt);
        assertStringIncludes(
          await turn({ ...ownerRequest, graphRelationship: unrelated }),
          "unavailable",
        );
      }, true);
      let wildcardTaskId: string | undefined;
      await ownerFacts(baseDir, async (turn) => {
        const request = {
          ...ownerRequest,
          graphRelationship: wildcard,
          requestId: crypto.randomUUID(),
        };
        const receipt = JSON.parse(await turn(request)).receipt;
        assertEquals(receipt.graphRelationship, wildcard);
        wildcardTaskId = receipt.taskId;
        assertEquals(JSON.parse(await turn(request)).receipt, receipt);
      }, true);
      let supersededTaskId: string | undefined;
      await ownerFacts(baseDir, async (turn) => {
        const response = JSON.parse(
          await turn({
            ...ownerRequest,
            graphRelationship: older,
            requestId: crypto.randomUUID(),
          }),
        );
        assertEquals(response.receipt.graphRelationship, older);
        supersededTaskId = response.receipt.taskId;
      }, true);
      assert(supersededTaskId);
      const latestTask = () =>
        store.list(revision).find(({ id }) => id === wildcardTaskId);
      planner.advance(state);
      const target = () =>
        store.list(revision).find(({ plannerRound }) =>
          plannerRound?.graphRelationship?.from === expected.from
        );
      const child = () =>
        store.list(revision).find(({ nodeId }) => nodeId === "follow-up");
      const otherTarget = () =>
        store.list(revision).find(({ plannerRound }) =>
          plannerRound?.graphRelationship?.from === unrelated.from
        );
      const otherChild = () =>
        store.list(revision).find(({ nodeId }) => nodeId === "other-follow-up");
      const deadline = Date.now() + 2_000;
      while (!child() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const queued = target();
      assert(queued);
      assertEquals(queued.id, ownerTaskId);
      assertEquals(queued.status, "queued");
      const second = otherTarget();
      assert(second && second.id !== queued.id);
      assertEquals(second.status, "queued");
      assertEquals(otherChild()?.prerequisites, [second.id]);
      const ordinaryId = sentinelAdaptiveTaskId(revision, {
        kind: "trace",
        nodeId: "app",
        depth: 1,
      });
      assert(ordinaryId !== queued.id && ordinaryId !== wildcardTaskId);
      assertEquals(child()?.prerequisites, [queued.id]);
      assertEquals(child()?.status, "queued");
      const submitEdge = async (
        { requireCurrentPass: _current, ...edge }: typeof expected,
      ) => {
        const result = await worker(path, lease, [[call(assigned)], [
          call(publish, { ...edge, requestId: crypto.randomUUID() }),
        ]]);
        return JSON.parse(result.results[1][0]);
      };
      const olderFact = await submitEdge(older);
      assertEquals(olderFact.controlVerification, outcomes[older.from]);
      advanceAdaptiveSentinel(path, state);
      assertEquals(latestTask()?.status, "queued");
      const supersededGate = store.list(revision).find(({ id }) =>
        id === supersededTaskId
      );
      assertEquals(supersededGate?.status, "queued");
      assertEquals(supersededGate?.attempts, 0);
      assertEquals(supersededGate?.factSatisfaction, undefined);

      const otherFact = await submitEdge(unrelated);
      advanceAdaptiveSentinel(path, state);
      assertEquals(target()?.status, "queued");
      assertEquals(child()?.status, "queued");
      assertEquals(otherFact.controlVerification, outcomes[unrelated.from]);
      assertEquals(otherTarget()?.factSatisfaction, undefined);
      assertEquals(otherTarget()?.attempts, 0);
      assertEquals(otherChild()?.status, "queued");
      for (const requirement of [failed, future]) {
        const rejected = await submitEdge(requirement);
        assertEquals(rejected.controlVerification, outcomes[requirement.from]);
        advanceAdaptiveSentinel(path, state);
        const held = store.list(revision).find((task) =>
          task.plannerRound?.graphRelationship?.from === requirement.from
        );
        assertEquals(held?.status, "queued");
        assertEquals(held?.attempts, 0);
      }
      const fact = await submitEdge(expected);
      const workflowPlan = (id: string, graphFactId: string) => ({
        id,
        classification: "INTERNAL" as const,
        steps: [{
          id: "require-pass",
          waitSeconds: 30,
          satisfiedBy: {
            case: "wait-for-fact",
            run_id: state.plan.runId!,
            revision: state.revision,
            graph_fact_id: graphFactId,
            require_current_pass: true as const,
          },
        }, { id: "dependent" }],
      });
      let proofTime = now;
      const renewalWorkflowPlan = {
        id: "wait-for-current-control",
        classification: "INTERNAL" as const,
        steps: [{
          id: "require-pass",
          evidenceWaitSeconds: 20,
          satisfiedBy: {
            case: "wait-for-fact",
            run_id: state.plan.runId!,
            revision: state.revision,
            asset_id: "app",
            control_id: "control",
            require_current_pass: true as const,
          },
        }, { id: "dependent" }],
      };
      const selectorProbed = Promise.withResolvers<void>();
      const verifyControl = createWorkflowObservationVerifier(
        baseDir,
        undefined,
        () => proofTime,
      );
      const controlPlans = [
        workflowPlan("require-current-pass", fact.id),
        workflowPlan("reject-superseded-pass", olderFact.id),
        renewalWorkflowPlan,
      ];
      const controlWorkflow = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        controlPlans,
        join(baseDir, "control-proof-workflows.db"),
        async (requirement) => {
          const proof = await verifyControl(requirement);
          if ("asset_id" in requirement) selectorProbed.resolve();
          return proof;
        },
      );
      await ownerFacts(
        baseDir,
        async (query) => {
          for (
            const [planId, time, allowed] of [
              ["require-current-pass", now, true],
              ["reject-superseded-pass", now, false],
              [
                "require-current-pass",
                Date.parse(outcomes[expected.from].validUntil),
                false,
              ],
            ] as const
          ) {
            proofTime = time;
            const { run } = JSON.parse(
              await query({
                action: "start",
                kind: "workflow",
                id: planId,
                requestId: crypto.randomUUID(),
              }),
            );
            const ref = { kind: "workflow", id: run.ref.id };
            const status = allowed ? "completed" : "failed";
            for (
              let attempt = 0;
              attempt < 100 &&
              controlWorkflow.inspect(ref.id)?.status !== status;
              attempt++
            ) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const view = controlWorkflow.inspect(ref.id);
            assertEquals(view?.status, status);
            assertEquals(
              view?.steps[1].status,
              allowed ? "completed" : "pending",
            );
            const traces =
              JSON.parse(await query({ action: "traces", ...ref })).page.events;
            const receipt = traces.find(({ event }: { event: string }) =>
              event === "step_satisfied"
            );
            if (allowed) {
              assertEquals(receipt?.evidence.graphFactId, fact.id);
              assertEquals(
                receipt?.evidence.controlCheckedAt,
                new Date(now).toISOString(),
              );
            } else {
              assertEquals(receipt, undefined);
            }
          }
        },
        true,
        undefined,
        controlWorkflow,
      );
      const restartTemplate = workflowPlan(
        "resume-control-prerequisite",
        fact.id,
      );
      const restartPlan = {
        ...restartTemplate,
        steps: [{ ...restartTemplate.steps[0], waitSeconds: 0 }, {
          id: "dependent",
          waitSeconds: 1,
        }],
      };
      const selectorRestartPlan = {
        ...renewalWorkflowPlan,
        id: "resume-control-selector",
        steps: [renewalWorkflowPlan.steps[0], restartPlan.steps[1], {
          id: "after-dependent",
        }],
      };
      const restartPlans = [restartPlan, selectorRestartPlan];
      const liveControlJournal = join(
        baseDir,
        "control-proof-before-restart.db",
      );
      const restartedControlDir = join(baseDir, "control-proof-after-restart");
      await Deno.mkdir(restartedControlDir, { mode: 0o700 });
      const restartedControlJournal = join(restartedControlDir, "workflows.db");
      const liveControl = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        restartPlans,
        liveControlJournal,
        verifyControl,
      );
      const resumeRef = { kind: "workflow", id: "" };
      const selectorResumeRef = { kind: "workflow", id: "" };
      const expiredAt = proofTime;
      proofTime = now;
      await ownerFacts(
        baseDir,
        async (query) => {
          try {
            for (
              const [plan, ref] of [[restartPlan, resumeRef], [
                selectorRestartPlan,
                selectorResumeRef,
              ]] as const
            ) {
              const { run } = JSON.parse(
                await query({
                  action: "start",
                  kind: "workflow",
                  id: plan.id,
                  requestId: crypto.randomUUID(),
                }),
              );
              ref.id = run.ref.id;
              for (
                let attempt = 0;
                attempt < 100 &&
                liveControl.inspect(ref.id)?.steps[1].status !== "running";
                attempt++
              ) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              const statuses = liveControl.inspect(ref.id)?.steps.map((
                { status },
              ) => status);
              assertEquals(statuses?.slice(0, 2), ["completed", "running"]);
              assertEquals(
                JSON.parse(await query({ action: "pause", ...ref })).run.status,
                "paused",
              );
            }
            await Deno.copyFile(liveControlJournal, restartedControlJournal);
          } finally {
            liveControl.cancel(resumeRef.id);
            liveControl.cancel(selectorResumeRef.id);
          }
        },
        true,
        undefined,
        liveControl,
      );
      proofTime = expiredAt;
      const restartedControl = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        restartPlans,
        restartedControlJournal,
        verifyControl,
      );
      await ownerFacts(
        baseDir,
        async (query) => {
          const resumeResult = await query({ action: "resume", ...resumeRef });
          assert(!resumeResult.startsWith("Error:"), resumeResult);
          for (
            let attempt = 0;
            attempt < 100 &&
            restartedControl.inspect(resumeRef.id)?.status !== "failed";
            attempt++
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assertEquals(
            restartedControl.inspect(resumeRef.id)?.status,
            "failed",
          );
          assertEquals(
            restartedControl.inspect(resumeRef.id)?.steps.map(({ status }) =>
              status
            ),
            ["completed", "pending"],
          );
          const traces =
            JSON.parse(await query({ action: "traces", ...resumeRef })).page
              .events;
          assertEquals(
            traces.filter(({ event }: { event: string }) =>
              event === "step_satisfied"
            ).map(({ evidence }: { evidence: { graphFactId: string } }) =>
              evidence.graphFactId
            ),
            [fact.id],
          );
          assertEquals(
            traces.filter((
              { event, stepId }: { event: string; stepId?: string },
            ) => event === "step_started" && stepId === "dependent").length,
            1,
          );
        },
        true,
        undefined,
        restartedControl,
      );
      advanceAdaptiveSentinel(path, state);
      assertEquals(target()?.status, "completed");
      assertEquals(target()?.attempts, 0);
      assertEquals(latestTask()?.status, "completed");
      assertEquals(latestTask()?.attempts, 0);
      assertEquals(latestTask()?.factSatisfaction?.graphFactId, fact.id);
      assertEquals(target()?.factSatisfaction?.graphFactId, fact.id);
      const checkedAt = target()?.factSatisfaction?.checkedAt;
      assert(typeof checkedAt === "string");
      assert(checkedAt < verification(true).validUntil);
      assertEquals(child()?.status, "completed");
      const whenSuperseded = Date.parse(outcomes[future.from].observedAt);
      assert(whenSuperseded < Date.parse(verification(true).validUntil));
      assert(
        !store.controlTaskHolds(revision, whenSuperseded - 1).blocked.has(
          child()!.id,
        ),
      );
      assert(
        store.controlTaskHolds(revision, whenSuperseded).blocked.has(
          child()!.id,
        ),
      );
      const wildcardChild = store.list(revision).find(({ nodeId }) =>
        nodeId === "wildcard-child"
      );
      assert(wildcardChild);
      assert(wildcardTaskId);
      assertEquals(wildcardChild.prerequisites, [wildcardTaskId]);
      assertEquals(wildcardChild.status, "completed");
      const forWildcardChild = (task: { id: string }) =>
        task.id === wildcardChild.id;
      const originalClaim = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        forWildcardChild,
      );
      assert(originalClaim);
      const staged = {
        repository: "owner/controls",
        workflowId: 1,
        connectorId: "github-actions",
        observedAt: new Date(now).toISOString(),
        evidenceRevision: state.revision,
        resultSha256: "a".repeat(64),
        runs: [{ id: 2, status: "completed", conclusion: "success" }],
      };
      assertEquals(
        store.recordLeasedGitHubWorkflowResult(
          revision,
          wildcardChild.id,
          originalClaim.token,
          state.revision,
          staged,
        ),
        staged,
      );

      const promptDigest = createHash("sha256")
        .update("Read and record the exact assigned relationship.")
        .digest("hex");
      await worker(
        path,
        {
          assessmentRevision: state.revision,
          assignedTaskId: wildcardChild.id,
          assignedTaskLeaseToken: originalClaim.token,
        },
        [[call(assigned)]],
        undefined,
        undefined,
        (checkpoint, trace) => {
          assert(
            store.recordModelReviewProgress(
              revision,
              wildcardChild.id,
              originalClaim.token,
              trace,
            ),
          );
          assert(store.recordLeasedWorkerCheckpoint(
            revision,
            wildcardChild.id,
            originalClaim.token,
            state.revision,
            promptDigest,
            checkpoint,
          ));
        },
      );
      assert(
        store.finishModelReview(
          revision,
          wildcardChild.id,
          originalClaim.token,
          "interrupted",
        ),
      );
      const sameAuthority = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        forWildcardChild,
      );
      assert(sameAuthority);
      assertEquals(
        store.readLeasedGitHubWorkflowResult(
          revision,
          wildcardChild.id,
          sameAuthority.token,
          state.revision,
        ),
        staged,
      );

      const originalProgress = store.readLeasedModelReviewProgress(
        revision,
        wildcardChild.id,
        sameAuthority.token,
        state.revision,
      );
      assertEquals(originalProgress.length, 1);
      assertEquals(originalProgress[0].tool, assigned);
      const sameCheckpoint = store.readLeasedWorkerCheckpoint(
        revision,
        wildcardChild.id,
        sameAuthority.token,
        state.revision,
        promptDigest,
      );
      assert(
        sameCheckpoint?.history.some(({ role, content }) =>
          role === "tool" && String(content).includes("wildcard-child")
        ),
      );
      assert(
        store.finishModelReview(
          revision,
          wildcardChild.id,
          sameAuthority.token,
          "interrupted",
        ),
      );
      const downstream = {
        kind: "impact" as const,
        nodeId: "other-follow-up",
        depth: 7,
        prerequisites: [wildcardChild.id],
      };
      const independent = {
        kind: "impact" as const,
        nodeId: "other-follow-up",
        depth: 8,
      };
      store.sync(revision, [downstream, independent], revision);
      const downstreamId = sentinelAdaptiveTaskId(revision, downstream);
      const independentId = sentinelAdaptiveTaskId(revision, independent);
      await ownerFacts(baseDir, async (turn) => {
        const task = {
          action: "tasks",
          id: "wait-for-fact",
          revision: state.revision,
          taskId: downstreamId,
        };
        const at = verification(true).validUntil;
        const before = JSON.parse(
          await turn({
            ...task,
            asOf: new Date(now).toISOString(),
          }),
        );
        const held = JSON.parse(await turn({ ...task, asOf: at }));
        const unrelated = JSON.parse(
          await turn({ ...task, taskId: independentId, asOf: at }),
        );
        assertEquals(before.tasks[0].controlPrerequisiteHold, false);
        assertEquals(held.controlEvaluatedAt, at);
        assertEquals(held.tasks[0].controlPrerequisiteHold, true);
        assertEquals(held.tasks[0].controlHoldSourceCount, 1);
        const [source] = held.tasks[0].controlHoldSources;
        assertEquals(source.taskId, wildcardTaskId);
        assertEquals(source.requirement, wildcard);
        assertEquals(source.originalSatisfaction.graphFactId, fact.id);
        assertEquals(source.originalSatisfaction.sourceTaskId, fact.taskId);
        assertEquals(before.tasks[0].controlHoldSources, []);
        assertEquals(unrelated.tasks[0].controlHoldSources, []);
        assertEquals(held.tasks[0].unfinishedPrerequisites, []);
        assertEquals(unrelated.tasks[0].controlPrerequisiteHold, false);
      });
      const expiredClock = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
        () => Date.parse(verification(true).validUntil),
      );
      try {
        const childId = child()!.id;
        const forChild = (task: { id: string }) => task.id === childId;
        assert(
          store.modelReviewAvailable(
            revision,
            MODEL_ASSIGNMENT_REASON,
            forChild,
          ),
        );
        const heldLease = store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          forChild,
        );
        assert(heldLease);
        const originalNow = Date.now;
        let reads = 0;
        try {
          const probe = await worker(
            path,
            {
              assessmentRevision: state.revision,
              assignedTaskId: heldLease.task.id,
              assignedTaskLeaseToken: heldLease.token,
            },
            [[call(assigned)], [call(assigned)]],
            undefined,
            (name) => {
              if (name === assigned && ++reads === 2) {
                Date.now = () => Date.parse(verification(true).validUntil);
              }
            },
          );
          assertEquals(JSON.parse(probe.results[0][0]).target.id, "follow-up");
          assertStringIncludes(
            probe.results[1][0],
            "no available graph target",
          );
        } finally {
          Date.now = originalNow;
        }
        assertEquals(
          expiredClock.activeModelReviewTask(
            revision,
            childId,
            heldLease.token,
          ),
          undefined,
        );
        assert(
          expiredClock.finishModelReview(revision, childId, heldLease.token, {
            note: "This summary would use expired evidence.",
            steps: [],
          }),
        );
        assert(
          !store.modelReviewNotes(revision).some(({ taskId }) =>
            taskId === childId
          ),
        );
        assert(
          !expiredClock.modelReviewAvailable(
            revision,
            MODEL_ASSIGNMENT_REASON,
            forChild,
          ),
        );
        assertEquals(
          expiredClock.claimModelReview(
            revision,
            MODEL_ASSIGNMENT_REASON,
            forChild,
          ),
          null,
        );
        const unrelatedIds = new Set(
          store.list(revision).map(({ id }) => id).filter((id) =>
            id !== downstreamId && id !== independentId
          ),
        );
        const alternative = expiredClock.claim(revision, 60, unrelatedIds);
        assertEquals(alternative?.task.id, independentId);
        assertEquals(expiredClock.claim(revision, 60, unrelatedIds), null);
        assertEquals(
          store.list(revision).find(({ id }) => id === downstreamId)?.status,
          "queued",
        );
        assertEquals(
          expiredClock.claimModelReview(
            revision,
            MODEL_ASSIGNMENT_REASON,
            forWildcardChild,
          ),
          null,
        );
        const renewalRef = await (async () => {
          let ref = { kind: "workflow", id: "" };
          await ownerFacts(
            baseDir,
            async (query) => {
              const { run } = JSON.parse(
                await query({
                  action: "start",
                  kind: "workflow",
                  id: renewalWorkflowPlan.id,
                  requestId: crypto.randomUUID(),
                }),
              );
              ref = { ...ref, id: run.ref.id };
              await selectorProbed.promise;
              assertEquals(
                controlWorkflow.inspect(ref.id)?.steps.map(({ status }) =>
                  status
                ),
                ["pending", "pending"],
              );
            },
            true,
            undefined,
            controlWorkflow,
          );
          return ref;
        })();
        const renewedFact = await submitEdge(renewal);
        assertEquals(renewedFact.evidenceRevision, state.revision);
        assertEquals(renewedFact.controlVerification, outcomes[renewal.from]);
        await ownerFacts(
          baseDir,
          async (query) => {
            const resumed = JSON.parse(
              await query({ action: "resume", ...selectorResumeRef }),
            );
            assertEquals(resumed.run.status, "running");
            for (
              let attempt = 0;
              attempt < 300 &&
              restartedControl.inspect(selectorResumeRef.id)?.status !==
                "completed";
              attempt++
            ) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assertEquals(
              restartedControl.inspect(selectorResumeRef.id)?.status,
              "completed",
            );
            const traces = JSON.parse(
              await query({ action: "traces", ...selectorResumeRef }),
            ).page.events;
            assertEquals(
              traces.filter(({ event }: { event: string }) =>
                event === "step_satisfied" || event === "step_proof_renewed"
              ).map((
                { event, evidence }: {
                  event: string;
                  evidence: { graphFactId: string };
                },
              ) => [
                event,
                evidence.graphFactId,
              ]),
              [
                ["step_satisfied", fact.id],
                ["step_proof_renewed", renewedFact.id],
              ],
            );
            assert(
              traces.findIndex(({ event }: { event: string }) =>
                event === "step_proof_renewed"
              ) <
                traces.findLastIndex((
                  { event, stepId }: { event: string; stepId?: string },
                ) => event === "step_started" && stepId === "dependent"),
            );
          },
          true,
          undefined,
          restartedControl,
        );

        await ownerFacts(
          baseDir,
          async (query) => {
            for (
              let attempt = 0;
              attempt < 100 &&
              controlWorkflow.inspect(renewalRef.id)?.status !== "completed";
              attempt++
            ) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assertEquals(
              controlWorkflow.inspect(renewalRef.id)?.status,
              "completed",
            );
            assertEquals(
              controlWorkflow.inspect(renewalRef.id)?.steps[1].status,
              "completed",
            );
            const traces =
              JSON.parse(await query({ action: "traces", ...renewalRef })).page
                .events;
            assertEquals(
              traces.find(({ event }: { event: string }) =>
                event === "step_satisfied"
              )?.evidence,
              {
                assetId: "app",
                controlId: "control",
                graphFactId: renewedFact.id,
                sourceTaskId: renewedFact.taskId,
                sourceStepIndex: renewedFact.sourceStepIndex,
                resultSha256: renewedFact.resultSha256,
                caseId: "wait-for-fact",
                runId: state.plan.runId,
                revision: state.revision,
                controlCheckedAt: new Date(proofTime).toISOString(),
              },
            );
          },
          false,
          undefined,
          controlWorkflow,
        );

        assertEquals(
          expiredClock.claim(revision, 60, unrelatedIds)?.task.id,
          downstreamId,
        );
        const renewedClaim = expiredClock.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          forWildcardChild,
        );
        assertEquals(renewedClaim?.task.id, wildcardChild.id);
        assert(renewedClaim);
        const stageArgs = [
          revision,
          wildcardChild.id,
          renewedClaim.token,
          state.revision,
        ] as const;
        assertEquals(
          expiredClock.readLeasedGitHubWorkflowResult(...stageArgs),
          undefined,
        );
        assertEquals(
          expiredClock.commitLeasedWorkflowObservation(...stageArgs, 0),
          undefined,
        );
        const fresh = { ...staged, resultSha256: "b".repeat(64) };
        assertEquals(
          expiredClock.recordLeasedGitHubWorkflowResult(...stageArgs, fresh),
          fresh,
        );
        assertEquals(
          expiredClock.recordLeasedGitHubWorkflowResult(...stageArgs, staged),
          fresh,
        );
        assertEquals(
          expiredClock.readLeasedGitHubWorkflowResult(...stageArgs),
          fresh,
        );

        assertEquals(
          expiredClock.readLeasedWorkerCheckpoint(
            revision,
            wildcardChild.id,
            renewedClaim.token,
            state.revision,
            promptDigest,
          ),
          undefined,
        );
        assertEquals(
          expiredClock.readLeasedModelReviewProgress(
            revision,
            wildcardChild.id,
            renewedClaim.token,
            state.revision,
          ),
          [],
        );
        assertEquals(
          store.modelReviewProgress(revision, wildcardChild.id),
          originalProgress,
        );
        const realClock = Date.now;
        try {
          Date.now = () => Date.parse(verification(true).validUntil);
          await worker(
            path,
            {
              assessmentRevision: state.revision,
              assignedTaskId: wildcardChild.id,
              assignedTaskLeaseToken: renewedClaim.token,
            },
            [[call(assigned, { unexpected: true })]],
            undefined,
            undefined,
            (_checkpoint, trace) => {
              assert(expiredClock.recordModelReviewProgress(
                revision,
                wildcardChild.id,
                renewedClaim.token,
                trace,
              ));
            },
          );
        } finally {
          Date.now = realClock;
        }
        const freshProgress = expiredClock.readLeasedModelReviewProgress(
          revision,
          wildcardChild.id,
          renewedClaim.token,
          state.revision,
        );
        assertEquals(
          freshProgress.map(({ tool, outcome }) => [tool, outcome]),
          [[assigned, "error"]],
        );
        assertEquals(
          expiredClock.claimModelReview(
            revision,
            MODEL_ASSIGNMENT_REASON,
            forChild,
          ),
          null,
        );
        const renewals = store.history(revision).filter(({ event }) =>
          event === "control_prerequisite_renewed"
        );
        assertEquals(renewals.length, 1);
        assertEquals(renewals[0].taskId, wildcardTaskId);
        const proof = {
          initialGraphFactId: fact.id,
          graphFactId: renewedFact.id,
          sourceTaskId: renewedFact.taskId,
          sourceObservationSha256: renewedFact.resultSha256,
          evidenceRevision: state.revision,
        };
        assertEquals(JSON.parse(renewals[0].note!), proof);
        const reopened = openSentinelAdaptiveStore(
          join(dirname(path), "sentinel-adaptive.db"),
        );
        try {
          const history = reopened.history(revision);
          for (
            const [taskId, action] of [
              [downstreamId, "claimed"],
              [wildcardChild.id, "model_review_claimed"],
            ]
          ) {
            const matching = history.find((item) =>
              item.taskId === taskId && item.event === action
            );
            assert(matching?.note);
            assertEquals(JSON.parse(matching.note), {
              controlPrerequisites: [{
                requirementTaskId: wildcardTaskId,
                ...proof,
              }],
            });
            assertEquals(matching.at, renewals[0].at);
          }
          assertEquals(
            history.find((item) =>
              item.taskId === independentId && item.event === "claimed"
            )?.note,
            null,
          );
        } finally {
          reopened.close();
        }
        assertEquals(target()?.factSatisfaction?.graphFactId, fact.id);
      } finally {
        expiredClock.close();
      }
      const historical = readHistoricalAdaptiveSentinel(path, state.revision);
      assert(historical);
      const provenance = buildSentinelProvenance(state.result, historical)
        .snapshot();
      const assignment = provenance.nodes.find(({ sourceId }) =>
        sourceId === queued.id
      );
      const latestAssignment = provenance.nodes.find(({ sourceId }) =>
        sourceId === wildcardTaskId
      );
      assert(latestAssignment && "factSatisfaction" in latestAssignment);
      assertEquals(latestAssignment.factSatisfaction?.graphFactId, fact.id);
      const source = provenance.nodes.find(({ sourceId }) =>
        sourceId === fact.id
      );
      assert(assignment && source);
      assert(
        provenance.edges.some(({ from, to, relation }) =>
          from === assignment.id && to === source.id &&
          relation === "references"
        ),
      );
      const heldTask = {
        kind: "trace" as const,
        nodeId: "follow-up",
        depth: 9,
        prerequisites: [queued.id],
      };
      store.sync(revision, [heldTask], revision);
      const heldTaskId = sentinelAdaptiveTaskId(revision, heldTask);
      assert(!store.controlTaskHolds(revision, now).blocked.has(heldTaskId));
      assert(recordSentinelOperatingConstraints(path, {
        runId: state.plan.runId!,
        evidenceRevision: state.revision,
        expectedVersion: 0,
        requestId: crypto.randomUUID(),
        operatorScope: "owner",
        constraints: { allowedAssetIds: ["follow-up"], deniedKinds: [] },
      }));
      advanceAdaptiveSentinel(path, state);
      await ownerFacts(baseDir, async (turn) => {
        const result = JSON.parse(
          await turn({
            action: "tasks",
            id: "wait-for-fact",
            revision: state.revision,
            taskId: heldTaskId,
            asOf: new Date(now).toISOString(),
          }),
        );
        assertEquals(result.tasks[0].status, "queued");
        assertEquals(result.tasks[0].controlPrerequisiteHold, true);
        assertEquals(result.tasks[0].controlHoldSources[0].taskId, queued.id);
      });
    } finally {
      store.close();
    }
  } finally {
    planner.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Sentinel publishes a retained control outcome from the assigned asset and verified mitigation and DNS facts for peers and planning", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const verification = {
    outcome: "pass",
    observedAt: "2025-01-01T00:00:00.000Z",
    validUntil: "2025-01-02T00:00:00.000Z",
  };
  const relationship = {
    from: "approved",
    to: "control",
    relation: "verifies",
  };
  const mitigation = {
    from: "control",
    to: "finding",
    relation: "mitigates" as const,
  };
  const resolution = {
    from: "hostname",
    to: "address",
    relation: "resolved_to" as const,
  };
  const foreignResolution = { ...resolution, from: "other-hostname" };
  const resolutionArgs = { ...resolution, requestId: crypto.randomUUID() };
  const otherMitigation = { ...mitigation, to: "other-finding" };
  const mitigationArgs = { ...mitigation, requestId: crypto.randomUUID() };
  const unrelated = { from: "outside", to: "control", relation: "verifies" };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Assigned application" },
          { id: "other", kind: "asset", label: "Other application" },
          ...["hostname", "other-hostname", "address"].map((id) => ({
            id,
            kind: "asset",
            label: id,
          })),
          { id: "finding", kind: "finding", label: "Finding", severity: "low" },
          { id: "control", kind: "control", label: "Control under review" },
          {
            id: "other-finding",
            kind: "finding",
            label: "Other finding",
            severity: "low",
          },
          ...["approved", "outside"].map((id) => ({
            id,
            kind: "evidence",
            label: id,
            controlVerification: verification,
          })),
        ],
        edges: [
          relationship,
          unrelated,
          { from: "approved", to: "app", relation: "observed_on" },
          { from: "outside", to: "other", relation: "observed_on" },
          { from: "finding", to: "app", relation: "affects" },
          mitigation,
          otherMitigation,
          resolution,
          foreignResolution,
          { from: "app", to: "hostname", relation: "uses_hostname" },
          { from: "other", to: "other-hostname", relation: "uses_hostname" },
          { from: "other-finding", to: "other", relation: "affects" },
        ],
      }),
    );
    const state = startSentinelAssessment(path);
    const revision = adaptiveRevision(state);
    advanceAdaptiveSentinel(path, state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      store.sync(
        revision,
        [7, 8].map((depth) => ({
          kind: "trace",
          nodeId: "app",
          depth,
          reason: MODEL_ASSIGNMENT_REASON,
        })),
        revision,
      );
      advanceAdaptiveSentinel(path, state);
      const lease = (depth: number): Lease => {
        const claim = store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          (task) => task.nodeId === "app" && task.depth === depth,
        );
        assert(claim);
        return {
          assessmentRevision: state.revision,
          assignedTaskId: claim.task.id,
          assignedTaskLeaseToken: claim.token,
        };
      };
      const producer = lease(7);
      const peer = lease(8);
      const args = { ...relationship, requestId: crypto.randomUUID() };
      const denied = await worker(path, producer, [[call(assigned)], [
        call(publish, args),
        call(publish, mitigationArgs),
        call(publish, resolutionArgs),
      ]], "assigned");
      for (const result of denied.results[1]) {
        assertStringIncludes(result, "unavailable");
      }
      const published = await worker(path, producer, [[call(assigned)], [
        call(publish, { ...unrelated, requestId: crypto.randomUUID() }),
        call(publish, args),
        call(publish, args),
        call(publish, { ...otherMitigation, requestId: crypto.randomUUID() }),
        call(publish, mitigationArgs),
        call(publish, mitigationArgs),
      ]]);
      const dns = await worker(path, producer, [[call(assigned)], [
        call(publish, { ...foreignResolution, requestId: crypto.randomUUID() }),
        call(publish, resolutionArgs),
        call(publish, resolutionArgs),
      ]]);
      assertEquals(JSON.parse(dns.results[0][0]).hostnameResolutions, [
        resolution,
      ]);
      assertStringIncludes(dns.results[1][0], "unavailable");
      const dnsFact = JSON.parse(dns.results[1][1]);
      assertEquals(dnsFact.relationship, resolution);
      assertEquals(dns.results[1][1], dns.results[1][2]);
      assertEquals(
        dns.trace.at(dnsFact.sourceStepIndex)?.resultSha256,
        dnsFact.resultSha256,
      );
      assertEquals(JSON.parse(published.results[0][0]).controlChecks, [{
        relationship,
        findingId: "finding",
        controlVerification: verification,
      }]);
      assertStringIncludes(published.results[1][0], "unavailable");
      assertEquals(
        JSON.parse(published.results[0][0]).mitigationRelationships,
        [mitigation],
      );
      assertStringIncludes(published.results[1][3], "unavailable");
      const mitigationFact = JSON.parse(published.results[1][4]);
      assertEquals(mitigationFact.relationship, mitigation);
      assertEquals(mitigationFact.controlVerification, undefined);
      assertEquals(published.results[1][5], published.results[1][4]);
      assertEquals(
        published.trace.at(mitigationFact.sourceStepIndex)?.resultSha256,
        mitigationFact.resultSha256,
      );
      const fact = JSON.parse(published.results[1][1]);
      assertEquals(fact.controlVerification, verification);
      assertEquals(fact.relationship, relationship);
      assertEquals(published.results[1][2], published.results[1][1]);
      assertEquals(
        published.trace.at(fact.sourceStepIndex)?.resultSha256,
        fact.resultSha256,
      );
      const opened = await worker(path, peer, [[
        call(read, { id: fact.id }),
        call(read, { id: mitigationFact.id }),
        call(read, { id: dnsFact.id }),
      ]]);
      assertEquals(JSON.parse(opened.results[0][0]), fact);
      assertEquals(JSON.parse(opened.results[0][1]), mitigationFact);
      assertEquals(JSON.parse(opened.results[0][2]), dnsFact);
      await ownerFacts(baseDir, async (query) => {
        const saved = JSON.parse(
          await query({
            id: "main",
            revision: state.revision,
            factId: fact.id,
          }),
        ).page.fact;
        assertEquals(saved.controlVerification, verification);
        assertEquals(saved.resultSha256, fact.resultSha256);
      });
      const seen = Promise.withResolvers<unknown>();
      const scopedFacts = Promise.withResolvers<unknown>();
      const planner = createSentinelModelPlanner(path, (_case, assignment) => ({
        execute(prompt, send) {
          if (!assignment) {
            const inputs = JSON.parse(String(prompt).split("\n").at(-1)!);
            if (inputs.operatingConstraints?.version === 1) {
              scopedFacts.resolve(inputs.graphFacts ?? []);
              send({ type: "response", taint: "INTERNAL", text: "[]" });
              return Promise.resolve();
            }
            seen.resolve(inputs.graphFacts);
            send({
              type: "response",
              text: JSON.stringify(
                [
                  ...[
                    mitigation,
                    otherMitigation,
                    resolution,
                    foreignResolution,
                  ]
                    .map((graphRelationship) => ({
                      kind: "trace",
                      nodeId: "app",
                      depth: 1,
                      graphFactOnly: true,
                      graphRelationship,
                    })),
                  ...[
                    ["app", [mitigationFact.id, dnsFact.id]],
                    ["app", [mitigationFact.id, mitigationFact.id]],
                    ["other", [mitigationFact.id, dnsFact.id]],
                    ["app", [
                      mitigationFact.id,
                      "worker-graph-fact:" + "0".repeat(64),
                    ]],
                  ].map(([nodeId, graphFactIds]) => ({
                    kind: "trace",
                    nodeId,
                    depth: 1,
                    graphFactIds,
                  })),
                ],
              ),
              taint: "INTERNAL",
            });
          }
          return Promise.resolve();
        },
        clear() {},
      }));
      const timer = setTimeout(
        () => seen.reject(new Error("No control fact planning round")),
        2_000,
      );
      try {
        planner.advance(state);
        assertEquals(await seen.promise, [{
          id: dnsFact.id,
          targetId: "app",
          taskId: producer.assignedTaskId,
          relationship: resolution,
          resultSha256: dnsFact.resultSha256,
        }, {
          id: mitigationFact.id,
          targetId: "app",
          taskId: producer.assignedTaskId,
          relationship: mitigation,
          resultSha256: mitigationFact.resultSha256,
        }, {
          id: fact.id,
          targetId: "app",
          taskId: producer.assignedTaskId,
          relationship,
          resultSha256: fact.resultSha256,
          controlVerification: verification,
        }]);
        for (
          let attempt = 0;
          attempt < 50 && planner.hasInFlightWork();
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        advanceAdaptiveSentinel(path, state);
        const factAssignments = store.list(revision).filter(
          (task) => task.plannerRound?.graphFactOnly,
        );
        assertEquals(factAssignments.length, 2);
        const combined = store.list(revision).filter(
          (task) => task.plannerRound?.sourceEvidence,
        );
        assertEquals(combined.length, 1);
        const followup = combined[0];
        assertEquals(followup.nodeId, "app");
        assertEquals(followup.prerequisites, [producer.assignedTaskId]);
        const sources = followup.plannerRound!.sourceEvidence!;
        assertEquals(
          sources,
          [mitigationFact, dnsFact].map((fact) => ({
            id: fact.id,
            taskId: producer.assignedTaskId,
            evidenceRevision: state.revision,
            digest: fact.resultSha256,
            sourceStepIndex: fact.sourceStepIndex,
          })).sort((a, b) => a.id.localeCompare(b.id)),
        );
        await ownerFacts(baseDir, async (query) => {
          const node = `task:adaptive:${followup.id}`;
          const detail = JSON.parse(
            await query({
              action: "node",
              id: "main",
              revision: state.revision,
              node,
            }),
          ).page;
          assertEquals(
            detail.connections.filter(({ from, relation }: {
              from: string;
              relation: string;
            }) => from === node && relation === "references")
              .map(({ to }: { to: string }) => to).sort(),
            sources.map(({ id }) => `observation:adaptive:${id}`).sort(),
          );
          for (const source of sources) {
            const record = JSON.parse(
              await query({
                id: "main",
                revision: state.revision,
                factId: source.id,
              }),
            ).page.fact;
            assertEquals(record.resultSha256, source.digest);
            assertEquals(record.sourceStepIndex, source.sourceStepIndex);
            assertEquals(record.taskId, source.taskId);
          }
        });
        for (
          const [graphRelationship, fact] of [[mitigation, mitigationFact], [
            resolution,
            dnsFact,
          ]] as const
        ) {
          const satisfied = factAssignments.find((assignment) =>
            assignment.plannerRound?.graphRelationship?.relation ===
              graphRelationship.relation
          );
          assert(satisfied);
          assertEquals(
            satisfied.plannerRound?.graphRelationship,
            graphRelationship,
          );
          assertEquals(satisfied.status, "completed");
          assertEquals(satisfied.attempts, 0);
          assertEquals(satisfied.factSatisfaction?.graphFactId, fact.id);
        }
        assert(recordSentinelOperatingConstraints(path, {
          runId: state.plan.runId!,
          evidenceRevision: state.revision,
          expectedVersion: 0,
          requestId: crypto.randomUUID(),
          operatorScope: "owner",
          constraints: {
            allowedAssetIds: ["app", "hostname"],
            deniedKinds: [],
          },
        }));
        const restricted = await worker(path, peer, [
          [call(assigned)],
          [call(publish, { ...resolution, requestId: crypto.randomUUID() })],
        ]);
        assertEquals(
          JSON.parse(restricted.results[0][0]).hostnameResolutions,
          undefined,
        );
        assertStringIncludes(restricted.results[1][0], "unavailable");
        planner.advance(state);
        const scopeTimeout = setTimeout(
          () =>
            scopedFacts.reject(
              new Error("No policy-filtered fact planning round"),
            ),
          2_000,
        );
        try {
          const currentFacts = await scopedFacts.promise;
          assertEquals(
            (currentFacts as { id: string }[]).map(({ id }) => id),
            [mitigationFact.id, fact.id],
          );
        } finally {
          clearTimeout(scopeTimeout);
        }
      } finally {
        clearTimeout(timer);
        planner.stop();
      }
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Pending graph fact requirements and dependent work carry only into compatible evidence revisions", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, "control-rollover");
  const requirement = (to: string) => ({
    to,
    relation: "verifies" as const,
    requireCurrentPass: true as const,
  });
  const relationship = { from: "finding", to: "app", relation: "affects" };
  const now = Date.now();
  const snapshot = (second: boolean) => ({
    version: 1,
    nodes: [
      ...["app", "child", "other-child", "relationship-child"].map((id) => ({
        id,
        kind: "asset",
        label: id,
      })),
      ...["control", "removed"].map((id) => ({
        id,
        kind: "control",
        label: id,
      })),
      { id: "finding", kind: "finding", label: "Finding", severity: "low" },
      {
        id: second ? "new-check" : "previous-check",
        kind: "evidence",
        label: "Control evidence",
        controlVerification: {
          outcome: second ? "pass" : "fail",
          observedAt: new Date(now - 1000).toISOString(),
          validUntil: new Date(now + 60_000).toISOString(),
        },
      },
    ],
    edges: [
      { from: "finding", to: "app", relation: "affects" },
      { from: "control", to: "finding", relation: "mitigates" },
      ...(!second
        ? [{ from: "removed", to: "finding", relation: "mitigates" }]
        : []),
      {
        from: second ? "new-check" : "previous-check",
        to: "app",
        relation: "observed_on",
      },
      {
        from: second ? "new-check" : "previous-check",
        to: "control",
        relation: "verifies",
      },
    ],
  });
  await Deno.mkdir(dirname(path), { recursive: true });
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot(false)));
    const first = startSentinelAssessment(path);
    const firstRevision = adaptiveRevision(first);
    advanceAdaptiveSentinel(path, first);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      store.sync(firstRevision, [{
        kind: "trace",
        depth: 7,
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], firstRevision);
      advanceAdaptiveSentinel(path, first);
      const claim = store.claimModelReview(
        firstRevision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.depth === 7,
      );
      assert(claim);
      const request = {
        action: "assign",
        id: "control-rollover",
        revision: first.revision,
        runId: first.plan.runId,
        adaptiveRevision: firstRevision,
        taskKind: "trace",
        node: "app",
      };
      for (const control of ["control", "removed"]) {
        await ownerFacts(baseDir, async (turn) => {
          const output = JSON.parse(
            await turn({
              ...request,
              requestId: crypto.randomUUID(),
              graphRelationship: requirement(control),
            }),
          );
          assertEquals(output.receipt.graphRelationship, requirement(control));
        }, true);
      }
      planner = createSentinelModelPlanner(path, (_case, assignment) => ({
        execute(_prompt, send) {
          if (!assignment) {
            send({
              type: "response",
              taint: "INTERNAL",
              text: JSON.stringify([
                ...[
                  requirement("control"),
                  requirement("removed"),
                  relationship,
                ]
                  .flatMap((graphRelationship, index) => [
                    {
                      kind: "trace",
                      nodeId: "app",
                      depth: 1,
                      graphFactOnly: true,
                      graphRelationship,
                    },
                    {
                      kind: "impact",
                      nodeId:
                        ["child", "other-child", "relationship-child"][index],
                      dependsOn: [2 * index],
                    },
                  ]),
              ]),
            });
          }
          return Promise.resolve();
        },
        clear() {},
      }));
      planner.advance(first);
      const deadline = Date.now() + 2000;
      while (
        !store.list(firstRevision).some(({ nodeId }) =>
          nodeId === "relationship-child"
        ) && Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      planner.stop();
      const oldTasks = store.list(firstRevision);
      const oldGate = oldTasks.find(({ plannerRound }) =>
        plannerRound?.graphRelationship?.to === "control"
      );
      const oldChild = oldTasks.find(({ nodeId }) => nodeId === "child");
      assert(oldGate && oldChild);
      assertEquals(oldChild.prerequisites, [oldGate.id]);
      assertEquals(oldChild.status, "queued");
      const oldReceipt = await worker(path, {
        assessmentRevision: first.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
      }, [[call(assigned)], [call(publish, {
        from: "previous-check",
        to: "control",
        relation: "verifies",
        requestId: crypto.randomUUID(),
      })]]);
      const oldFact = JSON.parse(oldReceipt.results[1][0]);
      assertEquals(oldFact.controlVerification.outcome, "fail");

      await Deno.writeTextFile(path, JSON.stringify(snapshot(true)));
      const second = refreshSentinelAssessment(path);
      assert(second && second.revision > first.revision);
      const next = adaptiveRevision(second);
      advanceAdaptiveSentinel(path, second);
      const tasks = () => store.list(next);
      const gate = tasks().find(({ plannerRound }) =>
        plannerRound?.graphRelationship?.to === "control"
      );
      const child = tasks().find(({ nodeId }) => nodeId === "child");
      assert(
        gate && child && gate.id !== oldGate.id && child.id !== oldChild.id,
      );
      assertEquals(
        gate.plannerRound?.graphRelationship,
        requirement("control"),
      );
      assertEquals(gate.status, "queued");
      assertEquals(gate.factSatisfaction, undefined);
      assertEquals(child.prerequisites, [gate.id]);
      assertEquals(child.status, "queued");
      assert(
        !tasks().some(({ nodeId, plannerRound }) =>
          nodeId === "other-child" ||
          plannerRound?.graphRelationship?.to === "removed"
        ),
      );

      const relationshipGate = tasks().find(({ plannerRound }) =>
        plannerRound?.graphRelationship?.relation === "affects"
      );
      const relationshipChild = tasks().find(({ nodeId }) =>
        nodeId === "relationship-child"
      );
      assert(relationshipGate && relationshipChild);
      assertEquals(relationshipGate.status, "queued");
      assertEquals(relationshipChild.prerequisites, [relationshipGate.id]);
      assertEquals(relationshipChild.status, "queued");

      const nextClaim = store.claimModelReview(
        next,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.depth === 7,
      );
      assert(nextClaim);
      const published = await worker(path, {
        assessmentRevision: second.revision,
        assignedTaskId: nextClaim.task.id,
        assignedTaskLeaseToken: nextClaim.token,
      }, [[call(read, { id: oldFact.id }), call(assigned)], [
        call(publish, {
          from: "new-check",
          to: "control",
          relation: "verifies",
          requestId: crypto.randomUUID(),
        }),
        call(publish, {
          ...relationship,
          requestId: crypto.randomUUID(),
        }),
      ]]);
      assertStringIncludes(published.results[0][0], "unavailable");
      const newFact = JSON.parse(published.results[1][0]);
      assertEquals(newFact.evidenceRevision, second.revision);
      advanceAdaptiveSentinel(path, second);
      const relationshipFact = JSON.parse(published.results[1][1]);
      const satisfiedRelationship = tasks().find(({ id }) =>
        id === relationshipGate.id
      );
      assertEquals(relationshipFact.evidenceRevision, second.revision);
      assertEquals(
        satisfiedRelationship?.factSatisfaction?.graphFactId,
        relationshipFact.id,
      );
      assertEquals(satisfiedRelationship?.attempts, 0);
      assertEquals(
        tasks().find(({ id }) => id === relationshipChild.id)?.status,
        "completed",
      );
      const satisfied = tasks().find(({ id }) => id === gate.id);
      assertEquals(satisfied?.factSatisfaction?.graphFactId, newFact.id);
      assertEquals(satisfied?.attempts, 0);
      assertEquals(
        tasks().find(({ id }) => id === child.id)?.status,
        "completed",
      );
    } finally {
      store.close();
    }
  } finally {
    planner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Owner workflows wait for an original finding and preserve the exact passing recheck across restart", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "workflow-recheck";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const checkTime = Date.now();
  const validUntil = new Date(checkTime + 60_000).toISOString();
  const graph = (remediated: boolean) => {
    const checks = [
      {
        id: "failed-check",
        outcome: "fail",
        observedAt: new Date(checkTime - 120_000).toISOString(),
      },
      ...(remediated
        ? [{
          id: "passing-check",
          outcome: "pass",
          observedAt: new Date(checkTime - 60_000).toISOString(),
        }]
        : []),
    ];
    return {
      version: 1,
      nodes: [
        { id: "asset", kind: "asset", label: "Fixture asset" },
        ...["finding", "other-finding"].map((id) => ({
          id,
          kind: "finding",
          label: "Control failure",
          severity: "high",
        })),
        { id: "control", kind: "control", label: "Fixture control" },
        ...checks.map(({ id, outcome, observedAt }) => ({
          id,
          kind: "evidence",
          label: id,
          controlVerification: { outcome, observedAt, validUntil },
        })),
      ],
      edges: [
        ...["finding", "other-finding"].flatMap((id) => [
          { from: id, to: "asset", relation: "affects" },
          { from: "control", to: id, relation: "mitigates" },
        ]),
        ...checks.flatMap(({ id }) => [
          { from: id, to: "control", relation: "verifies" },
          { from: id, to: "asset", relation: "observed_on" },
        ]),
      ],
    };
  };
  const readLease = (state: ReturnType<typeof startSentinelAssessment>) => {
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      const revision = adaptiveRevision(state);
      store.sync(revision, [{
        kind: "trace",
        depth: 5,
        nodeId: "asset",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.depth === 5,
      );
      assert(claim);
      return {
        assessmentRevision: state.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
      };
    } finally {
      store.close();
    }
  };
  const waitFor = async (ready: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!ready() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(ready());
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(graph(false)));
    const initial = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, initial);
    const [original, unrelated] = (await worker(path, readLease(initial), [
      [call(assigned)],
      ["finding", "other-finding"].map((graphFindingId) =>
        call("sentinel_report_finding", {
          graphFindingId,
          controlId: "control",
          evidenceId: "failed-check",
          requestId: crypto.randomUUID(),
          title: "One verified failed control",
          summary: "Original retained result.",
        })
      ),
    ])).results[1].map((result) =>
      JSON.parse(result).record as SentinelWorkerFindingRecord
    );
    assertEquals(original.kind, "finding");
    assertEquals(unrelated.kind, "finding");
    assert(original.id !== unrelated.id);

    let constraintVersion = 0;
    const reviewConstraints = (
      evidenceRevision: number,
      allowedAssetIds?: readonly string[],
    ) => {
      const updated = recordSentinelOperatingConstraints(path, {
        runId: original.runId,
        evidenceRevision,
        expectedVersion: constraintVersion,
        requestId: crypto.randomUUID(),
        operatorScope: "owner",
        constraints: {
          deniedKinds: [],
          ...(allowedAssetIds && { allowedAssetIds }),
        },
      });
      assert(updated);
      constraintVersion = updated.version;
    };
    const originalGrant = {
      case: caseId,
      run_id: original.runId,
      revision: initial.revision,
      observation_id: original.id,
    };
    let savedFindingProjection: Record<string, unknown> | undefined;
    const verifyOriginal = (projection: Record<string, unknown>) => {
      if (savedFindingProjection) {
        assertEquals(projection, savedFindingProjection);
      }
      savedFindingProjection = projection;
      assertEquals(projection, {
        _classification: "INTERNAL",
        kind: "finding",
        finding: {
          id: original.id,
          caseId,
          runId: original.runId,
          evidenceRevision: initial.revision,
          taskId: original.taskId,
          recordedAt: original.recordedAt,
          assetId: original.targetId,
          graphFindingId: original.graphFindingId,
          evidenceId: original.evidenceId,
          controlId: original.controlId,
          snapshotDigest: original.snapshotDigest,
          outcome: "fail",
          observedAt: original.observedAt,
          validUntil: original.validUntil,
          evaluatedAt: original.evaluatedAt,
        },
      });
    };
    await verifyDelegatedObservationGrant(
      baseDir,
      originalGrant,
      verifyOriginal,
      () => reviewConstraints(initial.revision, []),
      () => reviewConstraints(initial.revision),
    );
    for (const kind of ["webhook", "cron", "trigger"] as const) {
      await verifyScheduledObservationGrant(
        baseDir,
        originalGrant,
        verifyOriginal,
        kind,
      );
    }

    await Deno.writeTextFile(path, JSON.stringify(graph(true)));
    const current = refreshSentinelAssessment(path);
    assert(current && current.revision > initial.revision);
    assertStringIncludes(
      await createScheduledObservationRead(baseDir, originalGrant, undefined)(
        {},
      ),
      "unavailable",
    );
    advanceAdaptiveSentinel(path, current);
    const lease = readLease(current);
    const { runId } = current.plan;
    assert(runId);
    let evidenceClock = checkTime;
    const verify = createWorkflowObservationVerifier(
      baseDir,
      undefined,
      () => evidenceClock,
    );
    const findingRequirement = {
      case: caseId,
      run_id: runId,
      revision: current.revision,
      finding_id: original.id,
    };
    const waitingPlan = {
      id: "waiting-for-recheck",
      classification: "INTERNAL" as const,
      steps: [
        {
          id: "verify",
          satisfiedBy: findingRequirement,
          evidenceWaitSeconds: 8,
        },
        { id: "dependent" },
      ],
    };
    const selectorJournal = join(baseDir, "selector-workflows.db");
    const recoveredSelectorJournal = join(
      baseDir,
      "recovered-selector-workflows.db",
    );
    const selectorProbed = Promise.withResolvers<void>();
    const selector = createOperatorWorkflowRuns(
      createWorkflowRunRegistry(),
      [waitingPlan],
      selectorJournal,
      async (requirement) => {
        const proof = await verify(requirement);
        assertEquals(proof, undefined);
        selectorProbed.resolve();
        return proof;
      },
    );
    const selectorRef = { kind: "workflow", id: "" };
    let waitingDeadline = "";
    await ownerFacts(
      baseDir,
      async (query) => {
        selectorRef.id = JSON.parse(
          await query({
            action: "start",
            kind: "workflow",
            id: waitingPlan.id,
            requestId: crypto.randomUUID(),
          }),
        ).run.ref.id;
        await selectorProbed.promise;
        try {
          const events =
            JSON.parse(await query({ action: "traces", ...selectorRef })).page
              .events;
          waitingDeadline = events.find(({ event }: { event: string }) =>
            event === "step_waiting"
          )?.deadlineAt;
          assert(waitingDeadline);
          assertEquals(
            selector.inspect(selectorRef.id)?.steps.map(({ status }) => status),
            ["pending", "pending"],
          );
          await Deno.copyFile(selectorJournal, recoveredSelectorJournal);
        } finally {
          selector.cancel(selectorRef.id);
          await waitFor(() =>
            selector.inspect(selectorRef.id)?.status === "cancelled"
          );
        }
      },
      true,
      undefined,
      selector,
    );
    const recoveredProbed = Promise.withResolvers<void>();
    const recoveredSelector = createOperatorWorkflowRuns(
      createWorkflowRunRegistry(),
      [waitingPlan],
      recoveredSelectorJournal,
      async (requirement) => {
        const proof = await verify(requirement);
        recoveredProbed.resolve();
        return proof;
      },
    );
    assertEquals(recoveredSelector.recoverWaiting(), [selectorRef.id]);
    await recoveredProbed.promise;
    const publishRecheck = async (
      findingId: string,
    ): Promise<SentinelWorkerFindingRecheckRecord> => {
      const recheckCall = call("sentinel_record_finding_recheck", {
        findingId,
        evidenceId: "passing-check",
        requestId: crypto.randomUUID(),
        summary: "Observed a newer passing check.",
      });
      const [committed, duplicate] = (await worker(path, lease, [
        [call(assigned)],
        [recheckCall, recheckCall],
      ])).results[1].map((result) => JSON.parse(result).record);
      assertEquals(duplicate, committed);
      return committed;
    };
    let recheck: SentinelWorkerFindingRecheckRecord;
    try {
      const wrong = await publishRecheck(unrelated.id);
      assertEquals(wrong.outcome, "pass");
      assertEquals(wrong.findingId, unrelated.id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assertEquals(
        recoveredSelector.inspect(selectorRef.id)?.steps.map(({ status }) =>
          status
        ),
        ["pending", "pending"],
      );
      const beforePublish = performance.now();
      recheck = await publishRecheck(original.id);
      await waitFor(() =>
        recoveredSelector.inspect(selectorRef.id)?.status === "completed"
      );
      assert(
        performance.now() - beforePublish < 1700,
        "Expected publication to wake before the fallback poll",
      );
      assertEquals(recheck.outcome, "pass");
      assertEquals(recheck.findingId, original.id);
      await ownerFacts(
        baseDir,
        async (query) => {
          const events = JSON.parse(
            await query({ action: "traces", ...selectorRef }),
          ).page.events as readonly {
            event: string;
            deadlineAt?: string;
            evidence?: {
              findingRecheckId: string;
              findingId: string;
              sourceTaskId: string;
            };
            stepId?: string;
          }[];
          assertEquals(
            events.filter(({ event }) => event === "step_waiting")
              .map(({ deadlineAt }) => deadlineAt),
            [waitingDeadline],
          );
          const satisfied = events.filter(({ event }) =>
            event === "step_satisfied"
          );
          assertEquals(satisfied.length, 1);
          assertEquals(satisfied[0].evidence?.findingRecheckId, recheck.id);
          assertEquals(satisfied[0].evidence?.findingId, original.id);
          assertEquals(satisfied[0].evidence?.sourceTaskId, recheck.taskId);
          assertEquals(
            events.filter(({ event, stepId }) =>
              event === "step_started" && stepId === "dependent"
            ).length,
            1,
          );
        },
        true,
        undefined,
        recoveredSelector,
      );
    } finally {
      recoveredSelector.cancel(selectorRef.id);
    }
    await ownerFacts(
      baseDir,
      async (query) => {
        const originalRef = { id: caseId, revision: initial.revision };
        const listed = JSON.parse(
          await query({
            ...originalRef,
            action: "finding_receipts",
            limit: 1,
          }),
        ).page;
        assertEquals(listed.records.length, 1);
        assert(listed.nextCursor);
        const next = JSON.parse(
          await query({
            ...originalRef,
            action: "finding_receipts",
            cursor: listed.nextCursor,
          }),
        ).page;
        assertEquals(
          new Set([
            listed.records[0].id,
            next.records[0].id,
          ]),
          new Set([original.id, unrelated.id]),
        );
        const record = JSON.parse(
          await query({
            ...originalRef,
            action: "finding_receipt",
            receiptId: original.id,
          }),
        ).record;
        assertEquals(record, original);
        const actualRecheck = JSON.parse(
          await query({
            id: caseId,
            revision: current.revision,
            action: "finding_receipt",
            receiptId: recheck.id,
          }),
        ).record;
        assertEquals(actualRecheck, recheck);
        assertStringIncludes(
          await query({
            ...originalRef,
            action: "finding_receipt",
            receiptId: recheck.id,
          }),
          "unavailable",
        );
        assertStringIncludes(
          await query({
            ...originalRef,
            action: "amend_finding_report",
            receiptId: original.id,
          }),
          "unavailable",
        );
      },
      false,
      undefined,
      undefined,
      true,
    );
    const grant = {
      case: caseId,
      run_id: runId,
      revision: current.revision,
      observation_id: recheck.id,
    };
    let savedProjection: Record<string, unknown> | undefined;
    const verifyRecheck = (projection: Record<string, unknown>) => {
      if (savedProjection) assertEquals(projection, savedProjection);
      savedProjection = projection;
      assertEquals(projection._classification, "INTERNAL");
      assertEquals(projection.kind, "finding_recheck");
      const originalEvidence = projection.finding as Record<string, unknown>;
      const newEvidence = projection.recheck as Record<string, unknown>;
      assertEquals(newEvidence.findingId, original.id);
      assertEquals(originalEvidence.outcome, "fail");
      for (
        const [value, record] of [[originalEvidence, original], [
          newEvidence,
          recheck,
        ]] as const
      ) {
        for (
          const field of [
            "id",
            "caseId",
            "runId",
            "evidenceRevision",
            "taskId",
            "graphFindingId",
            "controlId",
            "evidenceId",
            "snapshotDigest",
            "evaluatedAt",
            "observedAt",
            "validUntil",
          ] as const
        ) {
          assertEquals(value[field], record[field]);
        }
        assertEquals(value.assetId, "asset");
        assert(!Object.hasOwn(value, "summary"));
        assert(!Object.hasOwn(value, "title"));
        assert(!Object.hasOwn(value, "requestId"));
      }
      assertEquals(newEvidence.outcome, "pass");
    };
    await verifyDelegatedObservationGrant(
      baseDir,
      grant,
      verifyRecheck,
      () => reviewConstraints(current.revision, []),
      () => reviewConstraints(current.revision),
    );
    for (const kind of ["webhook", "cron", "trigger"] as const) {
      await verifyScheduledObservationGrant(
        baseDir,
        grant,
        verifyRecheck,
        kind,
      );
    }
    assertStringIncludes(
      await createScheduledObservationRead(baseDir, {
        ...grant,
        revision: initial.revision,
      }, undefined)({}),
      "unavailable",
    );
    const plan = (
      id: string,
      findingRecheckId: string,
      revision: number,
      withDelay = false,
    ) => ({
      id,
      classification: "INTERNAL" as const,
      steps: [
        {
          id: "verify",
          satisfiedBy: {
            case: caseId,
            run_id: runId,
            revision,
            finding_recheck_id: findingRecheckId,
          },
        },
        ...(withDelay ? [{ id: "delay", waitSeconds: 0.3 }] : []),
        { id: "dependent" },
      ],
    });
    const plans = [
      plan("matching-recheck", recheck.id, current.revision),
      plan("stale-revision", recheck.id, initial.revision),
      plan(
        "unknown-recheck",
        `worker-recheck:${"0".repeat(64)}`,
        current.revision,
      ),
      plan("expires-before-dependent", recheck.id, current.revision, true),
      {
        ...waitingPlan,
        id: "stale-original-finding-selector",
        steps: [
          {
            id: "verify",
            satisfiedBy: { ...findingRequirement, revision: initial.revision },
          },
          { id: "dependent" },
        ],
      },
      {
        ...waitingPlan,
        id: "expired-original-finding-selector",
        steps: [
          { id: "verify", satisfiedBy: findingRequirement },
          { id: "dependent" },
        ],
      },
    ];
    const journalPath = join(baseDir, "owner-remediation-workflows.db");
    const live = createOperatorWorkflowRuns(
      createWorkflowRunRegistry(),
      plans,
      journalPath,
      verify,
    );
    const expireRef = { kind: "workflow", id: "" };
    const successRef = { kind: "workflow", id: "" };
    const restartedDir = join(baseDir, "reopened-workflows");
    await Deno.mkdir(restartedDir, { mode: 0o700 });
    const restartedPath = join(restartedDir, "workflows.db");
    await ownerFacts(
      baseDir,
      async (query) => {
        for (
          const planId of [
            "matching-recheck",
            "stale-revision",
            "unknown-recheck",
            "stale-original-finding-selector",
          ]
        ) {
          const { run } = JSON.parse(
            await query({
              action: "start",
              kind: "workflow",
              id: planId,
              requestId: crypto.randomUUID(),
            }),
          );
          const passed = planId === "matching-recheck";
          await waitFor(() =>
            live.inspect(run.ref.id)?.status ===
              (passed ? "completed" : "failed")
          );
          assertEquals(
            live.inspect(run.ref.id)?.steps[1].status,
            passed ? "completed" : "pending",
          );
          if (passed) successRef.id = run.ref.id;
        }
        expireRef.id = JSON.parse(
          await query({
            action: "start",
            ...expireRef,
            id: "expires-before-dependent",
            requestId: crypto.randomUUID(),
          }),
        ).run.ref.id;
        try {
          await waitFor(() =>
            live.inspect(expireRef.id)?.steps[1].status === "running"
          );
          assertEquals(
            JSON.parse(await query({ action: "pause", ...expireRef })).run
              .status,
            "paused",
          );
          await Deno.copyFile(journalPath, restartedPath);
        } finally {
          live.cancel(expireRef.id);
        }
        await waitFor(() => live.inspect(expireRef.id)?.status === "cancelled");
      },
      true,
      undefined,
      live,
    );
    evidenceClock = Date.parse(validUntil);
    const restarted = createOperatorWorkflowRuns(
      createWorkflowRunRegistry(),
      plans,
      restartedPath,
      verify,
    );
    await ownerFacts(
      baseDir,
      async (query) => {
        const evidence = JSON.parse(
          await query({ action: "traces", ...successRef }),
        ).page.events.find(({ event }: { event: string }) =>
          event === "step_satisfied"
        ).evidence;
        assertEquals(evidence, {
          caseId,
          runId,
          revision: current.revision,
          findingRecheckId: recheck.id,
          findingId: original.id,
          evidenceId: "passing-check",
          sourceTaskId: recheck.taskId,
          resultSha256: createHash("sha256").update(JSON.stringify(recheck))
            .digest("hex"),
          controlCheckedAt: new Date(checkTime).toISOString(),
        });
        const expiredSelector = JSON.parse(
          await query({
            action: "start",
            kind: "workflow",
            id: "expired-original-finding-selector",
            requestId: crypto.randomUUID(),
          }),
        ).run.ref.id;
        await waitFor(() =>
          restarted.inspect(expiredSelector)?.status === "failed"
        );
        assertEquals(
          restarted.inspect(expiredSelector)?.steps.map(({ status }) => status),
          ["pending", "pending"],
        );
        assertEquals(
          JSON.parse(await query({ action: "resume", ...expireRef })).run
            .status,
          "running",
        );
        await waitFor(() =>
          restarted.inspect(expireRef.id)?.status === "failed"
        );
        assertEquals(
          restarted.inspect(expireRef.id)?.steps[2].status,
          "pending",
        );
        const events = JSON.parse(
          await query({ action: "traces", ...expireRef }),
        ).page.events as readonly { event: string; stepId?: string }[];
        assertEquals(
          events.filter(({ event }) => event === "step_satisfied").length,
          1,
        );
        assert(
          !events.some(({ event, stepId }) =>
            event === "step_started" && stepId === "dependent"
          ),
        );
      },
      true,
      undefined,
      restarted,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
