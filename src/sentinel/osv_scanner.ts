/** Import existing OSV-Scanner JSON findings and their package relationships. */
import { createHash } from "node:crypto";
import { MAX_EDGES, MAX_NODES } from "./assessment.ts";
import { loadSentinelGraph } from "./graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type Node = Snapshot["nodes"][number];
type Edge = Snapshot["edges"][number];
const severityOrder = ["info", "low", "medium", "high", "critical"] as const;
type Severity = typeof severityOrder[number];

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid OSV-Scanner ${field}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > 1024 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) throw new Error(`Invalid OSV-Scanner ${field}`);
  return value;
}

function entries(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 25_000) {
    throw new Error(`Invalid OSV-Scanner ${field}`);
  }
  return value;
}

function id(kind: string, values: readonly string[]) {
  return `osv:${kind}:${
    createHash("sha256").update(JSON.stringify(values)).digest("hex")
  }`;
}

function reportedSeverity(advisory: Record<string, unknown>): Severity {
  const raw = advisory.database_specific;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "info";
  const severity = (raw as Record<string, unknown>).severity;
  return typeof severity === "string"
    ? severityOrder.find((value) => value === severity.toLowerCase()) ?? "info"
    : "info";
}

function severityFromScore(value: unknown): Severity {
  const score = typeof value === "string" && /^\d{1,2}(?:\.\d+)?$/.test(value)
    ? Number(value)
    : NaN;
  if (!Number.isFinite(score) || score < 0 || score > 10) return "info";
  return score >= 9
    ? "critical"
    : score >= 7
    ? "high"
    : score >= 4
    ? "medium"
    : score > 0
    ? "low"
    : "info";
}

function higherSeverity(a: Severity, b: Severity): Severity {
  return severityOrder.indexOf(a) >= severityOrder.indexOf(b) ? a : b;
}

function inferPackageUrl(
  ecosystem: string,
  name: string,
  version: string,
): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(version)) return undefined;
  const encodedVersion = encodeURIComponent(
    ecosystem === "PyPI" ? version.toLowerCase() : version,
  );
  const simple = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  switch (ecosystem) {
    case "npm": {
      const components = /^(@[A-Za-z0-9._-]+\/)?([A-Za-z0-9][A-Za-z0-9._-]*)$/
        .exec(name);
      if (!components) return undefined;
      const scope = components[1]
        ? `${encodeURIComponent(components[1].slice(0, -1))}/`
        : "";
      return `pkg:npm/${scope}${components[2]}@${encodedVersion}`;
    }
    case "PyPI":
      return simple.test(name)
        ? `pkg:pypi/${
          name.toLowerCase().replace(/[-_.]+/g, "-")
        }@${encodedVersion}`
        : undefined;
    case "crates.io":
      return simple.test(name)
        ? `pkg:cargo/${name}@${encodedVersion}`
        : undefined;
    case "Maven": {
      const [group, artifact, extra] = name.split(":");
      return extra === undefined && group && artifact && simple.test(group) &&
          simple.test(artifact)
        ? `pkg:maven/${group}/${artifact}@${encodedVersion}`
        : undefined;
    }
    case "Go":
      return /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/.test(name)
        ? `pkg:golang/${name}@${encodedVersion}`
        : undefined;
    default:
      return undefined;
  }
}

