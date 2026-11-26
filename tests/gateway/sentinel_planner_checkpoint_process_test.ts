import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { AgentTurnCheckpoint } from "../../src/core/types/orchestrator.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  createSentinelSubagent,
  type SentinelReadTrace,
} from "../../src/gateway/sentinel_agent.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  readSentinelAssessment,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { listSentinelPlannerGraphFacts } from "../../src/sentinel/worker_graph_facts.ts";

const readFact = "sentinel_graph_facts";
const relationship = { from: "record", relation: "supports", to: "finding" };
const usage = { inputTokens: 1, outputTokens: 1 };
const database = (path: string) => join(dirname(path), "sentinel-adaptive.db");
const allow: HookRunner = {
  evaluateHook: () =>
    Promise.resolve({
      allowed: true,
      action: "ALLOW",
      ruleId: null,
      duration: 0,
    }),
};

function model(
  complete: Parameters<
    ReturnType<typeof createProviderRegistry>["register"]
  >[0]["complete"],
) {
  const registry = createProviderRegistry();
  registry.register({
    name: "checkpoint-fixture",
    supportsStreaming: false,
    complete,
  });
  registry.setDefault("checkpoint-fixture");
  return registry;
}

function call(name: string, args: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

async function waitFor(
  description: string,
  condition: () => boolean | Promise<boolean>,
) {
  const deadline = Date.now() + 8_000;
  while (!await condition()) {
    assert(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function exists(path: string) {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return false;
  }
}

async function writeGraph(path: string, label: string) {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      version: 1,
      nodes: [
        { id: "app", kind: "asset", label: "Assigned asset" },
        { id: "record", kind: "evidence", label },
        {
          id: "finding",
          kind: "finding",
          label: "Local finding",
          severity: "low",
        },
      ],
      edges: [
        relationship,
        { from: "record", to: "app", relation: "observed_on" },
        { from: "finding", to: "app", relation: "affects" },
      ],
    }),
  );
}

async function publishFact(
  base: string,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
) {
  const path = resolveSentinelCasePath(base);
  const revision = adaptiveRevision(state);
  advanceAdaptiveSentinel(path, state);
  const store = openSentinelAdaptiveStore(database(path));
  try {
    store.sync(revision, [{
      kind: "impact",
      depth: 7,
      nodeId: "app",
      reason: MODEL_ASSIGNMENT_REASON,
    }], revision);
    advanceAdaptiveSentinel(path, state);
    const lease = store.claimModelReview(
      revision,
      MODEL_ASSIGNMENT_REASON,
      ({ kind, nodeId, depth }) =>
        kind === "impact" && nodeId === "app" && depth === 7,
    );
    assert(lease);
    const source = createSentinelSubagent({
      snapshotPath: path,
      assessmentRevision: state.revision,
      assignedTaskId: lease.task.id,
      assignedTaskLeaseToken: lease.token,
      providerRegistry: model((messages) => {
        const count = messages.filter(({ role }) => role === "tool").length;
        const toolCalls = count === 0
          ? [call("sentinel_assigned_target", {})]
          : count === 1
          ? [call("sentinel_publish_graph_fact", {
            ...relationship,
            requestId: crypto.randomUUID(),
          })]
          : [];
        return Promise.resolve({
          usage,
          toolCalls,
          content: toolCalls.length
            ? ""
            : '{"summary":"Reviewed the relationship.","followUps":[]}',
        });
      }),
      hookRunner: allow,
      allowModelAccess: true,
    });
    const steps: SentinelReadTrace[] = [];
    try {
      await source.execute(
        "Record the exact assigned relationship.",
        () => {},
        undefined,
        (step) => steps.push(step),
        true,
      );
    } finally {
      source.clear();
    }
    assert(store.finishModelReview(revision, lease.task.id, lease.token, {
      note: "Reviewed the relationship.",
      steps,
    }));
    assert(state.plan.runId);
    const [fact] = listSentinelPlannerGraphFacts(path, {
      caseId: "main",
      runId: state.plan.runId,
      evidenceRevision: state.revision,
    });
    assert(fact);
    return fact;
  } finally {
    store.close();
  }
}

