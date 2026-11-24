import { assertEquals, assertThrows } from "@std/assert";
import { createSentinelIndicatorDetector } from "../../src/sentinel/indicators.ts";

const dnsRule = {
  kind: "dns",
  field: "query",
  value: "telemetry.invalid",
  id: "dns-1",
  source: "IR-241",
  severity: "high",
};

const event = {
  version: 1,
  id: "sensor-12",
  asset: "workstation-5",
  timestamp: "2026-11-01T11:10:00Z",
  kind: "dns",
  fields: { query: "TELEMETRY.INVALID." },
};

Deno.test("Sentinel correlates normalized DNS records and produces source/evidence references", () => {
  const detector = createSentinelIndicatorDetector({
    version: 1,
    rules: [dnsRule],
  });
  assertEquals(detector.ingest(event), [{
    type: "indicator_match",
    indicatorId: "dns-1",
    source: "IR-241",
    severity: "high",
    asset: "workstation-5",
    kind: "dns",
    field: "query",
    observedAt: "2026-11-01T11:10:00.000Z",
    evidenceIds: ["sensor-12"],
  }]);
  for (const query of ["x.telemetry.invalid", "other.invalid"]) {
    assertEquals(detector.ingest({ ...event, fields: { query } }), []);
  }
});

Deno.test("Sentinel restricts scoped rules to exact assets", () => {
  const detector = createSentinelIndicatorDetector({
    version: 1,
    rules: [{ ...dnsRule, asset: "workstation-6" }],
  });
  assertEquals(detector.ingest(event), []);
  assertEquals(detector.ingest({ ...event, asset: "WORKSTATION-6" }), []);
  assertEquals(detector.ingest({ ...event, asset: "workstation-6" }).length, 1);
});

Deno.test("Sentinel correlates exact HTTP fields and normalized artifact hashes", () => {
  const hash = "ab".repeat(32);
  const detector = createSentinelIndicatorDetector({
    version: 1,
    rules: [
      { ...dnsRule, id: "path", kind: "http", field: "path", value: "/Health" },
      {
        ...dnsRule,
        id: "ua",
        kind: "http",
        field: "userAgent",
        value: "sensor/1",
      },
      { ...dnsRule, id: "sha", kind: "host", field: "sha256", value: hash },
    ],
  });
  const http = {
    ...event,
    kind: "http",
    fields: { path: "/health", userAgent: "sensor/1" },
  };
  assertEquals(detector.ingest(http).map(({ indicatorId }) => indicatorId), [
    "ua",
  ]);
  assertEquals(
    detector.ingest({
      ...http,
      fields: { path: "/Health", userAgent: "sensor/1.0" },
    }).map(({ indicatorId }) => indicatorId),
    ["path"],
  );
  assertEquals(
    detector.ingest({
      ...event,
      kind: "host",
      fields: { sha256: hash.toUpperCase(), processName: "test" },
    }).map(({ indicatorId }) => indicatorId),
    ["sha"],
  );
});

Deno.test("Sentinel rejects invalid catalogs, fields, and event times", () => {
  for (
    const rule of [
      { ...dnsRule, source: "" },
      { ...dnsRule, field: "sha256" },
      { ...dnsRule, value: "*.invalid" },
      { ...dnsRule, kind: "host", field: "sha256", value: "ab" },
    ]
  ) {
    assertThrows(() =>
      createSentinelIndicatorDetector({
        version: 1,
        rules: [rule],
      }), Error);
  }
  assertThrows(
    () =>
      createSentinelIndicatorDetector({
        version: 1,
        rules: [dnsRule, dnsRule],
      }),
    Error,
    "Duplicate",
  );
  const detector = createSentinelIndicatorDetector({
    version: 1,
    rules: [dnsRule],
  });
  assertThrows(
    () => detector.ingest({ ...event, fields: { userAgent: "client" } }),
    Error,
    "field for dns",
  );
  assertThrows(
    () => detector.ingest({ ...event, timestamp: "2026-02-30T00:00:00Z" }),
    Error,
    "calendar timestamp",
  );
});