export function importSentinelOsvScanner(
  raw: unknown,
  source: string,
): Snapshot {
  const project = text(source, "source identifier");
  const root = object(raw, "report");
  const projectId = id("project", [project]);
  const nodes = new Map<string, Node>([[projectId, {
    id: projectId,
    kind: "asset",
    label: project,
  }]]);
  const edges = new Map<string, Edge>();
  function addNode(node: Node) {
    nodes.set(node.id, node);
    if (nodes.size > MAX_NODES) {
      throw new Error("OSV-Scanner graph node limit exceeded");
    }
  }
  function addEdge(edge: Edge) {
    edges.set(JSON.stringify([edge.from, edge.relation, edge.to]), edge);
    if (edges.size > MAX_EDGES) {
      throw new Error("OSV-Scanner graph edge limit exceeded");
    }
  }
  const parents = new Map<string, string>();
  const matches: {
    advisoryId: string;
    packageId: string;
    path: string;
    severity: Severity;
  }[] = [];
  function representative(id: string): string {
    let root = id;
    while (parents.has(root)) root = parents.get(root)!;
    while (id !== root) {
      const next = parents.get(id)!;
      parents.set(id, root);
      id = next;
    }
    return root;
  }
  function groupAdvisories(first: string, next: string) {
    const left = representative(first);
    const right = representative(next);
    if (left !== right) parents.set(right, left);
  }
  let read = 0;
  function countRecord() {
    if (++read > 25_000) throw new Error("OSV-Scanner record limit exceeded");
  }
  for (const item of entries(root.results, "results")) {
    const scan = object(item, "scan result");
    const origin = object(scan.source, "result source");
    const path = text(origin.path, "source path");
    for (const value of entries(scan.packages, "packages")) {
      countRecord();
      const match = object(value, "package result");
      const groupSeverities = new Map<string, Severity>();
      for (const group of entries(match.groups ?? [], "advisory groups")) {
        countRecord();
        const raw = object(group, "advisory group");
        const severity = severityFromScore(raw.max_severity);
        let firstId: string | undefined;
        for (const value of entries(raw.ids, "advisory group IDs")) {
          countRecord();
          const advisoryId = text(value, "advisory group ID");
          if (firstId === undefined) firstId = advisoryId;
          else groupAdvisories(firstId, advisoryId);
          groupSeverities.set(
            advisoryId,
            higherSeverity(groupSeverities.get(advisoryId) ?? "info", severity),
          );
        }
      }
      const pkg = object(match.package, "package");
      const name = text(pkg.name, "package name");
      const version = text(pkg.version, "package version");
      const ecosystem = text(pkg.ecosystem, "package ecosystem");
      const pkgId = id("package", [project, ecosystem, name, version]);
      const purl = typeof pkg.purl === "string" ? pkg.purl : "";
      const encoded =
        /^pkg:[a-z][a-z\d.+-]*\/[^\s?#]+@([^\s?#]+)(?:[?#][^\s]*)?$/i.exec(purl)
          ?.[1];
      let alias = pkg.purl === undefined
        ? inferPackageUrl(ecosystem, name, version)
        : undefined;
      if (encoded && purl.length <= 1024) {
        try {
          if (decodeURIComponent(encoded) === version) alias = purl;
        } catch {
          // Malformed or mismatched package aliases are omitted.
        }
      }
      const previous = nodes.get(pkgId);
      const aliases = [
        ...new Set([
          ...(previous?.kind === "asset" ? previous.aliases ?? [] : []),
          ...(alias ? [alias] : []),
        ]),
      ].sort().slice(0, 20);
      addNode({
        id: pkgId,
        kind: "asset",
        label: `${ecosystem} ${name}@${version}`.slice(0, 1024),
        ...(aliases.length && { aliases }),
      });
      addEdge({ from: projectId, to: pkgId, relation: "depends_on" });
      for (
        const entry of entries(match.vulnerabilities ?? [], "vulnerabilities")
      ) {
        countRecord();
        const advisory = object(entry, "advisory");
        const advisoryId = text(advisory.id, "advisory ID");
        if (advisory.withdrawn) continue;
        const severity = higherSeverity(
          reportedSeverity(advisory),
          groupSeverities.get(advisoryId) ?? "info",
        );
        matches.push({ advisoryId, packageId: pkgId, path, severity });
      }
    }
  }
  const canonicalIds = new Map<string, string>();
  for (const { advisoryId } of matches) {
    const representativeId = representative(advisoryId);
    const previous = canonicalIds.get(representativeId);
    if (previous === undefined || advisoryId < previous) {
      canonicalIds.set(representativeId, advisoryId);
    }
  }
  for (const { advisoryId, packageId, path, severity } of matches) {
    const canonical = canonicalIds.get(representative(advisoryId))!;
    const findingId = id("finding", [project, canonical]);
    const previous = nodes.get(findingId);
    if (
      previous?.kind !== "finding" ||
      higherSeverity(previous.severity, severity) !== previous.severity
    ) {
      addNode({ id: findingId, kind: "finding", label: canonical, severity });
    }
    const evidence = id("evidence", [
      project,
      path,
      packageId,
      findingId,
      ...(canonical === advisoryId ? [] : [advisoryId]),
    ]);
    addNode({
      id: evidence,
      kind: "evidence",
      label: `OSV-Scanner: ${path} · ${advisoryId}`.slice(0, 1024),
    });
    addEdge({ from: evidence, to: findingId, relation: "supports" });
    addEdge({ from: evidence, to: packageId, relation: "observed_on" });
    addEdge({ from: findingId, to: packageId, relation: "affects" });
  }
  return loadSentinelGraph({
    version: 1,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.entries()].sort(([a], [b]) => a.localeCompare(b)).map((
      [, edge],
    ) => edge),
  }).snapshot();
}
