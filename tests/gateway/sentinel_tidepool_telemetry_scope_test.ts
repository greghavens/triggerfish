import { DatabaseSync } from "node:sqlite";
import { advanceAdaptiveSentinel } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { adaptiveRevision } from "../../src/sentinel/adaptive_planner.ts";
import {
  sentinelAlertKey,
  type TelemetryAlert,
} from "../../src/sentinel/telemetry.ts";
import { assert, assertEquals, assertExists } from "@std/assert";
import { dirname, join } from "@std/path";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import {
  recordSentinelOperatingConstraints,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import { createA2UIHost } from "../../src/tools/tidepool/host/host.ts";

Deno.test("Authenticated Tidepool hides revoked retained alert records and mixed incident cohorts", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const key = crypto.randomUUID();
  const host = createA2UIHost({ sessionKey: key });
  let socket: WebSocket | undefined;
  try {
    const graph = {
      version: 1,
      nodes: [
        { id: "app", kind: "asset", label: "Application" },
        { id: "proxy", kind: "asset", label: "Proxy" },
        { id: "private", kind: "asset", label: "Private asset" },
      ],
      edges: [{ from: "proxy", to: "private", relation: "depends_on" }],
    };
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(graph));
    function alert(
      type: string,
      asset: string,
      hour: string,
      evidenceId: string,
    ) {
      return {
        type,
        severity: type === "authentication_failure_burst" ? "medium" : "high",
        asset,
        subject: "operator",
        observedAt: `2026-01-01T${hour}:00:00.000Z`,
        evidenceIds: [evidenceId],
      };
    }
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([
        alert("network_security_alert", "app", "00", "app-network"),
        alert("authentication_failure_burst", "app", "00", "app-auth"),
        alert("network_security_alert", "proxy", "01", "proxy-network"),
        alert("authentication_failure_burst", "private", "01", "private-auth"),
      ]),
    );
    const saved = startSentinelAssessment(path);
    const runId = saved.plan.runId;
    assertExists(runId);
    host.registerTopicHandler(
      "sentinel",
      createTidepoolSentinelHandler({
        baseDir,
        config: { sentinel: { allow_model_access: true } },
      } as unknown as BootstrapResult),
    );
    const portProbe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (portProbe.addr as Deno.NetAddr).port;
    portProbe.close();
    await host.start(port);
    socket = new WebSocket(`ws://127.0.0.1:${port}/?key=${key}`);
    const ws = socket;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    let requestId = 0;
    function request(type: string, params: Record<string, unknown> = {}) {
      const id = ++requestId;
      const result = Promise.withResolvers<Record<string, unknown>>();
      const deadline = setTimeout(() => result.reject(new Error(type)), 2000);
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        if (event.requestId === id) result.resolve(event);
      };
      ws.addEventListener("message", receive);
      ws.send(JSON.stringify({
        topic: "sentinel",
        type,
        requestId: id,
        revision: saved.revision,
        ...params,
      }));
      return result.promise.finally(() => {
        clearTimeout(deadline);
        ws.removeEventListener("message", receive);
      });
    }
    const raw = await request("revision_alerts");
    assertEquals((raw.alerts as unknown[]).length, 4);
    const before = await request("incident_page");
    assertEquals(before.total, 2);
    const incidents = before.incidents as {
      sourceId: string;
      incident: { asset: string };
    }[];
    const allowed = incidents.find(({ incident }) => incident.asset === "app");
    const mixed = incidents.find(({ sourceId }) =>
      sourceId !== allowed?.sourceId
    );
    assertExists(allowed);
    assertExists(mixed);
    assertEquals(
      (await request("incident_alerts", {
        incidentId: mixed.sourceId,
      })).total,
      2,
    );

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...graph,
        nodes: [...graph.nodes, { id: "new", kind: "asset", label: "New" }],
      }),
    );
    const next = refreshSentinelAssessment(path);
    assertExists(next);
    assert(next.revision > saved.revision);
    assertEquals(next.plan.runId, runId);
    advanceAdaptiveSentinel(path, next);
    const assignment = { revision: adaptiveRevision(next), kind: "trace" };
    assertEquals(
      (await request("assign", {
        ...assignment,
        nodeId: "app",
      })).type,
      "sentinel_state",
    );
    const beforeScope = await request("assign", {
      ...assignment,
      nodeId: "private",
    });
    assertEquals(beforeScope.type, "sentinel_state");
    assert(JSON.stringify(beforeScope).includes('"nodeId":"private"'));

    const assignmentTasks = (beforeScope.adaptive as {
      tasks: { id: string; kind: string; nodeId: string }[];
    }).tasks;
    const visibleTask = assignmentTasks.find(({ nodeId, kind }) =>
      nodeId === "app" && kind === "trace"
    );
    const hiddenTask = assignmentTasks.find(({ nodeId, kind }) =>
      nodeId === "private" && kind === "trace"
    );
    assertExists(visibleTask);
    assertExists(hiddenTask);
    const historyArgs = {
      revision: next.revision,
      before: Number.MAX_SAFE_INTEGER,
    };
    const activity = new DatabaseSync(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const note = "unscoped worker narrative fixture";
    try {
      const event = activity.prepare(`
      INSERT INTO adaptive_events (revision, taskId, event, attempt, at, note)
      VALUES (?, ?, 'model_review_completed', 1, ?, ?)
    `);
      const timestamp = Date.now();
      for (let sequence = 0; sequence < 105; sequence++) {
        event.run(
          assignment.revision,
          visibleTask.id,
          timestamp + sequence,
          note,
        );
        event.run(
          assignment.revision,
          hiddenTask.id,
          timestamp + sequence,
          note,
        );
      }
    } finally {
      activity.close();
    }
    const previouslyVisible = await request("worker_history", historyArgs);
    assert(JSON.stringify(previouslyVisible).includes(hiddenTask.id));
    assert(JSON.stringify(previouslyVisible).includes(note));

    assert(recordSentinelOperatingConstraints(path, {
      runId,
      evidenceRevision: next.revision,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      operatorScope: "fixture-owner",
      constraints: { deniedKinds: [], allowedAssetIds: ["app", "proxy"] },
    }));

    const live = await request("status", { includeRevisions: true });
    assertEquals(live.type, "sentinel_state");
    assertEquals(live.scopeRestricted, true);
    assertEquals(live.revisions, undefined);
    assertEquals((live.assessment as { active: boolean }).active, true);
    assert(!JSON.stringify(live).includes('"private"'));
    const visibleTasks = (live.adaptive as {
      tasks: { nodeId: string; status: string }[];
    }).tasks;
    assert(
      visibleTasks.some(({ nodeId, status }) =>
        nodeId === "app" && typeof status === "string"
      ),
    );
    const updated = await request("assign", { ...assignment, nodeId: "proxy" });
    assertEquals(updated.type, "sentinel_state");
    assert(!JSON.stringify(updated).includes('"private"'));

    const scopedPage = await request("worker_history", historyArgs);
    assertEquals(scopedPage.type, "sentinel_worker_history");
    assert(!JSON.stringify(scopedPage).includes(hiddenTask.id));
    assert(!JSON.stringify(scopedPage).includes(note));

    const comparison = await request("revision", {
      revision: next.revision,
      baseline: saved.revision,
    });
    assertEquals(comparison.type, "sentinel_revision");
    assertEquals(comparison.scopeRestricted, true);
    type ActivityPage = {
      history: { cursor: number; taskId: string; note: null }[];
      historyCursor: number | null;
    };
    const first = comparison.adaptive as ActivityPage;
    assertExists(first.historyCursor);
    assertEquals(first.history.length, 100);
    assert(
      first.history.every(({ taskId, note }) =>
        taskId !== hiddenTask.id && note === null
      ),
    );
    assert(first.history.some(({ taskId }) => taskId === visibleTask.id));
    const cursorSequence = first.history.map(({ cursor }) => cursor);
    assertEquals(cursorSequence[0] - cursorSequence[99], 99);
    const older = await request("worker_history", {
      revision: next.revision,
      before: first.historyCursor,
    });
    const oldPage = older as unknown as ActivityPage;
    assertEquals(oldPage.historyCursor, null);
    assert(oldPage.history.length >= 5);
    assert(
      oldPage.history.every(({ cursor, taskId, note }) =>
        cursor < first.historyCursor! && taskId !== hiddenTask.id &&
        note === null
      ),
    );
    assertEquals(
      (scopedPage as unknown as ActivityPage).history,
      first.history,
    );
    assert(!JSON.stringify(older).includes(hiddenTask.id));

    const serialized = JSON.stringify(comparison);
    assert(!serialized.includes('"private"'));
    assert(!serialized.includes("private-auth"));
    assert(!serialized.includes(mixed.sourceId));
    const compared = comparison.comparison as {
      fullAlerts: { earlier: TelemetryAlert[]; later: TelemetryAlert[] };
      incidentNodes: { sourceId: string }[];
      graph: { nodes: { id: string }[] };
    };
    assertEquals(compared.graph.nodes.map(({ id }) => id), ["app", "proxy"]);
    for (
      const feed of [compared.fullAlerts.earlier, compared.fullAlerts.later]
    ) {
      assertEquals(feed.map(({ asset }) => asset), ["app", "app", "proxy"]);
    }
    assertEquals(compared.incidentNodes.map(({ sourceId }) => sourceId), [
      allowed.sourceId,
    ]);
    assertEquals(
      (await request("revision", { focusIncidentId: mixed.sourceId })).type,
      "error",
    );
    const allowedFocus = await request("revision", {
      focusIncidentId: allowed.sourceId,
    });
    assertEquals(allowedFocus.type, "sentinel_revision");
    assertEquals(
      allowedFocus.focusId,
      `observation:assessment:${allowed.sourceId}`,
    );
    const revokedAlert = (raw.alerts as TelemetryAlert[]).find(({ asset }) =>
      asset === "private"
    );
    assertExists(revokedAlert);
    assertEquals(
      (await request("revision", {
        focusAlertKey: sentinelAlertKey(revokedAlert),
      })).type,
      "error",
    );

    const scoped = await request("revision_alerts");
    assertEquals(
      (scoped.alerts as { asset: string }[]).map(({ asset }) => asset),
      [
        "app",
        "app",
        "proxy",
      ],
    );
    assert(!JSON.stringify(scoped).includes("private-auth"));
    const page = await request("incident_page");
    assertEquals(page.total, 1);
    assertEquals(page.nextOffset, null);
    assertEquals(page.incidents, [allowed]);
    const denied = await request("incident_alerts", {
      incidentId: mixed.sourceId,
    });
    assertEquals(denied.type, "error");
    assertEquals(denied.alerts, undefined);
    assertEquals(denied.total, undefined);
    assertEquals(denied.nextOffset, undefined);
    const visible = await request("incident_alerts", {
      incidentId: allowed.sourceId,
    });
    assertEquals(visible.total, 2);
    assertEquals(
      (visible.alerts as { asset: string }[]).map(({ asset }) => asset),
      [
        "app",
        "app",
      ],
    );
  } finally {
    socket?.close();
    await host.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
