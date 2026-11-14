<script lang="ts">
  import { clickOutside } from "../actions/clickOutside.js";

  interface MenuItem {
    label: string;
    action: () => void;
    danger?: boolean;
  }

  interface Props {
    items: MenuItem[];
    x: number;
    y: number;
    onclose: () => void;
  }

  let { items, x, y, onclose }: Props = $props();
</script>

<div
  class="context-menu glass"
  style:left="{x}px"
  style:top="{y}px"
  use:clickOutside={onclose}
>
  {#each items as item}
    <button
      class="context-item"
      class:danger={item.danger}
      onclick={() => { item.action(); onclose(); }}
    >
      {item.label}
    </button>
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: 900;
    min-width: 160px;
    padding: 4px;
    border-radius: var(--radius);
  }

  .context-item {
    display: block;
    width: 100%;
    padding: 8px 12px;
    text-align: left;
    border-radius: var(--radius-sm);
    color: var(--fg);
    font-size: 13px;
  }

  .context-item:hover {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .danger:hover {
    background: rgba(255, 107, 138, 0.15);
    color: var(--status-red);
  }
</style>
