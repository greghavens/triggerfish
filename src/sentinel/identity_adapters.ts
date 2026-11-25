/** Normalize selected events from trusted Windows and Okta log collectors. */
import { isIP } from "node:net";

interface IdentityEvent {
  readonly version: 1;
  readonly id: string;
  readonly timestamp: string;
  readonly asset: string;
  readonly kind:
    | "auth_success"
    | "auth_failure"
    | "integrity_change"
    | "egress_denied";
  readonly subject: string;
  readonly action?: string;
}

const timestampPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;
const windowsAuthentications = new Map<string, "auth_success" | "auth_failure">(
  [
    ["4624", "auth_success"],
    ["4625", "auth_failure"],
  ] as const,
);

const defenderChannel = "microsoft-windows-windows defender/operational";
const defenderSignals = new Map<string, {
  readonly kind:
    | "security_sensor_alert"
    | "network_security_alert"
    | "integrity_change";
  readonly subject: string;
}>([
  ["1116", {
    kind: "security_sensor_alert",
    subject: "defender-threat-detected",
  }],
  ["1118", {
    kind: "security_sensor_alert",
    subject: "defender-remediation-failed",
  }],
  ["1119", {
    kind: "security_sensor_alert",
    subject: "defender-remediation-critical-failure",
  }],
  ["1121", {
    kind: "security_sensor_alert",
    subject: "defender-attack-surface-reduction-blocked",
  }],
  ["1123", {
    kind: "security_sensor_alert",
    subject: "defender-controlled-folder-access-blocked",
  }],
  ["1126", {
    kind: "network_security_alert",
    subject: "defender-network-protection-blocked",
  }],
  ["1127", {
    kind: "security_sensor_alert",
    subject: "defender-controlled-folder-sector-write-blocked",
  }],
  ["5001", {
    kind: "integrity_change",
    subject: "defender-real-time-protection-disabled",
  }],
  ["5010", {
    kind: "integrity_change",
    subject: "defender-malware-scanning-disabled",
  }],
  ["5012", {
    kind: "integrity_change",
    subject: "defender-virus-scanning-disabled",
  }],
  ["5013", {
    kind: "security_sensor_alert",
    subject: "defender-tamper-protection-blocked-change",
  }],
  ["5101", {
    kind: "integrity_change",
    subject: "defender-protection-expired",
  }],
]);

const mitigationChannels = new Set([
  "microsoft-windows-security-mitigations/kernelmode",
  "microsoft-windows-security-mitigations/usermode",
]);
const mitigationBlocks = new Map([
  ["2", "arbitrary-code-guard"],
  ["4", "child-process"],
  ["6", "low-integrity-image"],
  ["8", "remote-image"],
  ["10", "win32k-system-call"],
  ["12", "code-integrity-guard"],
  ["14", "export-address-filter"],
  ["16", "enhanced-export-address-filter"],
  ["18", "import-address-filter"],
  ["20", "stack-pivot"],
  ["22", "caller-check"],
  ["24", "simulated-execution-check"],
]);

function exploitProtectionBlock(eventId: string, rawProvider: unknown) {
  const provider = typeof rawProvider === "string"
    ? rawProvider.toLowerCase()
    : "";
  switch (provider) {
    case "microsoft-windows-security-mitigations": {
      const subject = mitigationBlocks.get(eventId);
      return subject && { provider, subject, channels: mitigationChannels };
    }
    case "microsoft-windows-wer-diag":
      return eventId === "5"
        ? {
          provider,
          subject: "control-flow-guard",
          channels: werChannels,
        }
        : undefined;
    case "microsoft-windows-win32k":
    case "win32k":
      return eventId === "260"
        ? {
          provider,
          subject: "untrusted-font",
          channels: win32kChannels,
        }
        : undefined;
  }
}

const werChannels = new Set(["microsoft-windows-wer-diag/operational"]);
const win32kChannels = new Set(["microsoft-windows-win32k/operational"]);

