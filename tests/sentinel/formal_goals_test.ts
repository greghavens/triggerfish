import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  applySentinelFormalGoals,
  claimSentinelAssessmentReview,
  completeSentinelAssessmentGoal,
  completeSentinelAssessmentReview,
  pauseSentinelAssessment,
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  refreshSentinelAssessment,
  type SentinelFormalGoalApproval,
  startSentinelAssessment,
  updateSentinelAssessmentGoal,
} from "../../src/sentinel/assessment_store.ts";
import {
  digestSentinelGoalProposal,
  type SentinelFormalGoal,
} from "../../src/sentinel/formal_goals.ts";

function goal(id: string): SentinelFormalGoal {
  return {
    id,
    title: `Verify ${id}`,
    policy: "operator",
    criteria: [{
      id: "source",
      description: "Open the exact inventory record.",
      source: "graph_evidence",
      reference: "proof",
    }],
  };
}

function request(
  requestId: string,
  goals: readonly SentinelFormalGoal[],
  prior?: { revision: number; plan: { runId?: string } },
): SentinelFormalGoalApproval {
  return {
    requestId,
    mode: prior ? "append" : "start",
    proposalDigest: digestSentinelGoalProposal(goals),
    goals,
    ...(prior &&
      { expectedRevision: prior.revision, expectedRunId: prior.plan.runId }),
  };
}

