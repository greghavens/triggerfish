/** Import inline SARIF 2.1.0 findings as a Sentinel graph. */

type JsonObject = Record<string, unknown>;
type Severity = "high" | "medium" | "low" | "info";
type Node =
  | { id: string; kind: "asset" | "evidence"; label: string }
  | { id: string; kind: "finding"; label: string; severity: Severity };
type Edge = { from: string; to: string; relation: "affects" | "supports" };

const levels = {
  error: "high",
  warning: "medium",
  note: "low",
  none: "info",
} as const;
const severityRank = { info: 0, low: 1, medium: 2, high: 3 };
const baselineStates = ["new", "unchanged", "updated", "absent"];
const resultKinds = [
  "fail",
  "pass",
  "open",
  "informational",
  "notApplicable",
  "review",
];

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`SARIF ${field} must be an object`);
  }
  return value as JsonObject;
}

function optionalObject(value: unknown, field: string) {
  return value === undefined ? undefined : object(value, field);
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`SARIF ${field} must be an array`);
  return value;
}

function optionalArray(value: unknown, field: string) {
  return value === undefined ? [] : array(value, field);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`SARIF ${field} must be a nonempty string`);
  }
  return value;
}

function optionalText(value: unknown, field: string) {
  return value === undefined ? undefined : requiredText(value, field);
}

function optionalIndex(value: unknown, field: string, minimum = -1) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum
  ) {
    throw new Error(`SARIF ${field} must be an integer at least ${minimum}`);
  }
  return value;
}

function referencedObject(
  index: number | undefined,
  items: readonly unknown[],
  field: string,
) {
  return index === undefined || index === -1
    ? undefined
    : object(items[index], field);
}

function severity(level: unknown): Severity {
  const key = requiredText(level, "level");
  if (!Object.hasOwn(levels, key)) throw new Error("Unsupported SARIF level");
  return levels[key as keyof typeof levels];
}

function readLocation(raw: unknown, artifacts: readonly unknown[]) {
  const location = object(raw, "location");
  const physical = optionalObject(
    location.physicalLocation,
    "physicalLocation",
  );
  if (!physical) return;
  const artifact = optionalObject(
    physical.artifactLocation,
    "artifactLocation",
  );
  const indexed = referencedObject(
    optionalIndex(artifact?.index, "artifactLocation.index"),
    artifacts,
    "indexed artifact",
  );
  const indexedLocation = optionalObject(
    indexed?.location,
    "artifact.location",
  );
  const uri = optionalText(artifact?.uri, "artifactLocation.uri") ??
    optionalText(indexedLocation?.uri, "artifact.location.uri");
  const base =
    optionalText(artifact?.uriBaseId, "artifactLocation.uriBaseId") ??
      optionalText(indexedLocation?.uriBaseId, "artifact.location.uriBaseId");
  const region = optionalObject(physical.region, "region");
  const line = optionalIndex(region?.startLine, "region.startLine", 1);
  const column = optionalIndex(region?.startColumn, "region.startColumn", 1);
  if (uri === undefined) return;
  return { uri, base, line, column };
}

function fingerprint(raw: unknown) {
  const properties = optionalObject(raw, "result.fingerprints");
  if (!properties) return;
  const entries = Object.keys(properties).sort().map((
    key,
  ) => [key, requiredText(properties[key], "fingerprint")]);
  return entries.length ? entries : undefined;
}

function graphId(kind: Node["kind"], parts: readonly unknown[]) {
  return `sarif:${kind}:${JSON.stringify(parts)}`;
}

function indexRules(raw: unknown, field: string) {
  const rules = optionalArray(raw, field).map((entry) => object(entry, "rule"));
  return {
    rules,
    byId: new Map(
      rules.map((rule) => [requiredText(rule.id, "rule.id"), rule]),
    ),
  };
}

