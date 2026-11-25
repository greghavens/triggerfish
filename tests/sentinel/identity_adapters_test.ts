import { assessSentinelDefenseCoverage } from "../../src/sentinel/defense_coverage.ts";
import { decodeSentinelFeedLine } from "../../src/sentinel/feed_adapters.ts";
import { assertEquals, assertThrows } from "@std/assert";
import {
  adaptOktaSystemLogEvent,
  adaptWinlogbeatEvent,
  validateWinlogbeatPrivilegedGroups,
} from "../../src/sentinel/identity_adapters.ts";
import { createTelemetryDetector } from "../../src/sentinel/telemetry.ts";

const winlog = {
  "@timestamp": "2026-11-01T11:10:00.123456700Z",
  host: { name: "collector.example" },
  winlog: {
    event_id: "4625",
    record_id: "18446744073709551615",
    computer_name: "HOST-01.example",
    provider_name: "Microsoft-Windows-Security-Auditing",
    channel: "ForwardedEvents",
    event_data: {
      TargetUserName: "EXAMPLE-USER",
      TargetDomainName: "CONTOSO",
    },
  },
};

Deno.test("Winlogbeat adapter uses the forwarded origin and keeps lossless evidence IDs", () => {
  assertEquals(adaptWinlogbeatEvent(winlog), {
    version: 1,
    id: "winlog:4625:18446744073709551615:2026-11-01T11:10:00.123Z",
    asset: "host-01.example",
    timestamp: "2026-11-01T11:10:00.123Z",
    kind: "auth_failure",
    subject: "contoso\\example-user",
  });
  assertThrows(
    () =>
      adaptWinlogbeatEvent({
        ...winlog,
        winlog: { ...winlog.winlog, computer_name: undefined },
      }),
    Error,
    "originating computer",
  );
  assertEquals(
    adaptWinlogbeatEvent({
      ...winlog,
      winlog: {
        ...winlog.winlog,
        computer_name: undefined,
        channel: "Security",
        event_id: 4624,
      },
    })?.kind,
    "auth_success",
  );
});

Deno.test("Winlogbeat adapter recognizes audit clears and constrains provider and channel", () => {
  const clear = {
    ...winlog,
    winlog: {
      ...winlog.winlog,
      provider_name: "Microsoft-Windows-Eventlog",
      channel: "Security",
      event_id: 1102,
      event_data: undefined,
    },
  };
  const normalized = adaptWinlogbeatEvent(clear);
  const alerts = createTelemetryDetector().ingest(normalized);
  assertEquals(alerts.map((alert) => [alert.type, alert.subject]), [
    ["integrity_change", "windows-security-audit-log"],
  ]);

  assertEquals(alerts[0].triggeringAction, "winlog:1102");
  const unrelated = {
    ...alerts[0],
    triggeringAction: "winlog:4719:success-removed",
    evidenceIds: ["unrelated-audit-event"],
  };
  const coverage = assessSentinelDefenseCoverage({
    alerts: [...alerts, unrelated],
  })
    .upstreamChecks.find(({ id }) => id === "windows_security_log_cleared");
  assertEquals(coverage?.records.length, 1);
  assertEquals(coverage?.records[0].evidenceIds, alerts[0].evidenceIds);

  const full = createTelemetryDetector().ingest(adaptWinlogbeatEvent({
    ...clear,
    winlog: { ...clear.winlog, event_id: 1104 },
  }));
  assertEquals(full[0]?.triggeringAction, "winlog:1104");
  const fullCoverage = assessSentinelDefenseCoverage({
    alerts: [...alerts, ...full],
  })
    .upstreamChecks.find(({ id }) => id === "windows_security_log_full");
  assertEquals(fullCoverage?.records.map(({ evidenceIds }) => evidenceIds), [
    full[0].evidenceIds,
  ]);

  for (
    const changes of [
      { provider_name: "Other", event_id: 1102 },
      { provider_name: "Other", event_id: 1104 },
      { channel: "Application", event_id: 1104 },
      { provider_name: "Other", event_id: 1108 },
      { channel: "Application", event_id: 1108 },
      { channel: "Application" },
      { event_id: 4672 },
      { event_id: 1105 },
    ]
  ) {
    assertEquals(
      adaptWinlogbeatEvent({
        ...clear,
        winlog: { ...clear.winlog, ...changes },
      }),
      undefined,
    );
  }
});

