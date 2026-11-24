import { assert, assertEquals, assertThrows } from "@std/assert";
import { importSentinelCycloneDx } from "../../src/sentinel/cyclonedx.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";

const headers = { bomFormat: "CycloneDX", specVersion: "1.6" };
const project = "inventory-project";
const root = { type: "application", name: "site", "bom-ref": "app" };
const library = {
  type: "library",
  name: "widget",
  purl: "pkg:npm/widget@1.2.3",
  "bom-ref": "widget-old",
};
const update = {
  ...library,
  purl: "pkg:npm/widget@1.2.4",
  "bom-ref": "widget-new",
};

Deno.test("CycloneDX imports explicit package dependencies without inferring nesting", () => {
  const result = importSentinelCycloneDx({
    ...headers,
    metadata: { component: root },
    components: [{
      ...library,
      components: [{ type: "library", name: "nested" }],
    }],
    dependencies: [{
      ref: "app",
      dependsOn: ["widget-old", "external"],
      provides: ["nested"],
    }],
  }, project);
  const graph = loadSentinelGraph(result);
  assertEquals(graph.snapshot().nodes.map(({ label }) => label).sort(), [
    "nested",
    "site",
    "widget@1.2.3",
  ]);
  const dependency = result.nodes.find(({ label }) =>
    label === "widget@1.2.3"
  )!;
  const dependent = result.nodes.find(({ label }) => label === "site")!;
  assertEquals(graph.impact(dependency.id, 1).assets.map(({ id }) => id), [
    dependency.id,
    dependent.id,
  ]);
  assertEquals(result.edges.length, 1);
});

Deno.test("CycloneDX produces stable scoped identifiers across BOM ref and entry changes", () => {
  const initial = importSentinelCycloneDx({
    ...headers,
    components: [library, update],
  }, project);
  const reordered = importSentinelCycloneDx({
    ...headers,
    components: [update, {
      ...library,
      "bom-ref": "new-reference",
      version: "1.2.3",
    }],
  }, project);
  assertEquals(reordered, initial);
  assert(
    initial.nodes.every(({ id }) => /^cyclonedx:asset:[a-f0-9]{64}$/.test(id)),
  );
  const other = importSentinelCycloneDx(
    { ...headers, components: [library] },
    "other-project",
  );
  assert(!initial.nodes.some(({ id }) => id === other.nodes[0].id));
});

Deno.test("CycloneDX imports positively affected revisions and preserves the reported severity", () => {
  const result = importSentinelCycloneDx({
    ...headers,
    components: [library, update],
    vulnerabilities: [{
      id: "ADV-100",
      ratings: [{ severity: "medium" }, { severity: "critical" }],
      affects: [
        { ref: "widget-old", versions: [{ version: "1.2.3" }] },
        {
          ref: "widget-new",
          versions: [{ version: "1.2.4", status: "unaffected" }],
        },
      ],
      proofOfConcept: { reproductionSteps: "ignored source attachment field" },
    }, {
      id: "ADV-200",
      analysis: { state: "not_affected" },
      affects: [{ ref: "widget-old" }],
    }, {
      id: "ADV-300",
      affects: [{
        ref: "widget-old",
        versions: [{ range: "vers:npm/>=1.0.0" }],
      }],
    }],
  }, project);
  const graph = loadSentinelGraph(result);
  const target = result.nodes.find(({ label }) => label === "widget@1.2.3")!;
  const [first, third] = graph.report();
  assertEquals([first.label, first.severity, first.assets], [
    "ADV-100",
    "critical",
    [target.id],
  ]);
  assertEquals(first.evidence.length, 1);
  assertEquals([third.label, third.assets], ["ADV-300", []]);
  assert(!JSON.stringify(result).includes("ignored source attachment field"));
});

Deno.test("CycloneDX retains vulnerability identity as further affected assets appear", () => {
  const build = (affects: { ref: string }[]) =>
    importSentinelCycloneDx({
      ...headers,
      components: [library, update],
      vulnerabilities: [{ id: "ADV-100", affects }],
    }, project);
  const [before] = loadSentinelGraph(build([{ ref: "widget-old" }])).report();
  const [after] = loadSentinelGraph(
    build([{ ref: "widget-old" }, { ref: "widget-new" }]),
  ).report();
  assertEquals(before.id, after.id);
  assertEquals([before.assets.length, after.assets.length], [1, 2]);
});

Deno.test("CycloneDX validates conflicting refs and bounds publication size", () => {
  assertThrows(
    () =>
      importSentinelCycloneDx(
        { ...headers, components: [library, library] },
        project,
      ),
    Error,
    "Duplicate CycloneDX component bom-ref",
  );
  assertThrows(
    () =>
      importSentinelCycloneDx({
        ...headers,
        components: Array.from(
          { length: 2_001 },
          (_, i) => ({ type: "library", name: String(i) }),
        ),
      }, project),
    Error,
    "exceeds 2000 Sentinel nodes",
  );
  assertThrows(
    () => importSentinelCycloneDx({ ...headers, specVersion: "2.0" }, project),
    Error,
    "Expected a supported CycloneDX",
  );
});
