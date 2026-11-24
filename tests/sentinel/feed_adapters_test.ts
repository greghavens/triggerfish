import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { correlateSentinelIncidents } from "../../src/sentinel/incident_correlation.ts";
import { assessSentinelDefenseCoverage } from "../../src/sentinel/defense_coverage.ts";
import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  AUTH_FAILURE_LIMIT,
  createTelemetryDetector,
  DENIAL_LIMIT,
  normalizeSentinelTelemetryEvent,
} from "../../src/sentinel/telemetry.ts";
import {
  decodeSentinelFeedLine,
  parseSentinelSyslogClock,
} from "../../src/sentinel/feed_adapters.ts";
import { validateCefAlertSelectors } from "../../src/sentinel/cef_adapter.ts";

const normalizedEvent = {
  version: 1,
  kind: "integrity_change",
  timestamp: "2026-11-24T12:34:56Z",
  asset: "workstation",
  subject: "/etc/hosts",
  id: "source-event-id",
};

Deno.test("RFC5424 OpenSSH records correlate repeated failures and a success", () => {
  const { ingest } = createTelemetryDetector();
  const line = (index: number, status = "Failed", app = "sshd-auth") =>
    `<34>1 2026-11-24T12:34:${
      String(index).padStart(2, "0")
    }Z host ${app} 302 - - ${status} password for account from 192.0.2.1 port 40000 ssh2`;
  const [first] = decodeSentinelFeedLine(line(1), "syslog", "case-asset");
  const { id, ...fields } = normalizeSentinelTelemetryEvent(first);
  assertEquals(fields, {
    version: 1,
    timestamp: "2026-11-24T12:34:01.000Z",
    asset: "case-asset",
    kind: "auth_failure",
    subject: "account",
  });
  assertEquals(
    normalizeSentinelTelemetryEvent(
      decodeSentinelFeedLine(line(1), "syslog")[0],
    ).id,
    id,
  );
  for (let i = 1; i < AUTH_FAILURE_LIMIT; i++) {
    assertEquals(ingest(decodeSentinelFeedLine(line(i), "syslog")[0]), []);
  }
  const burst = ingest(
    decodeSentinelFeedLine(line(AUTH_FAILURE_LIMIT), "syslog")[0],
  );
  assertEquals(burst[0].type, "authentication_failure_burst");
  const success = ingest(
    decodeSentinelFeedLine(
      line(AUTH_FAILURE_LIMIT + 1, "Accepted"),
      "syslog",
    )[0],
  );
  assertEquals(success[0].type, "authentication_success_after_failures");
  assertEquals(
    decodeSentinelFeedLine(line(1, "Failed", "collector"), "syslog"),
    [],
  );
});
Deno.test("Sentinel decodes normalized JSON and RFC5424 collector messages", () => {
  const json = JSON.stringify(normalizedEvent);
  const header = "<134>1 2026-11-24T12:34:56Z host collector 12 EVENT ";
  assertEquals(decodeSentinelFeedLine(json, "jsonl"), [normalizedEvent]);
  assertEquals(
    decodeSentinelFeedLine(`${header}- ${json}`, "syslog"),
    [normalizedEvent],
  );
  assertEquals(
    decodeSentinelFeedLine(`${header}- \uFEFF  ${json}`, "syslog"),
    [normalizedEvent],
  );
  assertThrows(
    () => decodeSentinelFeedLine(`${header}- {broken`, "syslog"),
    Error,
    "Invalid JSON",
  );
  assertEquals(
    decodeSentinelFeedLine(
      `${header}[meta@123 label="x\\]y"][extra@123] ${json}`,
      "syslog",
    ),
    [normalizedEvent],
  );
  assertThrows(
    () =>
      decodeSentinelFeedLine(`${header}[meta@123 tag="a]b"] ${json}`, "syslog"),
    Error,
    "Invalid RFC 5424 structured data",
  );
  assertThrows(
    () => decodeSentinelFeedLine("<13>Nov 24 12:34:56 host test", "syslog"),
    Error,
    "Expected an RFC 5424",
  );
});

Deno.test("Legacy syslog uses an explicit clock and keeps existing OpenSSH and CEF validation", () => {
  const options = { syslogClock: parseSentinelSyslogClock("2026@-07:00") };
  const json = JSON.stringify(normalizedEvent);
  for (const message of [`  ${json}`, `collector: \uFEFF  ${json}`]) {
    assertEquals(
      decodeSentinelFeedLine(
        `<134>Jan  2 12:35:00 collector ${message}`,
        "syslog",
        undefined,
        undefined,
        options,
      ),
      [normalizedEvent],
    );
  }
  const source =
    "<34>Dec 31 23:59:59 bastion sshd[302]: Failed password for account from 192.0.2.1 port 40000 ssh2";
  const [record] = decodeSentinelFeedLine(
    source,
    "syslog",
    undefined,
    undefined,
    options,
  );
  const event = normalizeSentinelTelemetryEvent(record);
  assertEquals([event.asset, event.kind, event.timestamp], [
    "bastion",
    "auth_failure",
    "2027-01-01T06:59:59.000Z",
  ]);
  assertEquals(
    decodeSentinelFeedLine(source, "syslog", undefined, undefined, options),
    [record],
  );
  assertThrows(() => parseSentinelSyslogClock("2026@-25:00"));
  assertThrows(() =>
    decodeSentinelFeedLine(
      source.replace("Dec 31", "Feb 29"),
      "syslog",
      undefined,
      undefined,
      options,
    )
  );
  assertThrows(
    () => decodeSentinelFeedLine(source, "syslog"),
    Error,
    "RFC 5424",
  );
  const cef =
    "<134>Jan  2 12:35:00 collector CEF:0|Vendor|Product|1|class-1|Alert|6|msg=opaque";
  const selectors = validateCefAlertSelectors([
    {
      vendor: "Vendor",
      product: "Product",
      classId: "class-1",
      source: "collector",
      asset: "firewall",
    },
  ]);
  const [cefEvent] = decodeSentinelFeedLine(
    cef,
    "cef",
    undefined,
    selectors,
    options,
  );
  const normalized = normalizeSentinelTelemetryEvent(cefEvent);
  assertEquals([normalized.asset, normalized.kind, normalized.timestamp], [
    "firewall",
    "security_sensor_alert",
    "2026-01-02T19:35:00.000Z",
  ]);
  assertEquals(
    decodeSentinelFeedLine(
      cef.replace("collector", "untrusted"),
      "cef",
      undefined,
      selectors,
      options,
    ),
    [],
  );
});

Deno.test("Sentinel normalizes Suricata alert IDs and times without exposing payloads", () => {
  const raw = JSON.stringify({
    timestamp: "2026-11-24T12:34:56.123456-0700",
    event_type: "alert",
    src_ip: "192.0.2.1",
    dest_ip: "2001:db8:0000::1",
    src_port: 123,
    dest_port: 456,
    alert: { signature_id: 22, gid: 2, signature: "private signature text" },
    payload: "private payload",
  });
  const detector = createTelemetryDetector();
  const events = decodeSentinelFeedLine(raw, "suricata");
  assertEquals(decodeSentinelFeedLine(raw, "suricata"), events);
  const [alert] = detector.ingest(events[0]);
  assertEquals(alert.type, "network_security_alert");
  assertEquals(alert.asset, "2001:db8::1");
  assertEquals(alert.subject, "Suricata 2:22");
  assertEquals(alert.triggeringAction, "suricata:2:22");
  assertEquals(alert.observedAt, "2026-11-24T19:34:56.123Z");
  assertMatch(alert.evidenceIds[0], /^eve:[0-9a-f]{64}$/);
  assertEquals(detector.ingest(events[0]), []);
  assertEquals(decodeSentinelFeedLine('{"event_type":"flow"}', "suricata"), []);
});

