import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
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
  writeAuditEvent,
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
  let allowOperatorApproval = true;
  let approvalRuleId: string | undefined;
  const inbox = createToolApprovalService(join(dir, "approval-fixture.db"));
  const session = createSession({
    userId: "owner" as UserId,
    channelId: "test" as ChannelId,
  });
  const secret = ["synthetic", crypto.randomUUID(), "fixture"].join("_");
  const auditWrites: Promise<void>[] = [];
  const keychain = createMemorySecretStore();
  await keychain.setSecret("github-pat", secret);
  const durableMessages = createMemoryStorage();
  const messageStore = createMessageStore(durableMessages);
  const credential = () => resolveGitHubToken({ secretStore: keychain });
  let reads = 0;
  let exactReads = 0;
  let exactModelUses = 0;
  const exactRun = {
    id: 42,
    repositoryId: 72451,
    attempt: 2,
    status: "completed",
    conclusion: "cancelled",
  };
  const exactProjection = JSON.stringify(exactRun);
  let sourceChecks = 0;
  let mutations = 0;
  let inspectedSavedResult = false;
  let workflowHookBlocked: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
  let blockSavedRead: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
  const workflowPolicy = createWorkflowRecoveryPolicy({
    repositories: [repo],
    runStatus: true,
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
  let rejectExactAuthorization = false;
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
    async authorizeDispatch() {
      if (!rejectExactAuthorization) return true;
      const current = await credential();
      assert(current.ok);
      throw new Error(
        `The connector authorization failed with ${current.value}`,
      );
    },
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

  const inspectRecovery = (id: string) =>
    archiveRequest({
      action: "inspect",
      kind: "owner_chat",
      id,
    });
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
      | "credential_exception"
      | "context_exception"
      | "read_before_commit"
      | "read_resume"
      | "exact_interrupt"
      | "exact_resume"
      | "mutate_interrupt"
      | "reconcile_interrupt",
    test: (socket: WebSocket, reached: Promise<void>) => Promise<void>,
    chatSessionState = session,
  ) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const registry = createProviderRegistry();
    let contextFault = mode === "context_exception";
    registry.register({
      name: "fixture",
      supportsStreaming: false,
      async complete(messages) {
        const input = messages.findLast(({ role }) => role === "user")?.content;
        if (input === "Verify ordinary session isolation.") {
          assert(
            !JSON.stringify(messages).includes(secret),
            "Ordinary chat inherited protected recovery context.",
          );
          return {
            content: "Ordinary context is isolated.",
            toolCalls: [],
            usage,
          };
        }
        if (typeof input === "string" && input.startsWith("archive-fixture ")) {
          const last = messages.at(-1);
          return last?.role === "tool"
            ? {
              content: `Operator result:\n${String(last.content)}`,
              toolCalls: [],
              usage,
            }
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
        if (
          messages.some(({ role, content }) =>
            role === "tool" && content === exactProjection
          )
        ) {
          exactModelUses++;
          if (mode === "exact_interrupt") {
            entered.resolve();
            await release.promise;
          }
          return {
            content: "Exact run state recovered.",
            toolCalls: [],
            usage,
          };
        }
        const containsResult = messages.some((message) =>
          typeof message.content === "string" &&
          message.content.includes(approvedOutput)
        );
        if (containsResult) {
          inspectedSavedResult = true;
          if (mode === "credential_exception") {
            const current = await credential();
            assert(current.ok);
            throw new Error(
              `The source formatter failed with ${current.value}`,
            );
          }
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
                  : mode.startsWith("exact_")
                  ? { action: "get_run", repo, run_id: 42, attempt: 2 }
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
    if (blockSavedRead) {
      engine.addRule({
        id: "fixture-exact-source-policy",
        priority: 100,
        hook: blockSavedRead,
        conditions: [{
          field: "tool_name",
          operator: "equals",
          value: "github_actions",
        }],
        action: "BLOCK",
      });
    }
    if (approvalRuleId) {
      engine.addRule({
        id: approvalRuleId,
        priority: 50,
        hook: "PRE_TOOL_CALL",
        conditions: [{
          field: "tool_name",
          operator: "equals",
          value: "write_status",
        }],
        action: "REQUIRE_APPROVAL",
      });
    }
    const rootHooks = createHookRunner(engine, {
      logger: {
        log(entry) {
          auditWrites.push(writeAuditEvent({
            timestamp: entry.timestamp,
            type: entry.result.allowed ? "raw_content" : "policy_block",
            source: entry.hook,
            rawContent: JSON.stringify(entry),
          }));
        },
      },
    });
    const chatSession = createChatSession({
      session: chatSessionState,
      providerRegistry: registry,
      async getExtraSystemPromptSections() {
        if (contextFault) {
          contextFault = false;
          const current = await credential();
          assert(current.ok);
          throw new Error(
            `A connector context builder failed with ${current.value}`,
          );
        }
        return [];
      },
      hookRunner: {
        ...rootHooks,
        toolApprovalInbox: inbox,
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
        if (args.action === "get_run") {
          exactReads++;
          return JSON.stringify({
            ...exactRun,
            authorization: secret,
            _classification: "INTERNAL",
          });
        }
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
      ownerRecoveryTracePath: join(dir, "execution-traces.db"),
      recoverAgentTurn: (id, orchestrator, options, control) =>
        runRecoverableAgentTurn(db, id, policy, orchestrator, options, control),
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir: dir,
        authorizeExecutionTracePayload: async (payload) =>
          payload.repo === repo && payload.repositoryId === 72451 &&
          (await credential()).ok,
        confirm: () => {
          approvals++;
          return Promise.resolve(allowOperatorApproval);
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
      if (String(data).includes(secret)) {
        result.reject(
          new Error("A gateway frame contained the fixture credential."),
        );
        return;
      }
      const event = JSON.parse(data);
      if (event.type === "response") {
        text = event.text.replace(/^Operator result:\n/, "");
      }
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
    await withGateway("read_resume", async (socket) => {
      const blocked = JSON.parse(
        await turn(socket, inspectRecovery(blockedMutation)),
      );
      assertEquals(blocked.run, {
        kind: "owner_chat",
        id: blockedMutation,
        committedBatch: 0,
        status: "pending",
        pendingBatch: 1,
        pauseRequested: false,
        nextAction: "authorize_dispatch",
      });
      const legacy = JSON.parse(
        await turn(socket, inspectRecovery(uncertainId)),
      );
      assertEquals(legacy.run.nextAction, "reconcile_unknown");
    });
    approvalRuleId = "fixture-mutation-approval";
    await withGateway("reconcile_interrupt", async (socket, reached) => {
      send(socket, request(reconciledId));
      let approval;
      for (let attempt = 0; attempt < 100 && !approval; attempt++) {
        approval = inbox.list().records.find(({ status }) =>
          status === "pending"
        );
        if (!approval) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert(approval);
      assertEquals(mutations, 1);
      socket.send(JSON.stringify({
        type: "approval_inbox_decide",
        requestId: crypto.randomUUID(),
        approvalId: approval.id,
        approved: true,
      }));

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
            approvedRuleId: approvalRuleId,
            args: { field: "marker", operationId },
          },
        );
      } finally {
        journal.close();
      }
    });
    await withGateway("read_resume", async (socket) => {
      const text = await turn(socket, inspectRecovery(reconciledId));
      assertEquals(JSON.parse(text).run.nextAction, "verify_outcome");
      assert(!text.includes(operationId));
      assert(!text.includes("fixture-mutation-approval"));
    });
    await withGateway("read_resume", async (socket) => {
      assertStringIncludes(
        await turn(socket, inspectRecovery(reconciledId)),
        "unavailable",
      );
    }, createSession({ userId: session.userId, channelId: session.channelId }));
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
    approvalRuleId = "fixture-new-mutation-approval";
    await withGateway("read_resume", async (socket) => {
      assertStringIncludes(
        await turn(socket, request(reconciledId)),
        "blocked by the current policy",
      );
      assert(!verifiedMutation);
    });
    approvalRuleId = "fixture-mutation-approval";

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
    const exactReadId = crypto.randomUUID();
    await withGateway("exact_interrupt", async (socket, reached) => {
      send(socket, request(exactReadId));
      await reached;
      const saved = await readExecution(exactReadId);
      assert(saved?.status === "ready" && saved.checkpoint);
      assertEquals(saved.tools[0].args, {
        action: "get_run",
        repo,
        run_id: 42,
        attempt: 2,
      });
      assert(!JSON.stringify(saved).includes(secret));
    });
    await keychain.deleteSecret("github-pat");
    await withGateway("exact_resume", async (socket) => {
      assertStringIncludes(
        await turn(socket, request(exactReadId)),
        "no longer authorized",
      );
    });
    assertEquals(exactReads, 1);
    assertEquals(exactModelUses, 1);
    await keychain.setSecret("github-pat", secret);
    const pause = archiveRequest({
      action: "pause",
      kind: "owner_chat",
      id: exactReadId,
    });
    const beforeForeignPause = approvals;
    await withGateway("exact_resume", async (socket) => {
      assertStringIncludes(await turn(socket, pause), "unavailable");
    }, createSession({ userId: session.userId, channelId: session.channelId }));
    assertEquals(approvals, beforeForeignPause);
    workflowHookBlocked = "PRE_TOOL_CALL";
    await withGateway("exact_resume", async (socket) => {
      assertStringIncludes(await turn(socket, pause), "blocked by policy");
      assertEquals((await readExecution(exactReadId))?.status, "ready");
    });
    workflowHookBlocked = undefined;
    assertEquals(approvals, beforeForeignPause);
    await withGateway("exact_resume", async (socket) => {
      allowOperatorApproval = false;
      assertStringIncludes(await turn(socket, pause), "declined");
      assertEquals((await readExecution(exactReadId))?.status, "ready");
    });
    allowOperatorApproval = true;
    await withGateway("exact_resume", async (socket) => {
      const result = JSON.parse(await turn(socket, pause));
      assertEquals(result.run, {
        kind: "owner_chat",
        id: exactReadId,
        committedBatch: 1,
        status: "paused",
      });
      const count = approvals;
      assertEquals(JSON.parse(await turn(socket, pause)), result);
      assertEquals(approvals, count);
    });
    await withGateway("exact_resume", async (socket) => {
      const inspected = JSON.parse(
        await turn(socket, inspectRecovery(exactReadId)),
      );
      assertEquals(inspected.run.status, "paused");
      assertStringIncludes(await turn(socket, request(exactReadId)), "paused");
      assertEquals(
        await turn(socket, request(exactReadId, true)),
        "Exact run state recovered.",
      );
      assertStringIncludes(await turn(socket, pause), "unavailable");
    });
    assertEquals(exactReads, 1);
    assertEquals(exactModelUses, 2);
    const trace = archiveRequest({
      action: "execution_trace_payload",
      traceRole: "owner_chat",
      id: exactReadId,
      ordinal: 1,
    });
    const traceList = archiveRequest({
      action: "execution_traces",
      traceRole: "owner_chat",
      id: exactReadId,
    });
    const traceSearch = archiveRequest({
      action: "execution_traces",
      traceRole: "owner_chat",
      id: exactReadId,
      query: "github_actions",
    });
    const payloadSearch = archiveRequest({
      action: "execution_trace_payload",
      traceRole: "owner_chat",
      id: exactReadId,
      query: repo,
    });
    const discoverOwnerRuns = (cursor?: string) =>
      archiveRequest({
        action: "execution_traces",
        traceRole: "owner_chat",
        limit: 1,
        ...(cursor && { cursor }),
      });
    let ownerRunCursor: string;
    await withGateway("exact_resume", async (socket) => {
      const reopened = JSON.parse(await turn(socket, trace));
      assertEquals(reopened.run.scope.runId, exactReadId);
      assertEquals(reopened.step.scope.sessionId, session.id);
      assertEquals(reopened.step.ordinal, 1);
      assertEquals(reopened.payload, {
        kind: "github_actions_run_status",
        repo,
        ...exactRun,
      });
      const retained = JSON.parse(await turn(socket, traceList));
      assertEquals(retained.page.steps.map(({ id }: { id: string }) => id), [
        reopened.step.id,
      ]);
      const discovered = JSON.parse(await turn(socket, discoverOwnerRuns()));
      assertEquals(discovered.page.runs[0].scope.runId, exactReadId);
      assertEquals(discovered.page.runs[0].scope.sessionId, session.id);
      ownerRunCursor = discovered.page.nextCursor;
      assert(typeof ownerRunCursor === "string");
      const earlier = JSON.parse(
        await turn(socket, discoverOwnerRuns(ownerRunCursor)),
      );
      assertEquals(earlier.page.runs.length, 1);
      assert(earlier.page.runs[0].scope.runId !== exactReadId);
      for (const search of [traceSearch, payloadSearch]) {
        const found = JSON.parse(await turn(socket, search));
        assertEquals(
          found.page.matches.map((
            { runId, id }: { runId: string; id: string },
          ) => [runId, id]),
          [[exactReadId, reopened.step.id]],
        );
      }
      const all = JSON.parse(
        await turn(socket, archiveRequest({ action: "execution_traces" })),
      );
      assertEquals(all.page.runs, []);
      await keychain.deleteSecret("github-pat");
      assertStringIncludes(await turn(socket, trace), "unavailable");
      assertEquals(
        JSON.parse(await turn(socket, payloadSearch)).page.matches,
        [],
      );
      assertEquals(
        JSON.parse(await turn(socket, traceSearch)).page.matches.length,
        1,
      );
      await keychain.setSecret("github-pat", secret);
    });
    await withGateway("exact_resume", async (socket) => {
      assertStringIncludes(await turn(socket, trace), "unavailable");
      assertStringIncludes(await turn(socket, traceList), "unavailable");
      assertStringIncludes(await turn(socket, traceSearch), "unavailable");
      assertStringIncludes(await turn(socket, payloadSearch), "unavailable");
      assertEquals(
        JSON.parse(await turn(socket, discoverOwnerRuns())).page.runs,
        [],
      );
      assertStringIncludes(
        await turn(socket, discoverOwnerRuns(ownerRunCursor)),
        "unavailable",
      );
    }, createSession({ userId: session.userId, channelId: session.channelId }));
    assertEquals(exactReads, 1);

    const formattedError = crypto.randomUUID();
    const readsBeforeError = reads;
    const protectedRequest =
      `/recover ${formattedError} Verify the status using ${secret}.`;
    await withGateway("credential_exception", async (socket) => {
      const error = await turn(socket, protectedRequest);
      assert(
        !error.includes(secret),
        "A recoverable exception exposed the credential in a gateway frame.",
      );
      assertStringIncludes(error, "protected model call failed");
      const checkpoint = await readExecution(formattedError);
      assertEquals(checkpoint?.status, "ready");
      assertEquals(checkpoint?.committedBatch, 1);
      assert(!JSON.stringify(checkpoint).includes(secret));
    });
    await withGateway("context_exception", async (socket) => {
      const error = await turn(socket, protectedRequest);
      assert(
        !error.includes(secret),
        "A recoverable context exception exposed the credential in a gateway frame.",
      );
      assertStringIncludes(error, "protected agent context");
      assertEquals((await readExecution(formattedError))?.status, "ready");
      assertEquals(
        await turn(socket, "Verify ordinary session isolation."),
        "Ordinary context is isolated.",
      );
    });
    await withGateway("read_resume", async (socket) => {
      assertEquals(
        await turn(socket, protectedRequest),
        "Workflow status verified.",
      );
    });
    assertEquals(reads, readsBeforeError + 1);

    const deniedAuthorization = crypto.randomUUID();
    const priorMutations = mutations;
    approvalRuleId = undefined;
    rejectExactAuthorization = true;
    await withGateway("reconcile_interrupt", async (socket) => {
      const error = await turn(socket, request(deniedAuthorization));
      assert(
        !error.includes(secret),
        "A recovery authorization exception exposed the credential in a gateway frame.",
      );
      assertStringIncludes(error, "protected tool batch failed");
      assertEquals(mutations, priorMutations);
    });
    rejectExactAuthorization = false;

    assert(
      !JSON.stringify(await messageStore.loadSession(session.id)).includes(
        secret,
      ),
    );
    await Promise.all(auditWrites);
    await shutdownLogger();
    await shutdownAuditLog();
    const audit = await Deno.readTextFile(join(dir, "audit.log"));
    assertStringIncludes(audit, "PRE_CONTEXT_INJECTION");
    assertStringIncludes(audit, "PRE_TOOL_CALL");
    assertStringIncludes(audit, "POST_TOOL_RESPONSE");
    assertStringIncludes(audit, "PRE_OUTPUT");
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
