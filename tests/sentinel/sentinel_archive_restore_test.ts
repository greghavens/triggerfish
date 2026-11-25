import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  type RunArchiveIdentity,
  withVerifiedRunArchive,
  writeRunArchive,
} from "../../src/core/run_archive.ts";
import { adaptiveRevision } from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  readSentinelAssessment,
  resumeSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { captureStoppedSentinelCaseArtifacts } from "../../src/sentinel/case_archive_capture.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { digestSentinelSnapshot } from "../../src/sentinel/shared_inventory.ts";
import {
  listSentinelPlannerGraphFacts,
  openSentinelWorkerGraphFacts,
} from "../../src/sentinel/worker_graph_facts.ts";
import {
  permittedSentinelRestoreArtifacts,
  requiredSentinelRestoreArtifacts,
  restoreVerifiedSentinelCaseArchive,
} from "../../src/sentinel/sentinel_archive_restore.ts";

async function fixture(
  test: (value: {
    base: string;
    destination: string;
    path: string;
    identity: RunArchiveIdentity;
    staged: ReturnType<typeof captureStoppedSentinelCaseArtifacts>;
    write(name: string, override?: RunArchiveIdentity): Promise<string>;
    restore(
      archive: string,
      request?: { requestId: string; recovering: boolean },
    ): ReturnType<typeof restoreVerifiedSentinelCaseArchive>;
  }) => Promise<void>,
  planWork = true,
) {
  const base = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(base, "fixture");
    const staging = join(base, "staging");
    const destination = join(base, "receiving");
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.mkdir(staging, { mode: 0o700 });
    await Deno.mkdir(destination, { mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "service", kind: "asset", label: "Retained service" },
          { id: "record", kind: "evidence", label: "Retained record" },
        ],
        edges: [{ from: "record", to: "service", relation: "observed_on" }],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId!;
    const revision = adaptiveRevision(state);
    const adaptive = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      if (planWork) {
        adaptive.sync(
          revision,
          [
            { kind: "trace", nodeId: "service", depth: 1 },
            { kind: "trace", nodeId: "service", depth: 2 },
            { kind: "trace", nodeId: "service", depth: 3 },
          ],
          null,
          {
            number: state.revision,
            goal: { id: runId, label: "Retained review" },
          },
        );
        const claim = adaptive.claim(revision);
        assert(claim);
        assert(adaptive.complete({
          taskId: claim.task.id,
          leaseToken: claim.leaseToken,
          observation: { preserved: true },
        }));
        assert(adaptive.claim(revision));
      }
    } finally {
      adaptive.close();
    }
    const snapshot = state.result?.sharedGraph.snapshot;
    assert(snapshot);
    const facts = openSentinelWorkerGraphFacts(path);
    try {
      if (planWork) {
        assert(facts.record({
          caseId: "fixture",
          runId,
          evidenceRevision: state.revision,
          targetId: "service",
          taskId: `adaptive:${"1".repeat(64)}`,
          snapshotDigest: digestSentinelSnapshot(snapshot),
          resultSha256: "2".repeat(64),
          relationship: {
            from: "record",
            to: "service",
            relation: "observed_on",
          },
          sourceStepIndex: 0,
          requestId: crypto.randomUUID(),
        }, () => true));
      }
    } finally {
      facts.close();
    }
    assert(stopSentinelAssessment(path));
    const identity = {
      kind: "sentinel" as const,
      id: "fixture",
      runId,
      revision: state.revision,
    };
    const staged = captureStoppedSentinelCaseArtifacts(base, {
      caseId: identity.id,
      runId,
      evidenceRevision: state.revision,
    }, staging);
    const write = async (name: string, override = identity) => {
      const archive = join(base, name);
      await writeRunArchive(
        archive,
        override,
        staged.artifacts.map(({ name, path }) => ({ name, sourcePath: path })),
        permittedSentinelRestoreArtifacts,
      );
      return archive;
    };
    const restore = (
      archive: string,
      request?: { requestId: string; recovering: boolean },
    ) =>
      withVerifiedRunArchive(
        archive,
        destination,
        {
          expectedKind: "sentinel",
          permittedNames: permittedSentinelRestoreArtifacts,
          requiredNames: requiredSentinelRestoreArtifacts,
        },
        (verified) =>
          restoreVerifiedSentinelCaseArchive(destination, verified, request),
      );
    await test({ base, destination, path, identity, staged, write, restore });
  } finally {
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("A stopped Sentinel case with an initialized but unused planner store restores paused", async () => {
  await fixture(async ({ write, restore, identity }) => {
    const output = await restore(await write("unplanned-case"));
    const restored = readSentinelAssessment(output.snapshotPath);
    assert(restored?.paused);
    assertEquals(restored.plan.runId, identity.runId);
    const adaptive = openSentinelAdaptiveStore(
      join(dirname(output.snapshotPath), "sentinel-adaptive.db"),
    );
    try {
      assertEquals(adaptive.list(adaptiveRevision(restored)), []);
    } finally {
      adaptive.close();
    }
  }, false);
});

Deno.test("Verified named Sentinel archive restores paused without active leases or duplicate case overwrite", async () => {
  await fixture(
    async ({ destination, path, identity, staged, write, restore }) => {
      const stagedAdaptive = staged.artifacts.find(({ name }) =>
        name === "sentinel-adaptive.db"
      )!;
      const probe = new DatabaseSync(stagedAdaptive.path);
      try {
        probe.exec(`
        UPDATE adaptive_tasks SET status='running', leaseToken='lease-never-restored', leaseExpiresAt=9999999999999
        WHERE status='superseded';
        CREATE TABLE IF NOT EXISTS adaptive_worker_checkpoints (checkpoint TEXT);
        INSERT INTO adaptive_worker_checkpoints VALUES ('unfinished-work');
      `);
      } finally {
        probe.close();
      }
      const archive = await write("valid-archive");
      const output = await restore(archive);
      assertEquals(output.caseId, identity.id);
      assertEquals(output.runId, identity.runId);
      assertEquals(output.evidenceRevision, identity.revision);
      assertEquals(
        output.snapshotPath,
        resolveSentinelCasePath(destination, identity.id),
      );
      const restored = readSentinelAssessment(output.snapshotPath);
      assert(restored);
      assert(restored.paused);
      assertEquals(restored.revision, identity.revision);
      assertEquals(restored.plan.runId, identity.runId);
      assertEquals(readSentinelAssessment(path)?.active, false);
      const graphScope = {
        caseId: output.caseId,
        runId: output.runId,
        evidenceRevision: output.evidenceRevision,
      };
      const retainedFacts = listSentinelPlannerGraphFacts(
        output.snapshotPath,
        graphScope,
      );
      assertEquals(retainedFacts.length, 1);
      assertEquals(
        retainedFacts,
        listSentinelPlannerGraphFacts(path, graphScope),
      );
      const dbPath = join(dirname(output.snapshotPath), "sentinel-adaptive.db");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assertEquals(db.prepare("SELECT * FROM adaptive_active").all(), []);
        assertEquals(
          db.prepare("SELECT * FROM adaptive_worker_checkpoints").all(),
          [],
        );
        assertEquals(
          db.prepare(
            "SELECT leaseToken FROM adaptive_tasks WHERE leaseToken IS NOT NULL",
          ).all(),
          [],
        );
        assertEquals(
          db.prepare(
            "SELECT status, observation FROM adaptive_tasks ORDER BY depth",
          ).all(),
          [
            { status: "completed", observation: '{"preserved":true}' },
            { status: "superseded", observation: null },
            { status: "queued", observation: null },
          ],
        );
      } finally {
        db.close();
      }
      const preserved = await Deno.readFile(dbPath);
      await assertRejects(() => restore(archive), Deno.errors.AlreadyExists);
      assertEquals(await Deno.readFile(dbPath), preserved);
      const resumed = resumeSentinelAssessment(output.snapshotPath);
      assert(resumed);
      assertEquals(resumed.revision, identity.revision);
      const adaptive = openSentinelAdaptiveStore(dbPath);
      try {
        const revision = adaptiveRevision(resumed);
        assertEquals(
          adaptive.list(revision).filter(({ status }) => status === "queued")
            .map(({ depth }) => depth),
          [3],
        );
      } finally {
        adaptive.close();
      }
      assertEquals(resumed.plan.runId, identity.runId);
    },
  );
});

