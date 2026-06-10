/**
 * Signal channel adapter wiring for gateway startup.
 * Handles signal-cli daemon lifecycle (TCP and Unix socket transports)
 * and Signal channel adapter connection.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import { createSignalChannel } from "../../../channels/signal/adapter.ts";
import {
  checkSignalCli,
  isDaemonHealthy,
  isDaemonRunning,
  isDaemonRunningUnix,
  startDaemon,
  startDaemonUnix,
  waitForDaemon,
  waitForDaemonUnix,
} from "../../../channels/signal/setup/setup.ts";
import type { DaemonHandle } from "../../../channels/signal/setup/setup.ts";
import type { ChannelWiringDeps } from "./channels_shared.ts";
import { resolveChannelClassification } from "./channels_shared.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("startup-channels-signal");

/** Signal channel config from triggerfish.yaml. */
export interface SignalChannelConfig {
  readonly endpoint?: string;
  readonly account?: string;
  readonly ownerPhone?: string;
  readonly pairing?: boolean;
  readonly pairing_classification?: string;
  readonly classification?: string;
  readonly defaultGroupMode?: string;
  readonly user_classifications?: Record<string, string>;
  readonly respond_to_unclassified?: boolean;
  readonly groups?: Record<string, { mode: string; classification?: string }>;
}

/** Mutable handle for the spawned signal-cli daemon child. */
export interface SignalDaemonState {
  handle: DaemonHandle | null;
}

// ─── Daemon lifecycle ────────────────────────────────────────────────────────

/** Log daemon startup result (success or timeout with stderr). */
async function logDaemonStartResult(
  ready: boolean,
  handle: DaemonHandle,
  transport: string,
): Promise<void> {
  if (ready) {
    log.info(`signal-cli daemon started (${transport})`);
    const versionCheck = await checkSignalCli();
    if (versionCheck.ok) {
      log.info(`signal-cli version: ${versionCheck.value.version}`);
    }
  } else {
    const earlyErr = await handle.earlyStderr;
    if (earlyErr) log.error(`signal-cli early stderr: ${earlyErr}`);
    const stderr = await handle.stderrText();
    log.error(`signal-cli daemon (${transport}) not reachable within 60s`);
    if (stderr) log.error(`signal-cli stderr: ${stderr}`);
  }
}

