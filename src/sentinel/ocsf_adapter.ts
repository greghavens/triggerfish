/** Normalize source-reported OCSF Detection Findings for defensive triage. */

import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

interface OcsfTelemetryEvent {
  readonly version: 1;
  readonly kind: "security_sensor_alert";
  readonly id: string;
  readonly timestamp: string;
  readonly asset: string;
  readonly subject: "OCSF Detection Finding";
}

function object(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected an OCSF ${field} object`);
  }
  return value as JsonObject;
}

function optionalObject(value: unknown, field: string) {
  return value === undefined ? undefined : object(value, field);
}

function identifier(value: unknown, field: string, maxLength = 256): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > maxLength || value.trim() !== value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code < 160);
    })
  ) {
    throw new Error(`Invalid OCSF ${field}`);
  }
  return value;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : identifier(value, field, 4096);
}

function eventTimestamp(value: unknown): string {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
    value > 253402300799999
  ) {
    throw new Error("Expected OCSF time in Unix milliseconds");
  }
  return new Date(value).toISOString();
}

function targetAssetIds(finding: JsonObject): string[] {
  const resources = finding.resources;
  if (resources !== undefined && !Array.isArray(resources)) {
    throw new Error("Expected an OCSF resources array");
  }
  if (resources?.length) {
    const targets = new Set<string>();
    for (const raw of resources) {
      const resource = object(raw, "resource");
      // The class describes affected resources. An explicit non-target role
      // in the resource record overrides that default context.
      if (resource.role_id !== undefined && resource.role_id !== 1) continue;
      if (resource.uid === undefined) continue;
      targets.add(identifier(resource.uid, "resource.uid"));
    }
    return [...targets];
  }

  const device = optionalObject(finding.device, "device");
  if (!device || device.uid === undefined) return [];
  return [identifier(device.uid, "device.uid")];
}

/**
 * Consume trusted producer metadata for Detection Finding class 2004.
 * Unsupported classes, closed findings, and findings without stable asset IDs
 * yield no events. Multi-resource findings yield one event per target UID.
 */
export function adaptOcsfEvent(raw: unknown): readonly OcsfTelemetryEvent[] {
  const record = object(raw, "event");
  if (record.class_uid !== 2004) return [];
  const activity = record.activity_id;
  if (
    activity !== 0 && activity !== 1 && activity !== 2 && activity !== 3 &&
    activity !== 99
  ) {
    throw new Error("Invalid OCSF Detection Finding activity_id");
  }
  if (activity !== 1 && activity !== 2) return [];
  const timestamp = eventTimestamp(record.time);
  const info = object(record.finding_info, "finding_info");
  const uid = identifier(info.uid, "finding_info.uid", 4096);
  const source = optionalObject(record.metadata, "metadata");
  const product = optionalObject(info.product, "finding_info.product") ??
    optionalObject(source?.product, "metadata.product");
  const productUid = optionalIdentifier(
    info.product_uid ?? product?.uid,
    "product UID",
  );
  const productName = optionalIdentifier(product?.name, "product name");
  const vendorName = optionalIdentifier(product?.vendor_name, "vendor name");
  const identity = productUid === undefined
    ? [vendorName, productName, uid]
    : [productUid, uid];
  const hash = createHash("sha256").update(JSON.stringify(identity)).digest(
    "hex",
  );
  return targetAssetIds(record).map((asset) => ({
    version: 1,
    kind: "security_sensor_alert",
    id: `ocsf:${hash}`,
    timestamp,
    asset,
    subject: "OCSF Detection Finding",
  }));
}