async function runGateway(
  base: string,
  mode: string,
  clock: number,
  factId: string,
) {
  const path = resolveSentinelCasePath(base);
  const state = readSentinelAssessment(path);
  assert(state?.active);
  const marker = (name: string) => join(base, name);
  const append = (name: string, text: string) =>
    Deno.writeTextFileSync(marker(name), text + "\n", {
      append: true,
      create: true,
    });
  const registry = model(async (messages) => {
    const history = messages as AgentTurnCheckpoint["history"];
    const results = history.filter(({ role }) => role === "tool");
    if (mode === "denied") {
      append("unauthorized-model", "called");
      throw new Error("Denied checkpoint reached the provider");
    }
    if (!results.length) {
      assert(
        mode === "interrupt" || mode === "fresh",
        "The exact checkpoint repeated its calls",
      );
      append("requests", mode);
      return {
        usage,
        content: "",
        toolCalls: [
          call(readFact, { id: factId }),
          call(readFact, { id: factId }),
        ],
      };
    }
    const batch = history.filter(({ role, tool_calls }) =>
      role === "assistant" && !!tool_calls?.length
    );
    assertEquals(batch.length, 1);
    assertEquals(
      batch[0].tool_calls?.map((value) => (value as { id: string }).id),
      results.map(({ tool_call_id }) => tool_call_id),
    );
    const payloads = results.map(({ content }) => String(content));
    assertEquals(payloads.map((content) => JSON.parse(content).id), [
      factId,
      factId,
    ]);
    await Deno.writeTextFile(
      marker(mode + "-results"),
      JSON.stringify(payloads),
    );
    if (mode === "interrupt") return await new Promise<never>(() => {});
    return {
      usage,
      content: JSON.stringify({
        assignments: [{
          kind: "trace",
          nodeId: "app",
          depth: 1,
          graphFactId: factId,
        }],
        prioritize: [],
      }),
      toolCalls: [],
    };
  });
  const app = createGatewayServer({
    port: 0,
    token: crypto.randomUUID(),
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "planner-process-fixture" as ChannelId,
      }),
      providerRegistry: registry,
      hookRunner: allow,
    }),
  });
  const planner = createSentinelModelPlanner(
    path,
    (current, assignment) => {
      if (assignment) return { execute: () => Promise.resolve(), clear() {} };
      const agent = createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: current.revision,
        plannerExecutionEvidenceRunId: current.plan.runId,
        providerRegistry: registry,
        allowModelAccess: true,
        hookRunner: {
          evaluateHook(hook, context) {
            const { input } = context;
            const name = input.tool_name ??
              (input.tool_call as { name?: string } | undefined)?.name;
            if (name !== readFact) {
              return allow.evaluateHook(hook, context);
            }
            if (hook === "PRE_TOOL_CALL" || hook === "POST_TOOL_RESPONSE") {
              append("hooks", mode + ":" + hook);
            }
            const allowed = !(mode === "denied" && hook === "PRE_TOOL_CALL");
            return Promise.resolve({
              allowed,
              action: allowed ? "ALLOW" : "BLOCK",
              ruleId: null,
              duration: 0,
            });
          },
        },
      });
      return {
        ...agent,
        execute(prompt, send, signal, trace, access, options) {
          return agent.execute(
            prompt,
            send,
            signal,
            (step) => {
              if (step.tool === readFact) append("dispatches", mode);
              trace?.(step);
            },
            access,
            options,
          );
        },
      };
    },
    undefined,
    () => clock,
  );
  await app.start();
  const coordinator = startSentinelAssessmentCoordinator({
    snapshotPath: path,
    advanceAdaptive(current) {
      advanceAdaptiveSentinel(path, current);
      planner.advance(current);
    },
    stopAdaptive: () => planner.stop(),
  });
  try {
    if (mode === "interrupt") return await new Promise<never>(() => {});
    await waitFor("The restarted planner did not settle.", () => {
      const store = openSentinelAdaptiveStore(database(path));
      try {
        const attempt = store.modelPlanHistory(adaptiveRevision(state), true)
          .at(-1);
        if (mode === "denied") {
          return attempt?.attempt === 2 && attempt.outcome === "failed";
        }
        return attempt?.outcome === "completed" &&
          readAdaptiveSentinel(path, state, "revision")?.tasks.some(
              ({ plannerRound }) => plannerRound?.graphFactId === factId,
            ) === true;
      } finally {
        store.close();
      }
    });
  } finally {
    coordinator.stop();
    await app.stop();
  }
}

