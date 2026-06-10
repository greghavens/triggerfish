/**
 * Daemon connection setup for the CLI chat REPL.
 *
 * Loads configuration, opens the gateway WebSocket, and waits for
 * the daemon's "connected" event before handing off to the REPL loop.
 *
 * @module
 */

import { join } from "@std/path";
import type { Logger } from "../../core/logger/logger.ts";
import { loadConfig } from "../../core/config.ts";
import type { TriggerFishConfig } from "../../core/config.ts";
import {
  readGatewayToken,
  resolveBaseDir,
  resolveConfigPath,
} from "../../cli/config/paths.ts";
import { createWsMessageRouter } from "./chat_ws_router.ts";
import type { WsRouterDeps } from "./chat_ws_types.ts";

/** Load config and prepare the data directory. Returns config and dataDir. */
export async function loadChatConfig(): Promise<{
  readonly config: TriggerFishConfig;
  readonly dataDir: string;
}> {
  const configPath = resolveConfigPath();
  const configResult = loadConfig(configPath);
  if (!configResult.ok) {
    console.log(`Configuration error: ${configResult.error}`);
    console.log("Run 'triggerfish dive' to fix your configuration.\n");
    Deno.exit(1);
  }
  const baseDir = resolveBaseDir();
  const dataDir = join(baseDir, "data");
  await Deno.mkdir(dataDir, { recursive: true });
  return { config: configResult.value, dataDir };
}

/** Open a WebSocket to the gateway chat endpoint, authenticated by token. */
export function openChatWebSocket(log: Logger): WebSocket {
  const token = readGatewayToken();
  const base = "ws://127.0.0.1:18789/chat";
  const gatewayUrl = token
    ? `${base}?token=${encodeURIComponent(token)}`
    : base;
  try {
    return new WebSocket(gatewayUrl);
  } catch {
    log.debug("WebSocket construction failed for gateway chat");
    console.log("Cannot connect to daemon. Is it running?");
    console.log("Run 'triggerfish start' or 'triggerfish run' first.\n");
    Deno.exit(1);
    // Unreachable, but satisfies return type
    throw new Error("WebSocket connection failed");
  }
}

/** Install WS event listeners and wait for the "connected" event. */
export async function awaitDaemonConnection(
  routerDeps: Omit<WsRouterDeps, "resolveConnected">,
): Promise<void> {
  const connected = Promise.withResolvers<void>();

  routerDeps.ws.addEventListener("error", () => {
    console.log("Cannot connect to daemon. Is it running?");
    console.log("Run 'triggerfish start' or 'triggerfish run' first.\n");
    Deno.exit(1);
  });
  routerDeps.ws.addEventListener("open", () => {});

  const wsRouter = createWsMessageRouter({
    ...routerDeps,
    resolveConnected: () => connected.resolve(),
  });
  routerDeps.ws.addEventListener("message", wsRouter);

  installWsCloseHandler(routerDeps);

  const timeout = setTimeout(() => {
    console.log("Timed out waiting for daemon. Is it running?");
    console.log("Run 'triggerfish start' or 'triggerfish run' first.\n");
    routerDeps.ws.close();
    Deno.exit(1);
  }, 5000);
  await connected.promise;
  clearTimeout(timeout);
}

/** Handle WebSocket close by showing a disconnect message. */
function installWsCloseHandler(
  routerDeps: Omit<WsRouterDeps, "resolveConnected">,
): void {
  const { ws, isTty, screen, state } = routerDeps;
  ws.addEventListener("close", () => {
    if (isTty) {
      screen.writeOutput("  \x1b[31mDisconnected from daemon.\x1b[0m");
      screen.writeOutput("");
      screen.redrawInput(routerDeps.getEditor());
    } else {
      console.log("\n  Disconnected from daemon.\n");
    }
    state.isProcessing = false;
  });
}
