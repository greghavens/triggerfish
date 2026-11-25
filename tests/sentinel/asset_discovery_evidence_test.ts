import { assertEquals } from "@std/assert";
import {
  matchSentinelAssetDiscoveryDestination,
  verifySentinelAssetDiscovery,
} from "../../src/sentinel/asset_discovery_evidence.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";

const nodes = [
  {
    id: "remote-app",
    kind: "asset",
    label: "App",
    assetType: "service",
    aliases: ["shared-app"],
  },
  {
    id: "remote-dns",
    kind: "asset",
    label: "Hostname",
    assetType: "subdomain",
    aliases: ["shared-dns"],
  },
  {
    id: "remote-ip",
    kind: "asset",
    label: "IP",
    assetType: "ip",
    aliases: ["shared-ip"],
  },
  { id: "proof", kind: "evidence", label: "Recorded evidence" },
  {
    id: "inherited-proof",
    kind: "evidence",
    label: "Inherited evidence",
    relationshipSources: [{
      caseId: "reporter",
      from: "remote-app",
      to: "remote-dns",
    }],
  },
  { id: "unlinked-proof", kind: "evidence", label: "Unlinked evidence" },
];
const edges = [
  { from: "proof", to: "remote-app", relation: "observed_on" },
  { from: "proof", to: "remote-dns", relation: "observed_on" },
  { from: "proof", to: "remote-ip", relation: "observed_on" },
  { from: "inherited-proof", to: "remote-app", relation: "observed_on" },
  { from: "inherited-proof", to: "remote-dns", relation: "observed_on" },
  { from: "remote-app", to: "remote-dns", relation: "uses_hostname" },
  { from: "remote-dns", to: "remote-ip", relation: "resolved_to" },
  { from: "remote-ip", to: "remote-dns", relation: "resolved_to" },
];
const source = loadSentinelGraph({ version: 1, nodes, edges });
const asset = { kind: "asset", evidenceId: "proof", assetId: "remote-app" };
const alias = { ...asset, kind: "alias", alias: "shared-app" } as const;
const relationship = {
  ...asset,
  kind: "relationship",
  to: "remote-dns",
  relation: "uses_hostname",
} as const;
const observedDns = {
  ...relationship,
  assetId: "remote-dns",
  to: "remote-ip",
  relation: "resolved_to",
};

Deno.test("Asset discovery requires exact pinned graph evidence and compatible directed relationships", () => {
  for (const claim of [asset, alias, relationship, observedDns]) {
    assertEquals(verifySentinelAssetDiscovery(source, claim), claim);
  }
  for (
    const claim of [
      { ...asset, assetId: "shared-app" },
      { ...asset, evidenceId: "unlinked-proof" },
      { ...relationship, evidenceId: "inherited-proof" },
      { ...asset, preview: "claimed by model" },
      { ...alias, alias: "unknown-host" },
      { ...relationship, evidenceId: "remote-app" },
      { ...relationship, to: "shared-dns" },
      { ...relationship, to: "remote-app" },
      { ...relationship, relation: "depends_on" },
      { ...relationship, relation: "contained_in" },
      { ...observedDns, assetId: "remote-ip", to: "remote-dns" },
    ]
  ) assertEquals(verifySentinelAssetDiscovery(source, claim), undefined);
  const incomplete = loadSentinelGraph({
    version: 1,
    nodes,
    edges: edges.filter(({ from, to }) =>
      from !== "proof" || to !== "remote-dns"
    ),
  });
  assertEquals(
    verifySentinelAssetDiscovery(incomplete, relationship),
    undefined,
  );
});

Deno.test("Destination discovery resolves only exact IDs and unambiguous one-to-one aliases", () => {
  const localNodes = [
    {
      id: "remote-app",
      kind: "asset",
      label: "Exact app",
      assetType: "service",
    },
    {
      id: "local-dns",
      kind: "asset",
      label: "Local hostname",
      aliases: ["shared-dns"],
    },
    {
      id: "local-duplicate",
      kind: "asset",
      label: "Other",
      aliases: ["shared-app"],
    },
  ];
  const graph = (nodes: unknown[]) =>
    loadSentinelGraph({ version: 1, nodes, edges: [] });
  const destination = graph(localNodes);
  assertEquals(
    matchSentinelAssetDiscoveryDestination(source, destination, relationship),
    {
      claim: relationship,
      assetId: "remote-app",
      to: "local-dns",
    },
  );
  assertEquals(
    matchSentinelAssetDiscoveryDestination(source, destination, alias),
    {
      claim: alias,
      assetId: "remote-app",
    },
  );
  for (
    const badDestination of [
      graph([localNodes[0]]),
      graph([...localNodes, { ...localNodes[1], id: "duplicate-dns" }]),
      graph(
        localNodes.map((node) =>
          node.id === "local-dns" ? { ...node, assetType: "ip" } : node
        ),
      ),
      graph([
        {
          id: "collapsed",
          kind: "asset",
          label: "Conflicting identities",
          aliases: ["shared-app", "shared-dns"],
        },
      ]),
    ]
  ) {
    assertEquals(
      matchSentinelAssetDiscoveryDestination(
        source,
        badDestination,
        relationship,
      ),
      undefined,
    );
  }
  const sharedSourceAlias = graph([...nodes, {
    id: "ambiguous-app",
    kind: "asset",
    label: "Other source app",
    aliases: ["shared-app"],
  }]);
  assertEquals(
    verifySentinelAssetDiscovery(
      loadSentinelGraph({ ...sharedSourceAlias.snapshot(), edges }),
      alias,
    ),
    undefined,
  );
});
