import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { dirname } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
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
  createSentinelModelPlanner,
  readAdaptiveSentinel,
  readSentinelCaseHints,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import {
  recordSentinelOperatingConstraints,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

Deno.test("Reviewed analyst observations reach the next Sentinel plan without satisfying verified work", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      version: 1,
      nodes: [
        { id: "app", kind: "asset", label: "Application" },
        { id: "other", kind: "asset", label: "Other asset" },
        {
          id: "local-log",
          kind: "evidence",
          label: "Retained log observation",
        },
      ],
      edges: [{ from: "local-log", to: "app", relation: "observed_on" }],
    }),
  );
  const state = startSentinelAssessment(path);
  advanceAdaptiveSentinel(path, state);
  assertExists(state.plan.runId);
  const secondNote =
    "Analyst recorded another contextual observation before review.";
  const planningRevocation = Promise.withResolvers<void>();
  const releasePlan = Promise.withResolvers<void>();
  const secondReturned = Promise.withResolvers<void>();
  const note =
    "Operator observed a change in the retained application telemetry.";
  const observation = {
    action: "hint_batch",
    kind: "sentinel",
    id: "main",
    runId: state.plan.runId,
    revision: state.revision,
    requestId: crypto.randomUUID(),
    hints: [{
      note,
      assetIds: ["app"],
      analystObservation: { evidenceId: "local-log", confidence: "observed" },
    }],
  };
  let clock = Date.now();
  let seen: {
    id: number;
    text: string;
    assetIds: string[];
    analystObservation: {
      evidenceId: string;
      confidence: string;
      sourceSha256: string;
    };
  } | undefined;
  const planner = createSentinelModelPlanner(
    path,
    (_state, taskId) => ({
      async execute(message, send) {
        if (taskId) return;
        const input = JSON.parse(String(message).split("\n").at(-1)!);
        const second = input.operatorAssetHints?.find((
          { text }: { text: string },
        ) => text === secondNote);
        if (second) {
          planningRevocation.resolve();
          await releasePlan.promise;
          send({
            type: "response",
            taint: "INTERNAL",
            text: JSON.stringify([{
              kind: "impact",
              depth: 2,
              nodeId: "app",
              analystObservationHintId: second.id,
            }]),
          });
          secondReturned.resolve();
          return;
        }
        seen = input.operatorAssetHints?.find(({ text }: { text: string }) =>
          text === note
        );
        send({
          type: "response",
          taint: "INTERNAL",
          text: JSON.stringify(
            seen
              ? [
                {
                  kind: "impact",
                  nodeId: "other",
                  analystObservationHintId: seen.id,
                },
                {
                  kind: "trace",
                  nodeId: "app",
                  analystObservationHintId: seen.id,
                  graphFactOnly: true,
                },
                {
                  kind: "impact",
                  depth: 1,
                  nodeId: "app",
                  analystObservationHintId: seen.id,
                },
              ]
              : [],
          ),
        });
        return Promise.resolve();
      },
      clear() {},
    }),
    undefined,
    () => clock,
  );
  const coordinator = startSentinelAssessmentCoordinator({
    snapshotPath: path,
    advanceAdaptive: (current) => planner.advance(current),
  });
  let args: Record<string, unknown> = observation;
  let response = "";
  let confirmations = 0;
  let revokeDuringReview = false;
  let revoke = false;
  function setupGateway() {
    const providers = createProviderRegistry();
    providers.register({
      name: "analyst-observation-fixture",
      supportsStreaming: false,
      complete(messages) {
        const last = messages.at(-1);
        const done = last?.role === "tool";
        if (done) response = String(last.content);
        return Promise.resolve({
          content: done ? "Checked the operation." : "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: done ? [] : [{
            type: "function",
            id: crypto.randomUUID(),
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(args),
            },
          }],
        });
      },
    });
    providers.setDefault("analyst-observation-fixture");
    const chatSession = createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "analyst-fixture" as ChannelId,
        bumpersEnabled: false,
      }),
      providerRegistry: providers,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        confirm(text) {
          confirmations++;
          assertStringIncludes(text, "sourceSha256");
          if (revokeDuringReview) revoke = true;
          return Promise.resolve(true);
        },
      }),
      hookRunner: {
        evaluateHook(hook, { input }) {
          const call = input.tool_call as
            | { args?: { action?: string } }
            | undefined;
          const allowed = !(revoke && hook === "PRE_TOOL_CALL" &&
            call?.args?.action === "hint_batch");
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            duration: 0,
            ruleId: null,
          });
        },
      },
    });
    const token = crypto.randomUUID();
    return {
      token,
      gateway: createGatewayServer({ port: 0, token, chatSession }),
    };
  }
  async function withSocket(
    run: (
      send: (input: Record<string, unknown>) => Promise<string>,
    ) => Promise<void>,
  ) {
    const { gateway, token } = setupGateway();
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      await run(async (input) => {
        args = input;
        response = "";
        const start = Promise.withResolvers<void>();
        const bound = setTimeout(
          () => start.reject(new Error("No gateway turn result")),
          3000,
        );
        const listener = ({ data }: MessageEvent) => {
          if (JSON.parse(data).type === "turn_end") start.resolve();
        };
        socket.addEventListener("message", listener);
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Review the sourced observation.",
          }),
        );
        await start.promise.finally(() => {
          clearTimeout(bound);
          socket.removeEventListener("message", listener);
        });
        assert(response);
        return response;
      });
    } finally {
      socket.close();
      await gateway.stop();
    }
  }

  let receipt: unknown;
  try {
    await withSocket(async (send) => {
      for (
        const invalid of [
          { ...observation, revision: state.revision + 1 },
          {
            ...observation,
            hints: [{ ...observation.hints[0], assetIds: ["other"] }],
          },
        ]
      ) assertStringIncludes(await send(invalid), "unavailable");
      assertEquals(confirmations, 0);
      revokeDuringReview = true;
      assertStringIncludes(await send(observation), "unavailable");
      assertEquals(readSentinelCaseHints(path, 10), []);
      revoke = false;
      revokeDuringReview = false;
      clock += 61_000;
      receipt = JSON.parse(await send(observation)).receipt;
      assertExists(receipt);
    });
    const [saved] = readSentinelCaseHints(path, 10);
    assertExists(saved?.analystObservation);
    assertEquals(saved.analystObservation.evidenceId, "local-log");
    assertEquals(saved.text, note);
    for (let tries = 0; tries < 150 && !seen; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertExists(seen);
    assertEquals(seen.analystObservation, saved.analystObservation);
    assertEquals(seen.id, saved.id);
    const tasks = readAdaptiveSentinel(path, state)?.tasks ?? [];
    const followup = tasks.find(({ plannerRound }) =>
      plannerRound?.hintId === saved.id
    );
    assertExists(followup);
    assertEquals(followup.nodeId, "app");
    assertEquals(followup.kind, "impact");
    assertEquals(followup.factSatisfaction, undefined);
    assert(
      !tasks.some(({ nodeId, plannerRound }) =>
        nodeId === "other" && plannerRound?.hintId === saved.id
      ),
    );
    const exactRead = {
      action: "analyst_observation",
      kind: "sentinel",
      id: "main",
      runId: state.plan.runId,
      revision: state.revision,
      hintId: saved.id,
    };
    await withSocket(async (send) => {
      assertEquals(JSON.parse(await send(observation)).receipt, receipt);
      assertEquals(JSON.parse(await send(exactRead)).observation, saved);
    });
    assertEquals(confirmations, 2);
    assertEquals(readSentinelCaseHints(path, 10), [saved]);
    let secondId = 0;
    await withSocket(async (send) => {
      clock += 61_000;
      secondId = JSON.parse(
        await send({
          ...observation,
          requestId: crypto.randomUUID(),
          hints: [{ ...observation.hints[0], note: secondNote }],
        }),
      ).receipt.hintIds[0];
      assert(secondId > saved.id);
      const timeout = setTimeout(
        () => planningRevocation.reject(new Error("No analyst planning wake")),
        3000,
      );
      await planningRevocation.promise.finally(() => clearTimeout(timeout));
      assert(recordSentinelOperatingConstraints(path, {
        runId: state.plan.runId!,
        evidenceRevision: state.revision,
        expectedVersion: 0,
        requestId: crypto.randomUUID(),
        operatorScope: "analyst-fixture",
        constraints: { deniedKinds: [], allowedAssetIds: ["other"] },
      }));
      releasePlan.resolve();
      await secondReturned.promise;
      assertStringIncludes(
        await send({ ...exactRead, hintId: secondId }),
        "unavailable",
      );
    });
    let superseded = false;
    for (let tries = 0; tries < 100 && !superseded; tries++) {
      superseded =
        readAdaptiveSentinel(path, state)?.modelPlannerHistory.some((attempt) =>
          attempt.inputManifest?.hintIds.includes(secondId) &&
          attempt.outcome === "superseded"
        ) === true;
      if (!superseded) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(superseded);
    const afterRevocation = readAdaptiveSentinel(path, state);
    assert(
      !afterRevocation?.tasks.some(({ plannerRound }) =>
        plannerRound?.hintId === secondId
      ),
    );
  } finally {
    releasePlan.resolve();
    coordinator.stop();
    planner.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
