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
  createCronManager,
  createSchedulerService,
  type OrchestratorFactory,
} from "../../src/scheduler/mod.ts";
import { tickCronJobs } from "../../src/scheduler/service_cron.ts";
import { schedulerExecutionIdentity } from "../../src/scheduler/service_execution.ts";

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
