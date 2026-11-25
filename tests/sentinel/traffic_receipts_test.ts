import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ingestSentinelTraffic } from "../../src/cli/commands/sentinel_traffic.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { importSentinelHar } from "../../src/sentinel/har.ts";
import { sentinelTrafficPath } from "../../src/sentinel/paths.ts";
import {
  readSentinelTrafficReceipt,
  readSentinelTrafficReceiptPage,
} from "../../src/sentinel/traffic_receipts.ts";

const input = [
  {
    startedDateTime: "2026-06-01T00:00:00Z",
    request: {
      url: "https://user:pass@safe.example/secret?token=concealed#discarded",
      method: "GET",
      headers: [{ name: "authorization", value: "secret token" }],
      postData: { text: "sensitive request body" },
    },
    response: { status: 200, content: { text: "sensitive response body" } },
  },
  {
    startedDateTime: "2026-06-02T00:00:00Z",
    request: { url: "https://safe.example/other", method: "POST" },
    response: { status: 403 },
  },
];

function lines(records: readonly unknown[]) {
  return new Blob([records.map((record) => JSON.stringify(record)).join("\n")])
    .stream();
}

Deno.test("CLI traffic receipts reopen saved evidence with scoped search and no raw HTTP data", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = join(directory, "sentinel.json");
    const another = join(directory, "other", "sentinel.json");
    for (const destination of [path, another]) {
      await ingestSentinelTraffic(
        lines(input),
        "configured source",
        destination,
      );
      await ingestSentinelTraffic(
        lines([{
          hostname: "SAFE.example.",
          addresses: ["192.0.2.20", "2001:db8::1"],
          timestamp: "2026-06-02T01:00:00Z",
          payload: "unretained DNS payload",
        }]),
        "trusted DNS",
        destination,
        "dns",
      );
      startSentinelAssessment(destination);
    }
    const revision = 1;
    const first = readSentinelTrafficReceiptPage(path, revision, {
      family: "har",
      limit: 1,
    });
    assert(first?.nextCursor);
    assertEquals(first.receipts.length, 1);
    const subsequent = readSentinelTrafficReceiptPage(path, revision, {
      family: "har",
      limit: 1,
      cursor: first.nextCursor,
    });
    assert(subsequent);
    assertEquals(subsequent.receipts.length, 1);
    assertEquals(subsequent.nextCursor, null);
    assert(first.receipts[0].evidenceId !== subsequent.receipts[0].evidenceId);
    assertEquals(
      readSentinelTrafficReceiptPage(another, revision, {
        family: "har",
        limit: 1,
        cursor: first.nextCursor,
      }),
      undefined,
    );
    assertEquals(
      readSentinelTrafficReceiptPage(path, revision, {
        family: "har",
        method: "GET",
        limit: 1,
        cursor: first.nextCursor,
      }),
      undefined,
    );
    const http = readSentinelTrafficReceiptPage(path, revision, {
      origin: "https://safe.example",
      method: "GET",
      status: 200,
      from: "2026-06-01T00:00:00.000Z",
      until: "2026-06-02T00:00:00.000Z",
    })?.receipts[0];
    assert(http);
    assertEquals(
      readSentinelTrafficReceipt(path, revision, http, http.assetIds[0]),
      http,
    );
    assertEquals(
      readSentinelTrafficReceipt(path, revision, http, "another-asset"),
      undefined,
    );
    assertEquals(
      readSentinelTrafficReceipt(path, revision, {
        ...http,
        digest: "a".repeat(64),
      }),
      undefined,
    );
    const dns = readSentinelTrafficReceiptPage(path, revision, {
      hostname: "safe.example",
      family: "dns",
    });
    assertEquals(dns?.receipts[0].assetIds.length, 3);
    for (
      const forbidden of [
        "secret",
        "concealed",
        "discarded",
        "sensitive",
        "pass@",
        "payload",
      ]
    ) {
      assert(!JSON.stringify([http, dns]).includes(forbidden));
    }
    await Deno.remove(sentinelTrafficPath(path));
    const latest = refreshSentinelAssessment(path);
    assert(latest && latest.revision > revision);
    assertEquals(
      readSentinelTrafficReceipt(path, latest.revision, http),
      undefined,
    );
    assertEquals(readSentinelTrafficReceipt(path, revision, http), http);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Unproven graph lookalikes never acquire a typed traffic receipt", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = join(directory, "sentinel.json");
    const graphOnly = importSentinelHar({
      log: { version: "1.2", entries: [input[0]] },
    }, "untrusted published graph").snapshot;
    await Deno.writeTextFile(path, JSON.stringify(graphOnly));
    const prior = startSentinelAssessment(path);
    assertEquals(
      readSentinelTrafficReceiptPage(path, prior.revision)?.receipts,
      [],
    );
    await ingestSentinelTraffic(lines(input.slice(0, 1)), "real source", path);
    const revised = refreshSentinelAssessment(path);
    assert(revised);
    const receipts = readSentinelTrafficReceiptPage(path, revised.revision)
      ?.receipts;
    assertEquals(receipts?.length, 1);
    assert(!graphOnly.nodes.some(({ id }) => id === receipts?.[0].evidenceId));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Independent DNS decoder families can retain separate receipts for the same observed answer", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = join(directory, "sentinel.json");
    const dns = {
      hostname: "same.example",
      addresses: ["192.0.2.1"],
      timestamp: "2026-06-02T01:00:00Z",
    };
    await ingestSentinelTraffic(lines([dns]), "same source", path, "dns");
    await ingestSentinelTraffic(
      lines([{
        query: dns.hostname,
        qtype: 1,
        rcode: 0,
        answers: dns.addresses,
        ts: Date.parse(dns.timestamp) / 1000,
      }]),
      "same source",
      path,
      "zeek-dns",
    );
    const { revision } = startSentinelAssessment(path);
    const first = readSentinelTrafficReceiptPage(path, revision, { limit: 1 });
    assert(first?.nextCursor);
    const second = readSentinelTrafficReceiptPage(path, revision, {
      limit: 1,
      cursor: first.nextCursor,
    });
    assert(second?.receipts.length === 1);
    assertEquals(first.receipts[0].evidenceId, second.receipts[0].evidenceId);
    assertEquals(first.receipts[0].family, "dns");
    assertEquals(second.receipts[0].family, "zeek-dns");
    assertEquals(
      readSentinelTrafficReceipt(path, revision, second.receipts[0]),
      second.receipts[0],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