/** Kill an unhealthy daemon process and wait briefly. */
async function killUnhealthyDaemon(state: SignalDaemonState): Promise<void> {
  log.warn(
    "signal-cli daemon is occupying the port but not responding to JSON-RPC",
  );
  if (state.handle) {
    try {
      state.handle.child.kill("SIGTERM");
    } catch { /* already dead */ }
    state.handle = null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Start signal-cli TCP daemon if not already running. */
async function ensureTcpDaemon(
  tcpHost: string,
  tcpPort: number,
  account: string,
  state: SignalDaemonState,
): Promise<void> {
  const running = await isDaemonRunning(tcpHost, tcpPort);
  const healthy = running ? await isDaemonHealthy(tcpHost, tcpPort) : false;
  if (running && healthy) return;

  if (running && !healthy) await killUnhealthyDaemon(state);

  log.info("signal-cli daemon not running, starting...");
  const cliCheck = await checkSignalCli();
  if (!cliCheck.ok) {
    log.error("signal-cli not found — cannot auto-start daemon");
    return;
  }

  const daemonResult = startDaemon(
    account,
    tcpHost,
    tcpPort,
    cliCheck.value.path,
    cliCheck.value.javaHome,
  );
  if (!daemonResult.ok) {
    log.error(`Failed to start signal-cli daemon: ${daemonResult.error}`);
    return;
  }

  state.handle = daemonResult.value;
  const ready = await waitForDaemon(tcpHost, tcpPort);
  await logDaemonStartResult(ready, daemonResult.value, "TCP");
}

/** Start signal-cli Unix socket daemon if not already running. */
async function ensureUnixDaemon(
  socketPath: string,
  account: string,
  state: SignalDaemonState,
): Promise<void> {
  const running = await isDaemonRunningUnix(socketPath);
  if (running) return;

  log.info("signal-cli daemon not running (Unix socket), starting...");
  const cliCheck = await checkSignalCli();
  if (!cliCheck.ok) {
    log.error("signal-cli not found — cannot auto-start daemon");
    return;
  }

  const daemonResult = startDaemonUnix(
    account,
    socketPath,
    cliCheck.value.path,
    cliCheck.value.javaHome,
  );
  if (!daemonResult.ok) {
    log.error(`Failed to start signal-cli daemon: ${daemonResult.error}`);
    return;
  }

  state.handle = daemonResult.value;
  const ready = await waitForDaemonUnix(socketPath);
  await logDaemonStartResult(ready, daemonResult.value, "Unix socket");
}

/** Parse endpoint and start the appropriate daemon transport. */
async function ensureSignalDaemon(
  endpoint: string,
  account: string,
  state: SignalDaemonState,
): Promise<void> {
  const tcpMatch = endpoint.match(/^tcp:\/\/([^:]+):(\d+)$/);
  const unixMatch = endpoint.match(/^unix:\/\/(.+)$/);
  if (tcpMatch) {
    await ensureTcpDaemon(
      tcpMatch[1],
      parseInt(tcpMatch[2], 10),
      account,
      state,
    );
  } else if (unixMatch) {
    await ensureUnixDaemon(unixMatch[1], account, state);
  }
}

// ─── Adapter wiring ──────────────────────────────────────────────────────────

/** Build Signal group configuration from raw config. */
function buildGroupConfig(signalConfig: SignalChannelConfig): {
  readonly groupMode: "always" | "mentioned-only" | "owner-only";
  readonly groups:
    | Record<
      string,
      {
        readonly mode: "always" | "mentioned-only" | "owner-only";
        readonly classification?: ClassificationLevel;
      }
    >
    | undefined;
} {
  const groupMode = (signalConfig.defaultGroupMode ?? "always") as
    | "always"
    | "mentioned-only"
    | "owner-only";
  const groups = signalConfig.groups as
    | Record<
      string,
      {
        readonly mode: "always" | "mentioned-only" | "owner-only";
        readonly classification?: ClassificationLevel;
      }
    >
    | undefined;
  return { groupMode, groups };
}

/** Register Signal notification channel for owner. */
function registerSignalNotifications(opts: {
  readonly deps: ChannelWiringDeps;
  readonly adapter: ReturnType<typeof createSignalChannel>;
  readonly ownerPhone: string | undefined;
  readonly classification: ClassificationLevel;
}): void {
  if (!opts.ownerPhone) return;

  opts.deps.notificationService.registerChannel({
    name: "signal",
    classification: opts.classification,
    send: (notifMsg) =>
      opts.adapter.send({
        content: notifMsg,
        sessionId: `signal-${opts.ownerPhone}`,
      }),
  });
}

/** Connect Signal adapter and register message handler + notifications. */
async function connectSignalAdapter(
  signalConfig: SignalChannelConfig,
  deps: ChannelWiringDeps,
  classification: ClassificationLevel,
): Promise<void> {
  const { chatSession, channelAdapters } = deps;
  const { groupMode, groups } = buildGroupConfig(signalConfig);

  const signalAdapter = createSignalChannel({
    endpoint: signalConfig.endpoint!,
    account: signalConfig.account!,
    ownerPhone: signalConfig.ownerPhone,
    classification,
    defaultGroupMode: groupMode,
    groups,
  });

  await chatSession.registerChannel("signal", {
    adapter: signalAdapter,
    channelName: "Signal",
    classification,
    userClassifications: signalConfig.user_classifications,
    respondToUnclassified: signalConfig.respond_to_unclassified,
    pairing: signalConfig.pairing,
    pairingClassification: resolveChannelClassification({
      channel: "signal",
      field: "pairing_classification",
      raw: signalConfig.pairing_classification,
      fallback: "INTERNAL",
    }),
  });

  signalAdapter.onMessage((msg) => {
    chatSession.handleChannelMessage(msg, "signal")
      .catch((err) => log.error("Signal handleChannelMessage failed", err));
  });

  registerSignalNotifications({
    deps,
    adapter: signalAdapter,
    ownerPhone: signalConfig.ownerPhone,
    classification,
  });

  await signalAdapter.connect();
  channelAdapters.set("signal", {
    adapter: signalAdapter,
    classification,
    name: "Signal",
  });
  log.info("Signal channel connected");
}

/**
 * Wire and connect Signal channel adapter (runs in background).
 *
 * Returns the mutable daemon state so the caller can kill the daemon on shutdown.
 */
export function wireSignalChannel(
  signalConfig: SignalChannelConfig,
  deps: ChannelWiringDeps,
): SignalDaemonState {
  const state: SignalDaemonState = { handle: null };
  if (!signalConfig.endpoint || !signalConfig.account) return state;

  const classification = resolveChannelClassification({
    channel: "signal",
    field: "classification",
    raw: signalConfig.classification,
    fallback: "PUBLIC",
  });
  log.info("Signal channel setup starting (background)...");

  (async () => {
    try {
      await ensureSignalDaemon(
        signalConfig.endpoint!,
        signalConfig.account!,
        state,
      );
      await connectSignalAdapter(signalConfig, deps, classification);
    } catch (err) {
      log.error(
        `Signal channel failed to connect: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();

  return state;
}
