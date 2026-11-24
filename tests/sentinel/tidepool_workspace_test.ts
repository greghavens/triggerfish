import {
  claimSentinelAssessmentReview,
  completeSentinelAssessmentReview,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { startSentinelTopologySync } from "../../src/gateway/sentinel_topology_sync.ts";
import { sentinelAlertKey } from "../../src/sentinel/telemetry.ts";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "@std/path";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import {
  advanceAdaptiveSentinel,
  recordSentinelModelUsage,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import {
  type AdaptivePeerFindingCitation,
  type AdaptivePlannerRound,
  openSentinelAdaptiveStore,
} from "../../src/sentinel/adaptive_store.ts";
import { adaptiveRevision } from "../../src/sentinel/adaptive_planner.ts";
import {
  sentinelAlertsPath,
  sentinelSnapshotPath,
} from "../../src/sentinel/paths.ts";

import { auditSentinelSourceSnapshots } from "../../src/sentinel/source_snapshot_audit.ts";
import { withSentinelSourceSnapshotLock } from "../../src/sentinel/source_snapshot_lock.ts";

import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  digestSentinelSnapshot,
  sentinelSourceSnapshotPath,
} from "../../src/sentinel/shared_inventory.ts";

Deno.test("Source archive audit observes completed topology publications", async () => {
  const baseDir = await Deno.makeTempDir();
  try {
    const child = loadSentinelGraph({ version: 1, nodes: [], edges: [] })
      .snapshot();
    const childDigest = digestSentinelSnapshot(child);
    const parent = loadSentinelGraph({
      version: 1,
      nodes: [{
        id: "source-link",
        kind: "evidence",
        label: "Nested source",
        relationshipSources: [{
          caseId: "source",
          from: "app",
          to: "database",
          snapshotDigest: childDigest,
        }],
      }],
      edges: [],
    }).snapshot();
    const digest = digestSentinelSnapshot(parent);
    const data = join(baseDir, "data");
    const source = join(data, "sentinel-source-snapshots", "source");
    let audit!: ReturnType<typeof auditSentinelSourceSnapshots>;
    await withSentinelSourceSnapshotLock(baseDir, true, async () => {
      await Deno.mkdir(source, { recursive: true });
      await Deno.writeTextFile(
        join(source, digest + ".json"),
        JSON.stringify(parent),
      );
      await Deno.writeTextFile(
        join(source, childDigest + ".json"),
        JSON.stringify(child),
      );
      audit = auditSentinelSourceSnapshots(baseDir);
      const first = await Promise.race([
        audit.then(() => "audit"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("writer"), 20)
        ),
      ]);
      assertEquals(first, "writer");
      await Deno.writeTextFile(
        join(data, "sentinel-shared-topology.json"),
        JSON.stringify([{ sourceDigests: { source: digest } }]),
      );
    });
    assertEquals(await audit, {
      archivedCount: 2,
      referencedCount: 2,
      quarantined: [],
      missing: [],
      unreadableSnapshots: [],
      candidates: [],
      unavailableCases: [],
    });
    await Deno.writeTextFile(
      join(source, childDigest + ".json"),
      JSON.stringify(parent),
    );
    const invalid = await auditSentinelSourceSnapshots(baseDir);
    assertEquals(invalid.unreadableSnapshots, ["source/" + childDigest]);
    assertEquals(invalid.candidates, []);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Tidepool Sentinel workspace starts, steers, pauses, resumes and exports a durable assessment", async () => {
  const baseDir = await Deno.makeTempDir();
  try {
    const path = sentinelSnapshotPath(baseDir);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", label: "Application", kind: "asset" },
          {
            id: "finding",
            label: "Coverage gap",
            kind: "finding",
            severity: "high",
          },
        ],
        edges: [{ from: "finding", to: "app", relation: "affects" }],
      }),
    );

    const handle = createTidepoolSentinelHandler(
      {
        baseDir,
        config: {
          sentinel: {
            allow_model_access: true,
            model_worker_limit: 3,
            notify_incident_increases: true,
          },
        },
      } as unknown as BootstrapResult,
      (id) => id === "cloud-review" ? "waiting" : undefined,
    );
    const request = async (
      type: string,
      extra: Record<string, unknown> = {},
    ) => {
      let wire: string | undefined;
      const socket = {
        readyState: WebSocket.OPEN,
        send(value: string) {
          wire = value;
        },
      } as unknown as WebSocket;
      await handle({ topic: "sentinel", type, ...extra }, socket);
      assert(wire);
      return JSON.parse(wire);
    };

    recordSentinelModelUsage(path, "interactive", {
      inputTokens: 21,
      outputTokens: 7,
    });
    const beforeAssessment = await request("status");
    assertEquals(beforeAssessment.assessment, null);
    assertEquals(beforeAssessment.interactiveModelUsage, {
      calls: 1,
      inputTokens: 21,
      outputTokens: 7,
    });
    assertEquals(beforeAssessment.workerSettings, {
      gatewayLimit: 3,
      caseLimit: null,
    });
    assertEquals(beforeAssessment.notificationSettings, {
      gatewayEnabled: true,
      enabled: null,
      latest: null,
    });
    const muted = await request("incident_notifications", { enabled: false });
    assertEquals(muted.notificationSettings.enabled, false);
    assertEquals(
      (await request("status", { caseId: "cloud-review" })).notificationSettings
        .enabled,
      null,
    );
    assertEquals((await request("status")).notificationSettings.enabled, false);
    assertEquals(
      (await request("incident_notifications", { enabled: null }))
        .notificationSettings.enabled,
      null,
    );
    assertEquals((await request("worker_limit", { limit: 4 })).type, "error");
    assertEquals((await request("worker_limit", { limit: 1 })).workerSettings, {
      gatewayLimit: 3,
      caseLimit: 1,
    });
    assertEquals((await request("status")).workerSettings.caseLimit, 1);
    assertEquals(
      (await request("worker_limit", { limit: null })).workerSettings.caseLimit,
      null,
    );
    assertEquals(beforeAssessment.modelOutputSettings, {
      gatewayLanguage: "en",
      caseLanguage: null,
    });
    assertEquals(
      (await request("model_output_language", { language: "pt" })).type,
      "error",
    );
    assertEquals(
      (await request("model_output_language", { language: "ko" }))
        .modelOutputSettings.caseLanguage,
      "ko",
    );
    assertEquals(
      (await request("status")).modelOutputSettings.caseLanguage,
      "ko",
    );
    assertEquals(
      (await request("model_output_language", { language: null }))
        .modelOutputSettings.caseLanguage,
      null,
    );
    assertEquals((await request("add_case_hint", { hint: " " })).type, "error");
    const hinted = await request("add_case_hint", {
      hint: "Verify the patch inventory.",
    });
    assertEquals(hinted.caseHints.map(({ text }: { text: string }) => text), [
      "Verify the patch inventory.",
    ]);
    assertEquals((await request("status")).caseHints, hinted.caseHints);
    const hintDetail = await request("hint_detail", {
      hintId: hinted.caseHints[0].id,
    });
    assertEquals(hintDetail.type, "sentinel_hint_detail");
    assertEquals(hintDetail.hint, { ...hinted.caseHints[0], retained: false });
    assertEquals(
      (await request("hint_detail", {
        caseId: "isolated",
        hintId: hinted.caseHints[0].id,
      })).type,
      "error",
    );
    assertEquals(
      (await request("hint_detail", { hintId: hinted.caseHints[0].id + 1 }))
        .type,
      "error",
    );
    const started = await request("start", { goal: 'Review "app"' });
    assertEquals(started.type, "sentinel_state");
    assertEquals(started.assessment.active, true);
    assert(
      started.adaptive.tasks.some(({ kind }: { kind: string }) =>
        kind === "trace"
      ),
    );
    assert(
      started.provenance.edges.some(({ relation }: { relation: string }) =>
        relation === "produces"
      ),
    );
    recordSentinelModelUsage(path, started.assessment.revision, {
      inputTokens: 8,
      outputTokens: 3,
    });
    const activeStatus = await request("status");
    assertEquals(activeStatus.assessment.active, true);
    assertEquals(activeStatus.adaptive.modelUsage, {
      calls: 1,
      inputTokens: 8,
      outputTokens: 3,
    });
    assertEquals(
      activeStatus.interactiveModelUsage,
      beforeAssessment.interactiveModelUsage,
    );
    const assigned = await request("assign", {
      revision: started.adaptive.revision,
      kind: "impact",
      nodeId: "app",
    });
    assertEquals(assigned.type, "sentinel_state");
    const impact = assigned.adaptive.tasks.find(({ kind }: { kind: string }) =>
      kind === "impact"
    );
    assertEquals(impact?.status, "completed");
    assertStringIncludes(impact?.reason, "operator");
    const duplicate = await request("assign", {
      revision: started.adaptive.revision,
      kind: "impact",
      nodeId: "app",
    });
    assertEquals(
      duplicate.adaptive.tasks.length,
      assigned.adaptive.tasks.length,
    );
    assertEquals(
      (await request("assign", {
        revision: "stale",
        kind: "impact",
        nodeId: "app",
      })).type,
      "error",
    );
    assertEquals((await request("pause")).assessment.paused, true);
    assertEquals(
      (await request("set_goal", { goal: "Verify controls for app" }))
        .assessment.plan
        .goal,
      "Verify controls for app",
    );
    const pausedPlan = await request("status");
    assertEquals(pausedPlan.pendingInputs, false);
    const staged = await request("assign", {
      revision: pausedPlan.adaptive.revision,
      kind: "impact",
      nodeId: "app",
    });
    const stagedTask = staged.adaptive.tasks.find((
      { kind }: { kind: string },
    ) => kind === "impact");
    assertEquals(stagedTask?.status, "queued");
    assertEquals(stagedTask?.attempts, 0);
    const operation = {
      revision: staged.adaptive.revision,
      taskId: stagedTask.id,
    };
    const prioritized = await request("prioritize_task", operation);
    assertEquals(
      prioritized.adaptive.tasks.find(({ id }: { id: string }) =>
        id === stagedTask.id
      )?.prioritized,
      true,
    );
    const withdrawn = await request("withdraw_task_priority", operation);
    assertEquals(
      withdrawn.adaptive.tasks.find(({ id }: { id: string }) =>
        id === stagedTask.id
      )?.prioritized,
      undefined,
    );
    const priorGraph = JSON.parse(await Deno.readTextFile(path));
    const published = await request("import", {
      format: "graph",
      content: JSON.stringify({
        ...priorGraph,
        nodes: [...priorGraph.nodes, {
          id: "finding-after-pause",
          label: "Finding published during pause",
          kind: "finding",
          severity: "high",
        }],
        edges: [...priorGraph.edges, {
          from: "finding-after-pause",
          to: "app",
          relation: "affects",
        }],
      }),
    });
    assertEquals(published.assessment.revision, staged.assessment.revision);
    assertEquals(published.pendingInputs, true);
    assertEquals(
      published.adaptive.tasks.find(({ id }: { id: string }) =>
        id === stagedTask.id
      )?.attempts,
      0,
    );

    const validPublishedGraph = await Deno.readTextFile(path);
    await Deno.writeTextFile(path, "{");
    assertEquals((await request("resume")).type, "error");
    const afterFailedResume = await request("status");
    assertEquals(afterFailedResume.assessment.paused, true);
    assertEquals(
      afterFailedResume.assessment.revision,
      staged.assessment.revision,
    );
    assertEquals(
      afterFailedResume.adaptive.tasks.find(
        ({ id }: { id: string }) => id === stagedTask.id,
      )?.attempts,
      0,
    );
    await Deno.writeTextFile(path, validPublishedGraph);
    const resumed = await request("resume");
    assertEquals(resumed.assessment.paused, false);
    assertEquals(resumed.pendingInputs, undefined);
    assert(resumed.assessment.revision > published.assessment.revision);
    assert(resumed.adaptive.tasks.some(
      ({ kind, nodeId }: { kind: string; nodeId: string }) =>
        kind === "review_finding" && nodeId === "finding-after-pause",
    ));
    const carried = resumed.adaptive.tasks.find(({ kind }: { kind: string }) =>
      kind === "impact"
    );
    assertEquals(carried?.status, "completed");
    assert(carried.id !== stagedTask.id);
    assert(
      resumed.adaptive.history.some((
        { event, note }: { event: string; note: string },
      ) => event === "carried_forward" && note?.includes(stagedTask.id)),
    );
    const current = await request("status");
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    let failedId: string;
    try {
      const revision = current.adaptive.revision;
      store.sync(
        revision,
        [{ kind: "trace", nodeId: "app", depth: 3 }],
        revision,
      );
      const claim = store.claim(revision);
      assert(claim);
      failedId = claim.task.id;
      store.fail({
        taskId: failedId,
        leaseToken: claim.leaseToken,
        note: "Fixture failure",
      });
    } finally {
      store.close();
    }
    const retried = await request("retry_task", {
      revision: current.adaptive.revision,
      taskId: failedId,
    });
    const task = retried.adaptive.tasks.find(({ id }: { id: string }) =>
      id === failedId
    );
    assertEquals(task?.status, "completed");
    assertEquals(task?.attempts, 2);
    const report = await request("export", { format: "csv" });
    assertEquals(report.type, "export");
    assertStringIncludes(report.content, "Coverage gap");
    const named = await request("start", {
      caseId: "cloud-review",
      requestId: 5,
    });
    assertEquals(named.caseId, "cloud-review");
    assertEquals(named.requestId, 5);
    assert(named.cases.includes("cloud-review"));
    await request("import", {
      caseId: "asset-review",
      format: "graph",
      content: JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", label: "Named application", kind: "asset" },
          { id: "unique", label: "Distinct asset", kind: "asset" },
        ],
        edges: [{ from: "app", to: "unique", relation: "depends_on" }],
      }),
    });
    const inventory = await request("shared_inventory", {
      query: "named application",
      offset: 0,
    });
    assertEquals(inventory.type, "sentinel_shared_inventory");
    assertEquals(inventory.inventory.totalAssets, 1);
    assertEquals(inventory.inventory.assets[0].id, "app");
    assertEquals(
      inventory.inventory.assets[0].sources.map((
        { caseId }: { caseId: string },
      ) => caseId),
      [
        "main",
        "asset-review",
      ],
    );

    await request("import", {
      caseId: "topology-review",
      format: "graph",
      content: JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", label: "Application", kind: "asset" },
          { id: "unique", label: "Named dependency", kind: "asset" },
          { id: "different", label: "Additional dependency", kind: "asset" },
        ],
        edges: [
          { from: "app", to: "unique", relation: "depends_on" },
          { from: "different", to: "app", relation: "depends_on" },
        ],
      }),
    });
    const links = await request("shared_asset_links", {
      asset: "app",
      offset: 0,
    });
    assertEquals(links.type, "sentinel_shared_asset_links");
    const mainFindingSource = links.relationships.findings.find(
      ({ caseId }: { caseId: string }) => caseId === "main",
    );
    assert(mainFindingSource);
    const visibleFindingSnapshot = `main/${mainFindingSource.snapshotDigest}`;
    assertEquals(links.relationships.links, [
      {
        from: "app",
        to: "unique",
        relation: "depends_on",
        caseIds: ["asset-review", "topology-review"],
      },
      {
        from: "different",
        to: "app",
        relation: "depends_on",
        caseIds: ["topology-review"],
      },
    ]);
    assertEquals(
      (await request("shared_asset_links", { asset: "app", offset: 2 }))
        .relationships.links,
      [],
    );
    await request("import", {
      caseId: "sync-review",
      format: "graph",
      content: JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", label: "Local application", kind: "asset" },
          { id: "unique", label: "Local dependency", kind: "asset" },
        ],
        edges: [],
      }),
    });
    const syncPath = resolveSentinelCasePath(baseDir, "sync-review");
    const originalInventory = await Deno.readTextFile(syncPath);
    const beforeSync = await request("start", { caseId: "sync-review" });
    const synced = await request("sync_shared_topology", {
      caseId: "sync-review",
    });
    assertEquals(
      synced.assessment.revision,
      beforeSync.assessment.revision + 1,
    );
    assertEquals(await Deno.readTextFile(syncPath), originalInventory);
    assert(
      synced.provenance.edges.some((
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from === "asset:app" && to === "asset:unique" &&
        relation === "depends_on"
      ),
    );
    assert(
      synced.provenance.nodes.some(({ label }: { label: string }) =>
        label.includes("reported by asset-review, topology-review")
      ),
    );
    const sourceEvidence = synced.provenance.nodes.find((
      { label }: { label: string },
    ) => label.includes("reported by asset-review, topology-review"));
    for (const source of sourceEvidence.relationshipSources) {
      assert(/^[0-9a-f]{64}$/.test(source.snapshotDigest));
    }
    assertEquals(
      sourceEvidence.relationshipSources.map(
        (
          { snapshotDigest: _snapshotDigest, ...source }: Record<
            string,
            unknown
          >,
        ) => source,
      ),
      [
        { caseId: "asset-review", from: "app", to: "unique" },
        { caseId: "topology-review", from: "app", to: "unique" },
      ],
    );
    assert(
      !synced.provenance.nodes.some(({ sourceId }: { sourceId: string }) =>
        sourceId === "different"
      ),
    );
    const reviewTask = synced.assessment.result.tasks.find(
      ({ status }: { status: string }) => status === "completed",
    ).id;
    const reviewClaim = claimSentinelAssessmentReview(
      syncPath,
      synced.assessment.revision,
      reviewTask,
    )!;
    assert(
      completeSentinelAssessmentReview(
        syncPath,
        synced.assessment.revision,
        reviewTask,
        reviewClaim,
        "Consulted the original source asset.",
        [{
          tool: "sentinel_shared_asset_links",
          outcome: "returned",
          sourceSnapshots: [{
            caseId: "asset-review",
            assetId: "app",
            snapshotDigest:
              sourceEvidence.relationshipSources[0].snapshotDigest,
          }],
        }],
      ),
    );
    const repeated = await request("sync_shared_topology", {
      caseId: "sync-review",
    });
    assertEquals(repeated.assessment.revision, synced.assessment.revision);
    const auto = await request("set_topology_auto", {
      caseId: "sync-review",
      enabled: true,
    });
    assertEquals(auto.topologyAuto, true);
    let syncErrors = 0;
    const synchronizer = startSentinelTopologySync(baseDir, () => syncErrors++);
    await synchronizer.refresh();
    try {
      const source = resolveSentinelCasePath(baseDir, "asset-review");
      const secondSource = resolveSentinelCasePath(baseDir, "topology-review");
      const originalSource = await Deno.readTextFile(source);
      const originalSecond = await Deno.readTextFile(secondSource);
      await Deno.writeTextFile(source, "{");
      await synchronizer.refresh();
      assert(syncErrors > 0);
      const retained = await request("refresh", { caseId: "sync-review" });
      assertEquals(retained.assessment.revision, synced.assessment.revision);

      for (
        const [path, original] of [[source, originalSource], [
          secondSource,
          originalSecond,
        ]]
      ) {
        const graph = JSON.parse(original);
        graph.edges = [];
        await Deno.writeTextFile(path, JSON.stringify(graph));
      }
      await synchronizer.refresh();
      const withdrawn = await request("refresh", { caseId: "sync-review" });
      assertEquals(
        withdrawn.assessment.revision,
        synced.assessment.revision + 1,
      );
      assert(
        !withdrawn.provenance.edges.some(({ relation }: { relation: string }) =>
          relation === "depends_on"
        ),
      );
      assertEquals(await Deno.readTextFile(syncPath), originalInventory);
      const archive = await request("source_snapshot", {
        caseId: "sync-review",
        sourceCase: "asset-review",
        snapshotDigest: sourceEvidence.relationshipSources[0].snapshotDigest,
        asset: "app",
      });
      assertEquals(archive.type, "sentinel_source_snapshot");
      assertEquals(archive.graph, JSON.parse(originalSource));
      assertEquals(archive.citations, [{
        caseId: "sync-review",
        revision: synced.assessment.revision,
        focusId: sourceEvidence.id,
      }, {
        caseId: "sync-review",
        revision: synced.assessment.revision,
        focusId: `review:assessment:${reviewTask}`,
      }]);
      const savedReview = await request("revision", archive.citations[1]);
      assertEquals(savedReview.selectedAssessmentReview, reviewTask);
      assertEquals(
        savedReview.historical.reviews[0].analysis,
        "Consulted the original source asset.",
      );
      assertEquals(archive.moreCitations, false);
      const citation = await request("revision", archive.citations[0]);
      assertEquals(citation.focusId, sourceEvidence.id);
      assertEquals(citation.historical.revision, synced.assessment.revision);

      const extraCases = await Promise.all(
        Array.from({ length: 10 }, async (_, index) => {
          const id = `page-review-${index}`;
          const folder = dirname(resolveSentinelCasePath(baseDir, id));
          await Deno.mkdir(folder, { recursive: true, mode: 0o700 });
          await Deno.copyFile(
            join(dirname(syncPath), "sentinel-assessment.db"),
            join(folder, "sentinel-assessment.db"),
          );
          return folder;
        }),
      );
      try {
        const source = {
          caseId: "sync-review",
          sourceCase: "asset-review",
          snapshotDigest: sourceEvidence.relationshipSources[0].snapshotDigest,
          asset: "app",
        };
        const first = await request("source_snapshot", source);
        assertEquals(first.citations.length, 20);
        assertEquals(first.moreCitations, true);
        const second = await request("source_snapshot", {
          ...source,
          citationCursor: first.nextCitationCursor,
        });
        assertEquals(second.citations.length, 2);
        assertEquals(second.moreCitations, false);
        assertEquals(
          second.citations.map(({ caseId }: { caseId: string }) => caseId),
          ["page-review-9", "page-review-9"],
        );
        const keys = [...first.citations, ...second.citations].map(
          (entry) => JSON.stringify(entry),
        );
        assertEquals(new Set(keys).size, 22);
      } finally {
        for (const folder of extraCases) {
          await Deno.remove(folder, { recursive: true });
        }
      }
      const audit = await request("source_snapshot_audit", {
        caseId: "sync-review",
      });
      assertEquals(audit.type, "sentinel_source_snapshot_audit");
      assertEquals(audit.audit, {
        archivedCount: 3,
        referencedCount: 2,
        quarantined: [],
        missing: [],
        unreadableSnapshots: [],
        candidates: [visibleFindingSnapshot],
        unavailableCases: [],
      });
      const orphanDigest = sourceEvidence.relationshipSources[0].snapshotDigest;
      const orphanDirectory = join(
        baseDir,
        "data",
        "sentinel-source-snapshots",
        "orphan",
      );
      await Deno.mkdir(orphanDirectory, { recursive: true });
      await Deno.writeTextFile(
        join(orphanDirectory, orphanDigest + ".json"),
        originalSource,
      );
      const withOrphan = await request("source_snapshot_audit", {
        caseId: "sync-review",
      });
      const snapshotId = "orphan/" + orphanDigest;
      assertEquals(withOrphan.audit.candidates, [
        visibleFindingSnapshot,
        snapshotId,
      ]);
      const quarantined = await request("quarantine_source_snapshot", {
        sourceSnapshotId: snapshotId,
      });
      assertEquals(quarantined.audit.quarantined, [snapshotId]);
      assertEquals(quarantined.audit.candidates, [visibleFindingSnapshot]);
      const readable = await request("source_snapshot", {
        sourceCase: "orphan",
        snapshotDigest: orphanDigest,
        asset: "app",
      });
      assertEquals(readable.graph, JSON.parse(originalSource));
      const restored = await request("restore_source_snapshot", {
        sourceSnapshotId: snapshotId,
      });
      assertEquals(restored.audit.quarantined, []);
      assertEquals(restored.audit.candidates, [
        visibleFindingSnapshot,
        snapshotId,
      ]);
      const protectedSnapshot = await request("quarantine_source_snapshot", {
        sourceSnapshotId: "asset-review/" + orphanDigest,
      });
      assertEquals(protectedSnapshot.type, "error");
      const invalidArchive = await request("source_snapshot", {
        caseId: "sync-review",
        sourceCase: "../asset-review",
        snapshotDigest: sourceEvidence.relationshipSources[0].snapshotDigest,
        asset: "app",
      });
      assertEquals(invalidArchive.type, "error");

      assertEquals(
        (await request("set_topology_auto", {
          caseId: "sync-review",
          enabled: false,
        })).topologyAuto,
        false,
      );
      await Deno.writeTextFile(source, originalSource);
      await synchronizer.refresh();
      const disabled = await request("refresh", { caseId: "sync-review" });
      assertEquals(disabled.assessment.revision, withdrawn.assessment.revision);
    } finally {
      synchronizer.stop();
    }
    const overview = await request("case_overview", { caseId: "cloud-review" });
    assertEquals(overview.type, "sentinel_case_overview");
    assertEquals(
      overview.cases.find(({ id }: { id: string }) => id === "cloud-review")
        ?.coordinator,
      "waiting",
    );
    assert(
      overview.cases.some(({ id, status }: { id: string; status: string }) =>
        id === "main" && status === "running"
      ),
    );
    const pausedOverview = await request("case_lifecycle", {
      targetCase: "cloud-review",
      action: "pause",
    });
    assertEquals(pausedOverview.caseId, "main");
    assertEquals(pausedOverview.assessment.paused, false);
    assert(
      pausedOverview.caseOverview.some((
        { id, status }: { id: string; status: string },
      ) => id === "cloud-review" && status === "paused"),
    );
    const pausedCloudPath = resolveSentinelCasePath(baseDir, "cloud-review");
    await Deno.writeTextFile(
      pausedCloudPath,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "cloud", label: "Cloud account", kind: "asset" }],
        edges: [],
      }),
    );
    const checkedOverview = await request("case_overview");
    assertEquals(
      checkedOverview.cases.find(({ id }: { id: string }) =>
        id === "cloud-review"
      )?.pendingInputs,
      true,
    );
    const pollingOverview = await request("status", {
      includeCaseOverview: true,
    });
    assertEquals(
      pollingOverview.caseOverview.find(({ id }: { id: string }) =>
        id === "cloud-review"
      )?.pendingInputs,
      undefined,
    );
    await Deno.remove(pausedCloudPath);
    const resumedOverview = await request("case_lifecycle", {
      targetCase: "cloud-review",
      action: "resume",
    });
    assertEquals(resumedOverview.caseId, "main");
    assertEquals(
      resumedOverview.caseOverview.find(({ id }: { id: string }) =>
        id === "cloud-review"
      )?.status,
      "running",
    );
    const cloudPath = join(
      baseDir,
      "data",
      "sentinel-cases",
      "cloud-review",
      "sentinel.json",
    );
    await Deno.writeTextFile(
      sentinelAlertsPath(cloudPath),
      JSON.stringify(Array.from({ length: 26 }, (_, index) => ({
        type: "integrity_change",
        severity: "high",
        asset: "cloud",
        subject: "operator",
        observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        evidenceIds: [`audit-event-${index}`],
        triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
      }))),
    );

    assertEquals(
      await request("import", {
        caseId: "cloud-review",
        format: "graph",
        content: JSON.stringify({
          version: 1,
          nodes: [{ id: "cloud", kind: "asset", label: "Cloud asset" }],
          edges: [],
        }),
      }).then((state) =>
        state.provenance.nodes.some(({ id }: { id: string }) =>
          id === "asset:cloud"
        )
      ),
      true,
    );
    assert(
      !(await request("status")).provenance.nodes.some((
        { id }: { id: string },
      ) => id === "asset:cloud"),
    );
    const history = await request("history", { caseId: "cloud-review" });
    assertEquals(history.type, "sentinel_history");
    assertEquals(
      history.revisions.map(({ revision }: { revision: number }) => revision),
      [2, 1],
    );
    const older = await request("revision", {
      caseId: "cloud-review",
      revision: 1,
    });
    assertEquals(older.type, "sentinel_revision");
    assertEquals(older.alertFeedAvailable, false);
    assertEquals(older.historical.revision, 1);
    assert(
      !older.provenance.nodes.some(({ id }: { id: string }) =>
        id === "asset:cloud"
      ),
    );
    const historicalReport = await request("export", {
      caseId: "cloud-review",
      revision: 1,
      format: "markdown",
    });
    assertEquals(historicalReport.revision, 1);
    assertEquals(
      (await request("status", { caseId: "cloud-review" })).assessment.revision,
      2,
    );
    const cloud = await request("status", { caseId: "cloud-review" });
    const cloudAssigned = await request("assign", {
      caseId: "cloud-review",
      revision: cloud.adaptive.revision,
      kind: "impact",
      nodeId: "cloud",
    });
    assertEquals(cloudAssigned.type, "sentinel_state");
    const cloudStore = openSentinelAdaptiveStore(
      join(
        baseDir,
        "data",
        "sentinel-cases",
        "cloud-review",
        "sentinel-adaptive.db",
      ),
    );
    try {
      assertEquals(cloudStore.claimModelPlan(cloud.adaptive.revision), 1);
      cloudStore.completeModelPlan(cloud.adaptive.revision, 1);
    } finally {
      cloudStore.close();
    }
    await Deno.writeTextFile(sentinelAlertsPath(cloudPath), "[]");
    const newer = await request("import", {
      caseId: "cloud-review",
      format: "graph",
      content: JSON.stringify({
        version: 1,
        nodes: [{ id: "later", kind: "asset", label: "Later asset" }],
        edges: [],
      }),
    });
    assertEquals(newer.assessment.revision, 3);
    assertEquals(newer.alertFeedAvailable, true);
    const updatedIndex = await request("status", {
      caseId: "cloud-review",
      includeRevisions: true,
    });
    assertEquals(
      updatedIndex.revisions.map(({ revision }: { revision: number }) =>
        revision
      ),
      [3, 2, 1],
    );
    assertEquals(updatedIndex.revisions[0].summary, undefined);
    const compared = await request("revision", {
      caseId: "cloud-review",
      revision: 3,
      baseline: 2,
    });
    const transitions = compared.comparison.workerHistory;
    assert(transitions.length > 1);
    const page = await request("worker_history", {
      caseId: "cloud-review",
      revision: 2,
      before: transitions[0].cursor,
    });
    assertEquals(page.type, "sentinel_worker_history");
    assertEquals(page.history, transitions.slice(1));
    assertEquals(page.historyCursor, null);
    assertEquals(compared.comparison.revision, 2);
    const alertNodeId = compared.comparison.alertNodes[0].id;
    const focused = await request("revision", {
      caseId: "cloud-review",
      revision: 2,
      focusId: alertNodeId,
    });
    assertEquals(focused.focusId, alertNodeId);
    const unknownFocus = await request("revision", {
      caseId: "cloud-review",
      revision: 2,
      focusId: "missing",
    });
    assertEquals(unknownFocus.focusId, undefined);
    assertEquals(compared.comparison.fullAlerts.earlier.length, 26);
    const browsed = await request("revision_alerts", {
      caseId: "cloud-review",
      revision: 2,
    });
    assertEquals(browsed.type, "sentinel_revision_alerts");
    assertEquals(browsed.alerts, compared.comparison.fullAlerts.earlier);
    const oldestAlert = compared.comparison.fullAlerts.earlier[0];
    const sourceRevision = await request("revision", {
      caseId: "cloud-review",
      revision: 2,
    });
    const coverage = sourceRevision.historical.result.sharedGraph.observations
      .find(
        ({ task }: { task: string }) => task === "defense_coverage",
      );
    const auditCheck = coverage.facts.upstreamChecks.find(
      ({ id }: { id: string }) => id === "cloudtrail_logging_stopped",
    );
    const matches = await request("revision_alerts", {
      caseId: "cloud-review",
      revision: 2,
      upstreamCheck: auditCheck.id,
    });
    assertEquals(matches.alerts, browsed.alerts);
    const unrelatedMatches = await request("revision_alerts", {
      caseId: "cloud-review",
      revision: 2,
      upstreamCheck: "defender_network_block",
    });
    assertEquals(unrelatedMatches.alerts, []);
    const unknownCheck = await request("revision_alerts", {
      caseId: "cloud-review",
      revision: 2,
      upstreamCheck: "unknown",
    });
    assertEquals(unknownCheck.type, "error");
    assertEquals(auditCheck.alertCount, 26);
    assert(auditCheck.sample.length < auditCheck.alertCount);
    assertEquals(
      auditCheck.sample[0].focusAlertKey,
      sentinelAlertKey(oldestAlert),
    );

    assert(
      !compared.comparison.alertNodes.some((
        node: { alert: typeof oldestAlert },
      ) => sentinelAlertKey(node.alert) === sentinelAlertKey(oldestAlert)),
    );
    const expanded = await request("revision", {
      caseId: "cloud-review",
      revision: 2,
      focusAlertKey: auditCheck.sample[0].focusAlertKey,
    });
    assertEquals(
      expanded.provenance.nodes.find(({ id }: { id: string }) =>
        id === expanded.focusId
      )?.alert,
      oldestAlert,
    );
    assert(
      expanded.provenance.edges.some((edge: { from: string; to: string }) =>
        edge.from === expanded.focusId && edge.to === "asset:cloud"
      ),
    );
    assertEquals(compared.comparison.fullAlerts.later, []);
    assertEquals(
      compared.comparison.fullAlerts.earlier[0].triggeringAction,
      "cloudtrail.amazonaws.com:StopLogging",
    );
    assertEquals(
      compared.comparison.modelPlannerHistory.map((
        { outcome }: { outcome: string },
      ) => outcome),
      ["completed"],
    );
    assertEquals(compared.comparison.modelPlanner, {
      status: "completed",
      attempt: 1,
    });
    assertEquals(compared.comparison.adaptiveGoal, cloud.adaptive.goal.label);
    assert(compared.comparison.workerHistory.some(
      (
        { event, nodeId, revision }: {
          event: string;
          nodeId: string;
          revision: string;
        },
      ) =>
        event === "completed" && nodeId === "cloud" &&
        revision === cloud.adaptive.revision,
    ));
    assert(
      compared.comparison.observations.some(({ task }: { task: string }) =>
        task === "coverage"
      ),
    );
    assert(compared.comparison.adaptiveTasks.some(
      ({ kind, nodeId }: { kind: string; nodeId: string }) =>
        kind === "impact" && nodeId === "cloud",
    ));
    assert(
      compared.comparison.graph.nodes.some(({ id }: { id: string }) =>
        id === "cloud"
      ),
    );
    assert(
      !compared.comparison.graph.nodes.some(({ id }: { id: string }) =>
        id === "later"
      ),
    );
    assertEquals(
      (await request("revision", {
        caseId: "cloud-review",
        revision: 3,
        baseline: 3,
      }))
        .type,
      "error",
    );
    const archived = await request("revision", {
      caseId: "cloud-review",
      revision: 2,
    });
    assertEquals(archived.adaptive.revision, cloud.adaptive.revision);
    assertEquals(archived.adaptive.modelPlanner, {
      status: "completed",
      attempt: 1,
    });
    assert(archived.adaptive.tasks.some(
      (task: { kind: string; nodeId: string; status: string }) =>
        task.kind === "impact" && task.nodeId === "cloud" &&
        task.status === "completed",
    ));
    assert(
      archived.adaptive.notes.some(({ note }: { note: string }) =>
        note.includes("Operator assigned")
      ),
    );
    assert(
      !archived.provenance.nodes.some(({ id }: { id: string }) =>
        id === "asset:later"
      ),
    );
    const alertExport = await request("export", {
      caseId: "cloud-review",
      revision: 2,
      format: "alerts",
    });
    const exported = JSON.parse(alertExport.content);
    assertEquals(exported.revision, 2);
    assertEquals(
      exported.alerts[0].triggeringAction,
      "cloudtrail.amazonaws.com:StopLogging",
    );
    const emptyExport = await request("export", {
      caseId: "cloud-review",
      revision: 3,
      format: "alerts",
    });
    assertEquals(JSON.parse(emptyExport.content).alerts, []);
    assertEquals(
      (await request("export", {
        caseId: "cloud-review",
        revision: 1,
        format: "alerts",
      })).type,
      "error",
    );
    const graphExport = await request("export", {
      caseId: "cloud-review",
      revision: 2,
      format: "provenance",
    });
    const exportedGraph = JSON.parse(graphExport.content);
    assertEquals(exportedGraph.version, 1);
    assertEquals(exportedGraph.caseId, "cloud-review");
    assertEquals(exportedGraph.revision, 2);
    assertEquals(exportedGraph.provenance, archived.provenance);
    assertEquals(
      exportedGraph.observations,
      archived.historical.result.sharedGraph.observations,
    );
    const inventoryExport = await request("export", {
      caseId: "cloud-review",
      revision: 2,
      format: "inventory",
    });
    const exportedInventory = JSON.parse(inventoryExport.content);
    assertEquals(
      exportedInventory,
      archived.historical.result.sharedGraph.snapshot,
    );
    assertEquals(exportedGraph.inventory, exportedInventory);
    const copied = await request("import", {
      caseId: "cloud-copy",
      format: "graph",
      content: inventoryExport.content,
    });
    assertEquals(copied.type, "sentinel_state");
    assert(
      copied.provenance.nodes.some(({ id }: { id: string }) => id === "cloud"),
    );
    for (
      const format of [
        "csv",
        "provenance",
        "inventory",
        "decisions",
        "incidents",
      ]
    ) {
      const options = { caseId: "cloud-review", revision: 2, format };
      const defaultExport = await request("export", options);
      const japaneseExport = await request("export", {
        ...options,
        language: "ja",
      });
      assertEquals(defaultExport.type, "export", format);
      assertEquals(japaneseExport.content, defaultExport.content, format);
    }
    const spanish = await request("export", {
      caseId: "cloud-review",
      revision: 2,
      format: "markdown",
      language: "es",
    });
    assertStringIncludes(
      spanish.content,
      "# Informe de investigación de Sentinel",
    );
    assertStringIncludes(spanish.content, "## Procedencia");
    assertStringIncludes(spanish.content, "Operator assigned");
    for (
      const [language, title] of [
        ["ko", "# Sentinel 조사 보고서"],
        ["zh", "# Sentinel 调查报告"],
        ["ja", "# Sentinel 調査レポート"],
      ]
    ) {
      const localized = await request("export", {
        caseId: "cloud-review",
        revision: 2,
        format: "markdown",
        language,
      });
      assertStringIncludes(localized.content, title);
      assertStringIncludes(localized.content, "Operator assigned");
    }
    const archivedReport = await request("export", {
      caseId: "cloud-review",
      revision: 2,
      format: "markdown",
    });
    assertStringIncludes(archivedReport.content, "Operator assigned");
    assertStringIncludes(archivedReport.content, "### Model planning attempts");
    assertStringIncludes(
      archivedReport.content,
      "Model planner · completed · Attempt 1",
    );
    assertStringIncludes(archivedReport.content, "Adaptive task transitions");
    assertStringIncludes(archivedReport.content, "completed · Attempt 1");
    const currentReport = await request("export", {
      caseId: "cloud-review",
      format: "markdown",
    });
    assertEquals(currentReport.revision, 3);
    assert(!currentReport.content.includes("Operator assigned"));
    assertEquals(
      (await request("revision", { caseId: "cloud-review", revision: 99 }))
        .type,
      "error",
    );
    const stoppedCloud = await request("case_lifecycle", {
      targetCase: "cloud-review",
      action: "stop",
    });
    assertEquals(stoppedCloud.assessment.active, true);
    assertEquals(
      stoppedCloud.caseOverview.find(({ id }: { id: string }) =>
        id === "cloud-review"
      )?.status,
      "stopped",
    );
    assertEquals(
      (await request("revision", { caseId: "cloud-review", revision: 2 }))
        .historical.revision,
      2,
    );
    const beforeContinue = await request("status", { caseId: "cloud-review" });
    const continuedCloud = await request("case_lifecycle", {
      targetCase: "cloud-review",
      action: "continue",
    });
    assertEquals(continuedCloud.caseId, "main");
    assertEquals(
      continuedCloud.caseOverview.find(({ id }: { id: string }) =>
        id === "cloud-review"
      )?.status,
      "running",
    );
    const afterContinue = await request("status", { caseId: "cloud-review" });
    assertEquals(afterContinue.assessment.plan, beforeContinue.assessment.plan);
    assertEquals(
      afterContinue.assessment.revision,
      beforeContinue.assessment.revision,
    );
    assertEquals(
      afterContinue.adaptive.revision,
      beforeContinue.adaptive.revision,
    );
    await request("import", {
      caseId: "alias-review",
      format: "graph",
      content: JSON.stringify({
        version: 1,
        nodes: [
          {
            id: "alt-app",
            label: "Application",
            kind: "asset",
            aliases: ["app"],
          },
          { id: "unique", label: "Distinct asset", kind: "asset" },
          {
            id: "alias-finding",
            label: "Dependency advisory",
            kind: "finding",
            severity: "medium",
          },
          { id: "scan-report", label: "Scan report", kind: "evidence" },
        ],
        edges: [
          { from: "alt-app", to: "unique", relation: "depends_on" },
          { from: "alias-finding", to: "alt-app", relation: "affects" },
          { from: "scan-report", to: "alias-finding", relation: "supports" },
        ],
      }),
    });
    const aliasedLinks = await request("shared_asset_links", {
      asset: "app",
      sourceCase: "asset-review",
    });
    assertEquals(aliasedLinks.relationships.links[0].remapped, [{
      caseId: "alias-review",
      from: "alt-app",
      to: "unique",
    }]);
    const finding = aliasedLinks.relationships.findings.find(
      ({ caseId }: { caseId: string }) => caseId === "alias-review",
    );
    const { snapshotDigest, ...reportedFinding } = finding;
    assertEquals(reportedFinding, {
      caseId: "alias-review",
      assetId: "alt-app",
      finding: {
        id: "alias-finding",
        label: "Dependency advisory",
        kind: "finding",
        severity: "medium",
      },
    });
    const sourceRequest = {
      sourceCase: finding.caseId,
      asset: finding.assetId,
      finding: finding.finding.id,
      snapshotDigest,
    };
    const publishedFinding = await request(
      "shared_finding_source",
      sourceRequest,
    );
    assertEquals(publishedFinding.type, "sentinel_source_snapshot");
    assertEquals(publishedFinding.caseId, "main");
    assertEquals(publishedFinding.asset, "alias-finding");
    assertEquals(
      digestSentinelSnapshot(publishedFinding.graph),
      snapshotDigest,
    );
    assert(publishedFinding.graph.edges.some(
      (
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from === "scan-report" && to === publishedFinding.asset &&
        relation === "supports",
    ));
    const unrelated = await request("shared_finding_source", {
      ...sourceRequest,
      asset: "unique",
    });
    assertStringIncludes(unrelated.message, "unavailable for this asset");
    const stale = await request("shared_finding_source", {
      ...sourceRequest,
      snapshotDigest: "0".repeat(64),
    });
    assertStringIncludes(stale.message, "reporting inventory changed");
    const reportingCasePath = resolveSentinelCasePath(baseDir, finding.caseId);
    const reportingPublication = await Deno.readTextFile(reportingCasePath);
    try {
      const replacement = JSON.parse(reportingPublication);
      replacement.edges = replacement.edges.filter(
        ({ relation }: { relation: string }) => relation !== "affects",
      );
      await Deno.writeTextFile(reportingCasePath, JSON.stringify(replacement));
      const archivedFinding = await request(
        "shared_finding_source",
        sourceRequest,
      );
      assertEquals(archivedFinding.type, "sentinel_source_snapshot");
      assertEquals(archivedFinding.published, false);
      assertEquals(archivedFinding.graph, publishedFinding.graph);
    } finally {
      await Deno.writeTextFile(reportingCasePath, reportingPublication);
    }
    const reportingCase = await request("status", { caseId: finding.caseId });
    for (
      const graph of [
        reportingCase.provenance,
        (await request("start", { caseId: finding.caseId })).provenance,
      ]
    ) {
      const findingNode = graph.nodes.find(
        (
          { id, kind, sourceId }: {
            id: string;
            kind: string;
            sourceId?: string;
          },
        ) => kind === "finding" && (sourceId ?? id) === finding.finding.id,
      );
      assert(findingNode);
      const evidenceNode = graph.nodes.find(
        (
          { id, kind, sourceId }: {
            id: string;
            kind: string;
            sourceId?: string;
          },
        ) => kind === "evidence" && (sourceId ?? id) === "scan-report",
      );
      assert(evidenceNode);
      assert(graph.edges.some(
        (
          { from, to, relation }: {
            from: string;
            to: string;
            relation: string;
          },
        ) =>
          from === evidenceNode.id && to === findingNode.id &&
          relation === "supports",
      ));
    }
    const spdxImport = await request("import", {
      caseId: "spdx-review",
      format: "spdx",
      source: "project",
      content: JSON.stringify({
        spdxVersion: "SPDX-2.3",
        packages: [{
          SPDXID: "SPDXRef-library",
          name: "library",
          versionInfo: "1.0",
        }],
      }),
    });
    assert(
      spdxImport.provenance.nodes.some(({ label }: { label: string }) =>
        label === "library@1.0"
      ),
    );
    const importGraph = (id: string, label = id, mode = "merge") =>
      request("import", {
        caseId: "spdx-review",
        format: "graph",
        mode,
        content: JSON.stringify({
          version: 1,
          nodes: [{ id, label, kind: "asset" }],
          edges: [],
        }),
      });
    await Promise.all([importGraph("linked-app"), importGraph("linked-db")]);
    const mergedPath = resolveSentinelCasePath(baseDir, "spdx-review");
    const mergedInventory = await Deno.readTextFile(mergedPath);
    assertEquals(
      JSON.parse(mergedInventory).nodes.map(({ label }: { label: string }) =>
        label
      ),
      [
        "linked-app",
        "linked-db",
        "library@1.0",
      ],
    );
    assertEquals((await importGraph("linked-db", "Conflict")).type, "error");
    assertEquals(await Deno.readTextFile(mergedPath), mergedInventory);
    const review = {
      caseId: "spdx-review",
      format: "graph",
      mode: "replace",
      content: JSON.stringify({
        version: 1,
        nodes: [{
          id: "reviewed",
          label: "Reviewed",
          kind: "asset",
        }],
        edges: [],
      }),
    };
    const preview = await request("preview_import", review);
    assertEquals(preview.type, "sentinel_import_preview");
    assertEquals(preview.preview.currentNodes, 3);
    assertEquals(preview.preview.removedNodes, 3);
    assertEquals(preview.preview.addedNodes, 1);
    assertEquals(preview.preview.records.added, [{
      id: "reviewed",
      label: "Reviewed",
      kind: "asset",
    }]);
    assertEquals(preview.preview.records.removed.length, 3);
    assertEquals(await Deno.readTextFile(mergedPath), mergedInventory);
    await importGraph("other");
    const changed = await request("import", {
      ...review,
      inventoryDigest: preview.preview.inventoryDigest,
    });
    assertEquals(changed.type, "error");
    assertStringIncludes(changed.message, "changed after the preview");
    const fresh = await request("preview_import", review);
    const applied = await request("import", {
      ...review,
      inventoryDigest: fresh.preview.inventoryDigest,
    });
    assert(
      applied.provenance.nodes.some(({ label }: { label: string }) =>
        label === "Reviewed"
      ),
    );
    await importGraph("replacement", "Replacement", "replace");
    assertEquals(
      JSON.parse(await Deno.readTextFile(mergedPath)).nodes.length,
      1,
    );
    const incidentCase = "incident-review";
    const incidentPath = resolveSentinelCasePath(baseDir, incidentCase);
    await request("import", {
      caseId: incidentCase,
      format: "graph",
      content: JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "App" },
          {
            id: "finding",
            kind: "finding",
            severity: "high",
            label: "Finding",
          },
          { id: "log", kind: "evidence", label: "Log" },
        ],
        edges: [
          { from: "finding", to: "app", relation: "affects" },
          { from: "log", to: "finding", relation: "supports" },
        ],
      }),
    });
    await Deno.writeTextFile(
      sentinelAlertsPath(incidentPath),
      JSON.stringify(
        Array.from({ length: 30 }, (_, index) => ({
          type: index % 2
            ? "network_security_alert"
            : "authentication_failure_burst",
          severity: index % 2 ? "high" : "medium",
          asset: "app",
          subject: "test",
          observedAt: "2026-01-01T00:00:00.000Z",
          evidenceIds: ["audit-" + index],
        })),
      ),
    );
    const incidentState = await request("start", { caseId: incidentCase });
    const findingReview = {
      caseId: incidentCase,
      revision: incidentState.assessment.revision,
      findingId: "finding",
      disposition: "confirmed",
      note: "  Verified against supporting logs.  ",
    };
    assertEquals(
      (await request("review_finding", {
        ...findingReview,
        findingId: "app",
      })).type,
      "error",
    );
    assertEquals(
      (await request("review_finding", {
        ...findingReview,
        revision: findingReview.revision + 1,
      })).type,
      "error",
    );
    const savedFinding = await request("review_finding", findingReview);
    assertEquals(
      savedFinding.findingReviews[0].note,
      "Verified against supporting logs.",
    );
    const archivedFinding = await request("revision", {
      caseId: incidentCase,
      revision: findingReview.revision,
    });
    assertEquals(archivedFinding.findingReviews, savedFinding.findingReviews);
    for (const view of [savedFinding, archivedFinding]) {
      assertEquals(
        view.provenance.nodes.find(({ id }: { id: string }) =>
          id === "finding:finding"
        ).findingReviews,
        savedFinding.findingReviews,
      );
    }
    const findingCsv = await request("export", {
      caseId: incidentCase,
      revision: findingReview.revision,
      format: "csv",
    });
    assertStringIncludes(findingCsv.content, ',"confirmed"');
    const findingGraph = await request("export", {
      caseId: incidentCase,
      revision: findingReview.revision,
      format: "provenance",
    });
    assertEquals(
      JSON.parse(findingGraph.content).findingReviews,
      savedFinding.findingReviews,
    );
    assertEquals(
      JSON.parse(findingGraph.content).provenance,
      archivedFinding.provenance,
    );
    const incidentId =
      incidentState.provenance.nodes.find((node: { incident?: unknown }) =>
        node.incident
      ).sourceId;
    const incidentQuery = {
      caseId: incidentCase,
      revision: incidentState.assessment.revision,
      incidentId,
    };
    const decision = await request("review_incident", {
      ...incidentQuery,
      disposition: "investigating",
      note: "Reviewing the source alerts.",
    });
    assertEquals(
      decision.incidentReviews[0].note,
      "Reviewing the source alerts.",
    );
    assertEquals(
      (await request("review_incident", {
        ...incidentQuery,
        revision: incidentQuery.revision + 1,
        disposition: "resolved",
        note: "Stale submission.",
      })).type,
      "error",
    );
    const resolved = await request("review_incident", {
      ...incidentQuery,
      disposition: "resolved",
      note: "Confirmed maintenance.",
    });
    assertEquals(
      resolved.incidentReviews.map(({ disposition }: { disposition: string }) =>
        disposition
      ),
      ["resolved", "investigating"],
    );
    const archivedIncident = await request("revision", {
      caseId: incidentCase,
      revision: incidentQuery.revision,
    });
    assertEquals(archivedIncident.incidentReviews, resolved.incidentReviews);
    const reviewNode = archivedIncident.provenance.nodes.find(
      (node: { incidentReview?: { disposition: string } }) =>
        node.incidentReview?.disposition === "resolved",
    );
    assertEquals(reviewNode.incidentReview.note, "Confirmed maintenance.");
    const candidateNode = archivedIncident.provenance.nodes.find(
      (node: { incident?: unknown; sourceId: string }) =>
        node.incident && node.sourceId === incidentId,
    );
    assert(archivedIncident.provenance.edges.some(
      (edge: { from: string; to: string; relation: string }) =>
        edge.from === reviewNode.id && edge.to === candidateNode.id &&
        edge.relation === "references",
    ));
    const reviewExport = await request("export", {
      ...incidentQuery,
      format: "provenance",
    });
    assertEquals(
      JSON.parse(reviewExport.content).provenance,
      archivedIncident.provenance,
    );
    const incidentReport = await request("export", {
      ...incidentQuery,
      format: "markdown",
    });
    assertStringIncludes(incidentReport.content, "Confirmed maintenance&#46;");
    for (let index = 0; index < 10; index++) {
      await request("review_finding", {
        ...findingReview,
        note: `Finding decision ${index}`,
      });
      await request("review_incident", {
        ...incidentQuery,
        disposition: "investigating",
        note: `Incident decision ${index}`,
      });
    }
    for (
      const [kind, subjectId, oldest, total] of [
        ["finding", "finding", "Verified against supporting logs.", 11],
        ["incident", incidentId, "Reviewing the source alerts.", 12],
      ] as const
    ) {
      const historyRequest = {
        caseId: incidentCase,
        revision: incidentQuery.revision,
        kind,
        subjectId,
      };
      const first = await request("decision_history", historyRequest);
      assertEquals(first.type, "sentinel_decision_history");
      assertEquals(first.decisions.length, 10);
      assert(first.nextBefore);
      const last = await request("decision_history", {
        ...historyRequest,
        before: first.nextBefore,
      });
      assertEquals(last.decisions.length, total - 10);
      assertEquals(last.decisions.at(-1).note, oldest);
      assertEquals(last.nextBefore, null);
      assertEquals(
        (await request("decision_history", {
          ...historyRequest,
          revision: historyRequest.revision + 1,
        })).type,
        "error",
      );
    }
    for (const revision of [undefined, incidentQuery.revision]) {
      const historyExport = await request("export", {
        caseId: incidentCase,
        revision,
        format: "decisions",
      });
      const history = JSON.parse(historyExport.content);
      assertEquals(history.version, 1);
      assertEquals(history.caseId, incidentCase);
      assertEquals(history.revision, incidentQuery.revision);
      assertEquals(history.findingReviews.length, 11);
      assertEquals(history.incidentReviews.length, 12);
      assertEquals(
        history.findingReviews.at(-1).note,
        "Verified against supporting logs.",
      );
      assertEquals(
        history.incidentReviews.at(-1).note,
        "Reviewing the source alerts.",
      );
    }
    for (
      const [kind, subjectId, note] of [
        ["finding", "finding", "Verified against supporting logs."],
        ["incident", incidentId, "Reviewing the source alerts."],
      ] as const
    ) {
      const detail = await request("decision_detail", {
        caseId: incidentCase,
        kind,
        decisionId: 1,
      });
      assertEquals(detail.type, "sentinel_decision_detail");
      assertEquals(detail.decision.subjectId, subjectId);
      assertEquals(detail.decision.revision, incidentQuery.revision);
      assertEquals(detail.decision.note, note);
      assertEquals(detail.decision.retained, true);
    }
    assertEquals(
      (await request("decision_detail", {
        caseId: incidentCase,
        kind: "finding",
        decisionId: 999999,
      })).type,
      "error",
    );
    const incidentList = await request("incident_page", {
      caseId: incidentCase,
      revision: incidentQuery.revision,
      offset: 0,
    });
    assertEquals(incidentList.type, "sentinel_incident_page");
    assertEquals(incidentList.total, 1);
    assertEquals(incidentList.incidents[0].sourceId, incidentId);
    assertEquals(incidentList.incidents[0].incident.alertCount, 30);
    const incidentPlannerStore = openSentinelAdaptiveStore(
      join(dirname(incidentPath), "sentinel-adaptive.db"),
    );
    try {
      assertEquals(
        incidentPlannerStore.claimModelPlan(
          incidentState.adaptive.revision,
          { incidentCandidateIds: [incidentId] },
        ),
        1,
      );
    } finally {
      incidentPlannerStore.close();
    }
    const savedPlan = await request("revision", {
      caseId: incidentCase,
      revision: incidentQuery.revision,
    });
    const plannedIncident =
      savedPlan.adaptive.modelPlannerHistory[0].incidentCandidateIds[0];
    assertEquals(plannedIncident, incidentId);
    const incidentFocus = await request("revision", {
      caseId: incidentCase,
      revision: incidentQuery.revision,
      focusIncidentId: plannedIncident,
    });
    assertEquals(incidentFocus.focusId, `observation:assessment:${incidentId}`);
    const lastAlert = incidentFocus.provenance.nodes.find(
      (node: { alert?: { evidenceIds: string[] } }) =>
        node.alert?.evidenceIds.includes("audit-29"),
    );
    assert(lastAlert);
    assert(incidentFocus.provenance.edges.some(
      (
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from === incidentFocus.focusId && to === lastAlert.id &&
        relation === "references",
    ));
    assertEquals(
      (await request("revision", {
        caseId: incidentCase,
        revision: incidentQuery.revision,
        focusIncidentId: "incident:" + "0".repeat(64),
      })).type,
      "error",
    );
    const incidentExport = await request("export", {
      caseId: incidentCase,
      revision: incidentQuery.revision,
      format: "incidents",
    });
    const incidentReportJson = JSON.parse(incidentExport.content);
    assertEquals(incidentReportJson.caseId, incidentCase);
    assertEquals(incidentReportJson.incidents[0].id, incidentId);
    assertEquals(incidentReportJson.incidents[0].alertReferences.length, 30);
    assertEquals(
      incidentReportJson.incidents[0].latestReview.note,
      "Incident decision 9",
    );
    const firstPage = await request("incident_alerts", incidentQuery);
    assertEquals(firstPage.type, "sentinel_incident_alerts");
    assertEquals(firstPage.total, 30);
    assertEquals(firstPage.nextOffset, 10);
    const lastPage = await request("incident_alerts", {
      ...incidentQuery,
      offset: 20,
    });
    assertEquals(lastPage.nextOffset, null);
    assertEquals(lastPage.alerts.at(-1).evidenceIds, ["audit-29"]);
    const focusedIncidentAlert = await request("revision", {
      caseId: incidentCase,
      revision: incidentQuery.revision,
      focusAlertKey: lastPage.alerts.at(-1).focusAlertKey,
      focusIncidentId: incidentId,
    });
    assert(focusedIncidentAlert.focusId);
    assert(
      focusedIncidentAlert.provenance.nodes.some(({ id }: { id: string }) =>
        id === focusedIncidentAlert.focusId
      ),
    );
    assert(
      focusedIncidentAlert.provenance.edges.some((
        { from, to }: { from: string; to: string },
      ) =>
        from === `observation:assessment:${incidentId}` &&
        to === focusedIncidentAlert.focusId
      ),
    );
    const incidentAlertsPath = sentinelAlertsPath(incidentPath);
    const originalAlerts = JSON.parse(
      await Deno.readTextFile(incidentAlertsPath),
    );
    const duplicateAlert = {
      ...originalAlerts[0],
      subject: "Later duplicate",
      observedAt: "2026-01-01T00:00:01.000Z",
    };
    await Deno.writeTextFile(
      incidentAlertsPath,
      JSON.stringify([
        {
          ...originalAlerts[0],
          asset: "unrelated",
          evidenceIds: ["unrelated-event"],
        },
        ...originalAlerts,
        duplicateAlert,
      ]),
    );
    const carriedIncident = await request("refresh", { caseId: incidentCase });
    assertEquals(
      carriedIncident.assessment.revision,
      incidentQuery.revision + 1,
    );
    assertEquals(
      carriedIncident.incidentReviews[0].revision,
      incidentQuery.revision,
    );
    assertEquals(
      carriedIncident.incidentReviews[0].note,
      "Incident decision 9",
    );
    const unrelatedFocus = await request("revision", {
      caseId: incidentCase,
      revision: carriedIncident.assessment.revision,
      focusIncidentId: incidentId,
      focusAlertKey: sentinelAlertKey({
        ...originalAlerts[0],
        asset: "unrelated",
        evidenceIds: ["unrelated-event"],
      }),
    });
    assertEquals(unrelatedFocus.type, "error");
    assertStringIncludes(unrelatedFocus.message, "not a contributing alert");
    const duplicateFocus = {
      caseId: incidentCase,
      revision: carriedIncident.assessment.revision,
      focusAlertKey: sentinelAlertKey(duplicateAlert),
    };
    const newestAlert = await request("revision", duplicateFocus);
    const exactMember = await request("revision", {
      ...duplicateFocus,
      focusIncidentId: incidentId,
    });
    assertEquals(newestAlert.focusId, exactMember.focusId);
    assertEquals(
      newestAlert.provenance.nodes.find(({ id }: { id: string }) =>
        id === newestAlert.focusId
      ).alert.subject,
      duplicateAlert.subject,
    );
    assertEquals(
      exactMember.provenance.nodes.find(({ id }: { id: string }) =>
        id === exactMember.focusId
      ).alert.subject,
      originalAlerts[0].subject,
    );
    const carriedHistory = await request("decision_history", {
      caseId: incidentCase,
      revision: carriedIncident.assessment.revision,
      kind: "incident",
      subjectId: incidentId,
    });
    assertEquals(carriedHistory.decisions[0].revision, incidentQuery.revision);
    const archivedDb = new DatabaseSync(
      join(dirname(incidentPath), "sentinel-assessment.db"),
    );
    try {
      const row = archivedDb.prepare(
        "SELECT result FROM assessment WHERE id = 1",
      ).get()!;
      const legacy = JSON.parse(String(row.result));
      const observation = legacy.sharedGraph.observations.find(
        ({ task }: { task: string }) => task === "incident_correlation",
      );
      delete observation.facts.candidates[0].alertReferences;
      archivedDb.prepare("UPDATE assessment SET result = ? WHERE id = 1").run(
        JSON.stringify(legacy),
      );
      archivedDb.prepare(
        "UPDATE assessment_history SET result = ? WHERE revision = ?",
      )
        .run(JSON.stringify(legacy), carriedIncident.assessment.revision);
    } finally {
      archivedDb.close();
    }
    const legacyAlerts = await request("incident_alerts", {
      ...incidentQuery,
      revision: carriedIncident.assessment.revision,
    });
    assertEquals(legacyAlerts.total, 30);
    await Deno.writeTextFile(
      incidentAlertsPath,
      JSON.stringify(originalAlerts),
    );
    const carriedLegacy = await request("refresh", { caseId: incidentCase });
    assertEquals(
      carriedLegacy.assessment.revision,
      carriedIncident.assessment.revision + 1,
    );
    assertEquals(
      carriedLegacy.incidentReviews,
      carriedIncident.incidentReviews,
    );

    originalAlerts[0].subject = "updated incident evidence";
    await Deno.writeTextFile(
      incidentAlertsPath,
      JSON.stringify(originalAlerts),
    );
    const changedIncident = await request("refresh", { caseId: incidentCase });
    assertEquals(
      changedIncident.assessment.revision,
      carriedLegacy.assessment.revision + 1,
    );
    assert(
      changedIncident.provenance.nodes.some((
        node: { sourceId: string; incident?: unknown },
      ) => node.incident && node.sourceId === incidentId),
    );
    assertEquals(changedIncident.incidentReviews, []);
    await Deno.writeTextFile(sentinelAlertsPath(incidentPath), "[]");
    const nextReview = await request("refresh", { caseId: incidentCase });
    assert(nextReview.assessment.revision > incidentQuery.revision);
    await request("review_finding", {
      ...findingReview,
      revision: nextReview.assessment.revision,
      disposition: "resolved",
      note: "Verified the control.",
    });
    const comparedReviews = await request("revision", {
      caseId: incidentCase,
      revision: nextReview.assessment.revision,
      baseline: incidentQuery.revision,
    });
    assertEquals(
      comparedReviews.comparison.findingReviews[0].disposition,
      "confirmed",
    );
    assertEquals(comparedReviews.findingReviews[0].disposition, "resolved");
    assertEquals(
      comparedReviews.comparison.incidentNodes[0].sourceId,
      incidentId,
    );
    assertEquals(
      comparedReviews.comparison.incidentReviews[0].disposition,
      "investigating",
    );
    assertEquals(comparedReviews.incidentReviews, []);

    assertEquals((await request("stop")).assessment.active, false);
    assertEquals(
      (await request("status", { caseId: "cloud-review" })).assessment.active,
      true,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Tidepool completion pins the goal and evidence revision and archives the operator note", async () => {
  const baseDir = await Deno.makeTempDir();
  try {
    const path = sentinelSnapshotPath(baseDir);
    const graph = {
      version: 1,
      nodes: [{ id: "app", kind: "asset", label: "Application" }],
      edges: [],
    };
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const handle = createTidepoolSentinelHandler(
      { baseDir, config: {} } as BootstrapResult,
    );
    const request = async (
      type: string,
      payload: Record<string, unknown> = {},
    ) => {
      let frameText: string | undefined;
      await handle({ type, ...payload }, {
        readyState: WebSocket.OPEN,
        send(frame: string) {
          frameText = frame;
        },
      } as WebSocket);
      assert(frameText);
      return JSON.parse(frameText);
    };
    assertEquals(
      (await request("incident_notifications", { enabled: true })).type,
      "error",
    );
    const started = await request("start", { goal: "Review the application" });
    const outcome = {
      revision: started.assessment.revision,
      expectedGoal: "Review the application",
      note: "Reviewed the saved evidence.",
    };
    assertEquals(
      (await request("complete_goal", { ...outcome, expectedGoal: "Old goal" }))
        .type,
      "error",
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...graph,
        nodes: [{ ...graph.nodes[0], label: "Updated application" }],
      }),
    );
    assertEquals((await request("complete_goal", outcome)).type, "error");
    const refreshed = await request("refresh");
    assert(refreshed.assessment.revision > outcome.revision);
    assertEquals((await request("complete_goal", outcome)).type, "error");
    const revision = refreshed.assessment.revision;
    const completed = await request("complete_goal", { ...outcome, revision });
    assertEquals(completed.assessment.active, false);
    assertEquals(completed.assessment.completion.note, outcome.note);
    assertEquals(
      (await request("complete_goal", { ...outcome, revision })).type,
      "error",
    );
    const overview = await request("case_overview");
    assertEquals(
      overview.cases.find(({ id }: { id: string }) => id === "main").status,
      "completed",
    );
    const stopped = await request("stop");
    assertEquals(
      stopped.assessment.completion,
      completed.assessment.completion,
    );
    const restarted = await request("start", {
      goal: "Review new information",
    });
    assert(restarted.assessment.revision > revision);
    assertEquals(restarted.assessment.completion, undefined);
    const archived = await request("revision", { revision });
    assertEquals(
      archived.historical.completion,
      completed.assessment.completion,
    );
    const report = await request("export", { revision, format: "markdown" });
    assertStringIncludes(report.content, "Completion note");
    assertStringIncludes(report.content, "Reviewed the saved evidence&#46;");
    const structured = await request("export", {
      revision,
      format: "provenance",
    });
    assertEquals(
      JSON.parse(structured.content).completion,
      completed.assessment.completion,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Historical peer finding provenance reopens the exact archived reporting graph", async () => {
  const baseDir = await Deno.makeTempDir();
  try {
    const path = sentinelSnapshotPath(baseDir);
    await Deno.mkdir(dirname(path), { recursive: true });
    const asset = { id: "local-app", kind: "asset", label: "Local app" };
    const inventory = { version: 1, nodes: [asset], edges: [] };
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    const original = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, original);
    const reporting = loadSentinelGraph({
      version: 1,
      nodes: [
        { id: "remote-app", kind: "asset", label: "Reporting app" },
        {
          id: "remote-finding",
          kind: "finding",
          label: "Original finding",
          severity: "medium",
        },
      ],
      edges: [{
        from: "remote-finding",
        to: "remote-app",
        relation: "affects",
      }],
    }).snapshot();
    const snapshotDigest = digestSentinelSnapshot(reporting);
    const citation = {
      localAssetId: asset.id,
      sourceCaseId: "peer",
      sourceAssetId: "remote-app",
      sourceFindingId: "remote-finding",
      snapshotDigest,
    };
    const archive = sentinelSourceSnapshotPath(baseDir, "peer", snapshotDigest);
    await Deno.mkdir(dirname(archive), { recursive: true });
    await Deno.writeTextFile(archive, JSON.stringify(reporting), {
      mode: 0o600,
    });
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      const identity = adaptiveRevision(original);
      assertEquals(
        store.applyModelPlan(identity, null, [{
          kind: "trace",
          nodeId: asset.id,
          plannerRound: {
            identity,
            attempt: 1,
            peerFindingCitations: [citation],
          },
        }], {}),
        1,
      );
    } finally {
      store.close();
    }
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...inventory,
        nodes: [{ ...asset, label: "Updated inventory" }],
      }),
    );
    const updated = refreshSentinelAssessment(path)!;
    assert(updated.revision > original.revision);
    advanceAdaptiveSentinel(path, updated);

    const handler = createTidepoolSentinelHandler(
      { baseDir, config: {} } as BootstrapResult,
    );
    const events: Record<string, unknown>[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (event: string) => {
        events.push(JSON.parse(event));
      },
    } as unknown as WebSocket;
    await handler({
      type: "export",
      format: "provenance",
      revision: original.revision,
    }, socket);
    assertEquals(events[0].type, "export");
    const report = JSON.parse(String(events[0].content)) as {
      revision: number;
      provenance: {
        nodes: {
          peerFinding?: AdaptivePeerFindingCitation;
          plannerRound?: AdaptivePlannerRound;
        }[];
      };
    };
    assertEquals(report.revision, original.revision);
    const exported = report.provenance.nodes.find((node) => node.peerFinding)
      ?.peerFinding;
    assertEquals(exported, citation);
    assertEquals(
      report.provenance.nodes.find((node) => node.plannerRound)?.plannerRound
        ?.peerFindingCitations,
      [citation],
    );

    assert(exported);
    const sourceRequest = {
      type: "shared_finding_source",
      sourceCase: exported.sourceCaseId,
      asset: exported.sourceAssetId,
      finding: exported.sourceFindingId,
      snapshotDigest: exported.snapshotDigest,
    };
    await handler(sourceRequest, socket);
    assertEquals(events[1].type, "sentinel_source_snapshot");
    assertEquals(events[1].published, false);
    assertEquals(events[1].asset, citation.sourceFindingId);
    assertEquals(events[1].graph, reporting);
    await handler({ ...sourceRequest, asset: asset.id }, socket);
    assertStringIncludes(
      String(events[2].message),
      "unavailable for this asset",
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
