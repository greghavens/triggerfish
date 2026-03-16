/**
 * Gateway startup — brings up the full Triggerfish runtime.
 *
 * Orchestrates the bootstrap, core infrastructure, tool infrastructure,
 * and service startup phases, then registers shutdown handlers and
 * keeps the process alive.
 *
 * @module
 */

import { bootstrapConfigAndLogging } from "./bootstrap.ts";
import { initializeCoreInfrastructure } from "./infra/core_infra.ts";
import { initializeToolInfrastructure } from "./tools/tool_infra.ts";
import { startServicesAndChannels } from "./service_startup.ts";
import { registerShutdownHandlers } from "./shutdown.ts";

/**
 * Start the gateway server with scheduler and persistent cron storage.
 */
export async function startGatewayServer(): Promise<void> {
  const bootstrap = await bootstrapConfigAndLogging();
  const coreInfra = await initializeCoreInfrastructure(bootstrap);
  const toolInfra = await initializeToolInfrastructure(bootstrap, coreInfra);
  coreInfra.deferredMemoryCheck.bind(toolInfra.memoryStore);
  const shutdownDeps = await startServicesAndChannels(
    bootstrap,
    coreInfra,
    toolInfra,
  );
  registerShutdownHandlers(shutdownDeps);
  // Keep running until interrupted
  await new Promise(() => {}); // Never resolves — signal handler calls Deno.exit()
}

/** @deprecated Use startGatewayServer instead */
export const runStart = startGatewayServer;
