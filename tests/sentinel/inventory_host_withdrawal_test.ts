import { assertEquals } from "@std/assert";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  normalizeSentinelWithdrawalHost,
  proposeSentinelInventoryHostWithdrawal,
} from "../../src/sentinel/inventory_host_withdrawal.ts";
import { digestSentinelSnapshot } from "../../src/sentinel/shared_inventory.ts";

const graph = {
  version: 1,
  nodes: [
    {
      id: "host:exact",
      kind: "asset",
      assetType: "root_domain",
      aliases: ["safe.example"],
      label: "Declared host",
    },
    {
      id: "child.safe.example",
      kind: "asset",
      assetType: "subdomain",
      parentId: "host:exact",
      label: "Child",
    },
    { id: "safe.example.evil", kind: "asset", label: "Suffix decoy" },
    { id: "display", kind: "asset", label: "safe.example" },
    { id: "evidence", kind: "evidence", label: "Retained observation" },
    { id: "finding", kind: "finding", label: "Finding", severity: "low" },
  ],
  edges: [
    { from: "evidence", to: "host:exact", relation: "observed_on" },
    { from: "evidence", to: "child.safe.example", relation: "observed_on" },
    { from: "finding", to: "host:exact", relation: "affects" },
  ],
};

Deno.test("exact host withdrawal retains the observation and detaches direct children", () => {
  const original = structuredClone(graph);
  const proposal = proposeSentinelInventoryHostWithdrawal(
    graph,
    "SAFE.Example.",
  );
  if (!proposal) throw new Error("Expected exact host withdrawal");
  assertEquals(proposal.host, "safe.example");
  assertEquals(proposal.assetId, "host:exact");
  assertEquals(proposal.removedEdges, 3);
  assertEquals(proposal.detachedChildIds, ["child.safe.example"]);
  assertEquals(
    proposal.snapshot.nodes.map(({ id }) => id),
    [
      "child.safe.example",
      "safe.example.evil",
      "display",
      "evidence",
      "finding",
    ],
  );
  assertEquals(proposal.snapshot.edges, [graph.edges[1]]);
  assertEquals(
    proposal.previousDigest,
    digestSentinelSnapshot(loadSentinelGraph(graph).snapshot()),
  );
  assertEquals(proposal.nextDigest, digestSentinelSnapshot(proposal.snapshot));
  assertEquals(graph, original);
});

Deno.test("withdrawal accepts bare canonical hosts and rejects ambiguous identities", () => {
  assertEquals(normalizeSentinelWithdrawalHost("2001:0DB8::1"), "2001:db8::1");
  assertEquals(normalizeSentinelWithdrawalHost("192.0.2.1"), "192.0.2.1");
  for (
    const raw of [
      "*.safe.example",
      "https://safe.example",
      "safe.example:80",
      "safe.example..",
      "safe.example ",
      "K.example",
      "192.000.2.1",
    ]
  ) assertEquals(normalizeSentinelWithdrawalHost(raw), undefined);
  assertEquals(
    proposeSentinelInventoryHostWithdrawal(graph, "example"),
    undefined,
  );
  assertEquals(
    proposeSentinelInventoryHostWithdrawal({
      ...graph,
      nodes: [...graph.nodes, {
        id: "safe.example",
        kind: "asset",
        label: "Conflicting declared identity",
      }],
    }, "safe.example"),
    undefined,
  );
});
