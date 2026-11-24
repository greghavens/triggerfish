import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { publishSentinelInput } from "../../src/sentinel/published_input.ts";
import {
  digestSentinelSnapshot,
  readSharedSentinelFindingSource,
  sentinelSourceSnapshotPath,
} from "../../src/sentinel/shared_inventory.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

Deno.test({
  name:
    "An exact shared finding rejects a linked archive file or parent even with matching bytes",
  ignore: Deno.build.os === "windows",
  async fn() {
    const base = await Deno.makeTempDir();
    try {
      const snapshot = loadSentinelGraph({
        version: 1,
        nodes: [
          { id: "asset", kind: "asset", label: "Shared asset" },
          {
            id: "finding",
            kind: "finding",
            label: "Reported finding",
            severity: "high",
          },
        ],
        edges: [{ from: "finding", to: "asset", relation: "affects" }],
      }).snapshot();
      const reference = {
        caseId: "peer",
        snapshotDigest: digestSentinelSnapshot(snapshot),
        assetId: "asset",
        findingId: "finding",
      };
      const archive = sentinelSourceSnapshotPath(
        base,
        reference.caseId,
        reference.snapshotDigest,
      );
      const current = resolveSentinelCasePath(base, reference.caseId);
      const external = join(base, "same-content.json");
      await publishSentinelInput(current, snapshot);
      await publishSentinelInput(external, snapshot);
      await Deno.mkdir(dirname(archive), { recursive: true, mode: 0o700 });
      await Deno.symlink(external, archive);
      await assertRejects(
        () => readSharedSentinelFindingSource(base, reference),
        Error,
        "operator-controlled regular file",
      );

      await Deno.remove(archive);
      await publishSentinelInput(archive, snapshot);
      assertEquals(
        (await readSharedSentinelFindingSource(base, reference)).status,
        "available",
      );

      const relocated = join(base, "relocated-peer");
      await Deno.rename(dirname(archive), relocated);
      await Deno.symlink(relocated, dirname(archive));
      await assertRejects(
        () => readSharedSentinelFindingSource(base, reference),
        Error,
        "operator-controlled directory",
      );
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  },
});
