<script lang="ts">
  import Icon from "../../lib/components/Icon.svelte";
  import { sendMessage, cancelGeneration, getThinking, getSentinelMode, getPendingImages, removePendingImage, addPendingImage } from "../../lib/stores/chat.svelte.js";
  import { getTaint } from "../../lib/stores/session.svelte.js";
  import { classificationColor } from "../../lib/types.js";

  let inputText = $state("");
  let textareaEl: HTMLTextAreaElement;

  const taintColor = $derived(classificationColor(getTaint()));
  const sideCommand = $derived(/^\/btw(?:\s|$)/.test(inputText.trim()));

  function handleSend(): void {
    if (getThinking() && !sideCommand) {
      cancelGeneration();
      return;
    }
    if (!inputText.trim() && getPendingImages().length === 0) return;
    sendMessage(inputText);
    inputText = "";
    if (textareaEl) textareaEl.style.height = "auto";
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(): void {
    if (textareaEl) {
      textareaEl.style.height = "auto";
      textareaEl.style.height = Math.min(textareaEl.scrollHeight, 120) + "px";
    }
  }

  function handlePaste(e: ClipboardEvent): void {
    if (getSentinelMode()) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(",")[1];
          addPendingImage(base64);
        };
        reader.readAsDataURL(file);
      }
    }
  }
</script>

<div class="input-area">
  {#if getPendingImages().length > 0}
    <div class="paste-indicator">
      {#each getPendingImages() as _, i}
        <span class="paste-chip">
          <Icon name="image" size={12} />
          Image {i + 1}
          <button class="paste-remove" onclick={() => removePendingImage(i)}>&times;</button>
        </span>
      {/each}
    </div>
  {/if}

  {#if getSentinelMode()}
    <div class="mode-status" role="status">Sentinel mode · /sentinel to exit</div>
  {/if}

  <div class="input-bar" style:box-shadow="0 -2px 0 0 {taintColor} inset">
    <textarea
      bind:this={textareaEl}
      bind:value={inputText}
      onkeydown={handleKeydown}
      oninput={handleInput}
      onpaste={handlePaste}
      placeholder={getSentinelMode() ? "Ask Sentinel…" : "Send a message..."}
      rows="1"
      disabled={false}
    ></textarea>
    <button
      class="send-btn"
      class:stop={getThinking() && !sideCommand}
      onclick={handleSend}
      title={getThinking() && !sideCommand ? "Stop" : "Send"}
    >
      <Icon name={getThinking() && !sideCommand ? "stop" : "send"} size={18} />
    </button>
  </div>
</div>

<style>
  .input-area {
    padding: 12px 16px;
  }

  .mode-status {
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--fg2);
  }

  .paste-indicator {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .paste-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--bg3);
    border-radius: 12px;
    font-size: 11px;
    color: var(--fg2);
  }

  .paste-remove {
    font-size: 14px;
    color: var(--fg3);
    padding: 0 2px;
    line-height: 1;
  }

  .paste-remove:hover {
    color: var(--status-red);
  }

  .input-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: 24px;
    padding: 8px 8px 8px 16px;
    transition: box-shadow var(--transition-normal);
  }

  .input-bar:focus-within {
    border-color: var(--accent);
  }

  textarea {
    flex: 1;
    border: none;
    background: none;
    resize: none;
    padding: 4px 0;
    font-size: 14px;
    line-height: 1.4;
    color: var(--fg);
    max-height: 120px;
    outline: none;
  }

  .send-btn {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent);
    color: var(--bg);
    flex-shrink: 0;
    transition:
      background var(--transition-fast),
      transform var(--transition-fast);
  }

  .send-btn:hover {
    transform: scale(1.05);
  }

  .send-btn.stop {
    background: var(--status-red);
  }
</style>
