import { assertEquals } from "@std/assert";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import {
  adaptiveRevision,
  planSentinelTasks,
} from "../../src/sentinel/adaptive_planner.ts";
import {
  type AdaptiveTask,
  type AdaptiveTaskRequest,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";

function state(snapshot: unknown) {
  return {
    plan: {},
    active: true,
    paused: false,
    revision: 1,
    result: runSentinelAssessment({ snapshot }),
    updatedAt: "",
    reviews: [],
  };
}

function persisted(
  context: ReturnType<typeof state>,
  request: AdaptiveTaskRequest,
  status: AdaptiveTask["status"],
): AdaptiveTask {
  const revision = adaptiveRevision(context);
  return {
    ...request,
    id: sentinelAdaptiveTaskId(revision, request),
    revision,
    prerequisites: request.prerequisites ?? [],
    evidenceIds: request.evidenceIds ?? [],
    status,
    attempts: status === "queued" ? 0 : 1,
  };
}

Deno.test("Automatic finding review refills slots and skips held findings in rank order", () => {
  const nodes = Array.from({ length: 24 }, (_, index) => ({
    id: `finding-${String(index).padStart(2, "0")}`,
    label: `Finding ${index}`,
    kind: "finding",
    severity: "high",
  }));
  const context = state({ version: 1, nodes, edges: [] });
  const allow = ({ nodeId }: Pick<AdaptiveTaskRequest, "nodeId">) =>
    nodeId !== nodes[0].id;
  const held = persisted(context, {
    kind: "review_finding",
    nodeId: nodes[0].id,
  }, "queued");

  const initial = planSentinelTasks(context, [held], undefined, allow);
  assertEquals(
    initial.map(({ nodeId }) => nodeId),
    nodes.slice(1, 19).map(({ id }) => id),
  );
  const tasks = initial.map((request, index) =>
    persisted(
      context,
      request,
      index < 2 ? "completed" : index === 2 ? "running" : "queued",
    )
  );
  assertEquals(
    planSentinelTasks(context, [held, ...tasks], undefined, allow)
      .map(({ nodeId }) => nodeId),
    nodes.slice(19, 21).map(({ id }) => id),
  );
});

Deno.test("Automatic traffic review refills after the first six newest evidence groups", () => {
  const assets = Array.from({ length: 8 }, (_, index) => ({
    id: `asset-${index}`,
    label: `Asset ${index}`,
    kind: "asset",
  }));
  const evidence = assets.map((_, index) => ({
    id: `${index % 2 ? "dns" : "har"}:evidence:${index}`,
    label: `Imported observation at ${
      new Date(Date.UTC(2026, 0, 1, 0, 10 - index)).toISOString()
    }`,
    kind: "evidence",
  }));
  const context = state({
    version: 1,
    nodes: [
      ...assets,
      ...evidence,
      {
        id: "har:evidence:older",
        label: "An older observation at 2026-01-01T00:00:00.000Z",
        kind: "evidence",
      },
    ],
    edges: [
      ...evidence.map(({ id }, index) => ({
        from: id,
        to: assets[index].id,
        relation: "observed_on",
      })),
      {
        from: "har:evidence:older",
        to: assets[0].id,
        relation: "observed_on",
      },
    ],
  });
  const initial = planSentinelTasks(context, []);
  assertEquals(
    initial.map(({ nodeId }) => nodeId),
    evidence.slice(0, 6).map(({ id }) => id),
  );

  const persistedTasks = initial.map((request, index) =>
    persisted(
      context,
      request,
      index === 0 ? "completed" : index === 1 ? "running" : "queued",
    )
  );
  assertEquals(
    planSentinelTasks(context, persistedTasks).map(({ nodeId }) => nodeId),
    [evidence[6].id],
  );
  assertEquals(
    planSentinelTasks(
      context,
      persistedTasks.map((task) => ({ ...task, status: "completed" })),
    ).map(({ nodeId }) => nodeId),
    evidence.slice(6).map(({ id }) => id),
  );
});
