import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { renderSentinelProvenanceJson } from "../../src/sentinel/assessment_export.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import {
  listSentinelFindingTrafficLinks,
  openSentinelFindingTrafficLinks,
  type SentinelFindingTrafficLinkInput,
} from "../../src/sentinel/finding_traffic_links.ts";

const initial: SentinelFindingTrafficLinkInput = {
  caseId: "main",
  evidenceRevision: 2,
  assetId: "service",
  findingId: `worker-finding:${"1".repeat(64)}`,
  reportVersion: 1,
  trafficId: `har:evidence:${"2".repeat(64)}`,
  trafficSource: "har",
  trafficDigest: "3".repeat(64),
  authority: { kind: "assignment", taskId: `adaptive:${"4".repeat(64)}` },
  requestId: "f2671175-110d-44b6-8e3c-10a0365ade3a",
};

Deno.test("finding traffic links pin evidence and report versions across exact retries and restart", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(root);
    const peer = resolveSentinelCasePath(root, "peer");
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.mkdir(dirname(peer), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [],
        edges: [],
      }),
    );
    const assessment = startSentinelAssessment(path);
    const journal = join(dirname(path), "sentinel-finding-traffic-links.db");
    assertEquals(listSentinelFindingTrafficLinks(path), []);
    await assertRejects(() => Deno.lstat(journal), Deno.errors.NotFound);
    let currentRevision = 2;
    let currentReportVersion = 1;
    let checked = 0;
    const verifyNew = (input: SentinelFindingTrafficLinkInput) => {
      checked++;
      return input.evidenceRevision === currentRevision &&
        input.reportVersion === currentReportVersion;
    };
    let clock = 12_000;
    const writer = openSentinelFindingTrafficLinks(path, () => clock);
    const secondHandle = openSentinelFindingTrafficLinks(path, () => clock);
    try {
      const old = writer.record(initial, verifyNew);
      assert(old);
      assertEquals(old, {
        ...initial,
        id: old.id,
        recordedAt: new Date(clock).toISOString(),
      });
      assert(/^finding-traffic-link:[a-f0-9]{64}$/.test(old.id));
      assertEquals(checked, 1);

      currentRevision = 3;
      currentReportVersion = 2;
      clock += 5000;
      assertEquals(secondHandle.record(initial, verifyNew), old);
      assertEquals(checked, 1);
      assertEquals(
        secondHandle.record({
          ...initial,
          trafficDigest: "5".repeat(64),
        }, () => true),
        undefined,
      );
      assertEquals(
        secondHandle.record({
          ...initial,
          requestId: crypto.randomUUID(),
        }, verifyNew),
        undefined,
      );
      assertEquals(checked, 2);

      const newer = secondHandle.record({
        ...initial,
        recheckId: `worker-recheck:${"8".repeat(64)}`,
        evidenceRevision: 3,
        reportVersion: 2,
        trafficSource: "zeek-http",
        trafficId: "newer-exact-evidence",
        authority: { kind: "operator" },
        requestId: crypto.randomUUID(),
      }, verifyNew);
      assert(newer);
      assertEquals(checked, 3);
      assertEquals(writer.list(), [newer, old]);
      assertEquals(writer.list({ limit: 1, offset: 1 }), [old]);
      assertEquals(
        listSentinelFindingTrafficLinks(path, {
          evidenceRevision: 2,
          findingId: initial.findingId,
        }),
        [old],
      );
      assertEquals(listSentinelFindingTrafficLinks(peer), []);
      const exportRevision = (revision: number) =>
        JSON.parse(renderSentinelProvenanceJson(
          "main",
          {
            revision,
            updatedAt: new Date(clock).toISOString(),
            result: assessment.result,
            reviews: assessment.reviews,
          },
          undefined,
          path,
        ));
      assertEquals(exportRevision(2).findingTrafficLinks, [old]);
      assertEquals(exportRevision(3).findingTrafficLinks, [newer]);

      assertEquals(Object.hasOwn(newer, "outcome"), false);

      const wrapped = openSentinelFindingTrafficLinks(path);
      try {
        assertEquals(wrapped.list({ evidenceRevision: 3 }), [newer]);
        assertEquals(wrapped.record(initial, () => false), old);
        assertThrows(() =>
          wrapped.record({ ...initial, caseId: "peer" }, () => true)
        );
      } finally {
        wrapped.close();
      }
    } finally {
      secondHandle.close();
      writer.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("finding traffic journal rejects invalid receipt fields and rolls back failed authorization", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(root);
    await Deno.mkdir(dirname(path), { recursive: true });
    const store = openSentinelFindingTrafficLinks(path);
    try {
      assertThrows(
        () =>
          store.record(initial, () => {
            throw new Error("Trusted checks failed");
          }),
        Error,
        "Trusted checks failed",
      );
      assertEquals(store.list(), []);
      for (
        const malformed of [
          { trafficSource: "arbitrary" },
          { trafficDigest: "raw response text" },
          { recheckId: "r" },
          { evidenceRevision: 0 },
          { reportVersion: 0 },
          { requestId: "invalid" },
          { authority: { kind: "assignment", taskId: "wrong" } },
        ]
      ) {
        assertThrows(() =>
          store.record({
            ...initial,
            ...malformed,
          } as SentinelFindingTrafficLinkInput, () => true)
        );
      }
      const input = {
        ...initial,
        rawTraffic: "sensitive test body",
        outcome: "pass",
      };
      assert(store.record(input, () => true));
      const bytes = await Deno.readFile(
        join(dirname(path), "sentinel-finding-traffic-links.db"),
      );
      assert(!new TextDecoder().decode(bytes).includes(input.rawTraffic));
      assertEquals(Object.hasOwn(store.list()[0], "outcome"), false);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("finding traffic journal deduplicates a regenerated UUID without weakening stale checks", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(root);
    const directory = dirname(path);
    await Deno.mkdir(directory, { recursive: true });
    const first = openSentinelFindingTrafficLinks(path);
    let original;
    try {
      original = first.record(initial, () => true);
      assert(original);
    } finally {
      first.close();
    }

    // Exercise read-only compatibility and writable migration of the previous schema.
    const db = new DatabaseSync(
      join(directory, "sentinel-finding-traffic-links.db"),
    );
    try {
      db.exec(
        "DROP TABLE traffic_link_request_aliases; PRAGMA user_version = 1",
      );
    } finally {
      db.close();
    }
    assertEquals(listSentinelFindingTrafficLinks(path), [original]);
    const regenerated = { ...initial, requestId: crypto.randomUUID() };
    const upgraded = openSentinelFindingTrafficLinks(path);
    try {
      assertEquals(upgraded.record(regenerated, () => true), original);
      assertEquals(upgraded.list(), [original]);
    } finally {
      upgraded.close();
    }

    const restarted = openSentinelFindingTrafficLinks(path);
    try {
      assertEquals(restarted.record(regenerated, () => false), original);
      assertEquals(
        restarted.record({
          ...regenerated,
          trafficDigest: "f".repeat(64),
        }, () => true),
        undefined,
      );
      assertEquals(
        restarted.record({
          ...initial,
          requestId: crypto.randomUUID(),
        }, () => false),
        undefined,
      );
      assertEquals(restarted.list(), [original]);
    } finally {
      restarted.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
