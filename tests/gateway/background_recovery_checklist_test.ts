import { withTeamRecoveryStore } from "../../src/gateway/startup/factory/team_recovery_store.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { openExecutionTraces } from "../../src/core/execution_traces.ts";
import { teamDeliveryExecutionId } from "../../src/gateway/startup/factory/delegated_agent_recovery.ts";
import type { TriggerFishConfig } from "../../src/core/config_types.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
  type HookLogEntry,
} from "../../src/core/policy/hooks/hooks.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { maxClassification } from "../../src/core/types/classification.ts";
import {
  type ChannelId,
  createSession,
  restoreSession,
  type SessionId,
  type UserId,
} from "../../src/core/types/session.ts";
import { createWorkspace } from "../../src/exec/workspace.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { executeOperatorRunArchive } from "../../src/gateway/operator_run_archive.ts";
import type { EnhancedSessionManager } from "../../src/gateway/sessions.ts";
import { buildTeamManager } from "../../src/gateway/startup/factory/team_executor.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildWorkflowRecoveryExecutor } from "../../src/gateway/startup/factory/agent_recovery.ts";
import { initializeFactoryInfra } from "../../src/gateway/startup/factory/orchestrator_factory_infra.ts";
import { delegatedSubagentIdentity } from "../../src/gateway/startup/factory/delegated_agent_recovery.ts";
import { buildOwnerSubagentRecoveryCommand } from "../../src/gateway/startup/factory/owner_subagent_recovery.ts";
import { buildSchedulerRecoveryBindings } from "../../src/gateway/startup/factory/scheduler_recovery.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { assembleSchedulerToolExecutor } from "../../src/gateway/startup/tools/scheduler_tool_assembly.ts";
import { resolveToolsForProfile } from "../../src/gateway/tools/agent_tools.ts";
import { createGitHubToolExecutor } from "../../src/integrations/github/tools.ts";
import { createSchedulerService } from "../../src/scheduler/service.ts";
import type {
  OrchestratorFactory,
  SchedulerServiceConfig,
} from "../../src/scheduler/service_types.ts";

