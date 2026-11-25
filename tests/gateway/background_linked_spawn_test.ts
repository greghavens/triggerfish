import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
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
  type ExecutionTraceScope,
  openExecutionTraces,
} from "../../src/core/execution_traces.ts";

import { readSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { schedulerExecutionIdentity } from "../../src/scheduler/service_execution.ts";

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

Deno.test("Owner gateway starts and links published assessments from exact background parents", async () => {
  const baseDir = await Deno.makeTempDir();
  const tracePath = join(baseDir, "execution-traces.db");
  const owner = session("owner");
  const foreign = session("foreign");
  const delegated = { kind: "delegated", id: crypto.randomUUID() } as const;
  const hidden = { ...delegated, id: crypto.randomUUID() };
  const scheduledIdentity = schedulerExecutionIdentity(
    "trigger",
    "control-audit",
    "test-approval",
  );
  const scheduled = { kind: "scheduled", id: scheduledIdentity.id } as const;
  const scope = {
    role: delegated.kind,
    runId: delegated.id,
    sourceId: owner.id,
    sessionId: crypto.randomUUID(),
  };
  const scopes: ExecutionTraceScope[] = [
    scope,
    { ...scope, runId: hidden.id, sourceId: foreign.id },
    {
      role: scheduled.kind,
      runId: scheduled.id,
      sourceId: scheduledIdentity.sourceId,
      sessionId: crypto.randomUUID(),
    },
  ];
  const seed = (scopes: readonly ExecutionTraceScope[]) => {
    const trace = openExecutionTraces(tracePath);
    try {
      for (const scope of scopes) {
        assert(trace.admit(scope));
        assert(trace.finish(scope, "completed"));
      }
    } finally {
      trace.close();
    }
  };
  const publish = (caseId: string, label = "Approved fixture asset") => {
    const path = resolveSentinelCasePath(baseDir, caseId);
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "asset", kind: "asset", label }],
        edges: [],
      }),
    );
  };
  let confirmations = 0;
  let denyPreCall = false;
  let beforeApproval: (() => void) | undefined;
  const events: string[] = [];
  const hooks: HookRunner = {
    evaluateHook(hook, { input }) {
      const operatorCall = input.tool_name === "operator_runs";
      if (operatorCall || hook === "PRE_OUTPUT") events.push(hook);
      const allowed =
        !(denyPreCall && operatorCall && hook === "PRE_TOOL_CALL");
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
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
            beforeApproval?.();
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

  const spawn = (
    parent: typeof delegated | typeof scheduled,
    targetId: string,
  ) => ({
    action: "spawn",
    ...parent,
    targetKind: "sentinel",
    targetId,
    requestId: crypto.randomUUID(),
  });
  const unavailable = "Error: This operation or exact run is unavailable.";
  const state = (caseId: string) =>
    readSentinelAssessment(resolveSentinelCasePath(baseDir, caseId));
  const fromDelegated = spawn(delegated, "delegated-child");
  const fromScheduled = spawn(scheduled, "scheduled-child");
  let delegatedChild: { run: { ref: Record<string, unknown> }; link: unknown };
  try {
    seed(scopes);
    publish(fromDelegated.targetId);
    publish(fromScheduled.targetId);
    await withOwner(async (turn) => {
      denyPreCall = true;
      await turn(fromDelegated);
      denyPreCall = false;
      assertEquals(confirmations, 0);
      assertEquals(state(fromDelegated.targetId), undefined);
      assertEquals(
        await turn({ ...fromDelegated, id: hidden.id }),
        unavailable,
      );
      assertEquals(
        await turn({ ...fromDelegated, targetId: "unpublished-child" }),
        unavailable,
      );
      assertEquals(confirmations, 0);

      beforeApproval = () =>
        publish(fromDelegated.targetId, "Changed after approval");
      assertEquals(await turn(fromDelegated), unavailable);
      assertEquals(state(fromDelegated.targetId), undefined);
      beforeApproval = undefined;

      events.length = 0;
      delegatedChild = JSON.parse(await turn(fromDelegated));
      assertEquals(delegatedChild.run.ref, {
        kind: "sentinel",
        id: fromDelegated.targetId,
        revision: 1,
      });
      assertEquals(state(fromDelegated.targetId)?.active, true);
      for (
        const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE", "PRE_OUTPUT"]
      ) {
        assert(events.includes(hook), hook);
      }

      // Remove the exact source during confirmation. The child must stay unpublished.
      beforeApproval = () => {
        Deno.renameSync(tracePath, join(baseDir, "previous-traces.db"));
        seed(scopes.filter(({ role }) => role !== "scheduled"));
      };
      assertEquals(await turn(fromScheduled), unavailable);
      assertEquals(state(fromScheduled.targetId), undefined);
      beforeApproval = undefined;
      seed(scopes.filter(({ role }) => role === "scheduled"));
      const scheduledChild = JSON.parse(await turn(fromScheduled));
      assertEquals(scheduledChild.link.left, scheduled);
      assertEquals(scheduledChild.link.right, scheduledChild.run.ref);
      assertEquals(state(fromScheduled.targetId)?.active, true);
    });
    const priorApprovals = confirmations;
    await withOwner(async (turn) => {
      const retry = JSON.parse(await turn(fromDelegated));
      assertEquals(retry.link, delegatedChild.link);
      assertEquals(retry.run.ref, delegatedChild.run.ref);
      assertEquals(confirmations, priorApprovals);
      assertEquals(await turn({ ...fromDelegated, ...scheduled }), unavailable);
      assertEquals(confirmations, priorApprovals);
      const inspected = JSON.parse(
        await turn({ action: "inspect", ...delegated }),
      );
      assertEquals(inspected.links, [delegatedChild.link]);
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