Deno.test("Sentinel accepts Zeek notices and skips ordinary connection logs", () => {
  const record = {
    ts: 1_796_248_896.123,
    uid: "CtCJF01",
    dst: "192.0.2.50",
    note: "Notice::NetworkAlert",
    msg: "private notice text",
  };
  const [event] = decodeSentinelFeedLine(JSON.stringify(record), "zeek");
  const [alert] = createTelemetryDetector().ingest(event);
  assertEquals(alert.asset, "192.0.2.50");
  assertEquals(alert.subject, "Zeek Notice::NetworkAlert");
  assertEquals(alert.triggeringAction, "zeek:Notice::NetworkAlert");
  assertEquals(alert.observedAt, new Date(record.ts * 1000).toISOString());
  assertMatch(alert.evidenceIds[0], /^zeek:[0-9a-f]{64}$/);
  assertEquals(decodeSentinelFeedLine('{"ts":42,"uid":"conn"}', "zeek"), []);
  assertThrows(
    () =>
      decodeSentinelFeedLine(
        JSON.stringify({ ...record, ts: "2026-11-24" }),
        "zeek",
      ),
    Error,
    "Invalid Zeek notice timestamp",
  );
});

Deno.test("Zeek host notices retain source attribution when no responder is recorded", () => {
  const notice = {
    ts: 1_796_248_896.123,
    note: "SSH::Password_Guessing",
    src: "192.0.2.51",
    msg: "Private fixture detail",
  };
  const [event] = decodeSentinelFeedLine(JSON.stringify(notice), "zeek");
  const [alert] = createTelemetryDetector().ingest(event);
  assertEquals(alert.asset, "192.0.2.51");
  assertEquals(alert.triggeringAction, "zeek:SSH::Password_Guessing");
  const lookalike = { ...alert, triggeringAction: "zeek:Notice::NetworkAlert" };
  const coverage = assessSentinelDefenseCoverage({
    alerts: [alert, lookalike],
  });
  const check = coverage.upstreamChecks.find(({ id }) =>
    id === "zeek_ssh_password_guessing_notice"
  );
  assertEquals(check?.records.map(({ sourceRecord }) => sourceRecord), [1]);

  assertEquals(
    decodeSentinelFeedLine(
      JSON.stringify({ ts: notice.ts, note: notice.note }),
      "zeek",
    ),
    [],
  );
});

Deno.test("Sentinel normalizes Entra diagnostic envelopes and limits record fanout", () => {
  const signIn = {
    category: "SignInLogs",
    time: "2026-11-24T12:34:56Z",
    tenantId: "6a7295bf-7903-4e0b-9199-8bfb3bdc92ac",
    resultType: "0",
    properties: {
      id: "abfd77a8-8f36-4c6b-873d-b765d488c903",
      userId: "b55c76c5-979f-440c-91a9-a8f4fa32f5ae",
      isInteractive: true,
    },
  };
  const skipped = { category: "AuditLogs" };
  const expected = [{
    version: 1,
    timestamp: "2026-11-24T12:34:56.000Z",
    asset: signIn.tenantId,
    kind: "auth_success",
    subject: signIn.properties.userId,
    id: `entra:${signIn.properties.id}`,
  }];
  assertEquals(
    decodeSentinelFeedLine(JSON.stringify(signIn), "entra"),
    expected,
  );
  assertEquals(
    decodeSentinelFeedLine(
      JSON.stringify({ records: [skipped, signIn] }),
      "entra",
    ),
    expected,
  );
  assertEquals(decodeSentinelFeedLine('{"records":[]}', "entra"), []);
  assertThrows(
    () =>
      decodeSentinelFeedLine('{"records":{"category":"SignInLogs"}}', "entra"),
    Error,
    "Entra records array",
  );
  assertThrows(
    () =>
      decodeSentinelFeedLine(
        JSON.stringify({ records: Array(1001).fill(skipped) }),
        "entra",
      ),
    Error,
    "at most 1000",
  );
});

Deno.test("Sentinel applies CEF selectors to the RFC 5424 hostname", () => {
  const selectors = validateCefAlertSelectors([
    {
      vendor: "Vendor",
      product: "Product",
      classId: "class-1",
      asset: "default",
    },
    {
      vendor: "Vendor",
      product: "Product",
      classId: "class-1",
      asset: "host-specific",
      source: "trusted-host",
    },
  ]);
  const header =
    "<134>1 2026-11-24T12:34:56.25-07:00 trusted-host collector 12 EVENT ";
  const body =
    '[meta@123 tag="saved"] CEF:0|Vendor|Product|1|class-1|Alert|6|msg=opaque';
  const [event] = decodeSentinelFeedLine(
    header + body,
    "cef",
    undefined,
    selectors,
  );
  const [alert] = createTelemetryDetector().ingest(event);
  assertEquals(alert.type, "security_sensor_alert");
  assertEquals(alert.asset, "host-specific");
  assertEquals(alert.observedAt, "2026-11-24T19:34:56.250Z");
  assertMatch(alert.evidenceIds[0], /^cef:[0-9a-f]{64}$/);
  assertEquals(
    decodeSentinelFeedLine(
      header + body.replace("class-1", "other-class"),
      "cef",
      undefined,
      selectors,
    ),
    [],
  );
  assertThrows(
    () => decodeSentinelFeedLine(header + body, "cef"),
    Error,
    "requires explicit alert selectors",
  );
});

