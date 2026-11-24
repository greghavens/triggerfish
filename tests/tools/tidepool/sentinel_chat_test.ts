import { assertEquals } from "@std/assert";
import type { MessageContent } from "../../../src/core/image/content.ts";
import type { ChatSession } from "../../../src/gateway/chat.ts";
import { routeHostRequest } from "../../../src/tools/tidepool/host/host_server.ts";
import type { A2UIHostState } from "../../../src/tools/tidepool/host/host_types.ts";
import {
  type ChatDispatchContext,
  dispatchClientChatMessage,
} from "../../../src/tools/tidepool/host/host_chat.ts";

Deno.test("Tidepool routes Sentinel turns before the agent and resets on clear", async () => {
  const sent: unknown[] = [];
  const agentContent: unknown[] = [];
  let resetCount = 0;
  let clearCount = 0;
  let finished = Promise.withResolvers<void>();
  const ctx: ChatDispatchContext = {
    socket: {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        const event = JSON.parse(payload);
        sent.push(event);
        if (event.type === "turn_end") finished.resolve();
      },
    } as unknown as WebSocket,
    chatSession: {
      executeAgentTurn(content: MessageContent) {
        agentContent.push(content);
        return Promise.resolve();
      },
      clear() {
        clearCount++;
      },
    } as unknown as ChatSession,
    ref: { current: null },
    sentinelMode: {
      active: false,
      handle(content, send) {
        if (content !== "/sentinel") return Promise.resolve(false);
        send({ type: "response", text: "Sentinel is active" });
        return Promise.resolve(true);
      },
      reset() {
        resetCount++;
      },
    },
  };

  dispatchClientChatMessage(
    JSON.stringify({ type: "message", content: "/sentinel" }),
    ctx,
  );
  await finished.promise;
  assertEquals(agentContent, []);
  assertEquals(sent, [
    { type: "response", text: "Sentinel is active" },
    { type: "turn_end" },
  ]);

  finished = Promise.withResolvers<void>();
  dispatchClientChatMessage(
    JSON.stringify({ type: "message", content: "Ordinary chat" }),
    ctx,
  );
  await finished.promise;
  assertEquals(agentContent, ["Ordinary chat"]);
  assertEquals(ctx.ref.current, null);

  dispatchClientChatMessage(JSON.stringify({ type: "clear" }), ctx);
  assertEquals(resetCount, 1);
  assertEquals(clearCount, 1);
});

Deno.test("Tidepool cancellation aborts pending Sentinel routing before agent fallback", async () => {
  let invoked = false;
  const sent: unknown[] = [];
  const pending = Promise.withResolvers<boolean>();
  const finished = Promise.withResolvers<void>();
  const ctx: ChatDispatchContext = {
    socket: {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        const event = JSON.parse(payload);
        sent.push(event);
        if (event.type === "turn_end") finished.resolve();
      },
    } as unknown as WebSocket,
    chatSession: {
      executeAgentTurn() {
        invoked = true;
        return Promise.resolve();
      },
    } as unknown as ChatSession,
    ref: { current: null },
    sentinelMode: {
      active: false,
      handle(_content, _send, signal) {
        signal.addEventListener("abort", () => pending.resolve(false));
        return pending.promise;
      },
      reset() {},
    },
  };

  dispatchClientChatMessage(
    JSON.stringify({ type: "message", content: "report" }),
    ctx,
  );
  dispatchClientChatMessage(JSON.stringify({ type: "cancel" }), ctx);
  await finished.promise;
  assertEquals(invoked, false);
  assertEquals(sent, [{ type: "cancelled" }, { type: "turn_end" }]);
});

Deno.test("Tidepool isolates normal chat controls and stale prompt replies in Sentinel mode", () => {
  const sent: unknown[] = [];
  const calls: string[] = [];
  const mode = {
    active: true,
    handle: () => Promise.resolve(false),
    reset: () => calls.push("reset"),
  };
  const context: ChatDispatchContext = {
    socket: {
      readyState: WebSocket.OPEN,
      send: (message: string) => sent.push(JSON.parse(message)),
    } as unknown as WebSocket,
    chatSession: {
      toggleBumpers: () => {
        calls.push("bumpers");
        return true;
      },
      compact: () => {
        calls.push("compact");
        return Promise.resolve();
      },
      handleSecretPromptResponse: () => calls.push("secret"),
      handleCredentialPromptResponse: () => calls.push("credential"),
      handleConfirmPromptResponse: () => calls.push("confirm"),
      handleTriggerPromptResponse: () => calls.push("trigger"),
      clear: () => calls.push("clear"),
    } as unknown as ChatSession,
    ref: { current: null },
    sentinelMode: mode,
  };
  for (
    const type of [
      "bumpers",
      "compact",
      "secret_prompt_response",
      "credential_prompt_response",
      "confirm_prompt_response",
      "trigger_prompt_response",
    ]
  ) {
    dispatchClientChatMessage(JSON.stringify({ type }), context);
  }
  assertEquals(calls, []);
  assertEquals(
    sent,
    Array(2).fill({
      type: "error",
      message: "Exit Sentinel mode to use normal chat controls.",
    }),
  );
  dispatchClientChatMessage(JSON.stringify({ type: "clear" }), context);
  assertEquals(calls, ["reset", "clear"]);
  mode.active = false;
  dispatchClientChatMessage(JSON.stringify({ type: "bumpers" }), context);
  assertEquals(calls, ["reset", "clear", "bumpers"]);
});

