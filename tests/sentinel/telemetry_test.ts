import { assertEquals, assertThrows } from "@std/assert";
import { parseSentinelTelemetryAlert } from "../../src/sentinel/case_report.ts";
import { assessSentinelDefenseCoverage } from "../../src/sentinel/defense_coverage.ts";
import { correlateSentinelIncidents } from "../../src/sentinel/incident_correlation.ts";
import {
  AUTH_FANOUT_LIMIT,
  AUTH_WINDOW_MS,
  createTelemetryDetector,
  normalizeSentinelTelemetryEvent,
  WEB_SEQUENCE_WINDOW_MS,
  WEB_STAGES,
} from "../../src/sentinel/telemetry.ts";

const start = Date.parse("2026-01-01T00:00:00Z");

function event(
  id: number,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    version: 1,
    id: String(id),
    timestamp: new Date(start + id * 1000).toISOString(),
    asset: "gateway",
    kind: "auth_failure",
    subject: "account-1",
    ...overrides,
  };
}

Deno.test("Sentinel correlates authentication bursts and a subsequent success", () => {
  const { ingest } = createTelemetryDetector();
  for (let id = 1; id <= 4; id++) assertEquals(ingest(event(id)), []);
  assertEquals(ingest(event(4)), []);
  const sessionReference = `session:${"b".repeat(64)}`;
  assertEquals(ingest(event(5, { sessionReference })), [{
    type: "authentication_failure_burst",
    severity: "medium",
    asset: "gateway",
    subject: "account-1",
    observedAt: event(5).timestamp,
    evidenceIds: ["1", "2", "3", "4", "5"],
  }]);
  assertEquals(ingest(event(6)), []);
  assertEquals(ingest(event(3, { id: "late-record" })), []);
  assertEquals(ingest(event(7, { kind: "auth_success", sessionReference })), [{
    type: "authentication_success_after_failures",
    severity: "high",
    asset: "gateway",
    subject: "account-1",
    observedAt: event(7).timestamp,
    evidenceIds: ["2", "3", "4", "5", "6", "7"],
  }]);
  assertEquals(ingest(event(8, { kind: "auth_success" })), []);
});

Deno.test("Sentinel separates correlation subjects and expires denial evidence by event time", () => {
  const { ingest } = createTelemetryDetector();
  const denial = { kind: "egress_denied", subject: "destination-policy-1" };
  assertEquals(ingest(event(0, denial)), []);
  for (let id = 1; id <= 3; id++) assertEquals(ingest(event(id, denial)), []);
  assertEquals(ingest(event(4, { ...denial, asset: "runner" })), []);
  assertEquals(ingest(event(60, denial)), []);
  assertEquals(ingest(event(61, denial)), []);
  for (let id = 62; id <= 63; id++) assertEquals(ingest(event(id, denial)), []);
  assertEquals(ingest(event(64, denial)), [{
    type: "egress_denied_burst",
    severity: "medium",
    asset: "gateway",
    subject: "destination-policy-1",
    observedAt: event(64).timestamp,
    evidenceIds: ["60", "61", "62", "63", "64"],
  }]);
});

Deno.test("Sentinel validates event metadata and deduplicates integrity alerts", () => {
  const { ingest } = createTelemetryDetector();
  assertThrows(() => ingest(event(1, { timestamp: "2026-02-30T00:00:00Z" })));
  assertThrows(() =>
    ingest(event(1, { timestamp: "2026-01-01T00:00:00+00:00" }))
  );
  assertThrows(() => ingest(event(1, { asset: " " })));
  assertThrows(() => ingest(event(1, { version: 2 })));
  assertThrows(() => ingest(event(1, { kind: "invalid" })));

  const change = event(1, {
    kind: "integrity_change",
    timestamp: "2026-01-01T00:00:01.3Z",
    subject: "protected policy",
  });
  assertEquals(ingest(change), [{
    type: "integrity_change",
    severity: "high",
    asset: "gateway",
    subject: "protected policy",
    observedAt: "2026-01-01T00:00:01.300Z",
    evidenceIds: ["1"],
  }]);
  assertEquals(ingest(change), []);
});

