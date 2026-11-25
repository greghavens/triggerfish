import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
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
