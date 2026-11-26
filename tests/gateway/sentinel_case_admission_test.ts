import { readSentinelAdmissionSettings } from "../../src/gateway/sentinel_admission_settings.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { enforceConfig } from "../../src/core/config.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { bindSentinelCaseAdmission } from "../../src/gateway/sentinel_case_admission.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import { startSentinelCaseManager } from "../../src/gateway/sentinel_case_manager.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  needsSentinelAssessmentCoordinator,
  readSentinelAssessment,
  readSentinelAssessmentAdmission,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

Deno.test("An owner gateway's named Sentinel cases keep FIFO admission across restart", async () => {
  const baseDir = await Deno.makeTempDir();
  const session = createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  });
  const registry = createProviderRegistry();
  registry.register({
    name: "case-admission-fixture",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      const usage = { inputTokens: 1, outputTokens: 1 };
      return Promise.resolve(
        (last?.role === "tool" || !String(last?.content).startsWith("{"))
          ? { content: "Fixture turn finished.", toolCalls: [], usage }
          : {
            content: "",
            toolCalls: [{
              type: "function",
              id: crypto.randomUUID(),
              function: {
                name: "operator_runs",
                arguments: String(last?.content),
              },
            }],
            usage,
          },
      );
    },
  });
  registry.setDefault("case-admission-fixture");
  const calls: string[] = [];
  let allowControl = true;
  let revokeOnReview = false;
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input }) {
      calls.push(hook);
      const allowed = allowControl || hook !== "PRE_TOOL_CALL" ||
        !input.tool_call;
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const admissions: string[] = [];
  const awaitingYield = new Set<string>();
  const evaluations = new Set<string>();
  let managerClock = 0;
  function manager() {
    return startSentinelCaseManager(baseDir, (path, id) => {
      admissions.push(id);
      const coordinator = startSentinelAssessmentCoordinator({
        snapshotPath: path,
        advanceAdaptive: (state) => {
          evaluations.add(id);
          advanceAdaptiveSentinel(path, state);
        },
      });
      return {
        stop: coordinator.stop,
        canYield: () =>
          !awaitingYield.has(id) && !coordinator.hasInFlightWork(),
      };
    }, {
      concurrency: 1,
      readConcurrency: () =>
        readSentinelAdmissionSettings(baseDir, 1).effectiveLimit,
      intervalMs: 300_000,
      now: () => managerClock,
      isActiveCase: needsSentinelAssessmentCoordinator,
    });
  }
  async function withGateway(
    test: (
      turn: (
        action: string | Record<string, unknown>,
        id?: string,
        revision?: number,
      ) => Promise<string>,
      caseManager: ReturnType<typeof manager>,
    ) => Promise<void>,
  ) {
    const caseManager = manager();
    const releaseAdmission = bindSentinelCaseAdmission(
      baseDir,
      caseManager.isAdmitted,
    );
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session,
        providerRegistry: registry,
        targetClassification: "INTERNAL",
        hookRunner,
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          sentinelAdmission: {
            configuredLimit: 1,
            onChanged: caseManager.refresh,
          },
          confirm() {
            if (revokeOnReview) allowControl = false;
            return Promise.resolve(true);
          },
        }),
      }),
    });
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      await test(async (action, id, revision) => {
        const done = Promise.withResolvers<string>();
        let result = "";
        function receive({ data }: MessageEvent) {
          const event = JSON.parse(data);
          if (event.type === "tool_result") result = event.result;
          if (event.type === "turn_end") done.resolve(result);
        }
        const timer = setTimeout(
          () => done.reject(new Error("Missing gateway admission response")),
          3000,
        );
        socket.addEventListener("message", receive);
        try {
          socket.send(JSON.stringify({
            type: "message",
            content: JSON.stringify(
              typeof action === "string"
                ? { action, kind: "sentinel", id, revision }
                : action,
            ),
          }));
          return await done.promise;
        } finally {
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
        }
      }, caseManager);
    } finally {
      socket.close();
      caseManager.stop();
      try {
        await gateway.stop();
      } finally {
        releaseAdmission();
      }
    }
  }
  function completed(id: string): number {
    const path = resolveSentinelCasePath(baseDir, id);
    const state = readSentinelAssessment(path);
    return (state && readAdaptiveSentinel(path, state, "revision")?.tasks
      .filter(({ status }) => status === "completed").length) ?? 0;
  }
  try {
    for (const id of ["a-youngest", "m-middle", "z-oldest"]) {
      const path = resolveSentinelCasePath(baseDir, id);
      await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: [
            { id: "asset", kind: "asset", label: id },
            {
              id: "finding",
              kind: "finding",
              label: "Missing control",
              severity: "high",
            },
          ],
          edges: [{ from: "finding", relation: "affects", to: "asset" }],
        }),
      );
    }
    await withGateway(async (turn, caseManager) => {
      for (const id of ["z-oldest", "m-middle", "a-youngest"]) {
        assertEquals(JSON.parse(await turn("start", id)).run.status, "running");
      }
      for (const id of ["z-oldest", "m-middle", "a-youngest"]) {
        assertEquals(completed(id), 0);
      }
      caseManager.refresh();
      await Promise.resolve();
      assertEquals(admissions, ["z-oldest"]);
      assert(completed("z-oldest") > 0);
      assertEquals(completed("m-middle"), 0);
      assertEquals(completed("a-youngest"), 0);
      assertEquals([...evaluations], ["z-oldest"]);
      assertEquals(caseManager.coordinatorState("m-middle"), "waiting");
      assertEquals(caseManager.coordinatorState("a-youngest"), "waiting");
      managerClock += 120_001;
      caseManager.refresh();
      assertEquals(admissions, ["z-oldest"]);
    });
    await withGateway(async (turn, caseManager) => {
      assertEquals(admissions, ["z-oldest", "z-oldest"]);
      assertEquals(caseManager.coordinatorState("m-middle"), "waiting");

      // A pause and resume can both occur before the next coordinator scan.
      assertEquals(
        JSON.parse(await turn("pause", "z-oldest", 1)).run.status,
        "paused",
      );
      assertEquals(
        JSON.parse(await turn("resume", "z-oldest", 1)).run.status,
        "running",
      );
      caseManager.refresh();
      await Promise.resolve();
      assertEquals(admissions.at(-1), "m-middle");
      assertEquals(caseManager.coordinatorState("z-oldest"), "waiting");
      assertEquals([...evaluations], ["z-oldest", "m-middle"]);
      assert(completed("m-middle") > 0);
      assertEquals(completed("a-youngest"), 0);

      assertEquals(
        JSON.parse(await turn("pause", "m-middle", 1)).run.status,
        "paused",
      );
      caseManager.refresh();
      await Promise.resolve();
      assertEquals(admissions.at(-1), "a-youngest");
      assertEquals(caseManager.coordinatorState("z-oldest"), "waiting");
      assertEquals([...evaluations], ["z-oldest", "m-middle", "a-youngest"]);
    });
    await withGateway((_turn, caseManager) => {
      assertEquals(admissions.at(-1), "a-youngest");
      assertEquals(caseManager.coordinatorState("z-oldest"), "waiting");
      return Promise.resolve();
    });
    await withGateway(async (turn, caseManager) => {
      const raise = {
        action: "set_assessment_concurrency",
        requestId: crypto.randomUUID(),
        expectedVersion: 0,
        limit: 2,
      };
      assert((await turn({ ...raise, limit: 13 })).startsWith("Error:"));
      allowControl = false;
      assert((await turn(raise)).includes("blocked"));
      allowControl = true;
      const initial = await turn({ action: "assessment_concurrency" });
      assert(!initial.startsWith("Error:"), initial);
      assertEquals(JSON.parse(initial).version, 0);
      const admissionHistory = [...admissions];
      revokeOnReview = true;
      try {
        assertStringIncludes(await turn(raise), "unavailable");
      } finally {
        revokeOnReview = false;
        allowControl = true;
      }
      assertEquals(await turn({ action: "assessment_concurrency" }), initial);
      assertEquals(admissions, admissionHistory);
      assertEquals(caseManager.coordinatorState("z-oldest"), "waiting");
      const increased = JSON.parse(await turn(raise));
      assertEquals(increased.edit.override, 2);
      assertEquals(caseManager.coordinatorState("z-oldest"), "scheduled");
      assertEquals(JSON.parse(await turn(raise)), increased);
      assert((await turn({ ...raise, limit: 3 })).startsWith("Error:"));
    });
    await withGateway(async (turn, caseManager) => {
      assertEquals(caseManager.coordinatorState("a-youngest"), "scheduled");
      assertEquals(caseManager.coordinatorState("z-oldest"), "scheduled");
      const path = resolveSentinelCasePath(baseDir, "z-oldest");
      const admitted = readSentinelAssessmentAdmission(path);
      assert(admitted !== undefined);
      awaitingYield.add("z-oldest");
      const lower = {
        action: "set_assessment_concurrency",
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        limit: 1,
      };
      assertEquals(JSON.parse(await turn(lower)).edit.override, 1);
      assert(caseManager.isAdmitted("z-oldest", admitted));
      assert(!caseManager.mayStartWork("z-oldest"));
      awaitingYield.delete("z-oldest");
      caseManager.refresh();
      assertEquals(caseManager.coordinatorState("z-oldest"), "waiting");
      assertEquals(readSentinelAssessment(path)?.active, true);
      assertEquals(readSentinelAssessmentAdmission(path), admitted);
      const reset = {
        action: "reset_assessment_concurrency",
        requestId: crypto.randomUUID(),
        expectedVersion: 2,
      };
      const beforeReset = await turn({ action: "assessment_concurrency" });
      const admissionHistory = [...admissions];
      revokeOnReview = true;
      try {
        assertStringIncludes(await turn(reset), "unavailable");
      } finally {
        revokeOnReview = false;
        allowControl = true;
      }
      assertEquals(
        await turn({ action: "assessment_concurrency" }),
        beforeReset,
      );
      assertEquals(admissions, admissionHistory);
      const cleared = JSON.parse(await turn(reset));
      assertEquals(cleared.edit.override, null);
      assertEquals(JSON.parse(await turn(reset)), cleared);
    });
    await withGateway(async (turn, caseManager) => {
      assertEquals(
        JSON.parse(await turn({ action: "assessment_concurrency" }))
          .effectiveLimit,
        1,
      );
      assertEquals(caseManager.coordinatorState("a-youngest"), "scheduled");
      assertEquals(caseManager.coordinatorState("z-oldest"), "waiting");
    });
    for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE", "PRE_OUTPUT"]) {
      assertEquals(calls.includes(hook), true);
    }
    // Validation fails closed without coupling admission and worker capacity.
    const config = { models: { primary: "fixture" } };
    const bad = enforceConfig({
      ...config,
      sentinel: { assessment_concurrency: 13 },
    });
    assert(!bad.ok);
    assertStringIncludes(bad.error, "assessment_concurrency");
    assert(
      enforceConfig({
        ...config,
        sentinel: { assessment_concurrency: 1, model_worker_limit: 4 },
      }).ok,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
