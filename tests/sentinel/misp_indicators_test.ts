import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { createSentinelIndicatorDetector } from "../../src/sentinel/indicators.ts";
import { importSentinelMispIndicators } from "../../src/sentinel/misp_indicators.ts";

const eventId = "12345678-1234-4234-8234-123456789012";
const attrId = "12345678-1234-4234-8234-123456789013";
const domain = {
  type: "domain",
  uuid: attrId,
  to_ids: true,
  value: "Suspect.Example.",
};

Deno.test("MISP maps supported fields to exact passive indicator rules", () => {
  const catalog = importSentinelMispIndicators({
    response: [{
      Event: {
        uuid: eventId,
        Attribute: [
          domain,
          { type: "sha256", to_ids: true, value: "F".repeat(64) },
          { type: "user-agent", to_ids: true, value: "Observed client 1.0" },
          { type: "url", to_ids: true, value: "https://suspect.example/path" },
          { type: "domain", to_ids: false, value: "disabled.example" },
          { type: "domain", value: "missing-opt-in.example" },
          {
            type: "domain",
            to_ids: true,
            deleted: true,
            value: "deleted.example",
          },
          { type: "hostname", to_ids: true, value: "_service.example" },
        ],
      },
    }],
  }, "Local feed");
  assertEquals(catalog.rules.length, 5);
  assertEquals(
    catalog.rules.filter(({ value }) => value === "suspect.example").length,
    2,
  );
  const detector = createSentinelIndicatorDetector(catalog);
  const [match] = detector.ingest({
    version: 1,
    id: "http-event",
    asset: "app",
    timestamp: "2026-11-24T12:00:00Z",
    kind: "http",
    fields: { host: "SUSPECT.EXAMPLE" },
  });
  assertEquals(match.severity, "medium");
  assertStringIncludes(
    match.source,
    `Local feed (MISP event ${eventId} attribute ${attrId})`,
  );
});

Deno.test("MISP keeps UUID-backed rule identity stable across export layouts", () => {
  const wrapped = importSentinelMispIndicators({
    Event: { uuid: eventId, Attribute: [domain] },
  }, "Feed");
  const direct = importSentinelMispIndicators({
    response: { Attribute: [domain, domain] },
  }, "Feed");
  assertEquals(
    wrapped.rules.map(({ id }) => id),
    direct.rules.map(({ id }) => id),
  );
});

Deno.test("MISP rejects malformed supported values and duplicate-reference conflicts", () => {
  assertThrows(
    () =>
      importSentinelMispIndicators({
        Attribute: {
          type: "sha256",
          to_ids: true,
          value: "invalid",
        },
      }, "Feed"),
    Error,
    "SHA-256",
  );
  assertThrows(
    () =>
      importSentinelMispIndicators([
        domain,
        { ...domain, value: "different.example" },
      ], "Feed"),
    Error,
    "Conflicting",
  );
  assertThrows(
    () => importSentinelMispIndicators({ response: null }, "Feed"),
    Error,
    "export object",
  );
});
