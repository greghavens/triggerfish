<script lang="ts">
  import { sentinelWorkspaceText, type WorkspaceLanguage } from "./workspace_language.js";
  import { comparisonText, workerEventLabel } from "./comparison_markdown.js";
  import { humanize, planningInputs, type IncidentReview, type SentinelAdaptive, type SentinelObservation, type SentinelAlert, type SentinelNode, type SentinelTask } from "./types.js";

  type WorkerEvent = NonNullable<SentinelAdaptive["history"]>[number];

  let { language = "en", earlierObservations, laterObservations, earlierTasks, laterTasks,
    earlierHistory, laterHistory, baseline, revision, earlierCursor, laterCursor, pagingDisabled, onOlder, earlierGoal, laterGoal, earlierPlanner, laterPlanner, earlierPlannerHistory, laterPlannerHistory, earlierAlerts, laterAlerts, fullAlertFeeds, earlierAlertNodes, laterAlertNodes, onEarlierAlert, onLaterAlert, onEarlierSavedAlert, onLaterSavedAlert, earlierIncidents, laterIncidents, earlierIncidentReviews, laterIncidentReviews, onPlanningInput }: {
    language?: WorkspaceLanguage;
    earlierObservations: readonly SentinelObservation[];
    earlierAlerts: readonly SentinelAlert[];
    laterAlerts: readonly SentinelAlert[];
    fullAlertFeeds: boolean;
    onPlanningInput: (kind: "finding" | "incident" | "hint", id: number) => void;
    earlierIncidents: readonly SentinelNode[];
    laterIncidents: readonly SentinelNode[];
    earlierIncidentReviews: readonly IncidentReview[];
    laterIncidentReviews: readonly IncidentReview[];
    earlierAlertNodes: readonly SentinelNode[];
    laterAlertNodes: readonly SentinelNode[];
    onEarlierAlert: (id: string) => void;
    onLaterAlert: (id: string) => void;
    onEarlierSavedAlert: (key: string) => void;
    onLaterSavedAlert: (key: string) => void;
    laterObservations: readonly SentinelObservation[];
    earlierTasks: readonly SentinelTask[] | null;
    laterTasks: readonly SentinelTask[] | null;
    earlierGoal: string | null;
    laterGoal: string | null;
    earlierPlanner: SentinelAdaptive["modelPlanner"];
    laterPlanner: SentinelAdaptive["modelPlanner"];
    earlierPlannerHistory: NonNullable<SentinelAdaptive["modelPlannerHistory"]>;
    laterPlannerHistory: NonNullable<SentinelAdaptive["modelPlannerHistory"]>;
    earlierHistory: readonly WorkerEvent[] | null;
    laterHistory: readonly WorkerEvent[] | null;
    baseline: number;
    revision: number;
    earlierCursor?: number | null;
    laterCursor?: number | null;
    pagingDisabled: boolean;
    onOlder: (revision: number, cursor: number) => void;
  } = $props();
  const t = $derived(sentinelWorkspaceText(language));

  interface RecordValue {
    key: string;
    label: string;
    details: unknown;
  }

  function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
      }
      return item;
    });
  }

  function differences(before: readonly RecordValue[], after: readonly RecordValue[]) {
    const previous = new Map(before.map((entry) => [entry.key, entry]));
    const current = new Map(after.map((entry) => [entry.key, entry]));
    return [...new Set([...current.keys(), ...previous.keys()])].flatMap((key) => {
      const earlier = previous.get(key);
      const later = current.get(key);
      if (earlier && later && canonical(earlier.details) === canonical(later.details)) return [];
      return [{ key, earlier, later }];
    });
  }

  function observationRecord(observation: SentinelObservation): RecordValue {
    return {
      key: observation.id,
      label: humanize(observation.task),
      details: { worker: observation.worker, facts: observation.facts },
    };
  }

  function taskKey(task: SentinelTask): string {
    return JSON.stringify([task.kind, task.nodeId, task.depth]);
  }

  function taskLabel(task: SentinelTask): string {
    return [humanize(task.kind ?? "task"), task.nodeId].filter(Boolean).join(" · ");
  }

  function taskRecords(tasks: readonly SentinelTask[]): RecordValue[] {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return tasks.map((task) => {
      const prerequisites = (task.prerequisites ?? []).map((id) => {
        const dependency = byId.get(id);
        return dependency
          ? {
            key: taskKey(dependency),
            value: { kind: dependency.kind, node: dependency.nodeId, depth: dependency.depth },
          }
          : { key: id, value: { unresolvedTaskId: id } };
      }).sort((left, right) => left.key.localeCompare(right.key));
      return {
        key: taskKey(task),
        label: taskLabel(task),
        details: {
          depth: task.depth,
          status: task.status,
          attempts: task.attempts,
          prerequisites: prerequisites.map(({ value }) => value),
          evidence: [...(task.evidenceIds ?? [])].sort(),
          reason: task.reason,
          observation: task.observation,
        },
      };
    });
  }

  function alertKey(alert: SentinelAlert): string {
    return JSON.stringify([alert.type, alert.asset, [...alert.evidenceIds].sort()]);
  }

  function alertNodeIds(nodes: readonly SentinelNode[]): Map<string, string> {
    return new Map(nodes.flatMap(({ id, alert }) => alert ? [[alertKey(alert), id]] : []));
  }

  const earlierAlertIds = $derived(alertNodeIds(earlierAlertNodes));
  const laterAlertIds = $derived(alertNodeIds(laterAlertNodes));

  function alertRecords(alerts: readonly SentinelAlert[]): RecordValue[] {
    const records = new Map<string, RecordValue>();
    for (const alert of alerts) {
      const evidenceIds = [...alert.evidenceIds].sort();
      const key = alertKey(alert);
      const previous = records.get(key)?.details as SentinelAlert | undefined;
      if (previous && previous.observedAt >= alert.observedAt) continue;
      records.set(key, {
        key,
        label: [humanize(alert.type), alert.triggeringAction].filter(Boolean).join(" · "),
        details: { ...alert, evidenceIds },
      });
    }
    return [...records.values()];
  }

  const alertScope = $derived(fullAlertFeeds
    ? "Comparison covers both saved alert feeds."
    : "Comparison covers up to 25 distinct recent alerts per revision.");
  const alerts = $derived(differences(alertRecords(earlierAlerts), alertRecords(laterAlerts)));
  const alertPageSize = 25;
  let alertSearch = $state("");
  let alertChange = $state("all");
  let alertLimit = $state(alertPageSize);

  const filteredAlerts = $derived.by(() => {
    const search = alertSearch.trim().toLowerCase();
    return alerts.filter(({ earlier, later }) => {
      const change = changeLabel(earlier, later).toLowerCase();
      if (alertChange !== "all" && alertChange !== change) return false;
      return !search || [earlier, later].some((record) =>
        record && JSON.stringify(record.details).toLowerCase().includes(search)
      );
    });
  });

  function changeLabel(earlier: RecordValue | undefined, later: RecordValue | undefined) {
    return earlier && later ? "Changed" : later ? "Added" : "Removed";
  }

  const observations = $derived(differences(earlierObservations.map(observationRecord), laterObservations.map(observationRecord)));
  const tasks = $derived(earlierTasks && laterTasks
    ? differences(taskRecords(earlierTasks), taskRecords(laterTasks))
    : null);

  const timelines = $derived([
    { revision: baseline, events: earlierHistory, cursor: earlierCursor },
    { revision, events: laterHistory, cursor: laterCursor },
  ]);

  function describePlanner(planner: SentinelAdaptive["modelPlanner"], text = (value: string) => value): string {
    return planner
      ? `${text(humanize(planner.status))} · ${text("Attempt")} ${planner.attempt}`
      : text("No recorded model planner status");
  }

  const plannerRevisions = $derived([
    { number: baseline, status: earlierPlanner, attempts: earlierPlannerHistory },
    { number: revision, status: laterPlanner, attempts: laterPlannerHistory },
  ]);
  const hasPlannerRecords = $derived(plannerRevisions.some(({ status, attempts }) => status || attempts.length));

  function describeAttempt(entry: NonNullable<SentinelAdaptive["modelPlannerHistory"]>[number], text = (value: string) => value, includeInputs = true): string {
    const finished = entry.finished ? ` · ${text("Finished")} ${entry.finished}` : "";
    const inputs = includeInputs ? planningInputs(entry).flatMap(({ label, ids }) => ids.map((id) => ` · ${text(label)} #${id}`)).join("") : "";
    return `${text("Attempt")} ${entry.attempt} · ${text(humanize(entry.outcome))} · ${text("Started")} ${entry.started}${finished}${inputs}`;
  }

  function incidentStates(nodes: readonly SentinelNode[], reviews: readonly IncidentReview[]) {
    const latest = new Map<string, IncidentReview>();
    for (const review of reviews) {
      if ((latest.get(review.incidentId)?.id ?? 0) < review.id) latest.set(review.incidentId, review);
    }
    return new Map(nodes.flatMap(({ sourceId, incident }) => sourceId && incident
      ? [[sourceId, { asset: incident.asset, disposition: latest.get(sourceId)?.disposition ?? "requires_review" }]] as const
      : []));
  }

  const incidentChanges = $derived.by(() => {
    const earlier = incidentStates(earlierIncidents, earlierIncidentReviews);
    const later = incidentStates(laterIncidents, laterIncidentReviews);
    return [...new Set([...later.keys(), ...earlier.keys()])].flatMap((id) => {
      const from = earlier.get(id);
      const to = later.get(id);
      const incident = to ?? from;
      return incident && from?.disposition !== to?.disposition
        ? [{ id, asset: incident.asset, from: from?.disposition, to: to?.disposition }]
        : [];
    });
  });

  function incidentDisposition(value: string | undefined, text: (value: string) => string) {
    return text(value ? humanize(value) : "Incident absent");
  }

  export function markdown(text: (value: string) => string): string {
    const lines: string[] = [];
    if (incidentChanges.length) {
      lines.push(`## ${text("Incident disposition changes")}`, "");
      for (const { id, asset, from, to } of incidentChanges) {
        lines.push(`- ${comparisonText(asset)} · ${comparisonText(id)} · ${incidentDisposition(from, text)} → ${incidentDisposition(to, text)}`);
      }
      lines.push("");
    }
    if (hasPlannerRecords) {
      lines.push(`## ${text("Model planning")}`, "");
      for (const plan of plannerRevisions) {
        lines.push(`- ${text("Revision")} ${plan.number} · ${comparisonText(describePlanner(plan.status, text))}`);
        for (const attempt of plan.attempts) {
          lines.push(`  - ${comparisonText(describeAttempt(attempt, text))}`);
        }
      }
      lines.push("");
    }
    if (earlierGoal !== laterGoal) {
      lines.push(`## ${text("Adaptive goal changes")}`, "",
        `- ${text("Earlier revision")} · ${comparisonText(earlierGoal ?? text("No linked goal"))}`,
        `- ${text("Selected revision")} · ${comparisonText(laterGoal ?? text("No linked goal"))}`, "");
    }
    for (const [label, records] of [["Alert changes", alerts], ["Assessment observation changes", observations], ["Adaptive task changes", tasks]] as const) {
      lines.push(`## ${text(label)}`, "");
      if (records === alerts) lines.push(text(alertScope), "");
      if (!records) lines.push(text("Adaptive task comparison requires linked plans for both revisions."), "");
      else if (!records.length) lines.push(text("No changes."), "");
      for (const { earlier, later } of records ?? []) {
        const change = text(changeLabel(earlier, later));
        const label = later?.label ?? earlier?.label ?? "";
        lines.push(`- ${change} · ${comparisonText(label)}`);
        if (earlier) lines.push(`  - ${text("Earlier revision")} · ${comparisonText(JSON.stringify(earlier.details))}`);
        if (later) lines.push(`  - ${text("Selected revision")} · ${comparisonText(JSON.stringify(later.details))}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
</script>

{#if hasPlannerRecords}
  <details>
    <summary>{t("Model planning")}</summary>
    {#each plannerRevisions as plan (plan.number)}
      <p>{t("Revision")} {plan.number} · {describePlanner(plan.status, t)}</p>
      {#if plan.attempts.length}
        <ol>
          {#each plan.attempts as attempt, index (`${attempt.identity ?? index}:${attempt.attempt}`)}
            <li>
              {describeAttempt(attempt, t, false)}
              {#each planningInputs(attempt) as input (input.kind)}
                {#each input.ids as id (id)}
                  · <button type="button" disabled={pagingDisabled}
                    onclick={() => onPlanningInput(input.kind, id)}>{t(input.label)} #{id}</button>
                {/each}
              {/each}
            </li>
          {/each}
        </ol>
      {/if}
    {/each}
  </details>
{/if}
{#if earlierGoal !== laterGoal}
  <details>
    <summary>{t("Adaptive goal changes")}</summary>
    <p>{t("Earlier revision")} · {earlierGoal ?? t("No linked goal")}</p>
    <p>{t("Selected revision")} · {laterGoal ?? t("No linked goal")}</p>
  </details>
{/if}
{#snippet changedRecord(earlier: RecordValue | undefined, later: RecordValue | undefined, earlierNode?: string, laterNode?: string, savedAlertKey?: string)}
  <details>
    <summary>{t(changeLabel(earlier, later))} · {later?.label ?? earlier?.label}</summary>
    {#if earlier}<p>{t("Earlier revision")}</p><pre>{JSON.stringify(earlier.details, null, 2)}</pre>{/if}
    {#if later}<p>{t("Selected revision")}</p><pre>{JSON.stringify(later.details, null, 2)}</pre>{/if}
    {#if earlierNode}
      <button type="button" disabled={pagingDisabled} onclick={() => onEarlierAlert(earlierNode)}>{t("Open in earlier graph")}</button>
    {:else if savedAlertKey && earlier}
      <button type="button" disabled={pagingDisabled} onclick={() => onEarlierSavedAlert(savedAlertKey)}>{t("Open in earlier graph")}</button>
    {/if}
    {#if laterNode}
      <button type="button" onclick={() => onLaterAlert(laterNode)}>{t("Show in selected graph")}</button>
    {:else if savedAlertKey && later}
      <button type="button" disabled={pagingDisabled} onclick={() => onLaterSavedAlert(savedAlertKey)}>{t("Show in selected graph")}</button>
    {/if}
  </details>
{/snippet}

{#key `${baseline}:${revision}`}
  <details>
    <summary>{t("Alert changes")} ({alerts.length})</summary>
    <p>{t(alertScope)}</p>
    {#if alerts.length}
      <div class="alert-filters">
        <label>{t("Find alert changes")}
          <input type="search" bind:value={alertSearch} oninput={() => alertLimit = alertPageSize} />
        </label>
        <label>{t("Alert change type")}
          <select bind:value={alertChange} onchange={() => alertLimit = alertPageSize}>
            <option value="all">{t("All changes")}</option>
            <option value="added">{t("Added")}</option>
            <option value="removed">{t("Removed")}</option>
            <option value="changed">{t("Changed")}</option>
          </select>
        </label>
      </div>
      {#each filteredAlerts.slice(0, alertLimit) as { key, earlier, later } (key)}
        {@render changedRecord(earlier, later, earlierAlertIds.get(key), laterAlertIds.get(key), fullAlertFeeds ? key : undefined)}
      {:else}
        <p>{t("No alert changes match these filters.")}</p>
      {/each}
      {#if filteredAlerts.length > alertLimit}
        <button type="button" onclick={() => alertLimit += alertPageSize}>{t("Show more alert changes")}</button>
      {/if}
    {:else}
      <p>{t("No changes.")}</p>
    {/if}
  </details>
{/key}

{#each [{ label: "Assessment observation changes", records: observations }, { label: "Adaptive task changes", records: tasks }] as group (group.label)}
  {#if group.records}
    <details>
      <summary>{t(group.label)} ({group.records.length})</summary>
      {#if group.records.length === 0}<p>{t("No changes.")}</p>{/if}
      {#each group.records as { key, earlier, later } (key)}
        {@render changedRecord(earlier, later)}
      {/each}
    </details>
  {:else}
    <p>{t("Adaptive task comparison requires linked plans for both revisions.")}</p>
  {/if}
{/each}

<details>
  <summary>{t("Worker timelines")}</summary>
  <div class="timelines">
    {#each timelines as timeline (timeline.revision)}
      <section aria-label={`${t("Worker timeline for revision")} ${timeline.revision}`}>
        <h4>{t("Revision")} {timeline.revision}</h4>
        {#if !timeline.events}
          <p>{t("No linked adaptive plan.")}</p>
        {:else if !timeline.events.length}
          <p>{t("No recorded task transitions.")}</p>
        {:else}
          <ol>
            {#each timeline.events as event}
              <li>
                <time datetime={event.at}>{event.at}</time> · {workerEventLabel(event, t)}
                {#if event.note}<p>{event.note}</p>{/if}
              </li>
            {/each}
          </ol>
        {/if}
        {#if timeline.cursor}
          {@const cursor = timeline.cursor}
          <button type="button" disabled={pagingDisabled} onclick={() => onOlder(timeline.revision, cursor)}>
            {t("Load older transitions")}
          </button>
        {/if}
      </section>
    {/each}
  </div>
</details>

{#if incidentChanges.length}
  <details>
    <summary>{t("Incident disposition changes")} ({incidentChanges.length})</summary>
    <ul>
      {#each incidentChanges as { id, asset, from, to } (id)}
        <li>{asset} · <code>{id}</code> · {incidentDisposition(from, t)} → {incidentDisposition(to, t)}</li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .alert-filters {
    display: flex;
    flex-wrap: wrap;
    gap: .75rem;
    margin-bottom: .5rem;
  }
  .alert-filters label {
    display: grid;
    gap: .25rem;
  }

  .timelines {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
    gap: 1rem;
    overflow-wrap: anywhere;
  }

  pre {
    overflow: auto;
    max-height: 20rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
