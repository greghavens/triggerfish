<script lang="ts">
  import { sentinelWorkspaceText, type WorkspaceLanguage } from "./workspace_language.js";
  import Icon from "../../lib/components/Icon.svelte";
  import { humanize, type SentinelGraph, type SentinelEdge, type SentinelPathExport, type SentinelPeerFindingCitation } from "./types.js";
  import { alternateSentinelRelationshipPaths, type SentinelPathDirection } from "../../../../src/sentinel/path_search.ts";

  let {
    graph,
    language = "en",
    selectedId = $bindable(undefined),
    onOpenSource,
    onOpenPeerFinding,
    onOpenDecision,
    onDownloadPath,
    sourceNavigationDisabled,
  }: {
    graph: SentinelGraph | null;
    language?: WorkspaceLanguage;
    selectedId?: string;
    onOpenDecision?: (kind: "finding" | "incident", id: number) => void;
    onOpenSource: (caseId: string, assetId: string, snapshotDigest?: string) => void;
    onOpenPeerFinding?: (citation: SentinelPeerFindingCitation) => void;
    sourceNavigationDisabled: boolean;
    onDownloadPath: (path: SentinelPathExport) => void;
  } = $props();
  const t = $derived(sentinelWorkspaceText(language));
  let query = $state("");
  let kind = $state("all");
  let shown = $state(20);

  const nodes = $derived(graph?.nodes ?? []);
  const nodeById = $derived(new Map(nodes.map((node) => [node.id, node])));
  const matchingNodes = $derived.by(() => {
    const term = query.trim().toLowerCase();
    return nodes.filter(
      (node) =>
        (kind === "all" || node.kind === kind) &&
        (!term ||
          node.id.toLowerCase().includes(term) ||
          node.label.toLowerCase().includes(term) ||
          node.findingReviews?.some(({ note, disposition }) =>
            note.toLowerCase().includes(term) ||
            t(humanize(disposition)).toLowerCase().includes(term)) ||
          node.sourceId?.toLowerCase().includes(term) ||
          node.plannerRound?.identity.toLowerCase().includes(term) ||
          node.aliases?.some((alias) => alias.toLowerCase().includes(term)) ||
          node.relationshipSources?.some(({ caseId, from, to, snapshotDigest }) =>
            [caseId, from, to, snapshotDigest].some((value) => value?.toLowerCase().includes(term))
          )),
    );
  });
  const selected = $derived(
    (selectedId ? nodeById.get(selectedId) : undefined) ??
      nodes.find((node) => node.kind === "finding") ??
      nodes[0],
  );
  const incoming = $derived(
    (graph?.edges ?? []).filter(
      (edge) => edge.to === selected?.id && edge.from !== edge.to,
    ),
  );
  const outgoing = $derived(
    (graph?.edges ?? []).filter((edge) => edge.from === selected?.id),
  );
  let traceDepth = $state(2);
  let traceDirection = $state<SentinelPathDirection>("both");
  let traceRelations = $state<string[]>([]);
  const relationshipTypes = $derived([...new Set((graph?.edges ?? []).map(({ relation }) => relation))].sort());
  const effectiveTraceRelations = $derived(relationshipTypes.filter((relation) => traceRelations.includes(relation)));
  let traceLimit = $state(25);
  let pathOriginId = $state<string>();
  const pathOrigin = $derived(pathOriginId ? nodeById.get(pathOriginId) : undefined);
  const traceLinks = $derived.by(() => {
    const links = new Map<string, { id: string; edge: SentinelEdge }[]>();
    function add(from: string, to: string, edge: SentinelEdge) {
      const adjacent = links.get(from) ?? [];
      adjacent.push({ id: to, edge });
      links.set(from, adjacent);
    }
    for (const edge of graph?.edges ?? []) {
      if (!nodeById.has(edge.from) || !nodeById.has(edge.to) ||
        (effectiveTraceRelations.length && !effectiveTraceRelations.includes(edge.relation))) continue;
      if (traceDirection !== "incoming") add(edge.from, edge.to, edge);
      if (traceDirection !== "outgoing") add(edge.to, edge.from, edge);
    }
    return links;
  });

  function walk(root: string) {
    const visited = new Set([root]);
    const queue: { id: string; depth: number; via: string; edge?: SentinelEdge }[] =
      [{ id: root, depth: 0, via: "" }];
    for (const item of queue) {
      if (item.depth >= traceDepth) continue;
      for (const { id, edge } of traceLinks.get(item.id) ?? []) {
        if (visited.has(id) || !nodeById.has(id)) continue;
        visited.add(id);
        queue.push({ id, depth: item.depth + 1, via: item.id, edge });
      }
    }
    return queue.slice(1);
  }

  const trace = $derived(selected ? walk(selected.id) : []);
  const pathAdjacency = $derived(new Map([...traceLinks].map(([id, links]) =>
    [id, links.map(({ edge }) => edge)])));
  let pathIndex = $state(0);
  const alternatives = $derived.by(() => {
    if (!pathOrigin || !selected || pathOrigin.id === selected.id) {
      return { paths: [], truncated: false };
    }
    return alternateSentinelRelationshipPaths(
      nodeById, pathAdjacency, pathOrigin.id, selected.id,
      traceDepth, traceDirection, undefined, 10,
    );
  });
  $effect(() => {
    if (alternatives) pathIndex = 0;
  });
  const selectedPath = $derived(alternatives.paths[pathIndex] ?? alternatives.paths[0]);
  const path = $derived(selectedPath?.edges.map((edge, index) => ({
    id: selectedPath.nodes[index + 1].id,
    reversed: selectedPath.nodes[index].id !== edge.from,
    edge,
  })) ?? []);

  function downloadPath() {
    if (!pathOrigin || !selected || !selectedPath) return;
    onDownloadPath({
      from: pathOrigin.id,
      to: selected.id,
      direction: traceDirection,
      relation: effectiveTraceRelations.length === 1 ? effectiveTraceRelations[0] : null,
      relations: effectiveTraceRelations,
      maxDepth: traceDepth,
      nodes: selectedPath.nodes,
      edges: selectedPath.edges,
    });
  }

  const unresolved = $derived(
    (graph?.unresolvedReferences ?? []).filter(
      ({ node }) => node === selected?.id,
    ),
  );
