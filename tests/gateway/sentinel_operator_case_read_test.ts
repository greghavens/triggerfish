import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createSession } from "../../src/core/types/session.ts";
import type { ChannelId, UserId } from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

Deno.test("Authenticated Sentinel chat reads exact approved cross-case graph and findings through root policy", async () => {
  const baseDir = await Deno.makeTempDir();
  const secretLabel = "Exact authorized cross-case finding";
  const hiddenLabel = "Unregistered case finding";
  async function setupCase(id: string, label: string) {
    const path = resolveSentinelCasePath(baseDir, id);
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ kind: "finding", id: "finding", label, severity: "low" }],
        edges: [],
      }),
      { mode: 0o600 },
    );
    return { path, revision: startSentinelAssessment(path).revision };
  }

  const main = await setupCase("main", "Selected case finding");
  const approved = await setupCase("approved", secretLabel);
  const hidden = await setupCase("unregistered", hiddenLabel);
  const operator = createOperatorRunToolExecutor({
    baseDir,
    confirm() {
      throw new Error("A Sentinel graph read cannot request a mutation.");
    },
  });
  const ordinaryOwner = createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  });
  const registry = createProviderRegistry();
  let request: Record<string, unknown> | undefined;
  let result = "";
  let verifyWorkerBinding = false;
  let dispatched = 0;
  let reject: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | undefined;
  const hooks: string[] = [];
  registry.register({
    name: "sentinel-cross-case-reader",
    supportsStreaming: false,
    complete(messages, tools) {
      const next = request;
      request = undefined;
      const definitions = tools as {
        function?: {
          name?: string;
          parameters?: { properties?: { action?: { enum?: string[] } } };
        };
      }[] | undefined;
      const definition = definitions?.find((tool) =>
        tool.function?.name === "operator_runs"
      );
      if (verifyWorkerBinding) {
        assertEquals(definition, undefined);
        verifyWorkerBinding = false;
        return Promise.resolve({
          content: "Worker bindings verified.",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
        });
      }
      if (next) {
        assert(definition);
        assertEquals(
          definition.function?.parameters?.properties?.action?.enum,
          [
            "graph_overview",
            "graph",
            "findings",
            "node",
          ],
        );
      } else {
        result = String(
          messages.findLast(({ role }) => role === "tool")?.content,
        );
      }
      return Promise.resolve({
        content: next ? "" : result,
        toolCalls: next
          ? [{
            type: "function",
            id: crypto.randomUUID(),
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(next),
            },
          }]
          : [],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  });
  registry.setDefault("sentinel-cross-case-reader");
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    token,
    port: 0,
    chatSession: createChatSession({
      session: ordinaryOwner,
      providerRegistry: registry,
      sentinelSnapshotPath: main.path,
      resolveSentinelChatCase: (id) =>
        id === "approved" ? approved.path : undefined,
      allowSentinelModelAccess: true,
      hookRunner: {
        evaluateHook(hook, { input }) {
          const selectsTool = input.tool_name === "operator_runs";
          if (selectsTool || hook === "PRE_OUTPUT") hooks.push(hook);
          const blocked = hook === reject &&
            (selectsTool || hook === "PRE_OUTPUT" &&
                typeof input.content === "string" &&
                input.content.includes(secretLabel));
          return Promise.resolve({
            allowed: !blocked,
            action: blocked ? "BLOCK" : "ALLOW",
            ruleId: null,
            duration: 0,
          });
        },
      },
      operatorRunExecutor(args, policy) {
        dispatched++;
        assertEquals(policy?.authenticatedOwnerSessionId, ordinaryOwner.id);
        assertEquals(policy?.ceiling, "INTERNAL");
        assert(
          policy?.authorizeSentinelCaseRead?.("approved", approved.revision) ||
            args.revision !== approved.revision,
        );
        assertEquals(
          policy?.authorizeSentinelCaseRead?.("unregistered", hidden.revision),
          false,
        );
        return operator(args, policy);
      },
    }),
  });
  const { port } = await gateway.start();
  const url = `ws://127.0.0.1:${port}/chat?token=`;
  const unauthenticated = new WebSocket(url + "wrong-owner-token");
  const socket = new WebSocket(url + token);
  try {
    await new Promise<void>((resolve, reject) => {
      unauthenticated.addEventListener(
        "open",
        () => reject(new Error("Unauthenticated client connected")),
        { once: true },
      );
      unauthenticated.addEventListener("close", () => resolve(), {
        once: true,
      });
    });
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) return resolve();
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = async (content: string, call?: Record<string, unknown>) => {
      request = call;
      result = "";
      hooks.length = 0;
      const done = Promise.withResolvers<readonly string[]>();
      const frames: string[] = [];
      const timer = setTimeout(
        () => done.reject(new Error("Missing Sentinel turn end")),
        3000,
      );
      const receive = ({ data }: MessageEvent) => {
        frames.push(String(data));
        if (JSON.parse(data).type === "turn_end") done.resolve(frames);
      };
      socket.addEventListener("message", receive);
      try {
        socket.send(JSON.stringify({ type: "message", content }));
        return await done.promise;
      } finally {
        socket.removeEventListener("message", receive);
        clearTimeout(timer);
      }
    };
    await turn("/sentinel on");
    const exact = {
      kind: "sentinel",
      id: "approved",
      revision: approved.revision,
    };
    await turn("Read the peer finding", { action: "findings", ...exact });
    assertStringIncludes(result, secretLabel);
    assert(
      hooks.includes("PRE_TOOL_CALL") && hooks.includes("POST_TOOL_RESPONSE") &&
        hooks.includes("PRE_OUTPUT"),
    );
    assertEquals(dispatched, 1);
    const saved = JSON.parse(result);
    const graphNode = saved.page.nodes[0].id;

    await turn("Reopen the exact node", {
      ...exact,
      action: "node",
      node: graphNode,
    });
    assertStringIncludes(result, secretLabel);
    await turn("Read the peer graph", { ...exact, action: "graph" });
    assertStringIncludes(result, secretLabel);
    await turn("Read the peer graph summary", {
      ...exact,
      action: "graph_overview",
    });
    assertEquals(JSON.parse(result).overview.revision, approved.revision);

    await turn("Unknown case", {
      ...exact,
      action: "graph",
      id: "unregistered",
    });
    assertStringIncludes(result, "unavailable");
    assert(!result.includes(hiddenLabel));
    await turn("Unknown revision", {
      ...exact,
      action: "graph",
      revision: exact.revision + 100,
    });
    assertStringIncludes(result, "unavailable");
    const beforeMutation = dispatched;
    await turn("Unexpected mutation", { ...exact, action: "pause" });
    assertStringIncludes(result, "unavailable");
    assertEquals(dispatched, beforeMutation);

    reject = "PRE_TOOL_CALL";
    await turn("Pre-call denial", { ...exact, action: "graph" });
    assert(!result.includes(secretLabel));
    assertEquals(dispatched, beforeMutation);
    reject = "POST_TOOL_RESPONSE";
    await turn("Response classification denial", { ...exact, action: "graph" });
    assert(!result.includes(secretLabel));
    assertEquals(dispatched, beforeMutation + 1);
    reject = "PRE_OUTPUT";
    const blocked = await turn("Output denial", { ...exact, action: "graph" });
    assertStringIncludes(result, secretLabel);
    assert(blocked.every((frame) => !frame.includes(secretLabel)));

    reject = undefined;
    const selectedCase = await turn("/sentinel case");
    assert(
      selectedCase.some((frame) => frame.includes("Sentinel case: main.")),
    );
    verifyWorkerBinding = true;
    const worker = await turn(
      "/sentinel-agent Check the scoped worker bindings.",
    );
    assert(worker.some((frame) => frame.includes("Worker bindings verified.")));
    assertEquals(dispatched, beforeMutation + 2);
  } finally {
    socket.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
