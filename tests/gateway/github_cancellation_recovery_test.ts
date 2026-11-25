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
            visibility: "public",
          }),
        );
      }
      assertEquals(path, "/repos/owner/repo/actions/runs/42");
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
    const command = `/recover ${crypto.randomUUID()} Stop the approved run.`;
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
            toolCalls: done ? [] : [{
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
            }],
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
      const chat = createChatSession({
        session,
        providerRegistry: registry,
        recoverAgentTurn: recover,
        enableStreaming: false,
        tools: loadGitHubToolDefinitions(),
        toolExecutor: async (name, args) =>
          await tools(name, args) ?? "Error: unknown tool",
        hookRunner: { ...createHookRunner(engine), toolApprovalInbox: inbox },
      });
      const events: ChatEvent[] = [];
      await chat.executeAgentTurn(message, (event) => events.push(event));
      return events.at(-1);
    };
    const approvePending = async (expectedPosts: number) => {
      let pending;
      for (let i = 0; i < 100 && !pending; i++) {
        pending = inbox.list().records.find(({ status }) =>
          status === "pending"
        );
        if (!pending) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert(pending);
      assertEquals(postRequests, expectedPosts);
      assert(inbox.decide(pending.id, "approved"));
    };
    const first = turn();
    await approvePending(0);
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
    await approvePending(1);
    const rejected = await stale;
    assert(rejected?.type === "error");
    assertEquals(postRequests, 1);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