function object(raw: unknown, name: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Expected a ${name} object`);
  }
  return raw as Record<string, unknown>;
}

function identifier(raw: unknown, name: string): string {
  if (
    typeof raw !== "string" || !raw.trim() || raw.length > 256 ||
    [...raw].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return raw;
}

function timestamp(raw: unknown, name: string): string {
  const match = typeof raw === "string" ? timestampPattern.exec(raw) : null;
  if (!match) throw new Error(`Expected a UTC ${name} timestamp`);
  const [, seconds, fraction = ""] = match;
  const normalized = `${seconds}.${fraction.padEnd(3, "0").slice(0, 3)}Z`;
  const time = Date.parse(normalized);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== normalized) {
    throw new Error(`Invalid ${name} calendar timestamp`);
  }
  return normalized;
}

function recordId(raw: unknown): string {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return String(raw);
  }
  if (typeof raw === "string" && /^(0|[1-9][0-9]{0,19})$/.test(raw)) {
    if (BigInt(raw) <= 0xffffffffffffffffn) return raw;
  }
  throw new Error("Invalid Winlogbeat record ID");
}

function targetAccount(raw: unknown): string | undefined {
  const event = object(raw, "Winlogbeat event_data");
  const user = event.TargetUserName;
  if (user === undefined || user === "" || user === "-") return undefined;
  const name = identifier(user, "Windows target user").toLowerCase();
  const rawDomain = event.TargetDomainName;
  const domain =
    rawDomain === undefined || rawDomain === "" || rawDomain === "-"
      ? ""
      : identifier(rawDomain, "Windows target domain").toLowerCase();
  return identifier(domain ? `${domain}\\${name}` : name, "Windows account");
}

function blockedOutboundAddress(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const { Direction, DestAddress } = object(raw, "Winlogbeat event_data");
  if (
    Direction !== "%%14593" &&
    !(typeof Direction === "string" && Direction.toLowerCase() === "outbound")
  ) {
    return undefined;
  }
  if (
    typeof DestAddress !== "string" || DestAddress.length > 45 ||
    DestAddress.includes("%")
  ) {
    return undefined;
  }
  const family = isIP(DestAddress);
  if (family === 4) return DestAddress;
  if (family === 6) {
    return new URL(`http://[${DestAddress}]/`).hostname.slice(1, -1);
  }
}

function auditPolicyReduction(raw: unknown) {
  if (raw === undefined || raw === null) return undefined;
  const { AuditPolicyChanges, SubcategoryGuid } = object(
    raw,
    "Winlogbeat event_data",
  );
  if (
    typeof AuditPolicyChanges !== "string" || AuditPolicyChanges.length > 256
  ) {
    return undefined;
  }
  const changes = new Set(
    AuditPolicyChanges.toLowerCase().split(",").map((value) => value.trim()),
  );
  const removedSuccess = changes.has("%%8448") ||
    changes.has("success removed");
  const removedFailure = changes.has("%%8450") ||
    changes.has("failure removed");
  if (!removedSuccess && !removedFailure) return undefined;
  const scope = typeof SubcategoryGuid === "string" &&
      SubcategoryGuid.length === 38 &&
      /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i
        .test(SubcategoryGuid)
    ? `:${SubcategoryGuid.slice(1, -1).toLowerCase()}`
    : "";
  return {
    subject: `windows-audit-policy${scope}`,
    action: removedSuccess && removedFailure
      ? "winlog:4719:success-and-failure-removed"
      : removedSuccess
      ? "winlog:4719:success-removed"
      : "winlog:4719:failure-removed",
  };
}

const privilegedGroupAdditions = new Set(["4728", "4732", "4756"]);
const scheduledTaskChanges = new Set(["4698", "4702"]);

