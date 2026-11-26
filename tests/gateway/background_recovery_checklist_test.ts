import type { LlmProvider } from "../../src/core/types/llm.ts";
import { enableLiveProviderRoutes } from "../../src/agent/providers/live_routes.ts";
import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
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
import { schedulerAdmissionArchive } from "../../src/scheduler/admission_archive.ts";
import { schedulerAdmissionDatabase } from "../../src/scheduler/admission_database.ts";
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
  liveRoutes = false,
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
    requireReadApproval: false,
    beforeFirstModel: undefined as (() => Promise<void>) | undefined,
    writes: 0,
    reads: 0,
    results: [] as string[],
    hooks: [] as HookLogEntry[],
    providerCalls: [] as string[],
    routeNames: ["fixture", "alternate"],
    routingEnabled: liveRoutes,
  };
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  const baseHooks = createHookRunner(engine, {
    logger: { log: (entry) => state.hooks.push(entry) },
  });
  const inbox = createToolApprovalService(join(baseDir, "tool-approvals.db"));
  const providerModel = (provider: string): LlmProvider => ({
    name: provider,
    supportsStreaming: false,
    async complete(messages) {
      state.providerCalls.push(provider);
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
  infra.registry.register(providerModel("fixture"));
  if (liveRoutes) infra.registry.register(providerModel("alternate"));
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
        providerRegistry: state.routingEnabled
          ? enableLiveProviderRoutes(infra.registry, baseDir, {
            PUBLIC: [...state.routeNames],
            INTERNAL: [...state.routeNames],
          })
          : infra.registry,
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
          toolApprovalInbox: inbox,
          evaluateHook(hook, args) {
            if (
              state.requireReadApproval && hook === "PRE_TOOL_CALL" &&
              args.input.tool_name === "todo_read"
            ) {
              return Promise.resolve({
                allowed: false,
                action: "REQUIRE_APPROVAL",
                ruleId: "fixture-background-read-approval",
                duration: 0,
              });
            }
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
  return { tracePath, orchestratorFactory, state, inbox };
}

async function chooseBackgroundRoute(baseDir: string, provider: string) {
  const dir = join(baseDir, "data");
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const replacement = join(dir, "model-routes-next.json");
  await Deno.writeTextFile(
    replacement,
    JSON.stringify({
      PUBLIC: { provider },
      INTERNAL: { provider },
    }),
    { mode: 0o600 },
  );
  await Deno.rename(replacement, join(dir, "model-routes.json"));
}

async function decideBackgroundApproval(
  inbox: ReturnType<typeof createToolApprovalService>,
  approvalId: string,
) {
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "approval-review" as ChannelId,
      }),
      providerRegistry: createProviderRegistry(),
      hookRunner: {
        ...createHookRunner(createPolicyEngine()),
        toolApprovalInbox: inbox,
      },
    }),
  });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const requestId = crypto.randomUUID();
  const reply = Promise.withResolvers<boolean>();
  const timeout = setTimeout(
    () => reply.reject(new Error("No approval decision response")),
    3000,
  );
  socket.onopen = () =>
    socket.send(JSON.stringify({
      type: "approval_inbox_decide",
      requestId,
      approvalId,
      approved: true,
    }));
  socket.onmessage = ({ data }) => {
    const frame = JSON.parse(String(data));
    if (
      frame.type === "approval_inbox_result" && frame.requestId === requestId
    ) {
      reply.resolve(frame.ok === true);
    }
  };
  socket.onerror = () =>
    reply.reject(new Error("Approval review socket failed"));
  try {
    return await reply.promise;
  } finally {
    clearTimeout(timeout);
    socket.close();
    await gateway.stop();
  }
}

