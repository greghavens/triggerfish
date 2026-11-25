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