Deno.test("Winlogbeat accepts documented Defender alerts from their provider and originating host", () => {
  const winlogRecord = {
    ...winlog.winlog,
    provider_name: "Microsoft-Windows-Windows Defender",
    channel: "ForwardedEvents",
    event_data: { Path: "private file", User: "private user" },
  };
  const detector = createTelemetryDetector();
  const observed = [];
  for (
    const eventId of [
      1116,
      1118,
      1119,
      1121,
      1123,
      1126,
      1127,
      5001,
      5013,
      5010,
      5012,
      5101,
      3002,
      5008,
    ]
  ) {
    const event = adaptWinlogbeatEvent({
      ...winlog,
      winlog: { ...winlogRecord, event_id: eventId },
    });
    const [alert] = detector.ingest(event);
    observed.push(alert);
    assertEquals(alert.asset, "host-01.example");
    assertEquals(
      alert.type,
      [5001, 5010, 5012, 5101].includes(eventId)
        ? "integrity_change"
        : eventId === 1126
        ? "network_security_alert"
        : "security_sensor_alert",
    );
    assertEquals(alert.severity, "high");
    assertEquals(
      alert.triggeringAction,
      `defender:${eventId}`,
    );
    assertEquals(JSON.stringify(event).includes("private"), false);
  }
  const checks =
    assessSentinelDefenseCoverage({ alerts: observed }).upstreamChecks;
  for (
    const [id, records] of [
      ["defender_network_block", [6]],
      ["defender_malware_detected", [1]],
      ["defender_remediation_failed", [2, 3]],
      ["defender_real_time_protection_disabled", [8]],
      ["defender_attack_surface_reduction_block", [4]],
      ["defender_controlled_folder_access_block", [5, 7]],
      ["defender_tamper_protection_block", [9]],
      ["defender_scanning_disabled", [10, 11]],
      ["defender_protection_expired", [12]],
      ["defender_protection_failure", [13, 14]],
    ] as const
  ) {
    assertEquals(
      checks.find((check) => check.id === id)?.records.map(({ sourceRecord }) =>
        sourceRecord
      ),
      [...records],
    );
  }
  for (
    const changes of [
      { event_id: 5013, channel: "Security" },
      { event_id: 5013, provider_name: "Other" },
      { event_id: 3002, channel: "Security" },
      { event_id: 5008, provider_name: "Other" },
      { channel: "Security" },
      { provider_name: "Other" },
      ...[1117, 1122, 1124, 1125, 1128, 3007, 5000, 5007, 5009, 5011, 5100].map(
        (
          event_id,
        ) => ({
          event_id,
        }),
      ),
    ]
  ) {
    assertEquals(
      adaptWinlogbeatEvent({
        ...winlog,
        winlog: { ...winlogRecord, event_id: 1116, ...changes },
      }),
      undefined,
    );
  }
  assertEquals(
    adaptWinlogbeatEvent({
      ...winlog,
      winlog: {
        ...winlogRecord,
        event_id: 1116,
        channel: "Microsoft-Windows-Windows Defender/Operational",
      },
    })?.kind,
    "security_sensor_alert",
  );
});

