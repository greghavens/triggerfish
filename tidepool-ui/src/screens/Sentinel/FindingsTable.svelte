<script lang="ts">
  import DecisionHistory from "./DecisionHistory.svelte";
  import { humanize, type DecisionHistoryPage, type FindingReview, type SentinelGraph, type SentinelNode } from "./types.js";
  import { sentinelWorkspaceText, type WorkspaceLanguage } from "./workspace_language.js";

  let { graph, language, onFocus, reviews, canReview, disabled, onReview, decisionPage, onHistory }: {
    graph: SentinelGraph | null;
    language: WorkspaceLanguage;
    reviews: readonly FindingReview[];
    canReview: boolean;
    decisionPage?: DecisionHistoryPage;
    onHistory?: (id: string, before?: number) => void;
    disabled: boolean;
    onReview: (id: string, disposition: string, note: string) => void;
    onFocus: (id: string) => void;
  } = $props();

  const t = $derived(sentinelWorkspaceText(language));
  const size = 20;
  let severity = $state("");
  let asset = $state("");
  let task = $state("");
  let status = $state("");
  let page = $state(0);
  let disposition = $state("");
  let reviewId = $state<string>();
  const dispositions = ["open", "confirmed", "resolved", "dismissed"];
  const byId = $derived.by(() => {
    const map = new Map<string, FindingReview[]>();
    for (const review of reviews) {
      const history = map.get(review.findingId);
      if (history) history.push(review);
      else map.set(review.findingId, [review]);
    }
    return map;
  });

  const rows = $derived.by(() => {
    const nodes = new Map(graph?.nodes.map((node) => [node.id, node]));
    const byFinding = new Map<string, {
      finding: SentinelNode;
      assets: SentinelNode[];
      tasks: SentinelNode[];
    }>();
    for (const node of nodes.values()) {
      if (node.kind === "finding") byFinding.set(node.id, { finding: node, assets: [], tasks: [] });
    }
    for (const edge of graph?.edges ?? []) {
      const row = byFinding.get(edge.from);
      const target = nodes.get(edge.to);
      if (!row || !target) continue;
      if (edge.relation === "affects" && target.kind === "asset") row.assets.push(target);
      if (edge.relation === "prompted" && target.kind === "task") row.tasks.push(target);
    }
    return [...byFinding.values()];
  });

  const reviewed = $derived(rows.find(({ finding }) => finding.id === reviewId)?.finding);
  const history = $derived(reviewed ? byId.get(reviewed.sourceId ?? reviewed.id) ?? [] : []);

  function uniqueNodes(nodes: SentinelNode[]) {
    return [...new Map(nodes.map((node) => [node.id, node])).values()]
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  const severities = $derived([...new Set(rows.flatMap(({ finding }) => finding.severity ?? []))].sort());
  const assets = $derived(uniqueNodes(rows.flatMap((row) => row.assets)));
  const tasks = $derived(uniqueNodes(rows.flatMap((row) => row.tasks)));
  const statuses = $derived([...new Set(tasks.flatMap((node) => node.status ?? []))].sort());
  const matching = $derived(rows.filter((row) =>
    (!disposition || (byId.get(row.finding.sourceId ?? row.finding.id)?.[0]?.disposition ?? "open") === disposition) &&
    (!severity || row.finding.severity === severity) &&
    (!asset || row.assets.some((node) => node.id === asset)) &&
    ((!task && !status) || (status === "unassigned" ? !task && !row.tasks.length :
      row.tasks.some((node) => (!task || node.id === task) && (!status || node.status === status))))));
  const offset = $derived(Math.min(page, Math.max(0, Math.ceil(matching.length / size) - 1)) * size);

  function taskName(node: SentinelNode) {
    return `${t(humanize(node.label))} · ${node.sourceId ?? node.id}`;
  }
</script>

{#if rows.length}
  <section aria-label={t("Findings")}>
    <h2>{t("Findings")}</h2>
    <div class="filters">
      <label>{t("Severity")}
        <select bind:value={severity} onchange={() => page = 0}>
          <option value="">{t("Any")}</option>
          {#each severities as value}<option {value}>{t(humanize(value))}</option>{/each}
        </select>
      </label>
      <label>{t("Affected asset")}
        <select bind:value={asset} onchange={() => page = 0}>
          <option value="">{t("Any")}</option>
          {#each assets as node (node.id)}<option value={node.id}>{node.label} · {node.sourceId ?? node.id}</option>{/each}
        </select>
      </label>
      <label>{t("Assigned task")}
        <select bind:value={task} onchange={() => page = 0}>
          <option value="">{t("Any")}</option>
          {#each tasks as node (node.id)}<option value={node.id}>{taskName(node)}</option>{/each}
        </select>
      </label>
      <label>{t("Finding disposition")}
        <select bind:value={disposition} onchange={() => page = 0}>
          <option value="">{t("Any")}</option>
          {#each dispositions as value}<option {value}>{t(humanize(value))}</option>{/each}
        </select>
      </label>
      <label>{t("Task status")}
        <select bind:value={status} onchange={() => page = 0}>
          <option value="">{t("Any")}</option>
          <option value="unassigned">{t("Unassigned")}</option>
          {#each statuses as value}<option {value}>{t(humanize(value))}</option>{/each}
        </select>
      </label>
    </div>
    {#if matching.length}
      <div class="table">
        <table>
          <thead><tr><th scope="col">{t("Finding")}</th><th scope="col">{t("Severity")}</th><th scope="col">{t("Affected asset")}</th><th scope="col">{t("Assigned task")}</th><th scope="col">{t("Finding disposition")}</th></tr></thead>
          <tbody>
            {#each matching.slice(offset, offset + size) as { finding, assets, tasks } (finding.id)}
              <tr>
                <td><button type="button" onclick={() => onFocus(finding.id)}>{finding.label}</button></td>
                <td>{finding.severity ? t(humanize(finding.severity)) : "—"}</td>
                <td>{assets.map((node) => node.label).join(", ") || "—"}</td>
                <td>{#each tasks as node (node.id)}
                  <div>{taskName(node)}{node.status ? ` · ${t(humanize(node.status))}` : ""}</div>
                {:else}{t("Unassigned")}{/each}</td>
                <td><button type="button" aria-pressed={reviewId === finding.id}
                  aria-label={`${t("Finding disposition")} · ${finding.label}`}
                  onclick={() => reviewId = reviewId === finding.id ? undefined : finding.id}>
                  {t(humanize(byId.get(finding.sourceId ?? finding.id)?.[0]?.disposition ?? "open"))}
                </button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <button type="button" disabled={offset === 0} onclick={() => page = offset / size - 1}>{t("Previous page")}</button>
        <span aria-live="polite">{offset + 1}–{Math.min(matching.length, offset + size)} / {matching.length}</span>
        <button type="button" disabled={offset + size >= matching.length} onclick={() => page = offset / size + 1}>{t("Next page")}</button>
      </div>
    {:else}
      <p role="status">{t("No matching findings")}</p>
    {/if}
    {#if reviewed}
      <div class="review">
        <h3>{t("Finding disposition")} · {reviewed.label}</h3>
        {#if history.length}
          <ol>
            {#each history as decision (decision.id)}
              <li><strong>{t(humanize(decision.disposition))}</strong> ·
                <span>{t("Revision")} {decision.revision}</span> ·
                <time datetime={decision.at}>{decision.at}</time>
                <p>{decision.note}</p>
              </li>
            {/each}
          </ol>
        {/if}
        {#if onHistory && history.length}
          {@const id = reviewed.sourceId ?? reviewed.id}
          <DecisionHistory page={decisionPage?.subjectId === id ? decisionPage : undefined}
            {language} {disabled} onPage={(before) => onHistory?.(id, before)} />
        {/if}
        {#if canReview}
          {#key [reviewed.id, history[0]?.id].join(":")}
            <form onsubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              onReview(reviewed.sourceId ?? reviewed.id, String(form.get("disposition")), String(form.get("note")));
            }}>
              <label>{t("Finding disposition")}
                <select name="disposition" value={history[0]?.disposition ?? "open"} {disabled}>
                  {#each dispositions as value}<option {value}>{t(humanize(value))}</option>{/each}
                </select>
              </label>
              <label>{t("Review note")}
                <textarea name="note" maxlength="1000" required {disabled}></textarea>
              </label>
              <button type="submit" {disabled}>{t("Save finding review")}</button>
            </form>
          {/key}
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  section { padding: 1rem; border: 1px solid var(--border, #374151); border-radius: 0.75rem; }
  h2 { margin: 0 0 0.75rem; font-size: 1rem; }
  .filters, .pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
  label { display: grid; gap: 0.25rem; min-width: 0; }
  select { max-width: min(22rem, 100%); background: var(--bg-secondary, #202631); color: var(--text-primary, #fff); }
  .review { margin-top: 1rem; overflow-wrap: anywhere; }
  form { display: grid; gap: 0.5rem; justify-items: start; }
  .table { overflow: auto; margin: 0.75rem 0; }
  table { width: 100%; border-collapse: collapse; text-align: start; }
  th, td { text-align: start; padding: 0.45rem; vertical-align: top; border-bottom: 1px solid var(--border, #374151); }
  button { color: inherit; font: inherit; cursor: pointer; }
  button:disabled { cursor: default; opacity: 0.5; }
</style>