Deno.test("Sentinel restore rejects manifest relabels, foreign run collisions and executable schema", async () => {
  await fixture(
    async ({ destination, path, identity, staged, write, restore }) => {
      const wrong = await write("relabelled", {
        ...identity,
        id: "different-case",
      });
      await assertRejects(() => restore(wrong), Error, "case identity");
      await assertRejects(() =>
        Deno.lstat(
          dirname(resolveSentinelCasePath(destination, "different-case")),
        ), Deno.errors.NotFound);

      const archive = await write("correct-archive");
      const other = resolveSentinelCasePath(destination, "other");
      await Deno.mkdir(dirname(other), { recursive: true, mode: 0o700 });
      await Deno.copyFile(
        join(dirname(path), "sentinel-assessment.db"),
        join(dirname(other), "sentinel-assessment.db"),
      );
      await assertRejects(
        () => restore(archive),
        Deno.errors.AlreadyExists,
        "another case",
      );
      await Deno.remove(dirname(other), { recursive: true });

      const adaptive = staged.artifacts.find(({ name }) =>
        name === "sentinel-adaptive.db"
      )!;
      assert(typeof identity.revision === "number");
      const altered = new DatabaseSync(adaptive.path);
      try {
        altered.exec(`
          INSERT INTO adaptive_evidence_revisions
          SELECT revision, evidenceNumber + 1, goalId, goalLabel
          FROM adaptive_evidence_revisions;
        `);
        await assertRejects(
          () => write("future-planner-revision").then(restore),
          Error,
          "does not match the retained case run",
        );
        altered.prepare(
          "DELETE FROM adaptive_evidence_revisions WHERE evidenceNumber > ?",
        ).run(identity.revision);
      } finally {
        altered.close();
      }

      const assessment = staged.artifacts.find(({ name }) =>
        name === "sentinel-assessment.db"
      )!;
      const unsafe = new DatabaseSync(assessment.path);
      try {
        unsafe.exec(
          "CREATE TRIGGER assessment_fixture AFTER UPDATE ON assessment BEGIN SELECT 1; END",
        );
      } finally {
        unsafe.close();
      }
      const forged = await write("unsafe-schema");
      await assertRejects(
        () => restore(forged),
        Error,
        "Unexpected Sentinel archive database schema",
      );
      await assertRejects(
        () =>
          Deno.lstat(
            dirname(resolveSentinelCasePath(destination, identity.id)),
          ),
        Deno.errors.NotFound,
      );
    },
  );
});

