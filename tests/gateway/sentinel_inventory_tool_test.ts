import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import { advanceAdaptiveSentinel } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  createSentinelAgent,
  createSentinelSubagent,
  type SentinelAgentOptions,
  type SentinelReadTrace,
} from "../../src/gateway/sentinel_agent.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  recordSentinelFindingReview,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

const inventoryTool = "sentinel_case_inventory";
const answer = "Reviewed the assigned inventory.";

interface PolicyEvent {
  readonly hook: string;
  readonly input: Record<string, unknown>;
  readonly auditInput?: Record<string, unknown>;
  readonly taint: string;
}

type InventoryLease = Pick<
  SentinelAgentOptions,
  "assessmentRevision" | "assignedTaskId" | "assignedTaskLeaseToken"
>;

async function query(
  snapshotPath: string,
  argumentsList: readonly Record<string, unknown>[],
  deniedHook?: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT",
  lease?: InventoryLease,
) {
  const policyEvents: PolicyEvent[] = [];
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input, auditInput, session }) {
      const inventory = input.tool_name === inventoryTool ||
        (input.tool_call as { name?: unknown } | undefined)?.name ===
          inventoryTool;
      const relevant = inventory || hook === "PRE_OUTPUT";
      if (relevant) {
        policyEvents.push({ hook, input, auditInput, taint: session.taint });
      }
      const allowed = !relevant || hook !== deniedHook;
      return Promise.resolve({
        action: allowed ? "ALLOW" : "BLOCK",
        allowed,
        ruleId: null,
        duration: 0,
      });
    },
  };
  const registry = createProviderRegistry();
  const resultFrames: string[] = [];
  let iterations = 0;
  registry.register({
    name: "inventory-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      assert(
        tools?.some((tool) =>
          (tool as { function?: { name?: string } }).function?.name ===
            inventoryTool
        ),
      );
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (++iterations === 1) {
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: argumentsList.map((args, index) => ({
            id: `inventory-${index}`,
            type: "function",
            function: { name: inventoryTool, arguments: JSON.stringify(args) },
          })),
        });
      }
      assertEquals(iterations, 2);
      resultFrames.push(
        ...messages.filter(({ role }) => role === "tool").map(
          ({ content }) => String(content),
        ),
      );
      return Promise.resolve({ content: answer, usage, toolCalls: [] });
    },
  });
  registry.setDefault("inventory-fixture");
  const agent = (lease ? createSentinelSubagent : createSentinelAgent)({
    snapshotPath,
    providerRegistry: registry,
    hookRunner,
    allowModelAccess: true,
    ...lease,
  });
  const events: ChatEvent[] = [];
  const trace: SentinelReadTrace[] = [];
  try {
    await agent.execute(
      "Review the currently authorized local inventory.",
      (event) => events.push(event),
      undefined,
      (step) => trace.push(step),
    );
    assertEquals(resultFrames.length, argumentsList.length);
    return { resultFrames, policyEvents, events, trace };
  } finally {
    agent.clear();
  }
}

