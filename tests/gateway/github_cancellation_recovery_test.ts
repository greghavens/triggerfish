import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createHookRunner,
  createToolApprovalRules,
} from "../../src/core/policy/hooks/hooks.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildWorkflowRecoveryExecutor } from "../../src/gateway/startup/factory/agent_recovery.ts";
import { createGitHubClient } from "../../src/integrations/github/client.ts";
import { createGitHubToolExecutor } from "../../src/integrations/github/tools.ts";
import { loadGitHubToolDefinitions } from "../../src/integrations/github/tools_defs.ts";

Deno.test("An approved GitHub cancellation recovers by confirming the exact outcome without repeating POST", async () => {
  const baseDir = await Deno.makeTempDir();
  try {
    const secretStore = createMemorySecretStore();
    await secretStore.setSecret("github-pat", "synthetic-recovery-token");
    const inbox = createToolApprovalService(join(baseDir, "approvals.db"));
    const session = createSession({
      userId: "owner" as UserId,
      channelId: "test" as ChannelId,
      bumpersEnabled: false,
    });
    const target = {
      repo: "owner/repo",
      repository_id: 17,
      run_id: 42,
      attempt: 2,
    };
    let postRequests = 0;
    let resultSeen: unknown;
    let cancelled = false;
    let currentAttempt = 2;
    let allowMetadata = true;
    let metadataTimedOut = false;
    let repositoryVisibility = "public";
    let blockAfterMetadata = false;
    let denyDispatch = false;
    let denyCancelledResponse = false;
    let statusPolls = 0;
    let connection: WebSocket | undefined;
    let mixedBatch = false;
    const fetchFn: typeof fetch = (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/repos/owner/repo/actions/runs/42/cancel") {
        assertEquals(init?.method, "POST");
        postRequests++;
        cancelled = true;
        return Promise.reject(new Error("Transport interrupted after commit"));
      }
      assertEquals(init?.method ?? "GET", "GET");
      if (!allowMetadata) {
        return Promise.resolve(new Response("", { status: 403 }));
      }
      if (path === "/repos/owner/repo") {
        return Promise.resolve(
          Response.json({
            id: 17,
            full_name: "owner/repo",
            visibility: repositoryVisibility,
          }),
        );
      }
      assertEquals(path, "/repos/owner/repo/actions/runs/42");
      statusPolls++;
      if (metadataTimedOut) {
        return Promise.reject(new DOMException("Timed out", "TimeoutError"));
      }
      if (blockAfterMetadata) denyDispatch = true;

      return Promise.resolve(Response.json({
        id: 42,
        repository: { id: 17 },
        run_attempt: currentAttempt,
        status: cancelled ? "completed" : "in_progress",
        conclusion: cancelled ? "cancelled" : null,
      }));
    };
    const recover = buildWorkflowRecoveryExecutor(
      {
        agent_recovery: {
          github_repositories: [target.repo],
          github_cancel_runs: [target],
        },
      },
      baseDir,
      secretStore,
      () => "INTERNAL",
      undefined,
      true,
      { githubFetch: fetchFn },
    );
    assert(recover);
    const executionId = crypto.randomUUID();
    const command = `/recover ${executionId} Stop the approved run.`;
    const turn = async (message = command) => {
      const registry = createProviderRegistry();
      registry.register({
        name: "cancel-fixture",
        supportsStreaming: false,
        complete(messages) {
          const last = messages.at(-1);
          const done = last?.role === "tool";
          if (
            done && typeof last.content === "string" &&
            last.content.startsWith("{")
          ) {
            resultSeen = JSON.parse(last.content);
          }
          return Promise.resolve({
            content: done ? "Run outcome checked." : "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: done ? [] : [
              {
                type: "function",
                id: "cancel-fixture",
                function: {
                  name: "github_actions",
                  arguments: JSON.stringify({
                    action: "cancel_run",
                    repo: target.repo,
                    run_id: target.run_id,
                  }),
                },
              },
              ...(mixedBatch
                ? [{
                  type: "function" as const,
                  id: "mixed-read",
                  function: {
                    name: "github_actions",
                    arguments: JSON.stringify({
                      action: "list_runs",
                      repo: target.repo,
                    }),
                  },
                }]
                : []),
            ],
          });
        },
      });
      registry.setDefault("cancel-fixture");
      const engine = createPolicyEngine();
      for (const rule of createToolApprovalRules(["github_actions"])) {
        engine.addRule(rule);
      }
      const tools = createGitHubToolExecutor({
        client: createGitHubClient({
          token: "synthetic-recovery-token",
          fetchFn,
        }),
        sessionTaint: session.taint,
        sourceSessionId: session.id,
      });
      const hooks = createHookRunner(engine);
      const chat = createChatSession({
        session,
        providerRegistry: registry,
        recoverAgentTurn: recover,
        enableStreaming: false,
        tools: loadGitHubToolDefinitions(),
        toolExecutor: async (name, args) =>
          await tools(name, args) ?? "Error: unknown tool",
        hookRunner: {
          ...hooks,
          toolApprovalInbox: inbox,
          evaluateHook(hook, context) {
            if (
              (denyDispatch && hook === "PRE_TOOL_CALL") ||
              (denyCancelledResponse && hook === "POST_TOOL_RESPONSE" &&
                String(context.input.tool_response).includes(
                  '"outcome":"cancelled"',
                ))
            ) {
              return Promise.resolve({
                allowed: false,
                action: "BLOCK",
                ruleId: "fixture-policy-change",
                duration: 0,
              });
            }
            return hooks.evaluateHook(hook, context);
          },
        },
      });
      const token = crypto.randomUUID();
      const gateway = createGatewayServer({
        port: 0,
        token,
        chatSession: chat,
      });
      const { port } = await gateway.start();
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/chat?token=${token}`,
      );
      connection = socket;
      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        const done = Promise.withResolvers<ChatEvent | undefined>();
        let outcome: ChatEvent | undefined;
        socket.addEventListener("message", ({ data }) => {
          const event = JSON.parse(data);
          if (event.type === "error" || event.type === "response") {
            outcome = event;
          }
          if (event.type === "turn_end") done.resolve(outcome);
        });
        socket.send(JSON.stringify({ type: "message", content: message }));
        return await done.promise;
      } finally {
        socket.close();
        await gateway.stop();
      }
    };
    const decidePending = async (expectedPosts: number, approved = true) => {
      let pending;
      for (let i = 0; i < 100 && !pending; i++) {
        pending = inbox.list().records.find(({ status }) =>
          status === "pending"
        );
        if (!pending) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert(pending);
      assertEquals(postRequests, expectedPosts);
      const socket = connection;
      assert(socket);
      const requestId = crypto.randomUUID();
      const decision = Promise.withResolvers<boolean>();
      const onReply = ({ data }: MessageEvent) => {
        const msg = JSON.parse(data);
        if (
          msg.type === "approval_inbox_result" && msg.requestId === requestId
        ) {
          decision.resolve(msg.ok);
        }
      };
      socket.addEventListener("message", onReply);
      try {
        socket.send(JSON.stringify({
          type: "approval_inbox_decide",
          requestId,
          approvalId: pending.id,
          approved,
        }));
        assert(await decision.promise);
      } finally {
        socket.removeEventListener("message", onReply);
      }
    };
    const first = turn();
    await decidePending(0);
    const interrupted = await first;
    assert(interrupted?.type === "error");
    assertStringIncludes(interrupted.message, "checkpoint");
    assertEquals(postRequests, 1);
    assertEquals(resultSeen, undefined);
    cancelled = false;
    const stillRunning = await turn();
    assert(stillRunning?.type === "error");
    assertStringIncludes(stillRunning.message, "uncertain outcome");
    assertEquals(postRequests, 1);
    cancelled = true;
    currentAttempt = 3;
    const mismatch = await turn();
    assert(mismatch?.type === "error");
    assertStringIncludes(mismatch.message, "uncertain outcome");
    currentAttempt = 2;
    allowMetadata = false;
    const denied = await turn();
    assert(denied?.type === "error");
    assertStringIncludes(denied.message, "uncertain outcome");
    allowMetadata = true;
    const assertUnsettled = async () => {
      const denied = await turn();
      assert(denied?.type === "error");
      assertEquals(resultSeen, undefined);
      assertEquals(postRequests, 1);
      const pendingStore = new AgentRecoveryStore(
        join(baseDir, "agent-recovery.db"),
      );
      try {
        const key = assignmentRecoveryKey(session.id, executionId);
        const record = pendingStore.read(key);
        assert(record?.status === "pending");
        assertEquals(record.tools, []);
        assertEquals(pendingStore.pendingCall(key, record.pendingBatch)?.args, {
          action: "cancel_run",
          repo: target.repo,
          run_id: target.run_id,
          repositoryId: target.repository_id,
          attempt: target.attempt,
        });
      } finally {
        pendingStore.close();
      }
      assertStringIncludes(denied.message, "uncertain outcome");
    };
    let beforePoll = statusPolls;
    denyDispatch = true;
    await assertUnsettled();
    assertEquals(statusPolls, beforePoll);
    denyDispatch = false;
    blockAfterMetadata = true;
    await assertUnsettled();
    assertEquals(statusPolls, ++beforePoll);
    blockAfterMetadata = false;
    denyDispatch = false;
    denyCancelledResponse = true;
    await assertUnsettled();
    assertEquals(statusPolls, ++beforePoll);
    denyCancelledResponse = false;
    metadataTimedOut = true;
    await assertUnsettled();
    assertEquals(statusPolls, ++beforePoll);
    metadataTimedOut = false;
    repositoryVisibility = "private";
    await assertUnsettled();
    assertEquals(statusPolls, ++beforePoll);
    repositoryVisibility = "public";
    const resumed = await turn();
    assert(resumed?.type === "response");
    assertEquals(resultSeen, {
      repositoryId: 17,
      runId: 42,
      attempt: 2,
      outcome: "cancelled",
    });
    assertEquals(postRequests, 1);
    assertEquals(inbox.list().records.length, 1);
    cancelled = false;
    currentAttempt = 3;
    const stale = turn(
      `/recover ${crypto.randomUUID()} Stop the configured attempt.`,
    );
    await decidePending(1);
    const rejected = await stale;
    assert(rejected?.type === "error");
    assertEquals(postRequests, 1);
    mixedBatch = true;
    const mixed = await turn(
      `/recover ${crypto.randomUUID()} Stop the run and list other runs.`,
    );
    assert(mixed?.type === "error");
    assertStringIncludes(mixed.message, "before dispatch");
    assertEquals(postRequests, 1);
    assertEquals(inbox.list().records.length, 2);
    mixedBatch = false;

    currentAttempt = 2;
    blockAfterMetadata = true;
    const changedPolicyId = crypto.randomUUID();
    const lateDenial = turn(
      `/recover ${changedPolicyId} Stop the configured run.`,
    );
    await decidePending(1);
    const deniedAfterApproval = await lateDenial;
    assert(deniedAfterApproval?.type === "error");
    assertEquals(postRequests, 1);
    const journal = new AgentRecoveryStore(join(baseDir, "agent-recovery.db"));
    try {
      const key = assignmentRecoveryKey(session.id, changedPolicyId);
      const admission = journal.read(key);
      assert(admission?.status === "pending");
      assertEquals(journal.pendingCall(key, admission.pendingBatch), undefined);
    } finally {
      journal.close();
    }
    denyDispatch = false;
    blockAfterMetadata = false;
    const beforeRetry = inbox.list().records.length;
    const retry = turn(`/recover ${changedPolicyId} Stop the configured run.`);
    await decidePending(1, false);
    await retry;
    assertEquals(inbox.list().records.length, beforeRetry + 1);
    assertEquals(postRequests, 1);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
