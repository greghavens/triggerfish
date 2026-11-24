import { importSentinelOsvScanner } from "../../src/sentinel/osv_scanner.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { importSentinelCycloneDx } from "../../src/sentinel/cyclonedx.ts";
import { publishSentinelInput } from "../../src/sentinel/published_input.ts";
import {
  readSharedSentinelAssetLinks,
  readSharedSentinelAssets,
} from "../../src/sentinel/shared_inventory.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { importSentinelSpdx } from "../../src/sentinel/spdx.ts";

const document = {
  spdxVersion: "SPDX-2.3",
  packages: [
    { SPDXID: "SPDXRef-app", name: "app", versionInfo: "1" },
    {
      SPDXID: "SPDXRef-lib",
      name: "lib",
      versionInfo: "2",
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: "pkg:npm/lib@2",
      }],
    },
  ],
  relationships: [
    {
      spdxElementId: "SPDXRef-app",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: "SPDXRef-lib",
    },
    {
      spdxElementId: "SPDXRef-lib",
      relationshipType: "RUNTIME_DEPENDENCY_OF",
      relatedSpdxElement: "SPDXRef-app",
    },
    {
      spdxElementId: "SPDXRef-app",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: "DocumentRef-other:SPDXRef-external",
    },
  ],
};

Deno.test("SPDX maps local packages and inverse dependencies without resolving external documents", () => {
  const result = importSentinelSpdx(document, "review");
  assertEquals(result.nodes.map(({ kind, label }) => [kind, label]), [
    ["asset", "app@1"],
    ["asset", "lib@2"],
  ]);
  const [app, lib] = result.nodes;
  assertEquals(lib.kind === "asset" && lib.aliases, ["pkg:npm/lib@2"]);
  assertEquals(result.edges, [{
    from: app.id,
    to: lib.id,
    relation: "depends_on",
  }]);
  assertEquals(importSentinelSpdx(document, "review"), result);
});

Deno.test("SPDX rejects duplicate package IDs and unsupported versions", () => {
  assertThrows(() =>
    importSentinelSpdx({ ...document, spdxVersion: "SPDX-3.0" }, "review")
  );
  assertThrows(() =>
    importSentinelSpdx({
      ...document,
      packages: [document.packages[0], document.packages[0]],
    }, "review")
  );
});

Deno.test("SPDX 3 compact JSON-LD imports package URLs and multi-destination dependencies locally", () => {
  const graph = {
    "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
    "@graph": [
      { type: "software_Package", spdxId: "urn:app", name: "application" },
      {
        type: "software_Package",
        "@id": "urn:lib",
        name: "library",
        software_packageVersion: "2",
        software_packageUrl: "pkg:npm/library@2",
      },
      { type: "software_File", spdxId: "urn:file", name: "file" },
      {
        type: "Relationship",
        from: "urn:app",
        relationshipType: "dependsOn",
        to: [
          { "@id": "urn:lib" },
          "urn:file",
          "urn:external",
        ],
      },
    ],
  };
  const snapshot = importSentinelSpdx(graph, "review");
  const [app, lib] = snapshot.nodes;
  assertEquals(snapshot.nodes.length, 2);
  assertEquals(lib.kind === "asset" && lib.aliases, ["pkg:npm/library@2"]);
  assertEquals(snapshot.edges, [{
    from: app.id,
    to: lib.id,
    relation: "depends_on",
  }]);
  assertThrows(() =>
    importSentinelSpdx({
      ...graph,
      "@context": "https://example.invalid/spdx-context.jsonld",
    }, "review")
  );
});

Deno.test("Versioned package URLs correlate SPDX and CycloneDX inventory without merging other versions", async () => {
  const baseDir = await Deno.makeTempDir();
  try {
    await publishSentinelInput(
      resolveSentinelCasePath(baseDir, "spdx"),
      importSentinelSpdx(document, "review"),
    );
    const cyclone = importSentinelCycloneDx({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [
        { type: "library", name: "lib", version: "2", purl: "pkg:npm/lib@2" },
        { type: "library", name: "lib", version: "3", purl: "pkg:npm/lib@3" },
      ],
    }, "review");
    await publishSentinelInput(
      resolveSentinelCasePath(baseDir, "cyclone"),
      cyclone,
    );
    await publishSentinelInput(
      resolveSentinelCasePath(baseDir, "osv"),
      importSentinelOsvScanner({
        results: [{
          source: { path: "package-lock.json" },
          packages: [{
            package: { ecosystem: "npm", name: "lib", version: "2" },
            vulnerabilities: [{
              id: "OSV-example",
              database_specific: { severity: "HIGH" },
            }],
          }],
        }],
      }, "scan"),
    );
    const inventory = await readSharedSentinelAssets(
      baseDir,
      "pkg:npm/lib@",
      0,
      10,
    );
    assertEquals(inventory.totalAssets, 2);
    const versionTwo = inventory.assets.find(({ sources }) =>
      sources.some(({ aliases }) => aliases?.includes("pkg:npm/lib@2"))
    );
    assertEquals(versionTwo?.sources.map(({ caseId }) => caseId), [
      "cyclone",
      "osv",
      "spdx",
    ]);
    const versionThree = inventory.assets.find(({ sources }) =>
      sources.some(({ aliases }) => aliases?.includes("pkg:npm/lib@3"))
    );
    assertEquals(versionThree?.sources.length, 1);
    const reference = loadSentinelGraph(cyclone).snapshot();
    const graph = loadSentinelGraph(cyclone);
    const versionTwoId = graph.resolveAssetId("pkg:npm/lib@2");
    const versionThreeId = graph.resolveAssetId("pkg:npm/lib@3");
    assert(versionTwoId && versionThreeId);
    const affected = await readSharedSentinelAssetLinks(
      baseDir,
      versionTwoId,
      0,
      20,
      undefined,
      reference,
      true,
    );
    assertEquals(affected.totalFindings, 1);
    assertEquals(
      affected.findings?.map(({ caseId, assetId, finding }) => ({
        caseId,
        assetId,
        label: finding.label,
        severity: finding.severity,
      })),
      [{
        caseId: "osv",
        assetId: versionTwo?.sources.find(({ caseId }) => caseId === "osv")
          ?.assetId,
        label: "OSV-example",
        severity: "high",
      }],
    );
    const unaffected = await readSharedSentinelAssetLinks(
      baseDir,
      versionThreeId,
      0,
      20,
      undefined,
      reference,
      true,
    );
    assertEquals(unaffected.findings, []);
    const topology = await readSharedSentinelAssetLinks(
      baseDir,
      versionTwoId,
      0,
      20,
      undefined,
      reference,
    );
    assertEquals(topology.findings, undefined);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
