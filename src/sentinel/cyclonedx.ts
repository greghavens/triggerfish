/** Import bounded CycloneDX component inventory and vulnerability assertions. */

import { createHash } from "node:crypto";
import type { loadSentinelGraph } from "./graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type Node = Snapshot["nodes"][number];
type Edge = Snapshot["edges"][number];
type Severity = Extract<Node, { kind: "finding" }>["severity"];

interface Component {
  readonly id: string;
  readonly version?: string;
}

const MAX_NODES = 2_000;
const MAX_EDGES = 8_000;
const MAX_COMPONENT_DEPTH = 32;
const MAX_INPUT_ENTRIES = 25_000;
const severities = ["info", "low", "medium", "high", "critical"] as const;
const excludedStates = new Set([
  "not_affected",
  "false_positive",
  "resolved",
  "resolved_with_pedigree",
]);

function object(raw: unknown, field: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected a CycloneDX ${field} object`);
  }
  return raw as Record<string, unknown>;
}

function text(raw: unknown, field: string, max = 1024): string {
  if (
    typeof raw !== "string" || !raw.trim() || raw.length > max ||
    [...raw].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code < 160);
    })
  ) {
    throw new Error(`Invalid CycloneDX ${field}`);
  }
  return raw;
}

function optionalText(raw: unknown, field: string, max?: number) {
  return raw === undefined ? undefined : text(raw, field, max);
}

function stableId(kind: Node["kind"], identity: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest(
    "hex",
  );
  return `cyclonedx:${kind}:${digest}`;
}

function purlParts(
  raw: unknown,
): { raw: string; version?: string } | undefined {
  const purl = optionalText(raw, "component PURL", 4096);
  if (purl === undefined) return undefined;
  if (!/^pkg:[a-z][a-z\d.+-]*\/[^/?#\s]+/i.test(purl) || /\s/.test(purl)) {
    throw new Error("Invalid CycloneDX component PURL");
  }
  const base = purl.split(/[?#]/, 1)[0];
  const encodedVersion = /@([^@/]+)$/.exec(base)?.[1];
  if (encodedVersion === undefined) return { raw: purl };
  let version: string;
  try {
    version = decodeURIComponent(encodedVersion);
  } catch {
    throw new Error("Invalid CycloneDX component PURL version");
  }
  return { raw: purl, version: text(version, "component PURL version") };
}

function highestSeverity(left: Severity, right: Severity): Severity {
  return severities.indexOf(left) >= severities.indexOf(right) ? left : right;
}

function entryReader() {
  let read = 0;
  return (raw: unknown, field: string): readonly unknown[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || (read += raw.length) > MAX_INPUT_ENTRIES) {
      throw new Error(`Invalid or oversized CycloneDX ${field} array`);
    }
    return raw;
  };
}

type Entries = ReturnType<typeof entryReader>;

function severity(raw: unknown, entries: Entries): Severity {
  let resolved: Severity = "info";
  for (const item of entries(raw, "ratings")) {
    const rating = object(item, "rating");
    const recognized = severities.find((name) => name === rating.severity);
    if (recognized !== undefined) {
      resolved = highestSeverity(resolved, recognized);
    }
  }
  return resolved;
}

function appliesToVersion(
  raw: unknown,
  installed: string | undefined,
  entries: Entries,
): "yes" | "no" | "unknown" {
  const versions = entries(raw, "affected versions");
  if (versions.length === 0) return "yes";
  let affected = false;
  let uncertain = false;
  for (const item of versions) {
    const version = object(item, "affected version");
    const exact = optionalText(version.version, "affected version number");
    const range = optionalText(version.range, "affected version range", 4096);
    if ((exact === undefined) === (range === undefined)) {
      throw new Error("Expected exactly one CycloneDX version or range");
    }
    const status = version.status ?? "affected";
    if (
      status !== "affected" && status !== "unaffected" && status !== "unknown"
    ) {
      throw new Error("Invalid CycloneDX affected version status");
    }
    if (range !== undefined && status !== "affected") uncertain = true;
    if (installed === undefined || exact !== installed) continue;
    if (status === "unaffected") return "no";
    if (status === "unknown") uncertain = true;
    if (status === "affected") affected = true;
  }
  return affected && !uncertain ? "yes" : "unknown";
}

/** Convert an operator-supplied CycloneDX document without resolving external links. */
export function importSentinelCycloneDx(
  raw: unknown,
  source: string,
): Snapshot {
  const project = text(source, "project namespace", 256);
  const bom = object(raw, "document");
  if (
    bom.bomFormat !== "CycloneDX" || typeof bom.specVersion !== "string" ||
    !/^1\.[0-7]$/.test(bom.specVersion)
  ) {
    throw new Error("Expected a supported CycloneDX 1.0–1.7 JSON document");
  }

  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const byRef = new Map<string, Component>();
  const entries = entryReader();

  function addNode(node: Node): void {
    if (!nodes.has(node.id) && nodes.size >= MAX_NODES) {
      throw new Error("CycloneDX inventory exceeds 2000 Sentinel nodes");
    }
    nodes.set(node.id, node);
  }

  function addEdge(edge: Edge): void {
    const key = JSON.stringify([edge.from, edge.relation, edge.to]);
    if (!edges.has(key) && edges.size >= MAX_EDGES) {
      throw new Error("CycloneDX inventory exceeds 8000 Sentinel edges");
    }
    edges.set(key, edge);
  }

  function component(raw: unknown, depth: number): void {
    if (depth > MAX_COMPONENT_DEPTH) {
      throw new Error("CycloneDX component nesting exceeds 32");
    }
    const input = object(raw, "component");
    const type = text(input.type, "component type");
    const name = text(input.name, "component name");
    const group = optionalText(input.group, "component group") ?? "";
    const declared = optionalText(input.version, "component version");
    const purl = purlParts(input.purl);
    if (
      purl?.version !== undefined && declared !== undefined &&
      purl.version !== declared
    ) {
      throw new Error("CycloneDX component and PURL versions disagree");
    }
    const version = declared ?? purl?.version;
    const id = stableId(
      "asset",
      purl === undefined
        ? [project, "coordinates", type, group, name, version ?? ""]
        : [
          project,
          "purl",
          purl.raw,
          purl.version === undefined ? version ?? "" : "",
        ],
    );
    const ref = optionalText(input["bom-ref"], "component bom-ref", 4096);
    if (ref !== undefined) {
      if (byRef.has(ref)) {
        throw new Error("Duplicate CycloneDX component bom-ref");
      }
      byRef.set(ref, { id, version });
    }

    const display = group ? `${group}/${name}` : name;
    const label = version === undefined ? display : `${display}@${version}`;
    const prior = nodes.get(id);
    // Representatives with the same package identity can appear with varying labels.
    // Choose deterministically without depending on source record order.
    if (prior === undefined || label < prior.label) {
      addNode({
        id,
        kind: "asset",
        label,
        ...(purl?.version !== undefined && { aliases: [purl.raw] }),
      });
    }
    for (const child of entries(input.components, "nested components")) {
      component(child, depth + 1);
    }
  }

  const top = bom.metadata === undefined
    ? undefined
    : object(bom.metadata, "metadata").component;
  if (top !== undefined) component(top, 0);
  for (const entry of entries(bom.components, "components")) {
    component(entry, 0);
  }

  for (const raw of entries(bom.dependencies, "dependencies")) {
    const dependency = object(raw, "dependency");
    const ref = text(dependency.ref, "dependency ref", 4096);
    const from = byRef.get(ref);
    for (const item of entries(dependency.dependsOn, "dependsOn")) {
      const target = text(item, "dependency target ref", 4096);
      const to = byRef.get(target);
      if (from && to && (from.id !== to.id || ref === target)) {
        addEdge({ from: from.id, to: to.id, relation: "depends_on" });
      }
    }
  }

  const assertions = new Map<
    string,
    {
      label: string;
      severity: Severity;
      active: boolean;
      assets: Map<string, boolean>;
    }
  >();
  for (const raw of entries(bom.vulnerabilities, "vulnerabilities")) {
    const vulnerability = object(raw, "vulnerability");
    const analysis = vulnerability.analysis === undefined
      ? undefined
      : object(vulnerability.analysis, "vulnerability analysis");
    const active = !excludedStates.has(
      typeof analysis?.state === "string" ? analysis.state : "",
    );
    const advisory = optionalText(vulnerability.id, "vulnerability ID");
    const localRef = optionalText(
      vulnerability["bom-ref"],
      "vulnerability bom-ref",
      4096,
    );
    if (advisory === undefined && localRef === undefined) continue;

    const publisher = vulnerability.source === undefined
      ? undefined
      : object(vulnerability.source, "vulnerability publisher");
    const name = optionalText(publisher?.name, "publisher name") ??
      optionalText(publisher?.url, "publisher URL", 4096) ?? "";
    const id = advisory !== undefined
      ? stableId("finding", [project, "advisory", name, advisory])
      : stableId("finding", [project, "bom-ref", localRef!]);
    const fact = assertions.get(id) ?? {
      label: advisory ?? localRef!,
      severity: "info",
      active: false,
      assets: new Map<string, boolean>(),
    };
    if (active) {
      fact.active = true;
      fact.severity = highestSeverity(
        fact.severity,
        severity(vulnerability.ratings, entries),
      );
    }
    for (
      const rawAffect of entries(vulnerability.affects, "affected components")
    ) {
      const affect = object(rawAffect, "affected component");
      const target = byRef.get(
        text(affect.ref, "affected component ref", 4096),
      );
      const result = appliesToVersion(
        affect.versions,
        target?.version,
        entries,
      );
      if (!target) continue;
      if (!active || result === "no") fact.assets.set(target.id, false);
      else if (result === "yes" && !fact.assets.has(target.id)) {
        fact.assets.set(target.id, true);
      }
    }
    assertions.set(id, fact);
  }

  for (const [id, finding] of assertions) {
    if (!finding.active) continue;
    const label = finding.label;
    const evidence = stableId("evidence", [project, id]);
    addNode({ id, kind: "finding", label, severity: finding.severity });
    addNode({
      id: evidence,
      kind: "evidence",
      label: `CycloneDX report ${project}: ${label}`,
    });
    addEdge({ from: evidence, to: id, relation: "supports" });
    for (const [asset, applies] of finding.assets) {
      if (applies) addEdge({ from: id, to: asset, relation: "affects" });
    }
  }

  return {
    version: 1,
    nodes: [...nodes.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id === b.id ? 0 : 1
    ),
    edges: [...edges.entries()].sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1)
      .map(([, edge]) => edge),
  };
}
