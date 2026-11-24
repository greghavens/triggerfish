<script lang="ts">
  import { sentinelWorkspaceText, type WorkspaceLanguage } from "./workspace_language.js";
  import { onDestroy } from "svelte";
  import type { SentinelImportPreview, SentinelInventoryImport } from "./types.js";

  let {
    disabled,
    language = "en",
    imported,
    paused = false,
    onImport,
    onPreview,
    preview,
    onApplyPreview,
    onClearPreview,
  }: {
    language?: WorkspaceLanguage;
    disabled: boolean;
    imported: number;
    paused?: boolean;
    onImport: (request: SentinelInventoryImport) => void;
    onPreview: (request: SentinelInventoryImport) => void;
    preview?: SentinelImportPreview;
    onApplyPreview: () => void;
    onClearPreview: () => void;
  } = $props();

  const t = $derived(sentinelWorkspaceText(language));
  const maximumBytes = 1024 * 1024;
  let format = $state<SentinelInventoryImport["format"]>("graph");
  let source = $state("");
  let mode = $state<SentinelInventoryImport["mode"]>("merge");
  let fileInput = $state<HTMLInputElement>();
  let reading = $state(false);
  let error = $state("");
  let disposed = false;

  onDestroy(() => {
    disposed = true;
  });

  $effect(() => {
    if (imported && fileInput) fileInput.value = "";
  });

  async function importInventory(event: SubmitEvent) {
    event.preventDefault();
    if (disabled || reading) return;
    error = "";
    const file = fileInput?.files?.item(0);
    if (!file || !file.size || file.size > maximumBytes) {
      error = "Choose a nonempty JSON file up to 1 MiB.";
      return;
    }
    const previewOnly = event.submitter?.getAttribute("value") === "preview";
    const selectedFormat = format;
    const project = source.trim();
    const selectedMode = mode;
    if (selectedFormat !== "graph" && !project) {
      error = "Enter the project ID for this inventory.";
      return;
    }

    reading = true;
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (disposed) return;
      (previewOnly ? onPreview : onImport)({
        format: selectedFormat,
        mode: selectedMode,
        ...(selectedFormat === "graph" ? {} : { source: project }),
        content,
      });
    } catch {
      error = "The inventory file could not be read as UTF-8.";
    } finally {
      reading = false;
    }
  }
</script>

<details class="inventory">
  <summary>{t("Import inventory")}</summary>
  <form onsubmit={importInventory} onchange={onClearPreview}>
    <label>
      <span>{t("Inventory format")}</span>
      <select bind:value={format} disabled={disabled || reading}>
        <option value="graph">{t("Sentinel graph")}</option>
        <option value="sarif">SARIF</option>
        <option value="cyclonedx">CycloneDX</option>
        <option value="spdx">SPDX</option>
        <option value="osv">OSV-Scanner</option>
        <option value="har">{t("HTTP archive (HAR)")}</option>
      </select>
    </label>
    {#if format !== "graph"}
      <label>
        <span>{t("Project ID")}</span>
        <input
          type="text"
          bind:value={source}
          disabled={disabled || reading}
          required
        />
      </label>
    {/if}
    <label>
      <span>{t("Import mode")}</span>
      <select bind:value={mode} disabled={disabled || reading}>
        <option value="merge">{t("Merge with current inventory")}</option>
        <option value="replace">{t("Replace current inventory")}</option>
      </select>
    </label>
    <label class="file-field">
      <span>{t("JSON file (up to 1 MiB)")}</span>
      <input
        bind:this={fileInput}
        type="file"
        accept=".json,.sarif,.har,application/json"
        required
        disabled={disabled || reading}
      />
    </label>
    <button type="submit" value="preview" disabled={disabled || reading}>
      {t("Preview import")}
    </button>
    <button type="submit" disabled={disabled || reading || !!preview}>
      {t(reading ? "Reading…" : "Import")}
    </button>
  </form>
  {#if preview}
    <div aria-live="polite">
      <p>{t("Records")} {preview.currentNodes} → {preview.resultingNodes} · {t("Relationships")} {preview.currentEdges} → {preview.resultingEdges}</p>
      <p>{t("Added records")} {preview.addedNodes} · {t("Changed records")} {preview.changedNodes} · {t("Removed records")} {preview.removedNodes}</p>
      <p>{t("Added relationships")} {preview.addedEdges} · {t("Removed relationships")} {preview.removedEdges}</p>
      {#each [
        { label: "Added records", total: preview.addedNodes, records: preview.records?.added },
        { label: "Removed records", total: preview.removedNodes, records: preview.records?.removed },
      ] as group (group.label)}
        {#if group.records?.length}
          <details>
            <summary>{t(group.label)} ({group.records.length}/{group.total})</summary>
            <ul>
              {#each group.records as record}
                <li>{record.label} · {t(record.kind)} · <code>{record.id}</code></li>
              {/each}
            </ul>
          </details>
        {/if}
      {/each}
      {#if preview.records?.changed.length}
        <details>
          <summary>{t("Changed records")} ({preview.records.changed.length}/{preview.changedNodes})</summary>
          <ul>
            {#each preview.records.changed as { before, after, fields }}
              <li><code>{after.id}</code> · {before.label}{#if before.severity} ({before.severity}){/if}
                → {after.label}{#if after.severity} ({after.severity}){/if} · {fields.join(", ")}</li>
            {/each}
          </ul>
        </details>
      {/if}
      {#each [
        { label: "Added relationships", total: preview.addedEdges, edges: preview.relationships?.added },
        { label: "Removed relationships", total: preview.removedEdges, edges: preview.relationships?.removed },
      ] as group (group.label)}
        {#if group.edges?.length}
          <details>
            <summary>{t(group.label)} ({group.edges.length}/{group.total})</summary>
            <ul>
              {#each group.edges as edge}
                <li><code>{edge.from}</code> → {t(edge.relation.replaceAll("_", " "))} → <code>{edge.to}</code></li>
              {/each}
            </ul>
          </details>
        {/if}
      {/each}
      <button type="button" disabled={disabled || reading} onclick={onApplyPreview}>{t("Apply reviewed import")}</button>
      <button type="button" disabled={disabled || reading} onclick={onClearPreview}>{t("Dismiss preview")}</button>
    </div>
  {/if}
  {#if error}<p class="notice error" role="alert">{t(error)}</p>{/if}
  {#if imported && !error}<p class="notice" role="status">
      {t(paused ? "Inventory imported. Sentinel will assess it when the case resumes." : "Inventory imported.")}
    </p>{/if}
</details>

<style>
  .inventory {
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  summary {
    width: fit-content;
    color: var(--accent);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: end;
    margin-top: 9px;
  }
  label {
    min-width: 0;
    display: grid;
    gap: 4px;
    color: var(--fg2);
    font-size: 11px;
  }
  .file-field {
    flex: 1 1 230px;
  }
  input,
  select,
  button {
    min-width: 0;
    min-height: 34px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    padding: 0 7px;
    font-size: 12px;
  }
  input[type="file"] {
    padding: 4px;
  }
  button {
    background: var(--bg3);
    padding: 0 12px;
  }
  button:hover:not(:disabled) {
    border-color: var(--accent-glow);
  }
  :disabled {
    opacity: 0.45;
    cursor: default;
  }
  .notice {
    margin-top: 6px;
    color: var(--status-green);
    font-size: 12px;
  }
  .error {
    color: var(--status-red);
  }
</style>
