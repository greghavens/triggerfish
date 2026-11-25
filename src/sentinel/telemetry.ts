/** Stateful detection from defensive telemetry supplied by an operator. */

import { createHash } from "node:crypto";

export const WEB_STAGES = [
  "web_enumeration_observed",
  "web_probe_observed",
  "web_authentication_observed",
] as const;

const eventKinds = [
  "auth_failure",
  "auth_success",
  "egress_denied",
  "authorization_denied",
  "integrity_change",
  "endpoint_execution_alert",
  "network_security_alert",
  "cloud_security_alert",
  "security_sensor_alert",
  "unexpected_privilege_grant",
  "unexpected_remote_access",
  "sensitive_egress_alert",
  ...WEB_STAGES,
] as const;

type EventKind = typeof eventKinds[number];
type WebStage = typeof WEB_STAGES[number];

function isWebStage(kind: EventKind): kind is WebStage {
  return WEB_STAGES.some((stage) => stage === kind);
}

export type SentinelAlertSeverity = "low" | "medium" | "high" | "critical";

const severityRank: Readonly<Record<SentinelAlertSeverity, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function sentinelSeverityRank(value: unknown): number {
  return isSentinelAlertSeverity(value) ? severityRank[value] : 0;
}

export function isSeverityIncrease(
  previous: SentinelAlertSeverity,
  next: SentinelAlertSeverity,
): boolean {
  return severityRank[next] > severityRank[previous];
}

export function isSentinelAlertSeverity(
  value: unknown,
): value is SentinelAlertSeverity {
  return value === "low" || value === "medium" || value === "high" ||
    value === "critical";
}

export interface EntraRoleGrantContext {
  readonly roleIds: readonly string[];
  readonly administrativeUnitIds: readonly string[];
  readonly modifiedRoleIds?: readonly string[];
  readonly modifiedRoleTemplateIds?: readonly string[];
}

/** Normalize only the explicit directory identifiers retained from an Entra grant. */
export function parseEntraRoleGrantContext(
  raw: unknown,
  kind: string,
  action?: string,
): EntraRoleGrantContext | undefined {
  if (raw === undefined) return undefined;
  if (
    kind !== "unexpected_privilege_grant" ||
    !action?.startsWith("entra.directory_role.") ||
    !raw || typeof raw !== "object" || Array.isArray(raw)
  ) throw new Error("Invalid Sentinel Entra grant context");
  const {
    roleIds,
    administrativeUnitIds,
    modifiedRoleIds,
    modifiedRoleTemplateIds,
  } = raw as Record<string, unknown>;
  const parseIds = (values: unknown): string[] => {
    if (
      !Array.isArray(values) || values.length > 64 ||
      !values.every((id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) &&
        id !== "00000000-0000-0000-0000-000000000000"
      )
    ) throw new Error("Invalid Sentinel Entra grant context IDs");
    return [...new Set(values.map((id: string) => id.toLowerCase()))].sort();
  };
  const roleChanges = modifiedRoleIds === undefined
    ? []
    : parseIds(modifiedRoleIds);
  const templateChanges = modifiedRoleTemplateIds === undefined
    ? []
    : parseIds(modifiedRoleTemplateIds);
  const context = {
    roleIds: parseIds(roleIds),
    ...(roleChanges.length && { modifiedRoleIds: roleChanges }),
    ...(templateChanges.length && { modifiedRoleTemplateIds: templateChanges }),
    administrativeUnitIds: parseIds(administrativeUnitIds),
  };
  return context.roleIds.length || context.administrativeUnitIds.length ||
      roleChanges.length || templateChanges.length
    ? context
    : undefined;
}

interface TelemetryEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly time: number;
  readonly asset: string;
  readonly kind: EventKind;
  readonly severity?: SentinelAlertSeverity;
  readonly subject: string;
  readonly action?: string;
  readonly entraRoleGrant?: EntraRoleGrantContext;
  readonly sessionReference?: string;
  readonly identityReference?: string;
  readonly sourceReference?: string;
}

