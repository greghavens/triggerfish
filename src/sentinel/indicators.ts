/** Passive correlation against an operator-supplied indicator catalog. */

const fieldsByKind = {
  dns: ["query"],
  http: ["host", "path", "userAgent"],
  host: [
    "processName",
    "sha256",
    "tcpListenPort",
    "sqliteTable",
    "postgresTable",
  ],
} as const;

type Kind = keyof typeof fieldsByKind;
type Field = typeof fieldsByKind[Kind][number];
type Severity = "medium" | "high";

interface Rule {
  readonly id: string;
  readonly source: string;
  readonly severity: Severity;
}

export interface SentinelIndicatorAlert {
  readonly type: "indicator_match";
  readonly indicatorId: string;
  readonly source: string;
  readonly severity: Severity;
  readonly asset: string;
  readonly kind: Kind;
  readonly field: Field;
  readonly observedAt: string;
  readonly evidenceIds: readonly string[];
}

const MAX_RULES = 10000;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function object(raw: unknown, name: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected Sentinel indicator ${name} object`);
  }
  return raw as Record<string, unknown>;
}

function string(raw: unknown, field: string, max = 256): string {
  if (
    typeof raw !== "string" || raw.trim() === "" || raw.length > max ||
    [...raw].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  ) {
    throw new Error(`Invalid Sentinel indicator ${field}`);
  }
  return raw;
}

function eventKind(raw: unknown): Kind {
  if (raw === "dns" || raw === "http" || raw === "host") return raw;
  throw new Error("Expected Sentinel indicator kind dns, http, or host");
}

function ruleSeverity(raw: unknown): Severity {
  if (raw === "medium" || raw === "high") return raw;
  throw new Error("Expected Sentinel indicator severity medium or high");
}

function eventField(kind: Kind, raw: unknown): Field {
  const field = fieldsByKind[kind].find((allowed) => allowed === raw);
  if (field === undefined) {
    throw new Error(`Invalid Sentinel indicator field for ${kind}`);
  }
  return field;
}

export function isSentinelPostgresTable(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/.test(value);
}

function normalizeValue(field: Field, raw: unknown): string {
  const value = string(raw, field, 2048);

  if (field === "tcpListenPort") {
    if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) {
      throw new Error(
        "Expected a decimal Sentinel TCP listener port from 1 to 65535",
      );
    }
    return value;
  }

  if (
    field === "postgresTable" &&
    !isSentinelPostgresTable(value)
  ) {
    throw new Error("Expected an unquoted PostgreSQL schema.table indicator");
  }

  if (field === "sha256") {
    if (!/^[\da-f]{64}$/i.test(value)) {
      throw new Error("Expected a Sentinel indicator SHA-256 digest");
    }
    return value.toLowerCase();
  }

  if (field === "query" || field === "host") {
    const hostname = value.toLowerCase().replace(/\.$/, "");
    const label = field === "query"
      ? /^[a-z0-9_-]{1,63}$/
      : /^[a-z0-9-]{1,63}$/;
    if (
      hostname.length > 253 ||
      !hostname.split(".").every((part) =>
        label.test(part) && !part.startsWith("-") && !part.endsWith("-")
      )
    ) {
      throw new Error(`Expected a Sentinel indicator DNS name for ${field}`);
    }
    return hostname;
  }

  if (field === "path" && (!value.startsWith("/") || /[?#\s]/.test(value))) {
    throw new Error("Expected a Sentinel indicator HTTP pathname");
  }

  return value;
}

function observedAt(raw: unknown): string {
  if (typeof raw !== "string" || !TIMESTAMP_PATTERN.test(raw)) {
    throw new Error("Expected a Sentinel indicator UTC timestamp");
  }
  const time = Date.parse(raw);
  const timestamp = Number.isFinite(time) ? new Date(time).toISOString() : "";
  const [seconds, fraction = ""] = raw.slice(0, -1).split(".");
  if (timestamp !== `${seconds}.${fraction.padEnd(3, "0")}Z`) {
    throw new Error("Invalid Sentinel indicator calendar timestamp");
  }
  return timestamp;
}

function key(kind: Kind, field: Field, value: string, asset?: string): string {
  return JSON.stringify([kind, field, value, asset ?? null]);
}

export function parseSentinelIndicatorCatalog(rawRules: unknown) {
  const catalog = object(rawRules, "catalog");
  if (
    catalog.version !== 1 || !Array.isArray(catalog.rules) ||
    catalog.rules.length > MAX_RULES
  ) {
    throw new Error(
      `Expected a version 1 catalog with at most ${MAX_RULES} rules`,
    );
  }

  const seenIds = new Set<string>();
  return catalog.rules.map((raw: unknown) => {
    const rule = object(raw, "rule");
    const id = string(rule.id, "rule ID");
    if (seenIds.has(id)) throw new Error("Duplicate Sentinel indicator ID");
    seenIds.add(id);

    const kind = eventKind(rule.kind);
    const field = eventField(kind, rule.field);
    const value = normalizeValue(field, rule.value);
    const asset = rule.asset === undefined
      ? undefined
      : string(rule.asset, "asset");
    return {
      id,
      kind,
      field,
      value,
      asset,
      source: string(rule.source, "source", 1024),
      severity: ruleSeverity(rule.severity),
    };
  });
}

/** Index exact indicators without loading remote catalogs or executing events. */
export function createSentinelIndicatorDetector(rawRules: unknown): {
  ingest(rawEvent: unknown): readonly SentinelIndicatorAlert[];
} {
  const index = new Map<string, Rule[]>();
  for (const rule of parseSentinelIndicatorCatalog(rawRules)) {
    const ruleKey = key(rule.kind, rule.field, rule.value, rule.asset);
    const bucket = index.get(ruleKey) ?? [];
    bucket.push(rule);
    index.set(ruleKey, bucket);
  }

  return {
    ingest(rawEvent: unknown): readonly SentinelIndicatorAlert[] {
      const event = object(rawEvent, "event");
      if (event.version !== 1) {
        throw new Error("Expected indicator event version 1");
      }
      const id = string(event.id, "event ID");
      const asset = string(event.asset, "asset");
      const kind = eventKind(event.kind);
      const timestamp = observedAt(event.timestamp);
      const fieldEntries = Object.entries(object(event.fields, "event fields"));
      if (
        fieldEntries.length === 0 ||
        fieldEntries.length > fieldsByKind[kind].length
      ) {
        throw new Error(
          "Expected one or more recognized indicator event fields",
        );
      }

      const alerts: SentinelIndicatorAlert[] = [];
      for (const [rawField, rawValue] of fieldEntries) {
        const field = eventField(kind, rawField);
        const value = normalizeValue(field, rawValue);
        const matches = [
          ...index.get(key(kind, field, value)) ?? [],
          ...index.get(key(kind, field, value, asset)) ?? [],
        ];
        for (const rule of matches) {
          alerts.push({
            type: "indicator_match",
            indicatorId: rule.id,
            source: rule.source,
            severity: rule.severity,
            asset,
            kind,
            field,
            observedAt: timestamp,
            evidenceIds: [id],
          });
        }
      }
      return alerts;
    },
  };
}