</script>

<section class="panel graph" aria-labelledby="provenance-heading">
  <header class="panel-header">
    <h2 id="provenance-heading">{t("Provenance graph")}</h2>
    {#if graph}
      <span>{nodes.length} {t("nodes")} · {graph.edges.length} {t("links")}</span>
    {/if}
  </header>

  {#if !selected}
    <div class="empty">
      <Icon name="workflows" size={24} />
      <p>
        {graph
          ? t("The published graph is empty.")
           : t("Publish a graph snapshot to explore its evidence and relationships.")}
      </p>
    </div>
  {:else}
    <div class="graph-controls">
      <label>
        <span>{t("Find a node")}</span>
        <div class="search-field">
          <Icon name="search" size={15} />
          <input
            type="search"
            placeholder={t("Node name or ID")}
            bind:value={query}
            oninput={() => (shown = 20)}
          />
        </div>
      </label>
      <label>
        <span>{t("Node type")}</span>
        <select bind:value={kind} onchange={() => (shown = 20)}>
          <option value="all">{t("All types")}</option>
          <option value="asset">{t("Assets")}</option>
          <option value="finding">{t("Findings")}</option>
          <option value="evidence">{t("Evidence")}</option>
          <option value="control">{t("Controls")}</option>
          <option value="goal">{t("Goals")}</option>
          <option value="task">{t("Tasks")}</option>
          <option value="observation">{t("Observations")}</option>
        </select>
      </label>
    </div>

    <details class="graph-trace">
      <summary>{t("Trace relationships from")} {selected.label}</summary>
      <div class="graph-controls">
        <label>
          <span>{t("Trace direction")}</span>
          <select bind:value={traceDirection} onchange={() => traceLimit = 25}>
            <option value="both">{t("Both directions")}</option>
            <option value="outgoing">{t("Outgoing")}</option>
            <option value="incoming">{t("Incoming")}</option>
          </select>
        </label>
        <label>
          <span>{t("Relationship types")}</span>
          <select multiple bind:value={traceRelations} onchange={() => traceLimit = 25}>
            {#each relationshipTypes as relation (relation)}
              <option value={relation}>{t(humanize(relation))}</option>
            {/each}
          </select>
        </label>
        {#if effectiveTraceRelations.length}
          <button type="button" class="more" onclick={() => {
            traceRelations = [];
            traceLimit = 25;
          }}>{t("Clear relationship filters")}</button>
        {/if}
        <label>
          <span>{t("Trace depth")}</span>
          <select bind:value={traceDepth} onchange={() => traceLimit = 25}>
            {#each [1, 2, 3, 4, 5, 6, 7, 8] as depth}
              <option value={depth}>{depth}</option>
            {/each}
          </select>
        </label>
      </div>
      <p>{trace.length} {t(trace.length === 1 ? "reachable node" : "reachable nodes")}.</p>
      <ol>
        {#each trace.slice(0, traceLimit) as item (item.id)}
          <li>
            <button type="button" class="more" onclick={() => selectedId = item.id}>
              {nodeById.get(item.id)?.label ?? item.id}
            </button>
            <span> · {item.depth} {t(item.depth === 1 ? "hop" : "hops")} · {t(humanize(item.edge?.relation ?? ""))} · {t("via")} {nodeById.get(item.via)?.label ?? item.via}</span>
          </li>
        {/each}
      </ol>
      {#if trace.length > traceLimit}
        <button type="button" class="more" onclick={() => traceLimit += 25}>{t("Show more reachable nodes")}</button>
      {/if}
      <div class="graph-path">
        {#if pathOrigin}
          <p>{t("Path origin")} · {pathOrigin.label}</p>
          {#if pathOrigin.id === selected.id}
            <p>{t("Select another node to find a path.")}</p>
          {:else if path.length}
            {#if alternatives.paths.length > 1}
              <label>
                <span>{t("Shortest path option")}</span>
                <select bind:value={pathIndex}>
                  {#each alternatives.paths as _, index}
                    <option value={index}>{index + 1} / {alternatives.paths.length}</option>
                  {/each}
                </select>
              </label>
            {/if}
            {#if alternatives.truncated}
              <p>{t("More equally short paths exist.")}</p>
            {/if}
            <ol aria-label={t("Shortest relationship path")}>
              {#each path as hop (hop.id)}
                <li>
                  <span role="img" aria-label={t(hop.reversed ? "Incoming" : "Outgoing")}>{hop.reversed ? "←" : "→"}</span>
                  {t(humanize(hop.edge.relation))} ·
                  <button type="button" class="more" onclick={() => selectedId = hop.id}>
                    {nodeById.get(hop.id)?.label ?? hop.id}
                  </button>
                </li>
              {/each}
            </ol>
            <button type="button" class="more" onclick={downloadPath}>{t("Download path JSON")}</button>
          {:else}
            <p>{t(effectiveTraceRelations.length ? "No path within the selected traversal filters." : "No path within the selected direction and depth.")}</p>
          {/if}
          <button type="button" class="more" onclick={() => pathOriginId = undefined}>{t("Clear path origin")}</button>
        {/if}
        {#if pathOrigin?.id !== selected.id}
          <button type="button" class="more" onclick={() => pathOriginId = selected.id}>{t("Set selected node as path origin")}</button>
        {/if}
      </div>
    </details>
    <div class="graph-body">
      <div class="node-list" aria-label={t("Graph nodes")}>
        {#each matchingNodes.slice(0, shown) as node (node.id)}
          <button
            type="button"
            class:selected={node.id === selected.id}
            aria-pressed={node.id === selected.id}
            onclick={() => (selectedId = node.id)}
          >
            <span class="node-kind" data-kind={node.kind}>
              {t(humanize(node.kind))}
            </span>
            <strong>{node.label}</strong>
            <span class="node-id" title={node.id}>
              {node.sourceId ?? node.id}
            </span>
          </button>
        {:else}
          <p class="muted list-empty">{t("No matching nodes.")}</p>
        {/each}
        {#if matchingNodes.length > shown}
          <button type="button" class="more" onclick={() => (shown += 20)}>
            {t("Show more nodes")}
          </button>
        {/if}
      </div>

      <div
        class="neighborhood"
        aria-label={t("Selected node and direct relationships")}
      >
        {#if selected.decisionHold}
          {@const hold = selected.decisionHold}
          <p>{t("Held by analyst decision")} · {t(humanize(hold.disposition))} · {t("Revision")} {hold.revision}</p>
          {#if onOpenDecision}
            <button type="button" disabled={sourceNavigationDisabled}
              onclick={() => onOpenDecision?.(hold.kind, hold.id)}>
              {t(hold.kind === "finding" ? "Finding decision" : "Incident decision")} #{hold.id}
            </button>
          {/if}
        {/if}
        {#if selected.plannerRound}
          <p>{t("Model planner")} · {t("Attempt")} {selected.plannerRound.attempt}{#if selected.plannerRound.hintId} · {t("Hint")} #{selected.plannerRound.hintId}{/if}</p>
        {/if}
        {#if onOpenPeerFinding}
          {@const citations = selected.peerFinding
            ? [selected.peerFinding]
            : selected.plannerRound?.peerFindingCitations ?? []}
          {#each citations as citation}
            <button class="more" type="button" disabled={sourceNavigationDisabled}
              onclick={() => onOpenPeerFinding?.(citation)}>
              {t("Inspect source finding")} · {citation.sourceCaseId} / {citation.sourceFindingId}
            </button>
          {/each}
        {/if}
        {#if selected.relationshipSources?.length}
          <ul aria-label={t("Case sources")}>
            {#each selected.relationshipSources as source (source.caseId)}
              <li>
                {source.caseId} ·
                <button class="more" type="button" disabled={sourceNavigationDisabled}
                  onclick={() => onOpenSource(source.caseId, source.from, source.snapshotDigest)}>{source.from}</button>
                {#if source.to !== source.from}
                  →
                  <button class="more" type="button" disabled={sourceNavigationDisabled}
                    onclick={() => onOpenSource(source.caseId, source.to, source.snapshotDigest)}>{source.to}</button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if incoming.length}
          <div class="relation-section">
            <h3>{t("Incoming links")}</h3>
            {#each incoming as edge}
              {@const node = nodeById.get(edge.from)}
              {#if node}
                <button
                  type="button"
                  class="relation"
                  onclick={() => (selectedId = node.id)}
                >
                  <strong>{node.label}</strong>
                  <span>
                    {t(humanize(edge.relation))} <span aria-hidden="true">↘</span>
                  </span>
                </button>
              {/if}
            {/each}
          </div>
        {/if}

        <div class="selected-node">
          <div class="selected-meta">
            <span class="node-kind" data-kind={selected.kind}>
              {t(humanize(selected.kind))}
            </span>
            {#if selected.severity}<span
                class="severity"
                data-severity={selected.severity}
              >
                {t(humanize(selected.severity))}
              </span>{/if}
          </div>
          <strong>{selected.label}</strong>
          <span class="node-id" title={selected.id}>
            {selected.sourceId ?? selected.id}
          </span>
          {#if selected.origin || selected.status || selected.worker}
            <span class="muted">
              {[selected.origin, selected.status, selected.worker]
                .filter(Boolean)
                .map((value) => humanize(value!))
                .join(" · ")}
            </span>
          {/if}
          {#if selected.reason}<span class="muted">
              {selected.reason}
            </span>{/if}
          {#if selected.findingReviews?.length}
            <details>
              <summary>{t("Finding disposition")} · {t(humanize(selected.findingReviews[0].disposition))}</summary>
              <ol class="review-steps">
                {#each selected.findingReviews as decision (decision.id)}
                  <li><strong>{t(humanize(decision.disposition))}</strong> ·
                    <span>{t("Revision")} {decision.revision}</span> ·
                <time datetime={decision.at}>{decision.at}</time>
                    <p class="review-summary">{decision.note}</p>
                  </li>
                {/each}
              </ol>
            </details>
          {/if}
          {#if selected.incidentReview}
            {@const review = selected.incidentReview}
            <p class="review-summary">{review.note}</p>
            <span class="muted">{t("Revision")} {review.revision}</span>
            <time class="muted" datetime={review.at}>{review.at}</time>
          {/if}
          {#if selected.modelReview}
            {@const review = selected.modelReview}
            <p class="review-summary">{review.summary}</p>
            <time class="muted" datetime={review.at}>{review.at}</time>
            {#if review.steps.length}
              <details>
                <summary>{t("Worker queries")} ({review.steps.length})</summary>
                <ol class="review-steps">
                  {#each review.steps as step}
                    <li>
                      {step.tool}{step.target ? ` · ${step.target}` : ""} · {t(humanize(step.outcome))}
                      {#if step.sourceSnapshots?.length}
                        <ul>
                          {#each step.sourceSnapshots as source (source.caseId)}
                            <li>
                              {source.caseId} · <code>{source.snapshotDigest}</code>
                              {#if source.assetId}
                                <button type="button" disabled={sourceNavigationDisabled}
                                  onclick={() => onOpenSource(source.caseId, source.assetId!, source.snapshotDigest)}>
                                  {t("Open source snapshot")}
                                </button>
                              {/if}
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </li>
                  {/each}
                </ol>
              </details>
            {/if}
          {/if}
          {#if selected.alert}
            {@const alert = selected.alert}
            <dl class="alert-metadata">
              <dt>{t("Severity")}</dt><dd>{t(humanize(alert.severity))}</dd>
              <dt>{t("Subject")}</dt><dd>{alert.subject}</dd>
              <dt>{t("Observed")}</dt><dd><time datetime={alert.observedAt}>{alert.observedAt}</time></dd>
              {#if alert.triggeringAction}
                <dt>{t("Triggering action")}</dt><dd>{alert.triggeringAction}</dd>
              {/if}
              {#if alert.entraRoleGrant?.roleIds.length}
                <dt>{t("Entra role IDs")}</dt><dd>{alert.entraRoleGrant.roleIds.join(", ")}</dd>
              {/if}
              {#if alert.entraRoleGrant?.administrativeUnitIds.length}
                <dt>{t("Entra administrative unit IDs")}</dt><dd>{alert.entraRoleGrant.administrativeUnitIds.join(", ")}</dd>
              {/if}
              {#if alert.entraRoleGrant?.modifiedRoleIds?.length}
                <dt>{t("Entra role IDs from changes")}</dt><dd>{alert.entraRoleGrant.modifiedRoleIds.join(", ")}</dd>
              {/if}
              {#if alert.entraRoleGrant?.modifiedRoleTemplateIds?.length}
                <dt>{t("Entra role template IDs from changes")}</dt><dd>{alert.entraRoleGrant.modifiedRoleTemplateIds.join(", ")}</dd>
              {/if}
              <dt>{t("Evidence IDs")}</dt>
              <dd><ul>
                {#each alert.evidenceIds as evidence (evidence)}
                  <li><code>{evidence}</code></li>
                {/each}
              </ul></dd>
            </dl>
          {/if}
        </div>

        {#if outgoing.length}
          <div class="relation-section">
            <h3>{t("Outgoing links")}</h3>
            {#each outgoing as edge}
              {@const node = nodeById.get(edge.to)}
              {#if node}
                <button
                  type="button"
                  class="relation"
                  onclick={() => (selectedId = node.id)}
                >
                  <span>
                    <span aria-hidden="true">↳</span>
                    {t(humanize(edge.relation))}
                  </span>
                  <strong>{node.label}</strong>
                </button>
              {/if}
            {/each}
          </div>
        {/if}
        {#if !incoming.length && !outgoing.length}
          <p class="muted">This node has no direct links.</p>
        {/if}
        {#if unresolved.length}
          <div class="relation-section unresolved">
            <h3>{t("Unresolved references")}</h3>
            {#each unresolved as entry}
              <span class="node-id">
                {t(humanize(entry.relation))} · {entry.reference}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .graph-trace { margin-block: .5rem; overflow-wrap: anywhere; }
  .graph-path { border-top: 1px solid var(--border); margin-top: .5rem; padding-top: .5rem; }
  .graph-path li { margin-block: .25rem; }
  .alert-metadata {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: .25rem .5rem;
    margin: .5rem 0 0;
    font-size: .8rem;
    overflow-wrap: anywhere;
  }
  .alert-metadata dd, .alert-metadata ul {
    margin: 0;
  }
  .alert-metadata ul {
    padding-left: 1rem;
  }

  .panel {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg2);
  }
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }
  .panel-header h2 {
    font-size: 15px;
    font-weight: 650;
  }
  .panel-header span,
  .muted {
    color: var(--fg2);
    font-size: 12px;
  }
  .empty {
    min-height: 240px;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
    color: var(--fg2);
  }
  .graph-controls {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    display: grid;
    grid-template-columns: minmax(100px, 1fr) minmax(95px, auto);
    gap: 12px;
  }
  .graph-controls label {
    display: grid;
    gap: 4px;
    min-width: 0;
    font-size: 11px;
    color: var(--fg2);
  }
  .search-field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
  }
  .search-field,
  select {
    height: 34px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg);
    border-radius: var(--radius-sm);
  }
  input {
    color: var(--fg);
    background: transparent;
    border: 0;
    min-width: 0;
    width: 100%;
    font: inherit;
    height: 100%;
  }
  select {
    max-width: 100%;
    padding: 0 6px;
    font: inherit;
  }
  .graph-body {
    display: grid;
    grid-template-columns: minmax(110px, 0.8fr) minmax(160px, 1.35fr);
    min-height: 320px;
  }
  .node-list {
    padding: 8px;
    max-height: 470px;
    overflow: auto;
    border-right: 1px solid var(--border);
  }
  .node-list button {
    width: 100%;
    text-align: left;
    padding: 8px;
    display: grid;
    gap: 2px;
    color: var(--fg);
    border: 1px solid transparent;
    border-radius: var(--radius);
  }
  .node-list button:hover {
    background: var(--bg3);
  }
  .node-list button.selected {
    background: var(--accent-dim);
    border-color: var(--accent-glow);
  }
  .node-list strong,
  .node-id {
    overflow-wrap: anywhere;
  }
  .node-list strong {
    font-size: 12px;
    font-weight: 600;
  }
  .node-list .more {
    color: var(--accent);
  }
  .list-empty {
    padding: 8px;
  }
  .node-id {
    color: var(--fg2);
    font: 10px var(--font-mono);
  }
  .node-kind {
    width: fit-content;
    border-radius: 4px;
    font-size: 10px;
    line-height: 1.5;
    font-weight: 650;
    color: var(--fg2);
  }
  .node-kind[data-kind="asset"] {
    color: #9ac8f5;
  }
  .node-kind[data-kind="finding"] {
    color: var(--status-yellow);
  }
  .node-kind[data-kind="evidence"] {
    color: #c9b6fc;
  }
  .node-kind[data-kind="control"] {
    color: var(--status-green);
  }
  .node-kind[data-kind="goal"],
  .node-kind[data-kind="task"] {
    color: #9ac8f5;
  }
  .node-kind[data-kind="observation"] {
    color: #c9b6fc;
  }
  .neighborhood {
    padding: 14px;
    display: flex;
    align-items: stretch;
    flex-direction: column;
    gap: 12px;
    max-height: 470px;
    overflow: auto;
    background: radial-gradient(circle, var(--border) 1px, transparent 1px)
      var(--bg) 0 0 / 17px 17px;
  }
  .neighborhood > .muted {
    align-self: flex-start;
    background: var(--bg);
    padding: 4px 6px;
    border-radius: var(--radius-sm);
  }
  .selected-node {
    display: grid;
    gap: 3px;
    align-content: start;
    border: 1px solid var(--accent-glow);
    background: var(--bg2);
    border-radius: var(--radius);
    padding: 12px;
    overflow-wrap: anywhere;
  }
  .selected-meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
  }
  .severity {
    color: var(--fg2);
    font-size: 10px;
  }
  .severity[data-severity="critical"],
  .severity[data-severity="high"] {
    color: var(--status-red);
  }
  .relation-section {
    display: grid;
    gap: 4px;
    border-left: 1px solid var(--fg3);
    margin-left: 6px;
    padding-left: 10px;
  }
  .relation-section h3 {
    width: fit-content;
    color: var(--fg2);
    font-size: 11px;
    font-weight: 600;
    background: var(--bg);
  }
  .unresolved {
    border-color: var(--status-yellow);
  }
  .relation {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 4px;
    align-items: baseline;
    color: var(--fg);
    text-align: left;
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
  }
  .relation:hover {
    border-color: var(--accent-glow);
  }
  .relation strong {
    font-size: 11px;
    font-weight: 550;
    overflow-wrap: anywhere;
  }
  .relation span {
    color: var(--fg2);
    font-size: 10px;
  }
  @media (max-width: 550px) {
    .graph-body {
      grid-template-columns: minmax(80px, 0.7fr) minmax(135px, 1fr);
    }
    .neighborhood {
      padding: 8px;
    }
  }
  .review-summary, .review-steps {
    overflow-wrap: anywhere;
    margin: 0;
  }
  .review-steps {
    padding-inline-start: 1.25rem;
  }
</style>
