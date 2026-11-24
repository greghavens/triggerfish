import { parseSentinelTelemetryAlert } from "../../src/sentinel/case_report.ts";
import { assessSentinelDefenseCoverage } from "../../src/sentinel/defense_coverage.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { decodeSentinelFeedLine } from "../../src/sentinel/feed_adapters.ts";
import { adaptEntraEvent } from "../../src/sentinel/entra_adapter.ts";
import { createTelemetryDetector } from "../../src/sentinel/telemetry.ts";

const tenant = "6a7295bf-7903-4e0b-9199-8bfb3bdc92ac";
const user = "b55c76c5-979f-440c-91a9-a8f4fa32f5ae";
const signInId = "abfd77a8-8f36-4c6b-873d-b765d488c903";
const event = {
  category: "SignInLogs",
  time: "2026-11-01T11:10:00.1234567Z",
  tenantId: tenant.toUpperCase(),
  resultType: "0",
  correlationId: "cf36e942-ac5d-4a30-81cc-31f7e62876a5",
  properties: {
    id: signInId,
    userId: user.toUpperCase(),
    isInteractive: true,
    status: { errorCode: 0 },
  },
};

Deno.test("Entra adapter preserves tenant, principal, and sign-in evidence", () => {
  assertEquals(adaptEntraEvent(event), {
    version: 1,
    id: `entra:${signInId}`,
    timestamp: "2026-11-01T11:10:00.123Z",
    asset: tenant,
    subject: user,
    kind: "auth_success",
  });
  const next = adaptEntraEvent({
    ...event,
    properties: {
      ...event.properties,
      id: "abfd77a8-8f36-4c6b-873d-b765d488c904",
    },
  });
  assertEquals(next?.id, "entra:abfd77a8-8f36-4c6b-873d-b765d488c904");
});

Deno.test("Entra adapter accepts either documented numeric sign-in outcome", () => {
  assertEquals(
    adaptEntraEvent({
      ...event,
      properties: { ...event.properties, status: undefined },
      resultType: 50074,
    })?.kind,
    "auth_failure",
  );
  assertEquals(
    adaptEntraEvent({
      ...event,
      resultType: undefined,
      properties: { ...event.properties, status: { errorCode: 500121 } },
    })?.kind,
    "auth_failure",
  );
  assertThrows(
    () => adaptEntraEvent({ ...event, resultType: "50074" }),
    Error,
    "Conflicting",
  );
  assertThrows(
    () => adaptEntraEvent({ ...event, resultType: "FAILED" }),
    Error,
    "Invalid Entra sign-in result code",
  );
});

Deno.test("Entra adapter excludes background flows and requires UTC tenant-scoped evidence", () => {
  assertEquals(
    adaptEntraEvent({ category: "NonInteractiveUserSignInLogs" }),
    undefined,
  );
  assertEquals(
    adaptEntraEvent({
      ...event,
      properties: { ...event.properties, isInteractive: false },
    }),
    undefined,
  );
  assertEquals(
    adaptEntraEvent({
      ...event,
      properties: {
        ...event.properties,
        userId: "00000000-0000-0000-0000-000000000000",
      },
    }),
    undefined,
  );
  assertThrows(
    () => adaptEntraEvent({ ...event, tenantId: undefined }),
    Error,
    "tenant GUID",
  );
  assertThrows(
    () => adaptEntraEvent({ ...event, time: "2026-02-31T12:00:00Z" }),
    Error,
    "calendar timestamp",
  );
});

Deno.test("Sentinel keeps Entra authentication observations separated by tenant", () => {
  const detector = createTelemetryDetector();
  for (let i = 0; i < 5; i++) {
    detector.ingest(adaptEntraEvent({
      ...event,
      resultType: "50126",
      properties: {
        ...event.properties,
        id: `abfd77a8-8f36-4c6b-873d-b765d488c90${i}`,
        status: { errorCode: 50126 },
      },
    }));
  }

  assertEquals(
    detector.ingest(adaptEntraEvent({
      ...event,
      tenantId: "7cd37db3-213b-43c5-be92-c322ab2e92f7",
    })),
    [],
  );
  const alerts = detector.ingest(adaptEntraEvent({
    ...event,
    properties: {
      ...event.properties,
      id: "abfd77a8-8f36-4c6b-873d-b765d488c905",
    },
  }));
  assertEquals(alerts.map((alert) => alert.asset), [tenant]);
  assertEquals(alerts[0].evidenceIds.length, 6);
});

