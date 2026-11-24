<script lang="ts">
  import Nav from "./Nav.svelte";
  import ChatScreen from "./screens/Chat/ChatScreen.svelte";
  import AgentsScreen from "./screens/Agents/AgentsScreen.svelte";
  import SentinelScreen from "./screens/Sentinel/SentinelScreen.svelte";
  import WorkflowsScreen from "./screens/Workflows/WorkflowsScreen.svelte";
  import HealthScreen from "./screens/Health/HealthScreen.svelte";
  import SettingsScreen from "./screens/Settings/SettingsScreen.svelte";
  import LogsScreen from "./screens/Logs/LogsScreen.svelte";
  import MemoryScreen from "./screens/Memory/MemoryScreen.svelte";
  import SecretPromptModal from "./SecretPromptModal.svelte";
  import CredentialPromptModal from "./CredentialPromptModal.svelte";
  import TriggerPromptModal from "./TriggerPromptModal.svelte";
  import ConfirmPromptModal from "./ConfirmPromptModal.svelte";
  import { getActiveScreen } from "./lib/stores/nav.svelte.js";
  import { getModalKind } from "./lib/stores/modal.svelte.js";

  const screen = $derived(getActiveScreen());
  const modal = $derived(getModalKind());
</script>

<Nav />

<main class="screens">
  {#if screen === "chat"}
    <ChatScreen />
  {:else if screen === "agents"}
    <AgentsScreen />
  {:else if screen === "sentinel"}
    <SentinelScreen />
  {:else if screen === "workflows"}
    <WorkflowsScreen />
  {:else if screen === "health"}
    <HealthScreen />
  {:else if screen === "settings"}
    <SettingsScreen />
  {:else if screen === "logs"}
    <LogsScreen />
  {:else if screen === "memory"}
    <MemoryScreen />
  {/if}
</main>

{#if modal === "secret"}
  <SecretPromptModal />
{:else if modal === "credential"}
  <CredentialPromptModal />
{:else if modal === "trigger"}
  <TriggerPromptModal />
{:else if modal === "confirm"}
  <ConfirmPromptModal />
{/if}

<style>
  .screens {
    flex: 1;
    position: relative;
    overflow: hidden;
  }
</style>
