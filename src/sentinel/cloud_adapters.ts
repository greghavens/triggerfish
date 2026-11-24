/** Read exported GuardDuty and Security Command Center finding notifications. */

export type SentinelCloudFeedFormat = "guardduty" | "scc";

interface CloudTelemetryEvent {
  readonly version: 1;
  readonly id: string;
  readonly timestamp: string;
  readonly asset: string;
  readonly kind: "cloud_security_alert";
  readonly subject: string;
}

type JsonObject = Record<string, unknown>;

function object(raw: unknown): JsonObject | undefined {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw as JsonObject
    : undefined;
}

function parseObject(text: string, message: string): JsonObject {
  let parsed: JsonObject | undefined;
  try {
    parsed = object(JSON.parse(text));
  } catch {
    throw new Error(message);
  }
  if (!parsed) throw new Error(message);
  return parsed;
}

function identifier(raw: unknown, name: string, limit = 256): string {
  if (
    typeof raw !== "string" || !raw.trim() || raw.length > limit ||
    Array.from(raw).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  ) {
    throw new Error(`Invalid cloud finding ${name}`);
  }
  return raw;
}

const utc = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

function timestamp(raw: unknown): string {
  const parts = typeof raw === "string" ? utc.exec(raw) : null;
  if (!parts) throw new Error("Expected a cloud finding UTC timestamp");
  const [, whole, fraction = ""] = parts;
  const millis = `${whole}.${fraction.padEnd(3, "0").slice(0, 3)}Z`;
  const time = Date.parse(millis);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== millis) {
    throw new Error("Invalid cloud finding calendar timestamp");
  }
  return millis;
}

function bucketAsset(resource: JsonObject): unknown {
  if (!Array.isArray(resource.s3BucketDetails)) return undefined;
  const assets = new Set(resource.s3BucketDetails.map((item) => {
    const bucket = object(item);
    return bucket?.arn ?? bucket?.name;
  }));
  if (assets.size > 1) {
    throw new Error(
      "Multiple affected GuardDuty buckets require separate normalized records",
    );
  }
  return assets.values().next().value;
}

function guardDutyAsset(resource: JsonObject | undefined): unknown {
  if (!resource) return undefined;
  switch (resource.resourceType) {
    case "Instance":
      return object(resource.instanceDetails)?.instanceId;
    case "Lambda": {
      const detail = object(resource.lambdaDetails);
      return detail?.functionArn ?? detail?.functionName;
    }
    case "EKSCluster":
    case "KubernetesCluster": {
      const detail = object(resource.eksClusterDetails);
      return detail?.arn ?? detail?.name;
    }
    case "ECSCluster": {
      const detail = object(resource.ecsClusterDetails);
      return detail?.arn ?? detail?.name;
    }
    case "RDSDBInstance": {
      const detail = object(resource.rdsDbInstanceDetails);
      return detail?.dbInstanceArn ?? detail?.dbInstanceIdentifier;
    }
    case "S3Bucket":
    case "S3Object":
      return bucketAsset(resource);
    case "Container":
      return object(resource.containerDetails)?.id;
    case "AccessKey":
      // Key IDs are not exported. Preserve the associated principal instead.
      return object(resource.accessKeyDetails)?.principalId;
    default:
      return undefined;
  }
}

function guardDuty(event: JsonObject): CloudTelemetryEvent | undefined {
  if (
    event.source !== "aws.guardduty" ||
    event["detail-type"] !== "GuardDuty Finding"
  ) {
    return undefined;
  }
  const finding = object(event.detail);
  if (!finding) throw new Error("Expected an EventBridge GuardDuty finding");
  const service = object(finding.service);
  if (service?.archived === true) return undefined;

  return {
    version: 1,
    id: identifier(finding.arn ?? finding.id, "ID"),
    timestamp: timestamp(finding.updatedAt ?? event.time),
    asset: identifier(guardDutyAsset(object(finding.resource)), "asset"),
    kind: "cloud_security_alert",
    subject: `GuardDuty ${identifier(finding.type, "type", 240)}`,
  };
}

function unwrapPubSub(envelope: JsonObject): JsonObject {
  if (!Object.hasOwn(envelope, "message")) return envelope;
  const data = object(envelope.message)?.data;
  if (
    typeof data !== "string" || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  ) {
    throw new Error("Expected base64 data in the SCC Pub/Sub message");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));
  } catch {
    throw new Error("Invalid SCC Pub/Sub message data");
  }
  return parseObject(decoded, "Expected an SCC notification in Pub/Sub data");
}

function scc(raw: JsonObject): CloudTelemetryEvent | undefined {
  const notification = unwrapPubSub(raw);
  if (
    !Object.hasOwn(notification, "finding") ||
    notification.deletedFinding === true
  ) {
    return undefined;
  }
  const finding = object(notification.finding);
  if (!finding) throw new Error("Expected an SCC finding object");
  if (finding.state === "INACTIVE" || finding.mute === "MUTED") {
    return undefined;
  }
  if (finding.state !== "ACTIVE") {
    throw new Error("Expected an SCC finding state");
  }

  return {
    version: 1,
    id: identifier(finding.name, "ID"),
    timestamp: timestamp(finding.eventTime),
    asset: identifier(
      finding.resourceName ?? object(notification.resource)?.name,
      "asset",
    ),
    kind: "cloud_security_alert",
    subject: `SCC ${identifier(finding.category, "category", 250)}`,
  };
}

/** Decode a delivered JSON line locally. Unrelated or suppressed records produce no event. */
export function decodeSentinelCloudFeedLine(
  text: string,
  format: SentinelCloudFeedFormat,
): CloudTelemetryEvent | undefined {
  const raw = parseObject(text, "Expected a JSON cloud feed record");
  return format === "guardduty" ? guardDuty(raw) : scc(raw);
}