Deno.test("Winlogbeat ingests Windows exploit-protection blocks with provider and channel validation", () => {
  const provider = "Microsoft-Windows-Security-Mitigations";
  const direct = "Microsoft-Windows-Security-Mitigations/UserMode";
  const record = (
    event_id: number,
    channel = direct,
    provider_name = provider,
  ) =>
    JSON.stringify({
      ...winlog,
      winlog: {
        ...winlog.winlog,
        event_id,
        channel,
        provider_name,
        event_data: { ProcessPath: "private application" },
      },
    });
  const detector = createTelemetryDetector();
  for (let id = 1; id <= 24; id++) {
    const data = decodeSentinelFeedLine(record(id), "winlogbeat");
    if (id % 2) {
      assertEquals(data, []);
      continue;
    }
    const [alert] = detector.ingest(data[0]);
    assertEquals(alert.asset, "host-01.example");
    assertEquals(alert.type, "security_sensor_alert");
    assertEquals(alert.severity, "high");
    assertEquals(alert.triggeringAction, `winlog:mitigation:${id}`);
    assertEquals(
      assessSentinelDefenseCoverage({ alerts: [alert] }).upstreamChecks
        .find(({ id }) => id === "windows_exploit_protection_block")
        ?.records[0].evidenceIds,
      alert.evidenceIds,
    );
    assertEquals(JSON.stringify(data).includes("private"), false);
  }
  assertEquals(decodeSentinelFeedLine(record(2, "Security"), "winlogbeat"), []);
  assertEquals(
    decodeSentinelFeedLine(record(2, direct, "Other"), "winlogbeat"),
    [],
  );
  const [forwarded] = decodeSentinelFeedLine(
    record(22, "ForwardedEvents"),
    "winlogbeat",
  );
  assertEquals(
    detector.ingest(forwarded)[0].subject,
    "windows-exploit-protection:caller-check",
  );
});

Deno.test("Winlogbeat identifies CFG and untrusted font records on their documented channels", () => {
  const record = (
    event_id: number,
    provider_name: string,
    channel: string,
    Blocked: unknown = "true",
  ) =>
    decodeSentinelFeedLine(
      JSON.stringify({
        ...winlog,
        winlog: {
          ...winlog.winlog,
          event_id,
          provider_name,
          channel,
          event_data: { Blocked },
        },
      }),
      "winlogbeat",
    );
  const wer = "Microsoft-Windows-WER-Diag";
  const font = "Microsoft-Windows-Win32k";
  const detector = createTelemetryDetector();
  for (
    const [event, provider, channel, subject] of [
      [5, wer, `${wer}/Operational`, "control-flow-guard"],
      [260, font, `${font}/Operational`, "untrusted-font"],
      [260, "Win32k", "ForwardedEvents", "untrusted-font"],
    ] as const
  ) {
    const [alert] = detector.ingest(record(event, provider, channel)[0]);
    assertEquals(alert.subject, `windows-exploit-protection:${subject}`);
    assertEquals(alert.asset, "host-01.example");
    const unrelated = { ...alert, triggeringAction: "defender:1116" };
    const coverage = assessSentinelDefenseCoverage({
      alerts: [alert, unrelated],
    })
      .upstreamChecks.find(({ id }) =>
        id === "windows_exploit_protection_block"
      );
    assertEquals(coverage?.records.length, 1);
    assertEquals(coverage?.records[0].evidenceIds, alert.evidenceIds);
  }
  assertEquals(record(5, wer, "Security"), []);
  assertEquals(record(2, wer, `${wer}/Operational`), []);
  assertEquals(record(260, font, `${font}/Messages`), []);
  assertEquals(record(5, font, "ForwardedEvents"), []);
  assertEquals(record(260, font, `${font}/Operational`, "false"), []);
  assertEquals(record(260, font, "ForwardedEvents", null), []);
});

