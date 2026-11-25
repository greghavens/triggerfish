<script lang="ts">
  import { onMount } from "svelte";
  import { getThinking } from "../../lib/stores/chat.svelte.js";
  import { getConnectionState, offTopic, onTopic, send } from "../../lib/stores/websocket.svelte.js";

  interface Candidate {
    nodeId: string;
    resultSha256: string;
  }

  interface Page {
    runId: string;
    adaptiveRevision: string;
    candidates: Candidate[];
    nextOffset?: number;
  }

  let { caseId, revision, findingId, t, onQueued }: {
    caseId: string;
    revision: number;
    findingId: string;
    t: (text: string) => string;
    onQueued: () => void;
  } = $props();

  let page = $state<Page>();
  let status = $state("");
  let pending = $state<{ command: string; queue: boolean }>();
  let timer: ReturnType<typeof setTimeout>;
  let queued = $state<string>();
  const requestIds = new Map<string, string>();
  const prefix = $derived(`/sentinel-recheck ${caseId} ${revision} ${findingId}`);
  const disabled = $derived(!!pending || getThinking() || getConnectionState() !== "connected");

  function finish() {
    clearTimeout(timer);
    pending = undefined;
  }

  function run(command: string, queue = false) {
    if (disabled) return;
    status = "";
    pending = { command, queue };
    send({ type: "message", content: command });
    timer = setTimeout(() => {
      finish();
      status = t("No response received. You can retry this request.");
    }, 120000);
  }

  function lookup(offset = 0) {
    run(`${prefix} ${offset}`);
  }

  function queue(candidate: Candidate) {
    if (!page) return;
    const scope = `${page.runId} ${page.adaptiveRevision}`;
    const key = `${candidate.nodeId} ${scope}`;
    const id = requestIds.get(key) ?? crypto.randomUUID();
    requestIds.set(key, id);
    run(`${prefix} queue ${key} ${id}`, true);
  }

  function receive(message: Record<string, unknown>) {
    if (!pending || message.sentinelRecheckCommand !== pending.command) return;
    const wasQueue = pending.queue;
    finish();
    const text = String(message.type === "error" ? message.message : message.text);
    if (!text.startsWith("{")) {
      status = text;
      return;
    }
    try {
      const result = JSON.parse(text);
      if (wasQueue && typeof result.receipt?.taskId === "string") {
        queued = result.receipt.taskId;
        onQueued();
      } else if (!wasQueue && result.findingId === findingId && Array.isArray(result.candidates)) {
        page = result;
      }
    } catch {
      status = t("The gateway returned an invalid recheck response.");
    }
  }

  onMount(() => {
    const disconnected = (message: Record<string, unknown>) => {
      if (message.type === "ws_disconnected" && pending) {
        finish();
        status = t("Connection lost. You can retry this request.");
      }
    };
    onTopic("chat", receive);
    onTopic("shell", disconnected);
    return () => {
      finish();
      offTopic("chat", receive);
      offTopic("shell", disconnected);
    };
  });
</script>

<div class="recheck-actions">
  <button type="button" {disabled} onclick={() => lookup()}>
    {t("Find eligible evidence for a recheck")}
  </button>
  {#if pending}
    <p role="status">{t(pending.queue ? "Awaiting recheck confirmation" : "Checking evidence")}</p>
  {/if}
  {#if status}<p role="status">{status}</p>{/if}
  {#if queued}<p role="status">{t("Recheck queued")} · <code>{queued}</code></p>{/if}
  {#if page}
    {#each page.candidates as candidate (candidate.nodeId)}
      <p>
        <code>{candidate.nodeId}</code>
        <button type="button" {disabled} onclick={() => queue(candidate)}>{t("Request recheck")}</button>
      </p>
      <p>{t("Evidence digest")} · <code>{candidate.resultSha256}</code></p>
    {:else}
      <p>{t("No eligible evidence on this page")}</p>
    {/each}
    {#if page.nextOffset !== undefined}
      {@const offset = page.nextOffset}
      <button type="button" {disabled} onclick={() => lookup(offset)}>{t("Next page")}</button>
    {/if}
  {/if}
</div>

<style>
  .recheck-actions { margin-block: 0.75rem; overflow-wrap: anywhere; }
  button { cursor: pointer; }
  button:disabled { cursor: default; }
</style>
