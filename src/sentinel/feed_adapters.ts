/** Decode trusted collector output into Sentinel's normalized telemetry records. */

import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { importSentinelDnsObservation } from "./passive_dns.ts";
import { isSentinelTelemetryAction } from "./telemetry.ts";

import {
  adaptOktaSystemLogEvent,
  adaptWinlogbeatEvent,
} from "./identity_adapters.ts";
import { decodeSentinelCloudFeedLine } from "./cloud_adapters.ts";
import { adaptOcsfEvent } from "./ocsf_adapter.ts";
import { adaptEntraEvents } from "./entra_adapter.ts";
import { adaptCefAlert, type CefAlertSelector } from "./cef_adapter.ts";

const formats = [
  "jsonl",
  "syslog",
  "suricata",
  "zeek",
  "falco",
  "wazuh",
  "ecs",
  "journald",
  "winlogbeat",
  "okta",
  "guardduty",
  "scc",
  "ocsf",
  "entra",
  "cef",
  "kubernetes-audit",
  "cloudtrail",
] as const;

export type SentinelFeedFormat = typeof formats[number];

export interface SentinelFeedOptions {
  readonly privilegedGroups?: ReadonlySet<string>;
  readonly syslogClock?: { readonly year: string; readonly offset: string };
}

export function parseSentinelSyslogClock(value: unknown) {
  const match = typeof value === "string" &&
    /^([1-9][0-9]{3})@(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(value);
  if (!match || match[0] !== value) {
    throw new Error(
      "Expected --syslog-clock=YEAR@UTC_OFFSET, for example 2026@-07:00",
    );
  }
  const [, year, offset] = match;
  normalizeTimestamp(`${year}-07-01T00:00:00${offset}`);
  return { year, offset };
}

export function isSentinelFeedFormat(
  value: unknown,
): value is SentinelFeedFormat {
  return formats.some((format) => format === value);
}

const rfc5424Header =
  /^<(0|[1-9]\d{0,2})>1 ([!-~]{1,32}) ([!-~]{1,255}) ([!-~]{1,48}) ([!-~]{1,128}) [!-~]{1,32} /;
const structuredData =
  /^(-|(?:\[[!#-\x3c\x3e-\x5c\x5e-\x7e]{1,32}(?: [!#-\x3c\x3e-\x5c\x5e-\x7e]{1,32}="(?:[^"\\\]\r\n]|\\["\\\]])*")*\])+)(?: |$)/;
const timestampPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON");
  }
}

function normalizeTimestamp(raw: unknown): string {
  const parts = typeof raw === "string" ? timestampPattern.exec(raw) : null;
  if (!parts) throw new Error("Invalid feed timestamp");
  const [, seconds, fraction = "", timezone] = parts;
  const wallClock = `${seconds}.${fraction.padEnd(3, "0").slice(0, 3)}Z`;
  const local = Date.parse(wallClock);
  if (!Number.isFinite(local) || new Date(local).toISOString() !== wallClock) {
    throw new Error("Invalid feed calendar timestamp");
  }
  if (timezone === "Z") return wallClock;

  const hours = Number(timezone.slice(1, 3));
  const minutes = Number(timezone.slice(-2));
  if (hours > 23 || minutes > 59) throw new Error("Invalid feed UTC offset");
  const sign = timezone.startsWith("-") ? -1 : 1;
  const utc = new Date(local - sign * (hours * 60 + minutes) * 60_000)
    .toISOString();
  if (utc.length !== 24) {
    throw new Error("Feed timestamp is outside supported UTC range");
  }
  return utc;
}

const syslogMonths = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const rfc3164Header =
  /^<(0|[1-9][0-9]{0,2})>([A-Z][a-z]{2}) ( [1-9]|[12][0-9]|3[01]) ([0-9]{2}:[0-9]{2}:[0-9]{2}) ([!-~]{1,255}) (.*)$/;
const legacyProgram = /^([A-Za-z0-9_.-]{1,48})(?:\[([0-9]{1,20})\])?:\s*/;

function decodeLegacySyslog(
  text: string,
  clock: NonNullable<SentinelFeedOptions["syslogClock"]>,
) {
  const header = rfc3164Header.exec(text);
  if (!header || Number(header[1]) > 191) {
    throw new Error("Expected an RFC 3164 syslog message");
  }
  const month = syslogMonths.indexOf(header[2]) + 1;
  if (!month) throw new Error("Invalid RFC 3164 month");
  const day = header[3].trim().padStart(2, "0");
  const rawTimestamp = `${clock.year}-${
    String(month).padStart(2, "0")
  }-${day}T${header[4]}${clock.offset}`;
  const timestamp = normalizeTimestamp(rawTimestamp);
  const body = header[6];
  const tag = body.startsWith("CEF:") ? null : legacyProgram.exec(body);
  return {
    timestamp,
    rawTimestamp,
    hostname: header[5],
    appName: tag?.[1] ?? "-",
    processId: tag?.[2] ?? "-",
    message: tag ? body.slice(tag[0].length) : body,
  };
}

function decodeSyslogMessage(
  text: string,
  clock?: SentinelFeedOptions["syslogClock"],
) {
  const header = rfc5424Header.exec(text);
  if (!header && clock) return decodeLegacySyslog(text, clock);
  if (!header || Number(header[1]) > 191) {
    throw new Error("Expected an RFC 5424 syslog message");
  }
  const timestamp = header[2] === "-" ? "-" : normalizeTimestamp(header[2]);
  const body = text.slice(header[0].length);
  const metadata = structuredData.exec(body);
  if (!metadata) throw new Error("Invalid RFC 5424 structured data");
  const message = body.slice(metadata[0].length).trimStart();
  return {
    timestamp,
    rawTimestamp: header[2],
    hostname: header[3],
    appName: header[4],
    processId: header[5],
    message: message.replace(/^\uFEFF/, ""),
  };
}

function object(raw: unknown, name: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Expected a ${name} object`);
  }
  return raw as Record<string, unknown>;
}

function ip(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.includes("%") || isIP(raw) === 0) {
    throw new Error(`Invalid ${name}`);
  }
  return isIP(raw) === 6
    ? new URL(`http://[${raw}]/`).hostname.slice(1, -1)
    : raw;
}

function unsignedInteger(raw: unknown, max: number, field: string): number {
  if (
    typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > max
  ) {
    throw new Error(`Invalid Suricata EVE ${field}`);
  }
  return raw;
}

function correlationNumber(raw: unknown): string {
  // An oversized JSON integer has already lost precision in JSON.parse.
  // The other fields still distinguish records within the sensor feed.
  return Number.isSafeInteger(raw) && (raw as number) >= 0 ? String(raw) : "";
}

function evidenceId(source: string, fields: readonly unknown[]): string {
  const hash = createHash("sha256").update(JSON.stringify(fields));
  return `${source}:${hash.digest("hex")}`;
}

function decodeSuricata(text: string): readonly unknown[] {
  const record = object(parseJson(text), "Suricata EVE event");
  if (typeof record.event_type !== "string" || !record.event_type) {
    throw new Error("Expected a Suricata EVE event_type");
  }
  if (record.event_type !== "alert") return [];

  const signature = object(record.alert, "Suricata EVE alert");
  const sid = unsignedInteger(
    signature.signature_id,
    0xffffffff,
    "signature_id",
  );
  const gid = unsignedInteger(signature.gid ?? 1, 0xffffffff, "gid");
  const timestamp = normalizeTimestamp(record.timestamp);
  const source = ip(record.src_ip, "Suricata EVE src_ip");
  const asset = ip(record.dest_ip, "Suricata EVE dest_ip");
  const sourcePort = record.src_port === undefined
    ? ""
    : unsignedInteger(record.src_port, 65_535, "src_port");
  const destinationPort = record.dest_port === undefined
    ? ""
    : unsignedInteger(record.dest_port, 65_535, "dest_port");
  const protocol =
    typeof record.proto === "string" && /^[A-Z0-9]{1,16}$/.test(record.proto)
      ? record.proto
      : "";
  const id = evidenceId("eve", [
    record.timestamp,
    source,
    sourcePort,
    asset,
    destinationPort,
    protocol,
    gid,
    sid,
    correlationNumber(record.flow_id),
    correlationNumber(record.tx_id),
    correlationNumber(record.pcap_cnt),
  ]);

  return [{
    version: 1,
    id,
    timestamp,
    asset,
    kind: "network_security_alert",
    subject: `Suricata ${gid}:${sid}`,
    action: `suricata:${gid}:${sid}`,
  }];
}

/** Extract address evidence from detailed Suricata EVE DNS replies. */
export function importSentinelSuricataDns(raw: unknown, source: string) {
  const event = object(raw, "Suricata EVE record");
  if (event.event_type !== "dns") return [];
  const dns = object(event.dns, "Suricata EVE DNS record");
  if (
    (dns.type !== "answer" && dns.type !== "response") ||
    dns.rcode !== "NOERROR" || dns.qr === false || dns.tc === true ||
    (typeof dns.flags === "string" && /^[a-f0-9]{4}$/i.test(dns.flags) &&
      (Number.parseInt(dns.flags, 16) & 0x0200) !== 0) ||
    !Array.isArray(dns.answers)
  ) return [];

  const hostname = (value: unknown) =>
    typeof value === "string" ? value.toLowerCase().replace(/\.$/, "") : "";
  const records = new Map<string, { type: unknown; value: string }[]>();
  for (const rawAnswer of dns.answers) {
    const answer = object(rawAnswer, "Suricata DNS answer");
    const owner = hostname(answer.rrname);
    if (!owner || typeof answer.rdata !== "string") continue;
    const list = records.get(owner) ?? [];
    list.push({ type: answer.rrtype, value: answer.rdata });
    records.set(owner, list);
  }
  const questions = Array.isArray(dns.queries)
    ? dns.queries.slice(0, 16)
    : [dns];
  const timestamp = normalizeTimestamp(event.timestamp);
  return questions.flatMap((rawQuestion) => {
    const question = object(rawQuestion, "Suricata DNS query");
    const host = hostname(question.rrname);
    const family = question.rrtype === "A"
      ? 4
      : question.rrtype === "AAAA"
      ? 6
      : 0;
    if (!host || !family) return [];
    const addresses = new Set<string>();
    const seen = new Set<string>();
    let target = host;
    for (let depth = 0; target && depth < 8 && !seen.has(target); depth++) {
      seen.add(target);
      const answers = records.get(target) ?? [];
      for (const { type, value } of answers) {
        if (
          type === question.rrtype && !value.includes("%") &&
          isIP(value) === family
        ) {
          addresses.add(ip(value, "Suricata DNS address"));
        }
      }
      const aliases = new Set(
        answers.filter(({ type }) => type === "CNAME")
          .map(({ value }) => hostname(value)).filter(Boolean),
      );
      target = aliases.size === 1 ? aliases.values().next().value! : "";
    }
    return addresses.size
      ? [importSentinelDnsObservation({
        hostname: host,
        addresses: [...addresses].sort().slice(0, 16),
        timestamp,
      }, source)]
      : [];
  });
}

function decodeZeek(text: string): readonly unknown[] {
  const record = object(parseJson(text), "Zeek record");
  if (record.note === undefined) return [];
  const note = record.note;
  if (
    typeof note !== "string" || note.length > 240 ||
    !/^[A-Za-z0-9_]+(?:::[A-Za-z0-9_]+)*$/.test(note)
  ) {
    throw new Error("Invalid Zeek notice type");
  }
  const time = typeof record.ts === "number"
    ? new Date(record.ts * 1000)
    : undefined;
  if (!time || !Number.isFinite(time.getTime())) {
    throw new Error("Invalid Zeek notice timestamp");
  }
  const timestamp = time.toISOString();
  if (timestamp.length !== 24) {
    throw new Error("Unsupported Zeek notice UTC range");
  }
  const uid = record.uid;
  if (
    uid !== undefined &&
    (typeof uid !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(uid))
  ) {
    throw new Error("Invalid Zeek connection UID");
  }
  const destination = record["id.resp_h"] ?? record.dst;
  const source = record["id.orig_h"] ?? record.src;
  if (destination === undefined && source === undefined) return [];
  const asset = ip(destination ?? source, "Zeek notice asset");
  const id = evidenceId("zeek", [
    record.ts,
    uid,
    note,
    asset,
    source === undefined ? undefined : ip(source, "Zeek originator"),
  ]);
  return [{
    version: 1,
    id,
    timestamp,
    asset,
    kind: "network_security_alert",
    subject: `Zeek ${note}`,
    action: `zeek:${note}`,
  }];
}

function boundedText(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 256) {
    throw new Error(`Invalid ${field}`);
  }
  return raw;
}

function decodeEcs(text: string): readonly unknown[] {
  const record = object(parseJson(text), "Elastic Common Schema event");
  if (record.event === undefined) return [];
  const event = object(record.event, "ECS event metadata");
  if (event.category === undefined) return [];
  if (!Array.isArray(event.category)) {
    throw new Error("Expected ECS event categories");
  }
  if (
    event.category.includes("authentication") &&
    (event.outcome === "success" || event.outcome === "failure")
  ) {
    const host = object(record.host, "ECS host");
    const user = object(record.user, "ECS user");
    const timestamp = normalizeTimestamp(record["@timestamp"]);
    const asset = boundedText(host.name ?? host.id, "ECS asset");
    return [{
      version: 1,
      id: evidenceId("ecs", [asset, boundedText(event.id, "ECS event ID")]),
      timestamp,
      asset,
      kind: event.outcome === "success" ? "auth_success" : "auth_failure",
      subject: boundedText(user.name ?? user.id, "ECS account"),
    }];
  }

  if (
    event.category.includes("network") && Array.isArray(event.type) &&
    event.type.includes("denied") && record.network !== undefined
  ) {
    const network = object(record.network, "ECS network");
    if (network.direction === "egress" || network.direction === "outbound") {
      const source = object(record.source, "ECS source");
      const destination = object(record.destination, "ECS destination");
      const asset = ip(source.ip, "ECS egress source");
      return [{
        version: 1,
        id: evidenceId("ecs", [asset, boundedText(event.id, "ECS event ID")]),
        timestamp: normalizeTimestamp(record["@timestamp"]),
        asset,
        kind: "egress_denied",
        subject: ip(destination.ip, "ECS egress destination"),
      }];
    }
  }

  if (
    event.kind !== "alert" || !event.category.includes("intrusion_detection")
  ) return [];
  const destination = record.destination === undefined
    ? undefined
    : object(record.destination, "ECS destination");
  const host = record.host === undefined
    ? undefined
    : object(record.host, "ECS host");
  const asset = boundedText(
    destination?.ip ?? host?.name ?? host?.id,
    "ECS alert asset",
  );
  const rule = object(record.rule, "ECS rule");
  return [{
    version: 1,
    id: evidenceId("ecs", [asset, boundedText(event.id, "ECS event ID")]),
    timestamp: normalizeTimestamp(record["@timestamp"]),
    asset,
    kind: "security_sensor_alert",
    subject: `ECS ${boundedText(rule.id, "ECS rule ID").slice(0, 252)}`,
  }];
}

const opensshPrograms = new Set(["sshd", "sshd-session", "sshd-auth"]);

function parseOpenSshAuth(message: unknown) {
  if (typeof message !== "string") return undefined;
  const auth =
    /^(Accepted|Failed) ([\w@./-]+) for (?:invalid user )?([^\s]+) from (\S+) port (\d+) ssh2(?:$|: )/
      .exec(message);
  if (!auth || isIP(auth[4]) === 0 || Number(auth[5]) > 65535) return undefined;
  return {
    kind: auth[1] === "Accepted" ? "auth_success" : "auth_failure",
    method: auth[2],
    subject: boundedText(auth[3], "OpenSSH account"),
    peer: auth[4],
    port: auth[5],
  };
}

function decodeSyslog(
  text: string,
  assetOverride?: string,
  clock?: SentinelFeedOptions["syslogClock"],
): readonly unknown[] {
  const { timestamp, rawTimestamp, hostname, appName, processId, message } =
    decodeSyslogMessage(text, clock);
  const payload = message.trimStart();
  if (payload.startsWith("{")) return [parseJson(payload)];
  if (!opensshPrograms.has(appName)) return [];
  const auth = parseOpenSshAuth(payload);
  if (!auth) return [];
  if (timestamp === "-" || (hostname === "-" && assetOverride === undefined)) {
    throw new Error(
      "OpenSSH syslog requires a timestamp and a host or explicit asset",
    );
  }
  const asset = boundedText(assetOverride ?? hostname, "OpenSSH syslog asset");
  const { kind, subject, method, peer, port } = auth;
  return [{
    version: 1,
    id: evidenceId("ssh-syslog", [
      hostname,
      appName,
      processId,
      rawTimestamp,
      kind,
      subject,
      method,
      peer,
      port,
    ]),
    timestamp,
    asset,
    kind,
    subject,
  }];
}

function decodeJournal(text: string): readonly unknown[] {
  const record = object(parseJson(text), "systemd journal entry");
  if (typeof record._COMM !== "string" || !opensshPrograms.has(record._COMM)) {
    return [];
  }
  const auth = parseOpenSshAuth(record.MESSAGE);
  if (!auth) return [];
  const rawTime = record.__REALTIME_TIMESTAMP;
  if (typeof rawTime !== "string" || !/^\d{1,16}$/.test(rawTime)) {
    throw new Error("Invalid journal timestamp");
  }
  const timestamp = new Date(Math.trunc(Number(rawTime) / 1000)).toISOString();
  const asset = boundedText(record._HOSTNAME, "journal hostname");
  return [{
    version: 1,
    id: evidenceId("journal", [
      asset,
      boundedText(record.__CURSOR, "journal cursor"),
    ]),
    timestamp,
    asset,
    kind: auth.kind,
    subject: auth.subject,
  }];
}

const MAX_ENTRA_RECORDS = 1000;

function decodeEntra(text: string): readonly unknown[] {
  const envelope = object(parseJson(text), "Entra feed");
  if (!Object.hasOwn(envelope, "records")) return adaptEntraEvents(envelope);

  if (
    !Array.isArray(envelope.records) ||
    envelope.records.length > MAX_ENTRA_RECORDS
  ) {
    throw new Error(
      `Expected an Entra records array of at most ${MAX_ENTRA_RECORDS} records`,
    );
  }
  const events: unknown[] = [];
  for (const record of envelope.records) {
    events.push(...adaptEntraEvents(record));
    if (events.length > MAX_ENTRA_RECORDS) {
      throw new Error(
        `Entra feed exceeds ${MAX_ENTRA_RECORDS} normalized events`,
      );
    }
  }
  return events;
}

/** Use API audit metadata and retain only the cluster and event subject. */
function decodeKubernetesAudit(
  text: string,
  source?: string,
): readonly unknown[] {
  if (!source?.trim()) {
    throw new Error("Kubernetes audit requires a cluster asset ID");
  }
  const envelope = object(parseJson(text), "Kubernetes audit record");
  if (envelope.apiVersion !== "audit.k8s.io/v1") {
    throw new Error("Expected a Kubernetes audit.k8s.io/v1 record");
  }
  if (envelope.kind === "Event") {
    return adaptKubernetesAuditEvent(envelope, source);
  }
  if (
    envelope.kind !== "EventList" || !Array.isArray(envelope.items) ||
    envelope.items.length > 1000
  ) {
    throw new Error(
      "Expected a Kubernetes audit Event or an EventList with up to 1000 events",
    );
  }
  return envelope.items.flatMap((raw) => {
    const event = object(raw, "Kubernetes audit event");
    if (
      (event.apiVersion !== undefined &&
        event.apiVersion !== envelope.apiVersion) ||
      (event.kind !== undefined && event.kind !== "Event")
    ) {
      throw new Error("Unexpected object in Kubernetes audit EventList");
    }
    return adaptKubernetesAuditEvent(event, source);
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

const kubernetesPolicyVerbs = new Set([
  "create",
  "update",
  "patch",
  "delete",
  "deletecollection",
]);

/** Read policy mutation metadata without copying request content. */
function kubernetesPolicyAction(
  event: Record<string, unknown>,
  target: Record<string, unknown> | undefined,
  response: Record<string, unknown>,
): string | undefined {
  const { code, status } = response;
  const { verb, requestURI, requestObject } = event;
  if (
    typeof code !== "number" || !Number.isInteger(code) || code < 200 ||
    code >= 300 || (status !== undefined && status !== "Success") ||
    typeof verb !== "string" || !kubernetesPolicyVerbs.has(verb) || !target ||
    (target.subresource !== undefined && target.subresource !== "")
  ) return;
  const { apiGroup, resource } = target;
  const binding = apiGroup === "rbac.authorization.k8s.io" &&
    (resource === "rolebindings" || resource === "clusterrolebindings");
  const role = apiGroup === "rbac.authorization.k8s.io" &&
    (resource === "roles" || resource === "clusterroles");
  const network = apiGroup === "networking.k8s.io" &&
    resource === "networkpolicies";
  const admissionControl = apiGroup === "admissionregistration.k8s.io" &&
    (resource === "validatingwebhookconfigurations" ||
      resource === "mutatingwebhookconfigurations" ||
      resource === "validatingadmissionpolicies" ||
      resource === "validatingadmissionpolicybindings");
  if (!binding && !role && !network && !admissionControl) return;

  // Earlier binding exports may lack the URI. The new policy checks
  // require it to rule out a reported URL dry-run.
  if (requestURI === undefined) {
    if (!binding) return;
  } else {
    if (
      typeof requestURI !== "string" || !requestURI.startsWith("/") ||
      requestURI.length > 8192
    ) return;
    const query = requestURI.indexOf("?");
    if (
      query >= 0 && new URLSearchParams(requestURI.slice(query + 1))
        .getAll("dryRun").some((value) => value !== "")
    ) return;
  }
  if (
    (verb === "delete" || verb === "deletecollection") &&
    requestObject !== null && typeof requestObject === "object" &&
    !Array.isArray(requestObject)
  ) {
    const dryRun = (requestObject as Record<string, unknown>).dryRun;
    if (Array.isArray(dryRun) && dryRun.length > 0) return;
  }
  return `kubernetes-audit:${resource}:${verb}`;
}

function adaptKubernetesAuditEvent(
  event: Record<string, unknown>,
  source: string,
) {
  if (event.stage !== "ResponseComplete") return [];
  const response = object(
    event.responseStatus,
    "Kubernetes audit response status",
  );
  const status = response.code;
  const target = event.objectRef == null
    ? undefined
    : object(event.objectRef, "Kubernetes audit object reference");
  const action = kubernetesPolicyAction(event, target, response);
  const kind = status === 401
    ? "auth_failure"
    : status === 403
    ? "authorization_denied"
    : action
    ? "integrity_change"
    : undefined;
  if (!kind) return [];
  const auditId = event.auditID;
  if (
    typeof auditId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(auditId)
  ) {
    throw new Error("Invalid Kubernetes audit ID");
  }
  const user = event.user == null
    ? undefined
    : object(event.user, "Kubernetes audit user");
  const subject = boundedText(
    user?.username ?? "system:anonymous",
    "Kubernetes audit username",
  );
  return [{
    version: 1,
    id: evidenceId("kubernetes-audit", [source, auditId.toLowerCase()]),
    timestamp: normalizeTimestamp(event.stageTimestamp),
    asset: source,
    kind,
    subject,
    ...(action && { action }),
  }];
}

const cloudTrailPolicyChanges = new Set([
  "AttachGroupPolicy",
  "AttachRolePolicy",
  "AttachUserPolicy",
  "DetachGroupPolicy",
  "DetachRolePolicy",
  "DetachUserPolicy",
  "PutGroupPolicy",
  "PutRolePolicy",
  "PutUserPolicy",
  "DeleteGroupPolicy",
  "DeleteRolePolicy",
  "DeleteUserPolicy",
  "SetDefaultPolicyVersion",
  "UpdateAssumeRolePolicy",
]);

const cloudTrailAuditChanges = new Set([
  "StopLogging",
  "DeleteTrail",
  "UpdateTrail",
  "PutEventSelectors",
  "PutInsightSelectors",
  "StopEventDataStoreIngestion",
  "DeleteEventDataStore",
  "UpdateEventDataStore",
]);

const configRecorderStops = new Set([
  "StopConfigurationRecorder",
  "DeleteConfigurationRecorder",
  "DeleteServiceLinkedConfigurationRecorder",
]);

function cloudTrailMutationSucceeded(event: Record<string, unknown>): boolean {
  const { errorCode, errorMessage, readOnly } = event;
  return errorCode === undefined && errorMessage === undefined &&
    (readOnly === undefined || readOnly === false);
}

function cloudTrailAccessKeyChange(event: Record<string, unknown>) {
  if (
    event.eventSource !== "iam.amazonaws.com" ||
    !cloudTrailMutationSucceeded(event)
  ) return undefined;
  if (event.eventName === "CreateAccessKey") {
    return "iam.amazonaws.com:CreateAccessKey";
  }
  const parameters = event.requestParameters;
  if (
    event.eventName === "UpdateAccessKey" && parameters !== null &&
    typeof parameters === "object" && !Array.isArray(parameters) &&
    Object.hasOwn(parameters, "status") &&
    (parameters as { status: unknown }).status === "Active"
  ) return "iam.amazonaws.com:UpdateAccessKey:active";
  return undefined;
}

/** Source action for confirmed reductions in security service coverage. */
function cloudTrailControlReduction(event: Record<string, unknown>) {
  const { eventSource, eventName } = event;
  if (
    typeof eventName !== "string" || !cloudTrailMutationSucceeded(event)
  ) return undefined;

  if (
    eventSource === "logs.amazonaws.com" &&
    (eventName === "DeleteLogGroup" || eventName === "DeleteLogStream" ||
      eventName === "DeleteSubscriptionFilter" ||
      eventName === "PutSubscriptionFilter")
  ) return `${eventSource}:${eventName}`;
  if (
    eventSource === "config.amazonaws.com" && configRecorderStops.has(eventName)
  ) {
    return `${eventSource}:${eventName}`;
  }
  if (
    eventSource === "securityhub.amazonaws.com" &&
    (eventName === "DisableSecurityHub" ||
      eventName === "BatchDisableStandards")
  ) {
    return `${eventSource}:${eventName}`;
  }
  if (
    eventSource === "s3.amazonaws.com" &&
    eventName === "DeleteBucketPublicAccessBlock"
  ) return `${eventSource}:${eventName}`;
  if (
    eventSource === "ec2.amazonaws.com" &&
    (eventName === "DisableSnapshotBlockPublicAccess" ||
      eventName === "DisableImageBlockPublicAccess")
  ) return `${eventSource}:${eventName}`;
  const parameters = event.requestParameters;
  if (eventSource === "macie2.amazonaws.com") {
    if (eventName === "DisableMacie") return `${eventSource}:${eventName}`;
    if (
      eventName === "UpdateMacieSession" && parameters !== null &&
      typeof parameters === "object" && !Array.isArray(parameters) &&
      Object.hasOwn(parameters, "status") &&
      (parameters as { status: unknown }).status === "PAUSED"
    ) return `${eventSource}:${eventName}:paused`;
  }
  if (eventSource !== "guardduty.amazonaws.com") return undefined;
  if (eventName === "DeleteDetector") return `${eventSource}:${eventName}`;
  if (
    eventName === "UpdateDetector" && parameters !== null &&
    typeof parameters === "object" && !Array.isArray(parameters) &&
    Object.hasOwn(parameters, "enable") &&
    (parameters as { enable: unknown }).enable === false
  ) {
    return `${eventSource}:${eventName}:disabled`;
  }
  return undefined;
}

function cloudTrailSessionReference(
  identity: Record<string, unknown>,
): string | undefined {
  const { type, accountId, principalId, accessKeyId, sessionContext } =
    identity;
  const created =
    (sessionContext as { attributes?: { creationDate?: unknown } } | null)
      ?.attributes?.creationDate;
  if (
    type !== "AssumedRole" || typeof accountId !== "string" ||
    !/^\d{12}$/.test(accountId) ||
    typeof principalId !== "string" ||
    !/^AROA[A-Z0-9]+:[A-Za-z0-9_+=,.@-]{2,64}$/.test(principalId) ||
    typeof accessKeyId !== "string" ||
    !/^ASIA[A-Z0-9]{16}$/.test(accessKeyId) ||
    typeof created !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created) ||
    !Number.isFinite(Date.parse(created)) ||
    new Date(created).toISOString() !== created.replace("Z", ".000Z")
  ) return undefined;
  return `session:${
    createHash("sha256")
      .update(
        JSON.stringify([
          "aws-sts",
          accountId,
          principalId,
          accessKeyId,
          created,
        ]),
      )
      .digest("hex")
  }`;
}

function decodeCloudTrail(text: string, source?: string): readonly unknown[] {
  if (!source?.trim()) {
    throw new Error("CloudTrail requires an account asset ID");
  }
  const envelope = object(parseJson(text), "CloudTrail record");
  const records = Object.hasOwn(envelope, "Records")
    ? envelope.Records
    : [envelope];
  if (!Array.isArray(records) || records.length > 1000) {
    throw new Error(
      "Expected a CloudTrail Records array with up to 1000 events",
    );
  }
  return records.flatMap((raw) => {
    const event = object(raw, "CloudTrail event");
    if (
      typeof event.eventVersion !== "string" ||
      !/^1\.\d+$/.test(event.eventVersion)
    ) {
      throw new Error("Expected a CloudTrail version 1 event");
    }
    const consoleLogin = event.eventSource === "signin.amazonaws.com" &&
      event.eventName === "ConsoleLogin";
    const loginOutcome = consoleLogin && event.responseElements != null
      ? object(event.responseElements, "CloudTrail console response")
        .ConsoleLogin
      : undefined;
    const error = event.errorCode;
    const denied = typeof error === "string" &&
      /^(?:AccessDenied(?:Exception)?|(?:Client\.)?UnauthorizedOperation|AuthorizationError(?:Exception)?)$/
        .test(error);
    const controlReduction = cloudTrailControlReduction(event);
    const accessKeyChange = cloudTrailAccessKeyChange(event);
    const securityConfigurationChange = cloudTrailMutationSucceeded(event) &&
      typeof event.eventName === "string" &&
      ((event.eventSource === "iam.amazonaws.com" &&
        (cloudTrailPolicyChanges.has(event.eventName) ||
          event.eventName === "DeleteAccountPasswordPolicy" ||
          event.eventName === "UpdateAccountPasswordPolicy")) ||
        (event.eventSource === "cloudtrail.amazonaws.com" &&
          cloudTrailAuditChanges.has(event.eventName)) ||
        (event.eventSource === "s3.amazonaws.com" &&
          (event.eventName === "PutAccountPublicAccessBlock" ||
            event.eventName === "DeleteAccountPublicAccessBlock")) ||
        (event.eventSource === "kms.amazonaws.com" &&
          (event.eventName === "DisableKey" ||
            event.eventName === "ScheduleKeyDeletion" ||
            event.eventName === "PutKeyPolicy")));
    const kind = loginOutcome === "Success"
      ? "auth_success"
      : loginOutcome === "Failure"
      ? "auth_failure"
      : consoleLogin
      ? undefined
      : denied
      ? "authorization_denied"
      : securityConfigurationChange || controlReduction || accessKeyChange
      ? "integrity_change"
      : undefined;
    if (!kind) return [];
    const identity = object(event.userIdentity, "CloudTrail user identity");
    if (consoleLogin && !identity.principalId && !identity.arn) return [];
    const subject = boundedText(
      identity.principalId ?? identity.arn ?? identity.type,
      "CloudTrail principal",
    );
    const { type, accountId, principalId } = identity;
    const identityReference = type === "IAMUser" &&
        typeof accountId === "string" && /^\d{12}$/.test(accountId) &&
        typeof principalId === "string" &&
        /^AIDA[A-Z0-9]{8,64}$/.test(principalId)
      ? `identity:${
        createHash("sha256").update(
          JSON.stringify(["aws-iam-user", accountId, principalId]),
        ).digest("hex")
      }`
      : undefined;
    const loginData = event.additionalEventData;
    const rootWithoutMfa = consoleLogin && kind === "auth_success" &&
      type === "Root" && cloudTrailMutationSucceeded(event) &&
      loginData !== null && typeof loginData === "object" &&
      Object.hasOwn(loginData, "MFAUsed") &&
      (loginData as { MFAUsed: unknown }).MFAUsed === "No";
    const sessionReference = cloudTrailSessionReference(identity);
    const eventId = boundedText(event.eventID, "CloudTrail event ID");
    const action = (rootWithoutMfa
      ? "signin.amazonaws.com:ConsoleLogin:root-without-mfa"
      : undefined) ??
      controlReduction ?? accessKeyChange ??
      (typeof event.eventSource === "string" &&
          typeof event.eventName === "string"
        ? `${event.eventSource}:${event.eventName}`
        : undefined);
    return [{
      version: 1,
      id: evidenceId("cloudtrail", [source, eventId]),
      timestamp: normalizeTimestamp(event.eventTime),
      asset: source,
      kind,
      subject,
      ...(isSentinelTelemetryAction(action) && { action }),
      ...(sessionReference && { sessionReference }),
      ...(identityReference && { identityReference }),
    }];
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

const falcoSeverities = {
  emergency: "critical",
  alert: "critical",
  critical: "critical",
  error: "high",
  warning: "medium",
  notice: "low",
  informational: "low",
  debug: "low",
} as const;

function parseSensorJson(
  text: string,
  clock?: SentinelFeedOptions["syslogClock"],
): unknown {
  const line = text.trimStart();
  return parseJson(
    line.startsWith("<") ? decodeSyslogMessage(line, clock).message : line,
  );
}

function decodeFalco(
  text: string,
  assetOverride?: string,
  clock?: SentinelFeedOptions["syslogClock"],
): readonly unknown[] {
  const record = object(parseSensorJson(text, clock), "Falco JSON alert");
  const rule = boundedText(record.rule, "Falco rule");
  const timestamp = normalizeTimestamp(record.time);
  const priority = boundedText(record.priority, "Falco priority").toLowerCase();
  const severity = Object.hasOwn(falcoSeverities, priority)
    ? falcoSeverities[priority as keyof typeof falcoSeverities]
    : undefined;
  if (!severity) throw new Error("Invalid Falco priority");
  const hostname = record.hostname === undefined && assetOverride !== undefined
    ? undefined
    : boundedText(record.hostname, "Falco hostname");
  const asset = boundedText(assetOverride ?? hostname, "Falco asset");
  const source = record.source === undefined
    ? undefined
    : boundedText(record.source, "Falco event source");
  return [{
    version: 1,
    id: evidenceId("falco", [
      asset,
      hostname,
      record.time,
      rule,
      priority,
      source,
    ]),
    timestamp,
    asset,
    kind: "security_sensor_alert",
    severity,
    subject: rule,
    action: `falco:${priority}`,
  }];
}

function decodeWazuh(
  text: string,
  assetOverride?: string,
  clock?: SentinelFeedOptions["syslogClock"],
): readonly unknown[] {
  const record = object(parseSensorJson(text, clock), "Wazuh JSON alert");
  const rule = object(record.rule, "Wazuh rule");
  const agent = object(record.agent, "Wazuh agent");
  const manager = object(record.manager, "Wazuh manager");
  const ruleId = boundedText(rule.id, "Wazuh rule ID");
  if (!/^\d{1,16}$/.test(ruleId)) throw new Error("Invalid Wazuh rule ID");
  const level = rule.level;
  if (
    typeof level !== "number" || !Number.isInteger(level) || level < 0 ||
    level > 16
  ) {
    throw new Error("Invalid Wazuh rule level");
  }
  const alertId = boundedText(record.id, "Wazuh alert ID");
  const managerName = boundedText(manager.name, "Wazuh manager name");
  const agentId = boundedText(agent.id, "Wazuh agent ID");
  const asset = boundedText(assetOverride ?? agent.name, "Wazuh asset");
  return [{
    version: 1,
    id: evidenceId("wazuh", [managerName, agentId, alertId]),
    timestamp: normalizeTimestamp(record.timestamp),
    asset,
    kind: "security_sensor_alert",
    severity: level >= 15
      ? "critical"
      : level >= 12
      ? "high"
      : level >= 5
      ? "medium"
      : "low",
    subject: `Wazuh rule ${ruleId}`,
    action: `wazuh:rule:${ruleId}:level:${level}`,
  }];
}

/** Decode one line. The caller owns transport authentication and event validation. */
export function decodeSentinelFeedLine(
  text: string,
  format: SentinelFeedFormat,
  source?: string,
  selectors?: readonly CefAlertSelector[],
  options?: SentinelFeedOptions,
): readonly unknown[] {
  switch (format) {
    case "jsonl":
      return [parseJson(text)];
    case "syslog":
      return decodeSyslog(text, source, options?.syslogClock);
    case "cef": {
      if (!selectors?.length) {
        throw new Error("CEF requires explicit alert selectors");
      }
      const { message, hostname, timestamp } = decodeSyslogMessage(
        text,
        options?.syslogClock,
      );
      return adaptCefAlert(message, timestamp, hostname, selectors);
    }
    case "suricata":
      return decodeSuricata(text);
    case "zeek":
      return decodeZeek(text);
    case "falco":
      return decodeFalco(text, source, options?.syslogClock);
    case "wazuh":
      return decodeWazuh(text, source, options?.syslogClock);
    case "ecs":
      return decodeEcs(text);
    case "journald":
      return decodeJournal(text);
    case "winlogbeat": {
      const event = adaptWinlogbeatEvent(
        parseJson(text),
        options?.privilegedGroups,
      );
      return event ? [event] : [];
    }
    case "okta": {
      if (!source) throw new Error("Okta requires an explicit tenant asset ID");
      const event = adaptOktaSystemLogEvent(parseJson(text), source);
      return event ? [event] : [];
    }
    case "guardduty":
    case "scc": {
      const event = decodeSentinelCloudFeedLine(text, format);
      return event ? [event] : [];
    }
    case "ocsf":
      return adaptOcsfEvent(parseJson(text));
    case "entra":
      return decodeEntra(text);
    case "kubernetes-audit":
      return decodeKubernetesAudit(text, source);
    case "cloudtrail":
      return decodeCloudTrail(text, source);
  }
}
