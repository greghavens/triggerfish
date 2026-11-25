import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_SENTINEL_EVIDENCE_DIGEST_MEMBERS,
  openSentinelEvidenceDigests,
  type SentinelEvidenceDigestMember,
} from "../../src/sentinel/evidence_digests.ts";

const scope = {
  caseId: "local",
  runId: "00000000-0000-4000-8000-000000000001",
  evidenceRevision: 7,
};
const members: SentinelEvidenceDigestMember[] = [
  {
    id: "task:review",
    kind: "task",
    label: "Review control",
    status: "completed",
  },
  { id: "evidence:log", kind: "evidence", label: "Retained observation" },
];

Deno.test("Saved evidence digest reopens immutable member pages only for the exact run revision", async () => {
  const dir = await Deno.makeTempDir();
  const first = openSentinelEvidenceDigests(dir, () => 1000);
  const firstDigest = first.record(scope, { members });
  assert(firstDigest);
  try {
    const raw = [{ ...members[1], rawBody: "discarded" }, members[0]];
    assertEquals(first.record(scope, { members: raw }), firstDigest);
    assertEquals(firstDigest.memberCount, 2);
    assertEquals(firstDigest.createdAt, "1970-01-01T00:00:01.000Z");
    const page = first.expand(scope, firstDigest.id, 1);
    assert(page?.nextCursor);
    assertEquals(page.members, [members[1]]);
    assertEquals(
      first.expand(scope, firstDigest.id, 1, page.nextCursor)?.members,
      [members[0]],
    );
    const updated = first.record({ ...scope, evidenceRevision: 8 }, {
      members,
    });
    assert(updated);
    assert(updated.id !== firstDigest.id);
    assertEquals(
      first.expand({ ...scope, caseId: "peer" }, firstDigest.id),
      undefined,
    );
    assertEquals(
      first.expand({ ...scope, runId: crypto.randomUUID() }, firstDigest.id),
      undefined,
    );
    assertEquals(
      first.expand({ ...scope, evidenceRevision: 8 }, firstDigest.id),
      undefined,
    );
    assertEquals(
      first.expand(
        { ...scope, evidenceRevision: 8 },
        updated.id,
        1,
        page.nextCursor,
      ),
      undefined,
    );
    assertEquals(
      first.expand(scope, "sentinel-digest:" + "f".repeat(64)),
      undefined,
    );
    assertEquals(
      first.expand(scope, firstDigest.id, 1, firstDigest.id + ":256"),
      undefined,
    );
    assertEquals(
      first.list({ ...scope, evidenceRevision: 8 }, 1, firstDigest.id),
      undefined,
    );
    const other = first.record(scope, { members: [members[0]] });
    assert(other);
    const listed = first.list(scope, 1);
    assert(listed?.nextCursor);
    assertEquals(listed.digests, [other]);
    assertEquals(first.list(scope, 1, listed.nextCursor)?.digests, [
      firstDigest,
    ]);
    assertEquals(first.list(scope, 100), undefined);
  } finally {
    first.close();
  }
  const restarted = openSentinelEvidenceDigests(dir, () => 2000);
  try {
    assertEquals(restarted.record(scope, { members }), firstDigest);
    assertEquals(
      restarted.expand(scope, firstDigest.id)?.members,
      [...members].reverse(),
    );
  } finally {
    restarted.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Evidence digests reject invalid bounded projections and detect altered stored members", async () => {
  const dir = await Deno.makeTempDir();
  const journal = openSentinelEvidenceDigests(dir);
  try {
    for (
      const invalid of [
        [],
        [members[0], members[0]],
        [{ ...members[0], status: "x".repeat(81) }],
        [{ ...members[0], label: "bad\0text" }],
        [{ ...members[0], id: "x".repeat(1025) }],
        Array.from(
          { length: MAX_SENTINEL_EVIDENCE_DIGEST_MEMBERS + 1 },
          (_, index) => ({ ...members[0], id: "id-" + index }),
        ),
        Array.from(
          { length: 250 },
          (_, index) => ({
            ...members[0],
            id: "id-" + index,
            label: "é".repeat(500),
          }),
        ),
      ]
    ) assertEquals(journal.record(scope, { members: invalid }), undefined);
    const digest = journal.record(scope, { members });
    assert(digest);
    const database = new DatabaseSync(
      join(dir, "data", "sentinel-evidence-digests.db"),
    );
    try {
      database.prepare("UPDATE evidence_digests SET members = ? WHERE id = ?")
        .run(
          JSON.stringify([
            { ...members[1], label: "Altered after storage" },
            members[0],
          ]),
          digest.id,
        );
    } finally {
      database.close();
    }
    assertEquals(journal.expand(scope, digest.id), undefined);
    assertEquals(journal.record(scope, { members }), undefined);
    assertThrows(
      () => journal.recordBatch(scope, [[members[0]], members]),
      Error,
      "Conflicting Sentinel digest",
    );
    assertEquals(journal.list(scope)?.digests.map(({ id }) => id), [digest.id]);
  } finally {
    journal.close();
    await Deno.remove(dir, { recursive: true });
  }
});