const todo = {
  id: "checklist",
  content: "Review the scoped background checklist",
  status: "pending",
  priority: "high",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const complete = "Recovered the exact classified checklist.";
const instructions = "Write and verify the background checklist.";
const config: TriggerFishConfig = {
  agent_recovery: { scheduler: true, team: true, background_checklists: true },
  classification: { mode: "personal" },
  channels: {},
  models: { primary: { provider: "fixture" }, providers: {} },
};

function backgroundFixture(
  baseDir: string,
  kind: "delegated" | "scheduled" | "team",
) {
  const role = kind === "team" ? "delegated" : kind;
  const tracePath = join(baseDir, "execution-traces.db");
  const infra = initializeFactoryInfra(config, baseDir);
  const storage = createMemoryStorage();
  const state = {
    interruption: (role === "delegated" ? "before" : "after") as
      | "before"
      | "after"
      | undefined,
    rejectSavedWrite: false,
    beforeFirstModel: undefined as (() => Promise<void>) | undefined,
    writes: 0,
    reads: 0,
    results: [] as string[],
    hooks: [] as HookLogEntry[],
  };
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  const baseHooks = createHookRunner(engine, {
    logger: { log: (entry) => state.hooks.push(entry) },
  });
  infra.registry.register({
    name: "fixture",
    supportsStreaming: false,
    async complete(messages) {
      const prior = messages.filter(({ role }) => role === "tool");
      if (!prior.length) await state.beforeFirstModel?.();
      state.results = prior.map(({ content }) => String(content));
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (
        kind === "team" &&
        !messages.some(({ content }) => String(content).includes(instructions))
      ) {
        return Promise.resolve({
          content: "Team ready.",
          usage,
          toolCalls: [],
        });
      }
      if (prior.length === 2) {
        return Promise.resolve({ content: complete, usage, toolCalls: [] });
      }
      const name = prior.length === 0 ? "todo_write" : "todo_read";
      const args = prior.length === 0
        ? { expected_revision: "empty", todos: [todo] }
        : {};
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          type: "function",
          id: crypto.randomUUID(),
          function: { name, arguments: JSON.stringify(args) },
        }],
      });
    },
  });
  infra.registry.setDefault("fixture");
  const orchestratorFactory: OrchestratorFactory = {
    async create(channel, options) {
      const identity = options?.executionChecklistRunId;
      const id = options?.recoverySessionId;
      if (kind !== "team") assert(identity && id);
      const sessionInput = {
        channelId: channel as ChannelId,
        userId: "owner" as UserId,
      };
      const session = id
        ? restoreSession({ ...sessionInput, id })
        : createSession(sessionInput);
      const workspace = await createWorkspace({
        agentId: crypto.randomUUID(),
        basePath: baseDir,
      });
      let taint = session.taint;
      const getSessionTaint = () => taint;
      const assembled = assembleSchedulerToolExecutor({
        infra,
        session,
        storage,
        workspace,
        agentId: crypto.randomUUID(),
        githubExecutor: createGitHubToolExecutor(undefined),
        executionChecklist: identity
          ? { path: tracePath, role, runId: identity }
          : undefined,
        getSessionTaint,
      });
      const toolExecutor: typeof assembled = (name, args, context) => {
        if (name === "todo_write") state.writes++;
        if (name === "todo_read") state.reads++;
        return assembled(name, args, context);
      };
      const orchestrator = createOrchestrator({
        providerRegistry: infra.registry,
        enableStreaming: false,
        tools: resolveToolsForProfile(
          role === "delegated" ? "subagent" : "triggerSession",
        ),
        toolExecutor,
        getSessionTaint,
        escalateTaint: (next) => taint = maxClassification(taint, next),
        isTriggerSession: () => true,
        getNonOwnerCeiling: () => options?.ceiling ?? "INTERNAL",
        hookRunner: {
          ...baseHooks,
          evaluateHook(hook, args) {
            if (
              state.rejectSavedWrite && hook === "PRE_TOOL_CALL" &&
              args.input.tool_name === "todo_write"
            ) {
              return Promise.resolve({
                allowed: false,
                action: "BLOCK",
                ruleId: null,
                duration: 0,
              });
            }
            return baseHooks.evaluateHook(hook, args);
          },
        },
      });
      return {
        orchestrator: {
          ...orchestrator,
          executeAgentTurn: (options) =>
            orchestrator.executeAgentTurn({
              ...options,
              ...(state.interruption && {
                async onToolBatchCheckpoint(batch) {
                  if (state.interruption === "after") {
                    await options.onToolBatchCheckpoint?.(batch);
                  }
                  throw new Error(
                    "Fixture interruption before batch checkpoint",
                  );
                },
              }),
            }),
        },
        session,
        toolExecutor,
        getSessionTaint,
      };
    },
  };
  return { tracePath, orchestratorFactory, state };
}