Deno.test("Winlogbeat surfaces reduced audit coverage and ignores additions and lookalikes", () => {
  const record = (
    AuditPolicyChanges: string,
    provider_name = "Microsoft-Windows-Security-Auditing",
    record_id = 1049418,
  ) =>
    adaptWinlogbeatEvent({
      ...winlog,
      winlog: {
        ...winlog.winlog,
        event_id: 4719,
        record_id,
        provider_name,
        event_data: {
          AuditPolicyChanges,
          SubcategoryGuid: "{0CCE9223-69AE-11D9-BED3-505054503030}",
          SubjectUserName: "private account",
        },
      },
    });
  const detector = createTelemetryDetector();
  const events = [
    record("%%8448, %%8450"),
    record("%%8448", undefined, 1049419),
    record("%%8450", undefined, 1049420),
  ];
  const alerts = [...events, events[0]].flatMap(detector.ingest);
  const policy = assessSentinelDefenseCoverage({ alerts })
    .upstreamChecks
    .find(({ id }) => id === "windows_auditing_removed");
  assertEquals(
    policy?.records.map(({ asset, evidenceIds }) => [asset, evidenceIds]),
    alerts.map((alert) => ["host-01.example", alert.evidenceIds]),
  );
  assertEquals(
    alerts.map((alert) => alert.type),
    ["integrity_change", "integrity_change", "integrity_change"],
  );
  assertEquals(
    alerts.map((alert) => alert.triggeringAction),
    [
      "winlog:4719:success-and-failure-removed",
      "winlog:4719:success-removed",
      "winlog:4719:failure-removed",
    ],
  );
  assertEquals(
    alerts.map((alert) => alert.subject),
    alerts.map(() =>
      "windows-audit-policy:0cce9223-69ae-11d9-bed3-505054503030"
    ),
  );
  assertEquals(JSON.stringify(events).includes("private"), false);
  assertEquals(
    record("Failure removed, Success added")?.action,
    "winlog:4719:failure-removed",
  );
  for (const value of ["%%8449, %%8451", "%%84480", "not Success removed"]) {
    assertEquals(record(value), undefined);
  }
  assertEquals(record("%%8448", "Unrelated"), undefined);
});

Deno.test("Winlogbeat maps scheduled task creation and update without retaining task definitions", () => {
  const record = (
    event_id: number,
    record_id: number,
    contentField: string,
  ) => ({
    ...winlog,
    winlog: {
      ...winlog.winlog,
      event_id,
      record_id,
      event_data: {
        TaskName: "\\private-task-path",
        [contentField]:
          "<Task><Actions><Exec><Command>private-command</Command></Exec></Actions></Task>",
        SubjectUserName: "private-account",
      },
    },
  });
  const created = record(4698, 2, "TaskContent");
  const updated = record(4702, 3, "TaskContentNew");
  const decode = (row: object) =>
    decodeSentinelFeedLine(JSON.stringify(row), "winlogbeat");
  const events = [created, updated, updated].flatMap(decode);
  const alerts = events.flatMap(createTelemetryDetector().ingest);
  assertEquals(alerts.map(({ triggeringAction }) => triggeringAction), [
    "winlog:4698",
    "winlog:4702",
  ]);
  assertEquals(alerts.map(({ subject }) => subject), [
    "windows-scheduled-task",
    "windows-scheduled-task",
  ]);
  const coverage = assessSentinelDefenseCoverage({ alerts });
  assertEquals(
    coverage.upstreamChecks.find(({ id }) =>
      id === "windows_scheduled_task_created_or_updated"
    )?.records.map(({ asset, evidenceIds }) => [asset, evidenceIds]),
    [
      ["host-01.example", ["winlog:4698:2:2026-11-01T11:10:00.123Z"]],
      ["host-01.example", ["winlog:4702:3:2026-11-01T11:10:00.123Z"]],
    ],
  );
  assertEquals(
    JSON.stringify({ events, alerts, coverage }).includes("private-"),
    false,
  );
  for (
    const changes of [
      { event_id: "4699" },
      { event_id: "4700" },
      { event_id: "4701" },
      { provider_name: "Unrelated" },
      { channel: "Application" },
    ]
  ) {
    assertEquals(
      decode({ ...created, winlog: { ...created.winlog, ...changes } }),
      [],
    );
  }
});