/** Validate an operator's exact Windows group SID allowlist. */
export function validateWinlogbeatPrivilegedGroups(
  raw: unknown,
): ReadonlySet<string> {
  if (!Array.isArray(raw) || raw.length > 256) {
    throw new Error("Expected an array of up to 256 privileged group SIDs");
  }
  const groups = new Set<string>();
  for (const sid of raw) {
    if (
      typeof sid !== "string" ||
      sid.trim() !== sid ||
      !/^S-1-(0|[1-9][0-9]{0,14})(-(0|[1-9][0-9]{0,9})){1,15}$/.test(sid) ||
      groups.has(sid)
    ) throw new Error("Expected unique canonical privileged group SIDs");
    const [, , authority, ...subAuthorities] = sid.split("-");
    if (
      Number(authority) > 0xffffffffffff ||
      subAuthorities.some((part) => Number(part) > 0xffffffff)
    ) throw new Error("Invalid privileged group SID range");
    groups.add(sid);
  }
  return groups;
}

function privilegedWindowsGroup(
  eventId: string,
  raw: unknown,
  groups?: ReadonlySet<string>,
) {
  const { TargetSid: sid } = object(raw, "Winlogbeat event_data");
  if (typeof sid !== "string") return undefined;
  if (eventId === "4732" && sid === "S-1-5-32-544") {
    return "windows-builtin-administrators";
  }
  const domainGroup = /^S-1-5-21-(?:[0-9]{1,10}-){3}(512|518|519)$/.exec(sid);
  if (eventId === "4728" && domainGroup?.[1] === "512") {
    return "windows-domain-admins";
  }
  if (eventId === "4756") {
    if (domainGroup?.[1] === "518") return "windows-schema-admins";
    if (domainGroup?.[1] === "519") return "windows-enterprise-admins";
  }
  return groups?.has(sid) ? `windows-privileged-group:${sid}` : undefined;
}

type WinlogbeatEvent =
  | IdentityEvent
  | (
    & Omit<IdentityEvent, "kind">
    & {
      readonly action: string;
    }
    & (
      | { readonly kind: "security_sensor_alert"; readonly severity: "high" }
      | {
        readonly kind: "network_security_alert" | "unexpected_privilege_grant";
      }
    )
  );

