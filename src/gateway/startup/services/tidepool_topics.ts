import type { ChatSession } from "../../chat_session_interface.ts";
/**
 * Tidepool topic handler registration and supporting providers.
 *
 * Wires screen-specific WebSocket topic handlers (logs, health,
 * agents, memory, settings) into the Tidepool host.
 *
 * @module
 */

import type { SentinelCoordinatorLookup } from "../../sentinel_case_manager.ts";
import {
  createTidepoolAgentsHandler,
  createTidepoolConfigHandler,
  createTidepoolHealthHandler,
  createTidepoolLogSink,
  createTidepoolMemoryHandler,
  createTidepoolWorkflowsHandler,
} from "../../../tools/tidepool/host/mod.ts";
import {
  createAgentsTopicDispatcher,
  createHealthTopicDispatcher,
  createLogsTopicDispatcher,
  createMemoryTopicDispatcher,
  createSettingsTopicDispatcher,
  createWorkflowsTopicDispatcher,
} from "../../../tools/tidepool/host/host_topic_dispatch.ts";
import {
  createWorkflowStore,
  parseWorkflowYaml,
} from "../../../workflow/mod.ts";
import type { SimplifiedTask } from "../../../tools/tidepool/host/host_workflows_types.ts";
import type { BootstrapResult } from "../bootstrap.ts";
import type { CoreInfraResult } from "../infra/core_infra.ts";
import type { ToolInfraResult } from "../tools/tool_infra.ts";
import type { startTidepoolHost } from "./chat_session.ts";
import { createTidepoolSentinelHandler } from "./tidepool_sentinel.ts";
import { createHealthSnapshotProvider } from "./tidepool_health.ts";
import { wireTidepoolLogSink } from "./tidepool_log_sink.ts";
import { buildAgentListDataAsync } from "./tidepool_agents.ts";

// Re-export for backward compatibility
export type { AgentListData } from "./tidepool_agents.ts";
export { buildAgentListDataAsync } from "./tidepool_agents.ts";

/** Register WebSocket topic handlers for all Tidepool screens. */
export function registerTidepoolTopicHandlers(
  tidepoolHost: Awaited<ReturnType<typeof startTidepoolHost>>,
  toolInfra: ToolInfraResult,
  bootstrap: BootstrapResult,
  coreInfra: CoreInfraResult,
  coordinatorState?: SentinelCoordinatorLookup,
  readDiscoverySource?: ChatSession["readSentinelDiscoverySource"],
  readTrafficDownloadPage?: ChatSession["readSentinelTrafficDownloadPage"],
): void {
  tidepoolHost.registerTopicHandler(
    "sentinel",
    createTidepoolSentinelHandler(
      bootstrap,
      coordinatorState,
      readDiscoverySource,
      readTrafficDownloadPage,
    ),
  );
  registerLogsHandler(tidepoolHost);
  registerHealthHandler(tidepoolHost, coreInfra, bootstrap);
  registerAgentsHandler(tidepoolHost, coreInfra, toolInfra);
  registerMemoryHandler(tidepoolHost, toolInfra);
  registerSettingsHandler(tidepoolHost, bootstrap);
  registerWorkflowsHandler(tidepoolHost, coreInfra, toolInfra);
}

/** Wire logs topic: create sink, register handler, pipe log file. */
function registerLogsHandler(
  tidepoolHost: Awaited<ReturnType<typeof startTidepoolHost>>,
): void {
  const logSink = createTidepoolLogSink();
  tidepoolHost.registerTopicHandler(
    "logs",
    createLogsTopicDispatcher(logSink),
  );
  tidepoolHost.registerSocketCleanup((socket) => logSink.unsubscribe(socket));
  wireTidepoolLogSink(logSink);
}

