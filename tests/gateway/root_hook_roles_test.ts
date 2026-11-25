import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { openExecutionTraces } from "../../src/core/execution_traces.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
  type HookLogEntry,
} from "../../src/core/policy/hooks/hooks.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createSqliteStorage } from "../../src/core/storage/sqlite.ts";
import {
  type ClassificationLevel,
  maxClassification,
} from "../../src/core/types/classification.ts";
import {
  type ChannelId,
  createSession,
  restoreSession,
  updateTaint,
  type UserId,
} from "../../src/core/types/session.ts";
import type { ToolExecutionContext } from "../../src/core/types/tool.ts";
import { createWorkspace } from "../../src/exec/workspace.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { initializeFactoryInfra } from "../../src/gateway/startup/factory/orchestrator_factory_infra.ts";
import { assembleSchedulerToolExecutor } from "../../src/gateway/startup/tools/scheduler_tool_assembly.ts";
import { resolveToolsForProfile } from "../../src/gateway/tools/agent_tools.ts";
import { createGitHubToolExecutor } from "../../src/integrations/github/tools.ts";
import { createSchedulerService } from "../../src/scheduler/service.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";
import {
  createTodoManager,
  createTodoToolExecutor,
} from "../../src/tools/todo.ts";

const evidence = "private connector fixture evidence";
const name = "fixture_connector";
const finalText = "Completed fixture review.";
const prompt = "Run the fixture connector.";
const toolDefinitions = [{
  name,
  description: "Fixture connector",
  parameters: {},
}];
const usage = { inputTokens: 1, outputTokens: 1 };

function fixture(mode: "pre" | "post" | "allow") {
  const audit: HookLogEntry[] = [];
  const observed: string[] = [];
  const connectorEffects = createMemoryStorage();
  const conversations = createMemoryStorage();
  const messageStore = createMessageStore(conversations);
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  if (mode === "pre") {
    engine.addRule({
      id: "fixture-pre-denied",
      priority: 999,
      hook: "PRE_TOOL_CALL",
      conditions: [],
      action: "BLOCK",
    });
  }
  if (mode === "post") {
    engine.addRule({
      id: "fixture-post-redacted",
      priority: 999,
      hook: "POST_TOOL_RESPONSE",
      conditions: [
        { field: "tool_name", operator: "equals", value: name },
        { field: "tool_response", operator: "contains", value: evidence },
        { field: "session_taint", operator: "equals", value: "INTERNAL" },
      ],
      action: "REDACT",
    });
  }
  const hookRunner = createHookRunner(engine, {
    logger: { log: (entry) => audit.push(entry) },
  });
  const providerRegistry = createProviderRegistry();
  providerRegistry.register({
    name: "fixture",
    supportsStreaming: false,
    complete(messages) {
      const response = messages.findLast(({ role }) => role === "tool");
      if (response) observed.push(String(response.content));
      return Promise.resolve({
        content: response ? finalText : "",
        toolCalls: response ? [] : [{
          id: "fixture-call",
          type: "function",
          function: { name, arguments: "{}" },
        }],
        usage,
      });
    },
  });
  providerRegistry.setDefault("fixture");
  const config = {
    providerRegistry,
    hookRunner,
    messageStore,
    tools: toolDefinitions,
    toolClassifications: new Map([[name, "PUBLIC"]] as const),
    enableStreaming: false,
    async toolExecutor(tool: string) {
      if (tool !== name) {
        return "Fixture has no result for this service lookup.";
      }
      await connectorEffects.set("handler-executed", "true");
      return JSON.stringify({ _classification: "INTERNAL", evidence });
    },
  };
  return { audit, observed, config, conversations, connectorEffects };
}

async function runSocket(
  config: Omit<Parameters<typeof createChatSession>[0], "session">,
) {
  const chatSession = createChatSession({
    ...config,
    session: createSession({
      userId: "owner" as UserId,
      channelId: "socket" as ChannelId,
    }),
  });
  const token = crypto.randomUUID();
  const server = createGatewayServer({ port: 0, token, chatSession });
  const { port } = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  const received = Promise.withResolvers<string[]>();
  const events: string[] = [];
  socket.addEventListener("message", ({ data }) => {
    events.push(String(data));
    if (JSON.parse(data).type === "turn_end") received.resolve(events);
  });
  const timer = setTimeout(
    () =>
      received.reject(new Error("Gateway did not complete the fixture turn")),
    3000,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({ type: "message", content: prompt }));
    return await received.promise;
  } finally {
    clearTimeout(timer);
    socket.close();
    await closed.promise;
    await server.stop();
  }
}