Deno.test("Entra workload sign-ins correlate independently from interactive users", () => {
  const detector = createTelemetryDetector();
  const workload = {
    category: "ServicePrincipalSignInLogs",
    tenantId: tenant,
    time: event.time,
    resultType: "Failure",
    properties: {
      id: signInId,
      servicePrincipalId: user,
      status: { errorCode: 7000215 },
    },
  };
  for (let index = 0; index < 5; index++) {
    const normalized = adaptEntraEvent({
      ...workload,
      properties: {
        ...workload.properties,
        id: `abfd77a8-8f36-4c6b-873d-b765d488c90${index}`,
      },
    });
    assertEquals(normalized?.subject, "service-principal:" + user);
    detector.ingest(normalized);
  }
  assertEquals(detector.ingest(adaptEntraEvent(event)), []);
  const success = {
    ...workload,
    resultType: "Success",
    properties: {
      ...workload.properties,
      id: "abfd77a8-8f36-4c6b-873d-b765d488c905",
      status: { errorCode: 0 },
    },
  };
  const managed = adaptEntraEvent({
    ...success,
    category: "ManagedIdentitySignInLogs",
  });
  assertEquals(managed?.subject, "managed-identity:" + user);
  assertEquals(
    managed?.id,
    "entra:managed-identity:abfd77a8-8f36-4c6b-873d-b765d488c905",
  );
  assertEquals(detector.ingest(managed), []);
  assertEquals(
    adaptEntraEvent({ ...success, category: "AADManagedIdentitySignInLogs" }),
    managed,
  );
  const alerts = detector.ingest(adaptEntraEvent(success));
  assertEquals(
    alerts.map(({ type, subject, asset }) => ({ type, subject, asset })),
    [{
      type: "authentication_success_after_failures",
      subject: "service-principal:" + user,
      asset: tenant,
    }],
  );
  assertThrows(
    () => adaptEntraEvent({ ...workload, resultType: "Success" }),
    Error,
    "Conflicting",
  );
});

Deno.test("Log Analytics rows use the Entra tenant and match equivalent diagnostic events", () => {
  const row = {
    Type: "AADManagedIdentitySignInLogs",
    AadTenantId: "ignored",
    AADTenantId: tenant,
    TenantId: "7cd37db3-213b-43c5-be92-c322ab2e92f7",
    CreatedDateTime: event.time,
    TimeGenerated: "2026-11-01T11:11:00Z",
    ResultType: "Success",
    Id: signInId,
    ServicePrincipalId: user,
  };
  const managed = adaptEntraEvent({
    category: "ManagedIdentitySignInLogs",
    tenantId: tenant,
    time: event.time,
    resultType: "Success",
    properties: { id: signInId, servicePrincipalId: user },
  });
  assertEquals(adaptEntraEvent(row), managed);
  assertEquals(
    adaptEntraEvent({
      ...row,
      Type: "SigninLogs",
      ResultType: "0",
      UserId: user,
      IsInteractive: true,
    }),
    adaptEntraEvent(event),
  );
  assertThrows(
    () => adaptEntraEvent({ ...row, AADTenantId: undefined }),
    Error,
    "tenant GUID",
  );
});

