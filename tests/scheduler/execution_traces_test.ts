import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import {
  type ExecutionTraceRun,
  openExecutionTraces,
} from "../../src/core/execution_traces.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import type { ToolExecutor } from "../../src/core/types/tool.ts";
import {
  computeTimestampedHmac,
  createCronManager,
  createSchedulerService,
  type OrchestratorFactory,
} from "../../src/scheduler/mod.ts";
import { tickCronJobs } from "../../src/scheduler/service_cron.ts";
import { schedulerExecutionIdentity } from "../../src/scheduler/service_execution.ts";

function traceFixture(argsText: string, resultText: string) {
  const sessions = new Map<string, string>();
  const actualDispatches: string[] = [];
  const factory: OrchestratorFactory = {
    create(channelId, options) {
      assertEquals(options?.ceiling, "INTERNAL");
      const session = createSession({
        userId: "scheduled-fixture" as UserId,
        channelId: channelId as ChannelId,
      });
      sessions.set(channelId, session.id);
      const providers = createProviderRegistry();
      providers.register({
        name: "trace-scheduled-fixture",
        supportsStreaming: false,
        complete(messages) {
          const usage = { inputTokens: 1, outputTokens: 1 };
          if (messages.at(-1)?.role === "tool") {
            return Promise.resolve({
              content: "The scheduled fixture completed.",
              usage,
              toolCalls: [],
            });
          }
          return Promise.resolve({
            content: "",
            usage,
            toolCalls: ["fixture_read", "fixture_denied"].map((name) => ({
              type: "function",
              id: crypto.randomUUID(),
              function: {
                name,
                arguments: JSON.stringify({ marker: argsText }),
              },
            })),
          });
        },
      });
      providers.setDefault("trace-scheduled-fixture");
      const executor: ToolExecutor = (tool, args) => {
        if (tool === "memory_get") return Promise.resolve('{"found":false}');
        if (tool === "memory_save") return Promise.resolve("Saved.");
        actualDispatches.push(tool);
        assertEquals(args.marker, argsText);
        return Promise.resolve(resultText);
      };
      const orchestrator = createOrchestrator({
        providerRegistry: providers,
        hookRunner: {
          evaluateHook(hook, { input }) {
            const denied = hook === "PRE_TOOL_CALL" &&
              (input.tool_call as { name?: string } | undefined)?.name ===
                "fixture_denied";
            return Promise.resolve({
              allowed: !denied,
              action: denied ? "BLOCK" : "ALLOW",
              ruleId: null,
              duration: 0,
            });
          },
        },
        isOwnerSession: () => false,
        getNonOwnerCeiling: () => "INTERNAL",
        toolClassifications: new Map([["fixture_", "INTERNAL"]]),
        enableStreaming: false,
        tools: ["fixture_read", "fixture_denied"].map((name) => ({
          name,
          description: "Scheduled local fixture.",
          parameters: {
            marker: { type: "string", description: "Fixture argument" },
          },
        })),
        toolExecutor: executor,
      });
      return Promise.resolve({
        session,
        toolExecutor: executor,
        getSessionTaint: () => "INTERNAL",
        orchestrator,
      });
    },
  };
  return { factory, sessions, actualDispatches };
}