/** Wire health topic with snapshot provider. */
function registerHealthHandler(
  tidepoolHost: Awaited<ReturnType<typeof startTidepoolHost>>,
  coreInfra: CoreInfraResult,
  bootstrap: BootstrapResult,
): void {
  const healthHandler = createTidepoolHealthHandler();
  healthHandler.setSnapshotProvider(
    createHealthSnapshotProvider(coreInfra, bootstrap),
  );
  tidepoolHost.registerTopicHandler(
    "health",
    createHealthTopicDispatcher(healthHandler),
  );
  tidepoolHost.registerSocketCleanup((socket) =>
    healthHandler.unsubscribeLive(socket)
  );
}

/** Wire agents topic with session list provider. */
function registerAgentsHandler(
  tidepoolHost: Awaited<ReturnType<typeof startTidepoolHost>>,
  coreInfra: CoreInfraResult,
  toolInfra: ToolInfraResult,
): void {
  const agentsHandler = createTidepoolAgentsHandler();
  tidepoolHost.registerTopicHandler(
    "agents",
    createAgentsTopicDispatcher(
      agentsHandler,
      () => buildAgentListDataAsync(coreInfra, toolInfra),
    ),
  );
  tidepoolHost.registerSocketCleanup((socket) =>
    agentsHandler.removeSocket(socket)
  );
}

/** Wire memory topic if a store is available. */
function registerMemoryHandler(
  tidepoolHost: Awaited<ReturnType<typeof startTidepoolHost>>,
  toolInfra: ToolInfraResult,
): void {
  if (!toolInfra.memoryStore) return;
  const memoryHandler = createTidepoolMemoryHandler(
    toolInfra.memoryStore,
    toolInfra.memorySearchProvider,
  );
  tidepoolHost.registerTopicHandler(
    "memory",
    createMemoryTopicDispatcher(
      memoryHandler,
      () => toolInfra.state.session.taint,
    ),
  );
}

/** Wire settings topic with read-only config handler. */
function registerSettingsHandler(
  tidepoolHost: Awaited<ReturnType<typeof startTidepoolHost>>,
  bootstrap: BootstrapResult,
): void {
  const configHandler = createTidepoolConfigHandler(
    bootstrap.config as unknown as Record<string, unknown>,
  );
  tidepoolHost.registerTopicHandler(
    "settings",
    createSettingsTopicDispatcher(configHandler),
  );
}

/** Convert parsed workflow tasks to the simplified shape the UI needs. */
function buildSimplifiedTasks(yaml: string): SimplifiedTask[] {
  const parsed = parseWorkflowYaml(yaml);
  if (!parsed.ok) return [];
  return parsed.value.do.map((entry) => ({
    name: entry.name,
    type: entry.task.type,
    condition: entry.task.if,
    callType: entry.task.type === "call"
      ? (entry.task as { call: string }).call
      : undefined,
    flowDirective: typeof entry.task.then === "string"
      ? entry.task.then
      : undefined,
    metadata: entry.task.metadata
      ? { description: entry.task.metadata.description as string | undefined }
      : undefined,
  }));
}

/** Wire workflows topic with store, run registry, executor, and cron. */
function registerWorkflowsHandler(
  tidepoolHost: Awaited<ReturnType<typeof startTidepoolHost>>,
  coreInfra: CoreInfraResult,
  toolInfra: ToolInfraResult,
): void {
  const store = createWorkflowStore(coreInfra.storage);
  const handler = createTidepoolWorkflowsHandler(
    store,
    toolInfra.workflowRunRegistry,
    {
      workflowExecutor: toolInfra.toolExecutor,
      cronManager: coreInfra.cronManager,
      parseWorkflow: buildSimplifiedTasks,
    },
  );
  tidepoolHost.registerTopicHandler(
    "workflows",
    createWorkflowsTopicDispatcher(
      handler,
      () => toolInfra.state.session.taint,
      { sessionUserProvider: () => toolInfra.state.session.userId },
    ),
  );
  tidepoolHost.registerSocketCleanup((socket) => handler.removeSocket(socket));
}
