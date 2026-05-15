<script lang="ts">
  import Icon from "./lib/components/Icon.svelte";
  import Badge from "./lib/components/Badge.svelte";
  import StatusDot from "./lib/components/StatusDot.svelte";
  import {
    SCREENS,
    getActiveScreen,
    getBadges,
    getStatusDots,
    navigateTo,
  } from "./lib/stores/nav.svelte.js";
  import { statusToColor } from "./lib/types.js";
  import type { ScreenId, StatusColor } from "./lib/types.js";

  const labels: Record<ScreenId, string> = {
    chat: "Chat",
    agents: "Agents",
    workflows: "Workflows",
    health: "Health",
    settings: "Settings",
    logs: "Logs",
    memory: "Memory",
  };

  const iconNames: Record<ScreenId, string> = {
    chat: "chat",
    agents: "agents",
    workflows: "workflows",
    health: "health",
    settings: "settings",
    logs: "logs",
    memory: "memory",
  };

  // Calculate indicator Y position based on active screen index
  const activeIndex = $derived(SCREENS.indexOf(getActiveScreen()));
  const indicatorY = $derived(8 + activeIndex * 56 + 14);
</script>

<nav class="nav-bar">
  <div class="nav-items">
    <!-- Sliding indicator -->
    <div class="nav-indicator" style:top="{indicatorY}px"></div>

    {#each SCREENS as screen}
      {@const isActive = getActiveScreen() === screen}
      {@const badge = getBadges()[screen]}
      {@const dot = getStatusDots()[screen]}
      <button
        class="nav-item"
        class:active={isActive}
        onclick={() => navigateTo(screen)}
        title={labels[screen]}
      >
        <div class="nav-icon">
          <Icon name={iconNames[screen]} size={20} />
          {#if badge > 0}
            <div class="nav-badge-wrap">
              <Badge count={badge} />
            </div>
          {/if}
          {#if dot}
            <div class="nav-dot-wrap">
              <StatusDot color={statusToColor(dot) as StatusColor} size={6} />
            </div>
          {/if}
        </div>
        <span class="nav-label">{labels[screen]}</span>
      </button>
    {/each}
  </div>
</nav>

<style>
  .nav-bar {
    width: var(--nav-width);
    min-width: var(--nav-width);
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg2);
    border-right: 1px solid var(--border);
    z-index: 10;
  }

  .nav-items {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 8px 0;
    position: relative;
  }

  .nav-indicator {
    position: absolute;
    left: 0;
    width: 3px;
    height: 28px;
    background: var(--accent);
    border-radius: 0 3px 3px 0;
    transition: top 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 56px;
    gap: 4px;
    color: var(--fg3);
    transition:
      color var(--transition-fast),
      box-shadow var(--transition-fast);
    position: relative;
  }

  .nav-item:hover {
    color: var(--fg);
    box-shadow: inset 0 0 12px var(--accent-dim);
  }

  .nav-item.active {
    color: var(--accent);
  }

  .nav-icon {
    position: relative;
  }

  .nav-label {
    font-size: 9px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .nav-badge-wrap {
    position: absolute;
    top: -6px;
    right: -8px;
  }

  .nav-dot-wrap {
    position: absolute;
    bottom: -2px;
    right: -2px;
  }
</style>