Deno.test("Winlogbeat outbound firewall denials use canonical destinations and the existing burst rule", () => {
  const detector = createTelemetryDetector();
  const record = (
    record_id: number,
    Direction = "%%14593",
    DestAddress = "2001:0db8::1234",
  ) =>
    decodeSentinelFeedLine(
      JSON.stringify({
        ...winlog,
        winlog: {
          ...winlog.winlog,
          event_id: 5157,
          record_id,
          event_data: { Direction, DestAddress, Application: "private path" },
        },
      }),
      "winlogbeat",
    );
  assertEquals(record(10, "%%14592"), []);
  assertEquals(record(10, "Inbound"), []);
  assertEquals(record(10, "%%14593", "unknown host"), []);
  assertEquals(record(10, "%%14593", "fe80::1%eth0"), []);
  for (let index = 0; index < 4; index++) {
    const [event] = record(index);
    assertEquals(JSON.stringify(event).includes("private"), false);
    assertEquals(detector.ingest(event), []);
  }
  assertEquals(detector.ingest(record(3)[0]), []);
  const [alert] = detector.ingest(record(4, "Outbound", "2001:db8::1234")[0]);
  assertEquals(alert.type, "egress_denied_burst");
  assertEquals(alert.asset, "host-01.example");
  assertEquals(alert.subject, "2001:db8::1234");
  assertEquals(alert.evidenceIds.length, 5);
});

Deno.test("Winlogbeat reports privileged group additions by SID irrespective of group name", () => {
  const detector = createTelemetryDetector();
  const alerts = [];
  for (
    const [index, [event_id, TargetSid, subject]] of [
      [4732, "S-1-5-32-544", "windows-builtin-administrators"],
      [4728, "S-1-5-21-1-2-3-512", "windows-domain-admins"],
      [4756, "S-1-5-21-1-2-3-518", "windows-schema-admins"],
      [4756, "S-1-5-21-1-2-3-519", "windows-enterprise-admins"],
      [4732, "S-1-5-32-545", undefined],
      [4732, "S-1-5-21-1-2-3-512", undefined],
      [4728, "S-1-5-21-1-2-3-1512", undefined],
    ].entries()
  ) {
    const event = adaptWinlogbeatEvent({
      ...winlog,
      winlog: {
        ...winlog.winlog,
        event_id,
        record_id: index,
        event_data: { TargetSid, TargetUserName: "Administrators" },
      },
    });
    if (!subject) {
      assertEquals(event, undefined);
      continue;
    }
    const [alert] = detector.ingest(event);
    alerts.push(alert);
    assertEquals([
      alert.subject,
      alert.type,
      alert.asset,
      alert.triggeringAction,
    ], [
      subject,
      "unexpected_privilege_grant",
      "host-01.example",
      `winlog:${event_id}`,
    ]);
  }
  const check = assessSentinelDefenseCoverage({ alerts }).upstreamChecks.find(
    ({ id }) => id === "windows_privileged_group_grant",
  );
  assertEquals(check?.records.map(({ sourceRecord }) => sourceRecord), [
    1,
    2,
    3,
    4,
  ]);
});

Deno.test("Winlogbeat feed matches operator-defined groups by exact configured SID", () => {
  const sid = "S-1-5-21-1-2-3-2100";
  const groups = validateWinlogbeatPrivilegedGroups([sid]);
  const raw = (TargetSid: string) =>
    JSON.stringify({
      ...winlog,
      winlog: {
        ...winlog.winlog,
        event_id: 4728,
        event_data: { TargetSid },
      },
    });
  assertEquals(decodeSentinelFeedLine(raw(sid), "winlogbeat"), []);
  assertEquals(
    decodeSentinelFeedLine(
      raw(sid + "0"),
      "winlogbeat",
      undefined,
      undefined,
      { privilegedGroups: groups },
    ),
    [],
  );
  const [record] = decodeSentinelFeedLine(
    raw(sid),
    "winlogbeat",
    undefined,
    undefined,
    { privilegedGroups: groups },
  );
  const [alert] = createTelemetryDetector().ingest(record);
  assertEquals(alert.subject, `windows-privileged-group:${sid}`);
  assertEquals(alert.type, "unexpected_privilege_grant");
  for (
    const invalid of [[sid, sid], ["Administrators"], ["S-1-5-4294967296"]]
  ) {
    assertThrows(() => validateWinlogbeatPrivilegedGroups(invalid));
  }
});

