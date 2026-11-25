import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
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
  type UserId,
} from "../../src/core/types/session.ts";
import { createWorkspace } from "../../src/exec/workspace.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { executeOperatorRunArchive } from "../../src/gateway/operator_run_archive.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildWorkflowRecoveryExecutor } from "../../src/gateway/startup/factory/agent_recovery.ts";
import { initializeFactoryInfra } from "../../src/gateway/startup/factory/orchestrator_factory_infra.ts";
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
  agent_recovery: { scheduler: true, background_checklists: true },
  classification: { mode: "personal" },
  channels: {},
  models: { primary: { provider: "fixture" }, providers: {} },
};

function backgroundFixture(baseDir: string, role: "delegated" | "scheduled") {
  const tracePath = join(baseDir, "execution-traces.db");
  const infra = initializeFactoryInfra(config, baseDir);
  const storage = createMemoryStorage();
  const state = {
    interruption: (role === "delegated" ? "before" : "after") as
      | "before"
      | "after"
      | undefined,
    rejectSavedWrite: false,
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
    complete(messages) {
      const prior = messages.filter(({ role }) => role === "tool");
      state.results = prior.map(({ content }) => String(content));
      const usage = { inputTokens: 1, outputTokens: 1 };
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
      assert(identity && id);
      const session = restoreSession({
        channelId: channel as ChannelId,
        userId: "owner" as UserId,
        id,
      });
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
        executionChecklist: { path: tracePath, role, runId: identity },
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
    const gatewayToken = crypto.randomUUID();
    const server = createGatewayServer({
      port: 0,
      token: gatewayToken,
      chatSession: createChatSession({
        session: parent,
        providerRegistry: createProviderRegistry(),
        hookRunner: createHookRunner(createPolicyEngine()),
        runSubagentRecoveryCommand,
      }),
    });
    const { port } = await server.start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${gatewayToken}`,
    );
    const done = Promise.withResolvers<void>();
    const events: string[] = [];
    const timer = setTimeout(
      () => done.reject(new Error("Delegated gateway timeout")),
      5000,
    );
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "message", content: request }));
    socket.onmessage = ({ data }) => {
      events.push(String(data));
      if (JSON.parse(data).type === "turn_end") done.resolve();
    };
    socket.onerror = () => done.reject(new Error("Delegated gateway error"));
    try {
      await done.promise;
      return events.join("\n");
    } finally {
      clearTimeout(timer);
      socket.close();
      await server.stop();
    }
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
