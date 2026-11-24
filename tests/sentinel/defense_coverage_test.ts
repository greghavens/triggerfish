import { assertEquals, assertThrows } from "@std/assert";
import { assessSentinelDefenseCoverage } from "../../src/sentinel/defense_coverage.ts";

const observedAt = "2026-11-24T12:34:56.000Z";

Deno.test("Sentinel derives evidence references without asserting an attack occurred", () => {
  const assessment = assessSentinelDefenseCoverage({
    webContainmentConfigured: true,
    alerts: [
      {
        asset: "gateway",
        subject: "subject",
        type: "authentication_success_after_failures",
        severity: "high",
        observedAt,
        evidenceIds: ["1", "2", "3", "4", "5", "6"],
      },
      {
        asset: "workstation",
        subject: "process",
        type: "endpoint_execution_alert",
        severity: "high",
        observedAt,
        evidenceIds: ["host-alert"],
      },
    ],
  });
  assertEquals(assessment.webContainment.status, "configured");
  const byId = new Map(
    assessment.behaviors.map((behavior) => [behavior.id, behavior]),
  );
  const authentication = byId.get("credential_abuse")!;
  assertEquals(authentication.coverage, "direct_signals");
  assertEquals(authentication.evidenceStatus, "signals_observed");
  assertEquals(authentication.alertCount, 1);
  assertEquals(authentication.signals[1].records[0].sourceRecord, 1);
  const exploitation = byId.get("exploitation")!;
  assertEquals(exploitation.coverage, "indirect_signals");
  assertEquals(exploitation.signals[0].origin, "source_alert");
  assertEquals(exploitation.signals[0].records[0].evidenceIds, ["host-alert"]);
  assertEquals(byId.get("exfiltration")?.evidenceStatus, "none_observed");
  assertEquals(assessment.behaviors.length, 8);
});

Deno.test("Sentinel distinguishes no alert input from empty evidence", () => {
  const omitted = assessSentinelDefenseCoverage();
  const empty = assessSentinelDefenseCoverage({
    alerts: [],
    webContainmentConfigured: false,
  });
  assertEquals(omitted.webContainment.status, "unknown");
  assertEquals(empty.webContainment.status, "disabled");
  assertEquals(
    omitted.behaviors.every(({ evidenceStatus }) =>
      evidenceStatus === "not_provided"
    ),
    true,
  );
  assertEquals(
    empty.behaviors.every(({ evidenceStatus }) =>
      evidenceStatus === "none_observed"
    ),
    true,
  );
});

Deno.test("Sentinel coverage rejects malformed evidence", () => {
  assertThrows(
    () =>
      assessSentinelDefenseCoverage({
        alerts: [{ type: "sensitive_egress_alert" }],
      }),
    Error,
    "Invalid Sentinel alert at record 1",
  );
});
