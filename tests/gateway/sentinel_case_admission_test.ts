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
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import { startSentinelCaseManager } from "../../src/gateway/sentinel_case_manager.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { needsSentinelAssessmentCoordinator } from "../../src/sentinel/assessment_store.ts";
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
        last?.role === "tool"
          ? { content: String(last.content), toolCalls: [], usage }
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
  const hookRunner: HookRunner = {
    evaluateHook(hook) {
      calls.push(hook);
      return Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const admissions: string[] = [];
  const evaluations = new Set<string>();
  let managerClock = 0;
  function manager() {
    return startSentinelCaseManager(baseDir, (path, id) => {
      admissions.push(id);
      return startSentinelAssessmentCoordinator({
        snapshotPath: path,
        advanceAdaptive: () => {
          evaluations.add(id);
        },
      });
    }, {
      concurrency: 1,
      intervalMs: 300_000,
      now: () => managerClock,
      isActiveCase: needsSentinelAssessmentCoordinator,
    });
  }
  async function withGateway(
    test: (
      turn: (action: string, id: string, revision?: number) => Promise<string>,
      caseManager: ReturnType<typeof manager>,
    ) => Promise<void>,
  ) {
    const caseManager = manager();
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
          confirm: () => Promise.resolve(true),
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
            content: JSON.stringify({
              action,
              kind: "sentinel",
              id,
              revision,
            }),
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
      await gateway.stop();
    }
  }
  try {
    for (const id of ["a-youngest", "m-middle", "z-oldest"]) {
      const path = resolveSentinelCasePath(baseDir, id);
      await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: [{ id: "asset", kind: "asset", label: id }],
          edges: [],
        }),
      );
    }
    await withGateway(async (turn, caseManager) => {
      for (const id of ["z-oldest", "m-middle", "a-youngest"]) {
        assertEquals(JSON.parse(await turn("start", id)).run.status, "running");
      }
      caseManager.refresh();
      await Promise.resolve();
      assertEquals(admissions, ["z-oldest"]);
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