const immediateAlertSeverities = {
  integrity_change: "high",
  endpoint_execution_alert: "high",
  network_security_alert: "high",
  cloud_security_alert: "medium",
  security_sensor_alert: "medium",
  unexpected_privilege_grant: "high",
  unexpected_remote_access: "high",
  sensitive_egress_alert: "high",
} as const;

export const telemetryAlertSeverities = {
  ...immediateAlertSeverities,
  authentication_failure_burst: "medium",
  authentication_failure_fanout: "medium",
  authentication_success_after_fanout: "high",
  authentication_success_after_failures: "high",
  privileged_authentication_without_mfa: "high",
  egress_denied_burst: "medium",
  authorization_denial_burst: "medium",
  web_multistage_activity: "medium",
} as const;

export interface TelemetryAlert {
  readonly type: keyof typeof telemetryAlertSeverities;
  readonly severity: SentinelAlertSeverity;
  readonly asset: string;
  readonly subject: string;
  readonly observedAt: string;
  readonly evidenceIds: readonly string[];
  readonly triggeringAction?: string;
  readonly entraRoleGrant?: EntraRoleGrantContext;
  readonly sessionReference?: string;
  readonly identityReference?: string;
  readonly sourceReference?: string;
}

/** Stable identity for a detector alert within a case. */
export function sentinelAlertKey(
  alert: Pick<TelemetryAlert, "type" | "asset" | "evidenceIds">,
): string {
  return JSON.stringify([
    alert.type,
    alert.asset,
    [...alert.evidenceIds].sort(),
  ]);
}

export function sentinelAlertReference(
  alert: Pick<TelemetryAlert, "type" | "asset" | "evidenceIds">,
) {
  return `case-alert:${
    createHash("sha256").update(sentinelAlertKey(alert)).digest("hex")
  }`;
}

interface Observation {
  readonly id: string;
  readonly time: number;
  readonly sessionReference?: string;
  readonly identityReference?: string;
}

interface Window {
  readonly lastTime: number;
  readonly observations: readonly Observation[];
}

interface WebSequence {
  readonly lastTime: number;
  readonly enumeration?: Observation;
  readonly pair?: {
    readonly enumeration: Observation;
    readonly probe: Observation;
  };
}

type SourceObservation = Observation & { readonly subject: string };

interface AuthenticationSourceWindow {
  readonly lastTime: number;
  readonly subjects: readonly SourceObservation[];
  readonly fanout?: readonly SourceObservation[];
}

export const AUTH_FAILURE_LIMIT = 5;
export const AUTH_WINDOW_MS = 5 * 60 * 1000;
export const AUTH_FANOUT_LIMIT = 5;
export const DENIAL_LIMIT = 5;
export const DENIAL_WINDOW_MS = 60 * 1000;
export const WEB_SEQUENCE_WINDOW_MS = 5 * 60 * 1000;
const MAX_TRACKED_SUBJECTS = 4096;
const MAX_RECENT_IDS = 16384;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.length > 256 ||
    value.trim().length === 0
  ) {
    throw new Error(`Invalid Sentinel telemetry ${field}`);
  }
  return value;
}

