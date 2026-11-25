import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { OperatorRunLink } from "../../src/core/operator_runs.ts";
import {
  type ChannelId,
  createSession,
  updateTaint,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  type ExecutionTraceScope,
  openExecutionTraces,
} from "../../src/core/execution_traces.ts";

const usage = { inputTokens: 1, outputTokens: 1 };
function session(channelId: string) {
  return updateTaint(
    createSession({
      userId: "fixture" as UserId,
      channelId: channelId as ChannelId,
    }),
    "INTERNAL",
    "Fixture scope",
  );
}

Deno.test("Gateway restores exact background run links atomically with their execution trace", async () => {
  const baseDir = await Deno.makeTempDir();
  const tracePath = join(baseDir, "execution-traces.db");
  const linkPath = join(baseDir, "operator-run-links.db");
  const owner = session("owner");
  let confirmations = 0;
  const archived = { kind: "delegated", id: crypto.randomUUID() } as const;
  const peer = { kind: "scheduled", id: crypto.randomUUID() } as const;
  const other = { kind: "scheduled", id: crypto.randomUUID() } as const;
  const requestId = crypto.randomUUID();
  const seed = (...runs: (typeof archived | typeof peer | typeof other)[]) => {
    const trace = openExecutionTraces(tracePath);
    try {
      for (const run of runs) {
        const scope: ExecutionTraceScope = {
          role: run.kind,
          runId: run.id,
          sessionId: crypto.randomUUID(),
          ...(run.kind === "delegated" && { sourceId: owner.id }),
        };
        assert(trace.admit(scope));
        assert(trace.appendNext(scope, {
          tool: "review_control",
          outcome: "returned",
          classification: "INTERNAL",
        }));
        assert(trace.finish(scope, "completed"));
      }
    } finally {
      trace.close();
    }
  };
  const hooks: HookRunner = {
    evaluateHook() {
      return Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const operator = createProviderRegistry();
  operator.register({
    name: "live-control-owner",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      if (last?.role === "tool") {
        return Promise.resolve({
          content: "Fixture result: " + last.content,
          usage,
          toolCalls: [],
        });
      }
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          id: crypto.randomUUID(),
          type: "function",
          function: { name: "operator_runs", arguments: String(last?.content) },
        }],
      });
    },
  });
  operator.setDefault("live-control-owner");
  async function withOwner(
    run: (
      turn: (args: Record<string, unknown>) => Promise<string>,
    ) => Promise<void>,
  ) {
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: owner,
        providerRegistry: operator,
        targetClassification: "INTERNAL",
        hookRunner: hooks,
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          confirm: () => {
            confirmations++;
            return Promise.resolve(true);
          },
        }),
      }),
    });
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const closed = Promise.withResolvers<void>();
    socket.addEventListener("close", () => closed.resolve(), { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      return await run(async (args: Record<string, unknown>) => {
        const complete = Promise.withResolvers<string>();
        const timer = setTimeout(
          () => complete.reject(new Error("Missing owner control response")),
          3500,
        );
        let text = "";
        const receive = ({ data }: MessageEvent) => {
          const frame = JSON.parse(data);
          if (frame.type === "response") text = frame.text;
          if (frame.type === "error") text = frame.message;
          if (frame.type === "turn_end") {
            complete.resolve(text.replace(/^Fixture result: /, ""));
          }
        };
        socket.addEventListener("message", receive);
        socket.send(
          JSON.stringify({ type: "message", content: JSON.stringify(args) }),
        );
        try {
          return await complete.promise;
        } finally {
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
        }
      });
    } finally {
      socket.close();
      await closed.promise;
      await gateway.stop();
    }
  }

  try {
    seed(archived, peer, other);
    const archiveId = crypto.randomUUID();
    const link = {
      action: "link",
      ...archived,
      targetKind: peer.kind,
      targetId: peer.id,
      requestId,
    };
    let originalLink: OperatorRunLink;
    await withOwner(async (turn) => {
      originalLink = JSON.parse(await turn(link)).link;
      assert(originalLink.id);
      assertEquals(
        JSON.parse(await turn({ action: "inspect", ...archived })).links,
        [originalLink],
      );
      const receipt = JSON.parse(
        await turn({
          action: "archive",
          ...archived,
          requestId: archiveId,
        }),
      ).receipt;
      assertEquals(receipt.status, "succeeded");
      assertEquals(confirmations, 2);
    });

    // Keep only the archive and provision the linked peers on a fresh gateway.
    await Deno.rename(tracePath, join(baseDir, "source-traces.db"));
    await Deno.rename(linkPath, join(baseDir, "source-links.db"));
    seed(peer, other);
    const restore = { action: "restore", ...archived, archiveId };
    await withOwner(async (turn) => {
      const competingLink = JSON.parse(
        await turn({
          ...link,
          ...peer,
          targetId: other.id,
        }),
      ).link;
      assert(competingLink.id);
      const failed = JSON.parse(
        await turn({
          ...restore,
          requestId: crypto.randomUUID(),
        }),
      ).receipt;
      assertEquals(failed.status, "failed");
      assertStringIncludes(
        await turn({ action: "inspect", ...archived }),
        "unavailable",
      );
      assertEquals(
        JSON.parse(await turn({ action: "inspect", ...peer })).links,
        [competingLink],
      );
    });

    // A clean link journal allows the same archive to restore with a new request.
    await Deno.rename(linkPath, join(baseDir, "competing-links.db"));
    await withOwner(async (turn) => {
      const exactRestore = { ...restore, requestId: crypto.randomUUID() };
      const restored = JSON.parse(await turn(exactRestore)).receipt;
      assertEquals(restored.status, "succeeded");
      assertEquals(JSON.parse(await turn(exactRestore)).receipt, restored);
      const result = JSON.parse(await turn({ action: "inspect", ...archived }));
      assertEquals(result.links, [originalLink]);
      const exact = JSON.parse(
        await turn({
          action: "execution_traces",
          traceRole: archived.kind,
          id: archived.id,
          ordinal: 1,
        }),
      );
      assertEquals(exact.step.tool, "review_control");
      const beforeReplay = confirmations;
      assertEquals(JSON.parse(await turn(link)).link, originalLink);
      assertEquals(confirmations, beforeReplay);
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