Deno.test("normal scheduled trigger and cron turns retain only trusted root dispatch metadata", async () => {
  const directory = await Deno.makeTempDir();
  const tracePath = join(directory, "execution-traces.db");
  const triggerMdPath = join(directory, "TRIGGER.md");
  const sourceText = "Private scheduled fixture prompt";
  const argsText = "Private fixture tool arguments";
  const resultText = "Private fixture tool result";
  const cronManager = createCronManager();
  const cron = cronManager.create({
    expression: "* * * * *",
    task: sourceText,
    classificationCeiling: "INTERNAL",
  });
  assert(cron.ok);
  const { factory, sessions, actualDispatches } = traceFixture(
    argsText,
    resultText,
  );
  const config = {
    orchestratorFactory: factory,
    executionTracePath: tracePath,
    cronManager,
    triggerMdPath,
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: "INTERNAL" as const,
    },
    webhooks: { enabled: false, sources: {} },
  };
  const service = createSchedulerService(config);
  try {
    await Deno.writeTextFile(triggerMdPath, sourceText);
    await service.runTrigger();
    const when = new Date(Date.UTC(2026, 3, 21, 12, 0));
    tickCronJobs(config, cronManager, when);
    const journal = openExecutionTraces(tracePath);
    try {
      const deadline = Date.now() + 2000;
      while (
        (journal.listRuns({ role: "scheduled", ceiling: "INTERNAL" })?.runs
            .filter(({ status }) => status === "completed").length ?? 0) < 2 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const runs = journal.listRuns({ role: "scheduled", ceiling: "INTERNAL" })
        ?.runs;
      assertExists(runs);
      assertEquals(runs.length, 2);
      assertEquals(
        journal.listRuns({ role: "scheduled", ceiling: "PUBLIC" })?.runs,
        [],
      );
      for (
        const [channel, sourceId] of [["trigger", "trigger"], [
          "cron",
          cron.value.id,
        ]]
      ) {
        const run: ExecutionTraceRun | undefined = runs.find(({ scope }) =>
          scope.sourceId === sourceId
        );
        assertExists(run);
        assertEquals(run.scope.sessionId, sessions.get(channel));
        assertEquals(run.status, "completed");
        if (channel === "cron") {
          assertEquals(
            run.scope.runId,
            schedulerExecutionIdentity(
              "cron",
              sourceId,
              Math.floor(when.getTime() / 60_000),
            ).id,
          );
        } else {
          assert(/^scheduler-trigger-[a-f0-9]{64}$/.test(run.scope.runId));
        }
        const page = journal.list(run.scope, { ceiling: "INTERNAL" });
        assertExists(page);
        assertEquals(
          page.steps.map(({ ordinal, tool, classification, outcome }) => ({
            ordinal,
            tool,
            classification,
            outcome,
          })),
          [
            {
              ordinal: 1,
              tool: "fixture_read",
              classification: "INTERNAL",
              outcome: "returned",
            },
            {
              ordinal: 2,
              tool: "fixture_denied",
              classification: "INTERNAL",
              outcome: "blocked",
            },
          ],
        );
        for (
          const hidden of [
            sourceText,
            argsText,
            resultText,
            "memory_get",
            "memory_save",
          ]
        ) assert(!JSON.stringify(page).includes(hidden));
      }
      assertEquals(actualDispatches, ["fixture_read", "fixture_read"]);
    } finally {
      journal.close();
    }
  } finally {
    service.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("authenticated webhook traces record only accepted exact scheduler dispatch metadata", async () => {
  const directory = await Deno.makeTempDir();
  const tracePath = join(directory, "execution-traces.db");
  const sourceId = "signed-source";
  const secret = "private webhook binding secret";
  const body = JSON.stringify({ summary: "Private accepted webhook body" });
  const argsText = "Private webhook tool arguments";
  const resultText = "Private webhook tool output";
  const { factory, sessions, actualDispatches } = traceFixture(
    argsText,
    resultText,
  );
  const scheduler = createSchedulerService({
    orchestratorFactory: factory,
    executionTracePath: tracePath,
    triggerMdPath: join(directory, "TRIGGER.md"),
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: "INTERNAL",
    },
    webhooks: {
      enabled: true,
      sources: { [sourceId]: { secret, classification: "INTERNAL" } },
    },
  });
  const journal = openExecutionTraces(tracePath);
  const read = () =>
    journal.listRuns({ role: "scheduled", ceiling: "INTERNAL" })?.runs;
  try {
    const timestamp = String(Date.now());
    const signature = await computeTimestampedHmac(timestamp, body, secret);
    const invalid = await scheduler.handleWebhookRequest(sourceId, body, {
      timestamp,
      signature: await computeTimestampedHmac(
        timestamp,
        body,
        "incorrect fixture key",
      ),
    });
    assert(!invalid.ok);
    assertEquals(read(), []);
    assertEquals(actualDispatches, []);
    assertEquals(sessions.size, 0);
    const accepted = await scheduler.handleWebhookRequest(sourceId, body, {
      timestamp,
      signature,
    });
    assert(accepted.ok);
    assertEquals(Object.hasOwn(accepted, "executionId"), false);
    const runs = read();
    assertExists(runs);
    assertEquals(runs.length, 1);
    const [run] = runs;
    assertEquals(run.scope.role, "scheduled");
    assertEquals(run.scope.sourceId, sourceId);
    assertEquals(run.scope.sessionId, sessions.get(`webhook-${sourceId}`));
    assertEquals(
      run.scope.runId,
      schedulerExecutionIdentity("webhook", sourceId, signature).id,
    );
    assertEquals(run.status, "completed");
    assertEquals(
      journal.listRuns({ role: "scheduled", ceiling: "PUBLIC" })?.runs,
      [],
    );
    const receipt = journal.list(run.scope, { ceiling: "INTERNAL" });
    assertExists(receipt);
    assertEquals(
      receipt.steps.map((
        { tool, outcome, classification },
      ) => [tool, outcome, classification]),
      [
        ["fixture_read", "returned", "INTERNAL"],
        ["fixture_denied", "blocked", "INTERNAL"],
      ],
    );
    const replay = await scheduler.handleWebhookRequest(sourceId, body, {
      timestamp,
      signature,
    });
    assert(!replay.ok);
    assertEquals(read(), runs);
    assertEquals(journal.list(run.scope, { ceiling: "INTERNAL" }), receipt);
    assertEquals(actualDispatches, ["fixture_read"]);
    const persisted = new TextDecoder().decode(await Deno.readFile(tracePath));
    for (
      const hidden of [
        body,
        "Private accepted webhook body",
        secret,
        signature,
        argsText,
        resultText,
      ]
    ) {
      assert(!persisted.includes(hidden));
      assert(!JSON.stringify({ runs, receipt }).includes(hidden));
    }
  } finally {
    journal.close();
    scheduler.stop();
    await Deno.remove(directory, { recursive: true });
  }
});
