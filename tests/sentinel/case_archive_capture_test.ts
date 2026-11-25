import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { GoalCompletionStore } from "../../src/core/goal_completion.ts";
import { captureStoppedSentinelCaseArtifacts } from "../../src/sentinel/case_archive_capture.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import {
  pauseSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { adaptiveRevision } from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { digestSentinelSnapshot } from "../../src/sentinel/shared_inventory.ts";

Deno.test("case archive stages exact stopped graph and scrubs SQLite leases and private drafts", () => {
  const base = Deno.makeTempDirSync();
  try {
    const caseId = "archivable";
    const path = resolveSentinelCasePath(base, caseId);
    const caseDir = dirname(path);
    Deno.mkdirSync(caseDir, { recursive: true, mode: 0o700 });
    const stage = join(base, "stage");
    Deno.mkdirSync(stage, { mode: 0o700 });
    const snapshot = {
      version: 1,
      nodes: [{ id: "app", kind: "asset", label: "Current graph" }],
      edges: [],
    };
    Deno.writeTextFileSync(path, JSON.stringify(snapshot), { mode: 0o600 });
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId!;
    const exact = { caseId, runId, evidenceRevision: state.revision };
    assertThrows(
      () => captureStoppedSentinelCaseArtifacts(base, exact, stage),
      Error,
      "not stopped",
    );
    assert(pauseSentinelAssessment(path));
    assertThrows(
      () => captureStoppedSentinelCaseArtifacts(base, exact, stage),
      Error,
      "not stopped",
    );
    assert(stopSentinelAssessment(path));
    assertThrows(
      () =>
        captureStoppedSentinelCaseArtifacts(base, {
          ...exact,
          runId: crypto.randomUUID(),
        }, stage),
      Error,
      "not stopped",
    );
    assertThrows(
      () =>
        captureStoppedSentinelCaseArtifacts(
          base,
          { ...exact, caseId: "main" },
          stage,
        ),
      Error,
      "named",
    );
    assertEquals([...Deno.readDirSync(stage)], []);

    const src = join(caseDir, "sentinel-adaptive.db");
    const store = openSentinelAdaptiveStore(src);
    try {
      const revision = adaptiveRevision(state);
      store.sync(revision, [{ kind: "trace", nodeId: "app" }], null, {
        number: state.revision,
        goal: { id: runId, label: "Saved goal" },
      });
      assert(store.claim(revision));
    } finally {
      store.close();
    }
    const raw = new DatabaseSync(src);
    try {
      raw.exec(`
        CREATE TABLE adaptive_worker_checkpoints (checkpoint TEXT);
        INSERT INTO adaptive_worker_checkpoints VALUES ('nonportable-checkpoint-secret');
        CREATE TABLE unrecognized_secrets (payload TEXT);
        INSERT INTO unrecognized_secrets VALUES ('unknown-private-secret');
        UPDATE adaptive_tasks SET leaseToken = 'nonportable-lease-secret';
      `);
    } finally {
      raw.close();
    }
    Deno.writeTextFileSync(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: [{ ...snapshot.nodes[0], label: "Later publication" }],
      }),
    );
    const capture = captureStoppedSentinelCaseArtifacts(base, exact, stage);
    assertEquals(capture.artifacts.map(({ name }) => name), [
      "sentinel.json",
      "sentinel-assessment.db",
      "sentinel-adaptive.db",
    ]);
    assertEquals(
      JSON.parse(Deno.readTextFileSync(capture.artifacts[0].path)),
      snapshot,
    );
    const assessment = new DatabaseSync(capture.artifacts[1].path, {
      readOnly: true,
    });
    try {
      assertEquals(
        assessment.prepare("SELECT * FROM assessment_archive_identity").get(),
        {
          ...exact,
          snapshotDigest: digestSentinelSnapshot(
            state.result!.sharedGraph.snapshot!,
          ),
        },
      );
    } finally {
      assessment.close();
    }
    assert(
      capture.artifacts.every(({ sha256, bytes }) =>
        /^[a-f0-9]{64}$/.test(sha256) && bytes > 0
      ),
    );
    assertEquals(
      [...Deno.readDirSync(capture.directory)].map(({ name }) => name).sort(),
      [
        "sentinel-adaptive.db",
        "sentinel-assessment.db",
        "sentinel.json",
      ],
    );
    const retained = new DatabaseSync(capture.artifacts[2].path, {
      readOnly: true,
    });
    try {
      assertEquals(
        retained.prepare("SELECT status, leaseToken FROM adaptive_tasks").get(),
        {
          status: "superseded",
          leaseToken: null,
        },
      );
      assertEquals(retained.prepare("SELECT * FROM adaptive_active").all(), []);
      assertEquals(
        retained.prepare("SELECT * FROM adaptive_worker_checkpoints").all(),
        [],
      );
      assertEquals(
        retained.prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'unrecognized_secrets'",
        ).all(),
        [],
      );
      assertEquals(
        retained.prepare("SELECT goalId FROM adaptive_evidence_revisions").get()
          ?.goalId,
        runId,
      );
    } finally {
      retained.close();
    }
    const bytes = new TextDecoder().decode(
      Deno.readFileSync(capture.artifacts[2].path),
    );
    for (
      const marker of [
        "nonportable-checkpoint-secret",
        "nonportable-lease-secret",
        "unknown-private-secret",
      ]
    ) {
      assert(!bytes.includes(marker));
    }
    const unchanged = new DatabaseSync(src, { readOnly: true });
    try {
      assertEquals(
        unchanged.prepare("SELECT leaseToken FROM adaptive_tasks").get()
          ?.leaseToken,
        "nonportable-lease-secret",
      );
    } finally {
      unchanged.close();
    }
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test("case archive retains approved evidence stores by exact schema only", () => {
  const base = Deno.makeTempDirSync();
  try {
    const caseId = "archivable";
    const path = resolveSentinelCasePath(base, caseId);
    Deno.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const stage = join(base, "stage");
    Deno.mkdirSync(stage, { mode: 0o700 });
    Deno.writeTextFileSync(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "app", kind: "asset", label: "Application" }],
        edges: [],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    assert(stopSentinelAssessment(path));
    const exact = {
      caseId,
      runId: state.plan.runId!,
      evidenceRevision: state.revision,
    };
    const goalsPath = join(dirname(path), "sentinel-goal-completion.db");
    const scope = "sentinel:fixture";
    const source = new GoalCompletionStore(goalsPath);
    try {
      source.register(scope, "Verify published evidence.", [{
        id: "evidence",
        description: "Approve defensive evidence.",
      }], "operator");
      source.report(
        scope,
        [{
          criterionId: "evidence",
          evidence: [{
            source: "graph_evidence",
            reference: "receipt",
            detail: "Approved fixture.",
          }],
        }],
        () => true,
        true,
      );
    } finally {
      source.close();
    }
    const capture = captureStoppedSentinelCaseArtifacts(base, exact, stage);
    assertEquals(capture.artifacts.map(({ name }) => name), [
      "sentinel.json",
      "sentinel-assessment.db",
      "sentinel-goal-completion.db",
    ]);
    const staged = new GoalCompletionStore(capture.artifacts[2].path);
    try {
      assertEquals(staged.read(scope)?.status, "completed");
      assertEquals(
        staged.read(scope)?.observations[0].evidence[0].reference,
        "receipt",
      );
    } finally {
      staged.close();
    }
    const unsafe = new DatabaseSync(goalsPath);
    try {
      unsafe.exec("ALTER TABLE goal_completion ADD COLUMN unsafe_secret TEXT");
    } finally {
      unsafe.close();
    }
    assertThrows(
      () => captureStoppedSentinelCaseArtifacts(base, exact, stage),
      Error,
      "Unexpected Sentinel archive evidence-store fields",
    );
    assertEquals([...Deno.readDirSync(stage)].length, 1);
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});
