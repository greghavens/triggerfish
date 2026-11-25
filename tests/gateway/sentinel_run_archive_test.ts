import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  applySharedSentinelTopology,
  collectSharedSentinelTopology,
  digestSentinelSnapshot,
  readArchivedSentinelSnapshot,
  readPinnedSentinelSharedFindingSource,
  retainSentinelSourceSnapshot,
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
import { readAdaptiveSentinel } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { adaptiveRevision } from "../../src/sentinel/adaptive_planner.ts";
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
    policy: { denyArchive: boolean; denyPlannerResponse: boolean },
  ) => Promise<void>,
) {
  const approvals: string[] = [];
  const policy = { denyArchive: false, denyPlannerResponse: false };
  const registry = createProviderRegistry();
  const hooks: HookRunner = {
    evaluateHook(hook, { input }) {
      const call = input.tool_call as
        | { args?: { action?: string } }
        | undefined;
      const allowed = !(policy.denyArchive && hook === "PRE_TOOL_CALL" &&
        call?.args?.action === "archive") &&
        !(policy.denyPlannerResponse && hook === "POST_TOOL_RESPONSE" &&
          input.tool_name === "operator_runs");
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
            id: evidenceId,
            kind: "evidence",
            label: "Committed control evidence",
          },
        ],
        edges: [
          { from: evidenceId, to: findingId, relation: "supports" },
          { from: findingId, to: "app", relation: "affects" },
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
    const findingCitation = {
      localAssetId: "app",
      sourceCaseId: sourceCase,
      sourceAssetId: "source-app",
      sourceFindingId: "borrowed-finding",
      snapshotDigest: findingDigest,
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
    const plannerRead = {
      tool: "sentinel_shared_asset",
      outcome: "returned" as const,
      sourceSnapshots: [{
        caseId: sourceCase,
        snapshotDigest: plannerDigest,
        assetId: "source-app",
      }],
    };
    const privateToken = "archive-traffic-fixture-secret";
    await ingestSentinelTraffic(
      new Blob([JSON.stringify({
        startedDateTime: new Date(Date.now() - 60_000).toISOString(),
        request: {
          url: `https://app.example/private?token=${privateToken}`,
          method: "GET",
        },
        response: { status: 403 },
      })]).stream(),
      "archive-fixture",
      path,
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
        outcome: "returned",
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
    };
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    let sourceTaskId: string;
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
          outcome: "returned",
          sourceSnapshots: [traceReference],
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
      store.completeModelPlan(identity, 1, "no_new_assignments");
      sourceTaskId = source.id;
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
    const traffic = readSentinelTrafficReceiptPage(path, state.revision)
      ?.receipts[0];
    assert(traffic);
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
    let originalTopology: unknown;
    let trafficLinkId: string;
    let preArchiveTraffic: unknown;
    await withGateway(baseDir, async (turn) => {
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
    const workspaceTrace = sentinelSourceSnapshotPath(
      baseDir,
      sourceCase,
      traceDigest,
    );
    await Deno.remove(workspaceTrace);
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
      assertEquals(restored.plan.formalGoals, goals);
      assertEquals(restored.revision, state.revision);
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
      const handleTidepool = createTidepoolSentinelHandler(
        { baseDir, config: {} } as BootstrapResult,
      );
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
        readCount: 1,
      }]);
      const exactRead = {
        ...plannerQuery,
        plannerIdentity: plannerPage.page[0].plannerIdentity,
        attempt: plannerPage.page[0].attempt,
        ordinal: 1,
      };
      assertEquals(JSON.parse(await turn(exactRead)).read, plannerRead);
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
      policy.denyPlannerResponse = true;
      assertEquals(await turn(exactRead), "Tool response withheld by policy.");
      assertEquals(
        await turn(followPlannerSource),
        "Tool response withheld by policy.",
      );
      policy.denyPlannerResponse = false;
      for (
        const mismatch of [
          { revision: initial.revision },
          { id: "archive-peer" },
          { ordinal: 2 },
        ]
      ) {
        assertStringIncludes(
          await turn({ ...exactRead, ...mismatch }),
          "unavailable",
        );
      }
      assertEquals(
        adaptive?.modelPlannerHistory?.flatMap(({ reads }) => reads ?? []),
        [plannerRead],
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
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