Deno.test("Entra audit role grants retain the grantee and require explicit success", () => {
  const unit = "3d5a8925-8710-4195-b2b9-af9d70750f2b";
  const targets = [
    { type: "User", id: user },
    {
      type: "Role",
      id: tenant.toUpperCase(),
      displayName: "private-role-label",
    },
    { type: "AdministrativeUnit", id: unit },
    { type: "AdministrativeUnit", id: "invalid-id" },
    { type: "AdministrativeUnit", id: unit.toUpperCase() },
    { type: "Application", id: unit },
  ];
  const diagnostic = {
    category: "AuditLogs",
    tenantId: tenant,
    time: event.time,
    resultType: "Success",
    properties: {
      id: "Directory_audit-123",
      activityDisplayName: "Add member to role",
      result: "success",
      targetResources: targets,
    },
  };
  const record = adaptEntraEvent(diagnostic);
  assertEquals(record, {
    version: 1,
    id: "entra:audit:Directory_audit-123",
    timestamp: "2026-11-01T11:10:00.123Z",
    asset: tenant,
    subject: user,
    kind: "unexpected_privilege_grant",
    action: "entra.directory_role.add_member",
    entraRoleGrant: { roleIds: [tenant], administrativeUnitIds: [unit] },
  });
  assertEquals(
    adaptEntraEvent({
      Type: "AuditLogs",
      AADTenantId: tenant,
      Id: diagnostic.properties.id,
      ActivityDisplayName: diagnostic.properties.activityDisplayName,
      ActivityDateTime: event.time,
      TargetResources: targets,
      Result: "success",
    }),
    record,
  );
  assertEquals(
    adaptEntraEvent({ ...diagnostic, resultType: "Failure" }),
    undefined,
  );
  assertEquals(
    adaptEntraEvent({
      ...diagnostic,
      properties: {
        ...diagnostic.properties,
        activityDisplayName: "Add eligible member to role",
      },
    }),
    undefined,
  );
  const detector = createTelemetryDetector();
  const grants = [
    ["Add member to role", "entra.directory_role.add_member"],
    ["Add scoped member to role", "entra.directory_role.add_scoped_member"],
    [
      "Add member to role scoped over Restricted Management Administrative Unit",
      "entra.directory_role.add_restricted_scope_member",
    ],
  ];
  const alerts = grants.flatMap(([activityDisplayName], index) =>
    decodeSentinelFeedLine(
      JSON.stringify({
        ...diagnostic,
        properties: {
          ...diagnostic.properties,
          id: `Directory_${index}`,
          activityDisplayName,
        },
      }),
      "entra",
    ).flatMap((row) => detector.ingest(row))
  );
  assertEquals(
    alerts.map(({ triggeringAction }) => triggeringAction),
    grants.map(([, action]) => action),
  );
  assertEquals(
    alerts.map((alert) =>
      parseSentinelTelemetryAlert(JSON.parse(JSON.stringify(alert)), 1)
        .entraRoleGrant
    ),
    alerts.map(() => ({ roleIds: [tenant], administrativeUnitIds: [unit] })),
  );
  assertEquals(JSON.stringify(alerts).includes("private-role-label"), false);
  assertThrows(() =>
    parseSentinelTelemetryAlert({
      ...alerts[0],
      triggeringAction: "winlog:4728",
    }, 1)
  );
  assertThrows(() =>
    parseSentinelTelemetryAlert({
      ...alerts[0],
      entraRoleGrant: { roleIds: ["private"], administrativeUnitIds: [] },
    }, 1)
  );
  const check = assessSentinelDefenseCoverage({
    alerts: [...alerts, {
      ...alerts[0],
      triggeringAction: "winlog:4728",
      entraRoleGrant: undefined,
    }],
  }).upstreamChecks.find(({ id }) => id === "entra_directory_role_granted");
  assertEquals(
    check?.records.map(({ evidenceIds }) => evidenceIds),
    alerts.map(({ evidenceIds }) => evidenceIds),
  );
});

Deno.test("Entra feed emits separate stable evidence for each grantee", () => {
  const roleId = "15d58fb7-624c-47e6-8c10-a900f573bd11";
  const templateId = "3d5a8925-8710-4195-b2b9-af9d70750f2b";
  const targets = [{
    type: "User",
    id: user,
    modifiedProperties: [
      {
        displayName: "Role.ObjectID",
        newValue: JSON.stringify(roleId.toUpperCase()),
      },
      { displayName: "Role.TemplateId", newValue: "'" + templateId + "'" },
      { displayName: "Role.DisplayName", newValue: "private-role-name" },
      {
        displayName: "Role.ObjectID",
        oldValue: tenant,
        newValue: "invalid-id",
      },
      { displayName: "Role.ObjectID", newValue: JSON.stringify([tenant]) },
    ],
  }, { type: "Group", id: tenant }];
  const row = {
    Type: "AuditLogs",
    AADTenantId: tenant,
    Id: "Directory_multiple",
    ActivityDisplayName: "Add member to role",
    ActivityDateTime: event.time,
    TargetResources: [...targets, targets[0]],
    Result: "success",
  };
  const events = decodeSentinelFeedLine(
    JSON.stringify({ records: [row] }),
    "entra",
  );
  assertEquals(events.length, 2);
  const detector = createTelemetryDetector();
  const alerts = events.flatMap((value) => detector.ingest(value));
  const grant = {
    roleIds: [],
    administrativeUnitIds: [],
    modifiedRoleIds: [roleId],
    modifiedRoleTemplateIds: [templateId],
  };
  assertEquals(alerts[0].entraRoleGrant, grant);
  assertEquals(alerts[1].entraRoleGrant, undefined);
  assertEquals(
    parseSentinelTelemetryAlert(JSON.parse(JSON.stringify(alerts[0])), 1)
      .entraRoleGrant,
    grant,
  );
  assertEquals(JSON.stringify(alerts).includes("private-role-name"), false);
  assertEquals(alerts.map(({ subject }) => subject), [user, "group:" + tenant]);
  assertEquals(
    new Set(alerts.flatMap(({ evidenceIds }) => evidenceIds)).size,
    2,
  );
  assertEquals(
    decodeSentinelFeedLine(
      JSON.stringify({
        ...row,
        TargetResources: [...row.TargetResources].reverse(),
      }),
      "entra",
    ),
    events,
  );
});