Deno.test("Kubernetes audit derives scoped authorization and RBAC telemetry from completed events", () => {
  const event = {
    apiVersion: "audit.k8s.io/v1",
    kind: "Event",
    stage: "ResponseComplete",
    auditID: "663f497a-e026-4058-9ff5-cb3a05254fa8",
    stageTimestamp: "2026-01-01T00:00:00.123456Z",
    verb: "patch",
    user: { username: "example-user" },
    responseStatus: { code: 403 },
    objectRef: {
      apiGroup: "rbac.authorization.k8s.io",
      resource: "rolebindings",
    },
    requestObject: { private: "ignored" },
  };
  const decode = (input: object, source = "cluster-a") =>
    decodeSentinelFeedLine(JSON.stringify(input), "kubernetes-audit", source);
  const [denied] = decode(event) as Record<string, unknown>[];
  assertEquals(denied.kind, "authorization_denied");
  assertEquals(denied.timestamp, "2026-01-01T00:00:00.123Z");
  assertEquals(denied.asset, "cluster-a");
  assertEquals(denied.subject, "example-user");
  assertEquals(denied.requestObject, undefined);
  assertEquals(decode({ ...event, stage: "RequestReceived" }), []);
  assertEquals(
    decode({ ...event, responseStatus: { code: 200 }, verb: "get" }),
    [],
  );
  const [change] = decode({
    ...event,
    responseStatus: { code: 200 },
  }) as Record<string, unknown>[];
  assertEquals(change.kind, "integrity_change");
  const combine = createTelemetryDetector();
  const bindingEvents = ["rolebindings", "clusterrolebindings"].flatMap((
    resource,
  ) =>
    ["create", "update", "patch", "delete", "deletecollection"].flatMap((
      verb,
      n,
    ) =>
      decode({
        ...event,
        verb,
        responseStatus: { code: 200 },
        auditID: `663f497a-e026-4058-9ff5-cb3a05254f${
          resource.startsWith("cluster") ? 2 : 1
        }${n}`,
        objectRef: { ...event.objectRef, resource },
      })
    )
  );
  const replay = [...bindingEvents, ...decode(event)].flatMap((row) =>
    combine.ingest(row)
  );
  const check = assessSentinelDefenseCoverage({ alerts: replay }).upstreamChecks
    .find(({ id }) => id === "kubernetes_rbac_binding_changed");
  assertEquals(check?.records.length, 10);
  assertEquals(change.action, "kubernetes-audit:rolebindings:patch");
  assertEquals(decode({ ...event, responseStatus: { code: 500 } }), []);
  assertEquals(
    decode({
      ...event,
      responseStatus: { code: 200 },
      objectRef: { ...event.objectRef, resource: "roles" },
    }),
    [],
  );
  assertEquals(change.id, denied.id);
  const { apiVersion, kind: _kind, ...item } = event;
  const batch = {
    apiVersion,
    kind: "EventList",
    items: [
      { ...item, stage: "RequestReceived" },
      item,
    ],
  };
  assertEquals(decode(batch), [denied]);
  assertThrows(
    () => decode({ ...batch, items: [{ ...item, kind: "EventList" }] }),
    Error,
    "Unexpected object",
  );
  assertThrows(
    () => decode({ ...batch, items: Array(1001).fill(item) }),
    Error,
    "1000 events",
  );
  const [otherCluster] = decode(event, "cluster-b") as Record<
    string,
    unknown
  >[];
  assertNotEquals(otherCluster.id, denied.id);
  assertThrows(() => decode(event, ""), Error, "cluster asset ID");
  assertThrows(
    () => decode({ ...event, auditID: "-".repeat(36) }),
    Error,
    "audit ID",
  );
});

Deno.test("Kubernetes audit maps successful Role and NetworkPolicy requests to exact coverage checks", () => {
  const epoch = "2026-01-01T00:00:00Z";
  const verbs = ["create", "update", "patch", "delete", "deletecollection"];
  const groups = [
    ["rbac.authorization.k8s.io", "roles"],
    ["rbac.authorization.k8s.io", "clusterroles"],
    ["networking.k8s.io", "networkpolicies"],
  ] as const;
  const base = {
    apiVersion: "audit.k8s.io/v1",
    kind: "Event",
    stage: "ResponseComplete",
    stageTimestamp: epoch,
    responseStatus: { code: 200, status: "Success" },
    user: { username: "policy-operator" },
    requestObject: { confidential: "private request data" },
  };
  const records = groups.flatMap(([apiGroup, resource], group) =>
    verbs.map((verb, index) => {
      const namespace = resource === "clusterroles" ? "" : "fixture";
      const name = verb === "create" || verb === "deletecollection"
        ? ""
        : "private-resource-name";
      const path = [
        "/apis",
        apiGroup,
        "v1",
        ...(namespace ? ["namespaces", namespace] : []),
        resource,
        name,
      ]
        .filter(Boolean).join("/");
      return {
        ...base,
        auditID: `663f497a-e026-4058-9ff5-cb3a05254f${group}${index}`,
        verb,
        objectRef: { apiGroup, apiVersion: "v1", resource, namespace, name },
        requestURI: `${path}?pretty=true`,
      };
    })
  );
  const decode = (row: object, asset = "cluster-a") =>
    decodeSentinelFeedLine(JSON.stringify(row), "kubernetes-audit", asset)
      .map(normalizeSentinelTelemetryEvent);
  const normalized = [...records, records[0]].flatMap((row) => decode(row));
  assertEquals(JSON.stringify(normalized).includes("private"), false);
  const alerts = normalized.flatMap(createTelemetryDetector().ingest);
  assertEquals(
    alerts.map(({ triggeringAction }) => triggeringAction),
    groups.flatMap(([, resource]) =>
      verbs.map((verb) => `kubernetes-audit:${resource}:${verb}`)
    ),
  );
  const otherCluster = decode(records[0], "cluster-b")[0];
  assertNotEquals(normalized[0].id, otherCluster.id);
  const { upstreamChecks } = assessSentinelDefenseCoverage({ alerts });
  for (
    const [id, expected] of [
      ["kubernetes_rbac_role_changed", normalized.slice(0, 10)],
      ["kubernetes_network_policy_changed", normalized.slice(10, 15)],
    ] as const
  ) {
    assertEquals(
      upstreamChecks.find((check) => check.id === id)?.records
        .map(({ asset, evidenceIds }) => [asset, evidenceIds]),
      expected.map(({ id }) => ["cluster-a", [id]]),
    );
  }

  const policy = records[10];
  for (
    const changes of [
      { stage: "RequestReceived" },
      { verb: "get" },
      { objectRef: { ...policy.objectRef, apiGroup: "sample.invalid" } },
      { objectRef: { ...policy.objectRef, subresource: "status" } },
      { requestURI: undefined },
      { requestURI: policy.requestURI + "&dryRun=All" },
      { verb: "delete", requestObject: { dryRun: ["All"] } },
      { responseStatus: { code: 201.5 } },
      { responseStatus: { code: 200, status: "Failure" } },
      { responseStatus: { code: 500 } },
    ]
  ) {
    assertEquals(
      decode({ ...policy, ...changes }),
      [],
      JSON.stringify(changes),
    );
  }
  assertEquals(
    decode({ ...policy, requestURI: policy.requestURI + "&dryRun=" }).length,
    1,
  );
  assertEquals(
    decode({ ...policy, responseStatus: { code: 403 } })[0].kind,
    "authorization_denied",
  );
});

