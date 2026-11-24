import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  adaptCefAlert,
  validateCefAlertSelectors,
} from "../../src/sentinel/cef_adapter.ts";
import { createTelemetryDetector } from "../../src/sentinel/telemetry.ts";

const utc = "2026-11-24T12:34:56.000Z";
const baseMapping = {
  vendor: "Example|Vendor",
  product: "Monitor\\Web",
  classId: "2001",
  asset: "default-asset",
};
const policy = validateCefAlertSelectors([
  baseMapping,
  { ...baseMapping, source: "collector-west", asset: "west-gateway" },
]);
const header = String
  .raw`CEF:1|Example\|Vendor|Monitor\\Web|1.0|2001|Private rule \| description|High|`;
const cef = header + "private=secret-value";

Deno.test("CEF accepts exact matches and prefers explicit source assets", () => {
  const [normalized] = adaptCefAlert(cef, utc, "collector-west", policy);
  const detector = createTelemetryDetector();
  const [alert] = detector.ingest(normalized);
  assertEquals(alert.asset, "west-gateway");
  assertEquals(alert.subject, "CEF security alert");
  assertEquals(alert.severity, "medium");
  assertEquals(alert.type, "security_sensor_alert");
  assertEquals(alert.observedAt, utc);
  assertMatch(alert.evidenceIds[0], /^cef:[a-f0-9]{64}$/);
  assertEquals(
    detector.ingest(adaptCefAlert(cef, utc, "collector-west", policy)[0]),
    [],
  );
  const [other] = detector.ingest(
    adaptCefAlert(cef, utc, "collector-east", policy)[0],
  );
  assertEquals(other.asset, "default-asset");
  assertNotEquals(other.evidenceIds[0], alert.evidenceIds[0]);

  assertEquals(
    adaptCefAlert(
      cef.replace("|2001|", "|2002|"),
      utc,
      "collector-west",
      policy,
    ),
    [],
  );
  assertEquals(
    adaptCefAlert(
      cef.replace("Example", "example"),
      utc,
      "collector-west",
      policy,
    ),
    [],
  );
  assertEquals(
    adaptCefAlert("ordinary syslog message", utc, "collector-west", policy),
    [],
  );
});

Deno.test("CEF message identity distinguishes source records without outputting extensions", () => {
  const [first] = adaptCefAlert(cef, utc, "collector-west", policy);
  const [second] = adaptCefAlert(
    header + "private=other-value",
    utc,
    "collector-west",
    policy,
  );
  assertNotEquals(first, second);
  assertEquals(JSON.stringify(first).includes("secret-value"), false);
  assertEquals(JSON.stringify(first).includes("Private rule"), false);
});

Deno.test("CEF validates selector policy and event framing", () => {
  assertThrows(
    () =>
      validateCefAlertSelectors([baseMapping, {
        ...baseMapping,
        asset: "duplicate",
      }]),
    Error,
    "Duplicate",
  );
  assertThrows(
    () =>
      validateCefAlertSelectors([{
        ...baseMapping,
        classID: "mistyped property",
      }]),
    Error,
    "Unexpected",
  );
  assertThrows(
    () =>
      adaptCefAlert(cef.replace("High", "17"), utc, "collector-west", policy),
    Error,
    "severity",
  );
  assertThrows(
    () =>
      adaptCefAlert(
        cef.replace("CEF:1", "CEF:2"),
        utc,
        "collector-west",
        policy,
      ),
    Error,
    "Unsupported",
  );
  assertThrows(
    () => adaptCefAlert(cef, "2026-11-24T12:34:56", "collector-west", policy),
    Error,
    "in UTC",
  );
  assertThrows(
    () => adaptCefAlert(cef, utc, "-", policy),
    Error,
    "hostname",
  );
});
