import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  createEvidencePlanningGate,
  createEvidenceTaskSettler,
} from "../../src/core/evidence_task_progression.ts";

Deno.test("Evidence settlement is scoped, bounded, and leaves the committed receipt intact", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE assignments (
      id TEXT PRIMARY KEY, revision TEXT, status TEXT, attempts INTEGER,
      observation TEXT, factSatisfaction TEXT
    );
    INSERT INTO assignments VALUES ('target', 'r1', 'queued', 0, NULL, NULL);
    INSERT INTO assignments VALUES ('leased', 'r1', 'running', 1, NULL, NULL);
    INSERT INTO assignments VALUES ('retry', 'r1', 'queued', 1, NULL, NULL);`);
    const settle = createEvidenceTaskSettler(db, "assignments", 10);
    const proof = {
      revision: "r1",
      taskId: "target",
      observation: '"évidence"',
      receipt: { source: "committed" },
    };
    assert(!settle(proof)); // UTF-8 exceeds the byte budget.
    const eligible = { ...proof, observation: "{}" };
    assert(!settle({ ...eligible, revision: "r2" }));
    assert(!settle({ ...eligible, taskId: "leased" }));
    assert(!settle({ ...eligible, taskId: "retry" }));
    assert(settle(eligible));
    assert(!settle({ ...eligible, receipt: { source: "other" } }));
    const retained = db.prepare("SELECT * FROM assignments WHERE id = ?").get(
      "target",
    );
    assertEquals(retained?.status, "completed");
    assertEquals(retained?.attempts, 0);
    assertEquals(retained?.factSatisfaction, JSON.stringify(proof.receipt));
  } finally {
    db.close();
  }
});

Deno.test("Planner wakeups coalesce and a newer revision bypasses the cooldown", async () => {
  let clock = 0;
  let wakes = 0;
  const gate = createEvidencePlanningGate(() => wakes++, 10, () => clock);
  try {
    assert(gate.ready("first", 1));
    gate.started(1);
    gate.settled("first");
    assert(!gate.ready("first", 1));
    assert(!gate.ready("changed", 1));
    assert(!gate.ready("newest", 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(wakes, 1);
    clock = 10;
    assert(gate.ready("newest", 1));
    gate.started(1);
    assert(!gate.ready("additional", 1));
    assert(gate.ready("new revision", 2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(wakes, 1);
  } finally {
    gate.clear();
  }
});