Deno.test("Kubernetes audit maps admission webhook configuration changes to exact coverage checks", () => {
  const apiGroup = "admissionregistration.k8s.io";
  const resources = [
    [
      "validatingwebhookconfigurations",
      "kubernetes_validating_webhook_configuration_changed",
    ],
    [
      "mutatingwebhookconfigurations",
      "kubernetes_mutating_webhook_configuration_changed",
    ],
  ] as const;
  const verbs = ["create", "update", "patch", "delete", "deletecollection"];
  const records = resources.flatMap(([resource], group) =>
    verbs.map((verb, index) => {
      const name = verb === "create" || verb === "deletecollection"
        ? undefined
        : "private-webhook-name";
      return {
        apiVersion: "audit.k8s.io/v1",
        kind: "Event",
        stage: "ResponseComplete",
        stageTimestamp: "2026-01-01T00:00:00Z",
        responseStatus: {
          code: verb === "create" ? 201 : 200,
          status: "Success",
        },
        user: { username: "webhook-operator" },
        auditID: `f5f93262-6079-4606-922d-64e092ca7e${group}${index}`,
        verb,
        objectRef: { apiGroup, apiVersion: "v1", resource, name },
        requestURI: `/apis/${apiGroup}/v1/${resource}${name ? `/${name}` : ""}`,
      };
    })
  );
  const decode = (row: object) =>
    decodeSentinelFeedLine(JSON.stringify(row), "kubernetes-audit", "cluster-a")
      .map(normalizeSentinelTelemetryEvent);
  const first = records[0];
  const withBody = {
    ...first,
    requestObject: {
      webhooks: [{
        clientConfig: {
          url: "https://private-url.invalid",
          caBundle: "private-ca-bundle",
        },
      }],
    },
  };
  const events = [withBody, ...records.slice(1), records[0]].flatMap(decode);
  const alerts = events.flatMap(createTelemetryDetector().ingest);
  assertEquals(
    alerts.map(({ triggeringAction }) => triggeringAction),
    resources.flatMap(([resource]) =>
      verbs.map((verb) => `kubernetes-audit:${resource}:${verb}`)
    ),
  );
  const coverage = assessSentinelDefenseCoverage({ alerts });
  for (const [group, [, id]] of resources.entries()) {
    assertEquals(
      coverage.upstreamChecks.find((check) => check.id === id)?.records
        .map(({ asset, evidenceIds }) => [asset, evidenceIds]),
      events.slice(group * verbs.length, (group + 1) * verbs.length)
        .map(({ id }) => ["cluster-a", [id]]),
    );
  }
  assertEquals(
    JSON.stringify({ events, alerts, coverage }).includes("private-"),
    false,
  );
  for (
    const change of [
      { stage: "RequestReceived" },
      { verb: "get" },
      { objectRef: { ...first.objectRef, apiGroup: "other.invalid" } },
      {
        objectRef: {
          ...first.objectRef,
          resource: "validatingadmissionpolicies",
        },
      },
      { objectRef: { ...first.objectRef, subresource: "status" } },
      { responseStatus: { code: 500, status: "Failure" } },
      { responseStatus: { code: 200, status: "Failure" } },
      { requestURI: undefined },
      { requestURI: `${first.requestURI}?dryRun=All` },
    ]
  ) assertEquals(decode({ ...first, ...change }), []);
  assertEquals(
    decode({ ...records[3], requestObject: { dryRun: ["All"] } }),
    [],
  );
  assertEquals(
    decode({ ...first, responseStatus: { code: 403 } }).map((
      { kind, action },
    ) => [kind, action]),
    [["authorization_denied", undefined]],
  );
});

Deno.test("CloudTrail derives account scoped telemetry for access denials and successful IAM changes", () => {
  const base = {
    eventVersion: "1.11",
    eventTime: "2026-01-01T00:00:00Z",
    eventID: "event-denied",
    eventName: "DescribeInstances",
    eventSource: "ec2.amazonaws.com",
    errorCode: "Client.UnauthorizedOperation",
    userIdentity: { principalId: "example-principal" },
    requestParameters: { private: "discarded" },
  };
  const iam = {
    ...base,
    eventID: "event-policy",
    eventTime: "2026-01-01T00:00:01Z",
    errorCode: undefined,
    eventSource: "iam.amazonaws.com",
    eventName: "AttachRolePolicy",
  };
  const decode = (raw: object, source = "account-a") =>
    decodeSentinelFeedLine(JSON.stringify(raw), "cloudtrail", source) as Record<
      string,
      unknown
    >[];
  const alerts = decode({
    Records: [iam, base, { ...iam, eventName: "GetRole" }],
  });
  assertEquals(decode({ ...iam, readOnly: true }), []);
  assertEquals(decode({ ...iam, errorMessage: "Policy update failed" }), []);
  assertEquals(alerts.map(({ kind }) => kind), [
    "authorization_denied",
    "integrity_change",
  ]);
  assertEquals(alerts.map(({ asset }) => asset), ["account-a", "account-a"]);
  assertEquals(alerts[0], decode(base)[0]);
  assertEquals(alerts[0].action, "ec2.amazonaws.com:DescribeInstances");
  assertNotEquals(alerts[0].id, decode(base, "account-b")[0].id);
  assertEquals(JSON.stringify(alerts).includes("discarded"), false);
  const check = assessSentinelDefenseCoverage({ alerts: [] }).upstreamChecks
    .find(({ id }) => id === "cloudtrail_iam_policy_changed")!;
  const replays = check.actions.flatMap((action, index) =>
    decode({
      ...iam,
      eventID: `event-policy-${index}`,
      eventName: action.split(":")[1],
    })
  );
  const detector = createTelemetryDetector();
  const evidence = [
    ...replays,
    ...decode({
      ...iam,
      eventID: "denied-iam",
      errorCode: "AccessDenied",
    }),
  ].flatMap((row) => detector.ingest(row));
  assertEquals(
    assessSentinelDefenseCoverage({ alerts: evidence }).upstreamChecks
      .find(({ id }) => id === check.id)?.records.length,
    14,
  );
  assertThrows(() => decode(base, ""), Error, "account asset ID");
});

Deno.test("CloudTrail console authentication outcomes feed account-scoped correlation", () => {
  const records = Array.from(
    { length: AUTH_FAILURE_LIMIT + 1 },
    (_, index) => ({
      eventVersion: "1.11",
      eventTime: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      eventID: `login-${index}`,
      eventSource: "signin.amazonaws.com",
      eventName: "ConsoleLogin",
      userIdentity: { type: "IAMUser", principalId: "principal-a" },
      responseElements: {
        ConsoleLogin: index < AUTH_FAILURE_LIMIT ? "Failure" : "Success",
      },
    }),
  );
  const detector = createTelemetryDetector();
  const events = decodeSentinelFeedLine(
    JSON.stringify({ Records: records }),
    "cloudtrail",
    "account-a",
  );
  const alerts = events.flatMap((event) => detector.ingest(event));
  assertEquals(alerts.map(({ type }) => type), [
    "authentication_failure_burst",
    "authentication_success_after_failures",
  ]);
  assertEquals(alerts.map(({ asset }) => asset), ["account-a", "account-a"]);
  assertEquals(
    decodeSentinelFeedLine(
      JSON.stringify({
        ...records[0],
        userIdentity: { type: "Unknown" },
      }),
      "cloudtrail",
      "account-a",
    ),
    [],
  );
});

Deno.test("CloudTrail detects successful audit configuration changes", () => {
  const base = {
    eventVersion: "1.11",
    eventTime: "2026-01-01T00:00:00Z",
    eventSource: "cloudtrail.amazonaws.com",
    eventType: "AwsApiCall",
    eventCategory: "Management",
    userIdentity: { principalId: "audit-operator" },
    readOnly: false,
  };
  const mutations = [
    "DeleteTrail",
    "UpdateTrail",
    "PutEventSelectors",
    "PutInsightSelectors",
    "StopEventDataStoreIngestion",
    "DeleteEventDataStore",
    "UpdateEventDataStore",
  ];
  const confirmed = mutations.map((eventName, index) => ({
    ...base,
    eventID: `configuration-${index}`,
    eventName,
  }));
  const records = [
    { ...base, eventID: "stop-logging", eventName: "StopLogging" },
    ...confirmed,
    confirmed[0],
    {
      ...base,
      eventID: "denial",
      eventName: "DeleteTrail",
      errorCode: "AccessDenied",
    },
    {
      ...base,
      eventID: "read",
      eventName: "GetTrail",
      readOnly: true,
    },
    {
      ...base,
      eventID: "readonly-claim",
      eventName: "PutInsightSelectors",
      readOnly: true,
    },
    {
      ...base,
      eventID: "partial-error",
      eventName: "StopEventDataStoreIngestion",
      errorMessage: "Ingestion could not be stopped",
    },
    {
      ...base,
      eventID: "unrelated-op",
      eventName: "StartEventDataStoreIngestion",
    },
    {
      ...base,
      eventID: "wrong-source",
      eventName: "StopLogging",
      eventSource: "other.amazonaws.com",
    },
  ];
  const events = decodeSentinelFeedLine(
    JSON.stringify({ Records: records }),
    "cloudtrail",
    "account-a",
  ).map(normalizeSentinelTelemetryEvent);
  assertEquals(events.map(({ action, kind }) => [action, kind]), [
    ...["StopLogging", ...mutations, mutations[0]].map((action) => [
      `cloudtrail.amazonaws.com:${action}`,
      "integrity_change",
    ]),
    ["cloudtrail.amazonaws.com:DeleteTrail", "authorization_denied"],
  ]);
  const detector = createTelemetryDetector();
  const alerts = events.flatMap(detector.ingest);
  assertEquals(
    alerts.map(({ type }) => type),
    ["StopLogging", ...mutations].map(() => "integrity_change"),
  );
  const coverage = assessSentinelDefenseCoverage({ alerts });
  const check = coverage.upstreamChecks.find(({ id }) =>
    id === "cloudtrail_logging_stopped"
  )!;
  assertEquals(
    check.records.map(({ asset, evidenceIds }) => [asset, evidenceIds]),
    [
      ["account-a", [events[0].id]],
    ],
  );
  const configuration = coverage.upstreamChecks.find(({ id }) =>
    id === "cloudtrail_audit_configuration_changed"
  );
  assertEquals(
    configuration?.records.map((
      { asset, evidenceIds },
    ) => [asset, evidenceIds]),
    events.slice(1, 1 + mutations.length).map(({ id }) => ["account-a", [id]]),
  );
});

