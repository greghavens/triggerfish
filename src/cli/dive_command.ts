/**
 * Dive wizard and patrol health-check CLI commands.
 *
 * Collects runtime state, runs health diagnostics, and drives
 * the first-run setup wizard.
 *
 * @module
 */

import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import { resolveBaseDir, resolveConfigPath } from "./config/paths.ts";
import { createPatrolCheck } from "../dive/patrol.ts";
import type { PatrolInput } from "../dive/patrol.ts";
import { runWizard } from "../dive/wizard/wizard.ts";
import { runWizardSelective } from "../dive/selective/wizard_selective.ts";
import { fetchDaemonStatus, installAndStartDaemon } from "./daemon/daemon.ts";
import { probeGateway } from "./platform.ts";

// ─── Patrol helpers ───────────────────────────────────────────────────────────

/**
 * Count configured channels from the config file.
 */
function countConfiguredChannels(): number {
  const configPath = resolveConfigPath();
  try {
    const raw = Deno.readTextFileSync(configPath);
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const channels = parsed?.channels;
    if (channels && typeof channels === "object" && channels !== null) {
      return Object.keys(channels).length;
    }
  } catch {
    // Config not found or invalid
  }
  return 0;
}

/**
 * Count installed skills in ~/.triggerfish/skills/.
 */
function countInstalledSkills(): number {
  const skillsDir = join(resolveBaseDir(), "skills");
  try {
    let count = 0;
    for (const entry of Deno.readDirSync(skillsDir)) {
      if (entry.isDirectory) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/** Collect real runtime state for patrol diagnostics. */
async function collectPatrolInput(): Promise<{
  readonly input: PatrolInput;
  readonly daemonStatus: Awaited<ReturnType<typeof fetchDaemonStatus>>;
}> {
  const daemonStatus = await fetchDaemonStatus();
  const gatewayAlive = daemonStatus.running ? await probeGateway() : false;
  return {
    input: {
      gatewayRunning: gatewayAlive,
      llmConnected: gatewayAlive,
      channelsActive: countConfiguredChannels(),
      policyRulesLoaded: gatewayAlive ? 4 : 0,
      skillsInstalled: countInstalledSkills(),
    },
    daemonStatus,
  };
}

/** Display patrol health check results to the console. */
function displayPatrolReport(
  report: {
    overall: string;
    checks: readonly { status: string; name: string; message: string }[];
  },
  daemonStatus: { running: boolean; pid?: number; uptime?: string },
): void {
  if (daemonStatus.running) {
    console.log(`  Daemon: running (PID ${daemonStatus.pid ?? "?"})`);
    if (daemonStatus.uptime) console.log(`  Since:  ${daemonStatus.uptime}`);
  }
  console.log("");
  console.log(`Overall Status: ${report.overall}\n`);
  console.log("Health Checks:");
  for (const check of report.checks) {
    const icon = check.status === "HEALTHY"
      ? "✓"
      : check.status === "WARNING"
      ? "⚠"
      : "✗";
    console.log(`  ${icon} ${check.name}: ${check.message}`);
  }
  console.log();
  if (report.overall === "CRITICAL") {
    console.log(
      "❌ Critical issues detected. Run 'triggerfish start' to launch the gateway.\n",
    );
    Deno.exit(1);
  } else if (report.overall === "WARNING") {
    console.log("⚠️  Warnings detected. Check configuration.\n");
  } else {
    console.log("✅ All systems healthy.\n");
  }
}

// ─── Public commands ──────────────────────────────────────────────────────────

/**
 * Run patrol health diagnostics using real runtime state.
 */
export async function launchPatrolDiagnostics(): Promise<void> {
  console.log("🔍 Running Triggerfish health diagnostics...\n");
  const { input, daemonStatus } = await collectPatrolInput();
  const checker = createPatrolCheck(input);
  const report = await checker.runHealthChecks();
  displayPatrolReport(report, daemonStatus);
}

/** Start the daemon after the dive wizard completes. */
async function startDaemonAfterDive(): Promise<void> {
  const result = await installAndStartDaemon(Deno.execPath());
  if (result.ok) {
    console.log("✓ Daemon installed and started");
  } else {
    console.log(`✗ ${result.message}`);
    Deno.exit(1);
  }
}

/** Show a message that config already exists. */
function showConfigExistsMessage(configPath: string): void {
  console.log("");
  console.log("  Configuration already exists at:", configPath);
  console.log("  Run 'triggerfish start' to launch the gateway.");
  console.log("  Run 'triggerfish dive --force' to re-run the wizard.");
  console.log("");
}

/**
 * Run the dive setup wizard.
 *
 * Returns true if the wizard requested daemon installation,
 * false otherwise. Exits with code 0 on success, 1 on error.
 */
export async function launchDiveWizard(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const baseDir = resolveBaseDir();
  const configPath = resolveConfigPath(baseDir);

  // Check if config already exists
  let configExists = false;
  try {
    await Deno.stat(configPath);
    configExists = true;
  } catch {
    // Config doesn't exist
  }

  if (configExists && flags["force"] !== true) {
    showConfigExistsMessage(configPath);
    return;
  }

  // --force with existing config: let user pick which sections to update
  // No existing config: run the full wizard from scratch
  const result = configExists
    ? await runWizardSelective(baseDir)
    : await runWizard(baseDir);

  // If called with --install-daemon (from install script), auto-start daemon
  if (result.installDaemon && flags["install-daemon"] === true) {
    await startDaemonAfterDive();
  } else if (result.installDaemon) {
    // User said yes to daemon but not called from installer — tell them how
    console.log("  Run 'triggerfish start' to install the daemon.");
    console.log("");
  }
}

/** @deprecated Use launchPatrolDiagnostics instead */
export const runPatrol = launchPatrolDiagnostics;

/** @deprecated Use launchDiveWizard instead */
export const runDive = launchDiveWizard;
