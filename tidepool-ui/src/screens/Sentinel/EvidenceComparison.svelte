<script lang="ts">
  import { sentinelWorkspaceText, type WorkspaceLanguage } from "./workspace_language.js";
  import { comparisonText } from "./comparison_markdown.js";
  import { humanize, type FindingReview, type SentinelGraph, type SentinelNode } from "./types.js";

  let { language = "en", before, after, beforeReviews = [], afterReviews = [], baseline, revision }: {
    language?: WorkspaceLanguage;
    before: SentinelGraph | null;
    after: SentinelGraph | null;
    beforeReviews?: readonly FindingReview[];
    afterReviews?: readonly FindingReview[];
    baseline: number;
    revision: number;
  } = $props();
  const t = $derived(sentinelWorkspaceText(language));

  const previousNodes = $derived(new Map((before?.nodes ?? []).map((node) => [node.id, node])));
  const currentNodes = $derived(new Map((after?.nodes ?? []).map((node) => [node.id, node])));
  const added = $derived([...currentNodes.values()].filter((node) => !previousNodes.has(node.id)));
  const removed = $derived([...previousNodes.values()].filter((node) => !currentNodes.has(node.id)));
  function aliases(node: SentinelNode) {
    return [...(node.aliases ?? [])].sort();
  }

  function sources(node: SentinelNode) {
    return (node.relationshipSources ?? []).map(({ caseId, from, to, snapshotDigest }) =>
      [caseId, from, to, snapshotDigest ?? ""] as const
    ).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  }

  function describe(node: SentinelNode, showAliases: boolean, showSources: boolean, text: (key: string) => string) {
    const description = [node.label, text(humanize(node.kind)), node.severity].filter(Boolean);
    if (showAliases) description.push(`${text("Aliases")} ${aliases(node).join(", ") || "—"}`);
    if (showSources) description.push(`${text("Case sources")} ${sources(node).map(([caseId, from, to, digest]) =>
      `${caseId} · ${from} → ${to}${digest ? ` · ${digest}` : ""}`
    ).join("; ") || "—"}`);
    return description.join(" · ");
  }

  const changed = $derived([...currentNodes.values()].flatMap((node) => {
    const previous = previousNodes.get(node.id);
    if (!previous) return [];
    const showAliases = JSON.stringify(aliases(previous)) !== JSON.stringify(aliases(node));
    const showSources = JSON.stringify(sources(previous)) !== JSON.stringify(sources(node));
    return previous.label !== node.label ||
        previous.kind !== node.kind || previous.severity !== node.severity || showAliases || showSources
      ? [{ previous, node, showAliases, showSources }]
      : [];
  }));

  function keyedEdges(graph: SentinelGraph | null) {
    return new Map((graph?.edges ?? []).map((edge) => [
      JSON.stringify([edge.from, edge.relation, edge.to]),
      edge,
    ]));
  }

  const previousEdges = $derived(keyedEdges(before));
  const currentEdges = $derived(keyedEdges(after));
  const addedLinks = $derived([...currentEdges].flatMap(([key, edge]) => previousEdges.has(key) ? [] : [edge]));
  const removedLinks = $derived([...previousEdges].flatMap(([key, edge]) => currentEdges.has(key) ? [] : [edge]));

  function latestDispositions(reviews: readonly FindingReview[]) {
    const latest = new Map<string, FindingReview>();
    for (const review of reviews) {
      if ((latest.get(review.findingId)?.id ?? 0) < review.id) {
        latest.set(review.findingId, review);
      }
    }
    return latest;
  }

  const dispositionChanges = $derived.by(() => {
    const prior = latestDispositions(beforeReviews);
    const next = latestDispositions(afterReviews);
    return [...currentNodes.values()].flatMap((node) => {
      if (node.kind !== "finding" || previousNodes.get(node.id)?.kind !== "finding") return [];
      const from = prior.get(node.id)?.disposition ?? "open";
      const to = next.get(node.id)?.disposition ?? "open";
      return from === to ? [] : [{ node, from, to }];
    });
  });

  export function markdown(text: (value: string) => string): string {
    const lines = [`## ${text("Imported evidence")}`, ""];
    for (const [label, nodes] of [["Added records", added], ["Removed records", removed]] as const) {
      if (!nodes.length) continue;
      lines.push(`### ${text(label)}`, "");
      for (const node of nodes) {
        lines.push(`- ${comparisonText(node.label)} · ${comparisonText(node.kind)} · ${comparisonText(node.id)}`);
      }
      lines.push("");
    }
    if (changed.length) {
      lines.push(`### ${text("Changed records")}`, "");
      for (const { previous, node, showAliases, showSources } of changed) {
        lines.push(`- ${comparisonText(node.id)} · ${comparisonText(describe(previous, showAliases, showSources, text))} → ${comparisonText(describe(node, showAliases, showSources, text))}`);
      }
      lines.push("");
    }
    for (const [label, links] of [["Added relationships", addedLinks], ["Removed relationships", removedLinks]] as const) {
      if (!links.length) continue;
      lines.push(`### ${text(label)}`, "");
      for (const edge of links) {
        lines.push(`- ${comparisonText(edge.from)} → ${comparisonText(edge.relation)} → ${comparisonText(edge.to)}`);
      }
      lines.push("");
    }
    if (lines.length === 2) lines.push(text("No changes."), "");
    if (dispositionChanges.length) {
      lines.push(`## ${text("Finding disposition changes")}`, "");
      for (const { node, from, to } of dispositionChanges) {
        lines.push(`- ${comparisonText(node.label)} · ${comparisonText(node.id)} · ${comparisonText(text(humanize(from)))} → ${comparisonText(text(humanize(to)))}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
</script>

<h3>{t("Evidence changes from revision {from} to {to}").replace("{from}", String(baseline)).replace("{to}", String(revision))}</h3>
{#if added.length + removed.length + changed.length + addedLinks.length + removedLinks.length === 0}
  <p>{t("No changes to imported evidence records or relationships.")}</p>
{/if}
{#each [{ label: "Added records", nodes: added }, { label: "Removed records", nodes: removed }] as group (group.label)}
  {#if group.nodes.length}
    <details>
      <summary>{t(group.label)} ({group.nodes.length})</summary>
      <ul>
        {#each group.nodes as node (node.id)}
          <li>{node.label} · {t(humanize(node.kind))} · {node.id}</li>
        {/each}
      </ul>
    </details>
  {/if}
{/each}
{#if changed.length}
  <details>
    <summary>{t("Changed records")} ({changed.length})</summary>
    <ul>
      {#each changed as { previous, node, showAliases, showSources } (node.id)}
        <li>
          {node.id} · {describe(previous, showAliases, showSources, t)}
          → {describe(node, showAliases, showSources, t)}
        </li>
      {/each}
    </ul>
  </details>
{/if}
{#each [
  { label: "Added relationships", links: addedLinks, nodes: currentNodes },
  { label: "Removed relationships", links: removedLinks, nodes: previousNodes },
] as group (group.label)}
  {#if group.links.length}
    <details>
      <summary>{t(group.label)} ({group.links.length})</summary>
      <ul>
        {#each group.links as edge}
          <li>{group.nodes.get(edge.from)?.label ?? edge.from} → {t(humanize(edge.relation))} → {group.nodes.get(edge.to)?.label ?? edge.to}</li>
        {/each}
      </ul>
    </details>
  {/if}
{/each}

{#if dispositionChanges.length}
  <details>
    <summary>{t("Finding disposition changes")} ({dispositionChanges.length})</summary>
    <ul>
      {#each dispositionChanges as { node, from, to } (node.id)}
        <li>{node.label} · <code>{node.id}</code> · {t(humanize(from))} → {t(humanize(to))}</li>
      {/each}
    </ul>
  </details>
{/if}
