/**
 * Gateway startup, wiring, and subsystem initialization.
 *
 * @module
 */

export { runStart, startGatewayServer } from "./startup.ts";
export { wireChannels } from "./channels/channels.ts";
export { wireMcpServers } from "./infra/mcp.ts";
export type { McpBroadcastRefs } from "./infra/mcp.ts";
export { buildObsidianExecutor, discoverSkills } from "./infra/subsystems.ts";
export { buildWebTools } from "./factory/web_tools.ts";
export { buildSubagentFactory } from "./factory/subagent.ts";
export { createOrchestratorFactory } from "./factory/orchestrator_factory.ts";
export { buildSchedulerConfig } from "./factory/scheduler_config.ts";
export { buildGoogleExecutor } from "./factory/google_executor.ts";
export { createConfigWatcher } from "./services/config_watcher.ts";
