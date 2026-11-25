import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
} from "../../src/core/policy/hooks/hooks.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildWorkflowRecoveryExecutor } from "../../src/gateway/startup/factory/agent_recovery.ts";
import {
  buildTodoToolDefinitions,
  createTodoManager,
  createTodoToolExecutor,
} from "../../src/tools/todo.ts";

Deno.test("Owner gateway archives, restores and resumes one exact recoverable checklist", async () => {
  const baseDir = await Deno.makeTempDir();
  const recoveryPath = join(baseDir, "agent-recovery.db");
  const owner = createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  });
  const outsider = createSession({
    userId: owner.userId,
    channelId: owner.channelId,
  });
  const execution = crypto.randomUUID();
  const note = {
    id: "fixture-task",
    content: "Check the exact recovered checklist",
    status: "pending" as const,
    priority: "high" as const,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const shared = createTodoManager({
    storage: createMemoryStorage(),
    agentId: "main-session",
  });
  const sharedBefore = await shared.write([{
    ...note,
    content: "Shared owner item",
  }]);
  const executeShared = createTodoToolExecutor(shared);
  const configuredRecovery = buildWorkflowRecoveryExecutor(
    { agent_recovery: { owner_checklists: true } },
    baseDir,
    createMemorySecretStore(),
    undefined,
    undefined,
    true,
  );
  assert(configuredRecovery);
  const recover = configuredRecovery;
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  let modelWrites = 0;
  let expectedRevision: string | undefined;
  const prompt = "Create a recoverable checklist.";

  async function turn(request: string, opts?: {
    session?: typeof owner;
    interrupt?: boolean;
  }) {
    const registry = createProviderRegistry();
    let observed: string | undefined;
    registry.register({
      name: "checklist-fixture",
      supportsStreaming: false,
      complete(messages) {
        const saved = messages.findLast(({ role }) => role === "tool");
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (saved) {
          observed = String(saved.content);
          return Promise.resolve({
            content: "Checklist operation complete.",
            usage,
            toolCalls: [],
          });
        }
        const last = String(
          messages.findLast(({ role }) => role === "user")?.content,
        );
        const command = last.startsWith("{")
          ? { name: "operator_runs", args: JSON.parse(last) }
          : last === prompt
          ? {
            name: "todo_write",
            args: { expected_revision: "empty", todos: [note] },
          }
          : { name: "todo_read", args: {} };
        if (command.name === "todo_write") modelWrites++;
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [{
            type: "function",
            id: crypto.randomUUID(),
            function: {
              name: command.name,
              arguments: JSON.stringify(command.args),
            },
          }],
        });
      },
    });
    registry.setDefault("checklist-fixture");
    const gatewayToken = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token: gatewayToken,
      chatSession: createChatSession({
        session: opts?.session ?? owner,
        providerRegistry: registry,
        hookRunner: createHookRunner(engine),
        enableStreaming: false,
        tools: buildTodoToolDefinitions({ revisioned: true }),
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          confirm: () => Promise.resolve(true),
        }),
        async toolExecutor(name, args, context) {
          return await executeShared(name, args, context) ??
            "Unknown fixture tool";
        },
        recoverAgentTurn: (id, orch, options, control, context) =>
          recover(
            id,
            {
              executeAgentTurn: (options) =>
                orch.executeAgentTurn({
                  ...options,
                  ...(opts?.interrupt && {
                    async onToolBatchCheckpoint(batch) {
                      await options.onToolBatchCheckpoint?.(batch);
                      throw new Error(
                        "fixture interruption after durable checkpoint",
                      );
                    },
                  }),
                }),
            },
            options,
            control,
            context,
          ),
      }),
    });
    const { port } = await gateway.start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${gatewayToken}`,
    );
    const completed = Promise.withResolvers<void>();
    let error: string | undefined;
    const timer = setTimeout(
      () => completed.reject(new Error("Fixture timed out")),
      5000,
    );
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "message", content: request }));
    socket.onerror = () => completed.reject(new Error("Fixture disconnected"));
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.type === "error") error = event.message;
      if (event.type === "turn_end") completed.resolve();
    };
    try {
      await completed.promise;
      return { error, observed };
    } finally {
      clearTimeout(timer);
      socket.close();
      await gateway.stop();
    }
  }
  try {
    const recoverRequest = `/recover ${execution} ${prompt}`;
    const interrupted = await turn(recoverRequest, { interrupt: true });
    assertStringIncludes(interrupted.error ?? "", "checkpoint");
    assertEquals(modelWrites, 1);
    const requestId = crypto.randomUUID();
    const ref = { kind: "owner_chat", id: execution };
    const archive = JSON.stringify({ ...ref, action: "archive", requestId });
    const archived = await turn(archive);
    assertEquals(JSON.parse(archived.observed!).receipt.status, "succeeded");
    const archiveFile = join(
      baseDir,
      "data",
      "run-archives",
      requestId,
      "owner-checkpoint.json",
    );
    const saved = JSON.parse(await Deno.readTextFile(archiveFile));
    expectedRevision = JSON.parse(saved.checklist.contents).revision;
    assertEquals(saved.checklist.sessionId, owner.id);
    assertEquals(saved.checklist.runId, execution);
    assertEquals(saved.tools[0].args, { expected_revision: "empty" });
    await Deno.rename(recoveryPath, join(baseDir, "old-recovery.db"));
    const restore = JSON.stringify({
      ...ref,
      action: "restore",
      requestId: crypto.randomUUID(),
      archiveId: requestId,
    });
    const wrongOwner = await turn(restore, { session: outsider });
    assertStringIncludes(wrongOwner.observed ?? "", "unavailable");
    const restored = await turn(restore);
    assertEquals(JSON.parse(restored.observed!).receipt.status, "succeeded");
    assertEquals((await turn(restore)).observed, restored.observed);
    assertStringIncludes((await turn(recoverRequest)).error ?? "", "paused");
    const resume = await turn(
      `/recover --resume-paused ${execution} ${prompt}`,
    );
    assertEquals(resume.error, undefined);
    const checklist = JSON.parse(resume.observed!);
    assertEquals(checklist.todos, [note]);
    assertEquals(checklist.revision, expectedRevision);
    assertEquals(checklist._classification, "PUBLIC");
    assertEquals(modelWrites, 1);
    assertEquals(
      JSON.parse((await turn("Read shared owner list")).observed!),
      sharedBefore,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
