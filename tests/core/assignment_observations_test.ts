import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createAssignmentObservationJournal } from "../../src/core/assignment_observations.ts";

Deno.test("Committed observations retain exact source steps and peer scope", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE assignments (id TEXT PRIMARY KEY);
      INSERT INTO assignments VALUES ('producer');`);
    const journal = createAssignmentObservationJournal(
      db,
      "observations",
      "assignments",
      "test-observation",
      (raw) => typeof raw === "string" ? raw : undefined,
    );
    const source = {
      revision: "revision",
      taskId: "producer",
      targetId: "asset",
      evidenceRevision: 2,
      stepIndex: 0,
    };
    const saved = journal.publish(source, "verified");
    assert(saved?.created);
    assertEquals(journal.publish(source, "verified"), {
      observation: saved.observation,
      created: false,
    });
    assertEquals(journal.publish(source, "different"), undefined);
    const { id } = saved.observation;
    assertEquals(
      journal.readPeer("revision", id, "asset", 2, "peer"),
      saved.observation,
    );
    assertEquals(
      journal.readPeer("revision", id, "other", 2, "peer"),
      undefined,
    );
    assertEquals(
      journal.readPeer("revision", id, "asset", 1, "peer"),
      undefined,
    );
    assertEquals(
      journal.readPeer("revision", id, "asset", 2, "producer"),
      undefined,
    );
    journal.attachPublicationStep("revision", "producer", 2, id, 0);
    assertEquals(
      journal.readByPublicationStep("revision", "producer", 0),
      undefined,
    );
    journal.attachPublicationStep("revision", "producer", 2, id, 1);
    assertEquals(
      journal.readByPublicationStep("revision", "producer", 1),
      saved.observation,
    );
  } finally {
    db.close();
  }
});

Deno.test("Source-step observations migrate old receipts without relaxing assignment journals", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE assignments (id TEXT PRIMARY KEY);
      INSERT INTO assignments VALUES ('producer');`);
    const receipt = (raw: unknown) => typeof raw === "string" ? raw : undefined;
    const old = createAssignmentObservationJournal(
      db,
      "narratives",
      "assignments",
      "test-narrative",
      receipt,
    );
    const workflow = createAssignmentObservationJournal(
      db,
      "workflows",
      "assignments",
      "test-workflow",
      receipt,
    );
    const source = {
      revision: "revision",
      taskId: "producer",
      targetId: "asset",
      evidenceRevision: 2,
      stepIndex: 0,
    };
    const first = old.publish(source, "first");
    assert(first?.created);
    assert(workflow.publish(source, "workflow")?.created);
    old.attachPublicationStep(
      "revision",
      "producer",
      2,
      first.observation.id,
      1,
    );

    const upgraded = createAssignmentObservationJournal(
      db,
      "narratives",
      "assignments",
      "test-narrative",
      receipt,
      "source_step",
    );
    assertEquals(
      upgraded.readById("revision", first.observation.id),
      first.observation,
    );
    db.exec("BEGIN IMMEDIATE");
    const next = { ...source, stepIndex: 2 };
    const second = upgraded.publish(next, "second");
    db.exec("COMMIT");
    assert(second?.created);
    assertEquals(
      upgraded.readByPublicationStep("revision", "producer", 1),
      first.observation,
    );
    assertEquals(upgraded.publish(next, "second"), {
      ...second,
      created: false,
    });
    assertEquals(upgraded.publish(next, "first"), undefined);
    assertEquals(upgraded.publish({ ...source, stepIndex: 4 }, "first"), {
      ...first,
      created: false,
    });
    assertEquals(
      upgraded.listByAssignment("revision", "producer", 2),
      [first.observation, second.observation],
    );
    assertEquals(workflow.publish(next, "other workflow"), undefined);
  } finally {
    db.close();
  }
});