const registeredDevice = "eab73519-780d-4d43-be6d-a4a89af2a348";
const anotherTenant = "7cd37db3-213b-43c5-be92-c322ab2e92f7";

function deviceFailure(
  index: number,
  deviceId: string | undefined,
  reportedTenant = tenant,
) {
  const suffix = index.toString(16).padStart(2, "0");
  return {
    ...event,
    tenantId: reportedTenant,
    time: `2026-11-01T11:10:${String(index).padStart(2, "0")}Z`,
    resultType: "50126",
    properties: {
      ...event.properties,
      id: signInId.slice(0, -2) + suffix,
      userId: user.slice(0, -2) + suffix,
      status: { errorCode: 50126 },
      ipAddress: "192.0.2.45",
      deviceDetail: { deviceId, displayName: "private device name" },
    },
  };
}

Deno.test("Entra uses the same pseudonymous registered device source across export formats", () => {
  const diagnostic = deviceFailure(1, registeredDevice.toUpperCase());
  const table = {
    Type: "SigninLogs",
    AADTenantId: tenant.toUpperCase(),
    TenantId: anotherTenant,
    TimeGenerated: diagnostic.time,
    Id: diagnostic.properties.id,
    UserId: diagnostic.properties.userId,
    ResultType: diagnostic.resultType,
    IsInteractive: true,
    DeviceDetail: {
      deviceId: registeredDevice,
      displayName: "private device name",
    },
    IPAddress: "198.51.100.8",
  };
  const result = adaptEntraEvent(diagnostic);
  assertEquals(adaptEntraEvent(table), result);
  assertEquals(
    /^source:[0-9a-f]{64}$/.test(result?.sourceReference ?? ""),
    true,
  );
  const encoded = JSON.stringify(result);
  for (
    const raw of [
      registeredDevice,
      "192.0.2.45",
      "198.51.100.8",
      "private device name",
    ]
  ) {
    assertEquals(encoded.includes(raw), false, raw);
  }
});

Deno.test("Entra only supplies device source references for supported interactive records", () => {
  for (
    const device of [
      undefined,
      "",
      "00000000-0000-0000-0000-000000000000",
      "192.0.2.45",
    ]
  ) {
    const failure = adaptEntraEvent(deviceFailure(1, device));
    assertEquals(failure?.kind, "auth_failure");
    assertEquals(failure?.sourceReference, undefined);
  }
  const successful = adaptEntraEvent({
    ...event,
    properties: {
      ...event.properties,
      deviceDetail: { deviceId: registeredDevice },
    },
  });
  assertEquals(successful?.kind, "auth_success");
  assertEquals(
    successful?.sourceReference,
    adaptEntraEvent(deviceFailure(1, registeredDevice))?.sourceReference,
  );

  const diagnostic = deviceFailure(2, registeredDevice);
  const workload = adaptEntraEvent({
    ...diagnostic,
    category: "ServicePrincipalSignInLogs",
    properties: {
      ...diagnostic.properties,
      isInteractive: false,
      servicePrincipalId: user,
    },
  });
  assertEquals(workload?.kind, "auth_failure");
  assertEquals(workload?.sourceReference, undefined);
});

