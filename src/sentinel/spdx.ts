/** Import package inventory and declared dependencies from SPDX JSON and compact JSON-LD. */
import { createHash } from "node:crypto";
import { MAX_EDGES, MAX_NODES } from "./assessment.ts";
import { loadSentinelGraph } from "./graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
const inverseDependencies = new Set([
  "DEPENDENCY_OF",
  "BUILD_DEPENDENCY_OF",
  "DEV_DEPENDENCY_OF",
  "OPTIONAL_DEPENDENCY_OF",
  "PROVIDED_DEPENDENCY_OF",
  "TEST_DEPENDENCY_OF",
  "RUNTIME_DEPENDENCY_OF",
]);

function record(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected an SPDX ${field} object`);
  }
  return raw as Record<string, unknown>;
}

function text(raw: unknown, field: string, maxLength = 1024): string {
  if (
    typeof raw !== "string" || !raw.trim() || raw.length > maxLength ||
    raw.includes("\x00")
  ) throw new Error(`Invalid SPDX ${field}`);
  return raw.trim();
}

function entries(raw: unknown, field: string, limit: number): unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > limit) {
    throw new Error(`Invalid or oversized SPDX ${field} array`);
  }
  return raw;
}

function readSpdx3(document: Record<string, unknown>) {
  if (
    typeof document["@context"] !== "string" ||
    !/^https:\/\/spdx\.org\/rdf\/3\.0\.[01]\/spdx-context\.jsonld$/.test(
      document["@context"],
    ) ||
    !Array.isArray(document["@graph"])
  ) throw new Error("Expected a compact SPDX 3.0.0 or 3.0.1 JSON-LD graph");

  const packages: unknown[] = [];
  const relationships: unknown[] = [];
  function reference(value: unknown) {
    return typeof value === "string"
      ? text(value, "element reference")
      : text(record(value, "element reference")["@id"], "element reference");
  }

  for (
    const raw of entries(document["@graph"], "graph", MAX_NODES + MAX_EDGES * 2)
  ) {
    const element = record(raw, "graph element");
    if (element.type === "software_Package") {
      packages.push({
        SPDXID: element.spdxId ?? element["@id"],
        name: element.name,
        versionInfo: element.software_packageVersion,
        ...(element.software_packageUrl !== undefined && {
          externalRefs: [{
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: element.software_packageUrl,
          }],
        }),
      });
    } else if (
      element.type === "Relationship" &&
      element.relationshipType === "dependsOn"
    ) {
      const dependencySource = reference(element.from);
      for (
        const destination of entries(
          element.to,
          "relationship destinations",
          MAX_EDGES,
        )
      ) {
        relationships.push({
          relationshipType: "DEPENDS_ON",
          spdxElementId: dependencySource,
          relatedSpdxElement: reference(destination),
        });
        if (relationships.length > MAX_EDGES * 2) {
          throw new Error("SPDX dependency limit exceeded");
        }
      }
    }
  }
  return { packages, relationships };
}

export function importSentinelSpdx(raw: unknown, source: string): Snapshot {
  const document = record(raw, "document");
  const legacy = document.spdxVersion === "SPDX-2.2" ||
    document.spdxVersion === "SPDX-2.3";
  const inventory = legacy ? document : readSpdx3(document);
  const project = text(source, "project namespace", 256);
  const packages = new Map<string, string>();
  const nodes: Snapshot["nodes"] = [];
  for (const rawPackage of entries(inventory.packages, "packages", MAX_NODES)) {
    const pkg = record(rawPackage, "package");
    const ref = text(pkg.SPDXID, "package ID");
    if (
      (legacy && !/^SPDXRef-[A-Za-z0-9.-]+$/.test(ref)) || packages.has(ref)
    ) {
      throw new Error("Invalid or duplicate SPDX package ID");
    }
    const name = text(pkg.name, "package name");
    const version = pkg.versionInfo === undefined
      ? undefined
      : text(pkg.versionInfo, "package version");
    const id = "spdx:asset:" +
      createHash("sha256").update(JSON.stringify([project, ref, name, version]))
        .digest("hex");
    const aliases = new Set<string>();
    for (
      const rawRef of entries(pkg.externalRefs, "external references", 128)
    ) {
      const external = record(rawRef, "external reference");
      if (
        external.referenceCategory !== "PACKAGE-MANAGER" ||
        external.referenceType !== "purl"
      ) continue;
      const purl = text(external.referenceLocator, "package URL", 4096);
      const encoded =
        /^pkg:[a-z][a-z0-9.+-]*\/[^\s?#]+@([^@/\s?#]+)(?:[?#][^\s]*)?$/i
          .exec(purl)?.[1];
      if (encoded === undefined) continue;
      let purlVersion: string;
      try {
        purlVersion = decodeURIComponent(encoded);
      } catch {
        continue;
      }
      if (version === undefined || purlVersion === version) aliases.add(purl);
    }
    if (aliases.size > 32) throw new Error("Too many SPDX package aliases");
    packages.set(ref, id);
    nodes.push({
      id,
      kind: "asset",
      label: version ? `${name}@${version}` : name,
      ...(aliases.size && { aliases: [...aliases].sort() }),
    });
  }

  const edges = new Map<string, Snapshot["edges"][number]>();
  for (
    const rawRelationship of entries(
      inventory.relationships,
      "relationships",
      MAX_EDGES * 2,
    )
  ) {
    const relationship = record(rawRelationship, "relationship");
    const type = text(relationship.relationshipType, "relationship type");
    const reverse = inverseDependencies.has(type);
    if (!reverse && type !== "DEPENDS_ON") continue;
    const left = packages.get(
      text(relationship.spdxElementId, "relationship source"),
    );
    const right = packages.get(
      text(relationship.relatedSpdxElement, "relationship destination"),
    );
    if (!left || !right) continue;
    const [from, to] = reverse ? [right, left] : [left, right];
    edges.set(JSON.stringify([from, to]), { from, to, relation: "depends_on" });
    if (edges.size > MAX_EDGES) {
      throw new Error("SPDX dependency limit exceeded");
    }
  }

  return loadSentinelGraph({ version: 1, nodes, edges: [...edges.values()] })
    .snapshot();
}