Deno.test("CloudTrail detects IAM key creation and successful requests to set a key active", () => {
  const base = {
    eventVersion: "1.11",
    eventTime: "2026-01-01T00:00:00Z",
    eventType: "AwsApiCall",
    eventCategory: "Management",
    eventSource: "iam.amazonaws.com",
    userIdentity: { principalId: "iam-operator" },
    readOnly: false,
  };
  const created = {
    ...base,
    eventID: "create-key",
    eventName: "CreateAccessKey",
    requestParameters: { userName: "private-key-user" },
    responseElements: {
      accessKey: {
        accessKeyId: "private-key-id",
        secretAccessKey: "private-key-secret",
      },
    },
  };
  const activated = {
    ...base,
    eventID: "set-active",
    eventName: "UpdateAccessKey",
    requestParameters: { accessKeyId: "private-key-id", status: "Active" },
    responseElements: null,
  };
  const decode = (records: readonly unknown[]) =>
    decodeSentinelFeedLine(
      JSON.stringify({ Records: records }),
      "cloudtrail",
      "account-a",
    ).map(normalizeSentinelTelemetryEvent);
  const events = decode([
    created,
    activated,
    created,
    ...["Inactive", "Expired", "active", undefined, true].map((status, i) => ({
      ...activated,
      eventID: `status-control-${i}`,
      requestParameters: { status },
    })),
    { ...activated, eventID: "bad-shape", requestParameters: ["Active"] },
    { ...created, eventID: "readonly", readOnly: true },
    { ...activated, eventID: "failed", errorMessage: "Request failed" },
    { ...created, eventID: "wrong-service", eventSource: "sts.amazonaws.com" },
  ]);
  assertEquals(events.map(({ action, kind }) => [action, kind]), [
    ["iam.amazonaws.com:CreateAccessKey", "integrity_change"],
    ["iam.amazonaws.com:UpdateAccessKey:active", "integrity_change"],
    ["iam.amazonaws.com:CreateAccessKey", "integrity_change"],
  ]);
  assertEquals(
    decode([{ ...activated, eventID: "denied", errorCode: "AccessDenied" }])
      .map(({ kind }) => kind),
    ["authorization_denied"],
  );
  const alerts = events.flatMap(createTelemetryDetector().ingest);
  assertEquals(alerts.length, 2);
  const coverage = assessSentinelDefenseCoverage({ alerts });
  for (
    const [index, id] of [
      "cloudtrail_iam_access_key_created",
      "cloudtrail_iam_access_key_set_active",
    ].entries()
  ) {
    assertEquals(
      coverage.upstreamChecks.find((check) => check.id === id)?.records
        .map(({ asset, evidenceIds }) => [asset, evidenceIds]),
      [["account-a", [events[index].id]]],
    );
  }
  for (
    const value of ["private-key-id", "private-key-secret", "private-key-user"]
  ) {
    assertEquals(
      JSON.stringify({ events, alerts, coverage }).includes(value),
      false,
    );
  }
});

Deno.test("CloudTrail distinguishes Security Hub CSPM and standards disable requests", () => {
  const base = {
    eventVersion: "1.11",
    eventTime: "2026-01-01T00:00:00Z",
    eventType: "AwsApiCall",
    eventCategory: "Management",
    eventSource: "securityhub.amazonaws.com",
    userIdentity: { principalId: "security-operator" },
    readOnly: false,
  };
  const hub = {
    ...base,
    eventID: "disable-hub",
    eventName: "DisableSecurityHub",
    requestParameters: null,
    responseElements: null,
  };
  const subscription =
    "arn:aws:securityhub:us-east-1:123456789012:subscription/fixture-standards/v/1.0.0";
  const standards = {
    ...base,
    eventID: "disable-standards",
    eventName: "BatchDisableStandards",
    requestParameters: { standardsSubscriptionArns: [subscription] },
    responseElements: {
      standardsSubscriptions: [{
        standardsSubscriptionArn: subscription,
        standardsStatus: "DELETING",
      }],
    },
  };
  const decode = (records: readonly unknown[]) =>
    decodeSentinelFeedLine(
      JSON.stringify({ Records: records }),
      "cloudtrail",
      "account-a",
    ).map(normalizeSentinelTelemetryEvent);
  assertEquals(
    decode([
      { ...hub, eventName: "EnableSecurityHub" },
      { ...hub, eventName: "DescribeHub" },
      { ...standards, eventName: "BatchEnableStandards" },
      { ...hub, readOnly: true },
      { ...standards, errorMessage: "Request failed" },
      { ...hub, eventSource: "other.amazonaws.com" },
    ]),
    [],
  );
  assertEquals(
    decode([{ ...hub, errorCode: "AccessDeniedException" }]).map(({ kind }) =>
      kind
    ),
    ["authorization_denied"],
  );
  const events = decode([hub, standards, standards]);
  const alerts = events.flatMap(createTelemetryDetector().ingest);
  assertEquals(alerts.map(({ triggeringAction }) => triggeringAction), [
    "securityhub.amazonaws.com:DisableSecurityHub",
    "securityhub.amazonaws.com:BatchDisableStandards",
  ]);
  const coverage = assessSentinelDefenseCoverage({ alerts });
  for (
    const [index, id] of [
      "cloudtrail_security_hub_disabled",
      "cloudtrail_security_hub_standards_disable_requested",
    ].entries()
  ) {
    assertEquals(
      coverage.upstreamChecks.find((check) => check.id === id)?.records
        .map(({ asset, evidenceIds }) => [asset, evidenceIds]),
      [["account-a", [events[index].id]]],
    );
  }
  assertEquals(
    JSON.stringify({ events, alerts, coverage }).includes(subscription),
    false,
  );
});

