import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createEvidenceTaskSettler } from "../../src/core/evidence_task_progression.ts";

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
