import { assert, assertEquals } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGitHubClient } from "../../src/integrations/github/client.ts";
import { createGitHubToolExecutor } from "../../src/integrations/github/tools.ts";
import { loadGitHubToolDefinitions } from "../../src/integrations/github/tools_defs.ts";

Deno.test("Root dispatch reads one exact GitHub workflow attempt and enforces hooks", async () => {
  const paths: string[] = [];
  let attempt = 2;
  let repositoryId = 17;
  const client = createGitHubClient({
    token: "fixture-credential",
    fetchFn(input, init) {
      assertEquals(init?.method ?? "GET", "GET");
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/repos/owner/repo") {
        return Promise.resolve(Response.json({
          id: repositoryId,
          full_name: "owner/repo",
          visibility: "private",
          private: true,
        }));
      }
      assertEquals(path, "/repos/owner/repo/actions/runs/42/attempts/2");
      return Promise.resolve(Response.json({
        id: 42,
        repository: { id: 17 },
        run_attempt: attempt,
        status: "completed",
        conclusion: "cancelled",
        inputs: { token: "private input" },
      }));
    },
  });
  let deny: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | undefined;
  let received = "";
  const tools = loadGitHubToolDefinitions();
  const registry = createProviderRegistry();
  registry.register({
    name: "exact-workflow-run",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      const done = last?.role === "tool";
      if (done) received = String(last.content);
      return Promise.resolve({
        content: done ? "Read the exact workflow attempt." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: done ? [] : [{
          type: "function",
          id: crypto.randomUUID(),
          function: {
            name: "github_actions",
            arguments: JSON.stringify({
              action: "get_run",
              repo: "owner/repo",
              run_id: 42,
              attempt: 2,
            }),
          },
        }],
      });
    },
  });
  registry.setDefault("exact-workflow-run");
  const turn = async () => {
    received = "";
    const session = createSession({
      userId: "owner" as UserId,
      channelId: "test" as ChannelId,
      bumpersEnabled: false,
    });
    const execute = createGitHubToolExecutor({
      client,
      sessionTaint: session.taint,
      sourceSessionId: session.id,
    });
    const chat = createChatSession({
      session,
      targetClassification: "CONFIDENTIAL",
      providerRegistry: registry,
      tools,
      toolExecutor: async (name, args) =>
        await execute(name, args) ?? "Error: unknown tool",
      enableStreaming: false,
      hookRunner: {
        evaluateHook(hook) {
          const allowed = hook !== deny;
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          });
        },
      },
    });
    const events: ChatEvent[] = [];
    await chat.executeAgentTurn(
      "Inspect the approved run attempt.",
      (event) => events.push(event),
    );
    return events;
  };
  deny = "PRE_TOOL_CALL";
  await turn();
  assertEquals(paths, []);
  deny = "POST_TOOL_RESPONSE";
  await turn();
  assertEquals(received, "Tool response withheld by policy.");
  assertEquals(paths.length, 2);
  deny = "PRE_OUTPUT";
  const blocked = await turn();
  assert(!blocked.some((event) => event.type === "response"));
  deny = undefined;
  await turn();
  assertEquals(JSON.parse(received), {
    id: 42,
    repositoryId: 17,
    attempt: 2,
    status: "completed",
    conclusion: "cancelled",
    _classification: "CONFIDENTIAL",
  });
  attempt = 3;
  await turn();
  assert(received.includes("Unexpected workflow run identity"));
  attempt = 2;
  repositoryId = 19;
  await turn();
  assert(received.includes("repository identity could not be verified"));
});