Deno.test("CloudTrail detects removal of bucket-level S3 Block Public Access configuration", () => {
  const row = {
    eventVersion: "1.11",
    eventTime: "2026-01-01T00:00:00Z",
    eventType: "AwsApiCall",
    eventCategory: "Management",
    eventSource: "s3.amazonaws.com",
    eventName: "DeleteBucketPublicAccessBlock",
    eventID: "remove-block",
    readOnly: false,
    userIdentity: { principalId: "security-operator" },
    requestParameters: { bucketName: "private-fixture-bucket" },
    responseElements: null,
  };
  const decode = (...records: unknown[]) =>
    decodeSentinelFeedLine(
      JSON.stringify({ Records: records }),
      "cloudtrail",
      "account-a",
    ).map(normalizeSentinelTelemetryEvent);
  assertEquals(
    decode(
      { ...row, eventName: "DeleteAccountPublicAccessBlock" },
      { ...row, eventName: "GetBucketPublicAccessBlock" },
      { ...row, eventName: "PutBucketPublicAccessBlock" },
      { ...row, eventName: "DeleteBucketPolicy" },
      { ...row, readOnly: true },
      { ...row, errorMessage: "Request failed" },
      { ...row, eventSource: "other.amazonaws.com" },
    ),
    [],
  );
  assertEquals(
    decode({ ...row, errorCode: "AccessDenied" }).map(({ kind }) => kind),
    ["authorization_denied"],
  );
  const events = decode(row, row);
  const alerts = events.flatMap(createTelemetryDetector().ingest);
  assertEquals(alerts.map(({ triggeringAction }) => triggeringAction), [
    "s3.amazonaws.com:DeleteBucketPublicAccessBlock",
  ]);
  const coverage = assessSentinelDefenseCoverage({ alerts });
  assertEquals(
    coverage.upstreamChecks.find(({ id }) =>
      id === "cloudtrail_s3_bucket_public_access_block_removed"
    )?.records.map(({ asset, evidenceIds }) => [asset, evidenceIds]),
    [["account-a", [events[0].id]]],
  );
  assertEquals(
    JSON.stringify({ events, alerts, coverage }).includes(
      "private-fixture-bucket",
    ),
    false,
  );
});

Deno.test("CloudTrail distinguishes regional EBS snapshot and AMI public-access block disablement", () => {
  const base = {
    eventVersion: "1.11",
    eventTime: "2026-01-01T00:00:00Z",
    eventType: "AwsApiCall",
    eventCategory: "Management",
    eventSource: "ec2.amazonaws.com",
    awsRegion: "us-east-1",
    readOnly: false,
    userIdentity: { principalId: "security-operator" },
  };
  const snapshot = {
    ...base,
    eventName: "DisableSnapshotBlockPublicAccess",
    eventID: "snapshot-block-disabled",
  };
  const image = {
    ...base,
    eventName: "DisableImageBlockPublicAccess",
    eventID: "image-block-disabled",
  };
  const decode = (...records: unknown[]) =>
    decodeSentinelFeedLine(
      JSON.stringify({ Records: records }),
      "cloudtrail",
      "account-a",
    ).map(normalizeSentinelTelemetryEvent);
  assertEquals(
    decode(
      { ...snapshot, eventName: "EnableSnapshotBlockPublicAccess" },
      { ...image, eventName: "GetImageBlockPublicAccessState" },
      { ...snapshot, eventName: "ModifySnapshotAttribute" },
      { ...image, eventSource: "other.amazonaws.com" },
      { ...snapshot, readOnly: true },
      { ...image, errorMessage: "Request failed" },
      {
        ...snapshot,
        errorCode: "DryRunOperation",
        requestParameters: { dryRun: true },
      },
    ),
    [],
  );
  assertEquals(
    decode({ ...image, errorCode: "Client.UnauthorizedOperation" }).map((
      { kind },
    ) => kind),
    ["authorization_denied"],
  );
  const events = decode(snapshot, image, image);
  const alerts = events.flatMap(createTelemetryDetector().ingest);
  assertEquals(alerts.map(({ triggeringAction }) => triggeringAction), [
    "ec2.amazonaws.com:DisableSnapshotBlockPublicAccess",
    "ec2.amazonaws.com:DisableImageBlockPublicAccess",
  ]);
  const coverage = assessSentinelDefenseCoverage({ alerts });
  for (
    const [index, id] of [
      "cloudtrail_ebs_snapshot_public_access_block_disabled",
      "cloudtrail_ami_public_access_block_disabled",
    ].entries()
  ) {
    assertEquals(
      coverage.upstreamChecks.find((check) => check.id === id)?.records
        .map(({ asset, evidenceIds }) => [asset, evidenceIds]),
      [["account-a", [events[index].id]]],
    );
  }
});

Deno.test("CloudTrail detects a successful KMS key policy write without retaining its contents", () => {
  const keyId = "47d6b333-d72e-4504-9f1d-949a18a328cd";
  const row = {
    eventVersion: "1.08",
    eventTime: "2026-01-01T00:00:00Z",
    eventType: "AwsApiCall",
    eventCategory: "Management",
    eventSource: "kms.amazonaws.com",
    eventName: "PutKeyPolicy",
    eventID: "key-policy-write",
    userIdentity: { type: "IAMUser", principalId: "key-operator" },
    readOnly: false,
    requestParameters: {
      keyId,
      policyName: "default",
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "PrivatePolicyCanary",
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::123456789012:root" },
          Action: "kms:*",
          Resource: "*",
        }],
      }),
    },
    responseElements: null,
  };
  const decode = (...records: unknown[]) =>
    decodeSentinelFeedLine(
      JSON.stringify({ Records: records }),
      "cloudtrail",
      "account-a",
    ).map(normalizeSentinelTelemetryEvent);
  assertEquals(
    decode(
      { ...row, eventName: "GetKeyPolicy" },
      { ...row, eventName: "ListKeyPolicies" },
      { ...row, eventName: "CreateGrant" },
      { ...row, eventSource: "other.amazonaws.com" },
      { ...row, readOnly: true },
      { ...row, errorMessage: "Request failed" },
    ),
    [],
  );
  assertEquals(
    decode({ ...row, errorCode: "AccessDeniedException" }).map(({ kind }) =>
      kind
    ),
    ["authorization_denied"],
  );
  const events = decode(row, row);
  const alerts = events.flatMap(createTelemetryDetector().ingest);
  assertEquals(alerts.map(({ triggeringAction }) => triggeringAction), [
    "kms.amazonaws.com:PutKeyPolicy",
  ]);
  const coverage = assessSentinelDefenseCoverage({ alerts });
  assertEquals(
    coverage.upstreamChecks.find(({ id }) =>
      id === "cloudtrail_kms_key_policy_changed"
    )?.records.map(({ asset, evidenceIds }) => [asset, evidenceIds]),
    [["account-a", [events[0].id]]],
  );
  const output = JSON.stringify({ events, alerts, coverage });
  assertEquals(output.includes(keyId), false);
  assertEquals(output.includes("PrivatePolicyCanary"), false);
});

