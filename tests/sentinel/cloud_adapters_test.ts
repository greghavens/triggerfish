import { assertEquals, assertThrows } from "@std/assert";
import { decodeSentinelCloudFeedLine } from "../../src/sentinel/cloud_adapters.ts";

const guardDuty = {
  source: "aws.guardduty",
  "detail-type": "GuardDuty Finding",
  time: "2026-11-01T02:00:00Z",
  id: "delivery-id",
  detail: {
    id: "finding-id",
    arn:
      "arn:aws:guardduty:us-east-1:123456789012:detector/example/finding/finding-id",
    updatedAt: "2026-11-01T01:59:00.12Z",
    type: "UnauthorizedAccess:EC2/Example",
    resource: {
      resourceType: "Instance",
      instanceDetails: {
        instanceId: "i-0123456789abcdef0",
        tags: [{ key: "tag", value: "omit tag details" }],
      },
    },
    description: "omit raw payload",
    service: { archived: false },
  },
};
const scc = {
  notificationConfigName: "organizations/123/notificationConfigs/security",
  finding: {
    name: "organizations/123/sources/42/locations/global/findings/finding-id",
    state: "ACTIVE",
    severity: "HIGH",
    eventTime: "2026-11-01T02:00:00.123456789Z",
    resourceName:
      "//compute.googleapis.com/projects/example/zones/us-central1-a/instances/app",
    category: "EXAMPLE_ALERT",
    sourceProperties: { password: "omit source properties" },
  },
};

Deno.test("GuardDuty adapter retains the stable finding reference and resource", () => {
  assertEquals(
    decodeSentinelCloudFeedLine(JSON.stringify(guardDuty), "guardduty"),
    {
      version: 1,
      id: guardDuty.detail.arn,
      timestamp: "2026-11-01T01:59:00.120Z",
      asset: "i-0123456789abcdef0",
      kind: "cloud_security_alert",
      subject: "GuardDuty UnauthorizedAccess:EC2/Example",
    },
  );

  const accessKey = {
    ...guardDuty,
    detail: {
      ...guardDuty.detail,
      arn: undefined,
      resource: {
        resourceType: "AccessKey",
        accessKeyDetails: {
          accessKeyId: "omit-key-id",
          principalId: "principal-42",
        },
      },
    },
  };
  const normalizedKeyFinding = decodeSentinelCloudFeedLine(
    JSON.stringify(accessKey),
    "guardduty",
  );
  assertEquals(normalizedKeyFinding?.id, "finding-id");
  assertEquals(normalizedKeyFinding?.asset, "principal-42");
});

Deno.test("SCC adapter decodes wrapped and unwrapped notifications without forwarding payload", () => {
  const expected = {
    version: 1,
    id: scc.finding.name,
    timestamp: "2026-11-01T02:00:00.123Z",
    asset: scc.finding.resourceName,
    kind: "cloud_security_alert",
    subject: "SCC EXAMPLE_ALERT",
  };
  assertEquals(
    decodeSentinelCloudFeedLine(JSON.stringify(scc), "scc"),
    expected,
  );
  assertEquals(
    decodeSentinelCloudFeedLine(
      JSON.stringify({
        message: {
          data: btoa(JSON.stringify(scc)),
          messageId: "delivery-id",
        },
        subscription: "projects/example/subscriptions/security",
      }),
      "scc",
    ),
    expected,
  );
});

Deno.test("Cloud adapters skip unrelated, archived, suppressed, and deleted records", () => {
  assertEquals(
    decodeSentinelCloudFeedLine(
      JSON.stringify({
        ...guardDuty,
        "detail-type": "GuardDuty Malware Protection Resource Status Active",
      }),
      "guardduty",
    ),
    undefined,
  );
  assertEquals(
    decodeSentinelCloudFeedLine(
      JSON.stringify({
        ...guardDuty,
        detail: { ...guardDuty.detail, service: { archived: true } },
      }),
      "guardduty",
    ),
    undefined,
  );
  assertEquals(
    decodeSentinelCloudFeedLine(
      JSON.stringify({ ...scc, deletedFinding: true }),
      "scc",
    ),
    undefined,
  );
  for (const overrides of [{ state: "INACTIVE" }, { mute: "MUTED" }]) {
    assertEquals(
      decodeSentinelCloudFeedLine(
        JSON.stringify({
          ...scc,
          finding: { ...scc.finding, ...overrides },
        }),
        "scc",
      ),
      undefined,
    );
  }
});

Deno.test("Cloud adapters reject malformed source records without leaking their payloads", () => {
  assertThrows(
    () =>
      decodeSentinelCloudFeedLine(
        JSON.stringify({
          ...guardDuty,
          detail: { ...guardDuty.detail, updatedAt: "2026-02-30T00:00:00Z" },
        }),
        "guardduty",
      ),
    Error,
    "Invalid cloud finding calendar timestamp",
  );
  assertThrows(
    () =>
      decodeSentinelCloudFeedLine(
        JSON.stringify({
          ...scc,
          finding: { ...scc.finding, resourceName: "\n" },
        }),
        "scc",
      ),
    Error,
    "Invalid cloud finding asset",
  );
  assertThrows(
    () =>
      decodeSentinelCloudFeedLine(
        JSON.stringify({
          message: { data: "###" },
        }),
        "scc",
      ),
    Error,
    "Expected base64 data",
  );
});
