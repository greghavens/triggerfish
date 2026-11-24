<script lang="ts">
  import { sentinelWorkspaceText, type WorkspaceLanguage } from "./workspace_language.js";
  import { humanize, type SentinelAlert } from "./types.js";

  let { alerts, disabled, onOpen, language = "en" }: {
    language?: WorkspaceLanguage;
    alerts: readonly SentinelAlert[];
    disabled: boolean;
    onOpen: (key: string) => void;
  } = $props();

  const t = $derived(sentinelWorkspaceText(language));
  const pageSize = 25;
  let limit = $state(pageSize);
  let search = $state("");
  let severity = $state("");
  let asset = $state("");
  let type = $state("");
  let order = $state("time");

  const ranks: Readonly<Record<string, number>> = { critical: 4, high: 3, medium: 2, low: 1 };
  const severities = $derived([...new Set(alerts.map((alert) => alert.severity))]
    .sort((a, b) => (ranks[b] ?? 0) - (ranks[a] ?? 0)));
  const assets = $derived([...new Set(alerts.map((alert) => alert.asset))].sort());
  const types = $derived([...new Set(alerts.map((alert) => alert.type))]
    .sort((a, b) => t(humanize(a)).localeCompare(t(humanize(b)), language)));
  const matches = $derived.by(() => {
    const term = search.trim().toLocaleLowerCase(language);
    return alerts.filter((alert) =>
      (!severity || alert.severity === severity) &&
      (!asset || alert.asset === asset) &&
      (!type || alert.type === type) &&
      (!term || [
        alert.type, t(humanize(alert.type)), alert.asset, alert.subject,
        alert.severity, t(humanize(alert.severity)), alert.triggeringAction,
        ...alert.evidenceIds,
      ].some((field) => field?.toLocaleLowerCase(language).includes(term)))
    ).sort((a, b) => {
      const severityOrder = order === "severity" ? (ranks[b.severity] ?? 0) - (ranks[a.severity] ?? 0) : 0;
      return severityOrder || b.observedAt.localeCompare(a.observedAt);
    });
  });

  function open(alert: SentinelAlert) {
    onOpen(JSON.stringify([alert.type, alert.asset, [...alert.evidenceIds].sort()]));
  }
</script>

<section aria-label={t("Saved alerts")}>
  <h3>{t("Saved alerts")} ({alerts.length})</h3>
  {#if alerts.length}
    <div class="filters">
      <label>{t("Find saved alerts")}
        <input type="search" bind:value={search} oninput={() => limit = pageSize} />
      </label>
      <label>{t("Severity")}
        <select aria-label={t("Severity")} bind:value={severity} onchange={() => limit = pageSize}>
          <option value="">{t("Any")}</option>
          {#each severities as item (item)}<option value={item}>{t(humanize(item))}</option>{/each}
        </select>
      </label>
      <label>{t("Asset")}
        <select aria-label={t("Asset")} bind:value={asset} onchange={() => limit = pageSize}>
          <option value="">{t("Any")}</option>
          {#each assets as item (item)}<option value={item}>{item}</option>{/each}
        </select>
      </label>
      <label>{t("Alert type")}
        <select aria-label={t("Alert type")} bind:value={type} onchange={() => limit = pageSize}>
          <option value="">{t("Any")}</option>
          {#each types as item (item)}<option value={item}>{t(humanize(item))}</option>{/each}
        </select>
      </label>
      <label>{t("Sort alerts")}
        <select aria-label={t("Sort alerts")} bind:value={order} onchange={() => limit = pageSize}>
          <option value="time">{t("Newest first")}</option>
          <option value="severity">{t("Highest severity first")}</option>
        </select>
      </label>
    </div>
    <p aria-live="polite">{t("{matched} of {total} alerts", { matched: matches.length, total: alerts.length })}</p>
    <ul>
      {#each matches.slice(0, limit) as alert}
        <li>
          <button type="button" {disabled} onclick={() => open(alert)}>
            {t(humanize(alert.type))} · {alert.asset} · {alert.subject} · {t(humanize(alert.severity))}
            {alert.triggeringAction ? ` · ${alert.triggeringAction}` : ""}
          </button>
          <time datetime={alert.observedAt}>{alert.observedAt}</time>
        </li>
      {:else}
        <li>{t("No saved alerts match your search.")}</li>
      {/each}
    </ul>
    {#if matches.length > limit}
      <button type="button" onclick={() => limit += pageSize}>{t("Show more saved alerts")}</button>
    {/if}
  {:else}
    <p>{t("No alerts were saved for this revision.")}</p>
  {/if}
</section>

<style>
  .filters { display: flex; flex-wrap: wrap; gap: .75rem; }
  label { display: grid; gap: .25rem; min-width: 0; }
  select { max-width: 100%; }
  li { margin-block: .3rem; overflow-wrap: anywhere; }
  time { display: block; font-size: .8rem; }
</style>