Deno.test("CloudTrail distinguishes KMS key disablement from scheduled deletion", () => {
  const keyId = "arn:aws:kms:us-east-1:123456789012:key/private-key-id";
  const base = {
    eventVersion: "1.11",
    eventTime: "2026-01-01T00:00:00Z",
    eventType: "AwsApiCall",
    eventCategory: "Management",
    eventSource: "kms.amazonaws.com",
    userIdentity: { principalId: "key-operator" },
    readOnly: false,
    resources: [{ type: "AWS::KMS::Key", ARN: keyId }],
  };
  const disabled = {
    ...base,
    eventID: "key-disabled",
    eventName: "DisableKey",
    requestParameters: { keyId },
    responseElements: { keyId },
  };
  const scheduled = {
    ...base,
    eventID: "deletion-scheduled",
    eventName: "ScheduleKeyDeletion",
    requestParameters: { keyId, pendingWindowInDays: 30 },
    responseElements: { keyId, keyState: "PendingDeletion" },
  };
  const decode = (...records: unknown[]) =>
    decodeSentinelFeedLine(
      JSON.stringify({ Records: records }),
      "cloudtrail",
      "account-a",
    ).map(normalizeSentinelTelemetryEvent);
  assertEquals(
    decode(
      { ...disabled, eventName: "EnableKey" },
      { ...disabled, eventName: "DisableKeyRotation" },
      { ...scheduled, eventName: "CancelKeyDeletion" },
      { ...scheduled, eventName: "DeleteKey", eventType: "AwsServiceEvent" },
      { ...disabled, eventSource: "other.amazonaws.com" },
      { ...disabled, readOnly: true },
      { ...scheduled, errorMessage: "Request failed" },
    ),
    [],
  );
  assertEquals(
    decode({ ...scheduled, errorCode: "AccessDenied" }).map(
      ({ kind }) => kind,
    ),
    ["authorization_denied"],
  );
  const events = decode(disabled, scheduled, scheduled);
  const alerts = events.flatMap(createTelemetryDetector().ingest);
  assertEquals(alerts.map(({ triggeringAction }) => triggeringAction), [
    "kms.amazonaws.com:DisableKey",
    "kms.amazonaws.com:ScheduleKeyDeletion",
  ]);
  const coverage = assessSentinelDefenseCoverage({ alerts });
  for (
    const [index, id] of [
      "cloudtrail_kms_key_disabled",
      "cloudtrail_kms_key_deletion_scheduled",
    ].entries()
  ) {
    assertEquals(
      coverage.upstreamChecks.find((check) => check.id === id)?.records
        .map(({ asset, evidenceIds }) => [asset, evidenceIds]),
      [["account-a", [events[index].id]]],
    );
  }
  assertEquals(
    JSON.stringify({ events, alerts, coverage }).includes(keyId),
    false,
  );
});

Deno.test("CloudTrail distinguishes confirmed GuardDuty and AWS Config coverage reductions", () => {
  const base = {
    eventVersion: "1.11",
    eventTime: "2026-01-01T00:00:00Z",
    userIdentity: { principalId: "audit-operator" },
    readOnly: false,
  };
  const guardDuty = {
    eventSource: "guardduty.amazonaws.com",
    eventName: "UpdateDetector",
    requestParameters: { enable: false, detail: "omit request detail" },
  };
  const config = {
    eventSource: "config.amazonaws.com",
    eventName: "StopConfigurationRecorder",
    requestParameters: { configurationRecorderName: "omit request detail" },
  };
  const records = [
    guardDuty,
    { ...guardDuty, eventName: "DeleteDetector", requestParameters: undefined },
    config,
    { ...config, eventName: "DeleteConfigurationRecorder" },
    { ...config, eventName: "DeleteServiceLinkedConfigurationRecorder" },
    { ...guardDuty, requestParameters: { enable: true } },
    { ...guardDuty, requestParameters: { enable: "false" } },
    { ...guardDuty, requestParameters: { features: [{ status: "DISABLED" }] } },
    { ...guardDuty, eventSource: "other.amazonaws.com" },
    { ...guardDuty, errorCode: "AccessDenied" },
    { ...config, readOnly: true },
    { ...config, errorMessage: "Configuration recorder is unavailable" },
    { ...config, eventName: "StartConfigurationRecorder" },
    { ...config, eventName: "PutConfigurationRecorder" },
  ].map((record, index) => ({ ...base, ...record, eventID: `audit-${index}` }));
  const events = decodeSentinelFeedLine(
    JSON.stringify({ Records: records }),
    "cloudtrail",
    "account-a",
  ).map(normalizeSentinelTelemetryEvent);
  assertEquals(events.map(({ action, kind }) => [action, kind]), [
    ["guardduty.amazonaws.com:UpdateDetector:disabled", "integrity_change"],
    ["guardduty.amazonaws.com:DeleteDetector", "integrity_change"],
    ["config.amazonaws.com:StopConfigurationRecorder", "integrity_change"],
    ["config.amazonaws.com:DeleteConfigurationRecorder", "integrity_change"],
    [
      "config.amazonaws.com:DeleteServiceLinkedConfigurationRecorder",
      "integrity_change",
    ],
    ["guardduty.amazonaws.com:UpdateDetector", "authorization_denied"],
  ]);
  assertEquals(JSON.stringify(events).includes("omit request detail"), false);
  const detector = createTelemetryDetector();
  const alerts = [...events, ...events].flatMap(detector.ingest);
  const { upstreamChecks } = assessSentinelDefenseCoverage({ alerts });
  const guardDutyCheck = upstreamChecks.find(({ id }) =>
    id === "cloudtrail_guardduty_detector_reduced"
  );
  const configCheck = upstreamChecks.find(({ id }) =>
    id === "cloudtrail_config_recorder_reduced"
  );
  for (
    const [check, expected] of [[guardDutyCheck, events.slice(0, 2)], [
      configCheck,
      events.slice(2, 5),
    ]] as const
  ) {
    assertEquals(
      check?.records.map(({ asset, evidenceIds }) => [asset, evidenceIds]),
      expected.map(({ id }) => ["account-a", [id]]),
    );
  }
});

Deno.test("CloudTrail authorization replay separates successful activity and cloud accounts", () => {
  const detector = createTelemetryDetector();
  const replay = (index: number, asset: string, denied: boolean) =>
    decodeSentinelFeedLine(
      JSON.stringify({
        eventVersion: "1.11",
        eventTime: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        eventID: `api-call-${index}`,
        eventName: "DescribeInstances",
        eventSource: "ec2.amazonaws.com",
        errorCode: denied ? "Client.UnauthorizedOperation" : undefined,
        userIdentity: { principalId: "example-principal" },
      }),
      "cloudtrail",
      asset,
    );
  const primary = Array.from(
    { length: DENIAL_LIMIT },
    (_, index) => replay(index, "account-a", true)[0],
  );
  const independent = replay(DENIAL_LIMIT, "account-b", true);
  const benign = replay(DENIAL_LIMIT + 1, "account-a", false);
  assertEquals(benign, []);
  assertEquals(
    [...primary.slice(0, -1), ...independent].flatMap(detector.ingest),
    [],
  );
  const final = replay(DENIAL_LIMIT + 2, "account-a", true)[0];
  assertEquals(detector.ingest(final), [{
    type: "authorization_denial_burst",
    severity: "medium",
    asset: "account-a",
    subject: "example-principal",
    observedAt: normalizeSentinelTelemetryEvent(final).timestamp,
    triggeringAction: "ec2.amazonaws.com:DescribeInstances",
    evidenceIds: [...primary.slice(0, -1), final].map((record) =>
      normalizeSentinelTelemetryEvent(record).id
    ),
  }]);
});

