import { assertEquals } from "@std/assert";
import { resolveTeamComposition } from "../../../src/gateway/healing/team_spawner.ts";
import type { SessionId } from "../../../src/core/types/session.ts";
import type { InterventionCategory } from "../../../src/core/types/healing.ts";

function makeOptions(category: InterventionCategory) {
  return {
    category,
    leadSessionId: "lead-1" as SessionId,
    currentTaint: "PUBLIC" as const,
    workflowName: "test-wf",
    failedTaskName: "fetch-data",
    createTeam: () =>
      Promise.resolve({ teamId: "t1", disband: () => Promise.resolve() }),
  };
}

Deno.test("resolveTeamComposition: transient_retry has 1 role", () => {
  const comp = resolveTeamComposition(makeOptions("transient_retry"));
  assertEquals(comp.roles.length, 1);
  assertEquals(comp.roles[0].name, "retry-coordinator");
});

Deno.test("resolveTeamComposition: runtime_workaround has 2 roles", () => {
  const comp = resolveTeamComposition(makeOptions("runtime_workaround"));
  assertEquals(comp.roles.length, 2);
  assertEquals(comp.roles.some((r) => r.name === "diagnostician"), true);
  assertEquals(comp.roles.some((r) => r.name === "workaround-author"), true);
});

Deno.test("resolveTeamComposition: structural_fix has diagnostician + fixer", () => {
  const comp = resolveTeamComposition(makeOptions("structural_fix"));
  assertEquals(comp.roles.length, 2);
  assertEquals(comp.roles.some((r) => r.name === "diagnostician"), true);
  assertEquals(comp.roles.some((r) => r.name === "definition-fixer"), true);
});

Deno.test("resolveTeamComposition: plugin_gap has diagnostician + plugin-author", () => {
  const comp = resolveTeamComposition(makeOptions("plugin_gap"));
  assertEquals(comp.roles.length, 2);
  assertEquals(comp.roles.some((r) => r.name === "plugin-author"), true);
});

Deno.test("resolveTeamComposition: unresolvable has diagnostician only", () => {
  const comp = resolveTeamComposition(makeOptions("unresolvable"));
  assertEquals(comp.roles.length, 1);
  assertEquals(comp.roles[0].name, "diagnostician");
});

Deno.test("resolveTeamComposition: inherits lead taint", () => {
  const opts = makeOptions("structural_fix");
  const comp = resolveTeamComposition({
    ...opts,
    currentTaint: "CONFIDENTIAL",
  });
  assertEquals(comp.taint, "CONFIDENTIAL");
});

Deno.test("resolveTeamComposition: name includes workflow and task", () => {
  const comp = resolveTeamComposition(makeOptions("structural_fix"));
  assertEquals(comp.name.includes("test-wf"), true);
  assertEquals(comp.name.includes("fetch-data"), true);
});
