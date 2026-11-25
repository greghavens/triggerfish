import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createAssignmentLeaseJournal } from "../../src/core/durable_assignment.ts";

Deno.test("Assignment leases reject overlapping claims and stale settlement", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE assignments (id TEXT PRIMARY KEY, revision TEXT NOT NULL);
      CREATE TABLE leases (
        taskId TEXT PRIMARY KEY REFERENCES assignments(id),
        attempts INTEGER NOT NULL,
        token TEXT,
        availableAt INTEGER NOT NULL
      );
      INSERT INTO assignments VALUES ('assignment', 'first');
    `);
    const leases = createAssignmentLeaseJournal(db, "leases", "assignments");
    const first = leases.claim("assignment", 100, 50);
    assert(first);
    assertEquals(leases.claim("assignment", 149, 50), undefined);
    assertEquals(
      leases.ownedAttempt("other", "assignment", first.token, 149),
      undefined,
    );
    assertEquals(leases.expire("first", 150).length, 1);
    const second = leases.claim("assignment", 150, 50);
    assert(second);
    assertEquals(second.attempts, 2);
    assertEquals(leases.release("assignment", first.token, 1, 150), false);
    assertEquals(
      leases.ownedAttempt("first", "assignment", second.token, 151),
      2,
    );
    assert(leases.release("assignment", second.token, 2, 225));
    assertEquals(leases.claim("assignment", 224, 50), undefined);
    assert(leases.claim("assignment", 225, 50));
  } finally {
    db.close();
  }
});