Deno.test("Entra replays one successful same-device sign-in to an account cited in a recent fan-out", () => {
  const failures = [1, 2, 3, 4, 5].map((index) =>
    deviceFailure(index, registeredDevice)
  );
  const success = {
    ...deviceFailure(12, registeredDevice),
    resultType: "0",
    properties: {
      ...deviceFailure(12, registeredDevice).properties,
      userId: failures[0].properties.userId,
      status: { errorCode: 0 },
    },
  };
  const fixtures = [
    { ...success, properties: { ...success.properties, userId: user } },
    { ...success, tenantId: anotherTenant },
    {
      ...success,
      properties: {
        ...success.properties,
        deviceDetail: { deviceId: undefined },
      },
    },
    {
      ...success,
      properties: {
        ...success.properties,
        deviceDetail: { deviceId: anotherTenant },
      },
    },
    { ...success, time: failures[4].time },
    { ...success, time: "2026-11-01T11:15:01Z" },
  ];
  const decode = (records: readonly unknown[]) =>
    decodeSentinelFeedLine(
      JSON.stringify({ records }),
      "entra",
    ).flatMap(createTelemetryDetector().ingest);
  for (const benign of fixtures) {
    assertEquals(decode([...failures, benign]).map(({ type }) => type), [
      "authentication_failure_fanout",
    ]);
  }
  const [fanoutAlert, followUp] = decode([
    ...failures,
    deviceFailure(6, registeredDevice),
    success,
    success,
    {
      ...success,
      properties: {
        ...success.properties,
        id: deviceFailure(13, registeredDevice).properties.id,
      },
    },
  ]).map(parseSentinelTelemetryAlert);
  assertEquals(followUp.type, "authentication_success_after_fanout");
  assertEquals(followUp.subject, success.properties.userId);
  assertEquals(followUp.sourceReference, fanoutAlert.sourceReference);
  assertEquals(followUp.evidenceIds, [
    ...fanoutAlert.evidenceIds,
    `entra:${success.properties.id}`,
  ]);
  assertEquals(JSON.stringify(followUp).includes(registeredDevice), false);
});

Deno.test("Entra feed replay correlates five account failures from the same device within one tenant", () => {
  const anotherDevice = "eab73519-780d-4d43-be6d-a4a89af2a349";
  const final = deviceFailure(8, registeredDevice);
  const records = [
    deviceFailure(1, registeredDevice),
    deviceFailure(2, registeredDevice),
    deviceFailure(3, registeredDevice),
    deviceFailure(4, registeredDevice),
    deviceFailure(5, registeredDevice, anotherTenant),
    deviceFailure(6, anotherDevice),
    deviceFailure(7, undefined),
    final,
    final,
  ];
  const same = adaptEntraEvent(records[0])?.sourceReference;
  for (const index of [4, 5, 6]) {
    assertEquals(
      adaptEntraEvent(records[index])?.sourceReference === same,
      false,
    );
  }

  const normalized = decodeSentinelFeedLine(
    JSON.stringify({ records }),
    "entra",
  );
  const alerts = normalized.flatMap(createTelemetryDetector().ingest);
  assertEquals(alerts.length, 1);
  const alert = parseSentinelTelemetryAlert(alerts[0], 1);
  assertEquals(alert.type, "authentication_failure_fanout");
  assertEquals(alert.asset, tenant);
  assertEquals(alert.sourceReference, same);
  assertEquals(
    alert.evidenceIds,
    [...records.slice(0, 4), final].map(({ properties }) =>
      `entra:${properties.id}`
    ),
  );
});

const policyId = "15d58fb7-624c-47e6-8c10-a900f573bd11";
const auditActions = [
  [
    "Update Conditional Access policy",
    "entra.conditional_access.policy_update",
  ],
  [
    "Delete Conditional Access policy",
    "entra.conditional_access.policy_delete",
  ],
  ["Authentication Methods Policy Reset", "entra.authentication.methods_reset"],
  [
    "Authentication Methods Policy Update",
    "entra.authentication.methods_update",
  ],
  [
    "Authentication Strength Policy Delete",
    "entra.authentication.strength_delete",
  ],
  [
    "Authentication Strength Policy Update",
    "entra.authentication.strength_update",
  ],
  ["Update security defaults", "entra.authentication.security_defaults_update"],
] as const;

function policyAudit(index = 0) {
  return {
    category: "AuditLogs",
    tenantId: tenant,
    time: "2026-11-01T11:10:01.000Z",
    resultType: "Success",
    properties: {
      id: `Directory_policy_${index}`,
      activityDisplayName: auditActions[index][0],
      result: "success",
      targetResources: [{
        id: policyId.toUpperCase(),
        type: "Policy",
        displayName: "private policy name",
        modifiedProperties: [{
          displayName: "Rule",
          newValue: "private policy content",
        }],
      }],
      initiatedBy: { user: { userPrincipalName: "private actor" } },
    },
  };
}

