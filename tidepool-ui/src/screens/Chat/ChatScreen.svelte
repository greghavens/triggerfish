<script lang="ts">
  import StatusBar from "./StatusBar.svelte";
  import MessageList from "./MessageList.svelte";
  import ChatInput from "./ChatInput.svelte";
  import CanvasPanel from "./Canvas/CanvasPanel.svelte";
  import { getCanvasVisible } from "../../lib/stores/canvas.svelte.js";
  import { closeSideQuestions, getSideQuestions, sendMessage } from "../../lib/stores/chat.svelte.js";

  const side = $derived(getSideQuestions());
</script>

<div class="chat-screen">
  <div class="chat-main">
    <StatusBar />
    <MessageList />
    {#if side.visible}
      <section class="side-questions" aria-label="Side question history">
        <header>
          <strong>Side questions</strong>
          {#if side.running}
            <button onclick={() => sendMessage("/btw cancel")}>Cancel question</button>
          {/if}
          <button onclick={closeSideQuestions}>Close history</button>
        </header>
        {#if side.status}<p role="status">{side.status}</p>{/if}
        {#each side.entries as entry}
          <p><strong>{entry.question}</strong></p>
          <p>{entry.answer}</p>
        {/each}
      </section>
    {/if}
    <ChatInput />
  </div>
  {#if getCanvasVisible()}
    <CanvasPanel />
  {/if}
</div>

<style>
  .chat-screen {
    height: 100%;
    display: flex;
  }

  .chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .side-questions {
    border-top: 1px solid var(--bg3);
    max-height: 32vh;
    overflow: auto;
    padding: 8px 16px;
    white-space: pre-wrap;
  }

  .side-questions header {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
</style>
