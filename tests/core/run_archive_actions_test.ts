import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  openRunArchiveActions,
  type RunArchiveActionInput,
} from "../../src/core/run_archive_actions.ts";

const identity = {
  kind: "sentinel" as const,
  id: "case-local",
  runId: "case-run-test",
  revision: 2,
};
const archiveDigest = "a".repeat(64);

function input(
  overrides: Partial<RunArchiveActionInput> = {},
): RunArchiveActionInput {
  return {
    identity,
    action: "archive",
    archiveId: "archive-fixture",
    requestId: crypto.randomUUID(),
    ...overrides,
  };
}

Deno.test("Archive action journal claims exact input once across independent handles", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "actions.db");
  let clock = 1000;
  const first = openRunArchiveActions(path, () => clock);
  const second = openRunArchiveActions(path, () => clock);
  try {
    const request = input();
    const accepted = first.admit(
      { ...request, path: "discarded raw path" } as RunArchiveActionInput,
    );
    assert(accepted?.admitted);
    assertEquals(accepted.record.status, "pending");
    assertEquals(Object.keys(accepted.record).sort(), [
      "action",
      "archiveId",
      "createdAt",
      "identity",
      "requestId",
      "status",
      "updatedAt",
    ]);
    assertEquals(
      second.admit({ ...request, requestId: request.requestId.toUpperCase() }),
      { admitted: false, record: accepted.record },
    );
    for (
      const change of [
        { archiveId: "different" },
        { action: "restore" as const },
        { identity: { ...identity, runId: "different-run" } },
        { identity: { ...identity, revision: 3 } },
      ]
    ) assertEquals(second.admit({ ...request, ...change }), undefined);
    assertEquals(
      second.complete(request, crypto.randomUUID(), "failed"),
      undefined,
    );
    assertEquals(
      second.complete(
        { ...request, archiveId: "another" },
        accepted.token,
        "failed",
      ),
      undefined,
    );
    clock++;
    assertEquals(
      first.complete(request, accepted.token, "succeeded"),
      undefined,
    );
    assertEquals(
      first.complete(request, accepted.token, "failed", archiveDigest),
      undefined,
    );
    assertEquals(first.readArchived(request.archiveId), undefined);
    const outcome = first.complete(
      request,
      accepted.token,
      "succeeded",
      archiveDigest,
    );
    assert(outcome);
    assertEquals(outcome.status, "succeeded");
    assertEquals(outcome?.archiveDigest, archiveDigest);
    assertEquals(first.readArchived(request.archiveId), outcome);
    assertEquals(outcome?.updatedAt, new Date(clock).toISOString());
    assertEquals(second.admit(request), { admitted: false, record: outcome });
    assertEquals(second.complete(request, accepted.token, "failed"), undefined);
    assertEquals(first.read(request.requestId), outcome);
    const alternate = input();
    const claim = second.admit(alternate);
    assert(claim?.admitted);
    assertEquals(
      second.complete(alternate, claim.token, "succeeded", "b".repeat(64)),
      undefined,
    );
    assertEquals(first.readArchived(request.archiveId), outcome);
  } finally {
    second.close();
    first.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Archive action history retains terminal and unresolved admissions without rerunning", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "actions.db");
  const started = openRunArchiveActions(path);
  const interrupted = input();
  const failed = input({
    action: "restore",
    identity: { ...identity, revision: 3 },
  });
  const other = input({ identity: { ...identity, id: "other-case" } });
  try {
    assert(started.admit(interrupted)?.admitted);
    const failedAdmission = started.admit(failed);
    assert(failedAdmission?.admitted);
    assertEquals(
      started.complete(failed, failedAdmission.token, "failed")?.status,
      "failed",
    );
    assert(started.admit(other)?.admitted);
  } finally {
    started.close();
  }
  const reopened = openRunArchiveActions(path);
  try {
    assertEquals(reopened.admit(interrupted)?.admitted, false);
    assertEquals(reopened.admit(interrupted)?.record.status, "pending");
    assertEquals(reopened.admit(failed)?.record.status, "failed");
    assertEquals(
      reopened.list(identity).records.map(({ requestId }) => requestId),
      [interrupted.requestId],
    );
    const { revision: _, ...run } = identity;
    const first = reopened.list(run, 1);
    assertEquals(first.records.map(({ requestId }) => requestId), [
      failed.requestId,
    ]);
    assert(first.nextBefore);
    assertEquals(
      reopened.list(run, 1, first.nextBefore).records.map(({ requestId }) =>
        requestId
      ),
      [interrupted.requestId],
    );
    assertEquals(reopened.list({ ...run, runId: "not-this-run" }).records, []);
    assertEquals(reopened.admit(input({ archiveId: "../unsafe" })), undefined);
    assertEquals(reopened.admit(input({ identity: run })), undefined);
    const alias = join(dir, "symbolic.db");
    await Deno.symlink(path, alias);
    assertThrows(
      () => openRunArchiveActions(alias),
      Error,
      "private regular database",
    );
  } finally {
    reopened.close();
    await Deno.remove(dir, { recursive: true });
  }
});