export function isSentinelTelemetryAction(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

/** Collector-issued opaque reference, already scoped to its identity authority. */
export function isSentinelSessionReference(value: unknown): value is string {
  return typeof value === "string" && /^session:[a-f0-9]{64}$/.test(value);
}

export function isSentinelIdentityReference(value: unknown): value is string {
  return typeof value === "string" && /^identity:[a-f0-9]{64}$/.test(value);
}

/** Opaque authentication source reference scoped by the trusted collector. */
export function isSentinelSourceReference(value: unknown): value is string {
  return typeof value === "string" && /^source:[a-f0-9]{64}$/.test(value);
}

function parseEvent(raw: unknown): TelemetryEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Expected a Sentinel telemetry event object");
  }
  const event = raw as Record<string, unknown>;
  if (event.version !== 1) {
    throw new Error("Expected Sentinel telemetry event version 1");
  }
  const kind = eventKinds.find((value) => value === event.kind);
  if (kind === undefined) throw new Error("Invalid Sentinel telemetry kind");
  const webStage = isWebStage(kind);

  const timestamp = event.timestamp;
  if (typeof timestamp !== "string" || !TIMESTAMP_PATTERN.test(timestamp)) {
    throw new Error("Expected a Sentinel telemetry UTC timestamp");
  }
  const time = Date.parse(timestamp);
  const canonicalTimestamp = Number.isFinite(time)
    ? new Date(time).toISOString()
    : undefined;
  const [seconds, fraction = ""] = timestamp.slice(0, -1).split(".");
  if (canonicalTimestamp !== `${seconds}.${fraction.padEnd(3, "0")}Z`) {
    throw new Error("Invalid Sentinel telemetry calendar timestamp");
  }

  // Web stages are coarse collector classifications. Keep no request fields
  // or raw actor identity from these records.
  const action = webStage ? undefined : event.action;
  if (action !== undefined && !isSentinelTelemetryAction(action)) {
    throw new Error("Invalid Sentinel telemetry action");
  }
  const identityReference = webStage ? undefined : event.identityReference;
  if (
    identityReference !== undefined &&
    !isSentinelIdentityReference(identityReference)
  ) {
    throw new Error("Invalid Sentinel telemetry identity reference");
  }
  const sessionReference = event.sessionReference;
  if (
    (webStage || sessionReference !== undefined) &&
    !isSentinelSessionReference(sessionReference)
  ) {
    throw new Error("Invalid Sentinel telemetry session reference");
  }
  const sourceReference = kind === "auth_failure" || kind === "auth_success"
    ? event.sourceReference
    : undefined;
  if (
    sourceReference !== undefined && !isSentinelSourceReference(sourceReference)
  ) {
    throw new Error("Invalid Sentinel telemetry source reference");
  }
  const severity = kind === "security_sensor_alert"
    ? event.severity
    : undefined;
  if (severity !== undefined && !isSentinelAlertSeverity(severity)) {
    throw new Error("Invalid Sentinel sensor alert severity");
  }
  const entraRoleGrant = parseEntraRoleGrantContext(
    event.entraRoleGrant,
    kind,
    action,
  );
  return {
    ...(action !== undefined && { action }),
    ...(sessionReference && { sessionReference }),
    ...(identityReference && { identityReference }),
    ...(sourceReference && { sourceReference }),
    ...(entraRoleGrant && { entraRoleGrant }),
    ...(severity !== undefined && { severity }),
    id: identifier(event.id, "ID"),
    timestamp: canonicalTimestamp,
    time,
    asset: identifier(event.asset, "asset"),
    kind,
    subject: webStage
      ? identifier(sessionReference, "session reference")
      : identifier(event.subject, "subject"),
  };
}

/** Canonicalize one collector record without retaining raw vendor fields. */
export function normalizeSentinelTelemetryEvent(raw: unknown) {
  const { time: _time, ...event } = parseEvent(raw);
  return { version: 1 as const, ...event };
}

function remember<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  limit: number,
) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

function commonAlertReferences(observations: readonly Observation[]) {
  const first = observations[0];
  const sessionReference = first?.sessionReference;
  const identityReference = first?.identityReference;
  return {
    sessionReference: sessionReference &&
        observations.every((item) => item.sessionReference === sessionReference)
      ? sessionReference
      : undefined,
    identityReference: identityReference &&
        observations.every((item) =>
          item.identityReference === identityReference && !item.sessionReference
        )
      ? identityReference
      : undefined,
  };
}

function alert(
  event: TelemetryEvent,
  type: TelemetryAlert["type"],
  evidenceIds: readonly string[],
  { sessionReference, identityReference } = event.kind === type ? event : {},
): readonly TelemetryAlert[] {
  return [{
    type,
    severity: event.severity ?? telemetryAlertSeverities[type],
    asset: event.asset,
    subject: event.subject,
    observedAt: event.timestamp,
    evidenceIds,
    ...(event.action && { triggeringAction: event.action }),
    ...(sessionReference && { sessionReference }),
    ...(identityReference && { identityReference }),
    ...(event.entraRoleGrant && { entraRoleGrant: event.entraRoleGrant }),
  }];
}

