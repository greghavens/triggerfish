import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
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
  type ExecutionTraceApprovedPayload,
  type ExecutionTraceScope,
  openExecutionTraces,
} from "../../src/core/execution_traces.ts";
import { teamDeliveryTraceSource } from "../../src/core/team_delivery_trace_source.ts";

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

Deno.test("Owner gateway scopes team and durable delegated traces before discovery and exact reads", async () => {
  const baseDir = await Deno.makeTempDir();
  const owner = session("owner");
  const foreignOwner = session("foreign-owner");
  const teamId = crypto.randomUUID();
  const legacyId = crypto.randomUUID();
  const foreignId = crypto.randomUUID();
  const ownId = crypto.randomUUID();
  const malformedId = crypto.randomUUID();
  const newestForeignId = crypto.randomUUID();
  const ownDelegatedId = crypto.randomUUID();
  const foreignDelegatedId = crypto.randomUUID();
  const tracePath = join(baseDir, "execution-traces.db");
  const journal = openExecutionTraces(tracePath);
  const seed = (runId: string, sourceId?: string) => {
    const scope: ExecutionTraceScope = {
      runId,
      sessionId: session("worker").id,
      role: "delegated",
      ...(sourceId && { sourceId }),
      classification: "INTERNAL",
    };
    const payload: ExecutionTraceApprovedPayload = {
      kind: "github_actions_run_status",
      repo: "example/controls",
      repositoryId: 110,
      id: 782,
      attempt: 1,
      status: "completed",
      conclusion: "success",
    };
    assert(journal.admit(scope));
    const receipt = journal.appendNext(scope, {
      tool: "github_actions",
      classification: "INTERNAL",
      outcome: "returned",
    }, payload);
    assert(receipt);
    assert(journal.finish(scope, "completed", "INTERNAL"));
    return receipt.id;
  };
  const foreignStep = (() => {
    seed(legacyId);
    seed(ownDelegatedId, owner.id);
    seed(foreignDelegatedId, foreignOwner.id);
    seed(malformedId, `team-delivery:${owner.id}:malformed`);
    const foreignStep = seed(
      foreignId,
      teamDeliveryTraceSource(foreignOwner.id, teamId, crypto.randomUUID()),
    );
    seed(ownId, teamDeliveryTraceSource(owner.id, teamId, crypto.randomUUID()));
    seed(
      newestForeignId,
      teamDeliveryTraceSource(foreignOwner.id, teamId, crypto.randomUUID()),
    );
    return foreignStep;
  })();
  const foreignListCursor = journal.listRuns({
    role: "delegated",
    ceiling: "INTERNAL",
    limit: 1,
  })?.nextCursor;
  assert(foreignListCursor);
  journal.close();

  let authorizedPayloads = 0;
  let confirmations = 0;
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
    activeOwner: ReturnType<typeof session>,
    run: (
      turn: (args: Record<string, unknown>) => Promise<string>,
    ) => Promise<void>,
  ) {
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: activeOwner,
        providerRegistry: operator,
        targetClassification: "INTERNAL",
        hookRunner: hooks,
        tools: [{
          name: "github_actions",
          description: "Previously authorized status operation",
          parameters: {},
        }],
        toolExecutor: () =>
          Promise.reject(new Error("History must not rerun GitHub")),
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          confirm: () => {
            confirmations++;
            return Promise.resolve(true);
          },
          authorizeExecutionTracePayload: () => {
            authorizedPayloads++;
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
    await withOwner(owner, async (turn) => {
      const listArgs = { action: "list", kind: "delegated", limit: 1 };
      const list = JSON.parse(await turn(listArgs));
      assertEquals(
        list.runs.map(({ ref }: { ref: { id: string } }) => ref.id),
        [
          ownId,
        ],
      );
      assert(list.nextCursor);
      const listNext = JSON.parse(
        await turn({ ...listArgs, cursor: list.nextCursor }),
      );
      assertEquals(
        listNext.runs.map(({ ref }: { ref: { id: string } }) => ref.id),
        [ownDelegatedId],
      );
      const listLast = JSON.parse(
        await turn({ ...listArgs, cursor: listNext.nextCursor }),
      );
      assertEquals(listLast.runs[0].ref.id, legacyId);
      assertEquals(listLast.nextCursor, null);
      const unavailable = "Error: This operation or exact run is unavailable.";
      assertEquals(
        await turn({ ...listArgs, cursor: foreignListCursor }),
        unavailable,
      );

      // Unqualified history must apply the same owner filter.
      const history = { action: "execution_traces", limit: 1 };
      const historyFirst = JSON.parse(await turn(history)).page;
      assertEquals(historyFirst.runs[0].scope.runId, ownId);
      const historyNext =
        JSON.parse(await turn({ ...history, cursor: historyFirst.nextCursor }))
          .page;
      assertEquals(historyNext.runs[0].scope.runId, ownDelegatedId);
      const historyLast =
        JSON.parse(await turn({ ...history, cursor: historyNext.nextCursor }))
          .page;
      assertEquals(historyLast.runs[0].scope.runId, legacyId);
      assertEquals(historyLast.nextCursor, null);

      for (
        const selector of [
          { action: "execution_traces", query: "github_actions" },
          { action: "execution_trace_payload", query: "example/controls" },
        ]
      ) {
        const args = { ...selector, limit: 1 };
        const first = JSON.parse(await turn(args)).page;
        assertEquals(
          first.matches.map(({ runId }: { runId: string }) => runId),
          [
            ownId,
          ],
        );
        assert(first.nextCursor);
        const forgedAnchor = first.nextCursor.split(".")[0] + "." + foreignStep;
        assertEquals(
          await turn({ ...args, cursor: forgedAnchor }),
          unavailable,
        );
        const next =
          JSON.parse(await turn({ ...args, cursor: first.nextCursor })).page;
        assertEquals(
          next.matches.map(({ runId }: { runId: string }) => runId),
          [
            ownDelegatedId,
          ],
        );
        const last =
          JSON.parse(await turn({ ...args, cursor: next.nextCursor })).page;
        assertEquals(last.matches[0].runId, legacyId);
        assertEquals(last.nextCursor, null);
      }
      assertEquals(authorizedPayloads, 3);

      for (
        const id of [
          foreignId,
          foreignDelegatedId,
          malformedId,
          crypto.randomUUID(),
        ]
      ) {
        const exact = { traceRole: "delegated", id, ordinal: 1 };
        assertEquals(
          await turn({ action: "execution_traces", ...exact }),
          unavailable,
        );
        assertEquals(
          await turn({ action: "execution_trace_payload", ...exact }),
          unavailable,
        );
        assertEquals(
          await turn({
            action: "search_case_traces",
            query: "",
            scopes: [{ kind: "delegated", id }],
          }),
          unavailable,
        );
      }
      const exactOwn = JSON.parse(
        await turn({
          action: "search_case_traces",
          query: "",
          scopes: [{ kind: "delegated", id: ownId }],
        }),
      );
      assertEquals(exactOwn.pages[0].page.steps[0].tool, "github_actions");
      assertEquals(authorizedPayloads, 3);
    });

    const archiveId = crypto.randomUUID();
    const archivedRun = { kind: "delegated", id: foreignDelegatedId };
    const archive = { action: "archive", ...archivedRun, requestId: archiveId };
    const restore = {
      action: "restore",
      ...archivedRun,
      archiveId,
      requestId: crypto.randomUUID(),
    };
    const history = { action: "archive_history", ...archivedRun };
    const unavailableArchive =
      "Error: The archive or exact stopped run is unavailable.";
    await withOwner(owner, async (turn) => {
      assertEquals(await turn(archive), unavailableArchive);
      assertEquals(confirmations, 0);
    });
    await withOwner(foreignOwner, async (turn) => {
      assertEquals(JSON.parse(await turn(archive)).receipt.status, "succeeded");
      assertEquals(confirmations, 1);
    });
    await Deno.rename(tracePath, join(baseDir, "prior-traces.db"));
    await withOwner(owner, async (turn) => {
      assertEquals(await turn(history), unavailableArchive);
      assertEquals(await turn(archive), unavailableArchive);
      assertEquals(await turn(restore), unavailableArchive);
      assertEquals(confirmations, 1);
    });
    await withOwner(foreignOwner, async (turn) => {
      assertEquals(
        JSON.parse(await turn(history)).records[0].archiveId,
        archiveId,
      );
      assertEquals(JSON.parse(await turn(restore)).receipt.status, "succeeded");
      assertEquals(confirmations, 2);
      const trace = JSON.parse(
        await turn({
          action: "execution_traces",
          traceRole: "delegated",
          id: foreignDelegatedId,
          ordinal: 1,
        }),
      );
      assertEquals(trace.step.scope.sourceId, foreignOwner.id);
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
