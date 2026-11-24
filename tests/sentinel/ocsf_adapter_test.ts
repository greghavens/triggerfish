import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { adaptOcsfEvent } from "../../src/sentinel/ocsf_adapter.ts";
import { createTelemetryDetector } from "../../src/sentinel/telemetry.ts";

const record = {
  class_uid: 2004,
  activity_id: 1,
  time: 1_795_523_696_123,
  finding_info: { uid: "native-finding-id", title: "Private finding title" },
  metadata: {
    product: { vendor_name: "Vendor", name: "Monitor" },
  },
  resources: [
    { uid: "asset:west-01" },
    { uid: "asset:west-01", role_id: 1 },
    { uid: "actor-02", role_id: 2 },
    { uid: "asset:west-03", role_id: 1 },
    { name: "Unscoped display name" },
  ],
  raw_data: "raw event and evidence",
};

Deno.test("OCSF Detection Findings preserve exact target UIDs with no raw fields", () => {
  const events = adaptOcsfEvent(record);
  assertEquals(events.length, 2);
  assertEquals(events.map((event) => event.asset), [
    "asset:west-01",
    "asset:west-03",
  ]);
  assertMatch(events[0].id, /^ocsf:[a-f0-9]{64}$/);
  assertEquals(events[0], {
    kind: "security_sensor_alert",
    version: 1,
    id: events[0].id,
    timestamp: new Date(record.time).toISOString(),
    asset: "asset:west-01",
    subject: "OCSF Detection Finding",
  });
});

Deno.test("OCSF finding identity remains stable across updates and separates products", () => {
  const initial = adaptOcsfEvent(record)[0];
  const updated =
    adaptOcsfEvent({ ...record, activity_id: 2, time: record.time + 5000 })[0];
  const alternative = adaptOcsfEvent({
    ...record,
    metadata: { product: { name: "Other" } },
  })[0];
  assertEquals(updated.id, initial.id);
  assertNotEquals(updated.timestamp, initial.timestamp);
  assertNotEquals(alternative.id, initial.id);
  const detector = createTelemetryDetector();
  assertEquals(detector.ingest(initial)[0].type, "security_sensor_alert");
  assertEquals(detector.ingest(updated), []);
  assertEquals(detector.ingest(alternative)[0].severity, "medium");
});

Deno.test("OCSF skips unrelated, closed and unscoped records", () => {
  assertEquals(adaptOcsfEvent({ class_uid: 4001 }), []);
  assertEquals(adaptOcsfEvent({ ...record, activity_id: 3 }), []);
  assertEquals(
    adaptOcsfEvent({
      ...record,
      resources: [{ uid: "actor", role_id: 2 }],
      device: { uid: "ambiguous-pivot" },
    }),
    [],
  );
  assertEquals(
    adaptOcsfEvent({
      ...record,
      resources: [],
      device: { uid: "affected-device" },
    })[0].asset,
    "affected-device",
  );
});

Deno.test("OCSF validates selected fields for active findings", () => {
  assertThrows(
    () => adaptOcsfEvent({ ...record, time: "2026-11-24" }),
    Error,
    "Unix milliseconds",
  );
  assertThrows(
    () => adaptOcsfEvent({ ...record, finding_info: { uid: " " } }),
    Error,
    "finding_info.uid",
  );
  assertThrows(
    () => adaptOcsfEvent({ ...record, resources: [{ uid: "asset\nescape" }] }),
    Error,
    "resource.uid",
  );
});
