import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeSentinelFeedLine,
  parseSentinelSyslogClock,
} from "../../src/sentinel/feed_adapters.ts";
import { normalizeSentinelTelemetryEvent } from "../../src/sentinel/telemetry.ts";

function decode(value: unknown, format: "ecs" | "journald") {
  return decodeSentinelFeedLine(JSON.stringify(value), format)
    .map(normalizeSentinelTelemetryEvent)
    .map(({ id: _id, ...record }) => record);
}

Deno.test("ECS adapter supports identity outcomes and explicit denied egress", () => {
  const record = { "@timestamp": "2026-11-24T12:34:56.123456789Z" };
  assertEquals(
    decode({
      ...record,
      event: { id: "auth-1", category: ["authentication"], outcome: "failure" },
      host: { name: "edge" },
      user: { name: "operator" },
    }, "ecs"),
    [{
      version: 1,
      timestamp: "2026-11-24T12:34:56.123Z",
      asset: "edge",
      kind: "auth_failure",
      subject: "operator",
    }],
  );
  const network = {
    ...record,
    event: { id: "web-1", category: ["network"], type: ["denied"] },
    source: { ip: "192.0.2.3" },
    destination: { ip: "198.51.100.2" },
  };
  assertEquals(
    decode({ ...network, network: { direction: "outbound" } }, "ecs"),
    [{
      version: 1,
      timestamp: "2026-11-24T12:34:56.123Z",
      asset: "192.0.2.3",
      kind: "egress_denied",
      subject: "198.51.100.2",
    }],
  );
  assertEquals(
    decode({ ...network, network: { direction: "inbound" } }, "ecs"),
    [],
  );
});

Deno.test("Journal adapter only maps OpenSSH authentication outcomes", () => {
  const record = {
    _COMM: "sshd-session",
    _HOSTNAME: "edge",
    __CURSOR: "cursor",
    __REALTIME_TIMESTAMP: "1764000000000000",
    MESSAGE:
      "Failed password for invalid user example from 192.0.2.2 port 60321 ssh2",
  };
  assertEquals(decode(record, "journald"), [{
    version: 1,
    timestamp: "2025-11-24T16:00:00.000Z",
    asset: "edge",
    kind: "auth_failure",
    subject: "example",
  }]);
  assertEquals(decode({ ...record, _COMM: "logger" }, "journald"), []);
});

Deno.test("Falco imports rule alerts without retaining process output", () => {
  const record = {
    time: "2026-11-24T12:34:56.123456789Z",
    rule: "Unexpected process activity",
    hostname: "runtime-sensor",
    source: "syscall",
    priority: "Warning",
    output: "private process command line",
    output_fields: { "proc.cmdline": "private process command line" },
  };
  const decode = (value: Record<string, unknown>, asset?: string) =>
    normalizeSentinelTelemetryEvent(
      decodeSentinelFeedLine(JSON.stringify(value), "falco", asset)[0],
    );
  const { id, ...event } = decode(record);
  const syslog = "<134>1 2026-11-24T12:35:00Z collector relay 12 ALERT - ";
  const [wrapped] = decodeSentinelFeedLine(
    syslog + JSON.stringify(record),
    "falco",
  );
  assertEquals(normalizeSentinelTelemetryEvent(wrapped), { id, ...event });
  const [legacy] = decodeSentinelFeedLine(
    "<134>Nov 24 12:35:00 collector relay[12]: " + JSON.stringify(record),
    "falco",
    undefined,
    undefined,
    { syslogClock: parseSentinelSyslogClock("2026@-07:00") },
  );
  assertEquals(normalizeSentinelTelemetryEvent(legacy), { id, ...event });
  assertThrows(() =>
    decodeSentinelFeedLine("<134>malformed " + JSON.stringify(record), "falco")
  );

  assertEquals(event, {
    version: 1,
    timestamp: "2026-11-24T12:34:56.123Z",
    kind: "security_sensor_alert",
    severity: "medium",
    asset: "runtime-sensor",
    subject: "Unexpected process activity",
    action: "falco:warning",
  });
  assertEquals(decode({ ...record, output: "changed display text" }).id, id);
  assertEquals(
    decode({ ...record, priority: "Critical" }).severity,
    "critical",
  );
  assertEquals(decode(record, "cluster-node").asset, "cluster-node");
  assertEquals(
    decode({ ...record, hostname: undefined }, "cluster-node").asset,
    "cluster-node",
  );
  assertThrows(() => decode({ ...record, hostname: undefined }));
  assertThrows(() => decode({ ...record, priority: "invalid" }));
});

Deno.test("Wazuh preserves rule identity and namespaces alert IDs by manager and agent", () => {
  const record = {
    timestamp: "2026-11-24T12:34:56.123+0100",
    id: "1769160011.119294",
    agent: { id: "002", name: "runtime-node" },
    manager: { name: "security-manager" },
    rule: { id: "100001", level: 12, description: "Private description" },
    full_log: "Unredacted process data",
    data: { private: "sensitive details" },
  };
  const decode = (value: Record<string, unknown>, asset?: string) =>
    normalizeSentinelTelemetryEvent(
      decodeSentinelFeedLine(JSON.stringify(value), "wazuh", asset)[0],
    );
  const { id, ...event } = decode(record);
  const syslog = "<134>1 2026-11-24T12:35:00Z collector relay 12 ALERT - ";
  const [wrapped] = decodeSentinelFeedLine(
    syslog + JSON.stringify(record),
    "wazuh",
  );
  assertEquals(normalizeSentinelTelemetryEvent(wrapped), { id, ...event });
  const [legacy] = decodeSentinelFeedLine(
    "<134>Nov 24 12:35:00 collector relay[12]: " + JSON.stringify(record),
    "wazuh",
    undefined,
    undefined,
    { syslogClock: parseSentinelSyslogClock("2026@-07:00") },
  );
  assertEquals(normalizeSentinelTelemetryEvent(legacy), { id, ...event });
  assertThrows(() =>
    decodeSentinelFeedLine("<134>malformed " + JSON.stringify(record), "wazuh")
  );

  assertEquals(event, {
    version: 1,
    timestamp: "2026-11-24T11:34:56.123Z",
    asset: "runtime-node",
    kind: "security_sensor_alert",
    severity: "high",
    subject: "Wazuh rule 100001",
    action: "wazuh:rule:100001:level:12",
  });
  assertEquals(decode({ ...record, full_log: "Different raw text" }).id, id);
  assertEquals(decode(record, "case-asset").asset, "case-asset");
  assertEquals(decode(record, "case-asset").id, id);
  assertEquals(
    decode({ ...record, manager: { name: "other-manager" } }).id === id,
    false,
  );
  assertThrows(() => decode({ ...record, rule: { id: "100001", level: -1 } }));
});