/** Read selected Windows Security and Defender Operational events. */
export function adaptWinlogbeatEvent(
  raw: unknown,
  groups?: ReadonlySet<string>,
): WinlogbeatEvent | undefined {
  const event = object(raw, "Winlogbeat event");
  const winlog = object(event.winlog, "Winlogbeat winlog");
  const rawNumber = winlog.event_id;
  if (typeof rawNumber !== "string" && typeof rawNumber !== "number") {
    throw new Error("Invalid Winlogbeat event ID");
  }
  const eventId = String(rawNumber);
  const authentication = windowsAuthentications.get(eventId);
  const defender = defenderSignals.get(eventId);
  const securityLogEvent = eventId === "1102" || eventId === "1104";
  const groupAddition = privilegedGroupAdditions.has(eventId);
  const scheduledTaskChange = scheduledTaskChanges.has(eventId);
  const auditPolicyChange = eventId === "4719";
  const connectionBlocked = eventId === "5157";
  const mitigation = exploitProtectionBlock(eventId, winlog.provider_name);
  if (
    !authentication && !securityLogEvent && !defender && !groupAddition &&
    !mitigation && !auditPolicyChange && !connectionBlocked &&
    !scheduledTaskChange
  ) {
    return undefined;
  }

  const channel = identifier(winlog.channel, "Winlogbeat channel")
    .toLowerCase();
  if (
    channel !== "forwardedevents" &&
    (mitigation
      ? !mitigation.channels.has(channel)
      : channel !== (defender ? defenderChannel : "security"))
  ) return undefined;
  const provider = identifier(winlog.provider_name, "Winlogbeat provider")
    .toLowerCase();
  const expected = mitigation
    ? mitigation.provider
    : defender
    ? "microsoft-windows-windows defender"
    : securityLogEvent
    ? "microsoft-windows-eventlog"
    : "microsoft-windows-security-auditing";
  if (provider !== expected) return undefined;

  if (mitigation && eventId === "260") {
    const data = winlog.event_data;
    if (data === undefined || data === null) return undefined;
    const { Blocked } = object(data, "Winlogbeat event_data");
    if (Blocked !== true && Blocked !== "true") return undefined;
  }

  const reducedAuditPolicy = auditPolicyChange
    ? auditPolicyReduction(winlog.event_data)
    : undefined;
  if (auditPolicyChange && !reducedAuditPolicy) return undefined;
  const outboundAddress = connectionBlocked
    ? blockedOutboundAddress(winlog.event_data)
    : undefined;
  if (connectionBlocked && !outboundAddress) return undefined;
  const subject = outboundAddress ??
    (mitigation
      ? `windows-exploit-protection:${mitigation.subject}`
      : undefined) ??
    reducedAuditPolicy?.subject ?? defender?.subject ??
    (groupAddition
      ? privilegedWindowsGroup(eventId, winlog.event_data, groups)
      : authentication
      ? targetAccount(winlog.event_data)
      : scheduledTaskChange
      ? "windows-scheduled-task"
      : "windows-security-audit-log");
  if (subject === undefined) return undefined;

  const originatingHost = winlog.computer_name ?? (
    channel !== "forwardedevents"
      ? object(event.host, "Winlogbeat host").name
      : undefined
  );
  const host = identifier(originatingHost, "Winlogbeat originating computer")
    .toLowerCase();
  const time = timestamp(event["@timestamp"], "Winlogbeat");
  const base = {
    version: 1 as const,
    id: `winlog:${mitigation ? `mitigation:${channel}:` : ""}${eventId}:${
      recordId(winlog.record_id)
    }:${time}`,
    asset: host,
    timestamp: time,
    subject,
  };
  if (outboundAddress) {
    return {
      ...base,
      kind: "egress_denied",
      action: "winlog:5157:outbound-blocked",
    };
  }
  if (mitigation) {
    return {
      ...base,
      kind: "security_sensor_alert",
      severity: "high",
      action: `winlog:mitigation:${eventId}`,
    };
  }
  if (groupAddition) {
    return {
      ...base,
      kind: "unexpected_privilege_grant",
      action: `winlog:${eventId}`,
    };
  }
  if (defender) {
    const { kind } = defender;
    const action = `defender:${eventId}`;
    return kind === "security_sensor_alert"
      ? { ...base, kind, action, severity: "high" }
      : { ...base, kind, action };
  }
  return {
    ...base,
    kind: authentication ?? "integrity_change",
    ...((securityLogEvent || scheduledTaskChange) &&
      { action: `winlog:${eventId}` }),
    ...(reducedAuditPolicy && { action: reducedAuditPolicy.action }),
  };
}

/** Read Okta authentication-attempt outcomes for an operator-assigned tenant. */
export function adaptOktaSystemLogEvent(
  raw: unknown,
  organization: string,
): IdentityEvent | undefined {
  const event = object(raw, "Okta System Log event");
  const eventType = identifier(event.eventType, "Okta event type");
  if (eventType !== "user.session.start") return undefined;
  const outcome = object(event.outcome, "Okta outcome");
  const result = identifier(outcome.result, "Okta outcome result");
  if (result !== "SUCCESS" && result !== "FAILURE") return undefined;

  const actor = object(event.actor, "Okta actor");
  if (actor.type !== "User" || actor.id === null || actor.id === undefined) {
    return undefined;
  }
  const actorId = identifier(actor.id, "Okta user ID");
  if (["unknown", "(unknown)", "-"].includes(actorId.toLowerCase())) {
    return undefined;
  }
  const id = identifier(
    `okta:${identifier(event.uuid, "Okta event UUID")}`,
    "Okta evidence ID",
  );
  return {
    version: 1,
    id,
    asset: identifier(organization, "Okta organization"),
    timestamp: timestamp(event.published, "Okta published"),
    kind: result === "SUCCESS" ? "auth_success" : "auth_failure",
    subject: actorId,
  };
}