Deno.test("Sensor severity survives detection and saved alert validation", () => {
  const { ingest } = createTelemetryDetector();
  const sensor = event(1, {
    kind: "security_sensor_alert",
    severity: "critical",
  });
  const [raised] = ingest(sensor);
  const update = event(4, { kind: "security_sensor_alert", severity: "low" });
  assertEquals(ingest(update)[0].severity, "low");
  assertEquals(ingest({ ...update, severity: "high" })[0].severity, "high");
  assertEquals(ingest(update), []);
  assertEquals(raised.severity, "critical");
  assertEquals(parseSentinelTelemetryAlert(raised, 1), raised);
  assertEquals(
    ingest(event(2, { kind: "security_sensor_alert" }))[0].severity,
    "medium",
  );
  assertThrows(() =>
    ingest(event(3, { kind: "security_sensor_alert", severity: "unknown" }))
  );
  assertThrows(() =>
    parseSentinelTelemetryAlert({ ...raised, type: "integrity_change" }, 1)
  );
});

Deno.test("Authentication success respects the failure window, asset, and subject", () => {
  const { ingest } = createTelemetryDetector();
  const windowMs = 5 * 60 * 1000;
  const failures = Array.from({ length: 5 }, (_, id) => event(id));
  assertEquals(failures.flatMap(ingest).map(({ type }) => type), [
    "authentication_failure_burst",
  ]);
  assertEquals(
    ingest(event(5, {
      kind: "auth_success",
      subject: "different-account",
    })),
    [],
  );
  assertEquals(
    ingest(event(6, {
      kind: "auth_success",
      asset: "different-gateway",
    })),
    [],
  );
  assertEquals(
    ingest(event(7, {
      kind: "auth_success",
      timestamp: new Date(start + windowMs).toISOString(),
    })),
    [],
  );
  assertEquals(
    ingest(event(8, {
      kind: "auth_success",
      timestamp: new Date(start + windowMs + 1000).toISOString(),
    })),
    [],
  );
});

const webSession = `session:${"a".repeat(64)}`;
const otherWebSession = `session:${"b".repeat(64)}`;

function webEvent(time: number, stage: 0 | 1 | 2, overrides = {}) {
  return event(time, {
    kind: WEB_STAGES[stage],
    sessionReference: webSession,
    ...overrides,
  });
}

Deno.test("Sentinel correlates trusted web stages and preserves only bounded session evidence", () => {
  const { ingest } = createTelemetryDetector();
  const exploration = webEvent(1, 0, {
    subject: "private actor text",
    action: "private action text",
    identityReference: "private identity text",
    request: "private request text",
  });
  const normalized = normalizeSentinelTelemetryEvent(exploration);
  assertEquals(normalized, {
    version: 1,
    id: "1",
    timestamp: event(1).timestamp,
    asset: "gateway",
    kind: WEB_STAGES[0],
    subject: webSession,
    sessionReference: webSession,
  });
  assertEquals(ingest(exploration), []);
  assertEquals(ingest(webEvent(2, 1)), []);
  // A new enumeration does not erase an already valid first pair.
  assertEquals(ingest(webEvent(3, 0)), []);
  const [result] = ingest(webEvent(4, 2));
  const expected = {
    type: "web_multistage_activity" as const,
    severity: "medium" as const,
    observedAt: event(4).timestamp,
    asset: "gateway",
    subject: webSession,
    sessionReference: webSession,
    evidenceIds: ["1", "2", "4"],
  };
  assertEquals(result, expected);
  assertEquals(parseSentinelTelemetryAlert(result, 1), expected);
  assertEquals(ingest(webEvent(4, 2)), []);
  assertEquals(ingest(webEvent(5, 2)), []);

  const coverage = assessSentinelDefenseCoverage({ alerts: [result] });
  const web = coverage.behaviors.find(({ id }) => id === "reconnaissance")
    ?.signals.find(({ type }) => type === result.type);
  assertEquals(web?.origin, "sentinel_rule");
  assertEquals(web?.records[0].evidenceIds, expected.evidenceIds);

  const network = ingest(event(6, { kind: "network_security_alert" }));
  assertEquals(correlateSentinelIncidents([result, ...network]).candidates, []);
  const endpoint = ingest(event(7, { kind: "endpoint_execution_alert" }));
  assertEquals(
    correlateSentinelIncidents([result, ...endpoint]).candidates[0].signals,
    ["endpoint", "network"],
  );
});