function advanceWebSequence(
  previous: WebSequence | undefined,
  event: TelemetryEvent,
  stage: WebStage,
): {
  readonly state: WebSequence;
  readonly matched?: {
    readonly enumeration: Observation;
    readonly probe: Observation;
  };
} {
  const { id, time } = event;
  const observation = { id, time };
  const inWindow = (earlier: Observation | undefined) =>
    earlier !== undefined && time - earlier.time < WEB_SEQUENCE_WINDOW_MS;
  const enumeration = inWindow(previous?.enumeration)
    ? previous?.enumeration
    : undefined;
  const pair = inWindow(previous?.pair?.enumeration)
    ? previous?.pair
    : undefined;
  const lastTime = time;
  switch (stage) {
    case "web_enumeration_observed":
      return { state: { lastTime, enumeration: observation, pair } };
    case "web_probe_observed":
      return {
        state: {
          lastTime,
          enumeration,
          pair: enumeration && enumeration.time < time
            ? { enumeration, probe: observation }
            : pair,
        },
      };
    case "web_authentication_observed":
      return pair && pair.probe.time < time
        ? { state: { lastTime }, matched: pair }
        : { state: { lastTime, enumeration, pair } };
  }
}

function observeAuthenticationSource(
  windows: Map<string, AuthenticationSourceWindow>,
  event: TelemetryEvent,
): readonly TelemetryAlert[] {
  const { id, time, timestamp, asset, subject, sourceReference } = event;
  if (!sourceReference) return [];
  // A detector instance belongs to a single case. The source reference
  // includes the collector's identity authority and tenant scope.
  const key = JSON.stringify([asset, sourceReference]);
  const window = windows.get(key);
  if (window && time < window.lastTime) return [];

  const active = (window?.subjects ?? []).filter((record) =>
    time - record.time < AUTH_WINDOW_MS
  );
  const fanout = window?.fanout;
  const witness = fanout && time - fanout[0].time < AUTH_WINDOW_MS
    ? fanout
    : undefined;
  if (event.kind === "auth_success") {
    if (
      !witness || time <= witness[witness.length - 1].time ||
      !witness.some((record) => record.subject === subject)
    ) return [];
    remember(
      windows,
      key,
      { lastTime: time, subjects: active },
      MAX_TRACKED_SUBJECTS,
    );
    return [{
      type: "authentication_success_after_fanout",
      severity: telemetryAlertSeverities.authentication_success_after_fanout,
      asset,
      subject,
      sourceReference,
      observedAt: timestamp,
      evidenceIds: [...witness.map((record) => record.id), id],
    }];
  }
  // Only the latest event for each of the most recent distinct subjects
  // matters. Any discarded subject has older evidence than every retained one.
  const subjects = [
    ...active.filter((record) => record.subject !== subject),
    { subject, id, time },
  ].slice(-AUTH_FANOUT_LIMIT);
  const reached = active.length < AUTH_FANOUT_LIMIT &&
    subjects.length === AUTH_FANOUT_LIMIT;
  remember(windows, key, {
    lastTime: time,
    subjects,
    fanout: reached ? subjects : witness,
  }, MAX_TRACKED_SUBJECTS);
  if (!reached) return [];
  return [{
    type: "authentication_failure_fanout",
    severity: telemetryAlertSeverities.authentication_failure_fanout,
    asset,
    subject: sourceReference,
    sourceReference,
    observedAt: timestamp,
    evidenceIds: subjects.map((record) => record.id),
  }];
}

/**
 * Evaluate event-time rules in arrival order. Feed correlated events in
 * timestamp order. A late event on a tracked subject leaves its state intact.
 */
