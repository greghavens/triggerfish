import { assertEquals, assertThrows } from "@std/assert";
import { buildSentinelNavigatorLayer } from "../../src/sentinel/navigator.ts";

Deno.test("Navigator export keeps operator mappings and deduplicates alert evidence", () => {
  const mapping = [
    { techniqueID: "T1110", signal: "authentication_failure_burst" },
    { techniqueID: "T1110", signal: "authentication_failure_burst" },
  ];
  const alert = {
    type: "authentication_failure_burst",
    asset: "app",
    subject: "account",
    severity: "medium",
    observedAt: "2026-01-01T00:00:00.000Z",
    evidenceIds: ["evidence"],
  };
  const result = buildSentinelNavigatorLayer(mapping, [alert, alert]);
  assertEquals(result.techniques.length, 1);
  assertEquals(result.techniques[0].metadata, [{
    name: "authentication_failure_burst",
    value: "1 distinct alert(s)",
  }]);
  assertThrows(() =>
    buildSentinelNavigatorLayer([{ techniqueID: "custom", signal: "unknown" }])
  );
});

Deno.test("Navigator can map an exact source action without counting unrelated alerts", () => {
  const signal = "integrity_change";
  const triggeringAction = "cloudtrail.amazonaws.com:StopLogging";
  const outcome = buildSentinelNavigatorLayer([
    { techniqueID: "T1562.008", signal, triggeringAction },
  ], [
    {
      type: signal,
      triggeringAction,
      asset: "account-a",
      subject: "fixture",
      severity: "high",
      observedAt: "2026-01-01T00:00:00.000Z",
      evidenceIds: ["match"],
    },
    {
      type: signal,
      triggeringAction: "cloudtrail.amazonaws.com:UpdateTrail",
      asset: "account-a",
      subject: "fixture",
      severity: "high",
      observedAt: "2026-01-01T00:00:00.000Z",
      evidenceIds: ["different"],
    },
  ]);
  assertEquals(outcome.techniques[0].metadata, [{
    name: `${signal} · ${triggeringAction}`,
    value: "1 distinct alert(s)",
  }]);
});
