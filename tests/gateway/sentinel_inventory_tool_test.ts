import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import { reopenSentinelAssignedInventory } from "../../src/gateway/sentinel_inventory_tool.ts";
import { advanceAdaptiveSentinel } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  createSentinelAgent,
  createSentinelSubagent,
  type SentinelAgentOptions,
  type SentinelReadTrace,
  type SentinelTurnCheckpointOptions,
} from "../../src/gateway/sentinel_agent.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  recordSentinelFindingReview,
  recordSentinelOperatingConstraints,
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
  | "assessmentRevision"
  | "assignedTaskId"
  | "assignedTaskLeaseToken"
  | "plannerExecutionEvidenceRunId"
>;

async function query(
  snapshotPath: string,
  argumentsList: readonly Record<string, unknown>[],
  deniedHook?: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT",
  lease?: InventoryLease,
  checkpoint?: SentinelTurnCheckpointOptions,
  toolName = inventoryTool,
) {
  const policyEvents: PolicyEvent[] = [];
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input, auditInput, session }) {
      const inventory = input.tool_name === toolName ||
        (input.tool_call as { name?: unknown } | undefined)?.name ===
          toolName;
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
            toolName
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
            function: { name: toolName, arguments: JSON.stringify(args) },
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
      undefined,
      checkpoint,
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
        {
          id: "local-record",
          kind: "evidence",
          label: "Published record",
          controlVerification: {
            outcome: "fail",
            observedAt: "2026-01-01T00:00:00.000Z",
            validUntil: "2026-01-02T00:00:00.000Z",
          },
        },
        { id: "local-control", kind: "control", label: "Local control" },
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
        { from: "local-control", to: "local-finding", relation: "mitigates" },
        { from: "local-record", to: "local-control", relation: "verifies" },
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
    assertEquals(
      first.policyEvents.filter(({ hook }) => hook !== "PRE_OUTPUT").map(
        ({ hook }) => hook,
      ),
      [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ],
    );
    assertEquals(first.policyEvents.at(-1)?.hook, "PRE_OUTPUT");
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
    const gaps = await query(main, [
      { view: "coverage", coverageGap: "missing_evidence", limit: 1 },
      {
        view: "coverage",
        coverageGap: "unreviewed",
        limit: 1,
        cursor: coverageCursor,
      },
      { view: "assets", coverageGap: "either" },
    ]);
    const missing = JSON.parse(gaps.resultFrames[0]);
    assertEquals(
      missing.assets.map(({ asset }: { asset: { id: string } }) => asset.id),
      ["beta"],
    );
    assertEquals(missing.nextCursor, null);
    assertStringIncludes(gaps.resultFrames[1], "cursor");
    assertStringIncludes(gaps.resultFrames[2], "gap filter");

    const freshness = {
      view: "coverage",
      coverageGap: "missing_current_verification",
      limit: 1,
    };
    const expired = { ...freshness, asOf: "2026-01-02T00:00:00.000Z" };
    const [current, stale, future, invalid] = (await query(main, [
      { ...freshness, asOf: "2026-01-01T00:00:00.000Z" },
      expired,
      { ...freshness, asOf: "2025-12-31T23:59:59.999Z" },
      { ...freshness, asOf: "2026-02-30T00:00:00.000Z" },
    ])).resultFrames;
    assertEquals(
      JSON.parse(current).assets.map(({ asset }: { asset: { id: string } }) =>
        asset.id
      ),
      ["beta"],
    );
    assertEquals(JSON.parse(future).assets[0].asset.id, "alpha");
    assertStringIncludes(invalid, "gap filter");
    const stalePage = JSON.parse(stale);
    assertEquals(stalePage.assets[0].asset.id, "alpha");
    const [continued, wrongInstant] = (await query(main, [
      { ...expired, cursor: stalePage.nextCursor },
      {
        ...expired,
        asOf: "2026-01-03T00:00:00.000Z",
        cursor: stalePage.nextCursor,
      },
    ])).resultFrames;
    assertEquals(JSON.parse(continued).assets[0].asset.id, "beta");
    assertStringIncludes(wrongInstant, "cursor");

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
          { view: "assets", assetIds: ["alpha"] },
          { view: "assets", assetIds: ["alpha", "beta"] },
          { view: "assets", assetIds: ["alpha", "private-asset"] },
          { view: "assets", assetText: " ALPHA " },
          { view: "assets", assetText: "beta" },
          { view: "organizations", organizationText: "green" },
          {
            view: "organizations",
            organizationText: " OPERATIONS ",
            organizationId: "blue",
            includeMembers: true,
          },
        ],
        undefined,
        lease,
        { workerBoundary: () => ({}) },
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
      assertEquals(JSON.parse(worker.resultFrames[4]).assets[0].id, "alpha");
      assertEquals(worker.resultFrames[5], worker.resultFrames[6]);
      assertStringIncludes(worker.resultFrames[5], "unavailable");
      assert(
        worker.trace.some((step) =>
          step.goalReceiptRead?.args.assetIds?.join(",") === "alpha"
        ),
      );
      assertEquals(JSON.parse(worker.resultFrames[7]).assets[0].id, "alpha");
      assertEquals(JSON.parse(worker.resultFrames[8]).assets, []);
      assertEquals(JSON.parse(worker.resultFrames[9]).organizations, []);
      assertEquals(JSON.parse(worker.resultFrames[10]).assetIds, ["alpha"]);
      const memberReceipt = worker.trace.find((step) =>
        step.goalReceiptRead?.args.includeMembers === true
      )?.goalReceiptRead;
      assert(memberReceipt);
      assertEquals(
        reopenSentinelAssignedInventory(
          main,
          state.revision,
          assigned.task.id,
          "alpha",
          memberReceipt.args,
        ),
        worker.resultFrames[10],
      );
      const retained = worker.trace.find((step) =>
        step.goalReceiptRead?.args.assetText === "alpha"
      )?.goalReceiptRead;
      assert(retained);
      assertEquals(
        reopenSentinelAssignedInventory(
          main,
          state.revision,
          assigned.task.id,
          "alpha",
          retained.args,
        ),
        worker.resultFrames[7],
      );
      assertEquals(
        JSON.parse(worker.resultFrames[2]).assets[0].reviewed,
        false,
      );
      const deniedTotals = await query(
        main,
        [{
          view: "coverage",
          includeCoverageTotals: true,
        }],
        undefined,
        lease,
      );
      assertStringIncludes(deniedTotals.resultFrames[0], "Error:");
      assert(!deniedTotals.resultFrames[0].includes("coverageTotals"));

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
      const gaps = await query(main, [{
        view: "coverage",
        coverageGap: "unreviewed",
      }]);
      assertEquals(
        JSON.parse(gaps.resultFrames[0]).assets.map(
          ({ asset }: { asset: { id: string } }) => asset.id,
        ),
        ["beta"],
      );
      const expired = await query(main, [{ view: "assets" }], undefined, lease);
      assertStringIncludes(expired.resultFrames[0], "assignment");
    } finally {
      store.close();
    }
  });
});

