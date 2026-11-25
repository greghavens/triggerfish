import { assert, assertEquals, assertExists } from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { executeOperatorEvidenceDigest } from "../../src/gateway/operator_evidence_digests.ts";
import {
  createSentinelAgent,
  createSentinelSubagent,
  type SentinelAgentOptions,
} from "../../src/gateway/sentinel_agent.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

const list = "sentinel_list_evidence_digests";
const expand = "sentinel_expand_evidence_digest";

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

async function run(
  options: Omit<
    SentinelAgentOptions,
    "providerRegistry" | "hookRunner" | "allowModelAccess"
  >,
  interactive: boolean,
  calls: readonly Call[],
) {
  const offered = new Set<string>();
  const frames: string[] = [];
  const hooks: {
    phase: string;
    input: Record<string, unknown>;
    audit?: Record<string, unknown>;
  }[] = [];
  const registry = createProviderRegistry();
  let invoked = false;
  registry.register({
    name: "model-digest-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      for (const item of tools) {
        const name = (item as { function?: { name?: string } }).function?.name;
        if (name) offered.add(name);
      }
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (!invoked && calls.length) {
        invoked = true;
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: calls.map(({ name, args }) => ({
            id: crypto.randomUUID(),
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          })),
        });
      }
      frames.push(
        ...messages.filter(({ role }) => role === "tool").map(({ content }) =>
          String(content)
        ),
      );
      return Promise.resolve({
        content: "The archived evidence check finished.",
        usage,
        toolCalls: [],
      });
    },
  });
  registry.setDefault("model-digest-fixture");
  const agent = (interactive ? createSentinelAgent : createSentinelSubagent)({
    ...options,
    providerRegistry: registry,
    allowModelAccess: true,
    hookRunner: {
      evaluateHook(phase, { input, auditInput, session }) {
        const name = input.tool_name ??
          (input.tool_call as { name?: string } | undefined)?.name;
        if (name === list || name === expand) {
          assertEquals(session.taint, "INTERNAL");
          hooks.push({ phase, input, audit: auditInput });
        }
        return Promise.resolve({
          allowed: true,
          action: "ALLOW",
          duration: 0,
          ruleId: null,
        });
      },
    },
  });
  try {
    await agent.execute("Read the saved digest members.", () => {});
    return { offered, frames, hooks };
  } finally {
    agent.clear();
  }
}

Deno.test("Sentinel interactive and planner tools read exact saved evidence digests while leased workers have none", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "digest-model";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const graph = {
    version: 1,
    nodes: [
      { id: "app", kind: "asset", label: "Assigned app" },
      { id: "prior", kind: "evidence", label: "Archived digest member" },
      { id: "prior-second", kind: "evidence", label: "Second archived member" },
    ],
    edges: [{ from: "prior", to: "app", relation: "observed_on" }],
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(path, JSON.stringify(graph), { mode: 0o600 });
    const state = startSentinelAssessment(path);
    const ref = {
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
    } as const;
    const receipt = await executeOperatorEvidenceDigest(baseDir, ref, {
      action: "save_digest",
      ...ref,
      nodeKind: "evidence",
    }, () => Promise.resolve(true));
    assert(typeof receipt !== "string");
    const digest = receipt.digest as { id: string };
    assert(digest?.id);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...graph,
        nodes: [
          ...graph.nodes,
          { id: "newer", kind: "evidence", label: "Current only" },
        ],
      }),
    );
    const newer = refreshSentinelAssessment(path);
    assert(newer && newer.revision > state.revision);
    const calls = [
      { name: list, args: { revision: state.revision, limit: 1 } },
      {
        name: expand,
        args: { revision: state.revision, digestId: digest.id, limit: 1 },
      },
      {
        name: expand,
        args: { revision: newer.revision, digestId: digest.id, limit: 1 },
      },
    ];
    const scope = { snapshotPath: path, sharedInventoryBaseDir: baseDir };
    const displayed = await run(scope, true, calls);
    assert(displayed.offered.has(list) && displayed.offered.has(expand));
    assertEquals(displayed.frames.length, 3);
    assertEquals(JSON.parse(displayed.frames[0]).page.digests[0].id, digest.id);
    assertEquals(
      JSON.parse(displayed.frames[1]).page.members[0].id,
      "evidence:prior",
    );
    const cursor = JSON.parse(displayed.frames[1]).page.nextCursor;
    assert(cursor);
    const next = await run(scope, true, [{
      name: expand,
      args: { revision: state.revision, digestId: digest.id, limit: 1, cursor },
    }]);
    assertEquals(
      JSON.parse(next.frames[0]).page.members[0].id,
      "evidence:prior-second",
    );
    assert(displayed.frames[2].startsWith("Error:"));
    assert(displayed.hooks.some(({ phase }) => phase === "PRE_TOOL_CALL"));
    assert(displayed.hooks.some(({ phase }) => phase === "POST_TOOL_RESPONSE"));
    for (const entry of displayed.hooks) {
      assertEquals(entry.input.case_id, caseId);
      assertEquals(entry.input.operation_type, "read");
      assertEquals(entry.input.resource_classification, "INTERNAL");
      assert(!Object.hasOwn(entry.audit ?? {}, "tool_response"));
    }
    const planner = await run(
      {
        ...scope,
        assessmentRevision: newer.revision,
        snapshotOverride: newer.result?.sharedGraph.snapshot,
      },
      false,
      [
        { name: list, args: { revision: newer.revision } },
        { name: list, args: { revision: state.revision } },
        {
          name: expand,
          args: { revision: state.revision, digestId: digest.id },
        },
      ],
    );
    assert(planner.offered.has(list) && planner.offered.has(expand));
    assertEquals(JSON.parse(planner.frames[0]).page.digests, []);
    assert(planner.frames[1].startsWith("Error:"));
    assert(planner.frames[2].startsWith("Error:"));
    assert(planner.hooks.some(({ phase }) => phase === "PRE_TOOL_CALL"));
    assert(planner.hooks.some(({ phase }) => phase === "POST_TOOL_RESPONSE"));

    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      const revision = adaptiveRevision(newer);
      const [task] = store.sync(
        revision,
        [{
          kind: "trace",
          nodeId: "app",
          reason: MODEL_ASSIGNMENT_REASON,
        }],
        null,
        {
          number: newer.revision,
          goal: {
            id: newer.plan.runId!,
            label: "Investigate prioritized defensive findings",
          },
        },
      );
      const deterministic = store.claim(revision);
      assertExists(deterministic);
      assert(
        store.complete({
          taskId: task.id,
          leaseToken: deterministic.leaseToken,
          observation: {},
        }),
      );
      const assignment = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
      );
      assertExists(assignment);
      const worker = await run(
        {
          ...scope,
          assessmentRevision: newer.revision,
          assignedTaskId: task.id,
          assignedTaskLeaseToken: assignment.token,
          snapshotOverride: newer.result?.sharedGraph.snapshot,
        },
        false,
        [],
      );
      assert(worker.offered.size > 0);
      assert(!worker.offered.has(list) && !worker.offered.has(expand));
      assertEquals(worker.hooks, []);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
