<script lang="ts">
  import type { SentinelGraph, SentinelNode } from "./types.js";
  import { sentinelWorkspaceText, type WorkspaceLanguage } from "./workspace_language.js";

  type PayloadPart = "headers" | "request" | "response";
  let { graph, onFocus, onDownload, downloadDisabled = false, language = "en" }: {
    graph: SentinelGraph | null;
    onFocus: (id: string) => void;
    onDownload?: (findingId: string, trafficLinkId: string, payloadPart: PayloadPart) => void;
    downloadDisabled?: boolean;
    language?: WorkspaceLanguage;
  } = $props();

  const t = $derived(sentinelWorkspaceText(language));
  let filter = $state("");
  let protocol = $state<"all" | "http" | "dns">("all");
  let limit = $state(20);

  function collect(snapshot: SentinelGraph | null) {
    if (!snapshot) return [];
    const assets = new Map(snapshot.nodes.filter((node) => node.kind === "asset")
      .map((node) => [node.id, node]));
    const observed = new Map<string, SentinelNode[]>();
    for (const edge of snapshot.edges) {
      if (edge.relation !== "observed_on") continue;
      const asset = assets.get(edge.to);
      if (!asset) continue;
      const entries = observed.get(edge.from) ?? [];
      entries.push(asset);
      observed.set(edge.from, entries);
    }
    return snapshot.nodes.flatMap((node) => {
      if (node.kind !== "evidence") return [];
      const source = node.sourceId ?? node.id;
      const kind = source.startsWith("har:evidence:") ? "http"
        : source.startsWith("dns:evidence:") ? "dns"
        : null;
      if (!kind) return [];
      const timestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.exec(node.label)?.[0] ?? "";
      return [{ node, kind, timestamp, assets: observed.get(node.id) ?? [] }];
    }).sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.node.id.localeCompare(b.node.id));
  }

  const evidence = $derived(collect(graph));
  const matches = $derived(evidence.filter((item) => {
    if (protocol !== "all" && protocol !== item.kind) return false;
    const term = filter.trim().toLocaleLowerCase(language);
    return !term || [item.node, ...item.assets].some(({ label, id, sourceId }) =>
      [label, id, sourceId].some(value => value?.toLocaleLowerCase(language).includes(term)));
  }));

  let findingId = $state("");
  let trafficLinkId = $state("");
  let payloadPart = $state<PayloadPart>("response");
  const canDownload = $derived(!downloadDisabled &&
    /^worker-finding:[a-f0-9]{64}$/.test(findingId.trim()) &&
    /^finding-traffic-link:[a-f0-9]{64}$/.test(trafficLinkId.trim()));

  function resetPage() {
    limit = 20;
  }
</script>

<section class="traffic" aria-labelledby="traffic-heading">
  <header>
    <h2 id="traffic-heading">{t("Traffic evidence")}</h2>
    {#if evidence.length}<span>{t("Observations")} · {evidence.length}</span>{/if}
  </header>
  {#if evidence.length}
    <div class="filters">
      <label>
        <span>{t("Search traffic")}</span>
        <input type="search" bind:value={filter} oninput={resetPage} />
      </label>
      <label>
        <span>{t("Protocol")}</span>
        <select bind:value={protocol} onchange={resetPage}>
          <option value="all">{t("All protocols")}</option>
          <option value="http">HTTP</option>
          <option value="dns">DNS</option>
        </select>
      </label>
    </div>
    {#if matches.length}
      <ul>
        {#each matches.slice(0, limit) as item (item.node.id)}
          <li>
            <button type="button" onclick={() => onFocus(item.node.id)}>
              {item.node.label}
            </button>
            {#if item.assets.length}
              <div class="assets">
                {#each item.assets as asset (asset.id)}
                  <button type="button" onclick={() => onFocus(asset.id)}>{asset.label}</button>
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if matches.length > limit}
        <button type="button" onclick={() => limit += 20}>{t("Show more observations")}</button>
      {/if}
    {:else}
      <p>{t("No traffic observations match these filters.")}</p>
    {/if}
  {:else}
    <p>{t("HTTP and DNS observations appear here when the case receives capture evidence.")}</p>
  {/if}
  {#if onDownload}
    <details>
      <summary>{t("Download retained traffic")}</summary>
      <div class="filters">
        <label>{t("Finding receipt ID")} <input bind:value={findingId} /></label>
        <label>{t("Traffic attachment ID")} <input bind:value={trafficLinkId} /></label>
        <label>{t("Payload part")}
          <select bind:value={payloadPart}>
            <option value="response">{t("Response body")}</option>
            <option value="request">{t("Request body")}</option>
            <option value="headers">{t("Headers")}</option>
          </select>
        </label>
        <button type="button" disabled={!canDownload}
          onclick={() => onDownload?.(findingId.trim(), trafficLinkId.trim(), payloadPart)}>
          {t("Download retained traffic")}
        </button>
      </div>
    </details>
  {/if}
</section>

<style>
  .traffic {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1rem;
    min-width: 0;
  }
  header, .filters, .assets {
    display: flex;
    flex-wrap: wrap;
    gap: .5rem 1rem;
  }
  header { align-items: baseline; justify-content: space-between; }
  h2 { font-size: 1rem; margin: 0; }
  label { display: grid; gap: .25rem; }
  .filters { margin: .75rem 0; }
  ul { padding: 0; list-style: none; margin: .5rem 0; }
  li { border-top: 1px solid var(--border); padding: .5rem 0; overflow-wrap: anywhere; }
  button { cursor: pointer; text-align: left; white-space: normal; }
  .assets { margin-top: .25rem; font-size: .85rem; }
</style>
