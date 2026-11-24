/** Normalize explicitly selected CEF alerts from a trusted syslog collector. */

import { createHash } from "node:crypto";

export interface CefAlertSelector {
  readonly vendor: string;
  readonly product: string;
  readonly classId: string;
  readonly asset: string;
  /** Optional exact RFC 5424 hostname for this selector. */
  readonly source?: string;
}

const selectorKeys = new Set([
  "vendor",
  "product",
  "classId",
  "asset",
  "source",
]);
const validSeverity = /^(?:[0-9]|10|Unknown|Low|Medium|High|Very-High)$/;
const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 32 || (code >= 127 && code < 160);
}

function identifier(raw: unknown, field: string): string {
  if (
    typeof raw !== "string" || raw.length === 0 || raw.length > 256 ||
    raw.trim() !== raw || [...raw].some(isControl)
  ) {
    throw new Error(`Invalid Sentinel CEF ${field}`);
  }
  return raw;
}

/** Parse the operator-owned mapping from selected source classes to exact assets. */
export function validateCefAlertSelectors(
  raw: unknown,
): readonly CefAlertSelector[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1000) {
    throw new Error("Expected 1 to 1000 Sentinel CEF selectors");
  }
  const seen = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected a Sentinel CEF selector object");
    }
    const selector = value as Record<string, unknown>;
    if (Object.keys(selector).some((key) => !selectorKeys.has(key))) {
      throw new Error("Unexpected Sentinel CEF selector property");
    }

    const vendor = identifier(selector.vendor, "vendor");
    const product = identifier(selector.product, "product");
    const classId = identifier(selector.classId, "classId");
    const asset = identifier(selector.asset, "asset");
    const source = selector.source === undefined
      ? undefined
      : identifier(selector.source, "source");
    if (source === "-") {
      throw new Error("Expected an explicit CEF source hostname");
    }

    const key = JSON.stringify([vendor, product, classId, source]);
    if (seen.has(key)) throw new Error("Duplicate Sentinel CEF selector");
    seen.add(key);
    return source === undefined
      ? { vendor, product, classId, asset }
      : { vendor, product, classId, asset, source };
  });
}

/** Parse exactly the seven CEF fields. Extensions stay opaque. */
function decodeHeader(message: string): readonly string[] {
  const fields: string[] = [];
  let field = "";
  for (let index = 0; index < message.length; index++) {
    const character = message[index];
    if (character === "\\") {
      const escaped = message[++index];
      if (escaped !== "|" && escaped !== "\\") {
        throw new Error("Invalid escape in CEF header");
      }
      field += escaped;
    } else if (character === "|") {
      fields.push(field);
      if (fields.length === 7) return fields;
      field = "";
    } else {
      field += character;
    }
    if (field.length > 4096 || isControl(character)) {
      throw new Error("Invalid CEF header field");
    }
  }
  throw new Error("Incomplete CEF header");
}

/**
 * Adapt one CEF MSG already extracted from an authenticated collector's
 * RFC 5424 envelope. Selection uses vendor, product, class and optional source;
 * the configured asset identifies the affected scope. Reported severity and
 * arbitrary event text remain in the source system.
 */
export function adaptCefAlert(
  message: string,
  timestamp: string,
  source: string,
  selectors: readonly CefAlertSelector[],
): readonly unknown[] {
  if (!message.startsWith("CEF:")) return [];
  if (message.length > 64 * 1024 || /[\r\n]/.test(message)) {
    throw new Error("Invalid CEF message size or framing");
  }
  const [version, vendor, product, deviceVersion, classId, name, severity] =
    decodeHeader(message);
  if (version !== "CEF:0" && version !== "CEF:1") {
    throw new Error("Unsupported CEF version");
  }
  if (
    !vendor || !product || !deviceVersion || !classId || !name ||
    !validSeverity.test(severity)
  ) {
    throw new Error("Invalid CEF header fields or severity");
  }

  const matching = selectors.filter((selector) =>
    selector.vendor === vendor && selector.product === product &&
    selector.classId === classId
  );
  const selector = matching.find((candidate) => candidate.source === source) ??
    matching.find((candidate) => candidate.source === undefined);
  if (!selector) return [];
  if (identifier(source, "source hostname") === "-") {
    throw new Error("Expected an explicit RFC 5424 source hostname");
  }
  const time = Date.parse(timestamp);
  if (
    !utcTimestamp.test(timestamp) || !Number.isFinite(time) ||
    new Date(time).toISOString() !== timestamp
  ) {
    throw new Error("Expected an RFC 5424 message timestamp in UTC");
  }

  const digest = createHash("sha256").update(
    JSON.stringify([source, timestamp, message]),
  )
    .digest("hex");
  return [{
    version: 1,
    kind: "security_sensor_alert",
    id: `cef:${digest}`,
    timestamp,
    asset: selector.asset,
    subject: "CEF security alert",
  }];
}