Deno.test("Entra exact successful policy audit actions replay into coverage", () => {
  const records = auditActions.map((_entry, index) => policyAudit(index));
  const detector = createTelemetryDetector();
  const normalized = decodeSentinelFeedLine(
    JSON.stringify({ records: [...records, records[0]] }),
    "entra",
  );
  const alerts = normalized.flatMap(detector.ingest);
  assertEquals(alerts.length, auditActions.length);
  assertEquals(
    alerts.map(({ triggeringAction }) => triggeringAction),
    auditActions.map(([, action]) => action),
  );
  assertEquals(
    alerts.map(({ subject }) => subject),
    auditActions.map(() => `policy:${policyId}`),
  );
  assertEquals(JSON.stringify(normalized).includes("private"), false);
  const check = assessSentinelDefenseCoverage({ alerts }).upstreamChecks;
  for (
    const [id, expected] of [
      ["entra_conditional_access_policy_changed", records.slice(0, 2)],
      ["entra_authentication_policy_changed", records.slice(2)],
    ] as const
  ) {
    assertEquals(
      check.find((item) => item.id === id)?.records.map((
        { asset, evidenceIds },
      ) => [asset, evidenceIds]),
      expected.map((
        { properties },
      ) => [tenant, [`entra:audit:${properties.id}`]]),
    );
  }
});

Deno.test("Entra policy changes preserve canonical evidence across diagnostics and table exports", () => {
  const record = policyAudit();
  const table = {
    Type: "AuditLogs",
    AADTenantId: tenant.toUpperCase(),
    TenantId: anotherTenant,
    Id: record.properties.id,
    ActivityDisplayName: record.properties.activityDisplayName,
    ActivityDateTime: record.time,
    Result: "success",
    TargetResources: record.properties.targetResources,
  };
  const expected = {
    version: 1,
    asset: tenant,
    id: `entra:audit:${record.properties.id}`,
    timestamp: record.time,
    kind: "integrity_change",
    subject: `policy:${policyId}`,
    action: auditActions[0][1],
  } as const;
  assertEquals(adaptEntraEvent(record), expected);
  assertEquals(adaptEntraEvent(table), expected);
  assertEquals(
    adaptEntraEvent({
      ...record,
      properties: {
        ...record.properties,
        targetResources: [
          ...record.properties.targetResources,
          { type: "Policy", id: user },
        ],
      },
    })?.subject,
    "tenant-authentication-policy",
  );
});

Deno.test("Entra policy checks require explicit success and exact audit activity names", () => {
  const base = policyAudit();
  for (
    const extra of [
      { resultType: "Failure" },
      {
        resultType: "Success",
        properties: { ...base.properties, result: "failure" },
      },
      {
        resultType: undefined,
        properties: { ...base.properties, result: undefined },
      },
      {
        properties: {
          ...base.properties,
          activityDisplayName: "Update named location",
        },
      },
      {
        properties: {
          ...base.properties,
          activityDisplayName: "Delete Conditional Access policy preview",
        },
      },
      { category: "Other" },
    ]
  ) {
    assertEquals(adaptEntraEvent({ ...base, ...extra }), undefined);
  }
  assertEquals(
    adaptEntraEvent({
      ...base,
      properties: {
        ...base.properties,
        targetResources: [{ type: "User", id: user }, {
          type: "Policy",
          id: "not-a-guid",
        }],
      },
    })?.subject,
    "tenant-authentication-policy",
  );
});

const credentialAuditActions = [
  [
    "Add service principal credentials",
    "entra.service_principal.credentials_added",
    "ServicePrincipal",
  ],
  [
    "Remove service principal credentials",
    "entra.service_principal.credentials_removed",
    "ServicePrincipal",
  ],
  [
    "Update application - Certificates and secrets management",
    "entra.application.credentials_changed",
    "Application",
  ],
  [
    "Update application – Certificates and secrets management",
    "entra.application.credentials_changed",
    "App",
  ],
] as const;
const workloadId = "48e7b45e-12dc-4b3a-8811-837564e4a51a";

