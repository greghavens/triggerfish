import { assert, assertEquals, assertThrows } from "@std/assert";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { importSentinelHar } from "../../src/sentinel/har.ts";

function har(entries: unknown[]) {
  return { log: { version: "1.2", entries } };
}

const entry = {
  startedDateTime: "2026-11-01T11:20:04.987654-07:00",
  request: {
    url:
      "HTTPS://fixture-user:fixture-password@ExAmPle.test:443/private-segment?q=private-query#private-fragment",
    method: "POST",
    cookies: [{ name: "private-cookie", value: "hidden" }],
    headers: [{ name: "Authorization", value: "private-authorization" }],
    queryString: [{ name: "q", value: "private-query" }],
    postData: { text: "private-request-body" },
  },
  response: {
    status: 401,
    statusText: "private-response-text",
    redirectURL: "https://other.test/private-redirect",
    content: { text: "private-response-body" },
  },
};

Deno.test("Sentinel imports only allowlisted origin, method, status, and timestamp", () => {
  const result = importSentinelHar(har([entry]), "test-project");
  const [record] = result.observations;
  assertEquals(record, {
    assetId: record.assetId,
    evidenceId: record.evidenceId,
    origin: "https://example.test",
    method: "POST",
    status: 401,
    startedAt: "2026-11-01T18:20:04.987Z",
  });
  assertEquals(
    record.assetId.match(/^har:asset:[0-9a-f]{64}$/)?.[0],
    record.assetId,
  );
  assertEquals(
    record.evidenceId.match(/^har:evidence:[0-9a-f]{64}$/)?.[0],
    record.evidenceId,
  );
  const snapshot = loadSentinelGraph(result.snapshot).snapshot();
  assertEquals(snapshot.nodes.map((node) => node.kind), ["asset", "evidence"]);
  assertEquals(
    snapshot.edges,
    result.observations.map(({ evidenceId, assetId }) => ({
      from: evidenceId,
      to: assetId,
      relation: "observed_on",
    })),
  );
  const serialized = JSON.stringify(result);
  assert(!serialized.includes("private-"));
  assert(!serialized.includes("fixture-"));
  assert(!serialized.includes("other.test"));
});

Deno.test("Sentinel hashes sanitized HAR identities and preserves repeated observations", () => {
  const scrubbed = {
    ...entry,
    request: { url: "https://example.test/a-distinct-path", method: "POST" },
    response: { status: 401 },
  };
  const a = importSentinelHar(har([entry]), "test-project");
  const b = importSentinelHar(har([scrubbed]), "test-project");
  const repeated = importSentinelHar(har([entry, scrubbed]), "test-project");
  assertEquals(a, b);
  assertEquals(repeated.observations[0], a.observations[0]);
  assertEquals(
    repeated.observations[0].assetId,
    repeated.observations[1].assetId,
  );
  assert(
    repeated.observations[0].evidenceId !== repeated.observations[1].evidenceId,
  );
  const differentProject = importSentinelHar(har([entry]), "other-project");
  assert(
    a.observations[0].assetId !== differentProject.observations[0].assetId,
  );
});

Deno.test("Sentinel skips non-HTTP records and represents custom methods and no HTTP status", () => {
  const unrecorded = {
    request: {
      url: "http://[2001:0db8::1]:8080/",
      method: "private-custom-method",
    },
    response: { status: 0 },
  };
  const result = importSentinelHar(
    har([
      { request: { url: `data:text/plain,${"x".repeat(18_000)}` } },
      unrecorded,
    ]),
    "test-project",
  );
  assertEquals(result.observations.length, 1);
  const [record] = result.observations;
  assertEquals(record.origin, "http://[2001:db8::1]:8080");
  assertEquals(record.method, "OTHER");
  assertEquals(record.startedAt, undefined);
  assertEquals(record.status, 0);
  assert(!JSON.stringify(result).includes("private-custom-method"));
});

Deno.test("Sentinel rejects malformed HAR input with bounded and sanitized errors", () => {
  for (
    const broken of [
      { ...entry, startedDateTime: "2026-02-30T11:00:00Z" },
      { ...entry, response: { status: -1 } },
      { ...entry, request: { url: "https://:private-port/", method: "POST" } },
      { ...entry, request: { url: "private-relative", method: "GET" } },
    ]
  ) {
    const error = assertThrows(
      () => importSentinelHar(har([broken]), "test-project"),
      Error,
    );
    assert(!error.message.includes("private-"));
  }
  assertThrows(
    () => importSentinelHar(har(Array(2001).fill(entry)), "test-project"),
    Error,
    "more than 2000",
  );
  assertThrows(
    () => importSentinelHar(har(Array(2000).fill(entry)), "test-project"),
    Error,
    "exceed 2000 Sentinel nodes",
  );
});
