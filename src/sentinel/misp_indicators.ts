/** Import supported exact indicators from an operator-supplied MISP JSON export. */

import { createHash } from "node:crypto";
import { createSentinelIndicatorDetector } from "./indicators.ts";

const MAX_RECORDS = 20_000;
const MAX_RULES = 10_000;
const MAX_WRAPPER_DEPTH = 6;
const uuidPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const unsignedId = /^\d{1,32}$/;

type JsonObject = Record<string, unknown>;
type Target =
  | { readonly kind: "dns"; readonly field: "query" }
  | { readonly kind: "http"; readonly field: "host" | "userAgent" }
  | { readonly kind: "host"; readonly field: "sha256" };
type ImportedRule = Target & {
  readonly id: string;
  readonly source: string;
  readonly severity: "medium";
  readonly value: string;
};

function object(raw: unknown, field: string): JsonObject {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected a MISP ${field} object`);
  }
  return raw as JsonObject;
}

function text(raw: unknown, field: string, maxLength: number): string {
  if (
    typeof raw !== "string" || !raw.trim() || raw.length > maxLength ||
    [...raw].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  ) {
    throw new Error(`Invalid MISP ${field}`);
  }
  return raw;
}

function reference(uuid: unknown, id: unknown): string | undefined {
  if (uuid !== undefined) {
    if (typeof uuid !== "string" || !uuidPattern.test(uuid)) {
      throw new Error("Invalid MISP UUID reference");
    }
    return uuid.toLowerCase();
  }
  if (id === undefined) return;
  const normalized = typeof id === "number" && Number.isSafeInteger(id)
    ? String(id)
    : id;
  if (typeof normalized !== "string" || !unsignedId.test(normalized)) {
    throw new Error("Invalid MISP numeric reference");
  }
  return normalized;
}

function targets(type: unknown, value: string): readonly Target[] {
  switch (type) {
    case "domain":
    case "hostname":
      return value.includes("_")
        ? [{ kind: "dns", field: "query" }]
        : [{ kind: "dns", field: "query" }, { kind: "http", field: "host" }];
    case "sha256":
      return [{ kind: "host", field: "sha256" }];
    case "user-agent":
      return [{ kind: "http", field: "userAgent" }];
    default:
      return [];
  }
}

function active(record: JsonObject): boolean {
  return record.deleted === undefined || record.deleted === false;
}

/**
 * Read MISP Event/Attribute objects (bare or wrapped) and REST response arrays.
 * Import only explicit IDS attributes with exact Sentinel field equivalents.
 */
export function importSentinelMispIndicators(raw: unknown, source: string) {
  source = text(source, "source", 768).trim();
  const rules = new Map<string, ImportedRule>();
  let visited = 0;

  function visit() {
    if (++visited > MAX_RECORDS) {
      throw new Error("MISP export exceeds the 20000 record limit");
    }
  }

  function addAttribute(rawAttribute: unknown, event?: string) {
    visit();
    const attribute = object(rawAttribute, "Attribute");
    const { type } = attribute;
    if (
      attribute.to_ids !== true || !active(attribute) ||
      (type !== "domain" && type !== "hostname" && type !== "sha256" &&
        type !== "user-agent")
    ) {
      return;
    }

    const attributeId = reference(attribute.uuid, attribute.id);
    const eventId = event ??
      reference(attribute.event_uuid, attribute.event_id);
    const rawValue = text(attribute.value, "Attribute value", 2048);
    const value = type === "user-agent"
      ? rawValue
      : type === "sha256"
      ? rawValue.toLowerCase()
      : rawValue.toLowerCase().replace(/\.$/, "");
    const identity = attributeId ?? [eventId, type, value];
    const provenance = [
      "MISP",
      ...(eventId === undefined ? [] : [`event ${eventId}`]),
      ...(attributeId === undefined ? [] : [`attribute ${attributeId}`]),
    ].join(" ");

    for (const target of targets(type, value)) {
      const hash = createHash("sha256")
        .update(JSON.stringify([source, identity, target.kind, target.field]))
        .digest("hex");
      const id = `misp:${hash}`;
      const previous = rules.get(id);
      if (previous && previous.value !== value) {
        throw new Error(
          "Conflicting MISP values for the same attribute reference",
        );
      }
      if (!previous && rules.size >= MAX_RULES) {
        throw new Error("MISP import exceeds the 10000 rule limit");
      }
      const rule = {
        ...target,
        value,
        id,
        source: `${source} (${provenance})`,
        severity: "medium" as const,
      };
      if (!previous || previous.source < rule.source) rules.set(id, rule);
    }
  }

  function readAttributes(record: JsonObject, event?: JsonObject) {
    if (!active(record) || (event !== undefined && !active(event))) return;
    const eventSource = event ?? record;
    const eventId = reference(eventSource.uuid, eventSource.id);
    const attributes = record.Attribute;
    if (Array.isArray(attributes)) {
      if (attributes.length > MAX_RECORDS) {
        throw new Error("MISP export exceeds the 20000 record limit");
      }
      for (const item of attributes) addAttribute(item, eventId);
    } else if (attributes !== undefined) {
      addAttribute(attributes, eventId);
    }
  }

  function walk(input: unknown, depth: number) {
    visit();
    if (depth > MAX_WRAPPER_DEPTH) {
      throw new Error("MISP wrapper nesting limit exceeded");
    }
    if (Array.isArray(input)) {
      for (const item of input) walk(item, depth + 1);
      return;
    }

    const record = object(input, "export");
    if (Object.hasOwn(record, "response")) {
      walk(record.response, depth + 1);
    } else if (Object.hasOwn(record, "Attribute")) {
      readAttributes(
        record,
        record.Event === undefined ? undefined : object(record.Event, "Event"),
      );
    } else if (Object.hasOwn(record, "Event")) {
      const event = object(record.Event, "Event");
      readAttributes(event);
    } else if (Object.hasOwn(record, "type")) {
      addAttribute(record);
    } else if (!Object.hasOwn(record, "uuid") && !Object.hasOwn(record, "id")) {
      throw new Error("Unsupported MISP export structure");
    }
  }

  walk(raw, 0);
  const catalog = {
    version: 1 as const,
    rules: [...rules.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  // Use the detector's canonical validator as the final compatibility check.
  createSentinelIndicatorDetector(catalog);
  return catalog;
}
