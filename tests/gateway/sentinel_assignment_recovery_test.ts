import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { buildWorkflowRecoveryExecutor } from "../../src/gateway/startup/factory/agent_recovery.ts";
import {
  pauseSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { adaptiveRevision } from "../../src/sentinel/adaptive_planner.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

Deno.test("Owner recovery reconciles an exact committed Sentinel assignment through root dispatch", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "asset", kind: "asset", label: "Approved asset" }],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    assert(pauseSentinelAssessment(path, state.revision));
    const request = {
      action: "assign",
      kind: "sentinel",
      id: "main",
      revision: state.revision,
      runId: state.plan.runId,
      adaptiveRevision: adaptiveRevision(state),
      requestId: crypto.randomUUID(),
      taskKind: "trace",
      node: "asset",
    };
    const session = createSession({
      userId: "owner" as UserId,
      channelId: "test" as ChannelId,
      bumpersEnabled: false,
    });
    let approvals = 0;
    let dispatches = 0;
    let received = "";
    const original = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    const executionId = crypto.randomUUID();
    const message = `/recover ${executionId} Inspect the approved asset.`;
    const config = { agent_recovery: { sentinel_assignment_cases: ["main"] } };
    const secrets = createMemorySecretStore();
    assertEquals(
      buildWorkflowRecoveryExecutor(config, baseDir, secrets),
      undefined,
    );
    const recover = buildWorkflowRecoveryExecutor(
      config,
      baseDir,
      secrets,
      undefined,
      undefined,
      true,
    );
    assert(recover);

    const connect = async (interrupt: boolean) => {
      const registry = createProviderRegistry();
      registry.register({
        name: "assignment-recovery",
        supportsStreaming: false,
        complete(messages) {
          const last = messages.at(-1);
          const done = last?.role === "tool";
          if (done) received = String(last.content);
          return Promise.resolve({
            usage: { inputTokens: 1, outputTokens: 1 },
            content: done ? "Assignment receipt recovered." : "",
            toolCalls: done ? [] : [{
              type: "function",
              id: "assignment-fixture",
              function: {
                name: "operator_runs",
                arguments: JSON.stringify(request),
              },
            }],
          });
        },
      });
      registry.setDefault("assignment-recovery");
      const executeOperator = createOperatorRunToolExecutor({
        baseDir,
        confirm: () => {
          approvals++;
          return Promise.resolve(true);
        },
      });
      const chatSession = createChatSession({
        session,
        providerRegistry: registry,
        enableStreaming: false,
        recoverAgentTurn: recover,
        hookRunner: {
          async evaluateHook(hook, { input }) {
            if (
              hook === "POST_TOOL_RESPONSE" &&
              input.tool_name === "operator_runs"
            ) {
              if (interrupt) {
                original.resolve(String(input.tool_response));
                await release.promise;
              }
            }
            return {
              allowed: true,
              action: "ALLOW",
              ruleId: null,
              duration: 0,
            };
          },
        },
        operatorRunExecutor: (args, context) => {
          dispatches++;
          return executeOperator(args, context);
        },
      });
      const token = crypto.randomUUID();
      const gateway = createGatewayServer({ port: 0, token, chatSession });
      const { port } = await gateway.start();
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/chat?token=${token}`,
      );
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      return { socket, gateway };
    };
    const first = await connect(true);
    let committed = "";
    try {
      first.socket.send(JSON.stringify({ type: "message", content: message }));
      committed = await Promise.race([
        original.promise,
        new Promise<string>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Assignment did not reach response policy")),
            3_000,
          );
          Deno.unrefTimer(timer);
        }),
      ]);
      assertEquals(JSON.parse(committed).receipt.requestId, request.requestId);
    } finally {
      const closed = new Promise<void>((resolve) =>
        first.socket.addEventListener("close", () => resolve(), { once: true })
      );
      first.socket.close();
      await closed;
      release.resolve();
      await first.gateway.stop();
    }
    const journal = new AgentRecoveryStore(join(baseDir, "agent-recovery.db"));
    try {
      assertEquals(
        journal.read(assignmentRecoveryKey(session.id, executionId))?.status,
        "pending",
      );
    } finally {
      journal.close();
    }
    const reopened = await connect(false);
    try {
      const result = Promise.withResolvers<string>();
      const timer = setTimeout(
        () => result.reject(new Error("Recovery timed out")),
        3_000,
      );
      reopened.socket.addEventListener("message", ({ data }) => {
        const event = JSON.parse(data);
        if (event.type === "response") result.resolve(event.text);
        if (event.type === "error") result.reject(new Error(event.message));
      });
      try {
        reopened.socket.send(
          JSON.stringify({ type: "message", content: message }),
        );
        assertStringIncludes(
          await result.promise,
          "Assignment receipt recovered.",
        );
      } finally {
        clearTimeout(timer);
      }
      assertEquals(received, committed);
      assertEquals(dispatches, 1);
      assertEquals(approvals, 1);
      assertEquals(
        readAdaptiveSentinel(path, state)?.tasks.filter(({ id }) =>
          id === JSON.parse(committed).receipt.taskId
        ).length,
        1,
      );
    } finally {
      reopened.socket.close();
      await reopened.gateway.stop();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