Deno.test("Sentinel cannot acknowledge incomplete publication during restore recovery", async () => {
  await fixture(async ({ write, restore }) => {
    const archive = await write("publication-archive");
    const requestId = crypto.randomUUID();
    const published = await restore(archive, { requestId, recovering: false });
    const recovering = { requestId, recovering: true };
    assertEquals(await restore(archive, recovering), published);

    const directory = dirname(published.snapshotPath);
    const assessmentPath = join(directory, "sentinel-assessment.db");
    const factsPath = join(directory, "sentinel-worker-graph-facts.db");
    const snapshot = await Deno.readFile(published.snapshotPath);
    const assessment = await Deno.readFile(assessmentPath);
    const facts = await Deno.readFile(factsPath);
    const altered = facts.slice();
    altered[0] ^= 1;
    await Deno.writeFile(factsPath, altered);
    await assertRejects(
      () => restore(archive, recovering),
      Deno.errors.AlreadyExists,
    );
    assertEquals(await Deno.readFile(factsPath), altered);
    await Deno.remove(factsPath);

    await assertRejects(
      () => restore(archive, recovering),
      Deno.errors.AlreadyExists,
    );
    assertEquals(await Deno.readFile(published.snapshotPath), snapshot);
    assertEquals(await Deno.readFile(assessmentPath), assessment);
    await assertRejects(() => Deno.lstat(factsPath), Deno.errors.NotFound);
  });
});
