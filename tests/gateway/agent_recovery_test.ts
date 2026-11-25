import type { AgentRecoveryPolicy } from "../../src/core/agent_recovery.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
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
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createWorkflowRecoveryPolicy } from "../../src/gateway/workflow_recovery_policy.ts";
import { resolveGitHubToken } from "../../src/integrations/github/auth.ts";

const repo = "fixture-owner/fixture-repo";
const approvedOutput =
  '{"runs":[{"id":42,"status":"completed","conclusion":"success"}],"repositoryId":72451}';
const usage = { inputTokens: 1, outputTokens: 1 };

Deno.test("gateway resumes a saved credential-backed result and blocks revoked or uncertain work", async () => {
  const dir = await Deno.makeTempDir();
  const db = join(dir, "agent-recovery.db");
  let approvals = 0;
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
  let sourceChecks = 0;
  let mutations = 0;
  let inspectedSavedResult = false;
  let workflowHookBlocked: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
  const workflowPolicy = createWorkflowRecoveryPolicy({
    repositories: [repo],
    classification: () => "INTERNAL",
    async authorizeRepository(requested) {
      sourceChecks++;
      return requested === repo && (await credential()).ok;
    },
  });
  const reconciledId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const outcomePath = join(dir, "external-operation-receipt.json");
  let reconciliationAllowed = false;
  let verifiedMutation = false;
  const committedMarker = JSON.stringify({ status: "committed" });
  const policy: AgentRecoveryPolicy = {
    ...workflowPolicy,
    projectCall(call) {
      return call.name === "write_status" && call.args.field === "marker"
        ? {
          field: "marker",
          ...(call.args.operationId === operationId && { operationId }),
        }
        : workflowPolicy.projectCall(call);
    },
    projectResult(call, text) {
      return call.name === "write_status"
        ? call.args.operationId === operationId && text === committedMarker
          ? text
          : undefined
        : workflowPolicy.projectResult(call, text);
    },
    canReconcile: (call) =>
      call.name === "write_status" && call.args.operationId === operationId,
    async reconcile(operation) {
      if (!reconciliationAllowed || !(await credential()).ok) return;
      const saved = JSON.parse(await Deno.readTextFile(outcomePath));
      if (
        saved.executionId === operation.executionId &&
        saved.operationId === operation.args.operationId &&
        operation.batch === 1
      ) return saved.outcome;
    },
    async authorize(receipt) {
      return receipt.name === "write_status"
        ? reconciliationAllowed && receipt.args.operationId === operationId &&
          (await credential()).ok
        : await workflowPolicy.authorize(receipt);
    },
  };
  const resumeId = crypto.randomUUID();
  const uncertainId = crypto.randomUUID();
  const request = (id: string, paused = false) =>
    `/recover ${
      paused ? "--resume-paused " : ""
    }${id} Verify the workflow status.`;
  const archiveRequest = (args: Record<string, unknown>) =>
    `archive-fixture ${JSON.stringify(args)}`;

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
    mode:
      | "read_interrupt"
      | "read_before_commit"
      | "read_resume"
      | "mutate_interrupt"
      | "reconcile_interrupt",
    test: (socket: WebSocket, reached: Promise<void>) => Promise<void>,
    chatSessionState = session,
  ) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const registry = createProviderRegistry();
    registry.register({
      name: "fixture",
      supportsStreaming: false,
      async complete(messages) {
        const input = messages.findLast(({ role }) => role === "user")?.content;
        if (typeof input === "string" && input.startsWith("archive-fixture ")) {
          const last = messages.at(-1);
          return last?.role === "tool"
            ? { content: String(last.content), toolCalls: [], usage }
            : {
              content: "",
              toolCalls: [{
                id: "archive-fixture-call",
                type: "function",
                function: {
                  name: "operator_runs",
                  arguments: input.slice("archive-fixture ".length),
                },
              }],
              usage,
            };
        }
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
        if (
          messages.some(({ role, content }) =>
            role === "tool" && content === committedMarker
          )
        ) {
          verifiedMutation = true;
          return {
            content: "Recovered the committed mutation.",
            toolCalls: [],
            usage,
          };
        }
        const isWrite = mode === "mutate_interrupt" ||
          mode === "reconcile_interrupt";
        return {
          content: "",
          toolCalls: [{
            id: "call-fixture",
            type: "function",
            function: {
              name: isWrite ? "write_status" : "github_actions",
              arguments: JSON.stringify(
                isWrite
                  ? {
                    field: "marker",
                    ...(mode === "reconcile_interrupt" && { operationId }),
                  }
                  : { action: "list_runs", repo },
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
        hook: workflowHookBlocked,
        conditions: [],
        action: "BLOCK",
      });
    }
    const rootHooks = createHookRunner(engine);
    const chatSession = createChatSession({
      session: chatSessionState,
      providerRegistry: registry,
      hookRunner: {
        ...rootHooks,
        async evaluateHook(hook, context) {
          if (
            mode === "reconcile_interrupt" &&
            workflowHookBlocked === "PRE_TOOL_CALL" &&
            hook === "PRE_TOOL_CALL"
          ) {
            entered.resolve();
            await release.promise;
          }
          return await rootHooks.evaluateHook(hook, context);
        },
      },
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
      async toolExecutor(name, args) {
        if (name === "write_status") {
          mutations++;
          if (mode === "reconcile_interrupt") {
            assertEquals(args.operationId, operationId);
            await Deno.writeTextFile(
              outcomePath,
              JSON.stringify({
                executionId: reconciledId,
                operationId,
                outcome: committedMarker,
              }),
              { createNew: true },
            );
          }
          entered.resolve();
          await release.promise;
          return "Changed";
        }
        const supplied = await credential();
        assert(supplied.ok);
        assertEquals(supplied.value, secret);
        reads++;
        if (mode === "read_before_commit") {
          entered.resolve();
          await release.promise;
        }
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
      recoverAgentTurn: (id, orchestrator, options, control) =>
        runRecoverableAgentTurn(db, id, policy, orchestrator, options, control),
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir: dir,
        confirm: () => {
          approvals++;
          return Promise.resolve(true);
        },
      }),
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
    assertEquals(sourceChecks, 1);
    workflowHookBlocked = "PRE_TOOL_CALL";
    await withGateway("read_resume", async (socket) => {
      assertStringIncludes(
        await turn(socket, request(resumeId)),
        "blocked by the current policy",
      );
    });
    assertEquals(inspectedSavedResult, false);
    assertEquals(sourceChecks, 1);
    workflowHookBlocked = "POST_TOOL_RESPONSE";
    await withGateway("read_resume", async (socket) => {
      assertStringIncludes(
        await turn(socket, request(resumeId)),
        "saved tool result is blocked by the current policy",
      );
    });
    assertEquals(inspectedSavedResult, false);
    assertEquals(sourceChecks, 1);
    workflowHookBlocked = undefined;

    const saved = await readExecution(resumeId);
    assert(saved?.status === "ready" && saved.checkpoint);
    const sql = new DatabaseSync(db);
    try {
      const update = sql.prepare(
        "UPDATE recoveries SET checkpoint = ? WHERE key = ?",
      );
      const original = JSON.stringify(saved.checkpoint);
      for (
        const checkpoint of [
          original.replace("success", "failure"),
          original.replace(repo, "other/repo"),
          original.replace(
            '"tool_call_id":"recovery_1_0"',
            '"tool_call_id":"other"',
          ),
        ]
      ) {
        assert(checkpoint !== original);
        update.run(checkpoint, saved.key);
        await withGateway("read_resume", async (socket) => {
          assertStringIncludes(
            await turn(socket, request(resumeId)),
            "saved tool result is blocked by the current policy",
          );
        });
        assertEquals(inspectedSavedResult, false);
        assertEquals(reads, 1);
        assertEquals(sourceChecks, 1);
      }
      update.run(original, saved.key);
    } finally {
      sql.close();
    }

    const archiveId = crypto.randomUUID();
    const archive = archiveRequest({
      action: "archive",
      kind: "owner_chat",
      id: resumeId,
      requestId: archiveId,
    });
    const restore = archiveRequest({
      action: "restore",
      kind: "owner_chat",
      id: resumeId,
      archiveId,
      requestId: crypto.randomUUID(),
    });
    await withGateway("read_resume", async (socket) => {
      assertEquals(
        JSON.parse(await turn(socket, archive)).receipt.status,
        "succeeded",
      );
      const count = approvals;
      assertEquals(
        JSON.parse(await turn(socket, archive)).receipt.status,
        "succeeded",
      );
      assertEquals(approvals, count);
    });
    const checkpointArtifact = join(
      dir,
      "data",
      "run-archives",
      archiveId,
      "owner-checkpoint.json",
    );
    const artifact = await Deno.readTextFile(checkpointArtifact);
    assert(!artifact.includes(secret));
    assert(!artifact.includes("Verify the workflow status."));
    await Deno.rename(db, join(dir, "prior-recovery.db"));
    await Deno.writeTextFile(checkpointArtifact, "{}");
    await withGateway("read_resume", async (socket) => {
      const corrupt = archiveRequest({
        action: "restore",
        kind: "owner_chat",
        id: resumeId,
        archiveId,
        requestId: crypto.randomUUID(),
      });
      assertEquals(
        JSON.parse(await turn(socket, corrupt)).receipt.status,
        "failed",
      );
      assertEquals(await readExecution(resumeId), undefined);
    });
    await Deno.writeTextFile(checkpointArtifact, artifact);
    const beforeForeign = approvals;
    await withGateway("read_resume", async (socket) => {
      assertStringIncludes(await turn(socket, restore), "unavailable");
    }, createSession({ userId: session.userId, channelId: session.channelId }));
    assertEquals(approvals, beforeForeign);
    await withGateway("read_resume", async (socket) => {
      assertEquals(
        JSON.parse(await turn(socket, restore)).receipt.status,
        "succeeded",
      );
      assertEquals((await readExecution(resumeId))?.status, "paused");
      assertStringIncludes(await turn(socket, request(resumeId)), "paused");
    });
    await keychain.deleteSecret("github-pat");
    await withGateway("read_resume", async (socket) => {
      assertStringIncludes(
        await turn(socket, request(resumeId, true)),
        "no longer authorized",
      );
      assertEquals((await readExecution(resumeId))?.status, "paused");
    });
    await keychain.setSecret("github-pat", secret);
    assertEquals(sourceChecks, 2);

    await withGateway("read_resume", async (socket) => {
      assertEquals(
        await turn(socket, request(resumeId, true)),
        "Workflow status verified.",
      );
      assertStringIncludes(
        await turn(socket, request(resumeId)),
        "already finished",
      );
    });
    assertEquals(inspectedSavedResult, true);
    assertEquals(reads, 1);
    assertEquals(sourceChecks, 3);

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
    const blockedMutation = crypto.randomUUID();
    workflowHookBlocked = "PRE_TOOL_CALL";
    await withGateway("reconcile_interrupt", async (socket, reached) => {
      send(socket, request(blockedMutation));
      await reached;
      const admission = await readExecution(blockedMutation);
      assert(admission?.status === "pending");
      const journal = new AgentRecoveryStore(db);
      try {
        assertEquals(
          journal.pendingCall(admission.key, admission.pendingBatch),
          undefined,
        );
      } finally {
        journal.close();
      }
      assertEquals(mutations, 1);
    });
    workflowHookBlocked = undefined;
    await withGateway("reconcile_interrupt", async (socket, reached) => {
      send(socket, request(reconciledId));
      await reached;
      const admission = await readExecution(reconciledId);
      assert(admission?.status === "pending");
      const journal = new AgentRecoveryStore(db);
      try {
        assertEquals(
          journal.pendingCall(admission.key, admission.pendingBatch),
          {
            name: "write_status",
            classification: "INTERNAL",
            args: { field: "marker", operationId },
          },
        );
      } finally {
        journal.close();
      }
    });
    await withGateway("read_resume", async (socket) => {
      assertStringIncludes(
        await turn(socket, request(reconciledId)),
        "uncertain outcome",
      );
    });
    reconciliationAllowed = true;
    workflowHookBlocked = "POST_TOOL_RESPONSE";
    await withGateway("read_resume", async (socket) => {
      assertStringIncludes(
        await turn(socket, request(reconciledId)),
        "blocked by the current policy",
      );
      assert(!verifiedMutation);
    });
    workflowHookBlocked = undefined;
    await withGateway("read_resume", async (socket) => {
      assertEquals(
        await turn(socket, request(reconciledId)),
        "Recovered the committed mutation.",
      );
      assertStringIncludes(
        await turn(socket, request(reconciledId)),
        "already finished",
      );
    });
    assert(verifiedMutation);
    assertEquals(mutations, 2);

    const interruptedRead = crypto.randomUUID();
    await withGateway("read_before_commit", async (socket, reached) => {
      send(socket, request(interruptedRead));
      await reached;
      assertEquals((await readExecution(interruptedRead))?.status, "pending");
    });
    await withGateway("read_resume", async (socket) => {
      assertEquals(
        await turn(socket, request(interruptedRead)),
        "Workflow status verified.",
      );
    });
    assertEquals(reads, 3);
    assertEquals((await readExecution(interruptedRead))?.status, "finished");

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