Deno.test("Sentinel web correlation separates cases, assets, and authority-scoped sessions", () => {
  const first = createTelemetryDetector().ingest;
  const second = createTelemetryDetector().ingest;
  assertThrows(
    () => first(webEvent(1, 0, { sessionReference: undefined })),
    Error,
    "session reference",
  );
  assertThrows(
    () => first(webEvent(1, 0, { sessionReference: "192.0.2.5" })),
    Error,
    "session reference",
  );
  assertEquals(first(webEvent(1, 0)), []);
  assertEquals(first(webEvent(2, 1, { asset: "other-gateway" })), []);
  assertEquals(
    first(webEvent(3, 1, { sessionReference: otherWebSession })),
    [],
  );
  assertEquals(first(webEvent(4, 2)), []);
  assertEquals(first(webEvent(5, 1)), []);
  assertEquals(second(webEvent(6, 2)), []);
  assertEquals(
    first(webEvent(7, 2, { sessionReference: otherWebSession })),
    [],
  );
  assertEquals(first(webEvent(8, 2)).map(({ evidenceIds }) => evidenceIds), [[
    "1",
    "5",
    "8",
  ]]);
});

Deno.test("Sentinel web correlation rejects stale, tied, reversed, and duplicate evidence", () => {
  const { ingest } = createTelemetryDetector();
  assertEquals(ingest(webEvent(1, 1)), []);
  assertEquals(ingest(webEvent(2, 0)), []);
  assertEquals(ingest(webEvent(1, 1, { id: "late" })), []);
  assertEquals(ingest(webEvent(2, 1, { id: "tied" })), []);
  assertEquals(ingest(webEvent(3, 1, { id: "2" })), []);
  assertEquals(ingest(webEvent(4, 2)), []);
  assertEquals(
    ingest(webEvent(5, 1)),
    [],
  );
  assertEquals(ingest(webEvent(5, 2, { id: "tied-auth" })), []);
  const duration = WEB_SEQUENCE_WINDOW_MS / 1000;
  assertEquals(ingest(webEvent(2 + duration, 2)), []);
  assertEquals(ingest(webEvent(3 + duration, 0)), []);
  assertEquals(ingest(webEvent(4 + duration, 1)), []);
  assertEquals(ingest(webEvent(2 + 2 * duration, 2)).length, 1);
});

Deno.test("Sentinel evicts old web session state under high session cardinality", () => {
  const { ingest } = createTelemetryDetector();
  assertEquals(ingest(webEvent(0, 0)), []);
  for (let id = 1; id <= 4096; id++) {
    ingest(webEvent(0, 0, {
      id: String(id),
      sessionReference: `session:${id.toString(16).padStart(64, "0")}`,
    }));
  }
  assertEquals(ingest(webEvent(1, 1, { id: "later-probe" })), []);
  assertEquals(ingest(webEvent(2, 2, { id: "later-auth" })), []);
});

const authSource = `source:${"a".repeat(64)}`;
const authSourceOtherTenant = `source:${"b".repeat(64)}`;

function failedFromSource(time: number, subject: string, overrides = {}) {
  return event(time, { subject, sourceReference: authSource, ...overrides });
}

