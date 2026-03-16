/**
 * Signal device linking and daemon lifecycle prompts.
 *
 * Handles QR-code-based device linking, daemon startup, and readiness checks.
 * @module
 */

import { Confirm, Select } from "@cliffy/prompt";
import {
  isDaemonRunning,
  renderQrCode,
  startDaemon,
  startLinkProcess,
  waitForDaemon,
} from "../../../channels/signal/setup/setup.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import type { SignalCliBinary } from "./prompt_signal_binary.ts";

const log = createLogger("cli.signal");

const SIGNAL_TCP_HOST = "localhost";
const SIGNAL_TCP_PORT = 7583;

export { SIGNAL_TCP_HOST, SIGNAL_TCP_PORT };

/** Initiate the link process and display the QR code. */
async function initiateDeviceLink(
  binary: SignalCliBinary,
): Promise<
  { uri: string; process: { status: Promise<{ success: boolean }> } }
> {
  const linkResult = await startLinkProcess(
    "Triggerfish",
    binary.path,
    binary.javaHome,
  );

  if (!linkResult.ok) {
    log.error("Signal device link failed", {
      operation: "initiateDeviceLink",
      err: linkResult.error,
      manualCommand: `${binary.path} link -n Triggerfish`,
    });
    Deno.exit(1);
  }

  await renderQrCode(linkResult.value.uri);
  log.info("QR code displayed, waiting for Signal device link", {
    operation: "initiateDeviceLink",
  });
  return linkResult.value;
}

/** Run the device-link flow: display QR code and wait for completion. */
async function linkSignalDevice(binary: SignalCliBinary): Promise<void> {
  log.info("Starting Signal device link", { operation: "linkSignalDevice" });

  const link = await initiateDeviceLink(binary);
  const linkStatus = await link.process.status;
  if (!linkStatus.success) {
    log.error("Signal device linking process exited with failure", {
      operation: "linkSignalDevice",
    });
    Deno.exit(1);
  }
  log.info("Signal device linked successfully", {
    operation: "linkSignalDevice",
  });
}

/** Prompt for device setup mode and run linking if selected. */
export async function promptDeviceSetup(
  binary: SignalCliBinary,
): Promise<void> {
  const setupMode = await Select.prompt({
    message: "Device setup",
    options: [
      {
        name: "Link to existing Signal account (scan QR with phone)",
        value: "link",
      },
      { name: "Already linked / manual setup", value: "skip" },
    ],
    default: "link",
  });

  if (setupMode === "link") {
    await linkSignalDevice(binary);
  }
}

/** Print instructions for manually starting the daemon. */
function printManualDaemonInstructions(
  account: string,
  binaryPath: string,
): void {
  log.info("Signal daemon manual start instructions", {
    operation: "printManualDaemonInstructions",
    command:
      `${binaryPath} -a ${account} daemon --tcp ${SIGNAL_TCP_HOST}:${SIGNAL_TCP_PORT}`,
  });
}

/** Print a daemon start failure message with manual command hint. */
function printDaemonStartError(
  error: string,
  account: string,
  binaryPath: string,
): void {
  log.error("Signal daemon start failed", {
    operation: "startSignalDaemon",
    err: error,
    manualCommand: `${binaryPath} -a ${account} daemon --tcp localhost:7583`,
  });
}

/** Report daemon startup failure with stderr output. */
async function reportDaemonStartupFailure(
  daemonHandle: { stderrText: () => Promise<string> },
  account: string,
  binaryPath: string,
): Promise<void> {
  const stderr = await daemonHandle.stderrText();
  log.warn(
    "Signal daemon started but not reachable, may still be initializing",
    {
      operation: "reportDaemonStartupFailure",
      stderr: stderr || "(empty)",
      manualCommand: `${binaryPath} -a ${account} daemon --tcp localhost:7583`,
    },
  );
}

/** Spawn the signal-cli daemon process and verify readiness. */
async function spawnSignalDaemon(
  account: string,
  binary: SignalCliBinary,
): Promise<void> {
  log.info("Starting signal-cli daemon", { operation: "spawnSignalDaemon" });
  const daemonResult = startDaemon(
    account,
    SIGNAL_TCP_HOST,
    SIGNAL_TCP_PORT,
    binary.path,
    binary.javaHome,
  );

  if (!daemonResult.ok) {
    printDaemonStartError(daemonResult.error, account, binary.path);
    return;
  }

  const ready = await waitForDaemon(SIGNAL_TCP_HOST, SIGNAL_TCP_PORT);
  if (ready) {
    log.info("Signal daemon is running", { operation: "spawnSignalDaemon" });
    return;
  }

  await reportDaemonStartupFailure(daemonResult.value, account, binary.path);
}

/** Start the signal-cli daemon or report that it is already running. */
export async function ensureSignalDaemon(
  account: string,
  binary: SignalCliBinary,
): Promise<void> {
  const alreadyRunning = await isDaemonRunning(
    SIGNAL_TCP_HOST,
    SIGNAL_TCP_PORT,
  );
  if (alreadyRunning) {
    log.info("Signal daemon already running", {
      operation: "ensureSignalDaemon",
      host: SIGNAL_TCP_HOST,
      port: SIGNAL_TCP_PORT,
    });
    return;
  }

  const startIt = await Confirm.prompt({
    message:
      `Start signal-cli daemon on tcp://${SIGNAL_TCP_HOST}:${SIGNAL_TCP_PORT}?`,
    default: true,
  });

  if (!startIt) {
    printManualDaemonInstructions(account, binary.path);
    return;
  }

  await spawnSignalDaemon(account, binary);
}