export function createTelemetryDetector(): {
  ingest(raw: unknown): readonly TelemetryAlert[];
} {
  const recentEvents = new Map<string, SentinelAlertSeverity | null>();
  const windows = new Map<string, Window>();
  const webSequences = new Map<string, WebSequence>();
  const authenticationSources = new Map<string, AuthenticationSourceWindow>();

  return {
    ingest(raw: unknown): readonly TelemetryAlert[] {
      const event = parseEvent(raw);
      const eventKey = JSON.stringify([event.asset, event.id]);
      const prior = recentEvents.get(eventKey);
      const severity = event.kind === "security_sensor_alert"
        ? event.severity ?? immediateAlertSeverities.security_sensor_alert
        : null;
      if (
        prior !== undefined &&
        (!prior || !severity || !isSeverityIncrease(prior, severity))
      ) return [];

      if (isWebStage(event.kind)) {
        // Each detector belongs to one case. The collector scopes opaque
        // session references by authority and tenant before ingestion.
        const key = JSON.stringify([event.asset, event.sessionReference]);
        const previous = webSequences.get(key);
        if (previous && event.time < previous.lastTime) return [];
        remember(recentEvents, eventKey, null, MAX_RECENT_IDS);
        const { state, matched } = advanceWebSequence(
          previous,
          event,
          event.kind,
        );
        remember(webSequences, key, state, MAX_TRACKED_SUBJECTS);
        return matched
          ? alert(
            event,
            "web_multistage_activity",
            [matched.enumeration.id, matched.probe.id, event.id],
            { sessionReference: event.sessionReference },
          )
          : [];
      }

      if (event.kind in immediateAlertSeverities) {
        remember(recentEvents, eventKey, severity, MAX_RECENT_IDS);
        return alert(
          event,
          event.kind as keyof typeof immediateAlertSeverities,
          [event.id],
        );
      }

      const family =
        event.kind === "auth_failure" || event.kind === "auth_success"
          ? "auth"
          : event.kind;
      const key = JSON.stringify([family, event.asset, event.subject]);
      const window = windows.get(key);
      const privilegedAlerts = event.kind === "auth_success" &&
          event.action === "signin.amazonaws.com:ConsoleLogin:root-without-mfa"
        ? alert(event, "privileged_authentication_without_mfa", [event.id])
        : [];
      if (window && event.time < window.lastTime) {
        if (privilegedAlerts.length) {
          remember(recentEvents, eventKey, null, MAX_RECENT_IDS);
        }
        return privilegedAlerts;
      }
      remember(recentEvents, eventKey, null, MAX_RECENT_IDS);
      const sourceAlerts = observeAuthenticationSource(
        authenticationSources,
        event,
      );

      const duration = family === "auth" ? AUTH_WINDOW_MS : DENIAL_WINDOW_MS;
      const threshold = family === "auth" ? AUTH_FAILURE_LIMIT : DENIAL_LIMIT;
      const active = (window?.observations ?? []).filter(({ time }) =>
        event.time - time < duration
      );

      if (event.kind === "auth_success") {
        remember(windows, key, {
          lastTime: event.time,
          observations: [],
        }, MAX_TRACKED_SUBJECTS);
        if (active.length < threshold) {
          return [...privilegedAlerts, ...sourceAlerts];
        }
        return [
          ...alert(event, "authentication_success_after_failures", [
            ...active.map(({ id }) => id),
            event.id,
          ], commonAlertReferences([...active, event])),
          ...privilegedAlerts,
          ...sourceAlerts,
        ];
      }

      // Keep enough evidence to decide whether the window remains saturated.
      const observations = [
        ...active,
        {
          id: event.id,
          time: event.time,
          sessionReference: event.sessionReference,
          identityReference: event.identityReference,
        },
      ].slice(-threshold);
      remember(windows, key, {
        lastTime: event.time,
        observations,
      }, MAX_TRACKED_SUBJECTS);
      if (active.length >= threshold || observations.length < threshold) {
        return sourceAlerts;
      }
      return [
        ...alert(
          event,
          family === "auth"
            ? "authentication_failure_burst"
            : family === "egress_denied"
            ? "egress_denied_burst"
            : "authorization_denial_burst",
          observations.map(({ id }) => id),
          commonAlertReferences(observations),
        ),
        ...sourceAlerts,
      ];
    },
  };
}