Deno.test("Sentinel correlates failure fan-out with one event per canonical account", () => {
  const { ingest } = createTelemetryDetector();
  const first = failedFromSource(0, "account-a");
  assertEquals(
    normalizeSentinelTelemetryEvent(first).sourceReference,
    authSource,
  );
  assertEquals(ingest(first), []);
  assertEquals(ingest(failedFromSource(1, "account-a")), []);
  assertEquals(ingest(failedFromSource(2, "account-b")), []);
  assertEquals(ingest(failedFromSource(2, "account-c")), []);
  assertEquals(ingest(failedFromSource(3, "account-c")), []);
  assertEquals(ingest(failedFromSource(4, "account-d")), []);
  const [result] = ingest(failedFromSource(5, "account-e"));
  assertEquals(result, {
    type: "authentication_failure_fanout",
    severity: "medium",
    asset: "gateway",
    observedAt: event(5).timestamp,
    subject: authSource,
    sourceReference: authSource,
    evidenceIds: ["1", "2", "3", "4", "5"],
  });
  assertEquals(parseSentinelTelemetryAlert(result, 1), result);
  assertThrows(() =>
    parseSentinelTelemetryAlert({ ...result, sourceReference: "192.0.2.9" }, 1)
  );
  assertThrows(() =>
    parseSentinelTelemetryAlert({ ...result, evidenceIds: ["1"] }, 1)
  );
  assertThrows(() =>
    parseSentinelTelemetryAlert({ ...result, subject: "account-e" }, 1)
  );
  assertThrows(() =>
    parseSentinelTelemetryAlert({ ...result, sessionReference: webSession }, 1)
  );
  assertEquals(ingest(failedFromSource(6, "account-f")), []);

  const coverage = assessSentinelDefenseCoverage({ alerts: [result] });
  const fanout = coverage.behaviors.find(({ id }) => id === "credential_abuse")
    ?.signals.find(({ type }) => type === "authentication_failure_fanout");
  assertEquals(fanout?.origin, "sentinel_rule");
  assertEquals(fanout?.records[0].evidenceIds, result.evidenceIds);
  const isolated = correlateSentinelIncidents([result]).uncorrelatedAlerts;
  assertEquals(isolated.map(({ signalClass }) => signalClass), [
    "authentication",
  ]);
});

Deno.test("Sentinel fan-out separates source authority, asset, case, and unscoped records", () => {
  const { ingest } = createTelemetryDetector();
  const otherCase = createTelemetryDetector();
  for (let i = 0; i < AUTH_FANOUT_LIMIT - 1; i++) {
    assertEquals(ingest(failedFromSource(i, `account-${i}`)), []);
  }
  assertThrows(
    () =>
      ingest(
        failedFromSource(4, "account-e", { sourceReference: "192.0.2.9" }),
      ),
    Error,
    "source reference",
  );
  assertEquals(ingest(event(5, { subject: "account-e" })), []);
  assertEquals(
    ingest(
      failedFromSource(6, "account-e", {
        sourceReference: authSourceOtherTenant,
      }),
    ),
    [],
  );
  assertEquals(
    ingest(failedFromSource(7, "account-e", { asset: "other-asset" })),
    [],
  );
  assertEquals(
    ingest(failedFromSource(8, "account-e", { kind: "auth_success" })),
    [],
  );
  assertEquals(otherCase.ingest(failedFromSource(9, "account-e")), []);
  assertEquals(ingest(failedFromSource(10, "account-e")).length, 1);
});

Deno.test("Sentinel fan-out expires distinct-account evidence and ignores late records", () => {
  const { ingest } = createTelemetryDetector();
  const duration = AUTH_WINDOW_MS / 1000;
  for (let i = 0; i < AUTH_FANOUT_LIMIT - 1; i++) {
    assertEquals(ingest(failedFromSource(i, `account-${i}`)), []);
  }
  assertEquals(ingest(failedFromSource(duration, "account-e")), []);
  assertEquals(ingest(failedFromSource(4, "account-e", { id: "late" })), []);
  assertEquals(
    ingest(failedFromSource(duration, "fresh-account", { id: "fresh" }))[0]
      .evidenceIds,
    ["1", "2", "3", String(duration), "fresh"],
  );
});

Deno.test("Sentinel fan-out bounds memory by evicting the oldest source windows", () => {
  const { ingest } = createTelemetryDetector();
  for (let i = 0; i < AUTH_FANOUT_LIMIT - 1; i++) {
    assertEquals(ingest(failedFromSource(i, `account-${i}`)), []);
  }
  for (let i = 1; i <= 4096; i++) {
    ingest(failedFromSource(4, "unrelated-account", {
      id: `unrelated-${i}`,
      sourceReference: `source:${i.toString(16).padStart(64, "0")}`,
    }));
  }
  assertEquals(ingest(failedFromSource(5, "account-e")), []);
});
