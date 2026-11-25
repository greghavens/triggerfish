import { Buffer } from "node:buffer";
import {
  openSentinelEvidenceDigests,
  sentinelArchivedDigestFile,
} from "../../src/sentinel/evidence_digests.ts";
import { openSentinelWorkerGraphFacts } from "../../src/sentinel/worker_graph_facts.ts";
import { assetLinkProof } from "../../src/sentinel/shared_asset_link_page.ts";
import {
  createSentinelSubagent,
  projectSentinelSharedFindingSource,
  projectSentinelSharedTopologySource,
} from "../../src/gateway/sentinel_agent.ts";
import { DatabaseSync } from "node:sqlite";
import { createSentinelLiveWorkflowReader } from "../../src/gateway/sentinel_live_workflow.ts";
import { createHash } from "node:crypto";
import { reopenProjectedSentinelTrafficPage } from "../../src/gateway/sentinel_traffic_tool.ts";
import {
  withVerifiedRunArchive,
  writeRunArchive,
} from "../../src/core/run_archive.ts";
import {
  permittedSentinelRestoreArtifacts,
  restoreVerifiedSentinelCaseArchive,
} from "../../src/sentinel/sentinel_archive_restore.ts";
import {
  ensureSentinelFormalGoalContract,
  readSentinelWorkerGoalProofReceipt,
  reportSentinelWorkerGoalProof,
} from "../../src/gateway/sentinel_goal_completion.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  applySharedSentinelTopology,
  collectSharedSentinelTopology,
  digestSentinelSnapshot,
  maxSentinelArchivedTopologyBytes,
  readArchivedSentinelFindingSource,
  readArchivedSentinelSnapshot,
  readPinnedSentinelSharedFindingSource,
  readSharedSentinelTopologySource,
  retainSentinelSourceSnapshot,
  sentinelArchivedFindingSourcesFile,
  sentinelArchivedTraceSourcesFile,
  sentinelSourceSnapshotPath,
} from "../../src/sentinel/shared_inventory.ts";
import { ingestSentinelTraffic } from "../../src/cli/commands/sentinel_traffic.ts";
import { readSentinelTrafficReceiptPage } from "../../src/sentinel/traffic_receipts.ts";
import { openSentinelWorkerFindingStore } from "../../src/sentinel/worker_finding_store.ts";
import { openOperatorRunLinkStore } from "../../src/core/operator_runs.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
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
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import {
  adaptiveRevision,
  sentinelIncidentCandidates,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  applySentinelFormalGoals,
  claimSentinelAssessmentReview,
  completeSentinelAssessmentReview,
  readSentinelAssessment,
  readSentinelFindingReviews,
  recordSentinelFindingReview,
  refreshSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import {
  digestSentinelGoalProposal,
  type SentinelFormalGoal,
} from "../../src/sentinel/formal_goals.ts";

async function killRestoreAtPublication(
  baseDir: string,
  request: Record<string, unknown>,
  phase: "before" | "after",
  whileLive?: () => Promise<void>,
) {
  const fixture = new URL(
    "./fixtures/sentinel_restore_process.ts",
    import.meta.url,
  );
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--no-check",
      fixture.href,
      baseDir,
      JSON.stringify(request),
      phase,
    ],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const signal = Deno.build.os === "windows" ? "SIGTERM" : "SIGKILL";
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Restore did not reach publication")),
        5000,
      );
    });
    const marker = await Promise.race([reader.read(), timeout]);
    assertEquals(new TextDecoder().decode(marker.value), "ready\n");
    await whileLive?.();
    child.kill(signal);
    const outcome = await child.status;
    assertEquals(outcome.success, false);
    if (Deno.build.os !== "windows") assertEquals(outcome.signal, signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      child.kill(signal);
    } catch { /* Already exited. */ }
    await child.status;
    await reader.cancel();
  }
}

async function withGateway(
  baseDir: string,
  run: (
    request: (args: Record<string, unknown>) => Promise<string>,
    approvals: string[],
    policy: {
      denyArchive: boolean;
      denyTrafficBefore: boolean;
      denyRunResponse: boolean;
      denyWorkflowMetadata: boolean;
      denySharedAssetLinks: boolean;
      denyWorkerSourceBefore: boolean;
      denyWorkerSourceAfter: boolean;
      workerSourceHooks: string[];
      workflowMetadataCalls: number;
    },
  ) => Promise<void>,
) {
  const approvals: string[] = [];
  const policy = {
    denyArchive: false,
    denyTrafficBefore: false,
    denyRunResponse: false,
    denyWorkflowMetadata: false,
    denySharedAssetLinks: false,
    denyWorkerSourceBefore: false,
    denyWorkerSourceAfter: false,
    workerSourceHooks: [] as string[],
    workflowMetadataCalls: 0,
  };
  const registry = createProviderRegistry();
  const hooks: HookRunner = {
    evaluateHook(hook, { input }) {
      const call = input.tool_call as
        | { args?: { action?: string } }
        | undefined;
      const workerSource = input.tool_name === "sentinel_shared_asset" ||
        input.tool_name === "sentinel_shared_asset_links" ||
        input.tool_name === "sentinel_shared_topology_source" ||
        input.tool_name === "sentinel_trace" ||
        [
          "sentinel_impact",
          "sentinel_path",
          "sentinel_report",
          "sentinel_coverage",
          "sentinel_provenance_search",
          "sentinel_provenance_node",
          "sentinel_worker_observation",
          "sentinel_worker_trace_search",
          "sentinel_goal_state",
          "sentinel_case_hints",
          "sentinel_defense",
          "sentinel_incident_alerts",
          "sentinel_graph_facts",
          "sentinel_case_inventory",
          "sentinel_graph_overview",
          "sentinel_list_evidence_digests",
          "sentinel_expand_evidence_digest",
          "sentinel_traffic_search",
          "sentinel_traffic_get",
          "sentinel_finding_traffic_links",
          "sentinel_worker_findings",
          "sentinel_case_execution_evidence",
        ].includes(String(input.tool_name));
      if (workerSource) policy.workerSourceHooks.push(hook);
      const allowed = !(policy.denyArchive && hook === "PRE_TOOL_CALL" &&
        call?.args?.action === "archive") &&
        !(policy.denyTrafficBefore && hook === "PRE_TOOL_CALL" &&
          ["traffic_search", "traffic_get", "traffic_blob"].includes(
            String(call?.args?.action),
          )) &&
        !(policy.denyRunResponse && hook === "POST_TOOL_RESPONSE" &&
          input.tool_name === "operator_runs") &&
        !(policy.denySharedAssetLinks && hook === "POST_TOOL_RESPONSE" &&
          input.tool_name === "sentinel_shared_asset_links") &&
        !(workerSource && (
          policy.denyWorkerSourceBefore && hook === "PRE_TOOL_CALL" ||
          policy.denyWorkerSourceAfter && hook === "POST_TOOL_RESPONSE"
        ));
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        ruleId: null,
        duration: 0,
      });
    },
  };
  let next: Record<string, unknown> | undefined;
  let result = "";
  registry.register({
    name: "archive-fixture",
    supportsStreaming: false,
    complete(messages) {
      const args = next;
      next = undefined;
      if (!args) {
        result = String(
          messages.findLast(({ role }) => role === "tool")?.content,
        );
      }
      return Promise.resolve({
        content: args ? "" : "Finished archive request.",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: args
          ? [{
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(args),
            },
          }]
          : [],
      });
    },
  });
  registry.setDefault("archive-fixture");
  const chatSession = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "archive-fixture" as ChannelId,
      bumpersEnabled: false,
    }),
    providerRegistry: registry,
    hookRunner: hooks,
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir,
      readLiveWorkflow: createSentinelLiveWorkflowReader({
        scopes: [{
          case: "restorable",
          asset: "app",
          owner: "owner",
          repo: "repo",
          workflow_id: 22,
        }],
        resolveToken: () => Promise.resolve("fixture-metadata-token"),
        ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
        readRuns: () => {
          throw new Error("Archive readback must not fetch workflow runs");
        },
        verifyAccess: () => {
          policy.workflowMetadataCalls++;
          return Promise.resolve(!policy.denyWorkflowMetadata);
        },
      }),
      confirm(text) {
        approvals.push(text);
        return Promise.resolve(true);
      },
    }),
  });
  const token = crypto.randomUUID();
  const server = createGatewayServer({ port: 0, token, chatSession });
  const { port } = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((done, fail) => {
      socket.addEventListener("open", () => done(), { once: true });
      socket.addEventListener("error", fail, { once: true });
    });
    await run(
      (args) => {
        next = args;
        result = "";
        const done = Promise.withResolvers<string>();
        const timer = setTimeout(
          () => done.reject(new Error("No archive turn")),
          5000,
        );
        const onMessage = ({ data }: MessageEvent) => {
          if (JSON.parse(String(data)).type === "turn_end") {
            done.resolve(result);
          }
        };
        socket.addEventListener("message", onMessage);
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Use the approved operator run action.",
          }),
        );
        return done.promise.finally(() => {
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
        });
      },
      approvals,
      policy,
    );
  } finally {
    socket.close();
    await server.stop();
  }
}

