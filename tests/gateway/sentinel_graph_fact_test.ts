import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readHistoricalAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  createSentinelSubagent,
  type SentinelReadTrace,
} from "../../src/gateway/sentinel_agent.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { listSentinelPlannerGraphFacts } from "../../src/sentinel/worker_graph_facts.ts";

const assigned = "sentinel_assigned_target";
const publish = "sentinel_publish_graph_fact";
const read = "sentinel_graph_facts";
const call = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  args,
});

type Lease = {
  readonly assessmentRevision: number;
  readonly assignedTaskId: string;
  readonly assignedTaskLeaseToken: string;
};

async function worker(
  snapshotPath: string,
  lease: Lease,
  batches: readonly (readonly ReturnType<typeof call>[])[],
  deny?: "publish" | "assigned",
) {
  const results: string[][] = [];
  const trace: SentinelReadTrace[] = [];
  const hooks: string[] = [];
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input, session, auditInput }) {
      const name = String(
        input.tool_name ??
          (input.tool_call as { name?: string } | undefined)?.name,
      );
      if ([assigned, publish, read].includes(name)) {
        assertEquals(session.taint, "INTERNAL");
        hooks.push(`${hook}:${name}`);
        if (hook === "POST_TOOL_RESPONSE") {
          assert(!Object.hasOwn(auditInput ?? {}, "tool_response"));
          if (
            name !== assigned && typeof input.tool_response === "string" &&
            input.tool_response.startsWith("{")
          ) {
            assertEquals(
              JSON.parse(input.tool_response)._classification,
              "INTERNAL",
            );
          }
        }
      }
      const allowed =
        !(hook === "PRE_TOOL_CALL" && name === publish && deny === "publish") &&
        !(hook === "POST_TOOL_RESPONSE" && name === assigned &&
          deny === "assigned");
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const providerRegistry = createProviderRegistry();
  let iteration = 0;
  providerRegistry.register({
    name: "graph-fact-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      for (const name of [assigned, publish, read]) {
        assert(
          tools?.some((tool) =>
            (tool as { function?: { name?: string } }).function?.name === name
          ),
        );
      }
      if (iteration > 0) {
        const size = batches[iteration - 1].length;
        results.push(
          messages.filter(({ role }) => role === "tool").slice(-size)
            .map(({ content }) => String(content)),
        );
      }
      const batch = batches[iteration++];
      return Promise.resolve({
        usage: { inputTokens: 1, outputTokens: 1 },
        content: batch
          ? ""
          : '{"summary":"Reviewed the published defensively scoped relationship.","followUps":[]}',
        toolCalls: batch?.map(({ name, args }, index) => ({
          id: `graph-fact-${iteration}-${index}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        })) ?? [],
      });
    },
  });
  providerRegistry.setDefault("graph-fact-fixture");
  const agent = createSentinelSubagent({
    snapshotPath,
    providerRegistry,
    hookRunner,
    allowModelAccess: true,
    ...lease,
  });
  try {
    await agent.execute(
      "Read and record the exact assigned relationship.",
      () => {},
      undefined,
      (step) => trace.push(step),
      true,
    );
    assertEquals(results.length, batches.length);
    return { results, trace, hooks };
  } finally {
    agent.clear();
  }
}

Deno.test("Only a post-authorized exact leased graph edge can be published and reopened by a same-target peer", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const relationship = {
    from: "approved-record",
    to: "app",
    relation: "observed_on",
  };
  const foreign = {
    from: "foreign-record",
    to: "other-app",
    relation: "observed_on",
  };
  const raw = JSON.stringify({
    version: 1,
    nodes: [
      { id: "app", kind: "asset", label: "Assigned asset" },
      { id: "other-app", kind: "asset", label: "Different assignment asset" },
      { id: "approved-record", kind: "evidence", label: "Local record" },
      {
        id: "foreign-record",
        kind: "evidence",
        label: "Separate target record",
      },
    ],
    edges: [relationship, foreign],
  });
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, raw);
    const state = startSentinelAssessment(path);
    assert(state.plan.runId);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const assignedLease = (kind: "impact" | "trace", nodeId: string): Lease => {
      const lease = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.kind === kind && task.nodeId === nodeId,
      );
      assert(lease);
      return {
        assessmentRevision: state.revision,
        assignedTaskId: lease.task.id,
        assignedTaskLeaseToken: lease.token,
      };
    };
    try {
      store.sync(revision, [
        { kind: "impact", nodeId: "app", reason: MODEL_ASSIGNMENT_REASON },
        {
          kind: "trace",
          nodeId: "app",
          depth: 1,
          reason: MODEL_ASSIGNMENT_REASON,
        },
        {
          kind: "impact",
          nodeId: "other-app",
          reason: MODEL_ASSIGNMENT_REASON,
        },
      ], revision);
      advanceAdaptiveSentinel(path, state);
      const producer = assignedLease("impact", "app");
      const peer = assignedLease("trace", "app");
      const other = assignedLease("impact", "other-app");
      const args = { ...relationship, requestId: crypto.randomUUID() };
      const scope = {
        caseId: "main",
        runId: state.plan.runId,
        evidenceRevision: state.revision,
      };
      const deniedRead = await worker(path, producer, [
        [call(assigned)],
        [call(publish, args)],
      ], "assigned");
      assertEquals(
        deniedRead.results[0][0],
        "Tool response withheld by policy.",
      );
      assertStringIncludes(deniedRead.results[1][0], "unavailable");
      assertEquals(listSentinelPlannerGraphFacts(path, scope), []);

      const deniedPublish = await worker(path, producer, [
        [call(assigned)],
        [call(publish, args)],
      ], "publish");
      assert(deniedPublish.hooks.includes(`PRE_TOOL_CALL:${publish}`));
      assert(!deniedPublish.hooks.includes(`POST_TOOL_RESPONSE:${publish}`));
      assertEquals(listSentinelPlannerGraphFacts(path, scope), []);

      const produced = await worker(path, producer, [
        [call(publish, args)],
        [call(assigned)],
        [
          call(publish, { ...foreign, requestId: crypto.randomUUID() }),
          call(publish, { ...args, from: "app", to: "approved-record" }),
          call(publish, args),
          call(publish, args),
        ],
      ]);
      assertStringIncludes(produced.results[0][0], "unavailable");
      assertEquals(JSON.parse(produced.results[1][0]).relationships, [
        relationship,
      ]);
      const [outside, forged, committed, duplicate] = produced.results[2];
      assertStringIncludes(outside, "unavailable");
      assertStringIncludes(forged, "unavailable");
      const { _classification, ...fact } = JSON.parse(committed);
      assertEquals(_classification, "INTERNAL");
      assertEquals(JSON.parse(duplicate), JSON.parse(committed));
      assertEquals(fact.relationship, relationship);
      assertEquals(fact.taskId, producer.assignedTaskId);
      assertEquals(fact.sourceTool, assigned);
      const source = produced.trace.at(fact.sourceStepIndex);
      assertEquals(source?.tool, assigned);
      assertEquals(source?.resultSha256, fact.resultSha256);
      assertEquals(listSentinelPlannerGraphFacts(path, scope), [fact]);
      assert(!store.modelReviewNotes(revision).length);

      const readByPeer = await worker(path, peer, [[
        call(read),
        call(read, { id: fact.id }),
      ]]);
      assertEquals(JSON.parse(readByPeer.results[0][0]).facts, [fact]);
      assertEquals(JSON.parse(readByPeer.results[0][1]), {
        _classification: "INTERNAL",
        ...fact,
      });
      const blockedPeer = await worker(path, other, [[
        call(read),
        call(read, { id: fact.id }),
      ]]);
      assertEquals(JSON.parse(blockedPeer.results[0][0]).facts, []);
      assertStringIncludes(blockedPeer.results[0][1], "unavailable");
      assertEquals(await Deno.readTextFile(path), raw);
      const observed = Promise.withResolvers<unknown>();
      const planner = createSentinelModelPlanner(path, (_case, assignment) => ({
        execute(prompt, send) {
          if (!assignment) {
            observed.resolve(
              JSON.parse(String(prompt).split("\n").at(-1)!).graphFacts,
            );
            send({
              type: "response",
              text: JSON.stringify([
                { kind: "trace", nodeId: "other-app", graphFactId: fact.id },
                { kind: "trace", nodeId: "app", graphFactId: fact.id },
              ]),
              taint: "INTERNAL",
            });
          }
          return Promise.resolve();
        },
        clear() {},
      }));
      try {
        planner.advance(state);
        const deadline = setTimeout(
          () =>
            observed.reject(
              new Error("Planner did not receive the committed graph fact"),
            ),
          2000,
        );
        try {
          assertEquals(await observed.promise, [{
            id: fact.id,
            targetId: "app",
            taskId: fact.taskId,
            relationship,
            resultSha256: fact.resultSha256,
          }]);
        } finally {
          clearTimeout(deadline);
        }
        assertEquals(
          store.modelPlanHistory(revision, true).at(-1)?.inputManifest
            ?.graphFactIds,
          [fact.id],
        );
        const expires = Date.now() + 2000;
        while (
          !store.list(revision).some((task) =>
            task.plannerRound?.graphFactId
          ) && Date.now() < expires
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const cited = store.list(revision).filter((task) =>
          task.plannerRound?.graphFactId
        );
        assertEquals(
          cited.map(({ nodeId, prerequisites, plannerRound }) => ({
            nodeId,
            prerequisites,
            factId: plannerRound?.graphFactId,
          })),
          [{
            nodeId: "app",
            prerequisites: [producer.assignedTaskId],
            factId: fact.id,
          }],
        );
        const historical = readHistoricalAdaptiveSentinel(path, state.revision);
        assert(historical);
        assertEquals(historical.modelPlanner?.status, "completed");
        const provenance = buildSentinelProvenance(state.result, historical)
          .snapshot();
        const factNode = provenance.nodes.find((node) =>
          node.sourceId === fact.id
        );
        assert(factNode && "graphFact" in factNode);
        const assignmentNode = provenance.nodes.find((node) =>
          node.sourceId === cited[0].id
        );
        assert(assignmentNode);
        assert(
          provenance.edges.some(({ from, to, relation }) =>
            from === assignmentNode.id && to === factNode.id &&
            relation === "references"
          ),
        );
      } finally {
        planner.stop();
      }
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