Deno.test("Authenticated Tidepool disconnect aborts and clears an active Sentinel worker", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const releaseWorker = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  let clears = 0;
  let normalTurns = 0;
  const chat = {
    sentinelSnapshotPath: "fixture-snapshot.json",
    loadChatHistory: () => Promise.resolve([]),
    executeAgentTurn() {
      normalTurns++;
      return Promise.resolve();
    },
    createSentinelAgent(worker: boolean) {
      assertEquals(worker, true);
      return {
        async execute(
          _content: MessageContent,
          _send: unknown,
          signal: AbortSignal,
        ) {
          started.resolve(signal);
          await releaseWorker.promise;
        },
        clear() {
          clears++;
        },
      };
    },
  } as unknown as ChatSession;
  const state: A2UIHostState = {
    clients: new Set(),
    server: null,
    currentTree: null,
    resolvedPort: 0,
    cachedHtml: null,
    sessionKey: "test-session-key",
    lastMcpConnected: -1,
    lastMcpConfigured: -1,
    socketCleanupCallbacks: [() => disconnected.resolve()],
    canvasRenders: [],
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => routeHostRequest(request, state, chat),
  );
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.addr.port}/?key=${state.sessionKey}`,
  );
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "message",
      content: "/sentinel-agent Review saved observations",
    }));
  });
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(
      new Error("Timed out waiting for Tidepool worker lifecycle"),
    );
  }, 3000);
  try {
    const signal = await Promise.race([started.promise, timeout.promise]);
    assertEquals(signal.aborted, false);
    socket.close();
    await Promise.race([disconnected.promise, timeout.promise]);
    assertEquals(signal.aborted, true);
    assertEquals(clears, 1);
    assertEquals(normalTurns, 0);
    assertEquals(state.clients.size, 0);
  } finally {
    clearTimeout(timer);
    releaseWorker.resolve();
    if (socket.readyState < WebSocket.CLOSING) socket.close();
    await server.shutdown();
  }
});

for (const auth of ["no-key-configured", "wrong-key"] as const) {
  Deno.test(`Tidepool ${auth} cannot access Sentinel chat or workspace`, async () => {
    const frames: Record<string, unknown>[] = [];
    const rejected = Promise.withResolvers<void>();
    let agentCalls = 0;
    let workspaceCalls = 0;
    const chat = {
      sentinelSnapshotPath: "fixture-snapshot.json",
      loadChatHistory: () => Promise.resolve([]),
      createSentinelAgent() {
        agentCalls++;
        throw new Error("Unauthorized worker dispatch");
      },
      executeAgentTurn() {
        agentCalls++;
        return Promise.resolve();
      },
    } as unknown as ChatSession;
    const state: A2UIHostState = {
      clients: new Set(),
      server: null,
      currentTree: null,
      resolvedPort: 0,
      cachedHtml: null,
      sessionKey: auth === "wrong-key" ? "operator-key" : null,
      lastMcpConnected: -1,
      lastMcpConfigured: -1,
      topicHandlers: { sentinel: () => workspaceCalls++ },
      socketCleanupCallbacks: [],
      canvasRenders: [],
    };
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => routeHostRequest(request, state, chat),
    );
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.addr.port}/?key=invalid`,
    );
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "message",
        content: "/sentinel-agent Review saved observations",
      }));
      socket.send(JSON.stringify({ topic: "sentinel", type: "status" }));
    });
    socket.addEventListener("message", ({ data }) => {
      frames.push(JSON.parse(data));
      if (
        auth === "no-key-configured" &&
        frames.some((frame) => frame.type === "response") &&
        frames.some((frame) => frame.topic === "sentinel")
      ) rejected.resolve();
    });
    let closeCode: number | undefined;
    socket.addEventListener("close", ({ code }) => {
      closeCode = code;
      rejected.resolve();
    });
    const timer = setTimeout(
      () => rejected.reject(new Error("Timed out waiting for access denial")),
      3000,
    );
    try {
      await rejected.promise;
      assertEquals(agentCalls, 0);
      assertEquals(workspaceCalls, 0);
      if (auth === "wrong-key") {
        assertEquals(closeCode, 4401);
        assertEquals(frames, []);
      } else {
        assertEquals(
          frames.find((frame) => frame.type === "response")?.text,
          "Sentinel requires authenticated operator chat.",
        );
        assertEquals(
          frames.find((frame) => frame.topic === "sentinel")?.message,
          "Sentinel requires authenticated operator access.",
        );
      }
    } finally {
      clearTimeout(timer);
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      await server.shutdown();
    }
  });
}
