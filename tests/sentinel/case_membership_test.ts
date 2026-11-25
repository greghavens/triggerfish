import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  resolveSentinelCaseMembership,
  verifySentinelCaseMembership,
} from "../../src/sentinel/case_membership.ts";

const scope = { caseId: "defense", evidenceRevision: 7 };
const security = { id: "sec", label: "Security" };
const operations = { id: "ops", label: "Operations" };
const graph = {
  version: 1,
  nodes: [
    {
      id: "zulu",
      kind: "asset",
      label: "Host",
      assetType: "root_domain",
      aliases: ["friendly"],
      organization: security,
    },
    {
      id: "unassigned",
      kind: "asset",
      label: "Service",
      assetType: "service",
      parentId: "zulu",
    },
    {
      id: "alpha",
      kind: "asset",
      label: "Independent security asset",
      organization: security,
    },
    {
      id: "ops",
      kind: "asset",
      label: "Operations asset",
      organization: operations,
    },
    {
      id: "example-finding",
      kind: "finding",
      label: "A graph finding",
      severity: "low",
    },
  ],
  edges: [{ from: "example-finding", to: "zulu", relation: "affects" }],
};

Deno.test("Case membership uses declared local organization and exact asset IDs only", () => {
  const selector = { kind: "organization", organizationId: "sec" } as const;
  const selected = resolveSentinelCaseMembership(graph, { ...scope, selector });
  assert(selected);
  assertEquals(selected.selector, selector);
  assertMatch(selected.snapshotDigest, /^[a-f0-9]{64}$/);
  assertEquals(selected.assetIds, ["alpha", "zulu"]);
  assertEquals(selected.sources, [
    { assetId: "alpha", organization: security },
    { assetId: "zulu", organization: security },
  ]);
  const assetSelector = {
    kind: "assets",
    assetIds: ["zulu", "unassigned", "zulu"],
  };
  const exact = resolveSentinelCaseMembership(graph, {
    ...scope,
    selector: assetSelector,
  });
  assert(exact);
  assertEquals(exact.snapshotDigest, selected.snapshotDigest);
  assertEquals(exact.selector, {
    kind: "assets",
    assetIds: ["unassigned", "zulu"],
  });
  assertEquals(exact.sources, [{ assetId: "unassigned" }, {
    assetId: "zulu",
    organization: security,
  }]);

  for (
    const invalid of [
      { kind: "assets", assetIds: ["friendly"] },
      { kind: "assets", assetIds: ["example-finding"] },
      { kind: "assets", assetIds: ["alpha", "peer-only"] },
      { kind: "organization", organizationId: "Security" },
      { kind: "organization", organizationId: "SEC" },
      { ...selector, peerCase: "other" },
    ]
  ) {
    assertEquals(
      resolveSentinelCaseMembership(graph, { ...scope, selector: invalid }),
      undefined,
    );
  }
  assertEquals(
    resolveSentinelCaseMembership(graph, {
      ...scope,
      selector: { kind: "assets", assetIds: [] },
    })?.assetIds,
    [],
  );
});

Deno.test("Archived membership proof binds exact case, revision, snapshot and declarations", () => {
  const proof = resolveSentinelCaseMembership(graph, {
    ...scope,
    selector: { kind: "organization", organizationId: "sec" },
  });
  assert(proof);
  assert(verifySentinelCaseMembership(graph, structuredClone(proof), scope));
  assert(
    !verifySentinelCaseMembership(graph, proof, { ...scope, caseId: "peer" }),
  );
  assert(
    !verifySentinelCaseMembership(graph, proof, {
      ...scope,
      evidenceRevision: 8,
    }),
  );
  assert(
    !verifySentinelCaseMembership(
      graph,
      { ...proof, assetIds: ["alpha"] },
      scope,
    ),
  );
  assert(
    !verifySentinelCaseMembership(graph, {
      ...proof,
      sources: [
        { assetId: "alpha", organization: operations },
        proof.sources[1],
      ],
    }, scope),
  );
  assert(
    !verifySentinelCaseMembership(
      {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === "zulu" ? { ...node, organization: operations } : node
        ),
      },
      proof,
      scope,
    ),
  );
  assert(
    !verifySentinelCaseMembership(
      {
        ...graph,
        nodes: [...graph.nodes, {
          id: "new-member",
          kind: "asset",
          label: "Added asset",
          organization: security,
        }],
      },
      proof,
      scope,
    ),
  );
});

Deno.test("Organization scope exceeding the explicit membership bound is rejected whole", () => {
  const large = {
    version: 1,
    nodes: Array.from({ length: 129 }, (_, index) => ({
      id: `asset-${index}`,
      kind: "asset",
      label: `Asset ${index}`,
      organization: security,
    })),
    edges: [],
  };
  assertEquals(
    resolveSentinelCaseMembership(large, {
      ...scope,
      selector: { kind: "organization", organizationId: "sec" },
    }),
    undefined,
  );
  assertEquals(
    resolveSentinelCaseMembership(large, {
      ...scope,
      selector: { kind: "assets", assetIds: ["asset-128"] },
    })?.assetIds,
    ["asset-128"],
  );
});