Deno.test("authenticated Sentinel archive survives restart, restores paused, and preserves evidence and dependencies", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, "restorable");
  const evidenceId = "saved-log";
  const findingId = "missing-control";
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: "app",
            kind: "asset",
            label: "Service",
            aliases: ["app.example.invalid"],
          },
          {
            id: "db",
            kind: "asset",
            label: "Database",
            aliases: ["db.example.invalid"],
          },
          {
            id: findingId,
            kind: "finding",
            label: "Defensive gap",
            severity: "low",
          },
          {
            id: "native-workflow-control",
            kind: "control",
            label: "Workflow succeeds",
          },
          {
            id: evidenceId,
            kind: "evidence",
            label: "Committed control evidence",
          },
        ],
        edges: [
          { from: evidenceId, to: findingId, relation: "supports" },
          { from: findingId, to: "app", relation: "affects" },
          {
            from: "native-workflow-control",
            to: findingId,
            relation: "mitigates",
          },
        ],
      }),
    );
    const sourceCase = "topology-origin";
    const sourcePath = resolveSentinelCasePath(baseDir, sourceCase);
    await Deno.mkdir(dirname(sourcePath), { recursive: true, mode: 0o700 });
    const originalSource = {
      version: 1,
      nodes: [
        {
          id: "source-app",
          kind: "asset",
          label: "Original application",
          aliases: ["app.example.invalid"],
        },
        {
          id: "source-db",
          kind: "asset",
          label: "Original database",
          aliases: ["db.example.invalid"],
        },
      ],
      edges: [{ from: "source-app", to: "source-db", relation: "depends_on" }],
    };
    await Deno.writeTextFile(sourcePath, JSON.stringify(originalSource));
    const shared = await collectSharedSentinelTopology(
      baseDir,
      "restorable",
      path,
      undefined,
      true,
    );
    const overlaid = applySharedSentinelTopology(
      JSON.parse(await Deno.readTextFile(path)),
      shared,
    );
    const cited = overlaid.nodes.find(({ id }) =>
      id.startsWith("shared-topology:")
    );
    assert(cited);
    await Deno.writeTextFile(path, JSON.stringify(overlaid));
    await Deno.writeTextFile(
      sourcePath,
      JSON.stringify({ ...originalSource, edges: [] }),
    );
    const findingSource = loadSentinelGraph({
      ...originalSource,
      nodes: [...originalSource.nodes, {
        id: "borrowed-finding",
        kind: "finding",
        label: "Original peer finding",
        severity: "low",
      }],
      edges: [{
        from: "borrowed-finding",
        to: "source-app",
        relation: "affects",
      }],
    }).snapshot();
    const findingDigest = digestSentinelSnapshot(findingSource);
    await retainSentinelSourceSnapshot(
      baseDir,
      sourceCase,
      findingDigest,
      findingSource,
    );
    const mappingCase = "alias-bridge";
    const mappingSnapshot = loadSentinelGraph({
      version: 1,
      nodes: [{
        id: "app",
        kind: "asset",
        label: "Archived alias",
        aliases: ["source-app"],
      }],
      edges: [],
    }).snapshot();
    const mappingDigest = digestSentinelSnapshot(mappingSnapshot);
    await retainSentinelSourceSnapshot(
      baseDir,
      mappingCase,
      mappingDigest,
      mappingSnapshot,
    );
    let uncompressedMappingBytes = 0;
    const auxiliaryMappings = [];
    for (let index = 0; index < 32; index++) {
      const caseId = `supporting-publication-${index}`;
      const snapshot = loadSentinelGraph({
        version: 1,
        nodes: [
          { id: caseId, kind: "asset", label: caseId },
          ...Array.from({ length: 1_000 }, (_, item) => ({
            id: `retained-record-${item}`,
            kind: "evidence",
            label: "Original supporting metadata. ".repeat(18),
          })),
        ],
        edges: [],
      }).snapshot();
      uncompressedMappingBytes += new TextEncoder().encode(
        JSON.stringify(snapshot),
      ).byteLength;
      const snapshotDigest = digestSentinelSnapshot(snapshot);
      await retainSentinelSourceSnapshot(
        baseDir,
        caseId,
        snapshotDigest,
        snapshot,
      );
      auxiliaryMappings.push({ caseId, snapshotDigest });
    }
    const mappingSources = [
      ...auxiliaryMappings,
      { caseId: mappingCase, snapshotDigest: mappingDigest },
      { caseId: sourceCase, snapshotDigest: findingDigest },
    ];
    const findingCitation = {
      localAssetId: "app",
      sourceCaseId: sourceCase,
      sourceAssetId: "source-app",
      sourceFindingId: "borrowed-finding",
      snapshotDigest: findingDigest,
      mappingSources,
    };
    const traceSnapshot = loadSentinelGraph({
      ...originalSource,
      nodes: originalSource.nodes.map((node) => ({
        ...node,
        label: node.label + " (trace-only)",
      })),
    }).snapshot();
    const traceDigest = digestSentinelSnapshot(traceSnapshot);
    await retainSentinelSourceSnapshot(
      baseDir,
      sourceCase,
      traceDigest,
      traceSnapshot,
    );
    const aliasOnlySource = "trace-alias-proof";
    const aliasOnlySnapshot = loadSentinelGraph({
      version: 1,
      nodes: [{
        id: "app",
        kind: "asset",
        label: "Trace alias bridge",
        aliases: ["source-app"],
      }],
      edges: [],
    }).snapshot();
    const aliasOnlyDigest = digestSentinelSnapshot(aliasOnlySnapshot);
    await retainSentinelSourceSnapshot(
      baseDir,
      aliasOnlySource,
      aliasOnlyDigest,
      aliasOnlySnapshot,
    );
    const aliasMapping = {
      proof: "a".repeat(64),
      sources: [{ caseId: aliasOnlySource, snapshotDigest: aliasOnlyDigest }],
    };
    const traceReference = {
      caseId: sourceCase,
      snapshotDigest: traceDigest,
      assetId: "source-app",
    };
    const assessmentSnapshot = loadSentinelGraph({
      ...originalSource,
      nodes: originalSource.nodes.map((node) => ({
        ...node,
        label: node.label + " (assessment only)",
      })),
    }).snapshot();
    const assessmentDigest = digestSentinelSnapshot(assessmentSnapshot);
    await retainSentinelSourceSnapshot(
      baseDir,
      sourceCase,
      assessmentDigest,
      assessmentSnapshot,
    );
    const plannerSnapshot = loadSentinelGraph({
      ...originalSource,
      nodes: originalSource.nodes.map((node) => ({
        ...node,
        label: node.label + " (planner only)",
      })),
    }).snapshot();
    const plannerDigest = digestSentinelSnapshot(plannerSnapshot);
    await retainSentinelSourceSnapshot(
      baseDir,
      sourceCase,
      plannerDigest,
      plannerSnapshot,
    );
    const plannerAliasSource = "planner-alias-proof";
    const plannerAliasDigest = digestSentinelSnapshot(mappingSnapshot);
    await retainSentinelSourceSnapshot(
      baseDir,
      plannerAliasSource,
      plannerAliasDigest,
      mappingSnapshot,
    );
    const plannerAliasMapping = {
      proof: "b".repeat(64),
      sources: [{
        caseId: plannerAliasSource,
        snapshotDigest: plannerAliasDigest,
      }],
    };
    const plannerRead = {
      aliasMapping: plannerAliasMapping,
      tool: "sentinel_shared_asset_links",
      goalReceiptRead: {
        args: { asset: "app", limit: 5 },
        sha256: "d".repeat(64),
      },
      target: "app",
      outcome: "returned" as const,
      sourceSnapshots: [{
        caseId: sourceCase,
        snapshotDigest: plannerDigest,
        assetId: "source-app",
      }],
    };
    const privateToken = "archive-traffic-fixture-secret";
    const reviewedBody = "x".repeat(511) + "🙂reviewed response\n";
    const reviewedRequest = "q".repeat(511) + "🌿reviewed request\n";
    await ingestSentinelTraffic(
      new Blob([JSON.stringify({
        startedDateTime: new Date(Date.now() - 60_000).toISOString(),
        request: {
          url: `https://app.example/private?token=${privateToken}`,
          method: "POST",
          postData: { text: reviewedRequest },
          headers: [
            { name: "Accept", value: "text/plain" },
            { name: "AUTHORIZATION", value: privateToken },
          ],
        },
        response: {
          status: 403,
          content: { text: reviewedBody },
          headers: [
            { name: "Content-Type", value: "text/plain; charset=utf-8" },
            { name: "Set-Cookie", value: privateToken },
          ],
        },
      })]).stream(),
      "archive-fixture",
      path,
      "har",
      true,
      true,
      true,
    );
    const binaryBody = Buffer.from(
      Array.from({ length: 517 }, (_, index) => index % 256),
    );
    await ingestSentinelTraffic(
      new Blob([JSON.stringify({
        startedDateTime: new Date(Date.now() - 60_000).toISOString(),
        request: { url: "https://binary.example", method: "GET" },
        response: {
          status: 200,
          content: { encoding: "base64", text: binaryBody.toString("base64") },
        },
      })]).stream(),
      "binary-fixture",
      path,
      "har",
      false,
      false,
      false,
      true,
    );
    const goals: SentinelFormalGoal[] = [{
      id: "review-source",
      title: "Review source evidence",
      policy: "operator",
      criteria: [{
        id: "saved-log",
        description: "Review the saved control evidence.",
        source: "graph_evidence",
        reference: evidenceId,
      }],
    }];
    const { state: initial } = applySentinelFormalGoals(path, {
      mode: "start",
      requestId: crypto.randomUUID(),
      proposalDigest: digestSentinelGoalProposal(goals),
      goals,
      plan: { goal: "Review source evidence" },
    });
    const published = JSON.parse(await Deno.readTextFile(path));
    published.nodes.push({
      id: "later-record",
      kind: "evidence",
      label: "Later evidence revision",
    });
    await Deno.writeTextFile(path, JSON.stringify(published));
    const state = refreshSentinelAssessment(path);
    assert(state);
    assertEquals(state.revision, initial.revision + 1);
    const assessmentTask = state.result?.tasks.find(({ status }) =>
      status === "completed"
    );
    assert(assessmentTask);
    const assessmentClaim = claimSentinelAssessmentReview(
      path,
      state.revision,
      assessmentTask.id,
    );
    assert(assessmentClaim);
    assert(completeSentinelAssessmentReview(
      path,
      state.revision,
      assessmentTask.id,
      assessmentClaim,
      "Saved assessment review.",
      [{
        tool: "sentinel_shared_asset",
        target: "app",
        outcome: "returned",
        aliasMapping: {
          proof: "c".repeat(64),
          sources: [{ caseId: sourceCase, snapshotDigest: assessmentDigest }],
        },
        sourceSnapshots: [{
          caseId: sourceCase,
          snapshotDigest: assessmentDigest,
          assetId: "source-app",
        }],
      }],
    ));
    const revision = adaptiveRevision(state);
    assert(state.plan.runId);
    assert(
      recordSentinelFindingReview(
        path,
        state.revision,
        findingId,
        "confirmed",
        "Confirmed against saved control evidence.",
      ),
    );
    const decision = readSentinelFindingReviews(path, state.revision);
    const observation = {
      relatedNodeIds: [evidenceId, findingId],
      result: "Reviewed the retained record",
      details: "Retained local review detail. ".repeat(40),
    };
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const traffic = readSentinelTrafficReceiptPage(path, state.revision, {
      origin: "https://app.example",
    })?.receipts[0];
    const binary = readSentinelTrafficReceiptPage(path, state.revision, {
      origin: "https://binary.example",
    })?.receipts[0];
    assert(binary);
    assert(traffic);
    const trafficArgs = {
      revision: state.revision,
      origin: "https://app.example",
      limit: 1,
    };
    const trafficPage = reopenProjectedSentinelTrafficPage(
      path,
      "restorable",
      state.revision,
      trafficArgs,
      traffic.assetIds[0],
    );
    assert(trafficPage);
    const page = JSON.parse(trafficPage);
    assertEquals(page.receipts.length, 1);
    let trafficTaskId: string;
    let sourceTaskId: string;
    let interruptedTaskId: string;
    const workflowRuns = [{
      id: 17,
      status: "completed",
      conclusion: "success",
      repositoryId: 8642,
      createdAt: "2026-01-01T00:00:00.000Z",
    }];
    const workflowReceipt = {
      repository: "owner/repo",
      workflowId: 22,
      connectorId: "github-actions",
      observedAt: new Date().toISOString(),
      evidenceRevision: state.revision,
      resultSha256: createHash("sha256").update(JSON.stringify(workflowRuns))
        .digest("hex"),
      runs: workflowRuns,
    };
    const interruptedProofRequestId = crypto.randomUUID();
    const interruptedLinkSnapshot = loadSentinelGraph({
      ...originalSource,
      nodes: originalSource.nodes.map((node) => ({
        ...node,
        label: node.label + " (interrupted worker)",
      })),
    }).snapshot();
    const interruptedLinkDigest = digestSentinelSnapshot(
      interruptedLinkSnapshot,
    );
    const interruptedLinkPath = sentinelSourceSnapshotPath(
      baseDir,
      sourceCase,
      interruptedLinkDigest,
    );
    await retainSentinelSourceSnapshot(
      baseDir,
      sourceCase,
      interruptedLinkDigest,
      interruptedLinkSnapshot,
    );
    const interruptedLinkReference = {
      caseId: sourceCase,
      snapshotDigest: interruptedLinkDigest,
      assetId: "source-app",
    };
    const [interruptedLink] = interruptedLinkSnapshot.edges;
    assert(interruptedLink);
    const assetLinksArgs = { asset: "app" };
    const assetLinksProjection = {
      ...assetLinksArgs,
      offset: 0,
      links: [{
        ...interruptedLink,
        caseIds: [sourceCase],
        sourceDigests: { [sourceCase]: interruptedLinkDigest },
      }],
      sourceSnapshots: [interruptedLinkReference],
      totalLinks: 1,
      nextOffset: null,
      source: "live_published_inventory",
      caseEvidenceRevision: state.revision,
      unavailableSourceCount: 0,
    };
    const interruptedAliasCase = "interrupted-alias";
    await retainSentinelSourceSnapshot(
      baseDir,
      interruptedAliasCase,
      aliasOnlyDigest,
      aliasOnlySnapshot,
    );
    const interruptedMappings = [
      { caseId: interruptedAliasCase, snapshotDigest: aliasOnlyDigest },
      { caseId: sourceCase, snapshotDigest: interruptedLinkDigest },
    ];
    const mappingProof = assetLinkProof(
      "restorable",
      assetLinksProjection,
      interruptedMappings,
    );
    const assetLinksPage = { ...assetLinksProjection, mappingProof };
    const assetLinksText = JSON.stringify(assetLinksPage);
    const assetLinksStep = {
      tool: "sentinel_shared_asset_links",
      target: "app",
      outcome: "returned" as const,
      sharedAssetLinksPage: assetLinksText,
      aliasMapping: { proof: mappingProof, sources: interruptedMappings },
      goalReceiptRead: {
        args: assetLinksArgs,
        sha256: createHash("sha256").update(assetLinksText).digest("hex"),
      },
    };
    const interruptedFinding = loadSentinelGraph({
      ...findingSource,
      nodes: findingSource.nodes.map((node) => ({
        ...node,
        label: node.label + " (interrupted read)",
      })),
    }).snapshot();
    const interruptedFindingDigest = digestSentinelSnapshot(interruptedFinding);
    await retainSentinelSourceSnapshot(
      baseDir,
      sourceCase,
      interruptedFindingDigest,
      interruptedFinding,
    );
    const findingArgs = {
      asset: "app",
      sourceCase,
      sourceAsset: "source-app",
      finding: "borrowed-finding",
      snapshotDigest: interruptedFindingDigest,
    };
    const interruptedFindingSource = await readArchivedSentinelFindingSource(
      baseDir,
      {
        caseId: sourceCase,
        assetId: findingArgs.sourceAsset,
        findingId: findingArgs.finding,
        snapshotDigest: interruptedFindingDigest,
      },
      path,
    );
    assert(interruptedFindingSource);
    const interruptedFindingText = projectSentinelSharedFindingSource(
      interruptedFindingSource,
      state.revision,
      findingArgs,
    );
    const topologyArgs = { evidenceId: cited.id, sourceCase };
    const assessmentGraph = state.result?.sharedGraph.snapshot;
    assert(assessmentGraph);
    const interruptedTopology = await readSharedSentinelTopologySource(
      baseDir,
      assessmentGraph,
      topologyArgs.evidenceId,
      sourceCase,
      path,
    );
    assert(interruptedTopology);
    const interruptedTopologyText = projectSentinelSharedTopologySource(
      interruptedTopology,
      state.revision,
    );
    const privateProgress = "fixture-only-interrupted-progress-secret";
    let dependentId: string;
    try {
      const [source] = store.sync(
        revision,
        [{
          kind: "trace",
          nodeId: "app",
          reason: "fixture trace review",
          evidenceIds: [evidenceId],
          plannerRound: {
            identity: revision,
            attempt: 1,
            peerFindingCitations: [findingCitation],
          },
        }],
        null,
        {
          number: state.revision,
          goal: { id: state.plan.runId, label: state.plan.goal! },
        },
      );
      const lease = store.claim(revision);
      assert(lease);
      assert(
        store.complete({
          taskId: source.id,
          leaseToken: lease.leaseToken,
          observation,
        }),
      );
      const review = store.claimModelReview(revision, "fixture trace review");
      assert(review);
      assert(store.finishModelReview(revision, source.id, review.token, {
        note: "Confirmed scoped trace receipt",
        steps: [{
          tool: "sentinel_shared_asset",
          target: "app",
          outcome: "returned",
          sourceSnapshots: [traceReference],
          aliasMapping,
        }],
      }));
      const identity = `${revision}:obs:archive-fixture`;
      assertEquals(store.claimModelPlan(identity), 1);
      assert(store.recordModelPlanInputManifest(identity, 1, {
        promptSha256: "a".repeat(64),
        hintIds: [],
        findingReviewIds: [],
        incidentReviewIds: [],
        incidentCandidateIds: [],
        investigationIds: [],
        inventoryNodeIds: [],
        workerObservations: [],
      }));
      assert(store.recordModelPlanRead(identity, 1, plannerRead));
      sourceTaskId = source.id;
      const interrupted = store.sync(revision, [{
        kind: "trace",
        nodeId: "app",
        depth: 7,
        reason: "fixture interrupted review",
      }], revision).find(({ reason }) =>
        reason === "fixture interrupted review"
      );
      assert(interrupted);
      const otherTasks = new Set(
        store.list(revision).filter(({ id }) => id !== interrupted.id).map((
          { id },
        ) => id),
      );
      const interruptedLease = store.claim(revision, 60, otherTasks);
      assert(interruptedLease);
      assertEquals(interruptedLease.task.id, interrupted.id);
      assert(store.complete({
        taskId: interrupted.id,
        leaseToken: interruptedLease.leaseToken,
        observation: {},
      }));
      const pendingReview = store.claimModelReview(
        revision,
        "fixture interrupted review",
      );
      assert(pendingReview);
      interruptedTaskId = interrupted.id;
      assert(
        store.recordModelReviewProgress(
          revision,
          interrupted.id,
          pendingReview.token,
          [
            {
              tool: "sentinel_assigned_target",
              target: "app",
              outcome: "returned",
              resultSnapshot: {
                sha256: "a".repeat(64),
                excerpt: privateProgress,
                truncated: false,
              },
            },
            {
              tool: "sentinel_prove_goal",
              target: evidenceId,
              outcome: "returned",
              goalProofRequestId: interruptedProofRequestId,
            },
            {
              tool: "sentinel_live_workflow_status",
              target: "app",
              outcome: "returned",
              githubWorkflowRead: workflowReceipt,
            },
            assetLinksStep,
            {
              ...assetLinksStep,
              sharedAssetLinksPage: JSON.stringify({
                ...assetLinksPage,
                unavailableSourceCount: 1,
              }),
            },
            {
              tool: "sentinel_shared_finding_source",
              target: findingArgs.finding,
              outcome: "returned",
              goalReceiptRead: {
                args: findingArgs,
                sha256: createHash("sha256").update(interruptedFindingText)
                  .digest("hex"),
              },
            },
            {
              tool: "sentinel_shared_topology_source",
              target: topologyArgs.evidenceId,
              outcome: "returned",
              goalReceiptRead: {
                args: topologyArgs,
                sha256: createHash("sha256").update(interruptedTopologyText)
                  .digest("hex"),
              },
            },
          ],
        ),
      );
      const trafficTask = store.sync(revision, [{
        kind: "trace",
        nodeId: traffic.assetIds[0],
        depth: 7,
        reason: "fixture interrupted traffic search",
      }], revision).find(({ reason }) =>
        reason === "fixture interrupted traffic search"
      );
      assert(trafficTask);
      const excluded = new Set(
        store.list(revision).filter(({ id }) => id !== trafficTask.id).map((
          { id },
        ) => id),
      );
      const leased = store.claim(revision, 60, excluded);
      assert(leased);
      assert(
        store.complete({
          taskId: trafficTask.id,
          leaseToken: leased.leaseToken,
          observation: {},
        }),
      );
      const trafficReview = store.claimModelReview(
        revision,
        "fixture interrupted traffic search",
      );
      assert(trafficReview);
      trafficTaskId = trafficTask.id;
      const sha256 = createHash("sha256").update(trafficPage).digest("hex");
      assert(
        store.recordModelReviewProgress(
          revision,
          trafficTask.id,
          trafficReview.token,
          [{
            tool: "sentinel_traffic_search",
            outcome: "returned",
            trafficSearch: { args: trafficArgs, sha256 },
            trafficSearchPage: {
              revision: state.revision,
              receipts: page.receipts,
              nextCursor: page.nextCursor,
              sha256,
            },
          }],
        ),
      );
      const dependent = store.sync(revision, [{
        kind: "review_finding",
        nodeId: findingId,
        prerequisites: [source.id],
        evidenceIds: [evidenceId],
      }], revision).find(({ nodeId }) => nodeId === findingId);
      assert(dependent);
      dependentId = dependent.id;
    } finally {
      store.close();
    }
    const exact = {
      kind: "sentinel",
      id: "restorable",
      revision: state.revision,
      runId: state.plan.runId,
    };
    const journal = openSentinelWorkerFindingStore(path);
    const workerFinding = (() => {
      try {
        return journal.recordFinding({
          caseId: exact.id,
          runId: exact.runId,
          evidenceRevision: exact.revision,
          taskId: sourceTaskId,
          targetId: traffic.assetIds[0],
          graphFindingId: findingId,
          controlId: "fixture-control",
          evidenceId,
          snapshotDigest: "a".repeat(64),
          observedAt: "2026-01-01T00:00:00.000Z",
          evaluatedAt: "2026-01-02T00:00:00.000Z",
          validUntil: "2026-02-01T00:00:00.000Z",
          requestId: crypto.randomUUID(),
          title: "Retained traffic finding",
          summary: "Fixture finding for retained traffic linkage.",
        });
      } finally {
        journal.close();
      }
    })();
    const workerRecheck = (() => {
      const journal = openSentinelWorkerFindingStore(path);
      try {
        return journal.recordRecheck({
          ...workerFinding,
          findingId: workerFinding.id,
          taskId: trafficTaskId,
          evidenceId: traffic.evidenceId,
          observedAt: "2026-01-02T00:00:00.000Z",
          evaluatedAt: "2026-01-03T00:00:00.000Z",
          outcome: "pass",
          summary: "Fixture remediation recheck.",
          requestId: crypto.randomUUID(),
        });
      } finally {
        journal.close();
      }
    })();
    const proofRequestId = crypto.randomUUID();
    assert(ensureSentinelFormalGoalContract(path, state));
    const goalProofReceipt = reportSentinelWorkerGoalProof(path, {
      revision: state.revision,
      assignmentId: sourceTaskId,
      targetId: "app",
      goalId: "review-source",
      criterionId: "saved-log",
      evidenceId,
      requestId: proofRequestId,
    }, () => true);
    assertEquals(goalProofReceipt?.status, "awaiting_confirmation");
    const interruptedProof = reportSentinelWorkerGoalProof(path, {
      revision: state.revision,
      assignmentId: interruptedTaskId,
      targetId: "app",
      goalId: "review-source",
      criterionId: "saved-log",
      evidenceId,
      requestId: interruptedProofRequestId,
    }, () => true);
    assertEquals(interruptedProof?.status, "awaiting_confirmation");
    const trafficScope = {
      kind: exact.kind,
      id: exact.id,
      revision: exact.revision,
      receiptId: workerFinding.id,
    };
    const topologyAction = {
      action: "topology_source",
      kind: exact.kind,
      id: exact.id,
      revision: exact.revision,
      evidenceId: cited.id,
      sourceCase,
    };
    const trafficSearch = {
      kind: exact.kind,
      id: exact.id,
      revision: exact.revision,
      action: "traffic_search",
      evidenceId: traffic.evidenceId,
    };
    const trafficGet = {
      ...trafficSearch,
      action: "traffic_get",
      digest: traffic.digest,
    };
    const trafficBlob = { ...trafficGet, action: "traffic_blob" };
    const requestBlob = { ...trafficBlob, payloadPart: "request" };
    const binaryBlob = {
      ...trafficBlob,
      evidenceId: binary.evidenceId,
      digest: binary.digest,
    };
    let originalBinary: unknown;
    const headerBlob = { ...trafficBlob, payloadPart: "headers" };
    let originalHeaders: unknown;
    let originalRequestPayload: unknown;
    let originalPayload: unknown;
    let originalTrafficResult: unknown;
    let originalTopology: unknown;
    let trafficLinkId!: string;
    let preArchiveTraffic: unknown;
    let preArchiveLinkedPayload: unknown;
    const findingPayload = () => ({
      ...trafficScope,
      action: "finding_traffic",
      trafficLinkId,
      payloadPart: "response",
    });
    await withGateway(baseDir, async (turn, _approvals, policy) => {
      policy.denyTrafficBefore = true;
      assert(!(await turn(trafficBlob)).includes("🙂"));
      assert(!(await turn(trafficSearch)).includes(traffic.digest));
      policy.denyTrafficBefore = false;
      const search = JSON.parse(await turn(trafficSearch));
      assertEquals(
        search.receipts.map(({ digest }: { digest: string }) => digest),
        [traffic.digest],
      );
      originalTrafficResult = JSON.parse(await turn(trafficGet));
      assert(!JSON.stringify(originalTrafficResult).includes(reviewedBody));
      const firstPayload = JSON.parse(await turn(trafficBlob));
      assertEquals(firstPayload.nextOffset, 512);
      const lastPayload = JSON.parse(
        await turn({ ...trafficBlob, offset: firstPayload.nextOffset }),
      );
      assertEquals(lastPayload.nextOffset, null);
      assertEquals(firstPayload.text + lastPayload.text, reviewedBody);
      assertEquals(
        firstPayload.responsePayload,
        search.receipts[0].responsePayload,
      );
      assertEquals(lastPayload.responsePayload, firstPayload.responsePayload);
      assertEquals(firstPayload.responsePayload, {
        encoding: "utf-8",
        byteLength: new TextEncoder().encode(reviewedBody).byteLength,
        sha256: createHash("sha256").update(
          firstPayload.text + lastPayload.text,
        ).digest("hex"),
      });
      originalPayload = firstPayload;
      const binaryFirst = JSON.parse(await turn(binaryBlob));
      assertEquals(binaryFirst.nextOffset, 512);
      const binaryLast = JSON.parse(
        await turn({ ...binaryBlob, offset: binaryFirst.nextOffset }),
      );
      assertEquals(binaryLast.nextOffset, null);
      assertEquals(
        Buffer.concat([
          Buffer.from(binaryFirst.base64, "base64"),
          Buffer.from(binaryLast.base64, "base64"),
        ]),
        binaryBody,
      );
      assertEquals(binaryFirst.responsePayload, {
        byteLength: binaryBody.length,
        encoding: "base64",
        sha256: createHash("sha256").update(binaryBody).digest("hex"),
      });
      originalBinary = binaryFirst;
      assert(!JSON.stringify(search).includes(reviewedRequest));
      const firstRequest = JSON.parse(await turn(requestBlob));
      const lastRequest = JSON.parse(
        await turn({ ...requestBlob, offset: firstRequest.nextOffset }),
      );
      assertEquals(firstRequest.text + lastRequest.text, reviewedRequest);
      assertEquals(
        firstRequest.requestPayload.sha256,
        createHash("sha256").update(reviewedRequest).digest("hex"),
      );
      assertEquals(
        firstRequest.requestPayload,
        search.receipts[0].requestPayload,
      );
      originalRequestPayload = firstRequest;
      const headers = JSON.parse(await turn(headerBlob));
      assertEquals(JSON.parse(headers.text), {
        request: [{ name: "Accept", value: "text/plain" }],
        response: [{
          name: "Content-Type",
          value: "text/plain; charset=utf-8",
        }],
      });
      assertEquals(headers.headersPayload, search.receipts[0].headersPayload);
      assertEquals(
        headers.headersPayload.sha256,
        createHash("sha256").update(headers.text).digest("hex"),
      );
      originalHeaders = headers;

      assertEquals(
        search.receipts[0],
        (originalTrafficResult as { receipt: unknown }).receipt,
      );
      policy.denyRunResponse = true;
      assert(!(await turn(trafficGet)).includes(traffic.digest));
      assert(!(await turn(trafficBlob)).includes("🙂"));
      policy.denyRunResponse = false;
      assertStringIncludes(
        await turn({ ...trafficGet, digest: "a".repeat(64) }),
        "unavailable",
      );
      assertStringIncludes(
        await turn({ ...trafficGet, id: "archive-peer" }),
        "unavailable",
      );
      const topology = JSON.parse(await turn(topologyAction));
      assertEquals(
        topology.evidence.archivedSource.relationship,
        originalSource.edges[0],
      );
      assertEquals(
        topology.evidence.archivedSource.snapshotDigest,
        shared[0].sourceDigests?.[sourceCase],
      );
      originalTopology = topology;
      const attachment = JSON.parse(
        await turn({
          ...trafficScope,
          action: "attach_finding_traffic",
          evidenceId: traffic.evidenceId,
          digest: traffic.digest,
          reportVersion: 1,
          requestId: crypto.randomUUID(),
        }),
      ).link;
      assert(attachment);
      trafficLinkId = attachment.id;
      const linkedPage = JSON.parse(await turn(findingPayload()));
      const linkedTail = JSON.parse(
        await turn({
          ...findingPayload(),
          offset: linkedPage.payload.nextOffset,
        }),
      );
      assertEquals(linkedPage.link.id, trafficLinkId);
      assertEquals(linkedPage.receipt.digest, traffic.digest);
      assertEquals(
        linkedPage.payload.text + linkedTail.payload.text,
        reviewedBody,
      );
      preArchiveLinkedPayload = linkedPage;
      assertStringIncludes(
        await turn({
          ...findingPayload(),
          receiptId: `worker-finding:${"0".repeat(64)}`,
        }),
        "unavailable",
      );
      assertStringIncludes(
        await turn({
          ...findingPayload(),
          revision: exact.revision + 1,
        }),
        "unavailable",
      );
      policy.denyRunResponse = true;
      assert(!(await turn(findingPayload())).includes("🙂"));
      policy.denyRunResponse = false;
      preArchiveTraffic = JSON.parse(
        await turn({
          ...trafficScope,
          action: "finding_traffic",
          trafficLinkId,
        }),
      );
      assertEquals(
        (preArchiveTraffic as { receipt: { digest: string } }).receipt.digest,
        traffic.digest,
      );
    });
    const plannerIdentity = `${revision}:obs:archive-fixture`;
    const overviewRegistry = createProviderRegistry();
    let plannerOverview = "";
    const overviewHooks: string[] = [];
    overviewRegistry.register({
      name: "planner-overview-fixture",
      supportsStreaming: false,
      complete(messages) {
        const result = messages.findLast(({ role }) => role === "tool");
        if (result) plannerOverview = String(result.content);
        return Promise.resolve({
          content: result ? "[]" : "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: result ? [] : [{
            type: "function",
            id: "planner-overview",
            function: { name: "sentinel_graph_overview", arguments: "{}" },
          }],
        });
      },
    });
    overviewRegistry.setDefault("planner-overview-fixture");
    const overviewJournal = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      await createSentinelSubagent({
        providerRegistry: overviewRegistry,
        snapshotPath: path,
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: state.plan.runId,
        allowModelAccess: true,
        hookRunner: {
          evaluateHook(hook, { input }) {
            if (input.tool_name === "sentinel_graph_overview") {
              overviewHooks.push(hook);
            }
            return Promise.resolve({
              allowed: true,
              action: "ALLOW",
              ruleId: null,
              duration: 0,
            });
          },
        },
      }).execute("Summarize the case graph.", () => {}, undefined, (step) => {
        assert(step.graphOverviewProjection && step.goalReceiptRead);
        assert(overviewJournal.recordModelPlanRead(plannerIdentity, 1, step));
      });
      const subsequent = overviewJournal.sync(revision, [{
        kind: "trace",
        nodeId: "later-record",
        depth: 9,
        reason: "Later planner overview evidence",
      }], revision);
      assert(
        subsequent.some(({ reason }) =>
          reason === "Later planner overview evidence"
        ),
      );
    } finally {
      overviewJournal.close();
    }
    const plannerTotals = JSON.parse(plannerOverview);
    assertEquals(plannerTotals.revision, state.revision);
    assert(plannerTotals.nodesByKind.finding > 0);
    assertEquals(overviewHooks, ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"]);
    const trafficLinkSelector = {
      revision: state.revision,
      findingId: workerFinding.id,
      limit: 1,
    };
    let plannerFindingResults: string[] = [];
    const plannerFindingCalls = [
      { name: "sentinel_finding_traffic_links", args: trafficLinkSelector },
      {
        name: "sentinel_worker_findings",
        args: { receiptId: workerRecheck.id },
      },
      {
        name: "sentinel_worker_findings",
        args: { revision: state.revision, limit: 1 },
      },
    ];
    const trafficLinkRegistry = createProviderRegistry();
    trafficLinkRegistry.register({
      name: "planner-traffic-links",
      supportsStreaming: false,
      complete(messages) {
        plannerFindingResults = messages.filter(({ role }) => role === "tool")
          .map(({ content }) => String(content));
        const call = plannerFindingCalls[plannerFindingResults.length];
        return Promise.resolve({
          content: call ? "" : "[]",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: call
            ? [{
              id: "read-finding-result-" + plannerFindingResults.length,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            }]
            : [],
        });
      },
    });
    trafficLinkRegistry.setDefault("planner-traffic-links");
    const trafficLinkPlanner = createSentinelSubagent({
      providerRegistry: trafficLinkRegistry,
      snapshotPath: path,
      assessmentRevision: state.revision,
      plannerExecutionEvidenceRunId: state.plan.runId,
      sharedInventoryBaseDir: baseDir,
      allowModelAccess: true,
      hookRunner: {
        evaluateHook: () =>
          Promise.resolve({
            allowed: true,
            action: "ALLOW",
            ruleId: null,
            duration: 0,
          }),
      },
    });
    const trafficLinkJournal = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      await trafficLinkPlanner.execute(
        "Read the saved finding evidence links.",
        () => {},
        undefined,
        (step) => {
          assert(step.trafficLinks || step.goalReceiptRead);
          assert(
            trafficLinkJournal.recordModelPlanRead(plannerIdentity, 1, step),
          );
        },
      );
      trafficLinkJournal.completeModelPlan(
        plannerIdentity,
        1,
        "no_new_assignments",
      );
    } finally {
      trafficLinkJournal.close();
    }
    const [plannerTrafficResult, plannerRecheckResult, plannerFindingPage] =
      plannerFindingResults;
    assertEquals(JSON.parse(plannerRecheckResult).record.id, workerRecheck.id);
    assertEquals(
      JSON.parse(plannerFindingPage).records[0].id,
      workerRecheck.id,
    );
    assertEquals(JSON.parse(plannerTrafficResult).links[0].id, trafficLinkId);
    assert(stopSentinelAssessment(path));
    const archiveId = crypto.randomUUID();
    const request = { action: "archive", ...exact, requestId: archiveId };
    const restore = {
      action: "restore",
      ...exact,
      archiveId,
      requestId: crypto.randomUUID(),
    };
    const peerPath = resolveSentinelCasePath(baseDir, "archive-peer");
    await Deno.mkdir(dirname(peerPath), { recursive: true });
    await Deno.copyFile(path, peerPath);
    const peer = startSentinelAssessment(peerPath);
    const linkRequest = {
      action: "link",
      kind: "sentinel",
      id: exact.id,
      revision: exact.revision,
      targetKind: "sentinel",
      targetId: "archive-peer",
      targetRevision: peer.revision,
      requestId: crypto.randomUUID(),
    };
    const earlierLinkRequest = {
      ...linkRequest,
      revision: initial.revision,
      requestId: crypto.randomUUID(),
    };
    const linkPath = join(baseDir, "operator-run-links.db");
    let exactLink: unknown;
    let earlierLink: unknown;
    let archiveReceipt: unknown;
    await withGateway(baseDir, async (turn, approvals, policy) => {
      policy.denyArchive = true;
      assert((await turn(request)).length);
      assertEquals(approvals, []);
      policy.denyArchive = false;
      exactLink = JSON.parse(await turn(linkRequest)).link;
      assert(exactLink);
      earlierLink = JSON.parse(await turn(earlierLinkRequest)).link;
      assert(earlierLink);
      archiveReceipt = JSON.parse(await turn(request)).receipt;
      assertEquals((archiveReceipt as { status: string }).status, "succeeded");
      assertEquals(JSON.parse(await turn(request)).receipt, archiveReceipt);
      assertEquals(approvals.length, 3);
      const collision =
        JSON.parse(await turn({ ...restore, requestId: crypto.randomUUID() }))
          .receipt;
      assertEquals(collision.status, "failed");
      assertEquals(readSentinelFindingReviews(path, state.revision), decision);
    });

    const sourceDigest = shared[0].sourceDigests?.[sourceCase];
    assert(sourceDigest);
    const workspaceSource = sentinelSourceSnapshotPath(
      baseDir,
      sourceCase,
      sourceDigest,
    );
    await Deno.remove(workspaceSource);
    const workspaceFinding = sentinelSourceSnapshotPath(
      baseDir,
      sourceCase,
      findingDigest,
    );
    await Deno.remove(workspaceFinding);
    for (const { caseId, snapshotDigest } of auxiliaryMappings) {
      await Deno.remove(
        sentinelSourceSnapshotPath(baseDir, caseId, snapshotDigest),
      );
    }
    await Deno.remove(
      sentinelSourceSnapshotPath(baseDir, mappingCase, mappingDigest),
    );
    const workspaceTrace = sentinelSourceSnapshotPath(
      baseDir,
      sourceCase,
      traceDigest,
    );
    await Deno.remove(
      sentinelSourceSnapshotPath(
        baseDir,
        plannerAliasSource,
        plannerAliasDigest,
      ),
    );
    await Deno.remove(workspaceTrace);
    await Deno.remove(interruptedLinkPath);
    await Deno.remove(
      sentinelSourceSnapshotPath(baseDir, sourceCase, interruptedFindingDigest),
    );
    await Deno.remove(
      sentinelSourceSnapshotPath(
        baseDir,
        interruptedAliasCase,
        aliasOnlyDigest,
      ),
    );
    await Deno.remove(
      sentinelSourceSnapshotPath(baseDir, aliasOnlySource, aliasOnlyDigest),
    );
    const workspaceAssessment = sentinelSourceSnapshotPath(
      baseDir,
      sourceCase,
      assessmentDigest,
    );
    await Deno.remove(workspaceAssessment);
    const workspacePlanner = sentinelSourceSnapshotPath(
      baseDir,
      sourceCase,
      plannerDigest,
    );
    await Deno.remove(workspacePlanner);
    await Deno.rename(dirname(path), join(baseDir, "original-fixture"));
    await Deno.rename(linkPath, join(baseDir, "old-links.db"));
    const packageFile = join(
      baseDir,
      "data",
      "run-archives",
      archiveId,
      "sentinel.json",
    );
    assert(uncompressedMappingBytes > maxSentinelArchivedTopologyBytes);
    const findingBundle = join(
      dirname(packageFile),
      sentinelArchivedFindingSourcesFile,
    );
    const findingEntries = JSON.parse(await Deno.readTextFile(findingBundle));
    assertEquals(
      findingEntries.filter(({ gzip }: { gzip?: string }) => gzip).length,
      auxiliaryMappings.length,
    );
    assert(
      (await Deno.stat(findingBundle)).size <
        maxSentinelArchivedTopologyBytes / 4,
    );
    for await (const artifact of Deno.readDir(dirname(packageFile))) {
      if (!artifact.isFile) continue;
      const contents = await Deno.readFile(
        join(dirname(packageFile), artifact.name),
      );
      assert(!new TextDecoder().decode(contents).includes(privateToken));
    }
    const content = await Deno.readTextFile(packageFile);
    const peerBeforeFailures = readSentinelAssessment(peerPath);
    assert(peerBeforeFailures);
    // A valid package manifest can still omit an evidence dependency.
    const archiveDirectory = dirname(packageFile);
    const archivedAdaptive = await Deno.readFile(
      join(archiveDirectory, "sentinel-adaptive.db"),
    );
    assert(
      !new TextDecoder().decode(archivedAdaptive).includes(privateProgress),
    );
    assert(
      !new TextDecoder().decode(archivedAdaptive).includes(
        '"trafficSearch":{"args"',
      ),
    );
    const manifest = JSON.parse(
      await Deno.readTextFile(join(archiveDirectory, "manifest.json")),
    );
    const incompletePackage = join(baseDir, "missing-trace-source");
    await writeRunArchive(
      incompletePackage,
      manifest.identity,
      manifest.artifacts
        .filter(({ name }: { name: string }) =>
          name !== sentinelArchivedTraceSourcesFile
        )
        .map(({ name }: { name: string }) => ({
          name,
          sourcePath: join(archiveDirectory, name),
        })),
      permittedSentinelRestoreArtifacts,
    );
    await assertRejects(
      () =>
        withVerifiedRunArchive(incompletePackage, baseDir, {
          expectedKind: "sentinel",
          permittedNames: permittedSentinelRestoreArtifacts,
        }, (archive) => restoreVerifiedSentinelCaseArchive(baseDir, archive)),
      Error,
      "Archived source bundle is missing",
    );
    await assertRejects(() => Deno.lstat(dirname(path)), Deno.errors.NotFound);
    assertEquals(readSentinelAssessment(peerPath), peerBeforeFailures);

    let nativeArchiveRevision: number;
    let nativePlannerIdentity: string;
    let nativePlannerResponse: string;
    const nativeArchiveId = crypto.randomUUID();
    let nativeEvidenceId: string;
    await withGateway(baseDir, async (turn, approvals, policy) => {
      await Deno.writeTextFile(packageFile, "corrupt");
      const corrupt =
        JSON.parse(await turn({ ...restore, requestId: crypto.randomUUID() }))
          .receipt;
      assertEquals(corrupt.status, "failed");
      await assertRejects(() => Deno.lstat(path), Deno.errors.NotFound);
      assertEquals(readSentinelAssessment(peerPath), peerBeforeFailures);
      await Deno.writeTextFile(packageFile, content);
      for (
        const name of ["sentinel-adaptive.db", "sentinel-traffic-receipts.db"]
      ) {
        const artifact = join(dirname(packageFile), name);
        const savedArtifact = join(baseDir, `saved-${name}`);
        await Deno.rename(artifact, savedArtifact);
        const incomplete =
          JSON.parse(await turn({ ...restore, requestId: crypto.randomUUID() }))
            .receipt;
        assertEquals(incomplete.status, "failed");
        await assertRejects(
          () => Deno.lstat(dirname(path)),
          Deno.errors.NotFound,
        );
        assertEquals(readSentinelAssessment(peerPath), peerBeforeFailures);
        await Deno.rename(savedArtifact, artifact);
      }
      const conflictingLinks = openOperatorRunLinkStore(linkPath);
      try {
        conflictingLinks.record({
          scope: "workspace-operator",
          operatorId: "owner",
          requestId: linkRequest.requestId,
          left: { kind: "sentinel", id: exact.id, revision: exact.revision },
          right: { kind: "workflow", id: crypto.randomUUID() },
        });
      } finally {
        conflictingLinks.close();
      }
      const linkCollision = JSON.parse(
        await turn({
          ...restore,
          requestId: crypto.randomUUID(),
        }),
      ).receipt;
      assertEquals(linkCollision.status, "failed");
      const afterCollision = openOperatorRunLinkStore(linkPath);
      try {
        assertEquals(
          afterCollision.readRequest(
            "workspace-operator",
            "owner",
            earlierLinkRequest.requestId,
          ),
          undefined,
        );
      } finally {
        afterCollision.close();
      }
      await assertRejects(
        () => Deno.lstat(dirname(path)),
        Deno.errors.NotFound,
      );
      await Deno.rename(linkPath, join(baseDir, "conflicting-links.db"));
      const interruptedRequestId = crypto.randomUUID();
      const interrupted = { ...restore, requestId: interruptedRequestId };
      await killRestoreAtPublication(
        baseDir,
        interrupted,
        "before",
        async () => {
          const count = approvals.length;
          assertEquals(
            JSON.parse(await turn(interrupted)).receipt.status,
            "pending",
          );
          assertEquals(approvals.length, count);
        },
      );
      const partial = join(dirname(path), "sentinel-assessment.db");
      const archivedAssessment = await Deno.readFile(partial);
      await assertRejects(() => Deno.lstat(path), Deno.errors.NotFound);
      assertStringIncludes(
        await turn({
          action: "inspect",
          kind: "sentinel",
          id: exact.id,
          revision: exact.revision,
        }),
        "unavailable",
      );
      await Deno.writeTextFile(partial, "operator-changed-partial");
      const changedPartial = JSON.parse(
        await turn({
          ...restore,
          requestId: crypto.randomUUID(),
        }),
      ).receipt;
      assertEquals(changedPartial.status, "failed");
      assertEquals(
        await Deno.readTextFile(partial),
        "operator-changed-partial",
      );
      await Deno.writeFile(partial, archivedAssessment);
      const beforeRetry = approvals.length;
      const first = JSON.parse(await turn(interrupted)).receipt;
      assertEquals(first.status, "succeeded");
      assertEquals(first.requestId, interruptedRequestId);
      assertEquals(JSON.parse(await turn(interrupted)).receipt, first);
      assertEquals(approvals.length, beforeRetry);
      assertEquals(JSON.parse(await turn(request)).receipt, archiveReceipt);
      const restored = readSentinelAssessment(path);
      assert(restored?.paused);
      assertEquals(restored.plan.runId, state.plan.runId);
      const interruptedTrace = JSON.parse(
        await turn({
          action: "worker_trace_progress",
          kind: "sentinel",
          id: exact.id,
          revision: state.revision,
          taskId: interruptedTaskId,
          stepIndices: [0],
        }),
      );
      assertEquals(interruptedTrace.status, "interrupted");
      assertEquals(interruptedTrace.archived, true);
      assertEquals(interruptedTrace.page.steps, [{
        index: 0,
        tool: "sentinel_assigned_target",
        target: "app",
        outcome: "returned",
      }]);
      const interruptedReceipt = JSON.parse(
        await turn({
          action: "worker_trace_result",
          kind: "sentinel",
          id: exact.id,
          revision: state.revision,
          taskId: interruptedTaskId,
          stepIndices: [1],
        }),
      );
      assertEquals(interruptedReceipt.result, {
        _classification: "INTERNAL",
        ...interruptedProof,
      });
      const trafficResult = JSON.parse(
        await turn({
          action: "worker_trace_result",
          kind: "sentinel",
          id: exact.id,
          revision: state.revision,
          taskId: trafficTaskId,
          stepIndices: [0],
        }),
      );
      const workflowTrace = {
        action: "worker_trace_result",
        kind: "sentinel",
        id: exact.id,
        revision: state.revision,
        taskId: interruptedTaskId,
        stepIndices: [2],
      };
      const assetLinksTrace = { ...workflowTrace, stepIndices: [3] };
      assertEquals(
        JSON.parse(await turn(assetLinksTrace)).result,
        assetLinksPage,
      );
      assertStringIncludes(
        await turn({ ...assetLinksTrace, stepIndices: [4] }),
        "unavailable",
      );
      const interruptedSource = {
        ...assetLinksTrace,
        action: "worker_trace_source",
        sourceCase,
        snapshotDigest: interruptedLinkDigest,
        assetId: interruptedLinkReference.assetId,
      };
      assertEquals(JSON.parse(await turn(interruptedSource)).source, {
        caseId: sourceCase,
        snapshotDigest: interruptedLinkDigest,
        asset: interruptedLinkSnapshot.nodes.find(({ id }) =>
          id === interruptedLinkReference.assetId
        ),
      });
      assertStringIncludes(
        await turn({ ...interruptedSource, snapshotDigest: traceDigest }),
        "unavailable",
      );
      const { assetId: _asset, ...interruptedAliasRead } = interruptedSource;
      assertEquals(
        JSON.parse(
          await turn({
            ...interruptedAliasRead,
            sourceCase: interruptedAliasCase,
            snapshotDigest: aliasOnlyDigest,
          }),
        ).source,
        {
          caseId: interruptedAliasCase,
          snapshotDigest: aliasOnlyDigest,
          aliasProof: mappingProof,
        },
      );
      policy.denySharedAssetLinks = true;
      assertStringIncludes(await turn(assetLinksTrace), "unavailable");
      assertStringIncludes(await turn(interruptedSource), "unavailable");
      policy.denySharedAssetLinks = false;
      const findingRead = { ...workflowTrace, stepIndices: [5] };
      assertEquals(
        JSON.parse(await turn(findingRead)).result,
        JSON.parse(interruptedFindingText),
      );
      assertEquals(
        JSON.parse(
          await turn({
            ...findingRead,
            action: "worker_trace_source",
            sourceCase,
            snapshotDigest: interruptedFindingDigest,
            assetId: findingArgs.sourceAsset,
          }),
        ).source,
        {
          caseId: sourceCase,
          snapshotDigest: interruptedFindingDigest,
          asset: interruptedFinding.nodes.find(({ id }) =>
            id === findingArgs.sourceAsset
          ),
        },
      );
      assertEquals(
        JSON.parse(await turn({ ...workflowTrace, stepIndices: [6] })).result,
        JSON.parse(interruptedTopologyText),
      );
      const workflowResult = JSON.parse(await turn(workflowTrace)).result;
      assertEquals(workflowResult, { targetId: "app", ...workflowReceipt });
      assertEquals(policy.workflowMetadataCalls, 1);
      policy.denyWorkflowMetadata = true;
      assertStringIncludes(await turn(workflowTrace), "unavailable");
      assertEquals(policy.workflowMetadataCalls, 2);
      policy.denyWorkflowMetadata = false;
      const selectedRun = { ...workflowTrace, workflowRunNumber: 17 };
      const candidate = JSON.parse(await turn(selectedRun)).result;
      assertEquals(candidate, {
        targetId: "app",
        sourceResultSha256: workflowReceipt.resultSha256,
        outcome: "pass",
        payload: {
          kind: "github_actions_status",
          repo: "owner/repo",
          repositoryId: 8642,
          workflow: "22",
          runs: [{
            id: 17,
            status: "completed",
            conclusion: "success",
            created_at: "2026-01-01T00:00:00.000Z",
          }],
        },
      });
      assertStringIncludes(
        await turn({ ...selectedRun, workflowRunNumber: 99 }),
        "unavailable",
      );
      assertEquals(policy.workflowMetadataCalls, 3);
      policy.denyWorkflowMetadata = true;
      assertStringIncludes(await turn(selectedRun), "unavailable");
      policy.denyWorkflowMetadata = false;
      assertEquals(trafficResult.result, page);
      assertEquals(restored.plan.formalGoals, goals);
      assertEquals(restored.revision, state.revision);
      assertEquals(
        readSentinelWorkerGoalProofReceipt(
          path,
          restored,
          sourceTaskId,
          "app",
          proofRequestId,
        )?.receipt,
        goalProofReceipt,
      );

      assertEquals(JSON.parse(await turn(topologyAction)), originalTopology);
      await assertRejects(
        () => Deno.lstat(workspaceSource),
        Deno.errors.NotFound,
      );
      assertStringIncludes(
        await turn({ ...topologyAction, sourceCase: "archive-peer" }),
        "unavailable",
      );
      const reopenedTraffic = await turn({
        ...trafficScope,
        action: "finding_traffic",
        trafficLinkId,
      });
      assertEquals(JSON.parse(reopenedTraffic), preArchiveTraffic);
      assertEquals(
        JSON.parse(await turn(findingPayload())),
        preArchiveLinkedPayload,
      );
      assertEquals(JSON.parse(await turn(trafficGet)), originalTrafficResult);
      assertEquals(JSON.parse(await turn(trafficBlob)), originalPayload);
      assertEquals(JSON.parse(await turn(binaryBlob)), originalBinary);
      assertEquals(JSON.parse(await turn(requestBlob)), originalRequestPayload);
      assertEquals(JSON.parse(await turn(headerBlob)), originalHeaders);
      assertStringIncludes(
        await turn({ ...trafficBlob, id: "archive-peer" }),
        "unavailable",
      );
      assertStringIncludes(
        await turn({ ...trafficBlob, digest: "a".repeat(64) }),
        "unavailable",
      );
      const exactTraffic = await turn(trafficSearch);
      assert(!exactTraffic.includes(privateToken));
      assert(!exactTraffic.includes("/private"));
      assert(!reopenedTraffic.includes(privateToken));
      assert(!reopenedTraffic.includes("/private"));
      assertEquals(
        readSentinelFindingReviews(path, restored.revision),
        decision,
      );
      const adaptive = readAdaptiveSentinel(path, restored, "revision");
      const source = adaptive?.tasks.find(({ id }) => id === sourceTaskId);
      const dependent = adaptive?.tasks.find(({ id }) => id === dependentId);
      assertEquals(source?.status, "completed");
      assertEquals(source?.observation, observation);
      const workerResults = {
        action: "worker_observations",
        kind: exact.kind,
        id: exact.id,
        revision: exact.revision,
      };
      const found = JSON.parse(
        await turn({ ...workerResults, query: "Reviewed the retained record" }),
      );
      assertEquals(
        found.page.observations.map(({ id }: { id: string }) => id),
        [sourceTaskId],
      );
      const exactOutput = { ...workerResults, taskId: sourceTaskId };
      const firstOutput = JSON.parse(await turn(exactOutput)).page;
      assertEquals(firstOutput.nextOffset, 1000);
      const secondOutput = JSON.parse(
        await turn({ ...exactOutput, offset: firstOutput.nextOffset }),
      ).page;
      assertEquals(secondOutput.nextOffset, null);
      assertEquals(
        secondOutput.observationSha256,
        firstOutput.observationSha256,
      );
      assertEquals(
        JSON.parse(firstOutput.observationJson + secondOutput.observationJson),
        observation,
      );
      for (
        const mismatch of [{ revision: initial.revision }, {
          id: "archive-peer",
        }, { taskId: dependentId }]
      ) {
        assertStringIncludes(
          await turn({ ...exactOutput, ...mismatch }),
          "unavailable",
        );
      }
      policy.denyRunResponse = true;
      assertEquals(
        await turn(exactOutput),
        "Tool response withheld by policy.",
      );
      policy.denyRunResponse = false;
      assertEquals(
        adaptive?.modelReviews.find(({ taskId }) => taskId === sourceTaskId)
          ?.steps?.[0]?.sourceSnapshots,
        [traceReference],
      );
      assertEquals(
        await readArchivedSentinelSnapshot(
          baseDir,
          sourceCase,
          traceDigest,
          path,
        ),
        traceSnapshot,
      );
      await assertRejects(
        () => Deno.lstat(workspaceTrace),
        Deno.errors.NotFound,
      );
      const workerSource = {
        action: "worker_trace_source",
        kind: exact.kind,
        id: exact.id,
        revision: exact.revision,
        taskId: sourceTaskId,
        stepIndices: [0],
        sourceCase,
        snapshotDigest: traceDigest,
        assetId: traceReference.assetId,
      };
      const { assetId: _assetId, ...traceScope } = workerSource;
      const aliasRead = {
        ...traceScope,
        sourceCase: aliasOnlySource,
        snapshotDigest: aliasOnlyDigest,
      };
      assertEquals(JSON.parse(await turn(aliasRead)).source, {
        caseId: aliasOnlySource,
        snapshotDigest: aliasOnlyDigest,
        aliasProof: aliasMapping.proof,
      });
      assertEquals(
        await readArchivedSentinelSnapshot(
          baseDir,
          aliasOnlySource,
          aliasOnlyDigest,
          path,
        ),
        aliasOnlySnapshot,
      );
      assertStringIncludes(
        await turn({ ...aliasRead, sourceCase }),
        "unavailable",
      );
      const workerSourceResult = JSON.parse(await turn(workerSource));
      assertEquals(workerSourceResult.stepIndex, 0);
      assertEquals(workerSourceResult.source, {
        caseId: sourceCase,
        snapshotDigest: traceDigest,
        asset: traceSnapshot.nodes.find(({ id }) =>
          id === traceReference.assetId
        ),
      });
      policy.workerSourceHooks.length = 0;
      policy.denyWorkerSourceBefore = true;
      assertStringIncludes(await turn(workerSource), "unavailable");
      assertEquals(policy.workerSourceHooks.splice(0), ["PRE_TOOL_CALL"]);
      policy.denyWorkerSourceBefore = false;
      policy.denyWorkerSourceAfter = true;
      assertStringIncludes(await turn(workerSource), "unavailable");
      assertEquals(policy.workerSourceHooks.splice(0), [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]);
      policy.denyWorkerSourceAfter = false;
      for (
        const mismatch of [
          { stepIndices: [1] },
          { id: "archive-peer" },
          { revision: initial.revision },
          { snapshotDigest: plannerDigest },
        ]
      ) {
        assertStringIncludes(
          await turn({ ...workerSource, ...mismatch }),
          "unavailable",
        );
      }
      const handleTidepool = createTidepoolSentinelHandler(
        { baseDir, config: {} } as BootstrapResult,
      );
      const aliasReply = async (request: Record<string, unknown>) => {
        const replies: Record<string, unknown>[] = [];
        await handleTidepool({
          type: "alias_source_snapshot",
          caseId: exact.id,
          revision: exact.revision,
          stepIndex: 0,
          requestId: 32,
          ...request,
        }, {
          readyState: WebSocket.OPEN,
          send: (message: string) => replies.push(JSON.parse(message)),
        } as unknown as WebSocket);
        return replies[0];
      };
      const workerAliasRequest = {
        traceKind: "worker",
        traceId: sourceTaskId,
        sourceCase: aliasOnlySource,
        snapshotDigest: aliasOnlyDigest,
      };
      assertEquals(await aliasReply(workerAliasRequest), {
        topic: "sentinel",
        type: "sentinel_alias_source_snapshot",
        requestId: 32,
        caseId: exact.id,
        sourceCase: aliasOnlySource,
        snapshotDigest: aliasOnlyDigest,
        aliasProof: aliasMapping.proof,
        graph: aliasOnlySnapshot,
      });
      assertEquals(
        (await aliasReply({
          traceKind: "planner",
          traceId: `${revision}:obs:archive-fixture`,
          attempt: 1,
          sourceCase: plannerAliasSource,
          snapshotDigest: plannerAliasDigest,
        })).aliasProof,
        plannerAliasMapping.proof,
      );
      assertEquals(
        (await aliasReply({
          traceKind: "assessment",
          traceId: assessmentTask.id,
          sourceCase,
          snapshotDigest: assessmentDigest,
        })).graph,
        assessmentSnapshot,
      );
      for (
        const mismatch of [
          { stepIndex: 1 },
          { revision: initial.revision },
          { snapshotDigest: traceDigest },
          { caseId: "archive-peer" },
        ]
      ) {
        const rejected = await aliasReply({
          ...workerAliasRequest,
          ...mismatch,
        });
        assertEquals(rejected.type, "error");
        assertEquals(rejected.graph, undefined);
      }
      const messages: Record<string, unknown>[] = [];
      await handleTidepool({
        type: "source_snapshot",
        caseId: exact.id,
        sourceCase,
        snapshotDigest: traceDigest,
        asset: traceReference.assetId,
      }, {
        readyState: WebSocket.OPEN,
        send: (message: string) => messages.push(JSON.parse(message)),
      } as unknown as WebSocket);
      assertEquals(messages[0]?.type, "sentinel_source_snapshot");
      assertEquals(messages[0]?.graph, traceSnapshot);
      assertEquals(messages[0]?.citations, [{
        caseId: exact.id,
        revision: exact.revision,
        focusId: `observation:adaptive:review:${sourceTaskId}`,
      }]);
      await handleTidepool({
        type: "source_snapshot",
        caseId: exact.id,
        sourceCase,
        snapshotDigest: assessmentDigest,
        asset: "source-app",
      }, {
        readyState: WebSocket.OPEN,
        send: (message: string) => messages.push(JSON.parse(message)),
      } as unknown as WebSocket);
      assertEquals(messages[1]?.type, "sentinel_source_snapshot");
      assertEquals(messages[1]?.graph, assessmentSnapshot);
      assertEquals(messages[1]?.citations, [{
        caseId: exact.id,
        revision: exact.revision,
        focusId: `review:assessment:${assessmentTask.id}`,
      }]);
      await assertRejects(
        () => Deno.lstat(workspaceAssessment),
        Deno.errors.NotFound,
      );
      const assessmentReview = {
        action: "assessment_review",
        kind: exact.kind,
        id: exact.id,
        revision: exact.revision,
      };
      assertEquals(JSON.parse(await turn(assessmentReview)).reviews, [
        { taskId: assessmentTask.id, stepCount: 1 },
      ]);
      const reviewStep = {
        ...assessmentReview,
        taskId: assessmentTask.id,
        stepIndices: [0],
      };
      const [citation] =
        JSON.parse(await turn(reviewStep)).step.sourceSnapshots;
      const followReview = {
        ...reviewStep,
        sourceCase: citation.caseId,
        snapshotDigest: citation.snapshotDigest,
        assetId: citation.assetId,
      };
      assertEquals(JSON.parse(await turn(followReview)).source, {
        caseId: sourceCase,
        snapshotDigest: assessmentDigest,
        asset: assessmentSnapshot.nodes.find(({ id }) => id === "source-app"),
      });
      for (
        const mismatch of [
          { revision: initial.revision },
          { id: "archive-peer" },
          { snapshotDigest: traceDigest },
          { stepIndices: [1] },
        ]
      ) {
        assertStringIncludes(
          await turn({ ...followReview, ...mismatch }),
          "unavailable",
        );
      }
      policy.denyRunResponse = true;
      assertEquals(
        await turn(followReview),
        "Tool response withheld by policy.",
      );
      policy.denyRunResponse = false;
      const plannerQuery = {
        action: "planner_reads",
        kind: exact.kind,
        id: exact.id,
        revision: exact.revision,
      };
      const plannerPage = JSON.parse(await turn(plannerQuery));
      assertEquals(plannerPage.page, [{
        plannerIdentity: `${revision}:obs:archive-fixture`,
        attempt: 1,
        readCount: 5,
      }]);
      const exactRead = {
        ...plannerQuery,
        plannerIdentity: plannerPage.page[0].plannerIdentity,
        attempt: plannerPage.page[0].attempt,
        ordinal: 1,
      };
      assertEquals(JSON.parse(await turn(exactRead)).read, plannerRead);
      const plannerOverviewRead = {
        ...exactRead,
        ordinal: 2,
        includeResult: true,
      };
      assertEquals(
        JSON.stringify(JSON.parse(await turn(plannerOverviewRead)).result),
        plannerOverview,
      );
      policy.denyWorkerSourceAfter = true;
      assertStringIncludes(await turn(plannerOverviewRead), "unavailable");
      policy.denyWorkerSourceAfter = false;
      const trafficLinkRead = { ...exactRead, ordinal: 3, includeResult: true };
      assertEquals(
        JSON.stringify(JSON.parse(await turn(trafficLinkRead)).result),
        plannerTrafficResult,
      );
      policy.denyWorkerSourceAfter = true;
      assertStringIncludes(await turn(trafficLinkRead), "unavailable");
      policy.denyWorkerSourceAfter = false;
      for (
        const [ordinal, original] of [[4, plannerRecheckResult], [
          5,
          plannerFindingPage,
        ]] as const
      ) {
        const read = { ...exactRead, ordinal, includeResult: true };
        assertEquals(
          JSON.stringify(JSON.parse(await turn(read)).result),
          original,
        );
        policy.denyWorkerSourceAfter = true;
        assertStringIncludes(await turn(read), "unavailable");
        policy.denyWorkerSourceAfter = false;
      }

      assertEquals(
        JSON.parse(
          await turn({
            ...exactRead,
            sourceCase: plannerAliasSource,
            snapshotDigest: plannerAliasDigest,
          }),
        ).source,
        {
          caseId: plannerAliasSource,
          snapshotDigest: plannerAliasDigest,
          aliasProof: plannerAliasMapping.proof,
        },
      );
      const followPlannerSource = {
        ...exactRead,
        sourceCase,
        snapshotDigest: plannerDigest,
        assetId: "source-app",
      };
      assertEquals(JSON.parse(await turn(followPlannerSource)).source, {
        caseId: sourceCase,
        snapshotDigest: plannerDigest,
        asset: plannerSnapshot.nodes.find(({ id }) => id === "source-app"),
      });
      for (
        const mismatch of [
          { snapshotDigest: findingDigest },
          { assetId: "source-db" },
          { sourceCase: "archive-peer" },
        ]
      ) {
        assertStringIncludes(
          await turn({ ...followPlannerSource, ...mismatch }),
          "unavailable",
        );
      }
      for (const sourceRead of [followReview, followPlannerSource]) {
        policy.workerSourceHooks.length = 0;
        policy.denyWorkerSourceBefore = true;
        assertStringIncludes(await turn(sourceRead), "unavailable");
        assertEquals(policy.workerSourceHooks.splice(0), ["PRE_TOOL_CALL"]);
        policy.denyWorkerSourceBefore = false;
        policy.denyWorkerSourceAfter = true;
        assertStringIncludes(await turn(sourceRead), "unavailable");
        assertEquals(policy.workerSourceHooks.splice(0), [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
        ]);
        policy.denyWorkerSourceAfter = false;
      }
      policy.denyRunResponse = true;
      assertEquals(await turn(exactRead), "Tool response withheld by policy.");
      assertEquals(
        await turn(followPlannerSource),
        "Tool response withheld by policy.",
      );
      policy.denyRunResponse = false;
      for (
        const mismatch of [
          { revision: initial.revision },
          { id: "archive-peer" },
          { ordinal: 6 },
        ]
      ) {
        assertStringIncludes(
          await turn({ ...exactRead, ...mismatch }),
          "unavailable",
        );
      }
      assertEquals(
        adaptive?.modelPlannerHistory?.flatMap(({ reads }) => reads ?? []).find(
          ({ tool }) => tool === plannerRead.tool,
        ),
        plannerRead,
      );
      assertEquals(
        await readArchivedSentinelSnapshot(
          baseDir,
          sourceCase,
          plannerDigest,
          path,
        ),
        plannerSnapshot,
      );
      await assertRejects(
        () => Deno.lstat(workspacePlanner),
        Deno.errors.NotFound,
      );
      assertEquals(source?.plannerRound?.peerFindingCitations, [
        findingCitation,
      ]);
      const graphSnapshot = restored.result?.sharedGraph.snapshot;
      assert(graphSnapshot);
      assertEquals(
        await readPinnedSentinelSharedFindingSource(
          baseDir,
          graphSnapshot,
          {
            localAssetId: "app",
            caseId: sourceCase,
            assetId: "source-app",
            findingId: "borrowed-finding",
            snapshotDigest: findingDigest,
          },
          "restorable",
          path,
          mappingSources,
        ),
        findingSource,
      );
      await assertRejects(
        () => Deno.lstat(workspaceFinding),
        Deno.errors.NotFound,
      );
      assertEquals(dependent?.status, "queued");
      assertEquals(dependent?.prerequisites, [sourceTaskId]);
      assertEquals(dependent?.evidenceIds, [evidenceId]);
      const overviewRequest = {
        action: "graph_overview",
        kind: "sentinel",
        id: exact.id,
        revision: exact.revision,
      };
      const { overview } = JSON.parse(await turn(overviewRequest));
      assertEquals(overview.revision, exact.revision);
      assert(overview.nodeCount > plannerTotals.nodeCount);
      assert(overview.nodesByKind.finding > 0);
      assert(overview.edgesByRelation.affects > 0);
      assertEquals(
        overview.nodeCount,
        Object.values(overview.nodesByKind)
          .reduce<number>((total, count) => total + Number(count), 0),
      );
      assertStringIncludes(
        await turn({ ...overviewRequest, revision: exact.revision + 1 }),
        "unavailable",
      );
      policy.denyRunResponse = true;
      assertEquals(
        await turn(overviewRequest),
        "Tool response withheld by policy.",
      );
      policy.denyRunResponse = false;
      const graph = JSON.parse(
        await turn({
          action: "node",
          kind: "sentinel",
          id: exact.id,
          revision: exact.revision,
          node: `evidence:${evidenceId}`,
        }),
      );
      assertEquals(graph.page.node.id, `evidence:${evidenceId}`);
      const reopened = JSON.parse(
        await turn({
          action: "inspect",
          kind: "sentinel",
          id: exact.id,
          revision: exact.revision,
        }),
      );
      assertEquals(reopened.links, [exactLink]);
      assertEquals(JSON.parse(await turn(linkRequest)).link, exactLink);
      const earlier = JSON.parse(
        await turn({
          action: "inspect",
          kind: "sentinel",
          id: exact.id,
          revision: initial.revision,
        }),
      );
      assertEquals(earlier.run.status, "saved");
      assertEquals(earlier.links, [earlierLink]);
      assertEquals(
        JSON.parse(await turn(earlierLinkRequest)).link,
        earlierLink,
      );
      const history = JSON.parse(
        await turn({ action: "archive_history", ...exact }),
      );
      assertEquals(
        history.records.map(({ status }: { status: string }) => status),
        [
          "failed",
          "succeeded",
          "failed",
          "failed",
          "failed",
          "failed",
          "failed",
          "succeeded",
        ],
      );
      assertEquals(history.records[1].requestId, interruptedRequestId);
      await Deno.rename(dirname(path), join(baseDir, "first-restored-case"));
      const published = { ...restore, requestId: crypto.randomUUID() };
      await killRestoreAtPublication(baseDir, published, "after");
      const alreadyInstalled = await Deno.lstat(path);
      assert(alreadyInstalled.isFile);
      const publicationRetry = JSON.parse(await turn(published)).receipt;
      assertEquals(publicationRetry.status, "succeeded");
      assertEquals((await Deno.lstat(path)).ino, alreadyInstalled.ino);
      assertStringIncludes(
        await turn({
          ...restore,
          runId: crypto.randomUUID(),
        }),
        "unavailable",
      );
      const resumed = JSON.parse(
        await turn({
          action: "resume",
          kind: "sentinel",
          id: exact.id,
          revision: exact.revision,
        }),
      ).run;
      assertEquals(resumed.status, "running");
      const active = readSentinelAssessment(path);
      assert(active?.active && !active.paused);
      const resumedTasks = readAdaptiveSentinel(path, active, "revision")
        ?.tasks;
      assertEquals(
        resumedTasks?.find(({ id }) => id === dependentId)?.prerequisites,
        [sourceTaskId],
      );
      assertEquals(
        resumedTasks?.find(({ id }) => id === dependentId)?.status,
        "completed",
      );
      const attachNative = {
        ...workflowTrace,
        action: "attach_native_workflow_control",
        workflowRunNumber: 17,
        controlId: "native-workflow-control",
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      };
      policy.denyWorkflowMetadata = true;
      assertStringIncludes(await turn(attachNative), "unavailable");
      assertEquals(readSentinelAssessment(path)?.revision, state.revision);
      policy.denyWorkflowMetadata = false;
      const attached = JSON.parse(await turn(attachNative)).receipt;
      assertEquals(attached.source, {
        runId: state.plan.runId,
        revision: state.revision,
        taskId: interruptedTaskId,
        stepIndex: 2,
        workflowRunNumber: 17,
        resultSha256: workflowReceipt.resultSha256,
      });
      const current = readSentinelAssessment(path)!;
      const attachedGraph = current.result?.sharedGraph.snapshot;
      assert(current.revision > state.revision);
      assertEquals(
        attachedGraph?.nodes.find(({ id }) => id === attached.evidenceId),
        {
          id: attached.evidenceId,
          kind: "evidence",
          label: "Approved native workflow control observation",
          controlVerification: attached.verification,
          nativeWorkflowSource: attached.source,
        },
      );
      assert(
        attachedGraph?.edges.some(({ from, to, relation }) =>
          from === attached.evidenceId && to === attachNative.controlId &&
          relation === "verifies"
        ),
      );
      assertEquals(JSON.parse(await turn(attachNative)).receipt, attached);
      assertEquals(readSentinelAssessment(path)?.revision, current.revision);
      const plannerRegistry = createProviderRegistry();
      let toolResponse: string | undefined;
      plannerRegistry.register({
        name: "native-workflow-planner",
        supportsStreaming: false,
        complete(messages) {
          const response = messages.find(({ role }) => role === "tool");
          if (response) toolResponse = String(response.content);
          return Promise.resolve({
            content: response ? "[]" : "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: response ? [] : [{
              type: "function",
              id: "read-native",
              function: {
                name: "sentinel_case_execution_evidence",
                arguments: JSON.stringify({ node: attached.evidenceId }),
              },
            }],
          });
        },
      });
      plannerRegistry.setDefault("native-workflow-planner");
      let metadataReads = 0;
      let denyMetadata = true;
      let denyResponse = false;
      const planner = createSentinelSubagent({
        providerRegistry: plannerRegistry,
        snapshotPath: path,
        assessmentRevision: current.revision,
        plannerExecutionEvidenceRunId: current.plan.runId,
        sharedInventoryBaseDir: baseDir,
        allowModelAccess: true,
        authorizeExecutionTracePayload: () => Promise.resolve(false),
        readRetainedWorkflow: createSentinelLiveWorkflowReader({
          scopes: [{
            case: exact.id,
            asset: "app",
            owner: "owner",
            repo: "repo",
            workflow_id: 22,
          }],
          resolveToken: () => Promise.resolve("fixture-metadata-token"),
          ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
          verifyAccess: () => {
            metadataReads++;
            return Promise.resolve(true);
          },
          readRuns: () => {
            throw new Error("Do not fetch historic runs again");
          },
        }),
        hookRunner: {
          evaluateHook(hook, { input }) {
            const native = input.tool_name === "sentinel_live_workflow_status";
            const allowed =
              !(native && hook === "PRE_TOOL_CALL" && denyMetadata) &&
              !(native && hook === "POST_TOOL_RESPONSE" && denyResponse);
            return Promise.resolve({
              allowed,
              action: allowed ? "ALLOW" : "BLOCK",
              duration: 0,
              ruleId: null,
            });
          },
        },
      });
      await planner.execute("Read the approved control evidence.", () => {});
      assertStringIncludes(toolResponse ?? "", "unavailable");
      assertEquals(metadataReads, 0);
      denyMetadata = false;
      denyResponse = true;
      planner.clear();
      await planner.execute("Read the approved control evidence.", () => {});
      assertStringIncludes(toolResponse ?? "", "unavailable");
      assertEquals(metadataReads, 1);
      denyResponse = false;
      planner.clear();
      advanceAdaptiveSentinel(path, current);
      const journal = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
        () => Date.now() + 120_000,
      );
      try {
        const mapped = journal.forEvidence(current.revision);
        assert(mapped);
        nativePlannerIdentity = `${mapped.revision}:obs:native-archive`;
        assertEquals(journal.claimModelPlan(nativePlannerIdentity), 1);
        assert(journal.recordModelPlanInputManifest(nativePlannerIdentity, 1, {
          promptSha256: "b".repeat(64),
          hintIds: [],
          findingReviewIds: [],
          incidentReviewIds: [],
          incidentCandidateIds: [],
          investigationIds: [],
          inventoryNodeIds: [],
          workerObservations: [],
        }));
        await planner.execute(
          "Read the approved control evidence.",
          () => {},
          undefined,
          (step) => {
            assert(step.goalReceiptRead);
            assert(journal.recordModelPlanRead(nativePlannerIdentity, 1, step));
          },
        );
        journal.completeModelPlan(
          nativePlannerIdentity,
          1,
          "no_new_assignments",
        );
      } finally {
        journal.close();
      }
      assert(toolResponse);
      nativePlannerResponse = toolResponse;
      const readback = JSON.parse(toolResponse ?? "").evidence;
      assertEquals(readback.payload, candidate.payload);
      assertEquals(readback.resultSha256, attached.source.resultSha256);
      assertEquals(metadataReads, 2);
      nativeArchiveRevision = current.revision;
      nativeEvidenceId = attached.evidenceId;
      assert(stopSentinelAssessment(path));
      const nativeArchive = JSON.parse(
        await turn({
          action: "archive",
          ...exact,
          revision: nativeArchiveRevision,
          requestId: nativeArchiveId,
        }),
      ).receipt;
      assertEquals(nativeArchive?.status, "succeeded");
      await Deno.rename(dirname(path), join(baseDir, "native-archived-case"));
    });
    const nativeDirectory = join(
      baseDir,
      "data",
      "run-archives",
      nativeArchiveId,
    );
    const alteredDatabase = join(baseDir, "altered-adaptive.db");
    await Deno.copyFile(
      join(nativeDirectory, "sentinel-adaptive.db"),
      alteredDatabase,
    );
    const altered = new DatabaseSync(alteredDatabase);
    try {
      altered.prepare(
        "DELETE FROM adaptive_archived_worker_traces WHERE taskId = ?",
      )
        .run(interruptedTaskId);
    } finally {
      altered.close();
    }
    const nativeManifest = JSON.parse(
      await Deno.readTextFile(join(nativeDirectory, "manifest.json")),
    );
    const missingNative = join(baseDir, "missing-native-workflow-trace");
    await writeRunArchive(
      missingNative,
      nativeManifest.identity,
      nativeManifest.artifacts.map(({ name }: { name: string }) => ({
        name,
        sourcePath: name === "sentinel-adaptive.db"
          ? alteredDatabase
          : join(nativeDirectory, name),
      })),
      permittedSentinelRestoreArtifacts,
    );
    await assertRejects(
      () =>
        withVerifiedRunArchive(missingNative, baseDir, {
          expectedKind: "sentinel",
          permittedNames: permittedSentinelRestoreArtifacts,
        }, (archive) => restoreVerifiedSentinelCaseArchive(baseDir, archive)),
      Error,
      "Archive is missing exact native workflow evidence",
    );
    await assertRejects(() => Deno.lstat(dirname(path)), Deno.errors.NotFound);
    assertEquals(readSentinelAssessment(peerPath), peerBeforeFailures);
    await withGateway(baseDir, async (turn, _approvals, policy) => {
      const nativeRestore = JSON.parse(
        await turn({
          action: "restore",
          ...exact,
          revision: nativeArchiveRevision,
          archiveId: nativeArchiveId,
          requestId: crypto.randomUUID(),
        }),
      ).receipt;
      assertEquals(nativeRestore?.status, "succeeded");
      const restoredNative = readSentinelAssessment(path);
      assert(restoredNative?.paused);
      const node = restoredNative.result?.sharedGraph.snapshot?.nodes.find(
        ({ id }) => id === nativeEvidenceId,
      );
      assert(node?.kind === "evidence" && node.nativeWorkflowSource);
      const savedPlannerRead = {
        action: "planner_reads",
        kind: exact.kind,
        id: exact.id,
        revision: nativeArchiveRevision,
        plannerIdentity: nativePlannerIdentity,
        attempt: 1,
        ordinal: 1,
        includeResult: true,
      };
      assertEquals(
        JSON.stringify(JSON.parse(await turn(savedPlannerRead)).result),
        nativePlannerResponse,
      );
      assertEquals(policy.workflowMetadataCalls, 1);
      policy.denyWorkflowMetadata = true;
      assertStringIncludes(await turn(savedPlannerRead), "unavailable");
      assertEquals(policy.workflowMetadataCalls, 2);
      policy.denyWorkflowMetadata = false;
      policy.denyWorkerSourceAfter = true;
      assertStringIncludes(await turn(savedPlannerRead), "unavailable");
      policy.denyWorkerSourceAfter = false;
      const original = JSON.parse(
        await turn({
          kind: exact.kind,
          id: exact.id,
          revision: node.nativeWorkflowSource.revision,
          action: "worker_trace_result",
          taskId: node.nativeWorkflowSource.taskId,
          stepIndices: [node.nativeWorkflowSource.stepIndex],
          workflowRunNumber: node.nativeWorkflowSource.workflowRunNumber,
        }),
      ).result;
      assertEquals(
        original.sourceResultSha256,
        node.nativeWorkflowSource.resultSha256,
      );
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

async function verifyPlannerArchive(
  mode:
    | "search"
    | "direct"
    | "goals"
    | "telemetry"
    | "traffic"
    | "facts"
    | "digests"
    | "coverage",
) {
  const baseDir = await Deno.makeTempDir();
  const caseId = "planner-archive";
  const sourceCase = "planner-origin";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const sourcePath = resolveSentinelCasePath(baseDir, sourceCase);
  const registry = createProviderRegistry();
  const hooks: HookRunner = {
    evaluateHook(hook, { input }) {
      if (
        input.tool_name === "sentinel_shared_topology_source" ||
        input.tool_name === "sentinel_shared_asset_links" ||
        input.tool_name === "sentinel_trace" ||
        [
          "sentinel_impact",
          "sentinel_path",
          "sentinel_report",
          "sentinel_coverage",
          "sentinel_provenance_search",
          "sentinel_provenance_node",
          "sentinel_worker_observation",
          "sentinel_worker_trace_search",
          "sentinel_goal_state",
          "sentinel_case_hints",
          "sentinel_defense",
          "sentinel_incident_alerts",
          "sentinel_graph_facts",
          "sentinel_case_inventory",
          "sentinel_list_evidence_digests",
          "sentinel_expand_evidence_digest",
          "sentinel_traffic_search",
          "sentinel_traffic_get",
        ].includes(String(input.tool_name))
      ) {
        plannerHooks.push(hook);
      }
      return Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const plannerHooks: string[] = [];
  const planner = createSentinelModelPlanner(
    path,
    (state) =>
      createSentinelSubagent({
        providerRegistry: registry,
        snapshotPath: path,
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: state.plan.runId,
        webContainmentConfigured: mode === "telemetry" ? true : undefined,
        snapshotOverride: state.result?.sharedGraph.snapshot,
        sharedInventoryBaseDir: baseDir,
        allowModelAccess: true,
        hookRunner: hooks,
      }),
  );
  try {
    const graph = {
      version: 1,
      nodes: [
        { id: "app", kind: "asset", label: "Application" },
        { id: "db", kind: "asset", label: "Database" },
      ],
      edges: [],
    };
    for (const file of [path, sourcePath]) {
      await Deno.mkdir(dirname(file), { recursive: true, mode: 0o700 });
    }
    await Deno.writeTextFile(path, JSON.stringify(graph));
    await Deno.writeTextFile(
      sourcePath,
      JSON.stringify({
        ...graph,
        edges: [{ from: "app", to: "db", relation: "depends_on" }],
      }),
    );
    const shared = await collectSharedSentinelTopology(
      baseDir,
      caseId,
      path,
      undefined,
      true,
    );
    const savedGraph = applySharedSentinelTopology({
      ...graph,
      nodes: [...graph.nodes, {
        id: "control-finding",
        kind: "finding",
        label: "Recorded control gap",
        severity: "low",
      }],
      edges: [{ from: "control-finding", to: "app", relation: "affects" }],
    }, shared);
    const evidence = savedGraph.nodes.find(({ id }) =>
      id.startsWith("shared-topology:")
    );
    assert(evidence);
    await Deno.writeTextFile(path, JSON.stringify(savedGraph));
    const selector = { evidenceId: evidence.id, sourceCase };
    const sourceDigest = shared[0].sourceDigests?.[sourceCase];
    assert(sourceDigest);
    await Deno.writeTextFile(
      sourcePath,
      JSON.stringify({
        ...graph,
        nodes: graph.nodes.map((node) => ({
          ...node,
          label: node.label + " current",
        })),
        edges: [{ from: "app", to: "db", relation: "depends_on" }],
      }),
    );
    const linksSelector = { asset: "app", limit: 1 };
    let observedTaskId = "";
    const recordedFacts: string[] = [];
    const plannerCalls: { name: string; args: Record<string, unknown> }[] = [
      { name: "sentinel_shared_topology_source", args: selector },
      { name: "sentinel_shared_asset_links", args: linksSelector },
      { name: "sentinel_trace", args: { node: "app", depth: 1 } },
      { name: "sentinel_impact", args: { node: "db", depth: 1 } },
      { name: "sentinel_path", args: { from: "app", to: "db", depth: 2 } },
      { name: "sentinel_report", args: { limit: 2 } },
      { name: "sentinel_coverage", args: { limit: 2 } },
      {
        name: "sentinel_path",
        args: {
          graph: "provenance",
          from: "finding:control-finding",
          to: "asset:app",
          limit: 2,
        },
      },
      {
        name: "sentinel_provenance_search",
        args: { query: "Recorded control gap", limit: 2 },
      },
      {
        name: "sentinel_provenance_node",
        args: { node: "finding:control-finding", limit: 1 },
      },
      {
        name: "sentinel_worker_observation",
        get args() {
          return mode === "direct"
            ? { task: observedTaskId, offset: 5 }
            : { query: "retained planner fixture" };
        },
      },
      {
        name: "sentinel_worker_trace_search",
        args: { query: "sentinel_assigned_target", limit: 1 },
      },
    ];
    if (mode === "goals") {
      plannerCalls.splice(10, 2, {
        name: "sentinel_goal_state",
        args: { limit: 1 },
      }, { name: "sentinel_case_hints", args: { limit: 1 } });
    }
    let responses: string[] = [];
    registry.register({
      name: "planner-source-fixture",
      supportsStreaming: false,
      complete(messages) {
        responses = messages.filter(({ role }) => role === "tool").map(
          ({ content }) => String(content),
        );
        const index = responses.length;
        const next = plannerCalls.slice(
          index,
          index < 2 ? index + 1 : undefined,
        );
        return Promise.resolve({
          content: next.length ? "" : "[]",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: next.map((call, ordinal) => ({
            type: "function" as const,
            id: "planner-read-" + (index + ordinal),
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args),
            },
          })),
        });
      },
    });
    registry.setDefault("planner-source-fixture");
    const goals: SentinelFormalGoal[] = [{
      id: "review-control",
      title: "Review recorded control evidence",
      policy: "operator",
      criteria: [{
        id: "topology",
        description: "Check the saved dependency.",
        source: "graph_evidence",
        reference: evidence.id,
      }],
    }];
    if (mode === "telemetry") {
      await Deno.writeTextFile(
        sentinelAlertsPath(path),
        JSON.stringify([
          {
            type: "authentication_failure_burst",
            severity: "medium",
            asset: "app",
            subject: "user",
            observedAt: "2026-01-01T00:00:00.000Z",
            evidenceIds: ["auth"],
          },
          {
            type: "network_security_alert",
            severity: "high",
            asset: "app",
            subject: "sensor",
            observedAt: "2026-01-01T00:00:01.000Z",
            evidenceIds: ["net"],
          },
          {
            type: "integrity_change",
            severity: "high",
            asset: "app",
            subject: "audit",
            triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
            observedAt: "2026-01-01T00:00:02.000Z",
            evidenceIds: ["saved-audit-event"],
          },
        ]),
      );
    }
    const trafficSecret = "fixture-only-planner-traffic-secret";
    if (mode === "traffic") {
      await ingestSentinelTraffic(
        new Blob([JSON.stringify({
          startedDateTime: new Date(Date.now() - 60_000).toISOString(),
          request: {
            url: `https://app.example/private?token=${trafficSecret}`,
            method: "GET",
          },
          response: { status: 403 },
        })]).stream(),
        "planner-traffic-fixture",
        path,
      );
    }
    const state = mode === "goals"
      ? applySentinelFormalGoals(path, {
        mode: "start",
        requestId: crypto.randomUUID(),
        proposalDigest: digestSentinelGoalProposal(goals),
        goals,
        plan: { goal: "Review recorded control evidence" },
      }).state
      : startSentinelAssessment(path);
    if (mode === "goals") assert(ensureSentinelFormalGoalContract(path, state));
    if (mode === "telemetry") {
      const incident = sentinelIncidentCandidates(state)[0];
      assert(incident);
      plannerCalls.splice(10, 2, { name: "sentinel_defense", args: {} }, {
        name: "sentinel_incident_alerts",
        args: { incidentId: incident.id, limit: 1 },
      });
    }
    if (mode === "traffic") {
      const traffic = readSentinelTrafficReceiptPage(path, state.revision)
        ?.receipts[0];
      assert(traffic);
      plannerCalls.splice(10, 2, {
        name: "sentinel_traffic_search",
        args: {
          revision: state.revision,
          origin: "https://app.example",
          limit: 1,
        },
      }, {
        name: "sentinel_traffic_get",
        args: {
          revision: state.revision,
          evidenceId: traffic.evidenceId,
          digest: traffic.digest,
        },
      });
    }
    if (mode === "digests") {
      const runId = state.plan.runId;
      assert(runId);
      const store = openSentinelEvidenceDigests(baseDir);
      try {
        const digest = store.record({
          caseId,
          runId,
          evidenceRevision: state.revision,
        }, {
          members: [
            { id: "asset:app", kind: "asset", label: "Application" },
            { id: "asset:db", kind: "asset", label: "Database" },
          ],
        });
        assert(digest);
        plannerCalls.splice(10, 2, {
          name: "sentinel_list_evidence_digests",
          args: { revision: state.revision, limit: 1 },
        }, {
          name: "sentinel_expand_evidence_digest",
          args: { revision: state.revision, digestId: digest.id, limit: 1 },
        });
      } finally {
        store.close();
      }
    }
    if (mode === "coverage") {
      plannerCalls.splice(10, 2, {
        name: "sentinel_case_inventory",
        args: { view: "coverage", assetId: "app" },
      }, {
        name: "sentinel_case_inventory",
        args: { view: "coverage", coverageGap: "unreviewed", limit: 1 },
      });
    }
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      if (mode === "goals") {
        store.addCaseHint("Review the recorded dependency.", state.revision);
      }
      if (mode === "search" || mode === "direct" || mode === "facts") {
        const reason = "archive planner worker search fixture";
        const task = store.sync(revision, [{
          kind: "trace",
          nodeId: "db",
          depth: 8,
          reason,
        }], revision)
          .find((entry) => entry.reason === reason);
        assert(task);
        observedTaskId = task.id;
        const lease = store.claim(
          revision,
          60,
          new Set(
            store.list(revision).filter(({ id }) => id !== task.id).map((
              { id },
            ) => id),
          ),
        );
        assert(lease);
        assert(store.complete({
          taskId: task.id,
          leaseToken: lease.leaseToken,
          observation: { summary: "retained planner fixture" },
        }));
        const review = store.claimModelReview(revision, reason);
        assert(review);
        assert(store.finishModelReview(revision, task.id, review.token, {
          note: "Reviewed committed observation.",
          steps: [{
            tool: "sentinel_assigned_target",
            target: "db",
            outcome: "returned",
          }],
        }));
        if (mode === "facts") {
          const snapshot = state.result?.sharedGraph.snapshot;
          const runId = state.plan.runId;
          assert(snapshot && runId);
          const facts = openSentinelWorkerGraphFacts(path);
          try {
            for (let index = 0; index < 6; index++) {
              const fact = facts.record({
                caseId,
                runId,
                evidenceRevision: state.revision,
                targetId: "db",
                taskId: task.id,
                snapshotDigest: index === 5
                  ? "e".repeat(64)
                  : digestSentinelSnapshot(snapshot),
                resultSha256: "d".repeat(64),
                sourceStepIndex: 0,
                relationship: { from: "app", to: "db", relation: "depends_on" },
                requestId: crypto.randomUUID(),
              }, () => true);
              assert(fact);
              if (index < 5) recordedFacts.unshift(fact.id);
            }
          } finally {
            facts.close();
          }
          plannerCalls[10] = {
            name: "sentinel_graph_facts",
            args: { id: recordedFacts[0] },
          };
          plannerCalls[11] = {
            name: "sentinel_graph_facts",
            args: { offset: 1 },
          };
        }
      }
    } finally {
      store.close();
    }
    planner.advance(state);
    const readRound = () =>
      readAdaptiveSentinel(path, state)
        ?.modelPlannerHistory.find(({ reads }) =>
          reads?.length === plannerCalls.length
        );
    for (let i = 0; i < 200 && !readRound(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const round = readRound();
    assert(round?.reads?.length === plannerCalls.length);
    assertEquals(round.reads[8].provenanceSearchResult, undefined);
    assertEquals(round.reads[9].plannerProvenanceNodeResult, undefined);
    const [toolResponse, linksResponse] = responses;
    assert(toolResponse);
    const sha256 = createHash("sha256").update(toolResponse).digest("hex");
    assertEquals(round.reads[0].goalReceiptRead, { args: selector, sha256 });
    assert(linksResponse);
    assertEquals(JSON.parse(responses[5]).findings.length, 1);
    assertEquals(JSON.parse(responses[6]).findings.length, 1);
    assertEquals(JSON.parse(responses[7]).paths.length, 1);
    assertEquals(round.reads[7].plannerProvenancePath, undefined);
    assertEquals(
      JSON.parse(responses[8]).nodes[0].id,
      "finding:control-finding",
    );
    assertEquals(JSON.parse(responses[9]).node.id, "finding:control-finding");
    let workerNode: { taskId: string; results: string[] } | undefined;
    const observed = JSON.parse(responses[10]);
    if (mode === "coverage") {
      assertEquals(observed.assets[0].findings[0].review, null);
      assertEquals(JSON.parse(responses[11]).assets.length, 1);
      const store = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      try {
        assert(recordSentinelFindingReview(
          path,
          state.revision,
          "control-finding",
          "confirmed",
          "Original worker review marker",
        ));
        const reason = "Archive interrupted worker node read";
        const task = store.sync(revision, [{
          kind: "trace",
          nodeId: "app",
          depth: 10,
          reason,
        }], revision).find((task) => task.reason === reason);
        assert(task);
        const excluded = new Set(
          store.list(revision).filter(({ id }) => id !== task.id).map((
            { id },
          ) => id),
        );
        const lease = store.claim(revision, 60, excluded);
        assert(lease);
        assert(
          store.complete({
            taskId: task.id,
            leaseToken: lease.leaseToken,
            observation: {},
          }),
        );
        const claim = store.claimModelReview(revision, reason);
        assert(claim);
        const workerRegistry = createProviderRegistry();
        let results: string[] = [];
        const steps: Parameters<
          typeof store.recordModelReviewProgress
        >[3][number][] = [];
        workerRegistry.register({
          name: "worker-node-fixture",
          supportsStreaming: false,
          complete(messages) {
            results = messages.filter(({ role }) => role === "tool").map((
              { content },
            ) => String(content));
            return Promise.resolve({
              content: results.length ? "Read the finding." : "",
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: results.length
                ? []
                : plannerCalls.slice(8, 10).map((call, index) => ({
                  type: "function",
                  id: `worker-provenance-${index}`,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(
                      index === 0
                        ? { query: "Original worker review marker", limit: 2 }
                        : call.args,
                    ),
                  },
                })),
            });
          },
        });
        workerRegistry.setDefault("worker-node-fixture");
        const workerHooks = plannerHooks.length;
        await createSentinelSubagent({
          providerRegistry: workerRegistry,
          snapshotPath: path,
          assessmentRevision: state.revision,
          assignedTaskId: claim.task.id,
          assignedTaskLeaseToken: claim.token,
          allowModelAccess: true,
          hookRunner: hooks,
        }).execute(
          "Read the finding.",
          () => {},
          undefined,
          (step) => steps.push(step),
          true,
          { workerBoundary: () => ({}) },
        );
        assertEquals(plannerHooks.splice(workerHooks), [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
        ]);
        assertEquals(results.length, 2);
        assertEquals(
          JSON.parse(results[0]).nodes[0].id,
          "finding:control-finding",
        );
        assertEquals(steps[0].provenanceSearchResult, results[0]);
        assertEquals(steps[1].workerProvenanceNodeResult, results[1]);
        assert(
          store.recordModelReviewProgress(
            revision,
            claim.task.id,
            claim.token,
            steps,
          ),
        );
        workerNode = { taskId: claim.task.id, results };
      } finally {
        store.close();
      }
      for (let index = 0; index < 5; index++) {
        assert(recordSentinelFindingReview(
          path,
          state.revision,
          "control-finding",
          "confirmed",
          `Later recorded review ${index}.`,
        ));
      }
    } else if (mode === "digests") {
      assertEquals(observed.page.digests.length, 1);
      const expanded = JSON.parse(responses[11]);
      assertEquals(expanded.page.members[0].id, "asset:app");
      assertEquals(expanded.page.nextCursor, `${expanded.page.digest.id}:1`);
      assertEquals(round.reads[11].plannerDigestResult, undefined);
    } else if (mode === "facts") {
      assertEquals(observed.id, recordedFacts[0]);
      const page = JSON.parse(responses[11]);
      assertEquals(
        page.facts.map(({ id }: { id: string }) => id),
        recordedFacts.slice(1, 4),
      );
      assertEquals(page.nextOffset, 4);
      assertEquals(observed.taskId, observedTaskId);
      assertEquals(observed.requestId, undefined);
    } else if (mode === "traffic") {
      assertEquals(observed.receipts.length, 1);
      assertEquals(JSON.parse(responses[11]).receipt, observed.receipts[0]);
      assert(!responses.slice(10).join("").includes(trafficSecret));
    } else if (mode === "telemetry") {
      assert(observed.webContainment);
      assertEquals(round.reads[10].plannerDefenseContainment, undefined);
      assertEquals(JSON.parse(responses[11]).alerts.length, 1);
      await Deno.remove(sentinelAlertsPath(path));
    } else if (mode === "goals") {
      assertEquals(observed.criteria.length, 1);
      assertEquals(
        JSON.parse(responses[11]).hints[0].text,
        "Review the recorded dependency.",
      );
      const later = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      try {
        later.addCaseHint(
          "A later hint must not replace the saved page.",
          state.revision,
        );
      } finally {
        later.close();
      }
    } else if (mode === "direct") {
      assertEquals(observed.task, observedTaskId);
      assertEquals(observed.offset, 5);
      assertEquals(
        observed.observationJson,
        JSON.stringify({ summary: "retained planner fixture" }).slice(5),
      );
    } else {
      assertEquals(observed.observations[0].id, observedTaskId);
    }
    if (mode === "search" || mode === "direct") {
      assertEquals(JSON.parse(responses[11]).steps[0].taskId, observedTaskId);
    }
    const linksPage = JSON.parse(linksResponse);
    assertEquals(linksPage.links.length, 1);
    const [linkSource] = linksPage.sourceSnapshots;
    assert(linkSource.snapshotDigest !== sourceDigest);
    assertEquals(round.reads[1].goalReceiptRead, {
      args: linksSelector,
      sha256: createHash("sha256").update(linksResponse).digest("hex"),
    });
    assertEquals(round.reads[1].sharedAssetLinksPage, undefined);
    assertEquals(
      plannerHooks,
      plannerCalls.flatMap(() => [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]),
    );
    planner.stop();
    assert(stopSentinelAssessment(path));

    const run = {
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      runId: state.plan.runId,
    };
    const archiveId = crypto.randomUUID();
    await withGateway(baseDir, async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({
            ...run,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt.status,
        "succeeded",
      );
    });
    await Deno.rename(dirname(path), join(baseDir, "original-planner-case"));
    if (mode === "digests") {
      await Deno.remove(join(baseDir, "data", "sentinel-evidence-digests.db"));
    }
    await Deno.remove(dirname(sourcePath), { recursive: true });
    await Deno.remove(
      sentinelSourceSnapshotPath(baseDir, sourceCase, sourceDigest),
    );
    await Deno.remove(
      sentinelSourceSnapshotPath(
        baseDir,
        sourceCase,
        linkSource.snapshotDigest,
      ),
    );
    await withGateway(baseDir, async (turn, _approvals, policy) => {
      assertEquals(
        JSON.parse(
          await turn({
            ...run,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt.status,
        "succeeded",
      );
      if (mode === "telemetry") {
        const exact = { kind: run.kind, id: run.id, revision: run.revision };
        const overview =
          JSON.parse(await turn({ ...exact, action: "defense_coverage" }))
            .evidence;
        assertEquals(overview.webContainment.status, "unknown");
        assertEquals(
          overview.upstreamChecks.find(({ id }: { id: string }) =>
            id === "cloudtrail_logging_stopped"
          ).matchCount,
          1,
        );
        const check = {
          ...exact,
          action: "defense_coverage",
          upstreamCheck: "cloudtrail_logging_stopped",
          limit: 1,
        };
        const detail = JSON.parse(await turn(check)).evidence;
        assertEquals(detail.matches[0].evidenceIds, ["saved-audit-event"]);
        assertEquals(
          detail.matches[0].triggeringAction,
          "cloudtrail.amazonaws.com:StopLogging",
        );
        const directory = {
          ...exact,
          action: "incidents",
          assetId: "app",
          limit: 1,
        };
        const listed = JSON.parse(await turn(directory));
        assertEquals(listed.incidents[0].id, plannerCalls[11].args.incidentId);
        assert(listed.incidents[0].alertCount >= 2);
        assertEquals(
          JSON.parse(await turn({ ...directory, assetId: "db" })).incidents,
          [],
        );
        const incident = {
          ...exact,
          action: "incident_alerts",
          incidentId: listed.incidents[0].id,
          limit: 1,
        };
        assertEquals(
          JSON.parse(await turn(incident)).evidence,
          JSON.parse(responses[11]),
        );
        assertStringIncludes(
          await turn({ ...incident, revision: run.revision + 1 }),
          "unavailable",
        );
        policy.denyRunResponse = true;
        assert(!(await turn(check)).includes("saved-audit-event"));
        policy.denyRunResponse = false;
      }
      if (mode === "digests") {
        const archivedScope = {
          kind: run.kind,
          id: run.id,
          revision: run.revision,
        };
        const originalList = JSON.parse(responses[10]);
        const originalExpansion = JSON.parse(responses[11]);
        const listed = JSON.parse(
          await turn({ ...archivedScope, action: "list_digests", limit: 1 }),
        );
        assertEquals(listed.page, originalList.page);
        const cursor = originalExpansion.page.nextCursor;
        assert(cursor);
        const continued = JSON.parse(
          await turn({
            ...archivedScope,
            action: "expand_digest",
            digestId: originalExpansion.page.digest.id,
            cursor,
            limit: 1,
          }),
        );
        assertEquals(continued.page.digest, originalExpansion.page.digest);
        assertEquals(
          continued.page.members.map(({ id }: { id: string }) => id),
          ["asset:db"],
        );
        assertEquals(continued.page.nextCursor, null);
        const digestStore = openSentinelEvidenceDigests(baseDir);
        try {
          assert(run.runId);
          const added = digestStore.record({
            caseId,
            runId: run.runId,
            evidenceRevision: run.revision,
          }, {
            members: [{
              id: "asset:new",
              kind: "asset",
              label: "Later digest",
            }],
          });
          assert(added);
          const first = JSON.parse(
            await turn({ ...archivedScope, action: "list_digests", limit: 1 }),
          );
          assertEquals(first.page.digests, [added]);
          assertEquals(first.page.nextCursor, added.id);
          const second = JSON.parse(
            await turn({
              ...archivedScope,
              action: "list_digests",
              limit: 1,
              cursor: added.id,
            }),
          );
          assertEquals(second.page, originalList.page);
        } finally {
          digestStore.close();
        }
      }
      if (mode === "coverage") {
        const current = JSON.parse(
          await turn({
            action: "inventory",
            kind: run.kind,
            id: run.id,
            revision: run.revision,
            view: "coverage",
            assetId: "app",
          }),
        );
        assertEquals(
          current.page.assets[0].findings[0].review.disposition,
          "confirmed",
        );
        const metadata = JSON.parse(
          await turn({
            action: "planner_reads",
            kind: run.kind,
            id: run.id,
            revision: run.revision,
            plannerIdentity: round.identity,
            attempt: round.attempt,
            ordinal: 11,
          }),
        );
        assertEquals(metadata.read.plannerCoverageResult, undefined);
        const liveSearch = JSON.parse(
          await turn({
            action: "graph",
            kind: run.kind,
            id: run.id,
            revision: run.revision,
            query: "Original worker review marker",
          }),
        );
        assertEquals(liveSearch.page.nodes, []);
        assert(workerNode);
        const workerTrace = {
          kind: run.kind,
          id: run.id,
          revision: run.revision,
          taskId: workerNode.taskId,
          stepIndices: [0, 1],
        };
        const progress = JSON.parse(
          await turn({ ...workerTrace, action: "worker_trace_progress" }),
        );
        assertEquals(progress.archived, true);
        assertEquals(
          progress.page.steps[1].workerProvenanceNodeResult,
          undefined,
        );
        assertEquals(progress.page.steps[0].provenanceSearchResult, undefined);
        const result = {
          ...workerTrace,
          action: "worker_trace_result",
          stepIndices: [0],
        };
        for (const [index, exact] of workerNode.results.entries()) {
          assertEquals(
            JSON.stringify(
              JSON.parse(await turn({ ...result, stepIndices: [index] }))
                .result,
            ),
            exact,
          );
          assertEquals(policy.workerSourceHooks.splice(0), [
            "PRE_TOOL_CALL",
            "POST_TOOL_RESPONSE",
          ]);
        }
        policy.denyWorkerSourceBefore = true;
        assertStringIncludes(await turn(result), "unavailable");
        assertEquals(policy.workerSourceHooks.splice(0), ["PRE_TOOL_CALL"]);
        policy.denyWorkerSourceBefore = false;
        policy.denyWorkerSourceAfter = true;
        assertStringIncludes(await turn(result), "unavailable");
        assertEquals(policy.workerSourceHooks.splice(0), [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
        ]);
        policy.denyWorkerSourceAfter = false;
      }
      const sourceRead = {
        action: "planner_reads",
        kind: run.kind,
        id: run.id,
        revision: run.revision,
        plannerIdentity: round.identity,
        attempt: round.attempt,
        ordinal: 1,
        sourceCase,
        snapshotDigest: sourceDigest,
        assetId: "app",
      };
      const reopened = JSON.parse(await turn(sourceRead));
      assertEquals(reopened.read.goalReceiptRead, { args: selector, sha256 });
      assertEquals(reopened.source, {
        caseId: sourceCase,
        snapshotDigest: sourceDigest,
        asset: graph.nodes[0],
      });
      assertEquals(policy.workerSourceHooks.splice(0), [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]);
      const resultRead = {
        action: sourceRead.action,
        kind: sourceRead.kind,
        id: sourceRead.id,
        revision: sourceRead.revision,
        plannerIdentity: sourceRead.plannerIdentity,
        attempt: sourceRead.attempt,
        ordinal: sourceRead.ordinal,
        includeResult: true,
      };
      const result = JSON.parse(await turn(resultRead)).result;
      assertEquals(JSON.stringify(result), toolResponse);
      assertEquals(policy.workerSourceHooks.splice(0), [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]);
      assertStringIncludes(
        await turn({ ...resultRead, attempt: round.attempt + 1 }),
        "unavailable",
      );
      assertStringIncludes(
        await turn({ ...sourceRead, includeResult: true }),
        "unavailable",
      );
      assertEquals(policy.workerSourceHooks, []);
      const archivedLinks = { ...resultRead, ordinal: 2 };
      assertEquals(
        JSON.stringify(JSON.parse(await turn(archivedLinks)).result),
        linksResponse,
      );
      assertEquals(policy.workerSourceHooks.splice(0), [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]);
      const { includeResult: _result, ...linksMetadata } = archivedLinks;
      assertEquals(
        JSON.parse(await turn(linksMetadata)).read.sharedAssetLinksPage,
        undefined,
      );
      const linkedSource = JSON.parse(
        await turn({
          ...linksMetadata,
          sourceCase,
          snapshotDigest: linkSource.snapshotDigest,
          assetId: "app",
        }),
      ).source;
      assertEquals(linkedSource.asset.label, "Application current");
      assertEquals(policy.workerSourceHooks.splice(0), [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]);
      for (let index = 2; index < plannerCalls.length; index++) {
        const sha256 = createHash("sha256").update(responses[index]).digest(
          "hex",
        );
        if (mode === "coverage" && index >= 10) {
          assertEquals(round.reads?.[index].plannerCoverageResult, undefined);
        } else if (mode === "digests" && index >= 10) {
          assertEquals(round.reads?.[index].plannerDigestResult, undefined);
        } else if (mode === "traffic" && index === 10) {
          assertEquals<unknown>(round.reads?.[index].trafficSearch, {
            args: plannerCalls[index].args,
            sha256,
          });
        } else if (mode === "traffic" && index === 11) {
          assertEquals<unknown>(round.reads?.[index].trafficRead, {
            ...plannerCalls[index].args,
            sha256,
          });
        } else {
          assertEquals(round.reads?.[index].goalReceiptRead, {
            args: plannerCalls[index].args,
            sha256,
          });
        }
        const read = { ...resultRead, ordinal: index + 1 };
        const readText = await turn(read);
        assert(
          !readText.startsWith("Error:"),
          `index ${index}: ${readText} hooks ${
            policy.workerSourceHooks.join(",")
          }`,
        );
        assertEquals(
          JSON.stringify(JSON.parse(readText).result),
          responses[index],
        );
        assertEquals(policy.workerSourceHooks.splice(0), [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
        ]);
        policy.denyWorkerSourceAfter = true;
        assertStringIncludes(await turn(read), "unavailable");
        assertEquals(policy.workerSourceHooks.splice(0), [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
        ]);
        policy.denyWorkerSourceAfter = false;
      }
      policy.denyWorkerSourceBefore = true;
      assertStringIncludes(await turn(resultRead), "unavailable");
      assertEquals(policy.workerSourceHooks.splice(0), ["PRE_TOOL_CALL"]);
      policy.denyWorkerSourceBefore = false;
      policy.denyWorkerSourceAfter = true;
      assertStringIncludes(await turn(archivedLinks), "unavailable");
      assertEquals(policy.workerSourceHooks.splice(0), [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]);
      if (mode === "digests") {
        policy.denyWorkerSourceAfter = false;
        assert(stopSentinelAssessment(path));
        const restarted = startSentinelAssessment(path);
        assert(restarted.plan.runId && restarted.plan.runId !== run.runId);
        const registry = openSentinelEvidenceDigests(baseDir);
        const scope = {
          caseId,
          runId: restarted.plan.runId,
          evidenceRevision: restarted.revision,
        };
        try {
          const digest = registry.record(scope, {
            members: [{
              id: "asset:new",
              kind: "asset",
              label: "New run digest",
            }],
          });
          assert(digest);
          const fresh = {
            kind: run.kind,
            id: caseId,
            revision: restarted.revision,
          };
          const list = JSON.parse(
            await turn({ ...fresh, action: "list_digests" }),
          );
          assertEquals(list.page.digests, [digest]);
          const oldDigest = JSON.parse(responses[11]).page.digest.id;
          assertStringIncludes(
            await turn({
              ...fresh,
              action: "expand_digest",
              digestId: oldDigest,
            }),
            "unavailable",
          );
          assert(stopSentinelAssessment(path));
          const requestId = crypto.randomUUID();
          const archived = JSON.parse(
            await turn({
              ...fresh,
              action: "archive",
              runId: scope.runId,
              requestId,
            }),
          );
          assertEquals(archived.receipt.status, "succeeded");
          const catalog = JSON.parse(
            await Deno.readTextFile(join(
              baseDir,
              "data",
              "run-archives",
              requestId,
              sentinelArchivedDigestFile,
            )),
          );
          assertEquals(
            catalog.map((entry: { digest: unknown }) => entry.digest),
            [digest],
          );
        } finally {
          registry.close();
        }
      }
    });
  } finally {
    planner.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
}

Deno.test("a dispatched Sentinel planner source receipt survives gateway archive and restore", () =>
  verifyPlannerArchive("search"));
Deno.test("a dispatched Sentinel planner direct observation page survives gateway archive and restore", () =>
  verifyPlannerArchive("direct"));
Deno.test("a dispatched Sentinel planner goal state and hints survive gateway archive and restore", () =>
  verifyPlannerArchive("goals"));

Deno.test("a dispatched Sentinel planner defense and incident results survive gateway archive and restore", () =>
  verifyPlannerArchive("telemetry"));

Deno.test("a dispatched Sentinel planner traffic page and receipt survive gateway archive and restore", () =>
  verifyPlannerArchive("traffic"));

Deno.test("a dispatched Sentinel planner graph fact survives gateway archive and restore", () =>
  verifyPlannerArchive("facts"));

Deno.test("dispatched Sentinel planner evidence digest pages survive archive and restore", () =>
  verifyPlannerArchive("digests"));

Deno.test("dispatched Sentinel planner coverage pages survive review changes and archive restore", () =>
  verifyPlannerArchive("coverage"));