const okta = {
  eventType: "user.session.start",
  outcome: { result: "FAILURE" },
  actor: { id: "00uExample", type: "User" },
  uuid: "dc9fd3c0-598c-11ef-8478-2b7584bf8d5a",
  published: "2026-11-01T11:10:00Z",
};

Deno.test("Okta adapter scopes authentication records to the provided tenant", () => {
  assertEquals(adaptOktaSystemLogEvent(okta, "tenant-a"), {
    version: 1,
    id: "okta:dc9fd3c0-598c-11ef-8478-2b7584bf8d5a",
    asset: "tenant-a",
    timestamp: "2026-11-01T11:10:00.000Z",
    kind: "auth_failure",
    subject: "00uExample",
  });
  assertEquals(
    adaptOktaSystemLogEvent(
      { ...okta, outcome: { result: "SUCCESS" } },
      "tenant-b",
    )?.kind,
    "auth_success",
  );

  for (
    const changes of [
      { actor: { id: "unknown", type: "User" } },
      { actor: { id: "some-app", type: "AppInstance" } },
      { eventType: "user.session.end" },
      { outcome: { result: "UNKNOWN" } },
    ]
  ) {
    assertEquals(
      adaptOktaSystemLogEvent({ ...okta, ...changes }, "tenant-a"),
      undefined,
    );
  }

  assertThrows(
    () =>
      adaptOktaSystemLogEvent({
        ...okta,
        published: "2026-02-30T00:00:00Z",
      }, "tenant-a"),
    Error,
    "calendar timestamp",
  );
});

Deno.test("Sentinel correlates source events across an Okta authentication burst", () => {
  const detector = createTelemetryDetector();
  for (let i = 0; i < 5; i++) {
    detector.ingest(adaptOktaSystemLogEvent({
      ...okta,
      uuid: `failure-${i}`,
    }, "tenant-a"));
  }
  const alerts = detector.ingest(adaptOktaSystemLogEvent({
    ...okta,
    uuid: "success",
    outcome: { result: "SUCCESS" },
  }, "tenant-a"));
  assertEquals(alerts.map((alert) => alert.type), [
    "authentication_success_after_failures",
  ]);
  assertEquals(alerts[0].evidenceIds.length, 6);
});

Deno.test("Windows clock-change coverage excludes Local Service and malformed principals", () => {
  const audit = {
    ...winlog,
    winlog: { ...winlog.winlog, event_id: 4616 },
  };
  for (const sid of [undefined, "S-1-5-19", "malformed"]) {
    assertEquals(
      adaptWinlogbeatEvent({
        ...audit,
        winlog: { ...audit.winlog, event_data: { SubjectUserSid: sid } },
      }),
      undefined,
    );
  }
  const accepted = adaptWinlogbeatEvent({
    ...audit,
    winlog: {
      ...audit.winlog,
      event_data: { SubjectUserSid: "S-1-5-21-111-222-333-1001" },
    },
  });
  assertEquals(accepted?.subject, "windows-system-clock");
  assertEquals(accepted?.action, "winlog:4616");
  assertEquals(JSON.stringify(accepted).includes("S-1-5-21"), false);
});

Deno.test("Winlogbeat normalizes service installations without retaining service arguments", () => {
  const event = {
    ...winlog,
    winlog: {
      ...winlog.winlog,
      event_id: 4697,
      channel: "Security",
      event_data: { ServiceFileName: "private-fixture-service-arguments" },
    },
  };
  const record = adaptWinlogbeatEvent(event);
  assertEquals(record?.kind, "integrity_change");
  assertEquals(record?.subject, "windows-service-installation");
  assertEquals(record?.action, "winlog:4697");
  assertEquals(JSON.stringify(record).includes("private-fixture"), false);
  assertEquals(
    adaptWinlogbeatEvent({
      ...event,
      winlog: { ...event.winlog, provider_name: "Service Control Manager" },
    }),
    undefined,
  );
  assertEquals(
    adaptWinlogbeatEvent({
      ...event,
      winlog: { ...event.winlog, channel: "System" },
    }),
    undefined,
  );
});