Deno.test("Sentinel planner coverage gaps enforce the current allowed assets before paging", async () => {
  await fixture(async ({ main }) => {
    const state = startSentinelAssessment(main);
    const runId = state.plan.runId;
    assert(runId);
    const recorded = recordSentinelOperatingConstraints(main, {
      runId,
      evidenceRevision: state.revision,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      operatorScope: "owner",
      constraints: { allowedAssetIds: ["beta"], deniedKinds: [] },
    });
    assert(recorded);
    const result = await query(
      main,
      [
        { view: "coverage", coverageGap: "either", limit: 1 },
        { view: "assets", assetIds: ["beta"] },
        { view: "assets", assetIds: ["alpha", "beta"] },
        { view: "assets", assetText: "application" },
        { view: "assets", assetText: "alpha" },
      ],
      undefined,
      {
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: runId,
      },
      {
        operatingConstraints: {
          version: recorded.version,
          digest: recorded.digest,
        },
      },
    );
    const page = JSON.parse(result.resultFrames[0]);
    assertEquals(
      page.assets.map(({ asset }: { asset: { id: string } }) => asset.id),
      ["beta"],
    );
    assertEquals(page.nextCursor, null);
    assertEquals(JSON.parse(result.resultFrames[1]).assets[0].id, "beta");
    assertStringIncludes(result.resultFrames[2], "unavailable");
    assertEquals(
      JSON.parse(result.resultFrames[3]).assets.map(({ id }: { id: string }) =>
        id
      ),
      ["beta"],
    );
    assertEquals(JSON.parse(result.resultFrames[4]).assets, []);
  });
});

