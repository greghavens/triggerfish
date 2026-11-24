/** Normalize interactive and workload Microsoft Entra sign-in records exported by Azure Monitor. */

import type { EntraRoleGrantContext } from "./telemetry.ts";
import { createHash } from "node:crypto";

interface EntraEvent {
  readonly version: 1;
  readonly id: string;
  readonly timestamp: string;
  readonly asset: string;
  readonly kind:
    | "auth_success"
    | "auth_failure"
    | "unexpected_privilege_grant"
    | "integrity_change";
  readonly action?: string;
  readonly entraRoleGrant?: EntraRoleGrantContext;
  readonly subject: string;
  readonly sourceReference?: string;
}

const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const absentGuid = "00000000-0000-0000-0000-000000000000";
const timestampPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/;

function object(raw: unknown, name: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Expected an Entra ${name} object`);
  }
  return raw as Record<string, unknown>;
}

function guid(raw: unknown, name: string): string {
  if (typeof raw !== "string" || !guidPattern.test(raw) || raw === absentGuid) {
    throw new Error(`Invalid Entra ${name} GUID`);
  }
  return raw.toLowerCase();
}

function normalizeTime(raw: unknown): string {
  const match = typeof raw === "string" ? timestampPattern.exec(raw) : null;
  if (!match) throw new Error("Expected an Entra UTC timestamp");
  const [, seconds, fraction = ""] = match;
  const normalized = `${seconds}.${fraction.padEnd(3, "0").slice(0, 3)}Z`;
  const time = Date.parse(normalized);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== normalized) {
    throw new Error("Invalid Entra calendar timestamp");
  }
  return normalized;
}

function decodeResult(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  const result = typeof raw === "string" && /^(0|[1-9]\d{0,9})$/.test(raw)
    ? Number(raw)
    : raw;
  if (
    typeof result !== "number" || !Number.isInteger(result) ||
    result < 0 || result > 0x7fffffff
  ) {
    throw new Error("Invalid Entra sign-in result code");
  }
  return result === 0;
}

const grants = new Map([
  ["Add member to role", "entra.directory_role.add_member"],
  ["Add scoped member to role", "entra.directory_role.add_scoped_member"],
  [
    "Add member to role scoped over Restricted Management Administrative Unit",
    "entra.directory_role.add_restricted_scope_member",
  ],
]);

const policyChanges = new Map([
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
]);

const applicationCredentialChange = {
  action: "entra.application.credentials_changed",
  targetTypes: ["application", "app"],
  subjectKind: "application",
};
const credentialChanges = new Map([
  [
    "Add service principal credentials",
    {
      action: "entra.service_principal.credentials_added",
      targetTypes: ["serviceprincipal"],
      subjectKind: "service-principal",
    },
  ],
  [
    "Remove service principal credentials",
    {
      action: "entra.service_principal.credentials_removed",
      targetTypes: ["serviceprincipal"],
      subjectKind: "service-principal",
    },
  ],
  [
    "Update application - Certificates and secrets management",
    applicationCredentialChange,
  ],
  [
    "Update application – Certificates and secrets management",
    applicationCredentialChange,
  ],
]);

const applicationPermissionGrants = new Map([
  [
    "Add app role assignment to service principal",
    "entra.application.app_only_permission_granted",
  ],
  [
    "Add app role assignment to the service principal",
    "entra.application.app_only_permission_granted",
  ],
  [
    "Add delegated permission grant",
    "entra.application.delegated_permission_granted",
  ],
  ["Consent to application", "entra.application.consent_granted"],
]);

interface CompletedAudit {
  readonly activity: string;
  readonly id: unknown;
  readonly time: unknown;
  readonly tenant: unknown;
  readonly targets: unknown;
}

function completedAudit(
  event: Record<string, unknown>,
): CompletedAudit | undefined {
  const table = event.Type === "AuditLogs";
  if (!table && event.properties == null) return;
  const properties = table
    ? event
    : object(event.properties, "audit properties");
  const activity = table
    ? properties.ActivityDisplayName ?? properties.OperationName
    : properties.activityDisplayName;
  if (typeof activity !== "string") return;
  const result = table ? properties.Result : properties.result;
  const outcome = table ? properties.ResultType : event.resultType;
  if (result !== undefined && result !== "success") return;
  if (outcome !== undefined && outcome !== "Success" && outcome !== "success") {
    return;
  }
  if (result === undefined && outcome === undefined) return;
  return {
    activity,
    id: table ? properties.Id : properties.id,
    time: table
      ? properties.ActivityDateTime ?? properties.TimeGenerated
      : properties.activityDateTime ?? event.time,
    tenant: table ? event.AADTenantId : event.tenantId,
    targets: table ? properties.TargetResources : properties.targetResources,
  };
}

function auditEvidence(audit: CompletedAudit) {
  const id = audit.id;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_.:-]{0,191}$/i.test(id)) {
    throw new Error("Invalid Entra audit activity ID");
  }
  return {
    version: 1 as const,
    id: `entra:audit:${id}`,
    timestamp: normalizeTime(audit.time),
    asset: guid(audit.tenant, "tenant"),
  };
}

/** Keep an exact target only when the expected resource is unambiguous. */
function uniqueAuditTarget(raw: unknown, targetTypes: readonly string[]) {
  const candidates = new Set<string>();
  if (Array.isArray(raw) && raw.length <= 64) {
    for (const target of raw) {
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        continue;
      }
      const { type, id } = target;
      if (
        typeof type === "string" && targetTypes.includes(type.toLowerCase()) &&
        typeof id === "string" && guidPattern.test(id) && id !== absentGuid
      ) {
        candidates.add(id.toLowerCase());
      }
    }
  }
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

function changedRoleIds(
  raw: unknown,
  roles: Set<string>,
  templates: Set<string>,
) {
  if (!Array.isArray(raw) || raw.length > 64) return;
  for (const field of raw) {
    if (!field || typeof field !== "object" || Array.isArray(field)) continue;
    const { displayName, newValue } = field;
    const ids = displayName === "Role.ObjectID"
      ? roles
      : displayName === "Role.TemplateId"
      ? templates
      : undefined;
    if (!ids || typeof newValue !== "string" || newValue.length > 38) continue;
    const delimiter = newValue[0];
    const id =
      ((delimiter === '"' || delimiter === "'") && newValue.endsWith(delimiter)
        ? newValue.slice(1, -1)
        : newValue).toLowerCase();
    if (guidPattern.test(id) && id !== absentGuid) ids.add(id);
  }
}

function directoryRoleGrant(
  audit: CompletedAudit,
): EntraEvent[] {
  const action = grants.get(audit.activity);
  if (!action) return [];

  const rawTargets = audit.targets;
  if (!Array.isArray(rawTargets) || rawTargets.length > 64) return [];
  const subjects = new Map<
    string,
    { roles: Set<string>; templates: Set<string> }
  >();
  const roles = new Set<string>();
  const administrativeUnits = new Set<string>();
  for (const raw of rawTargets) {
    const target = object(raw, "audit target");
    const kind = typeof target.type === "string"
      ? target.type.toLowerCase()
      : "";
    if (
      typeof target.id !== "string" || !guidPattern.test(target.id) ||
      target.id === absentGuid
    ) continue;
    const id = target.id.toLowerCase();
    if (kind === "role" || kind === "directoryrole") {
      roles.add(id);
      continue;
    }
    if (kind === "administrativeunit") {
      administrativeUnits.add(id);
      continue;
    }
    if (!["user", "serviceprincipal", "group"].includes(kind)) continue;
    const subject = kind === "user"
      ? id
      : kind === "group"
      ? `group:${id}`
      : `service-principal:${id}`;
    let changes = subjects.get(subject);
    if (!changes) {
      changes = { roles: new Set(), templates: new Set() };
      subjects.set(subject, changes);
    }
    changedRoleIds(target.modifiedProperties, changes.roles, changes.templates);
  }
  if (!subjects.size) return [];
  const evidence = auditEvidence(audit);
  const roleIds = [...roles].sort();
  const administrativeUnitIds = [...administrativeUnits].sort();
  return [...subjects.keys()].sort().map((subject) => {
    const changes = subjects.get(subject)!;
    const modifiedRoleIds = [...changes.roles].sort().slice(0, 64);
    const modifiedRoleTemplateIds = [...changes.templates].sort().slice(0, 64);
    const entraRoleGrant = roleIds.length || administrativeUnitIds.length ||
        modifiedRoleIds.length || modifiedRoleTemplateIds.length
      ? {
        roleIds,
        administrativeUnitIds,
        ...(modifiedRoleIds.length && { modifiedRoleIds }),
        ...(modifiedRoleTemplateIds.length && { modifiedRoleTemplateIds }),
      }
      : undefined;
    const suffix = subjects.size === 1 ? "" : ":" +
      createHash("sha256").update(subject).digest("hex").slice(0, 32);
    return {
      ...evidence,
      id: evidence.id + suffix,
      subject,
      kind: "unexpected_privilege_grant",
      action,
      ...(entraRoleGrant && { entraRoleGrant }),
    };
  });
}

function normalizeRecord(event: Record<string, unknown>) {
  if (event.category !== undefined) return event;
  const category = event.Type === "SigninLogs" ? "SignInLogs" : event.Type;
  if (
    category !== "SignInLogs" && category !== "AADServicePrincipalSignInLogs" &&
    category !== "AADManagedIdentitySignInLogs"
  ) return event;
  return {
    category,
    // TenantId is the Log Analytics workspace identifier in these table rows.
    tenantId: event.AADTenantId,
    time: event.CreatedDateTime ?? event.TimeGenerated,
    resultType: event.ResultType,
    properties: {
      id: event.Id,
      userId: event.UserId,
      isInteractive: event.IsInteractive,
      servicePrincipalId: event.ServicePrincipalId,
      ...(category === "SignInLogs" && {
        status: event.Status,
        deviceDetail: event.DeviceDetail,
      }),
    },
  };
}

/** Map a diagnostic or Log Analytics record into tenant-scoped evidence. */
export function adaptEntraEvents(raw: unknown): EntraEvent[] {
  const record = object(raw, "record");
  if (record.category === "AuditLogs" || record.Type === "AuditLogs") {
    const audit = completedAudit(record);
    if (!audit) return [];
    const applicationGrant = applicationPermissionGrants.get(audit.activity);
    if (applicationGrant) {
      return [{
        ...auditEvidence(audit),
        kind: "integrity_change",
        action: applicationGrant,
        subject: "tenant-application-permissions",
      }];
    }
    const credential = credentialChanges.get(audit.activity);
    if (credential) {
      const target = uniqueAuditTarget(audit.targets, credential.targetTypes);
      return [{
        ...auditEvidence(audit),
        kind: "integrity_change",
        action: credential.action,
        subject: target
          ? `${credential.subjectKind}:${target}`
          : `tenant-${credential.subjectKind}-credentials`,
      }];
    }
    const action = policyChanges.get(audit.activity);
    if (!action) return directoryRoleGrant(audit);
    const target = uniqueAuditTarget(audit.targets, ["policy"]);
    return [{
      ...auditEvidence(audit),
      kind: "integrity_change",
      action,
      subject: target ? `policy:${target}` : "tenant-authentication-policy",
    }];
  }
  const event = signIn(record);
  return event ? [event] : [];
}

export function adaptEntraEvent(raw: unknown): EntraEvent | undefined {
  const events = adaptEntraEvents(raw);
  return events.length === 1 ? events[0] : undefined;
}

/** Correlate the registered device recorded by Entra without retaining its ID. */
function registeredDeviceSource(
  tenant: string,
  raw: unknown,
): string | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const { deviceId } = raw as Record<string, unknown>;
  if (
    typeof deviceId !== "string" || !guidPattern.test(deviceId) ||
    deviceId === absentGuid
  ) return;
  return `source:${
    createHash("sha256")
      .update(
        JSON.stringify([
          "entra-registered-device",
          tenant,
          deviceId.toLowerCase(),
        ]),
      )
      .digest("hex")
  }`;
}

function signIn(record: Record<string, unknown>): EntraEvent | undefined {
  const event = normalizeRecord(record);
  if (typeof event.category !== "string" || !event.category) {
    throw new Error("Expected an Entra diagnostic category");
  }
  const workload = event.category === "ServicePrincipalSignInLogs" ||
      event.category === "AADServicePrincipalSignInLogs"
    ? "service-principal"
    : event.category === "ManagedIdentitySignInLogs" ||
        event.category === "AADManagedIdentitySignInLogs"
    ? "managed-identity"
    : undefined;
  if (event.category !== "SignInLogs" && !workload) return undefined;

  const properties = object(event.properties, "sign-in properties");
  if (!workload) {
    if (properties.isInteractive === false) return undefined;
    if (properties.isInteractive !== true) {
      throw new Error(
        "Expected an explicit Entra interactive sign-in indicator",
      );
    }
  } else if (
    properties.isInteractive !== undefined && properties.isInteractive !== false
  ) {
    throw new Error("Unexpected Entra workload interactive indicator");
  }

  const actor = workload ? properties.servicePrincipalId : properties.userId;
  if (
    actor === undefined || actor === null || actor === "" ||
    actor === absentGuid
  ) return undefined;
  const principal = guid(
    actor,
    workload ?? "user",
  );
  const subject = workload ? `${workload}:${principal}` : principal;
  const result = workload && event.resultType === "Success"
    ? true
    : workload && event.resultType === "Failure"
    ? false
    : decodeResult(event.resultType);
  const status = properties.status === undefined || properties.status === null
    ? undefined
    : decodeResult(object(properties.status, "sign-in status").errorCode);
  if (result !== undefined && status !== undefined && result !== status) {
    throw new Error("Conflicting Entra sign-in outcomes");
  }
  const succeeded = result ?? status;
  if (succeeded === undefined) throw new Error("Missing Entra sign-in outcome");
  const tenant = guid(event.tenantId, "tenant");
  const sourceReference = !workload
    ? registeredDeviceSource(tenant, properties.deviceDetail)
    : undefined;

  return {
    version: 1,
    id: `entra:${workload ? workload + ":" : ""}${
      guid(properties.id, "sign-in ID")
    }`,
    timestamp: normalizeTime(event.time),
    asset: tenant,
    kind: succeeded ? "auth_success" : "auth_failure",
    subject,
    ...(sourceReference && { sourceReference }),
  };
}