async function fixture(
  run: (paths: {
    main: string;
    identical: string;
  }) => Promise<void>,
) {
  const baseDir = await Deno.makeTempDir();
  try {
    const main = resolveSentinelCasePath(baseDir);
    const identical = resolveSentinelCasePath(baseDir, "identical");
    const peer = resolveSentinelCasePath(baseDir, "private-peer");
    for (const path of [main, identical, peer]) {
      await Deno.mkdir(dirname(path), { recursive: true });
    }
    const snapshot = {
      version: 1,
      nodes: [
        {
          id: "alpha",
          kind: "asset",
          label: "Alpha application",
          assetType: "service",
          aliases: ["alpha.example.test"],
          organization: { id: "blue", label: "Blue Operations" },
        },
        {
          id: "beta",
          kind: "asset",
          label: "Beta application",
          assetType: "service",
          aliases: ["beta.example.test"],
          organization: { id: "green", label: "Green Operations" },
        },
        { id: "local-record", kind: "evidence", label: "Published record" },
        {
          id: "local-finding",
          kind: "finding",
          label: "Local gap",
          severity: "high",
        },
      ],
      edges: [
        { from: "local-record", to: "alpha", relation: "observed_on" },
        { from: "local-finding", to: "alpha", relation: "affects" },
        { from: "local-record", to: "local-finding", relation: "supports" },
      ],
    };
    await Promise.all([
      Deno.writeTextFile(main, JSON.stringify(snapshot)),
      Deno.writeTextFile(identical, JSON.stringify(snapshot)),
      Deno.writeTextFile(
        peer,
        JSON.stringify({
          version: 1,
          nodes: [{
            id: "private-asset",
            kind: "asset",
            label: "Peer-only asset",
          }],
          edges: [],
        }),
      ),
    ]);
    await run({ main, identical });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
}

Deno.test("Sentinel inventory returns exact case pages, declarations, and review evidence under current hooks", async () => {
  await fixture(async ({ main, identical }) => {
    const state = startSentinelAssessment(main);
    startSentinelAssessment(identical);
    assert(recordSentinelFindingReview(
      main,
      state.revision,
      "local-finding",
      "confirmed",
      "Reviewed the local evidence.",
    ));

    const first = await query(main, [
      { view: "assets", limit: 1, assetType: "service" },
      { view: "organizations" },
      { view: "coverage", assetId: "alpha" },
      { view: "assets", assetId: "private-asset" },
    ]);
    const [page, orgs, coverage, peer] = first.resultFrames.map((text) =>
      JSON.parse(text)
    );
    assertEquals(page.caseId, "main");
    assertEquals(page.evidenceRevision, state.revision);
    assertEquals(page._classification, "INTERNAL");
    assertEquals(page.assets.map(({ id }: { id: string }) => id), ["alpha"]);
    assert(typeof page.nextCursor === "string");
    assertEquals(orgs.organizations, [
      { id: "blue", label: "Blue Operations", assetCount: 1 },
      { id: "green", label: "Green Operations", assetCount: 1 },
    ]);
    assertEquals(coverage.assets.length, 1);
    const [row] = coverage.assets;
    assertEquals(row.asset.id, "alpha");
    assertEquals(row.findings[0].id, "local-finding");
    assertEquals(row.findings[0].review.disposition, "confirmed");
    assertEquals(row.evidence, [{
      id: "local-record",
      direct: true,
      supportsFindingIds: ["local-finding"],
      reviewTaskIds: [],
      sourceSnapshots: [],
    }]);
    assertEquals(peer.assets, []);
    assertEquals(first.policyEvents.map(({ hook }) => hook), [
      "PRE_TOOL_CALL",
      "POST_TOOL_RESPONSE",
      "PRE_TOOL_CALL",
      "POST_TOOL_RESPONSE",
      "PRE_TOOL_CALL",
      "POST_TOOL_RESPONSE",
      "PRE_TOOL_CALL",
      "POST_TOOL_RESPONSE",
      "PRE_OUTPUT",
    ]);
    for (const event of first.policyEvents) {
      assertEquals(event.taint, "INTERNAL");
      if (event.hook === "POST_TOOL_RESPONSE") {
        assertEquals(
          JSON.parse(String(event.input.tool_response))._classification,
          "INTERNAL",
        );
        assertEquals(
          Object.hasOwn(event.auditInput ?? {}, "tool_response"),
          false,
        );
      }
      if (event.hook === "PRE_OUTPUT") {
        assertEquals(event.input.target_classification, "INTERNAL");
      }
    }
    assert(first.events.some(({ type }) => type === "response"));

    const cursor = {
      view: "assets",
      limit: 1,
      assetType: "service",
      cursor: page.nextCursor,
    };
    const [next, changedFilter, changedView] = (await query(main, [
      cursor,
      { ...cursor, organizationId: "blue" },
      { ...cursor, view: "organizations" },
    ])).resultFrames;
    assertEquals(JSON.parse(next).assets.map(({ id }: { id: string }) => id), [
      "beta",
    ]);
    assertStringIncludes(changedFilter, "cursor");
    assertStringIncludes(changedView, "cursor");
    const copied = await query(identical, [cursor]);
    assertStringIncludes(copied.resultFrames[0], "cursor");

    const [firstCoverage] =
      (await query(main, [{ view: "coverage", limit: 1 }])).resultFrames;
    const coverageCursor = JSON.parse(firstCoverage).nextCursor;
    assert(typeof coverageCursor === "string");
    assert(recordSentinelFindingReview(
      main,
      state.revision,
      "local-finding",
      "resolved",
      "Published review changed.",
    ));
    const [changedCoverage] = (await query(main, [
      { view: "coverage", limit: 1, cursor: coverageCursor },
    ])).resultFrames;
    assertStringIncludes(changedCoverage, "cursor");

    assert(stopSentinelAssessment(main));
    const restarted = startSentinelAssessment(main);
    assert(restarted.revision > state.revision);
    const [staleRevision] = (await query(main, [cursor])).resultFrames;
    assertStringIncludes(staleRevision, "cursor");
  });
});

Deno.test("Sentinel inventory enforces the real leased asset and stops flow on hook denial", async () => {
  await fixture(async ({ main }) => {
    const state = startSentinelAssessment(main);
    advanceAdaptiveSentinel(main, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(main), "sentinel-adaptive.db"),
    );
    try {
      store.sync(revision, [{
        kind: "impact",
        nodeId: "alpha",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(main, state);
      const assigned = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.kind === "impact" && task.nodeId === "alpha",
      );
      assert(assigned);
      const lease = {
        assessmentRevision: state.revision,
        assignedTaskId: assigned.task.id,
        assignedTaskLeaseToken: assigned.token,
      };
      const worker = await query(
        main,
        [
          { view: "assets" },
          { view: "organizations" },
          { view: "coverage" },
          { view: "assets", assetId: "beta" },
        ],
        undefined,
        lease,
      );
      assertEquals(
        JSON.parse(worker.resultFrames[0]).assets.map((
          { id }: { id: string },
        ) => id),
        ["alpha"],
      );
      assertEquals(JSON.parse(worker.resultFrames[1]).organizations, [
        { id: "blue", label: "Blue Operations", assetCount: 1 },
      ]);
      assertEquals(
        JSON.parse(worker.resultFrames[2]).assets.map((
          { asset }: { asset: { id: string } },
        ) => asset.id),
        ["alpha"],
      );
      assertStringIncludes(worker.resultFrames[3], "scope");
      assertEquals(
        JSON.parse(worker.resultFrames[2]).assets[0].reviewed,
        false,
      );

      for (
        const hook of [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
          "PRE_OUTPUT",
        ] as const
      ) {
        const blocked = await query(main, [{ view: "assets" }], hook, lease);
        if (hook === "PRE_OUTPUT") {
          assertStringIncludes(blocked.resultFrames[0], "Alpha application");
          assert(!blocked.events.some(({ type }) => type === "response"));
          assert(blocked.events.some(({ type }) => type === "error"));
          continue;
        }
        assert(!blocked.resultFrames[0].includes("Alpha application"));
        assertEquals(blocked.trace, []);
        if (hook === "PRE_TOOL_CALL") {
          assert(
            !blocked.policyEvents.some(({ hook }) =>
              hook === "POST_TOOL_RESPONSE"
            ),
          );
        } else {
          assertEquals(
            blocked.resultFrames[0],
            "Tool response withheld by policy.",
          );
        }
      }
      assert(
        store.finishModelReview(
          revision,
          assigned.task.id,
          assigned.token,
          { note: answer, steps: worker.trace },
        ),
      );
      const completed = await query(main, [{ view: "coverage" }]);
      assertEquals(
        JSON.parse(completed.resultFrames[0]).assets.map(
          (
            { asset, reviewed }: { asset: { id: string }; reviewed: boolean },
          ) => [asset.id, reviewed],
        ),
        [["alpha", true], ["beta", false]],
      );
      const expired = await query(main, [{ view: "assets" }], undefined, lease);
      assertStringIncludes(expired.resultFrames[0], "assignment");
    } finally {
      store.close();
    }
  });
});