Deno.test("ECS egress replay separates allowed traffic, ingress, and independent destinations", () => {
  const detector = createTelemetryDetector();
  const replay = (
    index: number,
    outcome: string,
    direction = "egress",
    destination = "198.51.100.4",
  ) =>
    decodeSentinelFeedLine(
      JSON.stringify({
        "@timestamp": new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        event: {
          id: `network-${index}`,
          category: ["network"],
          type: [outcome],
        },
        network: { direction },
        source: { ip: "192.0.2.12" },
        destination: { ip: destination },
      }),
      "ecs",
    );
  const denied = Array.from(
    { length: DENIAL_LIMIT - 1 },
    (_, index) => replay(index, "denied")[0],
  );
  assertEquals(replay(DENIAL_LIMIT, "allowed"), []);
  assertEquals(replay(DENIAL_LIMIT + 1, "denied", "ingress"), []);
  const otherDestination = replay(
    DENIAL_LIMIT + 2,
    "denied",
    "egress",
    "198.51.100.5",
  );
  assertEquals([...denied, ...otherDestination].flatMap(detector.ingest), []);
  const final = replay(DENIAL_LIMIT + 3, "denied", "egress")[0];
  assertEquals(detector.ingest(final), [{
    type: "egress_denied_burst",
    severity: "medium",
    asset: "192.0.2.12",
    subject: "198.51.100.4",
    observedAt: normalizeSentinelTelemetryEvent(final).timestamp,
    evidenceIds: [...denied, final].map((record) =>
      normalizeSentinelTelemetryEvent(record).id
    ),
  }]);
});

Deno.test("CloudTrail links a temporary role session across case assets and requires unanimous burst evidence", () => {
  const identity = {
    type: "AssumedRole",
    accountId: "123456789012",
    principalId: "AROAEXAMPLE123456789:ops-session",
    accessKeyId: "ASIAAAAAAAAAAAAAAAAA",
    sessionContext: { attributes: { creationDate: "2026-01-01T00:00:00Z" } },
  };
  const base = {
    eventVersion: "1.11",
    eventTime: "2026-01-01T00:00:15Z",
    eventID: "policy-change",
    eventSource: "iam.amazonaws.com",
    eventName: "AttachRolePolicy",
    userIdentity: identity,
  };
  const decode = (record: object, asset: string) =>
    decodeSentinelFeedLine(JSON.stringify(record), "cloudtrail", asset)
      .map(normalizeSentinelTelemetryEvent);
  const [change] = decode(base, "management");
  const denial = (index: number, userIdentity = identity) =>
    decode({
      ...base,
      eventTime: `2026-01-01T00:00:0${index}Z`,
      eventID: `denial-${index}`,
      eventSource: "ec2.amazonaws.com",
      eventName: "DescribeInstances",
      errorCode: "AccessDenied",
      userIdentity,
    }, "workload")[0];
  assertMatch(change.sessionReference!, /^session:[a-f0-9]{64}$/);
  assertEquals(JSON.stringify(change).includes(identity.accessKeyId), false);
  const detector = createTelemetryDetector();
  const results = Array.from({ length: 5 }, (_, index) => denial(index))
    .flatMap(detector.ingest);
  const [integrity] = detector.ingest(change);
  const [burst] = results;
  assertEquals(burst.type, "authorization_denial_burst");
  assertEquals(burst.sessionReference, integrity.sessionReference);
  const graph = loadSentinelGraph({
    version: 1,
    nodes: [
      { id: "workload", kind: "asset", label: "Workload" },
      { id: "management", kind: "asset", label: "Management" },
    ],
    edges: [{ from: "workload", to: "management", relation: "depends_on" }],
  });
  const report = correlateSentinelIncidents([burst, integrity], { graph });
  assertEquals(report.candidates.length, 1);
  assertEquals(
    report.candidates[0].correlationBasis,
    "shared_session_reference",
  );
  const otherIdentity = { ...identity, accessKeyId: "ASIABBBBBBBBBBBBBBBB" };
  const mixed = createTelemetryDetector();
  assertEquals(
    denial(0, otherIdentity).sessionReference === change.sessionReference,
    false,
  );
  const [mixedBurst] = Array.from(
    { length: 5 },
    (_, index) => denial(index, index === 0 ? otherIdentity : identity),
  ).flatMap(mixed.ingest);
  assertEquals(mixedBurst.sessionReference, undefined);
  assertEquals(
    correlateSentinelIncidents([mixedBurst, integrity], { graph }).candidates,
    [],
  );
  for (
    const changes of [
      { type: "IAMUser" },
      { accessKeyId: "AKIAAAAAAAAAAAAAAAAA" },
      { accountId: undefined },
      { sessionContext: undefined },
    ]
  ) {
    assertEquals(
      denial(0, { ...identity, ...changes } as typeof identity)
        .sessionReference,
      undefined,
    );
  }
});

Deno.test("CloudTrail identity references correlate authority-scoped principals without joining conflicting sessions", () => {
  const userIdentity = {
    type: "IAMUser",
    accountId: "123456789012",
    principalId: "AIDAEXAMPLE123456789",
    userName: "example-user",
  };
  const source = {
    eventVersion: "1.11",
    eventTime: "2026-01-01T00:00:15Z",
    eventID: "policy-change",
    eventSource: "iam.amazonaws.com",
    eventName: "AttachRolePolicy",
    userIdentity,
  };
  const read = (raw: object, asset: string) =>
    decodeSentinelFeedLine(JSON.stringify(raw), "cloudtrail", asset)
      .map(normalizeSentinelTelemetryEvent)[0];
  const change = read(source, "management");
  const denial = (index: number, identity = userIdentity) =>
    read({
      ...source,
      eventTime: `2026-01-01T00:00:0${index}Z`,
      eventID: `denial-${index}`,
      eventSource: "ec2.amazonaws.com",
      eventName: "DescribeInstances",
      errorCode: "AccessDenied",
      userIdentity: identity,
    }, "workload");
  assertMatch(change.identityReference!, /^identity:[a-f0-9]{64}$/);
  assertEquals(change.identityReference, denial(0).identityReference);
  assertNotEquals(
    change.identityReference,
    denial(0, {
      ...userIdentity,
      accountId: "000000000001",
    }).identityReference,
  );
  assertEquals(
    read({
      ...source,
      userIdentity: {
        ...userIdentity,
        principalId: undefined,
      },
    }, "management").identityReference,
    undefined,
  );
  const detector = createTelemetryDetector();
  const [burst] = Array.from({ length: 5 }, (_, n) => ({
    ...denial(n),
    subject: "workload collector subject",
  })).flatMap(detector.ingest);
  const [integrity] = detector.ingest(change);
  assertEquals(burst.identityReference, integrity.identityReference);
  assertNotEquals(burst.subject, integrity.subject);
  const graph = loadSentinelGraph({
    version: 1,
    nodes: [
      { id: "workload", kind: "asset", label: "Workload" },
      { id: "management", kind: "asset", label: "Management" },
    ],
    edges: [{ from: "workload", to: "management", relation: "depends_on" }],
  });
  const [incident] =
    correlateSentinelIncidents([burst, integrity], { graph }).candidates;
  assertEquals(incident.correlationBasis, "shared_identity_reference");
  assertEquals(
    correlateSentinelIncidents([burst, {
      ...integrity,
      identityReference: undefined,
    }], { graph }).candidates,
    [],
  );
  assertEquals(
    correlateSentinelIncidents([
      { ...burst, sessionReference: `session:${"1".repeat(64)}` },
      { ...integrity, sessionReference: `session:${"2".repeat(64)}` },
    ], { graph }).candidates,
    [],
  );
  const mixed = createTelemetryDetector();
  const [mixedBurst] = Array.from({ length: 5 }, (_, n) => ({
    ...denial(
      n,
      n === 0 ? { ...userIdentity, accountId: "000000000001" } : userIdentity,
    ),
    subject: "workload collector subject",
  })).flatMap(mixed.ingest);
  assertEquals(mixedBurst.identityReference, undefined);
});
