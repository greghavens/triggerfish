<script lang="ts">
  import { humanize, type DecisionHistoryPage } from "./types.js";
  import { sentinelWorkspaceText, type WorkspaceLanguage } from "./workspace_language.js";

  let { page, disabled, language, onPage }: {
    page?: DecisionHistoryPage;
    disabled: boolean;
    language: WorkspaceLanguage;
    onPage: (before?: number) => void;
  } = $props();
  const t = $derived(sentinelWorkspaceText(language));
</script>

{#if page}
  <div aria-label={t("Decision history")} role="region">
    {#if page.decisions.length}
      <ol>
        {#each page.decisions as decision (decision.id)}
          <li>
            <strong>{t(humanize(decision.disposition))}</strong> ·
            {t("Revision")} {decision.revision} ·
            <time datetime={decision.at}>{decision.at}</time>
            <p>{decision.note}</p>
          </li>
        {/each}
      </ol>
    {:else}
      <p>{t("No saved decisions")}</p>
    {/if}
    {#if page.before !== undefined}
      <button type="button" {disabled} onclick={() => onPage()}>{t("Latest decisions")}</button>
    {/if}
    {#if page.nextBefore !== null}
      {@const before = page.nextBefore}
      <button type="button" {disabled} onclick={() => onPage(before)}>{t("Older decisions")}</button>
    {/if}
  </div>
{:else}
  <button type="button" {disabled} onclick={() => onPage()}>{t("Browse decision history")}</button>
{/if}