async function copyDirectory(source: string, target: string) {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory) await copyDirectory(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

if (import.meta.main) {
  await runGateway(
    Deno.args[0],
    Deno.args[1],
    Number(Deno.args[2]),
    Deno.args[3],
  );
} else {
  Deno.test({
    name:
      "A killed gateway restores a native planner batch, checks source policy, and fences a newer revision",
    ignore: Deno.build.os === "windows",
    async fn() {
      const temp = await Deno.makeTempDir();
      const base = join(temp, "original");
      const path = resolveSentinelCasePath(base);
      const time = Date.now();
      let child: Deno.ChildProcess | undefined;
      const launch = (
        dir: string,
        mode: string,
        clock: number,
        factId: string,
      ) =>
        new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            fromFileUrl(import.meta.url),
            dir,
            mode,
            String(clock),
            factId,
          ],
          stdout: "null",
          stderr: "piped",
          signal: AbortSignal.timeout(20_000),
        }).spawn();
      const prove = async (dir: string, mode: string, factId: string) => {
        const result = await launch(dir, mode, time + 240_000, factId).output();
        assert(result.success, new TextDecoder().decode(result.stderr));
      };
      try {
        await writeGraph(path, "Original saved checkpoint evidence");
        const state = startSentinelAssessment(path);
        const fact = await publishFact(base, state);
        child = launch(base, "interrupt", time, fact.id);
        await waitFor(
          "The first gateway did not save the complete planner batch.",
          () => exists(join(base, "interrupt-results")),
        );
        child.kill("SIGKILL");
        assert(!(await child.status).success);
        await child.stderr.cancel();
        child = undefined;
        const db = new DatabaseSync(database(path), { readOnly: true });
        try {
          const checkpoint = String(
            db.prepare("SELECT projection FROM adaptive_model_read_checkpoints")
              .get()?.projection,
          );
          assertEquals(JSON.parse(checkpoint).batchSizes, [2]);
          assert(!checkpoint.includes("Original saved checkpoint evidence"));
          assert(!checkpoint.includes('"relationship"'));
        } finally {
          db.close();
        }

        const denied = join(temp, "denied");
        const advanced = join(temp, "advanced");
        await copyDirectory(base, denied);
        await copyDirectory(base, advanced);

        await prove(base, "resume", fact.id);
        assertEquals(
          await Deno.readTextFile(join(base, "resume-results")),
          await Deno.readTextFile(join(base, "interrupt-results")),
        );
        assertEquals(
          await Deno.readTextFile(join(base, "dispatches")),
          "interrupt\ninterrupt\n",
        );
        const renewedHooks = (await Deno.readTextFile(join(base, "hooks")))
          .split("\n").filter((line) => line.startsWith("resume:"));
        assertEquals(renewedHooks, [
          "resume:PRE_TOOL_CALL",
          "resume:PRE_TOOL_CALL",
          "resume:POST_TOOL_RESPONSE",
          "resume:POST_TOOL_RESPONSE",
        ]);

        await prove(denied, "denied", fact.id);
        await assertRejects(
          () => Deno.stat(join(denied, "unauthorized-model")),
          Deno.errors.NotFound,
        );
        assertEquals(
          await Deno.readTextFile(join(denied, "dispatches")),
          "interrupt\ninterrupt\n",
        );

        const advancedPath = resolveSentinelCasePath(advanced);
        await writeGraph(advancedPath, "New committed evidence revision");
        const next = refreshSentinelAssessment(advancedPath);
        assert(next && next.revision > state.revision);
        const nextFact = await publishFact(advanced, next);
        assert(nextFact.id !== fact.id);
        await prove(advanced, "fresh", nextFact.id);
        assertEquals(
          await Deno.readTextFile(join(advanced, "requests")),
          "interrupt\nfresh\n",
        );
        assertEquals(
          await Deno.readTextFile(join(advanced, "dispatches")),
          "interrupt\ninterrupt\nfresh\nfresh\n",
        );
        const projected = await Deno.readTextFile(
          join(advanced, "fresh-results"),
        );
        assert(!projected.includes(fact.id));
        assert(projected.includes(nextFact.id));
      } finally {
        if (child) {
          try {
            child.kill("SIGKILL");
          } finally {
            await child.status;
            await child.stderr.cancel();
          }
        }
        await Deno.remove(temp, { recursive: true });
      }
    },
  });
}