async function sendBackgroundCommand(
  chatSession: ReturnType<typeof createChatSession>,
  request: string,
) {
  const gatewayToken = crypto.randomUUID();
  const server = createGatewayServer({
    port: 0,
    token: gatewayToken,
    chatSession,
  });
  const { port } = await server.start();
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/chat?token=${gatewayToken}`,
  );
  const done = Promise.withResolvers<void>();
  const events: string[] = [];
  const timer = setTimeout(
    () => done.reject(new Error("Background gateway timeout")),
    5000,
  );
  socket.onopen = () =>
    socket.send(JSON.stringify({ type: "message", content: request }));
  socket.onmessage = ({ data }) => {
    events.push(String(data));
    if (JSON.parse(data).type === "turn_end") done.resolve();
  };
  socket.onerror = () => done.reject(new Error("Background gateway error"));
  try {
    await done.promise;
    return events.join("\n");
  } finally {
    clearTimeout(timer);
    socket.close();
    await server.stop();
  }
}

Deno.test("Owner gateway resumes a delegated checklist under current policy without dispatching its write again", async () => {
  const baseDir = await Deno.makeTempDir();
  const fixture = backgroundFixture(baseDir, "delegated");
  const { state } = fixture;
  const configured = buildWorkflowRecoveryExecutor(
    config,
    baseDir,
    createMemorySecretStore(),
    undefined,
    undefined,
    false,
    { checklistRole: "delegated" },
  );
  assert(configured);
  const runSubagentRecoveryCommand = buildOwnerSubagentRecoveryCommand(
    buildSubagentFactory(fixture.orchestratorFactory, {
      executionTracePath: fixture.tracePath,
    }),
    configured,
  );
  const parent = createSession({
    userId: "owner" as UserId,
    channelId: "socket-fixture" as ChannelId,
  });
  const request = `/recover-subagent ${crypto.randomUUID()} ${instructions}`;
  async function send() {
    return await sendBackgroundCommand(
      createChatSession({
        session: parent,
        providerRegistry: createProviderRegistry(),
        hookRunner: createHookRunner(createPolicyEngine()),
        runSubagentRecoveryCommand,
      }),
      request,
    );
  }
  try {
    assertStringIncludes(await send(), "checkpoint");
    assertEquals(state.writes, 1);
    state.interruption = undefined;
    state.rejectSavedWrite = true;
    assertStringIncludes(await send(), "blocked by the current policy");
    assertEquals(state.reads, 0);
    state.rejectSavedWrite = false;
    assertStringIncludes(await send(), complete);
    assertEquals(state.writes, 1);
    assertEquals(state.reads, 1);
    assertEquals(state.results[0], state.results[1]);
    assertEquals(JSON.parse(state.results[0]).todos, [todo]);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

async function verifyBackgroundPauseBeforeFirstAction(
  kind: "delegated" | "scheduled",
) {
  const baseDir = await Deno.makeTempDir();
  const input = crypto.randomUUID();
  const parent = createSession({
    userId: "owner" as UserId,
    channelId: "background-pause" as ChannelId,
  });
  const foreign = createSession({
    userId: parent.userId,
    channelId: parent.channelId,
  });
  const identity = await delegatedSubagentIdentity(parent.id, input);
  const { orchestratorFactory, tracePath, state } = backgroundFixture(
    baseDir,
    kind,
  );
  state.interruption = undefined;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  state.beforeFirstModel = () => {
    entered.resolve();
    return release.promise;
  };
  const configured = buildWorkflowRecoveryExecutor(
    config,
    baseDir,
    createMemorySecretStore(),
    undefined,
    undefined,
    false,
    { checklistRole: "delegated" },
  );
  assert(configured);
  const runSubagentRecoveryCommand = buildOwnerSubagentRecoveryCommand(
    buildSubagentFactory(orchestratorFactory, {
      executionTracePath: tracePath,
    }),
    configured,
  );
  const send = () =>
    sendBackgroundCommand(
      createChatSession({
        session: parent,
        providerRegistry: createProviderRegistry(),
        hookRunner: createHookRunner(createPolicyEngine()),
        runSubagentRecoveryCommand,
      }),
      `/recover-subagent ${input} ${instructions}`,
    );
  const triggerMdPath = join(baseDir, "TRIGGER.md");
  const scheduledId = Promise.withResolvers<string>();
  let schedulerConfig: SchedulerServiceConfig | undefined;
  if (kind === "scheduled") {
    await Deno.writeTextFile(triggerMdPath, instructions);
    const bindings = buildSchedulerRecoveryBindings(
      config,
      baseDir,
      createMemorySecretStore(),
    );
    schedulerConfig = {
      ...bindings,
      orchestratorFactory,
      executionTracePath: tracePath,
      triggerMdPath,
      trigger: {
        enabled: false,
        intervalMinutes: 30,
        classificationCeiling: "INTERNAL",
      },
      webhooks: { enabled: false, sources: {} },
      recoverTurn(execution, orchestrator, options) {
        scheduledId.resolve(execution.id);
        return bindings.recoverTurn!(execution, orchestrator, options);
      },
    };
  }
  let scheduler = schedulerConfig && createSchedulerService(schedulerConfig);
  let denyControl = false;
  let approvals = 0;
  const controlHooks: HookLogEntry[] = [];
  const control = async (args: Record<string, unknown>, actor = parent) => {
    const registry = createProviderRegistry();
    let observed: string | undefined;
    registry.register({
      name: "fixture",
      supportsStreaming: false,
      complete(messages) {
        const response = messages.at(-1);
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (response?.role === "tool") {
          observed = String(response.content);
          return Promise.resolve({
            content: "Reviewed the exact background control.",
            usage,
            toolCalls: [],
          });
        }
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [{
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(args),
            },
          }],
        });
      },
    });
    registry.setDefault("fixture");
    const policy = createPolicyEngine();
    if (denyControl) {
      policy.addRule({
        id: "deny-background-control",
        priority: 999,
        hook: "PRE_TOOL_CALL",
        conditions: [{
          field: "tool_name",
          operator: "equals",
          value: "operator_runs",
        }],
        action: "BLOCK",
      });
    }
    await sendBackgroundCommand(
      createChatSession({
        session: actor,
        providerRegistry: registry,
        hookRunner: createHookRunner(policy, {
          logger: { log: (entry) => controlHooks.push(entry) },
        }),
        runSubagentRecoveryCommand,
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          resumeScheduledExecution: scheduler?.resumeScheduledExecution,
          confirm: () => {
            approvals++;
            return Promise.resolve(true);
          },
        }),
      }),
      "Control the existing background run.",
    );
    assert(observed);
    return observed;
  };
  const running = scheduler ? scheduler.runTrigger() : send();
  try {
    const timeout = setTimeout(
      () =>
        entered.reject(
          new Error("Worker never reached its first model call"),
        ),
      5_000,
    );
    try {
      await entered.promise;
    } finally {
      clearTimeout(timeout);
    }
    const ref = {
      kind,
      id: kind === "scheduled"
        ? await scheduledId.promise
        : identity.executionId,
    };
    const pause = { action: "pause", ...ref };
    const resume = {
      action: "resume",
      ...ref,
      ...(kind === "delegated" &&
        { executionId: input, originalTask: instructions }),
    };
    if (kind === "delegated") {
      assertStringIncludes(await control(pause, foreign), "unavailable");
    }
    denyControl = true;
    await control(pause);
    denyControl = false;
    assertEquals(approvals, 0);
    const paused = JSON.parse(await control(pause));
    assertEquals(paused.run.status, "paused");
    assertEquals(paused.pauseRequested, true);
    assertEquals(JSON.parse(await control(pause)).run, paused.run);
    assertEquals(approvals, 1);
    release.resolve();
    await running;
    assertEquals(state.writes, 0);
    assertEquals(state.reads, 0);
    let approvalsBeforeResume = 1;
    if (schedulerConfig) {
      scheduler?.stop();
      scheduler = createSchedulerService(schedulerConfig);
      await Deno.writeTextFile(
        triggerMdPath,
        "Changed trigger instructions.",
      );
      assertStringIncludes(await control(resume), "unavailable");
      assertEquals(
        JSON.parse(await control({ action: "inspect", ...ref })).run.status,
        "paused",
      );
      await Deno.writeTextFile(triggerMdPath, instructions);
      approvalsBeforeResume++;
    } else {
      assertStringIncludes(await send(), "paused");
    }
    assertEquals(state.writes, 0);
    denyControl = true;
    await control(resume);
    denyControl = false;
    assertEquals(approvals, approvalsBeforeResume);
    assertEquals(state.writes, 0);
    controlHooks.length = 0;
    const completed = JSON.parse(await control(resume));
    assertEquals(completed.run.status, "completed");
    for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE", "PRE_OUTPUT"]) {
      assert(controlHooks.some((entry) => entry.hook === hook), hook);
    }
    assertEquals(state.writes, 1);
    assertEquals(state.reads, 1);
    assertStringIncludes(await control(resume), "unavailable");
    assertEquals(approvals, approvalsBeforeResume + 1);
    assertEquals(state.writes, 1);
  } finally {
    release.resolve();
    await running.catch(() => undefined);
    scheduler?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
}

for (const kind of ["delegated", "scheduled"] as const) {
  Deno.test(`Authorized owner pauses a live ${kind} run before its first tool action`, () =>
    verifyBackgroundPauseBeforeFirstAction(kind));
}

Deno.test("Authenticated scheduler gateway resumes the exact classified checklist after interrupted dispatch", async () => {
  const baseDir = await Deno.makeTempDir();
  const fixture = backgroundFixture(baseDir, "scheduled");
  const { state } = fixture;
  const secrets = createMemorySecretStore();
  const triggerMdPath = join(baseDir, "TRIGGER.md");
  await Deno.writeTextFile(triggerMdPath, instructions);
  const initialBindings = buildSchedulerRecoveryBindings(
    config,
    baseDir,
    secrets,
  );
  const stopped = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const schedulerConfig: SchedulerServiceConfig = {
    ...initialBindings,
    orchestratorFactory: fixture.orchestratorFactory,
    executionTracePath: fixture.tracePath,
    triggerMdPath,
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: "INTERNAL",
    },
    webhooks: { enabled: false, sources: {} },
  };
  const first = createSchedulerService({
    ...schedulerConfig,
    async recoverTurn(identity, orchestrator, options) {
      const result = await initialBindings.recoverTurn!(
        identity,
        orchestrator,
        options,
      );
      assert(!result.ok);
      stopped.resolve(identity.id);
      await release.promise;
      return result;
    },
  });
  const initial = first.runTrigger();
  let restarted: ReturnType<typeof createSchedulerService> | undefined;
  try {
    const id = await Promise.race([
      stopped.promise,
      initial.then(() => {
        throw new Error("Trigger exited without an interrupted checklist");
      }),
    ]);
    assertEquals(state.writes, 1);
    const ref = { kind: "scheduled", id } as const;
    const archiveId = crypto.randomUUID();
    const result = await executeOperatorRunArchive(baseDir, ref, {
      ...ref,
      action: "archive",
      requestId: archiveId,
    }, () => Promise.resolve(true));
    assert(typeof result !== "string");
    assertEquals((result.receipt as { status: string }).status, "succeeded");
    for (
      const name of [
        "agent-recovery.db",
        "execution-traces.db",
        "scheduler-trigger-admissions.db",
      ]
    ) {
      await Deno.rename(join(baseDir, name), join(baseDir, `original-${name}`));
    }
    const restored = await executeOperatorRunArchive(baseDir, ref, {
      ...ref,
      action: "restore",
      requestId: crypto.randomUUID(),
      archiveId,
    }, () => Promise.resolve(true));
    assert(typeof restored !== "string");
    assertEquals((restored.receipt as { status: string }).status, "succeeded");
    state.interruption = undefined;
    state.hooks = [];
    restarted = createSchedulerService({
      ...schedulerConfig,
      ...buildSchedulerRecoveryBindings(config, baseDir, secrets),
    });
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      schedulerService: restarted,
    });
    const { port } = await gateway.start();
    const endpoint = `http://127.0.0.1:${port}/recovery/scheduled/${id}`;
    try {
      for (const authenticated of [false, true]) {
        const reply = await fetch(endpoint, {
          method: "POST",
          ...(authenticated &&
            { headers: { authorization: `Bearer ${token}` } }),
        });
        assertEquals(reply.status, authenticated ? 200 : 401);
        await reply.text();
      }
      assertEquals(state.writes, 1);
      assertEquals(state.reads, 1);
      assertEquals(state.results[0], state.results[1]);
      assertEquals(JSON.parse(state.results[0]).todos, [todo]);
      for (const expected of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"]) {
        assert(
          state.hooks.some(({ hook, input }) =>
            hook === expected && input.tool_name === "todo_write"
          ),
        );
      }
    } finally {
      await gateway.stop();
    }
  } finally {
    release.resolve();
    await initial;
    first.stop();
    restarted?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Owner gateway resumes a team delivery checklist without repeating a committed write", async () => {
  const baseDir = await Deno.makeTempDir();
  const fixture = backgroundFixture(baseDir, "team");
  const { state } = fixture;
  const storage = createMemoryStorage();
  const keychain = createMemorySecretStore();
  const parent = createSession({
    userId: "owner" as UserId,
    channelId: "team-socket-fixture" as ChannelId,
  });
  const makeManager = (root = baseDir, factory = fixture.orchestratorFactory) =>
    buildTeamManager({
      storage,
      orchestratorFactory: factory,
      callerSessionId: parent.id,
      sessionManager: {
        get: (id: SessionId) =>
          Promise.resolve(id === parent.id ? parent : null),
      } as unknown as EnhancedSessionManager,
      recovery: {
        path: join(root, "team-recovery.db"),
        profileBinding: "b".repeat(64),
        exactChecklists: true,
        run: () => Promise.reject(new Error("Expected an isolated delivery")),
        bindObservationRun: (source, authorizeObservationScope) =>
          buildWorkflowRecoveryExecutor(
            config,
            root,
            keychain,
            undefined,
            source,
            false,
            {
              checklistRole: "team",
              authorizeObservationScope,
            },
          ),
      },
    });
  try {
    const manager = makeManager();
    const team = await manager.createTeam({
      name: "Review team",
      task: "Review the assignment checklist.",
      members: [{
        role: "reviewer",
        description: "Review the checklist.",
        isLead: true,
        classificationCeiling: "INTERNAL",
      }],
    }, parent.id);
    assert(team.ok);
    manager.stopLifecycleMonitor(team.value.id);
    const [member] = team.value.members;
    const deliveryId = crypto.randomUUID();
    const send = (id = deliveryId) =>
      sendBackgroundCommand(
        createChatSession({
          session: parent,
          providerRegistry: createProviderRegistry(),
          hookRunner: createHookRunner(createPolicyEngine()),
          runTeamRecoveryCommand: makeManager().runRecoveryCommand,
        }),
        `/recover-team ${id} ${team.value.id} ${member.sessionId} ${instructions}`,
      );
    state.interruption = "before";
    assertStringIncludes(await send(), "checkpoint");
    assertEquals(state.writes, 1);
    state.interruption = undefined;
    state.rejectSavedWrite = true;
    assertStringIncludes(await send(), "blocked by the current policy");
    assertEquals(state.writes, 1);
    assertEquals(state.reads, 0);
    state.rejectSavedWrite = false;
    assertStringIncludes(await send(), "Team delivery completed.");
    assertEquals(state.writes, 1);
    assertEquals(state.reads, 1);
    assertEquals(state.results[0], state.results[1]);
    assertEquals(JSON.parse(state.results[0]).todos, [todo]);
    const firstResult = state.results[0];
    const runId = await teamDeliveryExecutionId(
      parent.id,
      member.sessionId,
      deliveryId,
    );
    const traces = openExecutionTraces(fixture.tracePath);
    let originalSnapshot;
    try {
      const archived = traces.archiveSnapshot("delegated", runId, "INTERNAL");
      assertEquals(archived?.run.status, "completed");
      assert(archived?.entries.length);
      originalSnapshot = archived;
      assertEquals(archived?.run.scope.sessionId, member.sessionId);
      assertEquals(
        traces.archiveSnapshot("delegated", runId, "PUBLIC"),
        undefined,
      );
      assertStringIncludes(archived?.checklist?.contents ?? "", todo.content);
    } finally {
      traces.close();
    }
    assertStringIncludes(await send(), "already finished");
    assertEquals(state.writes, 1);
    assertStringIncludes(
      await send(crypto.randomUUID()),
      "Team delivery completed.",
    );
    assertEquals(state.writes, 2);
    assertEquals(state.results[0], state.results[1]);
    assertEquals(JSON.parse(state.results[0]).todos, [todo]);
    assert(
      JSON.parse(state.results[0]).revision !==
        JSON.parse(firstResult).revision,
    );

    const foreign = createSession({
      userId: "other-owner" as UserId,
      channelId: "other" as ChannelId,
    });
    let approvals = 0;
    const archiveHooks: HookLogEntry[] = [];
    const archiveTool = async (
      root: string,
      actor: typeof parent,
      input: Record<string, unknown>,
      denyArchive = false,
      runTeamRecoveryCommand?: ReturnType<
        typeof makeManager
      >["runRecoveryCommand"],
    ) => {
      const registry = createProviderRegistry();
      let observed: string | undefined;
      registry.register({
        name: "fixture",
        supportsStreaming: false,
        complete(messages) {
          const prior = messages.findLast(({ role }) => role === "tool");
          const usage = { inputTokens: 1, outputTokens: 1 };
          if (prior) {
            observed = String(prior.content);
            return Promise.resolve({
              content: "Reviewed the tool response.",
              usage,
              toolCalls: [],
            });
          }
          return Promise.resolve({
            content: "",
            usage,
            toolCalls: [{
              type: "function",
              id: crypto.randomUUID(),
              function: {
                name: "operator_runs",
                arguments: JSON.stringify(input),
              },
            }],
          });
        },
      });
      registry.setDefault("fixture");
      const hooks = createPolicyEngine();
      for (const rule of createDefaultRules()) hooks.addRule(rule);
      const runner = createHookRunner(hooks, {
        logger: { log: (entry) => archiveHooks.push(entry) },
      });
      await sendBackgroundCommand(
        createChatSession({
          session: actor,
          runTeamRecoveryCommand,
          providerRegistry: registry,
          enableStreaming: false,
          hookRunner: {
            ...runner,
            evaluateHook(hook, args) {
              if (
                denyArchive && hook === "PRE_TOOL_CALL" &&
                args.input.tool_name === "operator_runs"
              ) {
                return Promise.resolve({
                  allowed: false,
                  action: "BLOCK",
                  ruleId: null,
                  duration: 0,
                });
              }
              return runner.evaluateHook(hook, args);
            },
          },
          operatorRunExecutor: createOperatorRunToolExecutor({
            baseDir: root,
            confirm: () => {
              approvals++;
              return Promise.resolve(true);
            },
          }),
        }),
        "Inspect exact team delivery history.",
      );
      assert(observed);
      return observed;
    };
    const id = [team.value.id, member.sessionId, deliveryId].join(":");
    const traceArgs = {
      action: "execution_traces",
      traceRole: "delegated",
      id: runId,
      ordinal: 1,
    };
    const archiveId = crypto.randomUUID();
    const archiveArgs = {
      action: "archive",
      kind: "team_delivery",
      id,
      requestId: archiveId,
    };
    const originalHistory = JSON.parse(
      await archiveTool(baseDir, parent, traceArgs),
    );
    assertEquals(originalHistory.step.id, originalSnapshot.entries[0].step.id);
    assertStringIncludes(
      await archiveTool(baseDir, foreign, traceArgs),
      "unavailable",
    );
    assertStringIncludes(
      await archiveTool(baseDir, foreign, {
        ...archiveArgs,
        kind: "delegated",
        id: runId,
      }),
      "unavailable",
    );
    await archiveTool(baseDir, parent, archiveArgs, true);
    assertEquals(approvals, 0);
    assertEquals(
      JSON.parse(await archiveTool(baseDir, parent, archiveArgs)).receipt
        .status,
      "succeeded",
    );
    assertEquals(approvals, 1);
    const interruptedDelivery = crypto.randomUUID();
    state.interruption = "after";
    assertStringIncludes(await send(interruptedDelivery), "checkpoint");
    state.interruption = undefined;
    assertEquals(state.writes, 3);
    const pausedArchiveId = crypto.randomUUID();
    const pausedArchiveArgs = {
      ...archiveArgs,
      id: [team.value.id, member.sessionId, interruptedDelivery].join(":"),
      requestId: pausedArchiveId,
    };
    const checkpointRunId = await teamDeliveryExecutionId(
      parent.id,
      member.sessionId,
      interruptedDelivery,
    );
    const interruptedHistory = JSON.parse(
      await archiveTool(baseDir, parent, { ...traceArgs, id: checkpointRunId }),
    );
    assertEquals(interruptedHistory.step.tool, "todo_write");
    assertEquals(
      JSON.parse(await archiveTool(baseDir, parent, pausedArchiveArgs)).receipt
        .status,
      "succeeded",
    );
    const cleanRoot = await Deno.makeTempDir({ dir: baseDir });
    await Deno.mkdir(join(cleanRoot, "data"));
    await Deno.rename(
      join(baseDir, "data", "run-archives"),
      join(cleanRoot, "data", "run-archives"),
    );
    assertStringIncludes(
      await archiveTool(cleanRoot, parent, traceArgs),
      "unavailable",
    );
    const restoreArgs = {
      ...archiveArgs,
      action: "restore",
      requestId: crypto.randomUUID(),
      archiveId,
    };
    assertStringIncludes(
      await archiveTool(cleanRoot, foreign, restoreArgs),
      "unavailable",
    );
    assertStringIncludes(
      await archiveTool(cleanRoot, parent, {
        ...restoreArgs,
        id: [crypto.randomUUID(), member.sessionId, deliveryId].join(":"),
      }),
      "unavailable",
    );
    assertEquals(approvals, 2);
    const restored = JSON.parse(
      await archiveTool(cleanRoot, parent, restoreArgs),
    );
    assertEquals(restored.receipt.status, "succeeded");
    assertEquals(
      JSON.parse(await archiveTool(cleanRoot, parent, restoreArgs)),
      restored,
    );
    assertEquals(approvals, 3);
    assert(
      archiveHooks.some(({ hook, input }) =>
        hook === "POST_TOOL_RESPONSE" && input.tool_name === "operator_runs"
      ),
    );
    assertEquals(
      JSON.parse(await archiveTool(cleanRoot, parent, traceArgs)),
      originalHistory,
    );
    assertStringIncludes(
      await archiveTool(cleanRoot, foreign, traceArgs),
      "unavailable",
    );
    const foreignSearch = JSON.parse(
      await archiveTool(cleanRoot, foreign, {
        action: "execution_traces",
        traceRole: "delegated",
        query: "todo",
      }),
    );
    assertEquals(foreignSearch.page.matches, []);
    const foreignList = JSON.parse(
      await archiveTool(cleanRoot, foreign, {
        action: "execution_traces",
        traceRole: "delegated",
      }),
    );
    assertEquals(foreignList.page.runs, []);
    assertEquals(state.writes, 3);
    const recoveredTraces = openExecutionTraces(
      join(cleanRoot, "execution-traces.db"),
    );
    try {
      assertEquals(
        recoveredTraces.archiveSnapshot("delegated", runId, "INTERNAL"),
        originalSnapshot,
      );
    } finally {
      recoveredTraces.close();
    }

    const restorePausedArgs = {
      ...pausedArchiveArgs,
      action: "restore",
      requestId: crypto.randomUUID(),
      archiveId: pausedArchiveId,
    };
    assertEquals(
      JSON.parse(await archiveTool(cleanRoot, parent, restorePausedArgs))
        .receipt.status,
      "succeeded",
    );
    const target = backgroundFixture(cleanRoot, "team");
    target.state.interruption = undefined;
    const resume = (request = instructions, explicit = true) =>
      sendBackgroundCommand(
        createChatSession({
          session: parent,
          providerRegistry: createProviderRegistry(),
          hookRunner: createHookRunner(createPolicyEngine()),
          runTeamRecoveryCommand:
            makeManager(cleanRoot, target.orchestratorFactory)
              .runRecoveryCommand,
        }),
        `/recover-team ${
          explicit ? "--resume-paused " : ""
        }${interruptedDelivery} ${team.value.id} ${member.sessionId} ${request}`,
      );
    let resumeInvocations = 0;
    const resumeWithModel = (
      actor = parent,
      originalTask = instructions,
      deny = false,
    ) =>
      archiveTool(
        cleanRoot,
        actor,
        {
          action: "resume",
          kind: "delegated",
          id: checkpointRunId,
          originalTask,
        },
        deny,
        (...args) => {
          resumeInvocations++;
          const resume = makeManager(cleanRoot, target.orchestratorFactory)
            .runRecoveryCommand;
          assert(resume);
          return resume(...args);
        },
      );
    const restoredRecovery = new AgentRecoveryStore(
      join(cleanRoot, "agent-recovery.db"),
    );
    const pausedKey = assignmentRecoveryKey(member.sessionId, checkpointRunId);
    try {
      assertEquals(restoredRecovery.read(pausedKey)?.status, "paused");
      const priorApprovals = approvals;
      assertStringIncludes(await resumeWithModel(foreign), "unavailable");
      await resumeWithModel(parent, instructions, true);
      assertEquals(approvals, priorApprovals);
      assertEquals(resumeInvocations, 0);
      assertStringIncludes(await resumeWithModel(), "unavailable");
      assertEquals(approvals, priorApprovals + 1);
      assertEquals(resumeInvocations, 1);
      assertStringIncludes(
        await resume(),
        "not available in the trusted recovery scope",
      );
      const current = withTeamRecoveryStore(
        join(baseDir, "team-recovery.db"),
        (store) => store.member(member.sessionId),
      );
      assert(current);
      // Provision current membership independently from the delivery archive.
      assert(
        withTeamRecoveryStore(
          join(cleanRoot, "team-recovery.db"),
          (store) => store.registerMember(current),
        ),
      );
      assertStringIncludes(
        await resume("different request"),
        "scope or request changed",
      );
      assertStringIncludes(await resume(instructions, false), "paused");
      target.state.rejectSavedWrite = true;
      assertStringIncludes(await resume(), "blocked by the current policy");
      assertEquals(restoredRecovery.read(pausedKey)?.status, "paused");
      assertEquals(target.state.writes, 0);
      assertEquals(target.state.reads, 0);
      assertStringIncludes(await resumeWithModel(), "unavailable");
      assertEquals(restoredRecovery.read(pausedKey)?.status, "paused");
      target.state.rejectSavedWrite = false;
      assertStringIncludes(
        await resumeWithModel(parent, "different request"),
        "unavailable",
      );
      const completed = JSON.parse(await resumeWithModel());
      assertEquals(completed.run.ref.id, checkpointRunId);
      assertEquals(completed.run.status, "completed");
      const approvedResumes = approvals;
      assertStringIncludes(await resumeWithModel(), "unavailable");
      assertEquals(approvals, approvedResumes);
      assertEquals(target.state.writes, 0);
      assertEquals(target.state.reads, 1);
      assertEquals(target.state.results[0], target.state.results[1]);
      assertEquals(JSON.parse(target.state.results[0]).todos, [todo]);
      const reopened = JSON.parse(
        await archiveTool(cleanRoot, parent, {
          ...traceArgs,
          id: checkpointRunId,
        }),
      );
      assertEquals(reopened.run.status, "completed");
      assertEquals(reopened.step.id, interruptedHistory.step.id);
      assertStringIncludes(await resume(), "already finished");
      assertEquals(target.state.writes, 0);
      assertEquals(target.state.reads, 1);
    } finally {
      restoredRecovery.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
