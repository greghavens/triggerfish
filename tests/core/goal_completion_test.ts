import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  GoalCompletionStore,
  summarizeGoalCriteria,
} from "../../src/core/goal_completion.ts";

const criteria = [
  {
    id: "validated",
    description: "Validate the imported report",
    requirement: "kind:report",
  },
  { id: "archived", description: "Retain the reviewed artifact" },
];
const first = {
  criterionId: "validated",
  evidence: [{
    source: "report",
    reference: "r:1",
    detail: "Verified exact report.",
  }],
};
const second = {
  criterionId: "archived",
  evidence: [{
    source: "archive",
    reference: "a:1",
    detail: "Verified approved archive.",
  }],
};

Deno.test("Goal completion accumulates verified criteria and survives restart as an immutable record", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "goal.sqlite");
  const now = () => 1_000;
  const verify = (criterion: string, evidence: { reference: string }) =>
    (criterion === "validated" && evidence.reference === "r:1") ||
    (criterion === "archived" && evidence.reference === "a:1");
  try {
    const initial = new GoalCompletionStore(path, now);
    try {
      const open = initial.register(
        "case:1",
        "Finish review",
        criteria,
        "automatic",
      );
      assertEquals(open.status, "open");
      assertEquals(
        initial.register("case:1", "Finish review", criteria, "automatic"),
        open,
      );
      assertThrows(
        () =>
          initial.register("case:1", "Finish review", [{
            ...criteria[0],
            requirement: "kind:unrelated",
          }, criteria[1]], "automatic"),
        Error,
        "already registered",
      );
      const partial = initial.report("case:1", [
        first,
        {
          ...second,
          evidence: [{ ...second.evidence[0], reference: "forged" }],
        },
      ], verify);
      assertEquals(partial.status, "open");
      assertEquals(partial.observations, [first]);
      assertEquals(summarizeGoalCriteria(partial), {
        open: ["archived"],
        satisfied: ["validated"],
      });
    } finally {
      initial.close();
    }

    const reopened = new GoalCompletionStore(path, () => 2_000);
    try {
      const done = reopened.report("case:1", [second], verify);
      assertEquals(done.status, "completed");
      assertEquals(done.observations, [first, second]);
      assertEquals(done.completedAt, new Date(2_000).toISOString());
      assertEquals(reopened.report("case:1", [], () => false), done);
      assertEquals(reopened.read("case:1"), done);
      assertEquals(reopened.read("other-case"), undefined);
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Operator completion requires explicit confirmation of all still-verified criteria", async () => {
  const directory = await Deno.makeTempDir();
  const store = new GoalCompletionStore(join(directory, "goal.sqlite"));
  try {
    store.register("case:2", "Finish review", criteria, "operator");
    assertEquals(
      store.report("case:2", [first], () => true, true).status,
      "open",
    );
    const pending = store.report("case:2", [second], () => true);
    assertEquals(pending.status, "awaiting_confirmation");
    assertEquals(pending.observations, [first, second]);
    assertThrows(() =>
      store.report("case:2", [{
        criterionId: "invented",
        evidence: [],
      }], () => true)
    );
    assertThrows(() =>
      store.report("case:2", [], () => {
        throw new Error("Verification offline");
      })
    );
    assertEquals(store.read("case:2"), pending);
    const revoked = store.report("case:2", [], (id) => id !== "archived", true);
    assertEquals(revoked.status, "open");
    assertEquals(revoked.observations, [first]);
    assertEquals(
      store.report("case:2", [second], () => true, true).status,
      "completed",
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Successive registrations preserve legacy decisions and the original evidence boundary", async () => {
  const directory = await Deno.makeTempDir();
  const store = new GoalCompletionStore(
    join(directory, "goal.sqlite"),
    () => 1_000,
  );
  try {
    const family = "chat:legacy-session";
    store.register(family, "Legacy", criteria, "automatic");
    const legacy = store.report(family, [first, second], () => true);
    const legacyRegistration = {
      requestId: "legacy",
      record: legacy,
      classification: "RESTRICTED",
    };
    assertEquals(store.readRegistration(family), legacyRegistration);
    const requestId = crypto.randomUUID();
    const next = store.registerSuccessive(
      family,
      requestId,
      "Next",
      criteria,
      "automatic",
      8,
      "RESTRICTED",
    );
    assertEquals(next.record.status, "open");
    assertEquals(next.record.createdAt, legacy.createdAt);
    assertEquals(next.afterSequence, 8);
    assertEquals(
      store.registerSuccessive(
        family,
        requestId,
        "Next",
        criteria,
        "automatic",
        10,
        "RESTRICTED",
      ),
      next,
    );
    assertEquals(store.readRegistration(family, "legacy"), legacyRegistration);
    assertEquals(
      store.readRegistration("chat:other-session", requestId),
      undefined,
    );
    assertEquals(store.registrationHistory(family, requestId), {
      registrations: [legacyRegistration],
      nextBefore: null,
    });
    assertThrows(
      () =>
        store.registerSuccessive(
          family,
          crypto.randomUUID(),
          "Open",
          criteria,
          "operator",
          11,
          "RESTRICTED",
        ),
      Error,
      "Complete the current goal",
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Goal revision migrates the registration journal and freezes prior reports", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "goal.sqlite");
  const store = new GoalCompletionStore(path, () => 1_000);
  try {
    const family = "chat:revision";
    store.registerSuccessive(
      family,
      undefined,
      "First review",
      criteria,
      "operator",
      4,
      "PUBLIC",
    );
    const archived = store.reportRegistration(
      family,
      "legacy",
      [first],
      () => true,
      "INTERNAL",
    );
    const originalJournal = new DatabaseSync(path);
    try {
      originalJournal.exec(
        "ALTER TABLE goal_completion_registrations DROP COLUMN revisesRequestId",
      );
    } finally {
      originalJournal.close();
    }
    assertEquals(store.readRegistration(family)?.record, archived);
    const requestId = crypto.randomUUID();
    const replacement = store.registerSuccessive(
      family,
      requestId,
      "Revised review",
      criteria,
      "operator",
      11,
      "INTERNAL",
      "legacy",
    );
    assertEquals(replacement.afterSequence, 11);
    assertEquals(replacement.revisesRequestId, "legacy");
    assertEquals(replacement.record.observations, []);
    assertEquals(store.readRegistration(family), replacement);
    assertThrows(
      () =>
        store.reportRegistration(
          family,
          "legacy",
          [second],
          () => true,
          "INTERNAL",
          true,
        ),
      Error,
      "registration is no longer current",
    );
    assertEquals(store.readRegistration(family, "legacy")?.record, archived);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});
