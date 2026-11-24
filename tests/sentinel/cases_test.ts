import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import {
  isSentinelAssessmentRunning,
  pauseSentinelAssessment,
  resumeSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { startSentinelCaseManager } from "../../src/gateway/sentinel_case_manager.ts";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../../src/sentinel/cases.ts";

Deno.test("Sentinel named cases are path scoped and preserve the main location", async () => {
  const base = await Deno.makeTempDir();
  try {
    const main = join(base, "data", "sentinel.json");
    assertEquals(resolveSentinelCasePath(base), main);
    assertEquals(resolveSentinelCasePath(base, "main"), main);
    const root = join(base, "data", "sentinel-cases");
    for (const id of ["east", "west-1", "main", "bad.name"]) {
      await Deno.mkdir(join(root, id), { recursive: true, mode: 0o700 });
    }
    assertEquals(listSentinelCaseIds(base), ["east", "west-1"]);
    assertEquals(
      resolveSentinelCasePath(base, "west-1"),
      join(root, "west-1", "sentinel.json"),
    );
    for (
      const invalid of [
        "../escape",
        "/absolute",
        "a\\b",
        "Uppercase",
        "-",
        "con",
        "a".repeat(49),
      ]
    ) {
      assertThrows(
        () => resolveSentinelCasePath(base, invalid),
        Error,
        "case ID",
      );
    }
    if (Deno.build.os !== "windows") {
      await Deno.symlink(join(root, "east"), join(root, "link"));
      assertEquals(listSentinelCaseIds(base), ["east", "west-1"]);
      assertThrows(
        () => resolveSentinelCasePath(base, "link"),
        Error,
        "operator-controlled",
      );
      await Deno.symlink(
        join(root, "east"),
        join(root, "west-1", "sentinel.json"),
      );
      assertThrows(
        () => resolveSentinelCasePath(base, "west-1"),
        Error,
        "regular file",
      );
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("Sentinel case manager bounds active coordinators and reclaims released slots", async () => {
  const base = await Deno.makeTempDir();
  const root = join(base, "data", "sentinel-cases");
  const active = new Set<string>();
  const started: string[] = [];
  const stopped: string[] = [];
  const caseId = (path: string) => basename(dirname(path));
  try {
    let time = 0;
    let busy = "case-02";
    for (let index = 1; index <= 14; index++) {
      const id = `case-${String(index).padStart(2, "0")}`;
      active.add(id);
      await Deno.mkdir(join(root, id), { recursive: true, mode: 0o700 });
    }
    await Deno.mkdir(join(root, "main"));
    const manager = startSentinelCaseManager(base, (path) => {
      const id = caseId(path);
      started.push(id);
      return {
        canYield: () => id !== busy,
        stop: () => {
          stopped.push(id);
        },
      };
    }, {
      intervalMs: 300000,
      now: () => time,
      isActiveCase: (path) => active.has(caseId(path)),
    });
    try {
      assertEquals(started.length, 12);
      assertEquals(manager.coordinatorState("case-14"), "waiting");
      assertEquals(started.at(-1), "case-12");
      manager.refresh();
      assertEquals(started.length, 12);
      active.delete("case-01");
      manager.refresh();
      assertEquals(stopped, ["case-01"]);
      assertEquals(started.at(-1), "case-13");
      time = 120_000;
      manager.refresh();
      assertEquals(stopped.at(-1), "case-03");
      assertEquals(started.at(-1), "case-14");
      assertEquals(manager.coordinatorState("case-14"), "scheduled");
      busy = "";
      manager.refresh();
      assertEquals(stopped.at(-1), "case-02");
      assertEquals(started.at(-1), "case-03");
    } finally {
      manager.stop();
      manager.stop();
    }
    assertEquals(stopped.length, 15);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("Pausing a named assessment releases its coordinator slot until resume", async () => {
  const base = await Deno.makeTempDir();
  try {
    for (let index = 1; index <= 13; index++) {
      const id = `case-${String(index).padStart(2, "0")}`;
      startSentinelAssessment(resolveSentinelCasePath(base, id));
    }
    const manager = startSentinelCaseManager(base, () => ({ stop() {} }), {
      intervalMs: 300_000,
      isActiveCase: isSentinelAssessmentRunning,
    });
    try {
      const first = resolveSentinelCasePath(base, "case-01");
      assertEquals(manager.coordinatorState("case-13"), "waiting");
      assertEquals(pauseSentinelAssessment(first), true);
      manager.refresh();
      assertEquals(manager.coordinatorState("case-01"), undefined);
      assertEquals(manager.coordinatorState("case-13"), "scheduled");
      assert(resumeSentinelAssessment(first));
      manager.refresh();
      assertEquals(manager.coordinatorState("case-01"), "waiting");
    } finally {
      manager.stop();
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("Shared topology maps only unambiguous asset aliases and preserves source IDs", async () => {
  const base = await Deno.makeTempDir();
  try {
    const { publishSentinelInput } = await import(
      "../../src/sentinel/published_input.ts"
    );
    const {
      applySharedSentinelTopology,
      collectSharedSentinelTopology,
      digestSentinelSnapshot,
      readSharedSentinelAssetLinks,
      readSharedSentinelAssets,
    } = await import("../../src/sentinel/shared_inventory.ts");
    const local = {
      version: 1,
      nodes: [
        {
          id: "app-local",
          kind: "asset",
          label: "Application",
          aliases: ["dns:app.example"],
        },
        {
          id: "db-local",
          kind: "asset",
          label: "Database",
          aliases: ["dns:db.example"],
        },
      ],
      edges: [],
    };
    const path = resolveSentinelCasePath(base, "main");
    await publishSentinelInput(path, local);
    const source = {
      version: 1,
      nodes: [
        {
          id: "app-remote",
          kind: "asset",
          label: "Remote application",
          aliases: ["dns:app.example"],
        },
        {
          id: "db-remote",
          kind: "asset",
          label: "Remote database",
          aliases: ["dns:db.example"],
        },
      ],
      edges: [{ from: "app-remote", to: "db-remote", relation: "depends_on" }],
    };
    await publishSentinelInput(resolveSentinelCasePath(base, "valid"), source);
    const grouped = await readSharedSentinelAssets(base, "app-remote", 0, 10);
    assertEquals(grouped.assets, [{
      id: "app-local",
      sources: [
        {
          caseId: "main",
          label: "Application",
          aliases: ["dns:app.example"],
        },
        {
          caseId: "valid",
          label: "Remote application",
          aliases: ["dns:app.example"],
          assetId: "app-remote",
        },
      ],
    }]);
    const indirectPath = resolveSentinelCasePath(base, "indirect");
    await publishSentinelInput(indirectPath, {
      ...source,
      nodes: source.nodes.map(({ id, label, kind }) => ({ id, label, kind })),
    });
    const indirect = await readSharedSentinelAssetLinks(
      base,
      "app-local",
      0,
      10,
      undefined,
      loadSentinelGraph(local).snapshot(),
    );
    assertEquals(indirect.links, [{
      from: "app-local",
      to: "db-local",
      relation: "depends_on",
      caseIds: ["indirect", "valid"],
      remapped: ["indirect", "valid"].map((caseId) => ({
        caseId,
        from: "app-remote",
        to: "db-remote",
      })),
    }]);
    const synced = await collectSharedSentinelTopology(base, "main", path);
    assertEquals(
      synced.map(({ sourceDigests, ...link }) => link),
      indirect.links,
    );
    const digest = digestSentinelSnapshot(loadSentinelGraph(source).snapshot());
    assertEquals(synced[0].sourceDigests?.valid, digest);
    assert(synced[0].sourceDigests?.indirect !== digest);
    await Deno.remove(dirname(indirectPath), { recursive: true });
    await publishSentinelInput(resolveSentinelCasePath(base, "ambiguous"), {
      ...source,
      nodes: [...source.nodes, { ...source.nodes[0], id: "another-app" }],
    });
    const overlay = await collectSharedSentinelTopology(base, "main", path);
    assertEquals(overlay, [{
      from: "app-local",
      to: "db-local",
      relation: "depends_on",
      caseIds: ["valid"],
      sourceDigests: { valid: digest },
      remapped: [{ caseId: "valid", from: "app-remote", to: "db-remote" }],
    }]);
    const sharedLinks = await readSharedSentinelAssetLinks(
      base,
      "app-local",
      0,
      10,
      undefined,
      loadSentinelGraph(local).snapshot(),
    );
    assertEquals(
      sharedLinks.links,
      overlay.map(({ sourceDigests, ...link }) => link),
    );
    const graph = applySharedSentinelTopology(local, overlay);
    assert(
      graph.nodes.some(({ label }) =>
        label.includes("valid: app-remote → db-remote")
      ),
    );
    const evidence = loadSentinelGraph(graph).snapshot().nodes.find(
      (node) => node.kind === "evidence",
    );
    assert(evidence?.kind === "evidence");
    assertEquals(evidence.relationshipSources, [{
      caseId: "valid",
      from: "app-remote",
      to: "db-remote",
      snapshotDigest: digest,
    }]);
    assert(!graph.nodes.some(({ id }) => id === "app-remote"));
    const corroborated = {
      ...local,
      edges: [{ from: "app-local", to: "db-local", relation: "depends_on" }],
    };
    await publishSentinelInput(path, corroborated);
    const corroboration = await collectSharedSentinelTopology(
      base,
      "main",
      path,
    );
    assertEquals(corroboration, overlay);
    const withSources = applySharedSentinelTopology(
      corroborated,
      corroboration,
    );
    assertEquals(
      withSources.edges.filter(({ relation }) => relation === "depends_on"),
      corroborated.edges,
    );
    assert(
      withSources.nodes.some(({ label }) =>
        label.includes("reported by valid")
      ),
    );
    const matches = await readSharedSentinelAssets(
      base,
      "dns:app.example",
      0,
      10,
    );
    assertEquals(matches.assets.map(({ id }) => id), [
      "another-app",
      "app-local",
      "app-remote",
    ]);
    await Deno.remove(dirname(resolveSentinelCasePath(base, "valid")), {
      recursive: true,
    });
    const withdrawn = await collectSharedSentinelTopology(base, "main", path);
    assertEquals(withdrawn, []);
    assertEquals(
      applySharedSentinelTopology(corroborated, withdrawn).edges,
      corroborated.edges,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
