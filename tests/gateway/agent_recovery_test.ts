import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import {
  createFileWriter,
  initAuditLog,
  initLogger,
  shutdownAuditLog,
  shutdownLogger,
} from "../../src/core/logger/mod.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { createMemorySecretStore } from "../../src/core/secrets/keychain/keychain.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { runRecoverableAgentTurn } from "../../src/gateway/agent_recovery.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createWorkflowRecoveryPolicy } from "../../src/gateway/workflow_recovery_policy.ts";
import { resolveGitHubToken } from "../../src/integrations/github/auth.ts";

const repo = "fixture-owner/fixture-repo";
const approvedOutput =
  '{"runs":[{"id":42,"status":"completed","conclusion":"success"}],"repositoryId":72451}';
const usage = { inputTokens: 1, outputTokens: 1 };

Deno.test("gateway resumes a saved credential-backed result and blocks revoked or uncertain work", async () => {
  const dir = await Deno.makeTempDir();
  const db = join(dir, "recovery.db");
  const session = createSession({
    userId: "owner" as UserId,
    channelId: "test" as ChannelId,
  });
  const secret = ["synthetic", crypto.randomUUID(), "fixture"].join("_");
  const keychain = createMemorySecretStore();
  await keychain.setSecret("github-pat", secret);
  const durableMessages = createMemoryStorage();
  const messageStore = createMessageStore(durableMessages);
  const credential = () => resolveGitHubToken({ secretStore: keychain });
  let reads = 0;
  let mutations = 0;
  let inspectedSavedResult = false;
  let workflowHookBlocked = false;
  const workflowPolicy = createWorkflowRecoveryPolicy({
    repositories: [repo],
    classification: () => "INTERNAL",
    authorizeRepository: async (requested) =>
      requested === repo && (await credential()).ok,
  });
  const policy: typeof workflowPolicy = {
    ...workflowPolicy,
    projectCall(call) {
      return call.name === "write_status" && call.args.field === "marker"
        ? { field: "marker" }
        : workflowPolicy.projectCall(call);
    },
    projectResult(call, text) {
      return call.name === "write_status"
        ? undefined
        : workflowPolicy.projectResult(call, text);
    },
  };
  const resumeId = crypto.randomUUID();
  const uncertainId = crypto.randomUUID();
  const request = (id: string) => `/recover ${id} Verify the workflow status.`;

  async function readExecution(id: string) {
    const key = await computeContentHash(JSON.stringify([session.id, id]));
    const store = new AgentRecoveryStore(db);
    try {
      return store.read(key);
    } finally {
      store.close();
    }
  }

  async function withGateway(
    mode: "read_interrupt" | "read_resume" | "mutate_interrupt",
    test: (socket: WebSocket, reached: Promise<void>) => Promise<void>,
  ) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const registry = createProviderRegistry();
    registry.register({
      name: "fixture",
      supportsStreaming: false,
      async complete(messages) {
        const containsResult = messages.some((message) =>
          typeof message.content === "string" &&
          message.content.includes(approvedOutput)
        );
        if (containsResult) {
          inspectedSavedResult = true;
          if (mode === "read_interrupt") {
            entered.resolve();
            await release.promise;
          }
          return { content: "Workflow status verified.", toolCalls: [], usage };
        }
        const isWrite = mode === "mutate_interrupt";
        return {
          content: "",
          toolCalls: [{
            id: "call-fixture",
            type: "function",
            function: {
              name: isWrite ? "write_status" : "github_actions",
              arguments: JSON.stringify(
                isWrite ? { field: "marker" } : { action: "list_runs", repo },
              ),
            },
          }],
          usage,
        };
      },
    });
    registry.setDefault("fixture");
    const engine = createPolicyEngine();
    if (workflowHookBlocked) {
      engine.addRule({
        id: "fixture-workflow-access-revoked",
        priority: 100,
        hook: "PRE_TOOL_CALL",
        conditions: [],
        action: "BLOCK",
      });
    }
    const chatSession = createChatSession({
      session,
      providerRegistry: registry,
      hookRunner: createHookRunner(engine),
      tools: [
        {
          name: "github_actions",
          description: "Fixture GitHub status read.",
          parameters: {},
        },
        {
          name: "write_status",
          description: "Fixture status update.",
          parameters: {},
        },
      ],
      async toolExecutor(name) {
        if (name === "write_status") {
          mutations++;
          entered.resolve();
          await release.promise;
          return "Changed";
        }
        const supplied = await credential();
        assert(supplied.ok);
        assertEquals(supplied.value, secret);
        reads++;
        return JSON.stringify({
          repositoryId: 72451,
          runs: [{
            id: 42,
            status: "completed",
            conclusion: "success",
            name: secret,
          }],
          authorization: secret,
        });
      },
      messageStore,
      enableStreaming: false,
      recoverAgentTurn: (id, orchestrator, options) =>
        runRecoverableAgentTurn(db, id, policy, orchestrator, options),
    });
    const token = crypto.randomUUID();
    const server = createGatewayServer({ port: 0, token, chatSession });
    const { port } = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const closed = Promise.withResolvers<void>();
    socket.addEventListener("close", () => closed.resolve(), { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      await test(socket, entered.promise);
    } finally {
      socket.close();
      await closed.promise;
      // An explicit cancel/close is handled before the held tool releases.
      release.resolve();
      await server.stop();
    }
  }

  function send(socket: WebSocket, content: string) {
    socket.send(JSON.stringify({ type: "message", content }));
  }

  async function turn(socket: WebSocket, content: string): Promise<string> {
    const result = Promise.withResolvers<string>();
    const timer = setTimeout(
      () => result.reject(new Error("No gateway turn result")),
      3000,
    );
    let text = "";
    function receive({ data }: MessageEvent) {
      const event = JSON.parse(data);
      if (event.type === "response") text = event.text;
      if (event.type === "error") text = event.message;
      if (event.type === "turn_end") result.resolve(text);
    }
    socket.addEventListener("message", receive);
    send(socket, content);
    try {
      return await result.promise;
    } finally {
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
    }
  }

  try {
    initLogger({
      level: "TRACE",
      console: false,
      fileWriter: await createFileWriter({ logDir: dir, baseName: "fixture" }),
    });
    await initAuditLog({ logDir: dir });
    await withGateway("read_interrupt", async (socket, reached) => {
      send(socket, request(resumeId));
      await reached;
      const state = await readExecution(resumeId);
      assertEquals(state?.status, "ready");
      assertEquals(state?.committedBatch, 1);
      assertStringIncludes(JSON.stringify(state), "success");
      assert(!JSON.stringify(state).includes(secret));
    });
    assertEquals(reads, 1);
    inspectedSavedResult = false;

    await keychain.deleteSecret("github-pat");
    await withGateway("read_resume", async (socket) => {
      assertStringIncludes(
        await turn(socket, request(resumeId)),
        "no longer authorized",
      );
    });
    assertEquals(reads, 1);
    assertEquals(inspectedSavedResult, false);

    await keychain.setSecret("github-pat", secret);
    workflowHookBlocked = true;
    await withGateway("read_resume", async (socket) => {
      assertStringIncludes(
        await turn(socket, request(resumeId)),
        "blocked by the current policy",
      );
    });
    assertEquals(inspectedSavedResult, false);
    workflowHookBlocked = false;

    await withGateway("read_resume", async (socket) => {
      assertEquals(
        await turn(socket, request(resumeId)),
        "Workflow status verified.",
      );
      assertStringIncludes(
        await turn(socket, request(resumeId)),
        "already finished",
      );
    });
    assertEquals(inspectedSavedResult, true);
    assertEquals(reads, 1);

    await withGateway("mutate_interrupt", async (socket, reached) => {
      send(socket, request(uncertainId));
      await reached;
      assertEquals((await readExecution(uncertainId))?.status, "pending");
    });
    await withGateway("mutate_interrupt", async (socket) => {
      assertStringIncludes(
        await turn(socket, request(uncertainId)),
        "uncertain outcome",
      );
    });
    assertEquals(mutations, 1);
    assert(
      !JSON.stringify(await messageStore.loadSession(session.id)).includes(
        secret,
      ),
    );
    await shutdownLogger();
    await shutdownAuditLog();
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) {
        assert(
          !(await Deno.readTextFile(join(dir, entry.name))).includes(secret),
        );
      }
    }
  } finally {
    await shutdownLogger();
    await shutdownAuditLog();
    await durableMessages.close();
    await Deno.remove(dir, { recursive: true });
  }
});
