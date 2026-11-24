import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { parseSentinelTelemetryAlert } from "../../src/sentinel/case_report.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  claimSentinelAssessmentReview,
  completeSentinelAssessmentReview,
  hasPendingSentinelInputs,
  pauseSentinelAssessment,
  readSentinelAssessment,
  readSentinelAssessmentHistory,
  readSentinelAssessmentRevision,
  readSentinelDecisionHistory,
  readSentinelFindingReviews,
  recordSentinelFindingReview,
  refreshSentinelAssessment,
  resumeSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
  withSentinelAssessmentWriteLock,
} from "../../src/sentinel/assessment_store.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";

const graph = {
  version: 1,
  nodes: [
    { id: "app", kind: "asset", label: "Application" },
    {
      id: "finding",
      kind: "finding",
      label: "Missing control",
      severity: "high",
    },
    { id: "log", kind: "evidence", label: "Source record" },
  ],
  edges: [
    { from: "finding", to: "app", relation: "affects" },
    { from: "log", to: "finding", relation: "supports" },
  ],
};

Deno.test("Finding decisions follow unchanged evidence and retain their original revision", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "graph.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const initial = startSentinelAssessment(path);
    assert(
      recordSentinelFindingReview(
        path,
        initial.revision,
        "finding",
        "confirmed",
        "Reviewed source.",
      ),
    );
    const original = readSentinelFindingReviews(path, initial.revision);
    assertEquals(original[0].revision, initial.revision);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...graph,
        nodes: [...graph.nodes, {
          id: "unrelated",
          kind: "asset",
          label: "Unrelated",
        }],
      }),
    );
    const unchanged = refreshSentinelAssessment(path)!;
    assertEquals(unchanged.revision, initial.revision + 1);
    assertEquals(
      readSentinelFindingReviews(path, unchanged.revision),
      original,
    );
    assert(
      recordSentinelFindingReview(
        path,
        unchanged.revision,
        "finding",
        "resolved",
        "Verified remediation.",
      ),
    );
    assertEquals(
      readSentinelDecisionHistory(
        path,
        unchanged.revision,
        "finding",
        "finding",
      )?.decisions.map(
        ({ revision }) => revision,
      ),
      [unchanged.revision, initial.revision],
    );
    const updated = readSentinelFindingReviews(path, unchanged.revision);
    assertEquals(
      updated.map(({ disposition, revision }) => [disposition, revision]),
      [
        ["resolved", unchanged.revision],
        ["confirmed", initial.revision],
      ],
    );

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === "log" ? { ...node, label: "Changed evidence" } : node
        ),
      }),
    );
    const changed = refreshSentinelAssessment(path)!;
    assertEquals(readSentinelFindingReviews(path, changed.revision), []);
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const reverted = refreshSentinelAssessment(path)!;
    assertEquals(readSentinelFindingReviews(path, reverted.revision), []);
    assertEquals(readSentinelFindingReviews(path, initial.revision), original);
    assertEquals(readSentinelFindingReviews(path, unchanged.revision), updated);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Policy assessment keeps waiting tasks and wakes them when supporting evidence arrives", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    const started = startSentinelAssessment(path, { evidenceNode: "log" });
    assertEquals(started.revision, 1);
    assertEquals(
      started.result?.tasks.find(({ id }) => id === "case")?.status,
      "waiting",
    );
    assertThrows(() => startSentinelAssessment(path), Error, "already active");
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const alertsPath = sentinelAlertsPath(path);
    await Deno.writeTextFile(alertsPath, "[");
    assertThrows(() => refreshSentinelAssessment(path), SyntaxError);
    assertEquals(readSentinelAssessment(path)?.revision, 1);

    await Deno.writeTextFile(alertsPath, "[]");
    const refreshed = refreshSentinelAssessment(path);
    assertEquals(refreshed?.revision, 2);
    assertEquals(
      refreshed?.result?.tasks.find(({ id }) => id === "case")?.status,
      "completed",
    );
    assert(
      refreshed?.result?.sharedGraph.observationLinks.some((
        { observation, node },
      ) => observation === "assessment:case" && node === "log"),
    );
    assertEquals(refreshSentinelAssessment(path)?.revision, 2);
    assertEquals(
      readSentinelAssessmentHistory(path).map(({ revision }) => revision),
      [2, 1],
    );
    assertEquals(stopSentinelAssessment(path), true);
    assertEquals(refreshSentinelAssessment(path)?.active, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("An isolated review can complete only once on its active evidence revision", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const { revision } = startSentinelAssessment(path, {
      traceNode: "finding",
    });
    const claim = claimSentinelAssessmentReview(path, revision, "coverage");
    assert(claim);
    assertEquals(
      claimSentinelAssessmentReview(path, revision, "coverage"),
      undefined,
    );
    assertEquals(
      completeSentinelAssessmentReview(
        path,
        revision,
        "coverage",
        "invalid",
        "x",
      ),
      false,
    );
    assertEquals(
      completeSentinelAssessmentReview(
        path,
        revision,
        "coverage",
        claim,
        "Review complete",
      ),
      true,
    );
    assertEquals(readSentinelAssessment(path)?.reviews, [{
      task: "coverage",
      analysis: "Review complete",
    }]);

    assertEquals(
      readSentinelAssessmentRevision(path, revision)?.reviews.length,
      1,
    );
    assertEquals(
      claimSentinelAssessmentReview(path, revision, "impact"),
      undefined,
    );
    const pending = claimSentinelAssessmentReview(path, revision, "trace");
    assert(pending);
    await Deno.writeTextFile(sentinelAlertsPath(path), "[]");
    assertEquals(refreshSentinelAssessment(path)?.revision, revision + 1);
    assertEquals(
      completeSentinelAssessmentReview(
        path,
        revision,
        "trace",
        pending,
        "Stale",
      ),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("An assessment writer cannot change the revision during a related-store commit", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const original = startSentinelAssessment(path);
    const writer = new DatabaseSync(join(dir, "sentinel-assessment.db"));
    try {
      writer.exec("PRAGMA busy_timeout = 0");
      withSentinelAssessmentWriteLock(path, (state) => {
        assertEquals(state?.revision, original.revision);
        assertThrows(
          () => writer.exec("UPDATE assessment SET revision = revision + 1"),
          Error,
          "locked",
        );
      });
      writer.exec("UPDATE assessment SET revision = revision + 1");
      assertEquals(
        readSentinelAssessment(path)?.revision,
        original.revision + 1,
      );
    } finally {
      writer.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Existing paused assessments pick up alert-driven reviews on resume with identical inputs", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(graph));
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([{
        type: "integrity_change",
        severity: "high",
        asset: "app",
        subject: "Audit policy",
        observedAt: "2026-11-24T12:00:00.000Z",
        evidenceIds: ["audit-record"],
      }]),
    );
    const initial = startSentinelAssessment(path);
    assert(initial.result);
    const legacyResult = structuredClone(initial.result);
    const observation = legacyResult.sharedGraph.observations.find(
      ({ task }) => task === "incident_correlation",
    );
    assert(observation?.facts.isolatedPriorityAlerts);
    delete (observation.facts as Record<string, unknown>)
      .isolatedPriorityAlerts;
    const alertObservation = legacyResult.sharedGraph.observations.find(
      ({ task }) => task === "case",
    );
    legacyResult.revision = `assessment:${
      createHash("sha256").update(
        JSON.stringify(legacyResult.sharedGraph.snapshot),
      )
        .update(
          JSON.stringify([
            (alertObservation?.facts.alerts as unknown[]).map((alert, index) =>
              parseSentinelTelemetryAlert(alert, index + 1)
            ),
            null,
            null,
            null,
            2,
            null,
          ]),
        )
        .digest("hex")
    }`;
    assert(pauseSentinelAssessment(path));
    const db = new DatabaseSync(join(dir, "sentinel-assessment.db"));
    try {
      const data = JSON.stringify(legacyResult);
      db.prepare(`
        UPDATE assessment SET fingerprint = substr(fingerprint, 1, 64), result = ?
      `).run(data);
      db.prepare("UPDATE assessment_history SET result = ? WHERE revision = ?")
        .run(data, initial.revision);
    } finally {
      db.close();
    }
    assertEquals(hasPendingSentinelInputs(path), false);
    assertEquals(refreshSentinelAssessment(path)?.revision, initial.revision);
    const resumed = resumeSentinelAssessment(path);
    assert(resumed);
    assertEquals(resumed.revision, initial.revision + 1);
    assert(
      resumed?.result?.sharedGraph.observations.some(({ facts }) =>
        Array.isArray(facts.isolatedPriorityAlerts) &&
        facts.isolatedPriorityAlerts.length === 1
      ),
    );
    assertEquals(
      readSentinelAssessmentRevision(path, initial.revision)?.result,
      legacyResult,
    );
    assertEquals(refreshSentinelAssessment(path)?.revision, resumed.revision);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Control evidence expiry changes the active assessment without rewriting archived coverage", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const now = Date.now();
  const validUntil = new Date(now + 60_000).toISOString();
  const snapshot = {
    ...graph,
    nodes: [
      ...graph.nodes,
      { id: "control", kind: "control", label: "Recorded mitigation" },
      {
        id: "verification",
        kind: "evidence",
        label: "Recorded passing check",
        controlVerification: {
          outcome: "pass",
          observedAt: new Date(now - 1000).toISOString(),
          validUntil,
        },
      },
    ],
    edges: [
      ...graph.edges,
      { from: "control", to: "finding", relation: "mitigates" },
      { from: "verification", to: "control", relation: "verifies" },
    ],
  };
  function coverage(
    result: ReturnType<typeof startSentinelAssessment>["result"],
  ) {
    const finding = result?.sharedGraph.observations.find(({ task }) =>
      task === "coverage"
    )?.facts.findings as {
      controlVerification: { status: string; asOf: string };
    }[];
    return finding[0].controlVerification;
  }
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const first = startSentinelAssessment(path);
    assertEquals(coverage(first.result).status, "pass");
    assertEquals(coverage(first.result).asOf, first.updatedAt);
    assertEquals(
      refreshSentinelAssessment(path, undefined, new Date(now + 30_000))
        ?.revision,
      first.revision,
    );
    const expired = refreshSentinelAssessment(
      path,
      undefined,
      new Date(validUntil),
    )!;
    assertEquals(expired.revision, first.revision + 1);
    assertEquals(expired.updatedAt, validUntil);
    assertEquals(coverage(expired.result).status, "stale");
    assertEquals(coverage(expired.result).asOf, validUntil);
    assertEquals(expired.result?.controlChanges, [{
      findingId: "finding",
      controlId: "control",
      before: { status: "pass", evidenceId: "verification" },
      after: { status: "stale", evidenceId: "verification" },
    }]);
    assertEquals(first.result?.controlChanges, undefined);
    assertEquals(
      expired.result?.sharedGraph.observationLinks.filter(({ observation }) =>
        observation === "assessment:coverage"
      ).map(({ node }) => node),
      ["finding", "control", "verification"],
    );

    advanceAdaptiveSentinel(path, expired);
    const work = readAdaptiveSentinel(path, expired)!.tasks.find(({ kind }) =>
      kind === "verify_control_coverage"
    );
    assertEquals(
      (work?.observation as { coverage?: string })?.coverage,
      "stale",
    );

    assertEquals(
      coverage(readSentinelAssessmentRevision(path, first.revision)!.result)
        .status,
      "pass",
    );
    assertEquals(
      refreshSentinelAssessment(path, undefined, new Date(now + 90_000))
        ?.revision,
      expired.revision,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