Deno.test("Leased trace search exposes completed peers only on the exact assigned asset", async () => {
  await fixture(async ({ main }) => {
    const state = startSentinelAssessment(main);
    advanceAdaptiveSentinel(main, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(main), "sentinel-adaptive.db"),
    );
    try {
      const peers = store.sync(
        revision,
        ["alpha", "beta"].map((nodeId) => ({
          kind: "trace" as const,
          depth: 9,
          nodeId,
          reason: MODEL_ASSIGNMENT_REASON,
        })),
        revision,
      );
      const idFor = (nodeId: string) => {
        const task = peers.find((task) =>
          task.nodeId === nodeId && task.depth === 9
        );
        assert(task);
        return task.id;
      };
      for (const nodeId of ["alpha", "beta"]) {
        const id = idFor(nodeId);
        const excluded = new Set(
          store.list(revision).filter((task) => task.id !== id).map(({ id }) =>
            id
          ),
        );
        const worker = store.claim(revision, 60, excluded);
        assert(worker);
        assert(
          store.complete({
            taskId: id,
            leaseToken: worker.leaseToken,
            observation: { summary: `Saved fixture observation for ${nodeId}` },
          }),
        );
        const review = store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          (task) => task.id === id,
        );
        assert(review);
        assert(store.finishModelReview(revision, id, review.token, {
          note: "Reviewed recorded evidence.",
          steps: [{
            tool: "sentinel_assigned_target",
            target: nodeId,
            outcome: "returned",
          }],
        }));
      }
      store.sync(revision, [{
        kind: "impact",
        nodeId: "alpha",
        depth: 10,
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(main, state);
      const consumer = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        ({ nodeId, kind, depth }) =>
          nodeId === "alpha" && kind === "impact" && depth === 10,
      );
      assert(consumer);
      const lease = {
        assessmentRevision: state.revision,
        assignedTaskId: consumer.task.id,
        assignedTaskLeaseToken: consumer.token,
      };
      const result = await query(
        main,
        [
          { task: idFor("alpha"), stepIndices: [0] },
          { task: idFor("beta"), stepIndices: [0] },
          { query: "sentinel_assigned_target" },
        ],
        undefined,
        lease,
        undefined,
        "sentinel_worker_trace_search",
      );
      assertEquals(JSON.parse(result.resultFrames[0]).steps[0].target, "alpha");
      assertStringIncludes(result.resultFrames[1], "unavailable");
      assertEquals(
        JSON.parse(result.resultFrames[2]).steps.map(
          ({ target }: { target: string }) => target,
        ),
        ["alpha"],
      );

      assert(state.plan.runId);
      const constraints = recordSentinelOperatingConstraints(main, {
        runId: state.plan.runId,
        evidenceRevision: state.revision,
        expectedVersion: 0,
        requestId: crypto.randomUUID(),
        operatorScope: "fixture-owner",
        constraints: { deniedKinds: [], allowedAssetIds: ["alpha"] },
      });
      assert(constraints);
      const planner = await query(
        main,
        [
          { task: idFor("alpha"), stepIndices: [0] },
          { task: idFor("beta"), stepIndices: [0] },
        ],
        undefined,
        {
          assessmentRevision: state.revision,
          plannerExecutionEvidenceRunId: state.plan.runId,
        },
        {
          operatingConstraints: {
            version: constraints.version,
            digest: constraints.digest,
          },
        },
        "sentinel_worker_trace_search",
      );
      assertEquals(
        JSON.parse(planner.resultFrames[0]).steps[0].target,
        "alpha",
      );
      assertStringIncludes(planner.resultFrames[1], "unavailable");
      const queries = [
        { task: idFor("alpha") },
        { task: idFor("beta") },
        { query: "Saved fixture observation" },
      ];
      const workerObservations = await query(
        main,
        queries,
        undefined,
        lease,
        undefined,
        "sentinel_worker_observation",
      );
      assertStringIncludes(
        workerObservations.resultFrames[0],
        "Saved fixture observation for alpha",
      );
      assertStringIncludes(workerObservations.resultFrames[1], "unavailable");
      assertEquals(
        JSON.parse(workerObservations.resultFrames[2]).observations.map(
          ({ id }: { id: string }) => id,
        ),
        [idFor("alpha")],
      );
      const plannerObservations = await query(main, queries, undefined, {
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: state.plan.runId,
      }, {
        operatingConstraints: {
          version: constraints.version,
          digest: constraints.digest,
        },
      }, "sentinel_worker_observation");
      assertEquals(
        plannerObservations.resultFrames,
        workerObservations.resultFrames,
      );
    } finally {
      store.close();
    }
  });
});