async function approveBackgroundRead(
  inbox: ReturnType<typeof createToolApprovalService>,
  runId: string,
) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const request = inbox.list().records.find(({ status }) =>
      status === "pending"
    );
    if (request) {
      assertEquals(request.tool, "todo_read");
      assertEquals(request.runId, runId);
      assert(await decideBackgroundApproval(inbox, request.id));
      return request.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error("No pending non-owner approval was available.");
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

async function checkDelegatedChecklistRecovery(liveRoutes: boolean) {
  const baseDir = await Deno.makeTempDir({ dir: Deno.cwd() });
  const fixture = backgroundFixture(baseDir, "delegated", liveRoutes);
  const { state } = fixture;
  if (liveRoutes) {
    state.interruption = "after";
    await chooseBackgroundRoute(baseDir, "fixture");
  }
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
    if (liveRoutes) {
      await chooseBackgroundRoute(baseDir, "alternate");
      state.providerCalls.length = 0;
      state.routeNames = ["alternate"];
      assertStringIncludes(
        await send(),
        "original approved model route is unavailable",
      );
      assertEquals(state.providerCalls, []);
      assertEquals(state.writes, 1);
      state.routeNames = ["fixture", "alternate"];
    }
    state.rejectSavedWrite = true;
    assertStringIncludes(await send(), "blocked by the current policy");
    assertEquals(state.reads, 0);
    state.rejectSavedWrite = false;
    assertStringIncludes(await send(), complete);
    assertEquals(state.writes, 1);
    assertEquals(state.reads, 1);
    if (liveRoutes) assertEquals(state.providerCalls, ["fixture", "fixture"]);
    assertEquals(state.results[0], state.results[1]);
    assertEquals(JSON.parse(state.results[0]).todos, [todo]);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
}

Deno.test("Owner gateway resumes a delegated checklist under current policy without dispatching its write again", () =>
  checkDelegatedChecklistRecovery(false));
Deno.test("Owner gateway resumes a delegated checkpoint on the original approved model route", () =>
  checkDelegatedChecklistRecovery(true));

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
  const { orchestratorFactory, tracePath, state, inbox } = backgroundFixture(
    baseDir,
    kind,
  );
  state.interruption = undefined;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let firstModelCalls = 0;
  state.beforeFirstModel = () => {
    firstModelCalls++;
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
  let scheduledId: string | undefined;
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
        scheduledId = execution.id;
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
    const id = kind === "scheduled" ? scheduledId : identity.executionId;
    assert(id);
    const ref = { kind, id };
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

    const archiveId = crypto.randomUUID();
    const archive = { action: "archive", ...ref, requestId: archiveId };
    const archived = JSON.parse(await control(archive));
    assertEquals(archived.receipt.status, "succeeded");
    assertEquals(JSON.parse(await control(archive)), archived);
    assertEquals(approvals, 2);
    const artifactPath = join(
      baseDir,
      "data",
      "run-archives",
      archiveId,
      "execution-trace.json",
    );
    const artifactText = await Deno.readTextFile(artifactPath);
    assert(!artifactText.includes(instructions));
    const artifact = JSON.parse(artifactText);
    assertEquals(artifact.checkpoint.status, "paused");
    assertEquals(artifact.checkpoint.committedBatch, 0);
    assertEquals(artifact.checkpoint.checkpoint, undefined);
    assertEquals(artifact.checkpoint.tools, []);
    assertEquals(artifact.trace.entries, []);
    assertEquals(!!artifact.admission, kind === "scheduled");
    for (
      const filename of [
        "agent-recovery.db",
        "execution-traces.db",
        ...(kind === "scheduled" ? ["scheduler-trigger-admissions.db"] : []),
      ]
    ) {
      await Deno.rename(
        join(baseDir, filename),
        join(baseDir, `prior-${filename}`),
      );
    }
    const restore = {
      action: "restore",
      ...ref,
      archiveId,
      requestId: crypto.randomUUID(),
    };
    let approvalsBeforeRestore = 2;
    if (kind === "scheduled") {
      await Deno.writeTextFile(artifactPath, "{}");
      const rejected = JSON.parse(
        await control({
          ...restore,
          requestId: crypto.randomUUID(),
        }),
      ).receipt;
      assertEquals(rejected.status, "failed");
      assertStringIncludes(
        await control({ action: "inspect", ...ref }),
        "unavailable",
      );
      const recovery = new AgentRecoveryStore(
        join(baseDir, "agent-recovery.db"),
      );
      try {
        const traceKey = assignmentRecoveryKey(
          artifact.trace.run.scope.sessionId,
          ref.id,
        );
        assertEquals(recovery.read(traceKey), undefined);
      } finally {
        recovery.close();
      }
      await Deno.writeTextFile(artifactPath, artifactText);
      approvalsBeforeRestore++;
    }
    const restored = JSON.parse(await control(restore));
    assertEquals(restored.receipt.status, "succeeded");
    assertEquals(JSON.parse(await control(restore)), restored);
    assertEquals(approvals, approvalsBeforeRestore + 1);
    assertEquals(
      JSON.parse(await control({ action: "inspect", ...ref })).run.status,
      "paused",
    );

    let approvalsBeforeResume = approvals;
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
    state.requireReadApproval = true;
    const finishing = control(resume);
    const approvalId = await approveBackgroundRead(inbox, ref.id);
    const completed = JSON.parse(await finishing);
    const approvalHistory = { action: "approval_history", ...ref };
    state.requireReadApproval = false;
    assertEquals(completed.run.status, "completed");
    const decision = inbox.list().records.find(({ id }) => id === approvalId);
    assertEquals(decision?.dispatchOutcome, "returned");
    assert(decision);
    const expectedDecision = {
      id: approvalId,
      runId: ref.id,
      tool: "todo_read",
      status: "completed",
      decision: "approved",
      dispatchOutcome: "returned",
      handlerReturnedAt: decision.handlerReturnedAt,
      createdAt: decision.createdAt,
      updatedAt: decision.updatedAt,
    };
    const inboxPath = join(baseDir, "tool-approvals.db");
    const archiveInbox = () =>
      Deno.rename(inboxPath, join(baseDir, "terminal-source-approvals.db"));
    for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE", "PRE_OUTPUT"]) {
      assert(controlHooks.some((entry) => entry.hook === hook), hook);
    }
    assertEquals(state.writes, 1);
    assertEquals(state.reads, 1);
    assertStringIncludes(await control(resume), "unavailable");
    assertEquals(approvals, approvalsBeforeResume + 1);
    assertEquals(state.writes, 1);

    if (schedulerConfig && scheduler) {
      const getTrace = (id: string) => {
        const traces = openExecutionTraces(tracePath);
        try {
          const snapshot = traces.archiveSnapshot("scheduled", id, "INTERNAL");
          assert(snapshot);
          return snapshot;
        } finally {
          traces.close();
        }
      };
      const completedTrace = getTrace(ref.id);
      assertEquals(completedTrace.run.status, "completed");
      const recoveryPath = join(baseDir, "agent-recovery.db");
      const completedKey = assignmentRecoveryKey(
        completedTrace.run.scope.sessionId,
        ref.id,
      );
      const readRecovery = () => {
        const store = new AgentRecoveryStore(recoveryPath);
        try {
          return store.read(completedKey);
        } finally {
          store.close();
        }
      };
      const finished = readRecovery();
      assertEquals(finished?.status, "finished");
      const cancelStarted = Promise.withResolvers<void>();
      const releaseCancelled = Promise.withResolvers<void>();
      let terminalModelCalls = 0;
      state.beforeFirstModel = () => {
        terminalModelCalls++;
        cancelStarted.resolve();
        return releaseCancelled.promise;
      };
      const cancelling = scheduler.runTrigger();
      let cancelledId: string;
      const cancelTimeout = setTimeout(
        () =>
          cancelStarted.reject(new Error("Scheduled cancel fixture timed out")),
        5_000,
      );
      try {
        await cancelStarted.promise;
        assert(scheduledId && scheduledId !== ref.id);
        cancelledId = scheduledId;
        const cancellation = JSON.parse(
          await control({
            action: "cancel",
            kind,
            id: cancelledId,
          }),
        );
        assertEquals(cancellation.run.status, "cancelled");
      } finally {
        clearTimeout(cancelTimeout);
        releaseCancelled.resolve();
        await cancelling;
      }
      const cancelledTrace = getTrace(cancelledId);
      assertEquals(cancelledTrace.run.operatorCancelled, true);
      assertEquals(state.writes, 1);
      const cases = [];
      for (const trace of [completedTrace, cancelledTrace]) {
        const { scope } = trace.run;
        const admission = schedulerAdmissionArchive(baseDir, scope)?.read(true);
        assert(admission && "disposition" in admission);
        assertEquals(
          admission.disposition,
          trace.run.operatorCancelled ? "execution_unavailable" : "completed",
        );
        const archiveId = crypto.randomUUID();
        const archived = JSON.parse(
          await control({
            action: "archive",
            kind,
            id: scope.runId,
            requestId: archiveId,
          }),
        );
        assertEquals(archived.receipt.status, "succeeded");
        cases.push({
          trace,
          admission,
          restore: {
            action: "restore",
            kind,
            id: scope.runId,
            archiveId,
            requestId: crypto.randomUUID(),
          },
        });
      }
      scheduler.stop();
      const admissionsPath = join(baseDir, "scheduler-trigger-admissions.db");
      const savedAdmissionsPath = join(baseDir, "terminal-admissions.db");
      await Deno.rename(recoveryPath, join(baseDir, "terminal-recovery.db"));
      await Deno.rename(tracePath, join(baseDir, "terminal-traces.db"));
      await Deno.rename(admissionsPath, savedAdmissionsPath);
      await archiveInbox();

      await Deno.copyFile(savedAdmissionsPath, admissionsPath);
      schedulerAdmissionDatabase(admissionsPath)((db) => {
        db.prepare(
          "UPDATE trigger_admissions SET promptSha256 = ? WHERE id = ?",
        )
          .run("f".repeat(64), ref.id);
      });
      const collision = JSON.parse(
        await control({
          ...cases[0].restore,
          requestId: crypto.randomUUID(),
        }),
      );
      assertEquals(collision.receipt.status, "failed");
      assertEquals(readRecovery(), undefined);
      assertStringIncludes(
        await control({ action: "inspect", ...ref }),
        "unavailable",
      );
      await Deno.rename(
        admissionsPath,
        join(baseDir, "conflicting-terminal-admissions.db"),
      );

      scheduler = createSchedulerService(schedulerConfig);
      for (const { trace, admission, restore } of cases) {
        const restored = JSON.parse(await control(restore));
        assertEquals(restored.receipt.status, "succeeded");
        assertEquals(JSON.parse(await control(restore)), restored);
        const expectedTrace = trace.run.operatorCancelled
          ? trace
          : { ...trace, toolDecisions: [expectedDecision] };
        assertEquals(getTrace(restore.id), expectedTrace);
        assertEquals(
          schedulerAdmissionArchive(baseDir, trace.run.scope)?.read(true),
          admission,
        );
        assertEquals(
          await scheduler.resumeScheduledExecution?.(restore.id),
          false,
        );
      }
      assertEquals(readRecovery(), finished);
      assertEquals(JSON.parse(await control(approvalHistory)).decisions, [
        expectedDecision,
      ]);
      assertEquals(
        JSON.parse(await control({ ...approvalHistory, id: cancelledId }))
          .decisions,
        [],
      );
      assertEquals(inbox.list().records, []);
      assertEquals(await decideBackgroundApproval(inbox, approvalId), false);
      assertEquals(terminalModelCalls, 1);
      assertEquals(state.writes, 1);
      assertEquals(state.reads, 1);
    }

    if (kind === "delegated") {
      const terminalArchiveId = crypto.randomUUID();
      const recoveryPath = join(baseDir, "agent-recovery.db");
      const finishedKey = assignmentRecoveryKey(identity.sessionId, ref.id);
      const journal = new AgentRecoveryStore(recoveryPath);
      const original = journal.read(finishedKey);
      journal.close();
      assertEquals(original?.status, "finished");
      const trace = {
        action: "execution_traces",
        traceRole: ref.kind,
        id: ref.id,
        ordinal: 1,
      };
      const sourceTrace = JSON.parse(await control(trace));
      const terminal = JSON.parse(
        await control({
          action: "archive",
          ...ref,
          requestId: terminalArchiveId,
        }),
      );
      assertEquals(terminal.receipt.status, "succeeded");
      await Deno.rename(recoveryPath, join(baseDir, "terminal-recovery.db"));
      await Deno.rename(tracePath, join(baseDir, "terminal-traces.db"));
      await archiveInbox();
      const restoreTerminal = {
        action: "restore",
        ...ref,
        archiveId: terminalArchiveId,
        requestId: crypto.randomUUID(),
      };
      const restoredTerminal = JSON.parse(await control(restoreTerminal));
      assertEquals(restoredTerminal.receipt.status, "succeeded");
      assertEquals(JSON.parse(await control(approvalHistory)).decisions, [
        expectedDecision,
      ]);
      assertStringIncludes(
        await control(approvalHistory, foreign),
        "unavailable",
      );
      assertEquals(inbox.list().records, []);
      assertEquals(await decideBackgroundApproval(inbox, approvalId), false);
      const beforeRetries = firstModelCalls;
      assertStringIncludes(await send(), "already finished");
      assertEquals(firstModelCalls, beforeRetries);
      assertEquals(JSON.parse(await control(trace)), sourceTrace);
      assertEquals(state.writes, 1);
      assertEquals(state.reads, 1);
      const reopened = new AgentRecoveryStore(recoveryPath);
      try {
        assertEquals(reopened.read(finishedKey), original);
      } finally {
        reopened.close();
      }
      assertEquals(
        JSON.parse(await control(restoreTerminal)),
        restoredTerminal,
      );
    }
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
  const baseDir = await Deno.makeTempDir({ dir: Deno.cwd() });
  const fixture = backgroundFixture(baseDir, "scheduled", true);
  const { state } = fixture;
  await chooseBackgroundRoute(baseDir, "fixture");
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
    await chooseBackgroundRoute(baseDir, "alternate");
    state.providerCalls.length = 0;
    state.routeNames = ["alternate"];
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
      const denied = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      assertEquals(denied.status, 409);
      await denied.text();
      assertEquals(state.providerCalls, []);
      assertEquals(state.writes, 1);
      state.routeNames = ["fixture", "alternate"];
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
      assertEquals(state.providerCalls, ["fixture", "fixture"]);
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
  const baseDir = await Deno.makeTempDir({ dir: Deno.cwd() });
  const fixture = backgroundFixture(baseDir, "team", true);
  const { state } = fixture;
  state.routingEnabled = false;
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
    await chooseBackgroundRoute(baseDir, "fixture");
    state.routingEnabled = true;
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
    await chooseBackgroundRoute(cleanRoot, "alternate");
    const target = backgroundFixture(cleanRoot, "team", true);
    target.state.interruption = undefined;
    const resume = (
      request = instructions,
      explicit = true,
      exactDelivery = interruptedDelivery,
    ) =>
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
        }${exactDelivery} ${team.value.id} ${member.sessionId} ${request}`,
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
      let terminalRetryModelCalls = 0;
      target.state.beforeFirstModel = () => {
        terminalRetryModelCalls++;
        return Promise.resolve();
      };
      assertStringIncludes(
        await resume(instructions, false, deliveryId),
        "already finished",
      );
      assertEquals(terminalRetryModelCalls, 0);
      assertEquals(target.state.writes, 0);
      const archivedDelivery = (root: string) =>
        withTeamRecoveryStore(
          join(root, "team-recovery.db"),
          (store) => store.delivery(deliveryId),
        );
      const originalDelivery = archivedDelivery(baseDir);
      assert(originalDelivery);
      assertEquals(archivedDelivery(cleanRoot), originalDelivery);
      const terminalKey = assignmentRecoveryKey(member.sessionId, runId);
      const sourceRecovery = new AgentRecoveryStore(
        join(baseDir, "agent-recovery.db"),
      );
      try {
        assertEquals(
          restoredRecovery.read(terminalKey),
          sourceRecovery.read(terminalKey),
        );
      } finally {
        sourceRecovery.close();
      }
      assertStringIncludes(
        await resume("different request"),
        "scope or request changed",
      );
      assertStringIncludes(await resume(instructions, false), "paused");
      target.state.routeNames = ["alternate"];
      assertStringIncludes(
        await resume(),
        "original approved model route is unavailable",
      );
      assertEquals(target.state.providerCalls, []);
      assertEquals(target.state.writes, 0);
      assertEquals(target.state.reads, 0);
      target.state.routeNames = ["fixture", "alternate"];
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
      assertEquals(target.state.providerCalls, ["fixture", "fixture"]);
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
    await Deno.rename(
      join(cleanRoot, "agent-recovery.db"),
      join(cleanRoot, "legacy-team-recovery.db"),
    );
    const modelCallsBeforeLegacy = target.state.results.length;
    assertStringIncludes(
      await resume(instructions, false, deliveryId),
      "already finished",
    );
    assertEquals(target.state.results.length, modelCallsBeforeLegacy);
    assertEquals(target.state.writes, 0);
    assertEquals(target.state.reads, 1);

    const zeroDelivery = crypto.randomUUID();
    const zeroRunId = await teamDeliveryExecutionId(
      parent.id,
      member.sessionId,
      zeroDelivery,
    );
    const beforeFirstTool = Promise.withResolvers<void>();
    const releaseFirstModel = Promise.withResolvers<void>();
    state.beforeFirstModel = () => {
      beforeFirstTool.resolve();
      return releaseFirstModel.promise;
    };
    const zeroRunning = send(zeroDelivery);
    const zeroTimeout = setTimeout(
      () =>
        beforeFirstTool.reject(new Error("Team delivery model did not start")),
      5_000,
    );
    const zeroControl = { kind: "delegated", id: zeroRunId };
    const priorWrites = state.writes;
    try {
      await beforeFirstTool.promise;
      const paused = JSON.parse(
        await archiveTool(baseDir, parent, {
          action: "pause",
          ...zeroControl,
        }),
      );
      assertEquals(paused.run.status, "paused");
      assertEquals(paused.pauseRequested, true);
    } finally {
      clearTimeout(zeroTimeout);
      releaseFirstModel.resolve();
      await zeroRunning;
      state.beforeFirstModel = undefined;
    }
    assertEquals(state.writes, priorWrites);
    const zeroArchiveId = crypto.randomUUID();
    const zeroArchive = {
      kind: "team_delivery",
      id: [team.value.id, member.sessionId, zeroDelivery].join(":"),
    };
    assertEquals(
      JSON.parse(
        await archiveTool(baseDir, parent, {
          action: "archive",
          ...zeroArchive,
          requestId: zeroArchiveId,
        }),
      ).receipt.status,
      "succeeded",
    );
    const zeroArtifact = await Deno.readTextFile(join(
      baseDir,
      "data",
      "run-archives",
      zeroArchiveId,
      "execution-trace.json",
    ));
    assert(!zeroArtifact.includes(instructions));
    const zeroRoot = await Deno.makeTempDir({ dir: baseDir });
    await Deno.mkdir(join(zeroRoot, "data"));
    await Deno.rename(
      join(baseDir, "data", "run-archives"),
      join(zeroRoot, "data", "run-archives"),
    );
    const zeroRestore = {
      action: "restore",
      ...zeroArchive,
      archiveId: zeroArchiveId,
      requestId: crypto.randomUUID(),
    };
    assertStringIncludes(
      await archiveTool(zeroRoot, foreign, zeroRestore),
      "unavailable",
    );
    const restoredZero = JSON.parse(
      await archiveTool(zeroRoot, parent, zeroRestore),
    );
    assertEquals(restoredZero.receipt.status, "succeeded");
    assertEquals(
      JSON.parse(await archiveTool(zeroRoot, parent, zeroRestore)),
      restoredZero,
    );
    const zeroStore = new AgentRecoveryStore(
      join(zeroRoot, "agent-recovery.db"),
    );
    try {
      const empty = zeroStore.read(
        assignmentRecoveryKey(member.sessionId, zeroRunId),
      );
      assert(empty?.status === "paused");
      assertEquals(empty.committedBatch, 0);
      assertEquals(empty.checkpoint, undefined);
      assertEquals(empty.tools, []);
    } finally {
      zeroStore.close();
    }
    const restoredEmptyTrace = await archiveTool(zeroRoot, parent, {
      action: "execution_traces",
      traceRole: "delegated",
      id: zeroRunId,
    });
    assertEquals(JSON.parse(restoredEmptyTrace).page.steps, []);
    const zeroTarget = backgroundFixture(zeroRoot, "team");
    zeroTarget.state.interruption = undefined;
    const zeroTeamCommand =
      makeManager(zeroRoot, zeroTarget.orchestratorFactory).runRecoveryCommand;
    const resumeZero = (originalTask = instructions, deny = false) =>
      archiveTool(
        zeroRoot,
        parent,
        {
          action: "resume",
          ...zeroControl,
          originalTask,
        },
        deny,
        zeroTeamCommand,
      );
    assertStringIncludes(await resumeZero(), "unavailable");
    assertEquals(zeroTarget.state.writes, 0);
    const admitted = withTeamRecoveryStore(
      join(baseDir, "team-recovery.db"),
      (store) => ({
        member: store.member(member.sessionId),
        delivery: store.delivery(zeroDelivery),
      }),
    );
    const storedMember = admitted.member;
    assert(storedMember && admitted.delivery);
    withTeamRecoveryStore(join(zeroRoot, "team-recovery.db"), (store) => {
      assertEquals(store.delivery(zeroDelivery), admitted.delivery);
      assertEquals(store.member(member.sessionId), undefined);
      assert(store.registerMember(storedMember));
    });
    assertStringIncludes(await resumeZero("different task"), "unavailable");
    const approvalsBeforeDenial = approvals;
    await resumeZero(instructions, true);
    assertEquals(approvals, approvalsBeforeDenial);
    assertEquals(zeroTarget.state.writes, 0);
    zeroTarget.state.requireReadApproval = true;
    const completingTeam = resumeZero();
    const teamApprovalId = await approveBackgroundRead(
      zeroTarget.inbox,
      zeroRunId,
    );
    const resumedZero = JSON.parse(await completingTeam);
    assertEquals(resumedZero.run.status, "completed");
    assertEquals(zeroTarget.state.writes, 1);
    assertEquals(zeroTarget.state.reads, 1);
    assertStringIncludes(await resumeZero(), "unavailable");
    assertEquals(zeroTarget.state.writes, 1);

    const completedApprovalId = crypto.randomUUID();
    const completedTeam = await archiveTool(zeroRoot, parent, {
      action: "archive",
      ...zeroArchive,
      requestId: completedApprovalId,
    });
    assertEquals(JSON.parse(completedTeam).receipt.status, "succeeded");
    for (
      const filename of [
        "agent-recovery.db",
        "execution-traces.db",
        "tool-approvals.db",
        "team-recovery.db",
      ]
    ) {
      await Deno.rename(
        join(zeroRoot, filename),
        join(zeroRoot, `approval-source-${filename}`),
      );
    }
    assertEquals(
      JSON.parse(
        await archiveTool(zeroRoot, parent, {
          action: "restore",
          ...zeroArchive,
          archiveId: completedApprovalId,
          requestId: crypto.randomUUID(),
        }),
      ).receipt.status,
      "succeeded",
    );
    const teamHistory = { action: "approval_history", ...zeroControl };
    const retainedApprovals =
      JSON.parse(await archiveTool(zeroRoot, parent, teamHistory)).decisions;
    assertEquals(retainedApprovals.length, 1);
    assertEquals(retainedApprovals[0].id, teamApprovalId);
    assertEquals(retainedApprovals[0].runId, zeroRunId);
    assertEquals(retainedApprovals[0].dispatchOutcome, "returned");
    assertStringIncludes(
      await archiveTool(zeroRoot, foreign, teamHistory),
      "unavailable",
    );
    const exactTeamHistory = { action: "approval_history", ...zeroArchive };
    assertEquals(
      JSON.parse(await archiveTool(zeroRoot, parent, exactTeamHistory)),
      {
        _classification: "INTERNAL",
        run: zeroArchive,
        decisions: retainedApprovals,
        nextOffset: null,
      },
    );
    assertStringIncludes(
      await archiveTool(zeroRoot, foreign, exactTeamHistory),
      "unavailable",
    );
    assertStringIncludes(
      await archiveTool(zeroRoot, parent, {
        ...exactTeamHistory,
        id: [crypto.randomUUID(), member.sessionId, zeroDelivery].join(":"),
      }),
      "unavailable",
    );
    assertEquals(zeroTarget.inbox.list().records, []);
    assertEquals(
      zeroTarget.inbox.decide(teamApprovalId, "approved"),
      undefined,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