Deno.test("Approved formal goals start, append, gate completion and preserve archived objectives", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Application" },
          { id: "proof", kind: "evidence", label: "Independent record" },
        ],
        edges: [{ from: "proof", to: "app", relation: "observed_on" }],
      }),
    );
    assertEquals(readSentinelAssessment(path), undefined);
    const approval = {
      ...request("approved-start", [goal("first")]),
      plan: { goal: "Defensive assessment for application" },
    };
    assertThrows(() =>
      applySentinelFormalGoals(path, {
        ...approval,
        proposalDigest: "0".repeat(64),
      })
    );
    assertEquals(readSentinelAssessment(path), undefined);
    assertThrows(() =>
      startSentinelAssessment(path, { formalGoals: approval.goals })
    );

    const initial = applySentinelFormalGoals(path, approval);
    assertEquals(initial.actor, "operator");
    assertEquals(initial.at, initial.state.updatedAt);
    assertEquals(initial.state.plan.activeFormalGoalIds, ["first"]);
    assertEquals(initial.state.plan.formalGoals, approval.goals);
    assertEquals(initial.state.plan.goal, approval.plan.goal);
    assertEquals(initial.state.active, true);
    const worker = claimSentinelAssessmentReview(
      path,
      initial.state.revision,
      "coverage",
    );
    assert(worker);
    assertThrows(() =>
      updateSentinelAssessmentGoal(path, "Replace formal goals")
    );
    assert(pauseSentinelAssessment(path));
    const append = request("approved-append", [goal("second")], initial.state);
    const second = applySentinelFormalGoals(path, append);
    assertEquals(second.state.revision, initial.state.revision + 1);
    assertEquals(second.state.plan.runId, initial.state.plan.runId);
    assertEquals(second.state.active, true);
    assertEquals(second.state.paused, false);
    assertEquals(second.state.plan.activeFormalGoalIds, ["first", "second"]);
    assertEquals(
      completeSentinelAssessmentReview(
        path,
        initial.state.revision,
        "coverage",
        worker,
        "Old worker output",
      ),
      false,
    );
    assertThrows(() =>
      applySentinelFormalGoals(
        path,
        request("stale", [goal("third")], initial.state),
      )
    );
    const retry = applySentinelFormalGoals(path, approval);
    assertEquals(retry.duplicate, true);
    assertEquals(retry.appliedRevision, initial.appliedRevision);
    assertEquals(retry.at, initial.at);
    assertEquals(retry.state.revision, second.state.revision);
    assertThrows(() =>
      applySentinelFormalGoals(path, {
        ...approval,
        plan: { goal: "Different objective" },
      })
    );
    assertThrows(() =>
      applySentinelFormalGoals(path, { ...append, mode: "start" })
    );
    const changed = {
      ...goal("second"),
      criteria: [{
        ...goal("second").criteria[0],
        reference: "different-proof",
      }],
    };
    assertThrows(() =>
      applySentinelFormalGoals(path, {
        ...append,
        goals: [changed],
        proposalDigest: digestSentinelGoalProposal([changed]),
      })
    );

    const revision = second.state.revision;
    const objective = second.state.plan.goal!;
    const independentlyVerified = () => true;
    assertEquals(
      completeSentinelAssessmentGoal(path, revision, objective, "Legacy note"),
      false,
    );
    assertEquals(
      completeSentinelAssessmentGoal(
        path,
        revision,
        objective,
        "Partial",
        undefined,
        independentlyVerified,
        ["first"],
      ),
      false,
    );
    assertEquals(
      completeSentinelAssessmentGoal(
        path,
        revision,
        objective,
        "Failed verification",
        undefined,
        () => false,
        ["first", "second"],
      ),
      false,
    );
    assert(
      completeSentinelAssessmentGoal(
        path,
        revision,
        objective,
        "All verified",
        undefined,
        independentlyVerified,
        ["first", "second"],
      ),
    );

    const completed = readSentinelAssessment(path)!;
    assertEquals(completed.plan.activeFormalGoalIds, []);
    assertEquals(completed.plan.completedFormalGoalIds, ["first", "second"]);
    assertEquals(completed.completion?.formalGoalIds, ["first", "second"]);
    const third = applySentinelFormalGoals(
      path,
      request("after-complete", [goal("third")], completed),
    );
    assertEquals(third.state.active, true);
    assertEquals(third.state.revision, revision + 1);
    assertEquals(third.state.plan.activeFormalGoalIds, ["third"]);
    assertEquals(third.state.plan.completedFormalGoalIds, ["first", "second"]);
    assertEquals(third.state.plan.formalGoals?.map(({ id }) => id), [
      "first",
      "second",
      "third",
    ]);
    assertEquals(third.state.completion, undefined);

    const archived = readSentinelAssessmentRevision(path, revision)!;
    assertEquals(archived.formalGoals?.map(({ id }) => id), [
      "first",
      "second",
    ]);
    assertEquals(archived.completedFormalGoalIds, ["first", "second"]);
    assertEquals(archived.plan?.runId, completed.plan.runId);
    assertEquals(archived.completion?.formalGoalIds, ["first", "second"]);
    for (let revisionOffset = 0; revisionOffset < 21; revisionOffset++) {
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: [{
            id: "app",
            kind: "asset",
            label: `Application ${revisionOffset}`,
          }],
          edges: [],
        }),
      );
      refreshSentinelAssessment(path);
    }
    const retained = readSentinelAssessmentRevision(path, revision);
    assertEquals(retained?.completion?.formalGoalIds, ["first", "second"]);
    assertEquals(
      readSentinelAssessmentRevision(path, initial.state.revision),
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Formal goal approval cannot exceed active criterion capacity or leave partial state", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const first = goal("first");
    const full = {
      ...first,
      criteria: Array.from(
        { length: 32 },
        (_, i) => ({ ...first.criteria[0], id: `criterion-${i}` }),
      ),
    };
    const current =
      applySentinelFormalGoals(path, request("start-full", [full])).state;
    assertThrows(() =>
      applySentinelFormalGoals(
        path,
        request("capacity", [goal("second")], current),
      )
    );
    assertEquals(readSentinelAssessment(path)?.revision, current.revision);
    assertEquals(readSentinelAssessment(path)?.plan.activeFormalGoalIds, [
      "first",
    ]);
    assert(
      completeSentinelAssessmentGoal(
        path,
        current.revision,
        current.plan.goal!,
        "Checked",
        undefined,
        () => true,
        ["first"],
      ),
    );
    const complete = readSentinelAssessment(path)!;
    const next = applySentinelFormalGoals(
      path,
      request("capacity", [goal("second")], complete),
    );
    assertEquals(next.state.plan.activeFormalGoalIds, ["second"]);
    assertEquals(next.state.plan.completedFormalGoalIds, ["first"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