function credentialAudit(index = 0) {
  const [activityDisplayName, , targetType] = credentialAuditActions[index];
  const base = policyAudit();
  return {
    ...base,
    properties: {
      ...base.properties,
      id: `Directory_credential_${index}`,
      activityDisplayName,
      targetResources: [{
        type: targetType,
        id: workloadId.toUpperCase(),
        displayName: "private display name",
        modifiedProperties: [{
          displayName: "Credential",
          newValue: "private credential value",
        }],
      }],
    },
  };
}

Deno.test("Entra distinguishes exact workload credential additions, removals and application changes", () => {
  const records = credentialAuditActions.map((_entry, offset) =>
    credentialAudit(offset)
  );
  const alerts = decodeSentinelFeedLine(
    JSON.stringify({ records: [...records, records[0]] }),
    "entra",
  ).flatMap(createTelemetryDetector().ingest);
  assertEquals(
    alerts.map(({ triggeringAction }) => triggeringAction),
    credentialAuditActions.map(([, action]) => action),
  );
  assertEquals(alerts.map(({ subject }) => subject), [
    `service-principal:${workloadId}`,
    `service-principal:${workloadId}`,
    `application:${workloadId}`,
    `application:${workloadId}`,
  ]);
  assertEquals(JSON.stringify(alerts).includes("private"), false);
  const checks = assessSentinelDefenseCoverage({ alerts }).upstreamChecks;
  for (
    const [id, rows] of [
      ["entra_service_principal_credentials_added", [0]],
      ["entra_service_principal_credentials_removed", [1]],
      ["entra_application_credentials_changed", [2, 3]],
    ] as const
  ) {
    assertEquals(
      checks.find((check) => check.id === id)?.records.map((
        { asset, evidenceIds },
      ) => [asset, evidenceIds]),
      rows.map((
        index,
      ) => [tenant, [`entra:audit:${records[index].properties.id}`]]),
    );
  }
});

Deno.test("Entra credential evidence keeps equivalent table exports and tenant scope", () => {
  const diagnostic = credentialAudit();
  const table = {
    Type: "AuditLogs",
    AADTenantId: tenant,
    TenantId: anotherTenant,
    Id: diagnostic.properties.id,
    OperationName: diagnostic.properties.activityDisplayName,
    ActivityDateTime: diagnostic.time,
    Result: "success",
    TargetResources: diagnostic.properties.targetResources,
  };
  assertEquals(adaptEntraEvent(table), adaptEntraEvent(diagnostic));
  assertEquals(
    adaptEntraEvent({ ...table, ActivityDisplayName: "Update application" }),
    undefined,
  );
  const normalized = [
    adaptEntraEvent(diagnostic),
    adaptEntraEvent({ ...table, AADTenantId: anotherTenant }),
  ];
  assertEquals(
    normalized.flatMap(createTelemetryDetector().ingest).map(({ asset }) =>
      asset
    ),
    [
      tenant,
      anotherTenant,
    ],
  );
});

Deno.test("Entra credential checks skip benign audit actions or failed attempts and omit ambiguous targets", () => {
  const diagnostic = credentialAudit();
  for (
    const extra of [
      { resultType: "Failure" },
      { properties: { ...diagnostic.properties, result: "timeout" } },
      {
        resultType: undefined,
        properties: { ...diagnostic.properties, result: undefined },
      },
      {
        properties: {
          ...diagnostic.properties,
          activityDisplayName: "Update application",
        },
      },
      {
        properties: {
          ...diagnostic.properties,
          activityDisplayName: "Add service principal credentials requested",
        },
      },
      { category: "SignInLogs" },
    ]
  ) {
    if (extra.category === "SignInLogs") {
      assertEquals(
        adaptEntraEvent({
          ...diagnostic,
          category: extra.category,
          properties: {
            ...event.properties,
            activityDisplayName: diagnostic.properties.activityDisplayName,
          },
          resultType: "0",
        })?.action,
        undefined,
      );
    } else {
      assertEquals(adaptEntraEvent({ ...diagnostic, ...extra }), undefined);
    }
  }

  for (
    const targetResources of [
      [{ type: "Application", id: workloadId }],
      [...diagnostic.properties.targetResources, {
        type: "ServicePrincipal",
        id: policyId,
      }],
      [{ type: "ServicePrincipal", id: "invalid" }],
    ]
  ) {
    assertEquals(
      adaptEntraEvent({
        ...diagnostic,
        properties: { ...diagnostic.properties, targetResources },
      })?.subject,
      "tenant-service-principal-credentials",
    );
  }
});