/** Read result metadata only. URIs are retained literally. */
export function importSentinelSarif(raw: unknown, source: string) {
  requiredText(source, "source namespace");
  const log = object(raw, "document");
  if (log.version !== "2.1.0") throw new Error("Expected SARIF version 2.1.0");

  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  function link(from: string, to: string, relation: Edge["relation"]) {
    edges.set(JSON.stringify([from, to, relation]), { from, to, relation });
  }

  for (const rawRun of array(log.runs, "runs")) {
    const run = object(rawRun, "run");
    const tool = object(run.tool, "run.tool");
    const driver = object(tool.driver, "tool.driver");
    const toolName = requiredText(driver.name, "driver.name");
    const driverGuid = optionalText(driver.guid, "driver.guid");
    const artifacts = optionalArray(run.artifacts, "artifacts");
    const driverRules = indexRules(driver.rules, "driver.rules");
    const extensions = optionalArray(tool.extensions, "tool.extensions")
      .map((value) => {
        const extension = object(value, "tool extension");
        return {
          name: requiredText(extension.name, "extension.name"),
          guid: optionalText(extension.guid, "extension.guid"),
          ...indexRules(extension.rules, "extension.rules"),
        };
      });

    for (const rawResult of optionalArray(run.results, "results")) {
      const result = object(rawResult, "result");
      const kind = optionalText(result.kind, "result.kind") ?? "fail";
      if (!resultKinds.includes(kind)) {
        throw new Error("Unsupported SARIF kind");
      }
      const explicitSeverity = result.level === undefined
        ? undefined
        : severity(result.level);
      if (
        kind !== "fail" && explicitSeverity !== undefined &&
        explicitSeverity !== "info"
      ) {
        throw new Error("SARIF non-failure result must use level none");
      }
      const baselineState = optionalText(result.baselineState, "baselineState");
      if (
        baselineState !== undefined && !baselineStates.includes(baselineState)
      ) {
        throw new Error("Unsupported SARIF baselineState");
      }
      if (kind !== "fail" && kind !== "open" && kind !== "review") continue;
      if (baselineState === "absent") continue;

      const ruleReference = optionalObject(result.rule, "result.rule");
      const ruleComponent = optionalObject(
        ruleReference?.toolComponent,
        "rule.toolComponent",
      );
      const componentIndex = optionalIndex(
        ruleComponent?.index,
        "toolComponent.index",
      );
      const componentName = optionalText(
        ruleComponent?.name,
        "toolComponent.name",
      );
      const componentGuid = optionalText(
        ruleComponent?.guid,
        "toolComponent.guid",
      );
      const hasExtensionIndex = componentIndex !== undefined &&
        componentIndex >= 0;
      const extension = hasExtensionIndex
        ? extensions[componentIndex]
        : extensions.find(({ name, guid }) =>
          componentGuid !== undefined
            ? guid === componentGuid
            : name === componentName
        );
      const namesDriver =
        (componentName === undefined || componentName === toolName) &&
        (componentGuid === undefined || componentGuid === driverGuid);
      if (!extension && (hasExtensionIndex || !namesDriver)) {
        throw new Error("SARIF references an unknown tool extension");
      }
      const { rules, byId } = extension ?? driverRules;
      const ruleId = optionalText(
        result.ruleId ?? ruleReference?.id,
        "result.ruleId",
      );
      const ruleIndex = optionalIndex(
        result.ruleIndex ?? ruleReference?.index,
        "result.ruleIndex",
      );
      const rule = referencedObject(ruleIndex, rules, "indexed rule") ??
        (ruleId === undefined ? undefined : byId.get(ruleId));
      const ruleKey = ruleId ?? optionalText(rule?.id, "rule.id");
      const defaultLevel = optionalObject(
        rule?.defaultConfiguration,
        "rule.defaultConfiguration",
      )?.level;
      const findingSeverity = explicitSeverity ??
        (kind === "fail" ? severity(defaultLevel ?? "warning") : "info");
      const message = object(result.message, "result.message");
      const description = optionalText(
        message.text ?? message.markdown ?? message.id,
        "result.message text",
      );
      if (!description) {
        throw new Error("SARIF result.message requires text, markdown, or id");
      }

      const locations = optionalArray(result.locations, "locations")
        .flatMap((rawLocation) => readLocation(rawLocation, artifacts) ?? []);
      const locationKeys = [
        ...new Set(
          locations.map(({ uri, base, line, column }) =>
            JSON.stringify([base, uri, line, column])
          ),
        ),
      ].sort();
      const correlationGuid = optionalText(
        result.correlationGuid,
        "result.correlationGuid",
      );
      const fingerprints = fingerprint(result.fingerprints);
      const identity = correlationGuid !== undefined
        ? ["correlationGuid", correlationGuid]
        : fingerprints
        ? ["fingerprints", fingerprints]
        : locationKeys.length
        ? ["locations", locationKeys]
        : ["message", description];
      const id = graphId("finding", [
        source,
        toolName,
        extension?.guid ?? extension?.name,
        ruleKey,
        identity,
      ]);
      const label = ruleKey
        ? `${toolName} ${ruleKey}: ${description}`
        : `${toolName}: ${description}`;
      const previous = nodes.get(id);
      if (
        previous?.kind !== "finding" ||
        severityRank[findingSeverity] > severityRank[previous.severity]
      ) {
        nodes.set(id, {
          id,
          kind: "finding",
          severity: findingSeverity,
          label,
        });
      }

      if (!locations.length) {
        const asset = graphId("asset", [source]);
        nodes.set(asset, { id: asset, kind: "asset", label: source });
        link(id, asset, "affects");
      }
      for (const { uri, base, line, column } of locations) {
        const asset = graphId("asset", [source, base, uri]);
        const evidence = graphId("evidence", [id, asset, line, column]);
        const path = base ? `${base} ${uri}` : uri;
        const position = line === undefined
          ? ""
          : `:${line}${column === undefined ? "" : `:${column}`}`;
        nodes.set(asset, { id: asset, kind: "asset", label: path });
        nodes.set(evidence, {
          id: evidence,
          kind: "evidence",
          label: `${path}${position}`,
        });
        link(id, asset, "affects");
        link(evidence, id, "supports");
      }
    }
  }

  return {
    version: 1 as const,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}