for (const role of ["socket", "delegated", "scheduled"] as const) {
  Deno.test(`Revisioned todo writes reject stale and malformed changes through the ${role} entry point`, async () => {
    const directory = await Deno.makeTempDir();
    const path = join(directory, "todos.db");
    const todo = {
      id: "task",
      content: "Review controls",
      status: "pending" as const,
      priority: "high" as const,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const audit: HookLogEntry[] = [];
    const engine = createPolicyEngine();
    for (const rule of createDefaultRules()) engine.addRule(rule);
    const hookRunner = createHookRunner(engine, {
      logger: { log: (entry) => audit.push(entry) },
    });
    const profile = role === "socket"
      ? "cli"
      : role === "delegated"
      ? "subagent"
      : "triggerSession";
    const tools = resolveToolsForProfile(profile).filter(({ name }) =>
      name.startsWith("todo_")
    );
    const backgroundSession = createSession({
      userId: "fixture" as UserId,
      channelId: role as ChannelId,
    });
    const infra = role === "socket" ? undefined : initializeFactoryInfra(
      {
        models: { primary: { provider: "fixture" }, providers: {} },
        channels: {},
        classification: { mode: "personal" },
      },
      directory,
    );
    assert(
      tools.find(({ name }) => name === "todo_write")?.parameters
        .expected_revision,
    );
    const turn = async (
      name: string,
      args: Record<string, unknown>,
      source = backgroundSession,
      level: ClassificationLevel = "PUBLIC",
      ceiling = level,
    ): Promise<string> => {
      const storage = createSqliteStorage(path);
      let result = "";
      const providerRegistry = createProviderRegistry();
      providerRegistry.register({
        name: "todo-revision-fixture",
        supportsStreaming: false,
        complete(messages, definitions) {
          assert(
            definitions?.some((entry) =>
              (entry as { function?: { name: string } }).function?.name === name
            ),
          );
          const response = messages.findLast(({ role }) => role === "tool");
          if (response) result = String(response.content);
          return Promise.resolve({
            content: response ? finalText : "",
            toolCalls: response ? [] : [{
              id: crypto.randomUUID(),
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            }],
            usage,
          });
        },
      });
      providerRegistry.setDefault("todo-revision-fixture");
      try {
        const session = updateTaint(
          restoreSession({
            id: source.id,
            userId: source.userId,
            channelId: source.channelId,
          }),
          level,
          "fixture classification",
        );
        const agentId = crypto.randomUUID();
        const execute = infra
          ? assembleSchedulerToolExecutor({
            infra,
            session,
            storage,
            agentId,
            workspace: await createWorkspace({ agentId, basePath: directory }),
            githubExecutor: createGitHubToolExecutor(undefined),
          })
          : createTodoToolExecutor(
            createTodoManager({ storage, agentId: role }),
          );
        const config = {
          providerRegistry,
          hookRunner,
          tools,
          enableStreaming: false,
          messageStore: createMessageStore(storage),
          toolClassifications: new Map([["todo_", "PUBLIC"]] as const),
          toolExecutor: async (
            name: string,
            args: Record<string, unknown>,
            context?: ToolExecutionContext,
          ) => await execute(name, args, context) ?? "Unknown todo tool",
        };
        const factory = backgroundFactory(config, session, ceiling);
        const output = role === "socket"
          ? (await runSocket(config)).join("\n")
          : role === "delegated"
          ? await buildSubagentFactory(factory)(prompt)
          : (await runTrigger(factory, ceiling)).join("\n");
        if (role !== "delegated" || level === ceiling) {
          assertStringIncludes(output, finalText);
        } else {
          assert(!output.includes(finalText));
        }
        return result;
      } finally {
        await storage.close();
      }
    };
    try {
      const initial = JSON.parse(await turn("todo_write", { todos: [todo] }));
      const saved = JSON.parse(await turn("todo_read", {}));
      assertEquals(saved, initial);
      const next = JSON.parse(
        await turn("todo_write", {
          todos: [{ ...todo, status: "completed" }],
          expected_revision: saved.revision,
        }),
      );
      assert(next.revision !== saved.revision);
      assertEquals(next.todos[0].status, "completed");
      assertStringIncludes(
        await turn("todo_write", {
          todos: [],
          expected_revision: saved.revision,
        }),
        "revision unavailable or changed",
      );
      assertStringIncludes(
        await turn("todo_write", { todos: [todo, todo] }),
        "distinct IDs",
      );
      assertEquals(JSON.parse(await turn("todo_read", {})), next);
      const concurrent = await Promise.all(
        ["Inspect audit trail", "Confirm asset ownership"].map((content) =>
          turn("todo_write", {
            todos: [{ ...todo, content }],
            expected_revision: next.revision,
          })
        ),
      );
      const winner = concurrent.find((result) => result.startsWith("{"));
      assert(winner);
      assertEquals(
        concurrent.filter((text) => text.startsWith("Error:")).length,
        1,
      );
      assertEquals(JSON.parse(await turn("todo_read", {})), JSON.parse(winner));
      let persisted = JSON.parse(winner);
      let persistedLevel: ClassificationLevel = "PUBLIC";
      if (infra) {
        const otherSession = createSession({
          userId: backgroundSession.userId,
          channelId: backgroundSession.channelId,
        });
        assertStringIncludes(
          await turn("todo_read", {}, otherSession),
          "No todos",
        );
        const sensitive = JSON.parse(
          await turn(
            "todo_write",
            {
              todos: [{ ...todo, content: "Internal checklist entry" }],
              _classification: "PUBLIC",
              expected_revision: JSON.parse(winner).revision,
            },
            backgroundSession,
            "INTERNAL",
          ),
        );
        assertEquals(sensitive._classification, "INTERNAL");
        assertStringIncludes(await turn("todo_read", {}), "classification");
        assertStringIncludes(
          await turn("todo_write", { todos: [] }),
          "classification",
        );
        const opened = JSON.parse(
          await turn("todo_read", {}, backgroundSession, "INTERNAL"),
        );
        assertEquals(opened, sensitive);
        assertEquals(
          JSON.parse(
            await turn(
              "todo_read",
              {},
              backgroundSession,
              "PUBLIC",
              "INTERNAL",
            ),
          ),
          sensitive,
        );
        assertStringIncludes(
          await turn(
            "todo_write",
            {
              todos: [{ ...todo, content: "Bearer fake-credential-token" }],
            },
            backgroundSession,
            "INTERNAL",
          ),
          "credential-bearing",
        );
        const legacy = createSqliteStorage(path);
        await legacy.set(
          `todos:recovery-${otherSession.id}`,
          JSON.stringify({
            todos: [{ ...todo, content: "Legacy checklist entry" }],
            revision: crypto.randomUUID(),
          }),
        );
        await legacy.close();
        assertStringIncludes(
          await turn("todo_read", {}, otherSession, "INTERNAL"),
          "classification",
        );
        assertStringIncludes(
          await turn("todo_write", { todos: [todo] }, otherSession, "INTERNAL"),
          "classification",
        );
        const cleared = JSON.parse(
          await turn("todo_write", { todos: [] }, otherSession, "INTERNAL"),
        );
        assertEquals(cleared.todos, []);
        assertEquals(cleared._classification, "INTERNAL");
        assertEquals(
          JSON.parse(
            await turn("todo_read", {}, backgroundSession, "INTERNAL"),
          ),
          sensitive,
        );
        persisted = sensitive;
        persistedLevel = "INTERNAL";
      }
      for (
        const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE", "PRE_OUTPUT"]
      ) {
        assert(
          audit.some((entry) => entry.hook === hook && entry.result.allowed),
        );
      }
      engine.addRule({
        id: "fixture-block-todo-mutation",
        priority: 999,
        hook: "PRE_TOOL_CALL",
        conditions: [
          { field: "tool_name", operator: "equals", value: "todo_write" },
        ],
        action: "BLOCK",
      });
      await turn(
        "todo_write",
        { todos: [], expected_revision: persisted.revision },
        backgroundSession,
        persistedLevel,
      );
      assert(
        audit.some(({ hook, result }) =>
          hook === "PRE_TOOL_CALL" && !result.allowed
        ),
      );
      assertEquals(
        JSON.parse(
          await turn("todo_read", {}, backgroundSession, persistedLevel),
        ),
        persisted,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
}

function backgroundFactory(
  config:
    & Pick<
      Parameters<typeof createOrchestrator>[0],
      | "providerRegistry"
      | "hookRunner"
      | "messageStore"
      | "tools"
      | "toolClassifications"
      | "enableStreaming"
    >
    & Required<Pick<Parameters<typeof createOrchestrator>[0], "toolExecutor">>,
  trustedSession?: ReturnType<typeof createSession>,
  trustedCeiling?: ClassificationLevel,
): OrchestratorFactory {
  return {
    create(channelId, options) {
      if (channelId === "subagent") {
        assertEquals(options?.delegatedKind, "subagent");
      } else assertEquals(options?.isTrigger, true);
      const session = trustedSession ?? createSession({
        userId: "fixture" as UserId,
        channelId: channelId as ChannelId,
      });
      let taint = session.taint;
      const getSessionTaint = () => taint;
      const orchestrator = createOrchestrator({
        ...config,
        getSessionTaint,
        escalateTaint: (level) => {
          taint = maxClassification(taint, level);
        },
        getNonOwnerCeiling: () => trustedCeiling ?? "PUBLIC",
        isOwnerSession: () => false,
        isTriggerSession: () => options?.isTrigger === true,
      });
      return Promise.resolve({
        orchestrator,
        session,
        toolExecutor: config.toolExecutor,
        getSessionTaint,
      });
    },
  };
}

async function runTrigger(
  factory: OrchestratorFactory,
  ceiling: ClassificationLevel = "PUBLIC",
) {
  const directory = await Deno.makeTempDir();
  const triggerMdPath = join(directory, "TRIGGER.md");
  const delivered: string[] = [];
  const service = createSchedulerService({
    orchestratorFactory: factory,
    triggerMdPath,
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: ceiling,
    },
    webhooks: { enabled: false, sources: {} },
    onTriggerOutput: (_source, _classification, preview) =>
      delivered.push(preview),
  });
  try {
    await Deno.writeTextFile(triggerMdPath, prompt);
    await service.runTrigger();
    return delivered;
  } finally {
    service.stop();
    await Deno.remove(directory, { recursive: true });
  }
}

for (const role of ["socket", "delegated", "scheduled"] as const) {
  Deno.test(`Root policy hook sequence reaches the real ${role} entry point`, async () => {
    for (const mode of ["pre", "post", "allow"] as const) {
      const state = fixture(mode);
      const factory = backgroundFactory(state.config);
      const output = role === "socket"
        ? (await runSocket(state.config)).join("\n")
        : role === "delegated"
        ? await buildSubagentFactory(factory)(prompt)
        : (await runTrigger(factory)).join("\n");
      const post = state.audit.find(({ hook }) =>
        hook === "POST_TOOL_RESPONSE"
      );
      const delivery = state.audit.find(({ hook }) => hook === "PRE_OUTPUT");
      const stored = await Promise.all(
        (await state.conversations.list("conv:")).map(
          (key) => state.conversations.get(key),
        ),
      );
      assertEquals(
        await state.connectorEffects.get("handler-executed"),
        mode === "pre" ? null : "true",
      );
      assert(
        state.audit.some(({ hook, result }) =>
          hook === "PRE_TOOL_CALL" && result.allowed === (mode !== "pre")
        ),
      );
      if (mode === "pre") {
        assertEquals(post, undefined);
        assert(!stored.some((entry) => /"role":"tool_call"/.test(entry ?? "")));
      } else {
        assertEquals(post?.input.session_taint, "INTERNAL");
        assertEquals(post?.result.allowed, mode === "allow");
        assert(!JSON.stringify(post).includes(evidence));
      }
      if (mode === "post") {
        assertEquals(post?.result.action, "REDACT");
        assertEquals(state.observed, ["Tool response withheld by policy."]);
        assert(!JSON.stringify(stored).includes(evidence));
        assert(!output.includes(evidence));
      }
      if (mode === "allow") {
        assertStringIncludes(state.observed[0], evidence);
      }
      if (mode !== "pre" && role !== "socket") {
        assertEquals(delivery?.result.allowed, false);
        assert(!output.includes(finalText));
      } else {
        assertEquals(delivery?.result.allowed, true);
        assertStringIncludes(output, finalText);
      }
    }
  });
}

Deno.test("Delegated execution saves classified tool outcomes under separate trusted run identities", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "execution-traces.db");
  try {
    for (const mode of ["pre", "post", "allow"] as const) {
      await buildSubagentFactory(backgroundFactory(fixture(mode).config), {
        executionTracePath: path,
      })(prompt);
    }
    const reopened = openExecutionTraces(path);
    try {
      const scoped = reopened.listRuns({
        role: "delegated",
        ceiling: "INTERNAL",
      });
      const runs = scoped?.runs ?? [];
      assertEquals(runs.length, 3);
      assert(
        runs.every(({ status, finishedAt }) =>
          status !== "running" && !!finishedAt
        ),
      );
      assertEquals(new Set(runs.map(({ scope }) => scope.runId)).size, 3);
      assertEquals(new Set(runs.map(({ scope }) => scope.sessionId)).size, 3);
      const steps = runs.map(({ scope }) =>
        reopened.list(scope, { ceiling: "INTERNAL" })?.steps ?? []
      );
      assertEquals(
        steps.map((list) =>
          list.map(({ tool, outcome, ordinal }) => ({ tool, outcome, ordinal }))
        ),
        [
          [{ tool: name, outcome: "returned", ordinal: 1 }],
          [{ tool: name, outcome: "blocked", ordinal: 1 }],
          [{ tool: name, outcome: "blocked", ordinal: 1 }],
        ],
      );
      assertEquals(steps[0][0].classification, "INTERNAL");
      assertEquals(
        reopened.list(runs[0].scope, { ceiling: "PUBLIC" }),
        undefined,
      );
      assertEquals(
        reopened.list(
          { ...runs[0].scope, sessionId: runs[1].scope.sessionId },
          { ceiling: "INTERNAL" },
        ),
        undefined,
      );
      assert(!JSON.stringify({ runs, steps }).includes(evidence));
      assert(!JSON.stringify({ runs, steps }).includes(prompt));
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
