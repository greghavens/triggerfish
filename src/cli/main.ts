/**
 * CLI entry point and command router for Triggerfish.
 *
 * Parses command-line arguments, loads configuration from YAML,
 * and validates config structure.
 * @module
 */

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { Confirm, Input, Select } from "@cliffy/prompt";
import { join } from "@std/path";
import {
  backupConfig,
  expandTilde,
  resolveBaseDir,
  resolveConfigPath,
} from "./paths.ts";
import { isDockerEnvironment } from "../core/env.ts";
import { createGatewayServer } from "../gateway/server.ts";
import {
  createSessionToolExecutor,
  getSessionToolDefinitions,
  SESSION_TOOLS_SYSTEM_PROMPT,
} from "../gateway/tools.ts";
import type { RegisteredChannel } from "../gateway/tools.ts";
import { createEnhancedSessionManager } from "../gateway/sessions.ts";
import type { EnhancedSessionManager } from "../gateway/sessions.ts";
import { createSessionManager } from "../core/session/manager.ts";
import { buildSendEvent, createChatSession } from "../gateway/chat.ts";
import type { ChatEvent } from "../gateway/chat.ts";
import { createA2UIHost } from "../tidepool/host.ts";
import {
  createTidepoolToolExecutor,
  createTidePoolTools,
  getTidepoolToolDefinitions,
  TIDEPOOL_SYSTEM_PROMPT,
} from "../tidepool/mod.ts";
import { createPatrolCheck } from "../dive/patrol.ts";
import type { PatrolInput } from "../dive/patrol.ts";
import { runWizard, runWizardSelective } from "../dive/wizard.ts";
import {
  cleanupOldBinary,
  getDaemonStatus,
  installAndStartDaemon,
  stopDaemon,
  tailLogs,
  updateTriggerfish,
} from "./daemon.ts";
import { VERSION } from "./version.ts";
import {
  buildToolClassifications,
  createOrchestrator,
} from "../agent/orchestrator.ts";
import type {
  OrchestratorEvent,
  ToolDefinition,
  ToolExecutor,
} from "../agent/orchestrator.ts";
import { createProviderRegistry } from "../agent/llm.ts";
import type { LlmProviderRegistry } from "../agent/llm.ts";
import {
  loadProvidersFromConfig,
  resolveVisionProvider,
} from "../agent/providers/config.ts";
import type { ModelsConfig } from "../agent/providers/config.ts";
import { createPolicyEngine } from "../core/policy/engine.ts";
import { createDefaultRules, createHookRunner } from "../core/policy/hooks.ts";
import { createSession, updateTaint } from "../core/types/session.ts";
import type { ChannelId, SessionId, UserId } from "../core/types/session.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import { createWorkspace } from "../exec/workspace.ts";
import { createExecTools } from "../exec/tools.ts";
import {
  CLAUDE_SESSION_SYSTEM_PROMPT,
  createClaudeSessionManager,
  createClaudeToolExecutor,
  getClaudeToolDefinitions,
} from "../exec/claude.ts";
import { createPathClassifier } from "../core/security/path_classification.ts";
import { createToolFloorRegistry } from "../core/security/tool_floors.ts";
import {
  createEventHandler,
  createScreenEventHandler,
  formatBanner,
  formatError,
  printBanner,
  renderError,
  renderPrompt,
} from "./chat_ui.ts";
import type { ToolDisplayMode } from "./chat_ui.ts";
import {
  createKeypressReader,
  createLineEditor,
  createSuggestionEngine,
} from "./terminal.ts";
import type { LineEditor } from "./terminal.ts";
import { loadInputHistory, saveInputHistory } from "./history.ts";
import { createScreenManager, taintColor } from "./screen.ts";
import { createSchedulerService } from "../scheduler/service.ts";
import { createTriggerStore } from "../scheduler/trigger_store.ts";
import type {
  OrchestratorFactory,
  SchedulerServiceConfig,
  WebhookSourceConfig,
} from "../scheduler/service.ts";
import { createPersistentCronManager } from "../scheduler/cron.ts";
import type { CronManager } from "../scheduler/cron.ts";
import type { StorageProvider } from "../core/storage/provider.ts";
import { createSqliteStorage } from "../core/storage/sqlite.ts";
import {
  createHealthcheckToolExecutor,
  createLlmTaskToolExecutor,
  createSummarizeToolExecutor,
  createTodoManager,
  createTodoToolExecutor,
  getHealthcheckToolDefinitions,
  getLlmTaskToolDefinitions,
  getSummarizeToolDefinitions,
  getTodoToolDefinitions,
  LLM_TASK_SYSTEM_PROMPT,
  SUMMARIZE_SYSTEM_PROMPT,
  TODO_SYSTEM_PROMPT,
} from "../tools/mod.ts";
import type { TodoManager } from "../tools/mod.ts";
import {
  createFts5SearchProvider,
  createMemoryStore,
  createMemoryToolExecutor,
  getMemoryToolDefinitions,
  MEMORY_SYSTEM_PROMPT,
} from "../memory/mod.ts";
import {
  createBraveSearchProvider,
  createCloudSearchProvider,
  createDomainPolicy,
  createDomainClassifier,
  createRateLimitedSearchProvider,
  createWebFetcher,
  createWebToolExecutor,
  getWebToolDefinitions,
  WEB_TOOLS_SYSTEM_PROMPT,
} from "../web/mod.ts";
import type {
  DomainClassifier,
  DomainSecurityConfig,
  SearchProvider,
  WebFetcher,
} from "../web/mod.ts";
import { createPlanManager, createPlanToolExecutor } from "../agent/plan.ts";
import {
  getPlanToolDefinitions,
  PLAN_SYSTEM_PROMPT,
} from "../agent/plan_tools.ts";
import {
  createAutoLaunchBrowserExecutor,
  createBrowserManager,
  createDomainPolicy as createBrowserDomainPolicy,
  getBrowserToolDefinitions,
} from "../browser/mod.ts";
import {
  createDailyNoteManager,
  createLinkResolver,
  createNoteStore,
  createObsidianToolExecutor,
  createVaultContext,
  getObsidianToolDefinitions,
} from "../obsidian/mod.ts";
import {
  createImageToolExecutor,
  getImageToolDefinitions,
  IMAGE_TOOLS_SYSTEM_PROMPT,
} from "../image/mod.ts";
import { imageBlock, readClipboardImage } from "../image/mod.ts";
import type {
  ContentBlock,
  ImageContentBlock,
  MessageContent,
} from "../image/mod.ts";
import {
  createExploreToolExecutor,
  EXPLORE_SYSTEM_PROMPT,
  getExploreToolDefinitions,
} from "../explore/mod.ts";
import {
  createCalendarService,
  createDriveService,
  createGmailService,
  createGoogleApiClient,
  createGoogleAuthManager,
  createGoogleToolExecutor,
  createSheetsService,
  createTasksService,
  getGoogleToolDefinitions,
} from "../google/mod.ts";
import type { GoogleAuthConfig } from "../google/mod.ts";
import {
  createGitHubClient,
  createGitHubToolExecutor,
  getGitHubToolDefinitions,
  resolveGitHubToken,
} from "../github/mod.ts";
import { createKeychain } from "../secrets/keychain.ts";
import { findSecretRefs, resolveConfigSecrets } from "../secrets/resolver.ts";
import {
  createSecretToolExecutor,
  getSecretToolDefinitions,
  SECRET_TOOLS_SYSTEM_PROMPT,
} from "../secrets/tools.ts";
import type { SecretPromptCallback } from "../secrets/tools.ts";
import {
  createMcpServerManager,
  createMcpExecutor,
  createMcpGateway,
  getMcpToolDefinitions,
  buildMcpToolClassifications,
  buildMcpSystemPrompt,
} from "../mcp/mod.ts";
import type { McpServerConfig } from "../mcp/mod.ts";
import { createTelegramChannel } from "../channels/telegram/adapter.ts";
import { createSignalChannel } from "../channels/signal/adapter.ts";
import { createPairingService } from "../channels/pairing.ts";
import {
  checkSignalCli,
  downloadSignalCli,
  fetchLatestVersion,
  isDaemonHealthy,
  isDaemonRunning,
  isDaemonRunningUnix,
  renderQrCode,
  startDaemon,
  startDaemonUnix,
  startLinkProcess,
  waitForDaemon,
  waitForDaemonUnix,
} from "../channels/signal/setup.ts";
import type { DaemonHandle } from "../channels/signal/setup.ts";
import { createNotificationService } from "../gateway/notifications.ts";
import {
  createTriggerToolExecutor,
  getTriggerToolDefinitions,
  TRIGGER_TOOLS_SYSTEM_PROMPT,
} from "../gateway/trigger_tools.ts";
import { parseClassification } from "../core/types/classification.ts";
import { createSkillLoader } from "../skills/loader.ts";
import type { Skill } from "../skills/loader.ts";
import {
  buildSkillsSystemPrompt,
  buildTriggersSystemPrompt,
  createSkillToolExecutor,
  getSkillToolDefinitions,
} from "../skills/mod.ts";
import {
  createFileWriter,
  createLogger,
  initLogger,
  parseUserLogLevel,
  shutdownLogger,
  USER_LEVEL_MAP,
} from "../core/logger/mod.ts";
import { logDir as resolveLogDir } from "./daemon.ts";

/** Known CLI commands. */
const KNOWN_COMMANDS = new Set([
  "chat",
  "connect",
  "cron",
  "disconnect",
  "run",
  "start",
  "stop",
  "status",
  "logs",
  "config",
  "dive",
  "patrol",
  "update",
  "help",
  "version",
]);

/** Options that influence default command selection. */
export interface ParseOptions {
  readonly configExists?: boolean;
}

/** Result of parsing CLI arguments. */
export interface ParsedCommand {
  readonly command: string;
  readonly subcommand?: string;
  readonly flags: Readonly<Record<string, boolean | string>>;
}

/** Triggerfish YAML configuration shape. */
export interface TriggerFishConfig {
  readonly models: {
    readonly primary: { readonly provider: string; readonly model: string };
    readonly vision?: string;
    readonly providers: Readonly<
      Record<string, { readonly model: string; readonly apiKey?: string }>
    >;
  };
  readonly channels: Readonly<Record<string, unknown>>;
  readonly classification: {
    readonly mode: string;
  };
  readonly web?: {
    readonly search?: {
      readonly provider?: string;
      readonly api_key?: string;
      readonly max_results?: number;
      readonly safe_search?: string;
      readonly rate_limit?: number;
    };
    readonly fetch?: {
      readonly rate_limit?: number;
      readonly max_content_length?: number;
      readonly timeout?: number;
      readonly default_mode?: string;
    };
    readonly domains?: {
      readonly denylist?: readonly string[];
      readonly allowlist?: readonly string[];
      readonly classifications?: readonly {
        readonly pattern: string;
        readonly classification: string;
      }[];
    };
  };
  readonly google?: {
    readonly classification?: string;
  };
  readonly github?: {
    readonly token?: string;
    readonly base_url?: string;
    readonly classification?: string;
    readonly classification_overrides?: Readonly<Record<string, string>>;
  };
  readonly scheduler?: {
    readonly trigger?: {
      readonly enabled?: boolean;
      readonly interval_minutes?: number;
      readonly quiet_hours?: {
        readonly start?: number;
        readonly end?: number;
      };
    };
    readonly webhooks?: {
      readonly enabled?: boolean;
      readonly sources?: Readonly<
        Record<string, {
          readonly secret: string;
          readonly classification: string;
        }>
      >;
    };
  };
  readonly plugins?: {
    readonly obsidian?: {
      readonly enabled?: boolean;
      readonly vault_path?: string;
      readonly classification?: string;
      readonly daily_notes?: {
        readonly folder?: string;
        readonly date_format?: string;
        readonly template?: string;
      };
      readonly exclude_folders?: readonly string[];
      readonly folder_classifications?: Readonly<Record<string, string>>;
    };
  };
  readonly filesystem?: {
    readonly default?: string;
    readonly paths?: Readonly<Record<string, string>>;
  };
  readonly tools?: {
    readonly floors?: Readonly<Record<string, string>>;
  };
  readonly mcp_servers?: Readonly<Record<string, {
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly url?: string;
    readonly classification?: string;
    readonly enabled?: boolean;
  }>>;
  readonly logging?: {
    /** Log level: "quiet" | "normal" | "verbose" | "debug". Default: "normal". */
    readonly level?: string;
  };
  readonly debug?: boolean;
}

/** Success result. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failure result. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Discriminated union result type. */
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Parse CLI arguments into a structured command object.
 *
 * @param args - Raw command-line argument array (without the binary name).
 * @param options - Optional context influencing defaults.
 * @returns Parsed command with optional subcommand and flags.
 */
export function parseCommand(
  args: readonly string[],
  options: ParseOptions = {},
): ParsedCommand {
  const flags: Record<string, boolean | string> = {};

  // Handle special flags first
  if (args.includes("--version")) {
    return { command: "version", flags };
  }

  // Extract flags from args (supports --key and --key=value)
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  // No positional args
  if (positional.length === 0) {
    const configExists = options.configExists ?? true;
    return { command: configExists ? "help" : "dive", flags };
  }

  const command = positional[0];

  // Unknown command → help
  if (!KNOWN_COMMANDS.has(command)) {
    return { command: "help", flags };
  }

  // Commands with subcommands
  if (command === "config" && positional.length > 1) {
    const sub = positional[1];
    if (sub === "add-channel" && positional.length > 2) {
      flags["channel_type"] = positional[2];
    } else if (sub === "remove-channel" && positional.length > 2) {
      flags["channel_type"] = positional[2];
    } else if (sub === "add-plugin" && positional.length > 2) {
      flags["plugin_type"] = positional[2];
    } else if (sub === "set" && positional.length >= 4) {
      flags["config_key"] = positional[2];
      flags["config_value"] = positional.slice(3).join(" ");
    } else if (sub === "get" && positional.length >= 3) {
      flags["config_key"] = positional[2];
    } else if (sub === "set-secret" && positional.length >= 4) {
      flags["secret_key"] = positional[2];
      flags["secret_value"] = positional.slice(3).join(" ");
    } else if (sub === "get-secret" && positional.length >= 3) {
      flags["secret_key"] = positional[2];
    }
    return { command, subcommand: sub, flags };
  }
  if (command === "cron" && positional.length > 1) {
    // Capture remaining positional args as flags for cron subcommands
    const sub = positional[1];
    if (sub === "add" && positional.length >= 4) {
      flags["expression"] = positional[2];
      flags["task"] = positional.slice(3).join(" ");
    } else if (
      (sub === "delete" || sub === "history") && positional.length > 2
    ) {
      flags["job_id"] = positional[2];
    }
    return { command, subcommand: sub, flags };
  }
  if (
    (command === "connect" || command === "disconnect") && positional.length > 1
  ) {
    const sub = positional[1];
    return { command, subcommand: sub, flags };
  }

  return { command, flags };
}

/**
 * Load and parse a triggerfish YAML configuration file.
 *
 * @param path - Absolute path to the YAML file.
 * @returns Result with parsed config or error string.
 */
export function loadConfig(path: string): Result<TriggerFishConfig, string> {
  try {
    const raw = Deno.readTextFileSync(path);
    const parsed = parseYaml(raw);

    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, error: "Config file did not parse to an object" };
    }

    const validation = validateConfig(parsed as Record<string, unknown>);
    if (!validation.ok) {
      return validation as Err<string>;
    }

    return { ok: true, value: parsed as unknown as TriggerFishConfig };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to load config: ${message}` };
  }
}

/**
 * Validate a parsed config object has all required fields.
 *
 * @param obj - Parsed object to validate.
 * @returns Result indicating validity or the first validation error.
 */
export function validateConfig(
  obj: Record<string, unknown>,
): Result<void, string> {
  // models must exist and have a primary field
  if (typeof obj.models !== "object" || obj.models === null) {
    return { ok: false, error: "Missing required field: models" };
  }

  const models = obj.models as Record<string, unknown>;
  // Accept both legacy string format (primary: "model-name") and
  // structured format (primary: { provider: "...", model: "..." })
  if (typeof models.primary === "string") {
    // Legacy format — valid as long as it's non-empty
    if (models.primary.length === 0) {
      return { ok: false, error: "models.primary must not be empty" };
    }
  } else if (typeof models.primary === "object" && models.primary !== null) {
    const primary = models.primary as Record<string, unknown>;
    if (typeof primary.provider !== "string" || primary.provider.length === 0) {
      return {
        ok: false,
        error: "Missing required field: models.primary.provider",
      };
    }
    if (typeof primary.model !== "string" || primary.model.length === 0) {
      return {
        ok: false,
        error: "Missing required field: models.primary.model",
      };
    }
  } else {
    return {
      ok: false,
      error:
        "models.primary must be a string or object with provider and model",
    };
  }

  return { ok: true, value: undefined };
}

/**
 * Load and parse a triggerfish YAML configuration file, resolving all
 * `secret:<key>` references from the OS keychain.
 *
 * Unlike the synchronous `loadConfig()`, this function performs async
 * secret resolution after parsing the YAML. If any `secret:` reference
 * cannot be found in the keychain, the function returns an error rather
 * than starting with an empty or null value (fail-fast behavior).
 *
 * @param path - Absolute path to the YAML file.
 * @param store - Secret store to resolve `secret:` references from.
 * @returns Result with parsed and secret-resolved config, or error string.
 */
export async function loadConfigWithSecrets(
  path: string,
  store: import("../secrets/keychain.ts").SecretStore,
): Promise<Result<TriggerFishConfig, string>> {
  const raw = loadConfig(path);
  if (!raw.ok) {
    return raw;
  }

  const resolved = await resolveConfigSecrets(raw.value, store);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  // Re-validate after secret resolution (resolved values could affect structure)
  const validation = validateConfig(resolved.value as Record<string, unknown>);
  if (!validation.ok) {
    return validation as Err<string>;
  }

  return { ok: true, value: resolved.value as TriggerFishConfig };
}

/**
 * Display help text.
 */
function showHelp(): void {
  console.log(`
Triggerfish - Secure Multi-Channel AI Agent Platform

USAGE:
  triggerfish [command] [options]

COMMANDS:
  chat        Start an interactive chat session
  config      Manage configuration (add channels, etc.)
  connect     Connect an external service (e.g. Google)
  cron        Manage scheduled cron jobs
  disconnect  Disconnect an external service
  dive        First-run setup wizard (creates triggerfish.yaml)
  run         Run the gateway server in foreground
  start       Install and start the daemon
  stop        Stop the daemon
  status      Show daemon status
  logs        View daemon logs (--tail to follow)
  patrol      Run health diagnostics
  update      Pull latest code, recompile, and restart
  help        Show this help message
  version     Show version information

CONFIG SUBCOMMANDS:
  config set <key> <value>                 Set a config value (dotted YAML path)
  config get <key>                         Get a config value
  config validate                          Validate configuration
  config add-channel [type]                Add a channel (telegram, slack, discord, etc.)
  config add-plugin [name]                 Add a plugin (obsidian)
  config set-secret <key> <value>          Store a secret in OS keychain
  config get-secret <key>                  Retrieve a secret from OS keychain
  config migrate-secrets                   Migrate plaintext secrets to keychain

CRON SUBCOMMANDS:
  cron list                              List all cron jobs
  cron add "<schedule>" <task>           Create a new cron job
  cron delete <job_id>                   Delete a cron job
  cron history <job_id>                  Show execution history

INTEGRATIONS:
  connect google                         Authenticate with Google Workspace
  connect github                         Authenticate with GitHub
  disconnect google                      Remove Google authentication
  disconnect github                      Remove GitHub authentication

EXAMPLES:
  triggerfish chat                                  # Start chatting with your agent
  triggerfish cron add "0 9 * * *" morning briefing # Daily 9am task
  triggerfish cron list                             # Show all cron jobs
  triggerfish cron delete <uuid>                    # Remove a job
  triggerfish cron history <uuid>                   # View execution log
  triggerfish config set <key> <value>                  # Set any config value
  triggerfish config get <key>                          # Read any config value
  triggerfish config add-channel telegram              # Add Telegram channel
  triggerfish config add-channel                       # Interactive channel selection
  triggerfish config add-plugin obsidian              # Add Obsidian vault plugin
  triggerfish config add-plugin                       # Interactive plugin selection
  triggerfish dive                                  # Interactive setup
  triggerfish run                                   # Run gateway in foreground
  triggerfish start                                 # Install and start daemon
  triggerfish stop                                  # Stop the daemon
  triggerfish status                                # Check daemon status
  triggerfish logs --tail                           # Follow daemon logs
  triggerfish connect google                          # Link Google account
  triggerfish disconnect google                       # Remove Google account
  triggerfish patrol                                # Health check
  triggerfish update                                # Update to latest version

For more information, visit: https://trigger.fish/docs
`);
}

/**
 * Display version information.
 */
function showVersion(): void {
  console.log(`Triggerfish ${VERSION}`);
}

/**
 * Run the dive setup wizard.
 *
 * Returns true if the wizard requested daemon installation,
 * false otherwise. Exits with code 0 on success, 1 on error.
 */
async function runDive(
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
    console.log("");
    console.log("  Configuration already exists at:", configPath);
    console.log("  Run 'triggerfish start' to launch the gateway.");
    console.log("  Run 'triggerfish dive --force' to re-run the wizard.");
    console.log("");
    return;
  }

  // --force with existing config: let user pick which sections to update
  // No existing config: run the full wizard from scratch
  const result = configExists
    ? await runWizardSelective(baseDir)
    : await runWizard(baseDir);

  // If called with --install-daemon (from install script), auto-start daemon
  if (result.installDaemon && flags["install-daemon"] === true) {
    await runDaemonStart();
  } else if (result.installDaemon) {
    // User said yes to daemon but not called from installer — tell them how
    console.log("  Run 'triggerfish start' to install the daemon.");
    console.log("");
  }
}

/**
 * Probe the gateway HTTP endpoint to check if it's alive.
 */
async function probeGateway(port = 18789): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

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

/**
 * Run patrol health diagnostics using real runtime state.
 */
async function runPatrol(): Promise<void> {
  console.log("🔍 Running Triggerfish health diagnostics...\n");

  // Check real state
  const daemonStatus = await getDaemonStatus();
  const gatewayAlive = daemonStatus.running ? await probeGateway() : false;
  const channelCount = countConfiguredChannels();
  const skillCount = countInstalledSkills();

  // LLM is "connected" if gateway is alive (provider is loaded at startup)
  // A more thorough check would query the gateway, but this is good enough
  const llmConnected = gatewayAlive;

  const input: PatrolInput = {
    gatewayRunning: gatewayAlive,
    llmConnected,
    channelsActive: channelCount,
    policyRulesLoaded: gatewayAlive ? 4 : 0, // Fixed rules always loaded when running
    skillsInstalled: skillCount,
  };

  const checker = createPatrolCheck(input);
  const report = await checker.run();

  // Show daemon info
  if (daemonStatus.running) {
    console.log(`  Daemon: running (PID ${daemonStatus.pid ?? "?"})`);
    if (daemonStatus.uptime) {
      console.log(`  Since:  ${daemonStatus.uptime}`);
    }
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

/**
 * Build web search/fetch infrastructure from config.
 *
 * Returns a SearchProvider (if configured) and a WebFetcher.
 */
function buildWebTools(
  config: TriggerFishConfig,
): { searchProvider: SearchProvider | undefined; webFetcher: WebFetcher; domainClassifier: DomainClassifier } {
  const webConfig = config.web;

  // Build domain security config
  const domainSecConfig: DomainSecurityConfig = {
    allowlist: webConfig?.domains?.allowlist ?? [],
    denylist: webConfig?.domains?.denylist ?? [],
    classificationMap: (webConfig?.domains?.classifications ?? []).map((c) => ({
      pattern: c.pattern,
      classification: c.classification as ClassificationLevel,
    })),
  };

  const domainPolicy = createDomainPolicy(domainSecConfig);
  const domainClassifier = createDomainClassifier(domainPolicy);
  const webFetcher = createWebFetcher(domainPolicy);

  // Build search provider
  let searchProvider: SearchProvider | undefined;
  const searchConfig = webConfig?.search;

  if (config.models.primary.provider === "triggerfish") {
    // Triggerfish Cloud subscribers get search via the gateway
    const tfProviders = config.models.providers as Readonly<
      Record<string, { readonly gateway_url?: string; readonly licenseKey?: string }>
    >;
    const tfConfig = tfProviders["triggerfish"];
    if (tfConfig?.licenseKey) {
      const gatewayUrl = tfConfig.gateway_url ??
        Deno.env.get("TRIGGERFISH_GATEWAY_URL") ??
        "https://api.trigger.fish";
      searchProvider = createCloudSearchProvider({
        gatewayUrl,
        licenseKey: tfConfig.licenseKey,
      });
    }
  } else if (searchConfig?.provider === "brave" && searchConfig.api_key) {
    searchProvider = createBraveSearchProvider({
      apiKey: searchConfig.api_key,
    });
  } else if (searchConfig?.api_key) {
    // Default to Brave if an API key is provided without explicit provider
    searchProvider = createBraveSearchProvider({
      apiKey: searchConfig.api_key,
    });
  }

  if (searchProvider && searchConfig?.rate_limit) {
    searchProvider = createRateLimitedSearchProvider(
      searchProvider,
      searchConfig.rate_limit,
    );
  }

  return { searchProvider, webFetcher, domainClassifier };
}

/**
 * Build a subagent factory that uses OrchestratorFactory to spawn isolated agents.
 *
 * Each call creates a fresh orchestrator + session and processes the task prompt,
 * returning the agent's text response.
 */
function buildSubagentFactory(
  orchFactory: OrchestratorFactory,
): (task: string, tools?: string) => Promise<string> {
  return async (task: string, _tools?: string): Promise<string> => {
    const { orchestrator, session } = await orchFactory.create("subagent");
    const result = await orchestrator.processMessage({
      session,
      message: task,
      targetClassification: session.taint,
    });
    if (!result.ok) return `Sub-agent error: ${result.error}`;
    return result.value.response;
  };
}

/**
 * Create an OrchestratorFactory from config.
 *
 * The factory captures shared infrastructure (provider registry, policy
 * engine, hook runner, tool definitions) and creates a fresh workspace,
 * session, and orchestrator per call for execution isolation.
 */
function createOrchestratorFactory(
  config: TriggerFishConfig,
  baseDir: string,
  cronManager?: CronManager,
  storage?: StorageProvider,
  enhancedSessionManager?: EnhancedSessionManager,
  fsPathMap?: ReadonlyMap<string, ClassificationLevel>,
  fsDefault?: ClassificationLevel,
  schedulerToolFloorRegistry?: import("../core/security/tool_floors.ts").ToolFloorRegistry,
): OrchestratorFactory {
  const registry = createProviderRegistry();
  loadProvidersFromConfig(config.models as ModelsConfig, registry);
  const schedulerVisionProvider = resolveVisionProvider(
    config.models as ModelsConfig,
  );

  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) {
    engine.addRule(rule);
  }
  const hookRunner = createHookRunner(engine);

  const spinePath = join(baseDir, "SPINE.md");
  const toolDefs = getToolDefinitions();
  const { searchProvider, webFetcher, domainClassifier: schedulerDomainClassifier } = buildWebTools(config);
  const schedulerKeychain = createKeychain();

  // Shared by all scheduler orchestrators — same config-driven map
  const schedulerToolClassifications = buildToolClassifications(config);

  // Discover skills for scheduler agents (same directories as main session)
  const factoryBundledSkillsDir = join(
    import.meta.dirname ?? ".",
    "..",
    "..",
    "skills",
    "bundled",
  );
  const factoryManagedSkillsDir = join(baseDir, "skills");
  const factoryWorkspaceSkillsDir = join(
    baseDir,
    "workspaces",
    "main",
    "skills",
  );
  const factorySkillLoader = createSkillLoader({
    directories: [
      factoryBundledSkillsDir,
      factoryManagedSkillsDir,
      factoryWorkspaceSkillsDir,
    ],
    dirTypes: {
      [factoryBundledSkillsDir]: "bundled",
      [factoryManagedSkillsDir]: "managed",
      [factoryWorkspaceSkillsDir]: "workspace",
    },
  });
  let factorySkillsPrompt = "";
  // Discover is async — do it lazily on first create()
  let factorySkillsDiscovered = false;

  return {
    async create(channelId: string) {
      if (!factorySkillsDiscovered) {
        factorySkillsDiscovered = true;
        try {
          const skills = await factorySkillLoader.discover();
          factorySkillsPrompt = buildSkillsSystemPrompt(skills);
        } catch {
          // Non-fatal
        }
      }
      const agentId = `scheduler-${channelId}-${Date.now()}`;
      const workspace = await createWorkspace({
        agentId,
        basePath: join(baseDir, "workspaces"),
      });

      // Symlink SPINE.md into workspace so the agent can read AND edit its identity
      try {
        const workspaceSpine = join(workspace.path, "SPINE.md");
        try {
          await Deno.remove(workspaceSpine);
        } catch { /* doesn't exist yet */ }
        await Deno.symlink(spinePath, workspaceSpine);
      } catch {
        // SPINE.md may not exist yet — not fatal
      }

      const execTools = createExecTools(workspace);
      const todoManager = storage
        ? createTodoManager({ storage, agentId })
        : undefined;
      let session = createSession({
        userId: "owner" as UserId,
        channelId: channelId as ChannelId,
      });

      // Memory for scheduler agents (uses storage-backed store, no FTS5)
      let schedulerMemoryExecutor:
        | ((
          name: string,
          input: Record<string, unknown>,
        ) => Promise<string | null>)
        | undefined;
      if (storage) {
        const schedulerMemoryStore = createMemoryStore({ storage });
        schedulerMemoryExecutor = createMemoryToolExecutor({
          store: schedulerMemoryStore,
          agentId,
          sessionTaint: session.taint,
          sourceSessionId: session.id,
        });
      }

      // Plan manager for scheduler agents
      const planManager = createPlanManager({
        plansDir: `${workspace.path}/plans`,
      });
      const planExecutor = createPlanToolExecutor(planManager, session.id);

      // Session tools for scheduler agents (if session manager is available)
      const sessionExecutor = enhancedSessionManager
        ? createSessionToolExecutor({
          sessionManager: enhancedSessionManager,
          callerSessionId: session.id,
          callerTaint: session.taint,
        })
        : undefined;

      // GitHub tools for scheduler agents
      const schedulerGithubTokenResult = await resolveGitHubToken({
        secretStore: schedulerKeychain,
      });
      const schedulerGithubExecutor = createGitHubToolExecutor(
        schedulerGithubTokenResult.ok
          ? {
            client: createGitHubClient({
              token: schedulerGithubTokenResult.value,
              baseUrl: config.github?.base_url,
              classificationConfig: config.github?.classification_overrides
                ? {
                  overrides: config.github.classification_overrides as Readonly<
                    Record<string, ClassificationLevel>
                  >,
                }
                : undefined,
            }),
            sessionTaint: session.taint,
            sourceSessionId: session.id,
          }
          : undefined,
      );

      const toolExecutor = createToolExecutor({
        execTools,
        cronManager,
        todoManager,
        searchProvider,
        webFetcher,
        memoryExecutor: schedulerMemoryExecutor,
        planExecutor,
        sessionExecutor,
        googleExecutor: buildGoogleExecutor(session.taint, session.id),
        githubExecutor: schedulerGithubExecutor,
        llmTaskExecutor: registry
          ? createLlmTaskToolExecutor(registry)
          : undefined,
        summarizeExecutor: registry
          ? createSummarizeToolExecutor(registry)
          : undefined,
        healthcheckExecutor: createHealthcheckToolExecutor({
          providerRegistry: registry,
          storageProvider: storage,
          skillLoader: factorySkillLoader,
        }),
        skillExecutor: createSkillToolExecutor({ skillLoader: factorySkillLoader }),
        providerRegistry: registry,
      });
      // Build path classifier for scheduler workspace
      const schedulerPathClassifier = fsPathMap ? createPathClassifier(
        { paths: fsPathMap, defaultClassification: fsDefault ?? "CONFIDENTIAL" },
        {
          basePath: workspace.path,
          internalPath: workspace.internalPath,
          confidentialPath: workspace.confidentialPath,
          restrictedPath: workspace.restrictedPath,
        },
      ) : undefined;

      const orchestrator = createOrchestrator({
        hookRunner,
        providerRegistry: registry,
        spinePath,
        tools: toolDefs,
        toolExecutor,
        systemPromptSections: [
          TODO_SYSTEM_PROMPT,
          WEB_TOOLS_SYSTEM_PROMPT,
          MEMORY_SYSTEM_PROMPT,
          PLAN_SYSTEM_PROMPT,
          LLM_TASK_SYSTEM_PROMPT,
          SUMMARIZE_SYSTEM_PROMPT,
          factorySkillsPrompt,
        ],
        visionProvider: schedulerVisionProvider,
        toolClassifications: schedulerToolClassifications,
        getSessionTaint: () => session.taint,
        escalateTaint: (level: ClassificationLevel, reason: string) => {
          session = updateTaint(session, level, reason);
        },
        pathClassifier: schedulerPathClassifier,
        domainClassifier: schedulerDomainClassifier,
        toolFloorRegistry: schedulerToolFloorRegistry,
      });

      return { orchestrator, session };
    },
  };
}

/**
 * Build a SchedulerServiceConfig from the YAML config with defaults.
 */
function buildSchedulerConfig(
  config: TriggerFishConfig,
  baseDir: string,
  factory: OrchestratorFactory,
): SchedulerServiceConfig {
  const sched = config.scheduler;

  const sources: Record<string, WebhookSourceConfig> = {};
  if (sched?.webhooks?.sources) {
    for (const [id, src] of Object.entries(sched.webhooks.sources)) {
      sources[id] = {
        secret: src.secret,
        classification: src.classification as ClassificationLevel,
      };
    }
  }

  return {
    orchestratorFactory: factory,
    triggerMdPath: join(baseDir, "TRIGGER.md"),
    trigger: {
      enabled: sched?.trigger?.enabled ?? true,
      intervalMinutes: sched?.trigger?.interval_minutes ?? 30,
      quietHours: sched?.trigger?.quiet_hours
        ? {
          start: sched.trigger.quiet_hours.start ?? 22,
          end: sched.trigger.quiet_hours.end ?? 7,
        }
        : { start: 22, end: 7 },
      classificationCeiling: "INTERNAL" as ClassificationLevel,
    },
    webhooks: {
      enabled: sched?.webhooks?.enabled ?? false,
      sources,
    },
  };
}

/** Google OAuth2 scopes for all Workspace services. */
const GOOGLE_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
];

/**
 * Build Google Workspace tool executor.
 *
 * Creates the full auth → client → services → executor chain.
 * Auth failures are lazy — if tokens don't exist, the user gets a
 * clear error at tool-call time, not at startup.
 */
function buildGoogleExecutor(
  sessionTaint: ClassificationLevel,
  sourceSessionId: SessionId,
):
  | ((name: string, input: Record<string, unknown>) => Promise<string | null>)
  | undefined {
  try {
    const secretStore = createKeychain();
    const authManager = createGoogleAuthManager(secretStore);
    const apiClient = createGoogleApiClient(authManager);
    return createGoogleToolExecutor({
      gmail: createGmailService(apiClient),
      calendar: createCalendarService(apiClient),
      tasks: createTasksService(apiClient),
      drive: createDriveService(apiClient),
      sheets: createSheetsService(apiClient),
      sessionTaint,
      sourceSessionId,
    });
  } catch {
    return undefined;
  }
}

/**
 * Start the gateway server with scheduler and persistent cron storage.
 */
async function runStart(): Promise<void> {
  console.log("Starting Triggerfish gateway...\n");

  const baseDir = resolveBaseDir();
  const configPath = resolveConfigPath(baseDir);

  // Check if config exists
  try {
    await Deno.stat(configPath);
  } catch {
    if (isDockerEnvironment()) {
      console.error(`No configuration found at ${configPath}\n`);
      console.error("Option 1: Mount your config file:");
      console.error(
        "  docker run -v ./triggerfish.yaml:/data/triggerfish.yaml triggerfish/triggerfish\n",
      );
      console.error("Option 2: Run the setup wizard interactively:");
      console.error(
        "  docker run -it -v triggerfish-data:/data triggerfish/triggerfish dive\n",
      );
    } else {
      console.log("Configuration not found.");
      console.log("Run 'triggerfish dive' to set up your agent.\n");
    }
    Deno.exit(1);
  }

  // Create default directories on first run
  for (const sub of ["logs", "data", "skills"]) {
    await Deno.mkdir(join(baseDir, sub), { recursive: true });
  }
  if (isDockerEnvironment()) {
    await Deno.mkdir(join(baseDir, "workspace"), { recursive: true });
  }

  // Initialize structured logger early so we capture startup.
  // On Windows, when running as a service the C# wrapper already captures
  // stdout/stderr to triggerfish.log via a StreamWriter. Opening the same
  // file from Deno causes EBUSY (os error 32) because Windows file locks
  // are mandatory. Skip the FileWriter in that case — stderr output is
  // sufficient since the service wrapper redirects it to the log file.
  const isWindowsService = Deno.build.os === "windows" &&
    !Deno.stdout.isTerminal();
  const fileWriter = isWindowsService
    ? undefined
    : await createFileWriter({ logDir: resolveLogDir() });
  initLogger({ level: "INFO", fileWriter, console: true });
  let log = createLogger("main");

  // Load config and resolve secret references from OS keychain
  const keychainForConfig = createKeychain();
  const configResult = await loadConfigWithSecrets(configPath, keychainForConfig);
  if (!configResult.ok) {
    log.error("Failed to load configuration:", configResult.error);
    Deno.exit(1);
  }

  const config = configResult.value;

  // Re-initialize logger with YAML-configured level.
  // Priority: logging.level in triggerfish.yaml > TRIGGERFISH_DEBUG=1 compat > "normal"
  const debugCompat = Deno.env.get("TRIGGERFISH_DEBUG") === "1" ? "debug" : undefined;
  const userLevel = parseUserLogLevel(config.logging?.level ?? debugCompat ?? "normal");
  initLogger({
    level: USER_LEVEL_MAP[userLevel],
    fileWriter,
    console: true,
  });
  log = createLogger("main");
  log.info(`Configuration loaded (log_level=${userLevel})`);

  // Create persistent storage for cron jobs
  const dataDir = join(baseDir, "data");
  const storage = createSqliteStorage(join(dataDir, "triggerfish.db"));
  const pairingService = createPairingService(storage);
  const cronManager = await createPersistentCronManager(storage);

  const existingJobs = cronManager.list();
  if (existingJobs.length > 0) {
    log.info(`Loaded ${existingJobs.length} persistent cron job(s)`);
  }

  // Create session manager (shared by orchestrator factory, main session, and gateway)
  const baseSessionManager = createSessionManager(storage);
  const enhancedSessionManager = createEnhancedSessionManager(
    baseSessionManager,
  );

  // Notification service for scheduler output delivery
  const notificationService = createNotificationService(storage);

  // Trigger store for persisting trigger results (used by trigger_add_to_context tool)
  const triggerStore = createTriggerStore(storage);

  // Build filesystem security config (shared by factory and main session)
  const fsConfig = config.filesystem;
  const fsPathMap = new Map<string, ClassificationLevel>();
  if (fsConfig?.paths) {
    for (const [pattern, level] of Object.entries(fsConfig.paths)) {
      const parsed = parseClassification(level);
      if (parsed.ok) {
        fsPathMap.set(pattern, parsed.value);
      }
    }
  }
  let fsDefault: ClassificationLevel = "CONFIDENTIAL";
  if (fsConfig?.default) {
    const parsed = parseClassification(fsConfig.default);
    if (parsed.ok) {
      fsDefault = parsed.value;
    }
  }

  if (fsDefault === "PUBLIC") {
    log.warn("filesystem.default is set to PUBLIC — all unmapped paths are accessible at PUBLIC level");
  }

  // Build tool floor registry from enterprise overrides (shared by factory and main session)
  const toolFloorOverrides = new Map<string, ClassificationLevel>();
  if (config.tools?.floors) {
    for (const [tool, level] of Object.entries(config.tools.floors)) {
      const parsed = parseClassification(level);
      if (parsed.ok) {
        toolFloorOverrides.set(tool, parsed.value);
      }
    }
  }
  const toolFloorRegistry = createToolFloorRegistry(
    toolFloorOverrides.size > 0 ? toolFloorOverrides : undefined,
  );

  // Build orchestrator factory and scheduler with persistent cron manager
  const factory = createOrchestratorFactory(
    config,
    baseDir,
    cronManager,
    storage,
    enhancedSessionManager,
    fsPathMap,
    fsDefault,
    toolFloorRegistry,
  );
  const schedulerConfig = buildSchedulerConfig(config, baseDir, factory);
  const schedulerService = createSchedulerService({
    ...schedulerConfig,
    cronManager,
    notificationService,
    ownerId: "owner" as UserId,
    triggerStore,
  });

  // Create the main session orchestrator — this is the daemon-owned session
  const registry = createProviderRegistry();
  loadProvidersFromConfig(config.models as ModelsConfig, registry);

  if (!registry.getDefault()) {
    log.error("No LLM provider configured. Check triggerfish.yaml.");
    Deno.exit(1);
  }

  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) {
    engine.addRule(rule);
  }
  const hookRunner = createHookRunner(engine);

  const spinePath = join(baseDir, "SPINE.md");
  const mainWorkspace = await createWorkspace({
    agentId: "main-session",
    basePath: join(baseDir, "workspaces"),
  });

  // Symlink SPINE.md into workspace so the agent can read AND edit its identity
  try {
    const workspaceSpine = join(mainWorkspace.path, "SPINE.md");
    try {
      await Deno.remove(workspaceSpine);
    } catch { /* doesn't exist yet */ }
    await Deno.symlink(spinePath, workspaceSpine);
  } catch {
    // SPINE.md may not exist yet — not fatal
  }

  // Build path classifier for main workspace
  const pathClassifier = createPathClassifier(
    { paths: fsPathMap, defaultClassification: fsDefault },
    {
      basePath: mainWorkspace.path,
      internalPath: mainWorkspace.internalPath,
      confidentialPath: mainWorkspace.confidentialPath,
      restrictedPath: mainWorkspace.restrictedPath,
    },
  );

  const execTools = createExecTools(mainWorkspace);
  const todoManager = createTodoManager({ storage, agentId: "main-session" });
  const { searchProvider, webFetcher, domainClassifier } = buildWebTools(config);

  // Initialize memory system with FTS5 search
  const { Database } = await import("@db/sqlite");
  const memoryDb = new Database(join(dataDir, "triggerfish.db"));
  memoryDb.exec("PRAGMA journal_mode=WAL");
  const memorySearchProvider = createFts5SearchProvider(memoryDb);
  const memoryStore = createMemoryStore({
    storage,
    searchProvider: memorySearchProvider,
  });
  let session = createSession({
    userId: "owner" as UserId,
    channelId: "daemon" as ChannelId,
  });
  const memoryExecutor = createMemoryToolExecutor({
    store: memoryStore,
    searchProvider: memorySearchProvider,
    agentId: "main-session",
    sessionTaint: session.taint,
    sourceSessionId: session.id,
  });

  // Plan manager for main session
  const mainPlanManager = createPlanManager({
    plansDir: `${mainWorkspace.path}/plans`,
  });
  const mainPlanExecutor = createPlanToolExecutor(mainPlanManager, session.id);

  // Vision provider for image fallback and browser screenshots (optional)
  const visionProvider = resolveVisionProvider(config.models as ModelsConfig);

  // Browser tools — auto-launch Chrome on first browser_* call
  const browserDomainPolicy = createBrowserDomainPolicy({
    allowList: (config.web?.domains?.allowlist ?? []) as string[],
    denyList: (config.web?.domains?.denylist ?? []) as string[],
    classifications: Object.fromEntries(
      (config.web?.domains?.classifications ?? []).map((
        c,
      ) => [c.pattern, c.classification]),
    ),
  });
  const browserHandle = createAutoLaunchBrowserExecutor({
    manager: createBrowserManager({
      profileBaseDir: join(dataDir, "browser-profiles"),
      domainPolicy: browserDomainPolicy,
      storage,
      headless: false,
    }),
    agentId: "main-session",
    getSessionTaint: () => session.taint,
    visionProvider,
    primaryProvider: registry.getDefault(),
  });
  const browserExecutor = browserHandle.executor;

  // Tidepool tools (lazy getter — tools resolve after host creation)
  // deno-lint-ignore prefer-const
  let tidepoolTools: import("../tidepool/mod.ts").TidePoolTools | undefined;
  const tidepoolExecutor = createTidepoolToolExecutor(() => tidepoolTools);

  // Image analysis tools
  const imageExecutor = createImageToolExecutor(registry, visionProvider);

  // Channel adapter registry — populated below when channels are wired up.
  // Shared mutable Map so the session executor can see channels registered later.
  const channelAdapters = new Map<string, RegisteredChannel>();

  // Session management tools — uses shared EnhancedSessionManager created earlier
  const sessionExecutor = createSessionToolExecutor({
    sessionManager: enhancedSessionManager,
    callerSessionId: session.id,
    callerTaint: session.taint,
    getCallerTaint: () => session.taint,
    channels: channelAdapters,
    pairingService,
  });

  // Sub-agent factory — bridges OrchestratorFactory to the subagent tool
  const subagentFactory = buildSubagentFactory(factory);

  // Explore tool — uses subagent factory for parallel codebase exploration
  const exploreExecutor = createExploreToolExecutor(
    subagentFactory,
    async (prompt: string) => {
      const provider = registry.getDefault();
      if (!provider) return prompt;
      const result = await provider.complete(
        [{ role: "user", content: prompt }],
        [],
        {},
      );
      return result.content;
    },
  );

  // Integration/plugin/channel classification map. Built-in tools pass through.
  const toolClassifications = buildToolClassifications(config);

  // GitHub tools — resolve token from OS keychain
  const keychain = createKeychain();
  const githubTokenResult = await resolveGitHubToken({ secretStore: keychain });
  const githubExecutor = createGitHubToolExecutor(
    githubTokenResult.ok
      ? {
        client: createGitHubClient({
          token: githubTokenResult.value,
          baseUrl: config.github?.base_url,
          classificationConfig: config.github?.classification_overrides
            ? {
              overrides: config.github.classification_overrides as Readonly<
                Record<string, ClassificationLevel>
              >,
            }
            : undefined,
        }),
        sessionTaint: session.taint,
        sourceSessionId: session.id,
      }
      : undefined,
  );
  // GitHub classification is set by buildToolClassifications from config

  // Obsidian vault tools (graceful degrade if not configured)
  let obsidianExecutor:
    | ((name: string, input: Record<string, unknown>) => Promise<string | null>)
    | undefined;
  const obsVaultPath = config.plugins?.obsidian?.vault_path;
  if (config.plugins?.obsidian?.enabled && obsVaultPath) {
    const obsCfg = config.plugins.obsidian;
    const vaultResult = await createVaultContext({
      vaultPath: obsVaultPath,
      classification:
        (obsCfg.classification ?? "INTERNAL") as ClassificationLevel,
      dailyNotes: obsCfg.daily_notes
        ? {
          folder: obsCfg.daily_notes.folder ?? "daily",
          dateFormat: obsCfg.daily_notes.date_format ?? "YYYY-MM-DD",
          template: obsCfg.daily_notes.template,
        }
        : undefined,
      excludeFolders: obsCfg.exclude_folders as string[] | undefined,
      folderClassifications: obsCfg.folder_classifications as
        | Record<string, ClassificationLevel>
        | undefined,
    });
    if (vaultResult.ok) {
      const noteStore = createNoteStore(vaultResult.value);
      obsidianExecutor = createObsidianToolExecutor({
        vaultContext: vaultResult.value,
        noteStore,
        dailyNoteManager: createDailyNoteManager(vaultResult.value, noteStore),
        linkResolver: createLinkResolver(vaultResult.value),
        getSessionTaint: () => session.taint,
        sessionId: session.id,
      });
      // Obsidian classification is set by buildToolClassifications from config
      log.info(`Obsidian vault connected: ${obsCfg.vault_path}`);
    } else {
      log.error(`Obsidian vault error: ${vaultResult.error}`);
    }
  }

  // --- MCP server wiring ---
  // MCP servers are connected in the background (non-blocking). Tools are injected
  // dynamically as servers come online. The daemon and chat session start immediately
  // without waiting for MCP servers to be available.
  const mcpManager = createMcpServerManager();
  let mcpExecutor:
    | ((name: string, input: Record<string, unknown>) => Promise<string | null>)
    | undefined;

  if (config.mcp_servers && Object.keys(config.mcp_servers).length > 0) {
    const mcpConfigs: McpServerConfig[] = [];
    for (const [id, serverCfg] of Object.entries(config.mcp_servers)) {
      let classification: ClassificationLevel | undefined;
      if (serverCfg.classification) {
        const parsed = parseClassification(serverCfg.classification);
        if (parsed.ok) classification = parsed.value;
      }
      mcpConfigs.push({
        id,
        command: serverCfg.command,
        args: serverCfg.args,
        env: serverCfg.env,
        url: serverCfg.url,
        classification,
        enabled: serverCfg.enabled,
      });
    }

    // Create MCP gateway for policy enforcement (always, regardless of connectivity)
    const mcpGateway = createMcpGateway({ hookRunner });

    // Create MCP executor with live getter — picks up newly connected servers automatically
    mcpExecutor = createMcpExecutor({
      gateway: mcpGateway,
      getServers: () => mcpManager.getConnected(),
      getSession: () => session,
    });

    // Register a status change callback that:
    // 1. Re-registers newly connected servers with the gateway
    // 2. Updates tool classifications live
    // 3. Broadcasts MCP status to CLI and Tidepool clients
    mcpManager.onStatusChange((statuses) => {
      // Re-register all currently connected servers with the gateway
      for (const status of statuses) {
        if (status.state === "connected" && status.server) {
          mcpGateway.registerServer({
            uri: `mcp://${status.server.id}`,
            name: status.server.id,
            status: status.server.classification ? "CLASSIFIED" : "UNTRUSTED",
            classification: status.server.classification,
          });
        }
      }

      // Rebuild MCP tool classifications into the main map
      const connectedServers = statuses
        .filter((s) => s.state === "connected" && s.server !== undefined)
        .map((s) => s.server!);
      const mcpClassifications = buildMcpToolClassifications(connectedServers);
      // Clear old MCP prefix entries then apply new ones
      for (const key of [...toolClassifications.keys()]) {
        if (key.startsWith("mcp_")) {
          toolClassifications.delete(key);
        }
      }
      for (const [prefix, level] of mcpClassifications) {
        toolClassifications.set(prefix, level);
      }

      // Broadcast MCP status to CLI clients (via gateway WebSocket) and Tidepool clients.
      // _mcpGatewayServerRef and _mcpTidepoolRef are set after server/host are created.
      const mcpConnected = statuses.filter((s) => s.state === "connected").length;
      const mcpConfigured = mcpManager.getConfiguredCount();
      if (_mcpChatSessionRef !== null) {
        _mcpChatSessionRef.setMcpStatus?.(mcpConnected, mcpConfigured);
      }
      if (_mcpGatewayServerRef !== null) {
        _mcpGatewayServerRef.broadcastChatEvent({
          type: "mcp_status",
          connected: mcpConnected,
          configured: mcpConfigured,
        });
      }
      if (_mcpTidepoolRef !== null) {
        _mcpTidepoolRef.broadcastMcpStatus(mcpConnected, mcpConfigured);
      }
    });

    // Start background connection loops (non-blocking — daemon starts immediately)
    log.info("Starting MCP server connection loops (background)...");
    mcpManager.startAll(mcpConfigs, keychain);
  }

  // Late-bound references for MCP status indicator callbacks (set after chatSession/server/host creation)
  let _mcpChatSessionRef: import("../gateway/chat.ts").ChatSession | null = null;
  let _mcpGatewayServerRef: import("../gateway/server.ts").GatewayServer | null = null;
  let _mcpTidepoolRef: import("../tidepool/host.ts").A2UIHost | null = null;

  // Discover skills from bundled, managed, and workspace directories
  const bundledSkillsDir = join(
    import.meta.dirname ?? ".",
    "..",
    "..",
    "skills",
    "bundled",
  );
  const managedSkillsDir = join(baseDir, "skills");
  const workspaceSkillsDir = join(baseDir, "workspaces", "main", "skills");
  const skillLoader = createSkillLoader({
    directories: [bundledSkillsDir, managedSkillsDir, workspaceSkillsDir],
    dirTypes: {
      [bundledSkillsDir]: "bundled",
      [managedSkillsDir]: "managed",
      [workspaceSkillsDir]: "workspace",
    },
  });
  let discoveredSkills: readonly Skill[] = [];
  try {
    discoveredSkills = await skillLoader.discover();
    if (discoveredSkills.length > 0) {
      log.info(`Discovered ${discoveredSkills.length} skill(s)`);
    }
  } catch {
    // Skill discovery failure is non-fatal
  }
  const SKILLS_SYSTEM_PROMPT = buildSkillsSystemPrompt(discoveredSkills);
  const TRIGGERS_SYSTEM_PROMPT = buildTriggersSystemPrompt(baseDir);
  const skillExecutor = createSkillToolExecutor({ skillLoader });

  // Claude session manager — spawns headless Claude CLI subprocesses
  const claudeSessionManager = createClaudeSessionManager({
    workspacePath: mainWorkspace.path,
  });
  const claudeExecutor = createClaudeToolExecutor(claudeSessionManager);

  // Secret store and CLI prompt callback for secure out-of-context secret input.
  // The prompt writes directly to the terminal TTY to keep the value off-screen
  // and out of any pipe or log. The LLM never sees the entered value.
  const mainKeychain = createKeychain();
  const cliSecretPrompt: SecretPromptCallback = async (
    name: string,
    hint?: string,
  ): Promise<string | null> => {
    const promptText = hint
      ? `Enter value for '${name}' (${hint}): `
      : `Enter value for '${name}': `;
    // Write prompt to stderr so it shows on terminal even when stdout is piped.
    Deno.stderr.writeSync(new TextEncoder().encode(promptText));
    // Read from stdin with raw mode to suppress echo.
    try {
      Deno.stdin.setRaw(true);
    } catch {
      // setRaw may fail in non-TTY environments; proceed without it.
    }
    const chars: number[] = [];
    const buf = new Uint8Array(1);
    try {
      while (true) {
        const n = await Deno.stdin.read(buf);
        if (n === null) break;
        const byte = buf[0];
        // Enter key
        if (byte === 13 || byte === 10) break;
        // Ctrl-C
        if (byte === 3) {
          Deno.stderr.writeSync(new TextEncoder().encode("\n"));
          return null;
        }
        // Backspace
        if (byte === 127 || byte === 8) {
          if (chars.length > 0) chars.pop();
        } else {
          chars.push(byte);
        }
      }
    } finally {
      try {
        Deno.stdin.setRaw(false);
      } catch {
        // Ignore
      }
      Deno.stderr.writeSync(new TextEncoder().encode("\n"));
    }
    return new TextDecoder().decode(new Uint8Array(chars));
  };
  // Mutable prompt callback ref — defaults to CLI terminal input.
  // Tidepool path swaps this to the browser WebSocket callback once the
  // chatSession is available. Access is safe because the mutex serializes
  // processMessage calls and ensures no concurrent secret_save invocations.
  let activeSecretPrompt: SecretPromptCallback = cliSecretPrompt;
  const secretExecutor = createSecretToolExecutor(
    mainKeychain,
    (name, hint) => activeSecretPrompt(name, hint),
  );

  const triggerExecutor = createTriggerToolExecutor({
    triggerStore,
    sessionTaint: session.taint,
    getSessionTaint: () => session.taint,
    escalateTaint: (level: ClassificationLevel) => {
      session = updateTaint(session, level, "trigger context injection");
    },
  });

  const toolExecutor = createToolExecutor({
    execTools,
    cronManager,
    todoManager,
    searchProvider,
    webFetcher,
    memoryExecutor,
    planExecutor: mainPlanExecutor,
    browserExecutor,
    tidepoolExecutor,
    imageExecutor,
    sessionExecutor,
    exploreExecutor,
    googleExecutor: buildGoogleExecutor(session.taint, session.id),
    githubExecutor,
    obsidianExecutor,
    llmTaskExecutor: registry ? createLlmTaskToolExecutor(registry) : undefined,
    summarizeExecutor: registry
      ? createSummarizeToolExecutor(registry)
      : undefined,
    healthcheckExecutor: createHealthcheckToolExecutor({
      providerRegistry: registry,
      storageProvider: storage,
      skillLoader,
    }),
    claudeExecutor,
    mcpExecutor,
    subagentFactory,
    secretExecutor,
    triggerExecutor,
    skillExecutor,
    providerRegistry: registry,
  });

  // Read streaming preference from config. When not set, let the orchestrator
  // default to true. Users can disable with `streaming: false` in triggerfish.yaml.
  const modelsConfig = config.models as Record<string, unknown> | undefined;
  const streamingPref = modelsConfig?.streaming;

  const chatSession = createChatSession({
    hookRunner,
    providerRegistry: registry,
    spinePath,
    tools: getToolDefinitions(),
    getExtraTools: () => getMcpToolDefinitions(mcpManager.getConnected()) as readonly ToolDefinition[],
    getExtraSystemPromptSections: () => {
      const mcpPrompt = buildMcpSystemPrompt(mcpManager.getConnected());
      return mcpPrompt ? [mcpPrompt] : [];
    },
    toolExecutor,
    systemPromptSections: [
      TODO_SYSTEM_PROMPT,
      WEB_TOOLS_SYSTEM_PROMPT,
      MEMORY_SYSTEM_PROMPT,
      PLAN_SYSTEM_PROMPT,
      TIDEPOOL_SYSTEM_PROMPT,
      SESSION_TOOLS_SYSTEM_PROMPT,
      IMAGE_TOOLS_SYSTEM_PROMPT,
      EXPLORE_SYSTEM_PROMPT,
      SKILLS_SYSTEM_PROMPT,
      TRIGGERS_SYSTEM_PROMPT,
      TRIGGER_TOOLS_SYSTEM_PROMPT,
      LLM_TASK_SYSTEM_PROMPT,
      SUMMARIZE_SYSTEM_PROMPT,
      CLAUDE_SESSION_SYSTEM_PROMPT,
      SECRET_TOOLS_SYSTEM_PROMPT,
    ],
    secretStore: mainKeychain,
    session,
    ...(streamingPref !== undefined
      ? { enableStreaming: streamingPref === true }
      : {}),
    getSession: () => session,
    debug: config.debug === true || Deno.env.get("TRIGGERFISH_DEBUG") === "1",
    visionProvider,
    toolClassifications,
    getSessionTaint: () => session.taint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      session = updateTaint(session, level, reason);
    },
    resetSession: () => {
      session = createSession({
        userId: "owner" as UserId,
        channelId: "daemon" as ChannelId,
      });
      // Close browser so next session gets a fresh launch
      browserHandle.close().catch(() => {});
    },
    pairingService,
    pathClassifier,
    domainClassifier,
    toolFloorRegistry,
    primaryModelName: config.models.primary.model,
  });

  log.info("Main session created");
  // Wire chat session for MCP status broadcasting (late-bound ref used in onStatusChange callback)
  _mcpChatSessionRef = chatSession;

  // Wrap the chatSession processMessage for Tidepool so that each WebSocket
  // message sets the active secret prompt callback to the Tidepool variant
  // (which sends a `secret_prompt` event over the browser WebSocket).
  // CLI path leaves activeSecretPrompt as the terminal hidden-input callback.
  const tidepoolChatSession = {
    ...chatSession,
    processMessage: (
      content: Parameters<typeof chatSession.processMessage>[0],
      sendEvent: Parameters<typeof chatSession.processMessage>[1],
      signal?: Parameters<typeof chatSession.processMessage>[2],
    ) => {
      activeSecretPrompt = chatSession.createTidepoolSecretPrompt(sendEvent);
      return chatSession.processMessage(content, sendEvent, signal).finally(() => {
        activeSecretPrompt = cliSecretPrompt;
      });
    },
  };

  // Start Tidepool + Gateway EARLY so `triggerfish chat` can connect
  // while channels and MCP servers finish wiring in the background.
  const tidepoolHost = createA2UIHost({ chatSession: tidepoolChatSession });
  const tidepoolPort = 18790;
  await tidepoolHost.start(tidepoolPort);
  tidepoolTools = createTidePoolTools(tidepoolHost);
  log.info(`Tidepool listening on http://127.0.0.1:${tidepoolPort}`);
  // Wire up MCP status indicator for Tidepool
  _mcpTidepoolRef = tidepoolHost;

  // Wrap the chatSession for CLI WebSocket clients so that secret_save prompts
  // are sent over the WebSocket (just like the Tidepool variant) instead of
  // trying to read from the daemon's stdin (which has no TTY).
  const gatewayChatSession = {
    ...chatSession,
    processMessage: (
      content: Parameters<typeof chatSession.processMessage>[0],
      sendEvent: Parameters<typeof chatSession.processMessage>[1],
      signal?: Parameters<typeof chatSession.processMessage>[2],
    ) => {
      activeSecretPrompt = chatSession.createTidepoolSecretPrompt(sendEvent);
      return chatSession.processMessage(content, sendEvent, signal).finally(() => {
        activeSecretPrompt = cliSecretPrompt;
      });
    },
  };

  const server = createGatewayServer({
    port: 18789,
    schedulerService,
    chatSession: gatewayChatSession,
    sessionManager: enhancedSessionManager,
    notificationService,
  });
  const addr = await server.start();
  log.info(`Gateway listening on ${addr.hostname}:${addr.port}`);
  // Wire gateway server for MCP status broadcasting
  _mcpGatewayServerRef = server;

  // --- Telegram channel wiring ---
  const telegramConfig = config.channels?.telegram as {
    botToken?: string;
    ownerId?: number;
    classification?: string;
    user_classifications?: Record<string, string>;
    respond_to_unclassified?: boolean;
  } | undefined;

  if (telegramConfig?.botToken) {
    const telegramAdapter = createTelegramChannel({
      botToken: telegramConfig.botToken,
      ownerId: telegramConfig.ownerId,
      classification:
        (telegramConfig.classification ?? "PUBLIC") as ClassificationLevel,
    });

    await chatSession.registerChannel("telegram", {
      adapter: telegramAdapter,
      channelName: "Telegram",
      classification:
        (telegramConfig.classification ?? "PUBLIC") as ClassificationLevel,
      userClassifications: telegramConfig.user_classifications,
      respondToUnclassified: telegramConfig.respond_to_unclassified,
    });

    telegramAdapter.onMessage((msg) => {
      // Handle /start — greet the user on first contact
      if (msg.content === "/start") {
        telegramAdapter.send({
          content: "Triggerfish connected. You can chat with me here.",
          sessionId: msg.sessionId,
        }).catch((err) => log.error("Telegram send error:", err));
        return;
      }

      // /clear must call chatSession.clear() — same as the CLI/gateway path.
      // Without this, "/clear" is just sent as text to the LLM which responds
      // with "session cleared" but never actually resets the session taint.
      if (msg.content === "/clear" && msg.isOwner !== false) {
        chatSession.clear();
        telegramAdapter.clearChat(msg.sessionId ?? "")
          .then(() =>
            telegramAdapter.send({
              content:
                "Session cleared. Your context and taint level have been reset to PUBLIC.\n\nWhat would you like to do?",
              sessionId: msg.sessionId,
            })
          )
          .then(() => notificationService.flushPending("owner" as UserId))
          .catch((err) => log.error("Telegram clear error:", err));
        return;
      }

      // Owner uses the same processMessage path as the CLI.
      // Non-owner messages go through handleChannelMessage for per-user sessions + access control.
      if (msg.isOwner !== false) {
        const sendEvent = buildSendEvent(telegramAdapter, "Telegram", msg);
        chatSession.processMessage(msg.content, sendEvent)
          .catch((err) =>
            log.error("Telegram message processing error:", err)
          );
      } else {
        chatSession.handleChannelMessage(msg, "telegram")
          .catch((err) =>
            log.error("Telegram message processing error:", err)
          );
      }
    });

    // Register Telegram for notification delivery
    const ownerChatId = telegramConfig.ownerId
      ? `telegram-${telegramConfig.ownerId}`
      : undefined;
    if (ownerChatId) {
      notificationService.registerChannel({
        name: "telegram",
        send: (msg) =>
          telegramAdapter.send({ content: msg, sessionId: ownerChatId }),
      });
    }

    await telegramAdapter.connect();

    // Register Telegram adapter for agent tool access (message, channels_list)
    channelAdapters.set("telegram", {
      adapter: telegramAdapter,
      classification:
        (telegramConfig.classification ?? "PUBLIC") as ClassificationLevel,
      name: "Telegram",
    });

    log.info("Telegram channel connected");
  }

  // --- Signal channel wiring ---
  const signalConfig = config.channels?.signal as {
    endpoint?: string;
    account?: string;
    ownerPhone?: string;
    pairing?: boolean;
    pairing_classification?: string;
    classification?: string;
    defaultGroupMode?: string;
    user_classifications?: Record<string, string>;
    respond_to_unclassified?: boolean;
    groups?: Record<string, { mode: string; classification?: string }>;
  } | undefined;

  // Track the spawned signal-cli daemon child so we can gracefully stop it on exit.
  // deno-lint-ignore no-explicit-any
  let signalDaemonHandle: DaemonHandle | null = null as any;

  if (signalConfig?.endpoint && signalConfig?.account) {
    // Signal setup runs in the background — daemon auto-start can take 60s+
    // and must never block the rest of Triggerfish from starting.
    log.info("Signal channel setup starting (background)...");
    const signalEndpoint = signalConfig.endpoint;
    const signalAccount = signalConfig.account;
    const signalOwnerPhone = signalConfig.ownerPhone;
    const signalClassification = (signalConfig.classification ?? "PUBLIC") as ClassificationLevel;
    const signalDefaultGroupMode = (signalConfig.defaultGroupMode ?? "always") as
      | "always"
      | "mentioned-only"
      | "owner-only";
    const signalGroups = signalConfig.groups as
      | Record<
        string,
        {
          readonly mode: "always" | "mentioned-only" | "owner-only";
          readonly classification?: ClassificationLevel;
        }
      >
      | undefined;
    const signalUserClassifications = signalConfig.user_classifications;
    const signalRespondToUnclassified = signalConfig.respond_to_unclassified;
    const signalPairing = signalConfig.pairing;
    const signalPairingClassification = (signalConfig.pairing_classification ??
      "INTERNAL") as ClassificationLevel;

    (async () => {
      try {
        // Parse endpoint — handle both TCP and Unix socket auto-start
        const tcpMatch = signalEndpoint.match(/^tcp:\/\/([^:]+):(\d+)$/);
        const unixMatch = signalEndpoint.match(/^unix:\/\/(.+)$/);

        if (tcpMatch) {
          const [, tcpHost, tcpPortStr] = tcpMatch;
          const tcpPort = parseInt(tcpPortStr, 10);
          const running = await isDaemonRunning(tcpHost, tcpPort);
          const healthy = running ? await isDaemonHealthy(tcpHost, tcpPort) : false;

          if (!running || !healthy) {
            if (running && !healthy) {
              log.warn("signal-cli daemon is occupying the port but not responding to JSON-RPC");
              if (signalDaemonHandle) {
                try { signalDaemonHandle.child.kill("SIGTERM"); } catch { /* already dead */ }
                signalDaemonHandle = null;
                await new Promise((r) => setTimeout(r, 1000));
              }
            }

            log.info("signal-cli daemon not running, starting...");
            const cliCheck = await checkSignalCli();
            if (cliCheck.ok) {
              const daemonResult = startDaemon(
                signalAccount,
                tcpHost,
                tcpPort,
                cliCheck.value.path,
                cliCheck.value.javaHome,
              );
              if (daemonResult.ok) {
                signalDaemonHandle = daemonResult.value;
                const ready = await waitForDaemon(tcpHost, tcpPort);
                if (ready) {
                  log.info("signal-cli daemon started");
                  const versionCheck = await checkSignalCli();
                  if (versionCheck.ok) {
                    log.info(`signal-cli version: ${versionCheck.value.version}`);
                  }
                } else {
                  const earlyErr = await daemonResult.value.earlyStderr;
                  if (earlyErr) {
                    log.error(`signal-cli early stderr: ${earlyErr}`);
                  }
                  const stderr = await daemonResult.value.stderrText();
                  log.error("signal-cli daemon started but not reachable within 60s");
                  if (stderr) {
                    log.error(`signal-cli stderr: ${stderr}`);
                  }
                }
              } else {
                log.error(`Failed to start signal-cli daemon: ${daemonResult.error}`);
              }
            } else {
              log.error("signal-cli not found — cannot auto-start daemon");
            }
          }
        } else if (unixMatch) {
          const socketPath = unixMatch[1];
          const running = await isDaemonRunningUnix(socketPath);
          if (!running) {
            log.info("signal-cli daemon not running (Unix socket), starting...");
            const cliCheck = await checkSignalCli();
            if (cliCheck.ok) {
              const daemonResult = startDaemonUnix(
                signalAccount,
                socketPath,
                cliCheck.value.path,
                cliCheck.value.javaHome,
              );
              if (daemonResult.ok) {
                signalDaemonHandle = daemonResult.value;
                const ready = await waitForDaemonUnix(socketPath);
                if (ready) {
                  log.info("signal-cli daemon started (Unix socket)");
                  const versionCheck = await checkSignalCli();
                  if (versionCheck.ok) {
                    log.info(`signal-cli version: ${versionCheck.value.version}`);
                  }
                } else {
                  const earlyErr = await daemonResult.value.earlyStderr;
                  if (earlyErr) {
                    log.error(`signal-cli early stderr: ${earlyErr}`);
                  }
                  const stderr = await daemonResult.value.stderrText();
                  log.error("signal-cli daemon (Unix socket) not reachable within 60s");
                  if (stderr) {
                    log.error(`signal-cli stderr: ${stderr}`);
                  }
                }
              } else {
                log.error(`Failed to start signal-cli daemon: ${daemonResult.error}`);
              }
            } else {
              log.error("signal-cli not found — cannot auto-start daemon");
            }
          }
        }

        const signalAdapter = createSignalChannel({
          endpoint: signalEndpoint,
          account: signalAccount,
          ownerPhone: signalOwnerPhone,
          classification: signalClassification,
          defaultGroupMode: signalDefaultGroupMode,
          groups: signalGroups,
        });

        await chatSession.registerChannel("signal", {
          adapter: signalAdapter,
          channelName: "Signal",
          classification: signalClassification,
          userClassifications: signalUserClassifications,
          respondToUnclassified: signalRespondToUnclassified,
          pairing: signalPairing,
          pairingClassification: signalPairingClassification,
        });

        signalAdapter.onMessage((msg) => {
          chatSession.handleChannelMessage(msg, "signal")
            .catch((err) => log.error("Signal message processing error:", err));
        });

        if (signalOwnerPhone) {
          notificationService.registerChannel({
            name: "signal",
            send: (notifMsg) =>
              signalAdapter.send({
                content: notifMsg,
                sessionId: `signal-${signalOwnerPhone}`,
              }),
          });
        }

        await signalAdapter.connect();

        // Register Signal adapter for agent tool access (message, channels_list)
        channelAdapters.set("signal", {
          adapter: signalAdapter,
          classification: signalClassification,
          name: "Signal",
        });

        log.info("Signal channel connected");
      } catch (err) {
        log.error(
          `Signal channel failed to connect: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })();
  }

  // Start the scheduler (cron tick loop + trigger)
  schedulerService.start();
  log.info("Scheduler started");
  if (schedulerConfig.trigger.enabled) {
    log.info(`Trigger: every ${schedulerConfig.trigger.intervalMinutes}m`);
  }
  log.info("Triggerfish is running!");

  // Graceful shutdown handler
  let shuttingDown = false;
  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down...");

    // Stop signal-cli daemon if we spawned it
    if (signalDaemonHandle) {
      try { signalDaemonHandle.child.kill("SIGTERM"); } catch { /* already dead */ }
      signalDaemonHandle = null;
    }

    // Stop scheduler (cron tick loop + triggers)
    try { schedulerService.stop(); } catch { /* best effort */ }

    // Stop gateway and tidepool servers
    try { await server.stop(); } catch { /* best effort */ }
    try { await tidepoolHost.stop(); } catch { /* best effort */ }

    // Close database connections
    try { memoryDb.close(); } catch { /* best effort */ }
    try { await storage.close(); } catch { /* best effort */ }

    log.info("Shutdown complete");

    // Close the log file handle so the file lock is released before exit.
    // Without this, a stop→start cycle on Windows can hit EBUSY if the
    // old process's handle lingers.
    try { await shutdownLogger(); } catch { /* best effort */ }
    Deno.exit(0);
  };
  try {
    Deno.addSignalListener("SIGTERM", () => { handleShutdown(); });
  } catch { /* not supported on all platforms */ }
  try {
    Deno.addSignalListener("SIGINT", () => { handleShutdown(); });
  } catch { /* not supported on all platforms */ }

  // Keep running until interrupted
  await new Promise(() => {}); // Never resolves — signal handler calls Deno.exit()
}

/**
 * Install and start the Triggerfish daemon.
 */
async function runDaemonStart(): Promise<void> {
  console.log("Starting Triggerfish daemon...\n");

  const binaryPath = Deno.execPath();
  const result = await installAndStartDaemon(binaryPath);

  if (result.ok) {
    console.log("✓", result.message);

    // Wait for gateway to be ready (up to 30s)
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const conn = await Deno.connect({ hostname: "127.0.0.1", port: 18789 });
        conn.close();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (ready) {
      console.log("✓ Gateway ready");
    } else {
      console.log("  Gateway not yet reachable — check 'triggerfish logs'");
    }

    console.log(`\n  Tidepool: http://127.0.0.1:18790`);
    console.log("\nRun 'triggerfish logs --tail' to follow output.\n");
  } else {
    console.log("✗", result.message);
    Deno.exit(1);
  }
}

/**
 * Stop the Triggerfish daemon.
 */
async function runDaemonStop(): Promise<void> {
  const result = await stopDaemon();

  if (result.ok) {
    console.log("✓", result.message);
  } else {
    console.log("✗", result.message);
    Deno.exit(1);
  }
}

// ─── Channel type definitions for config add-channel ─────────────────────────

/** Supported channel types for add-channel. */
const CHANNEL_TYPES = [
  "telegram",
  "slack",
  "discord",
  "whatsapp",
  "webchat",
  "email",
  "signal",
] as const;

type ChannelType = typeof CHANNEL_TYPES[number];

const PLUGIN_TYPES = [
  "obsidian",
] as const;

type PluginType = typeof PLUGIN_TYPES[number];

/** Prompt for channel-specific config fields and return the config object. */
async function promptChannelConfig(
  channelType: ChannelType,
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};

  switch (channelType) {
    case "telegram": {
      config.botToken = await Input.prompt({
        message: "Bot token (from @BotFather)",
      });
      const ownerId = await Input.prompt({
        message:
          "Your Telegram user ID (numeric, message @getmyid_bot for your ID number)",
      });
      config.ownerId = parseInt(ownerId, 10) || 0;
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["INTERNAL", "PUBLIC", "CONFIDENTIAL", "RESTRICTED"],
        default: "INTERNAL",
      });

      break;
    }

    case "slack": {
      config.botToken = await Input.prompt({
        message: "Bot token (xoxb-...)",
      });
      config.appToken = await Input.prompt({
        message: "App token (xapp-... for Socket Mode)",
      });
      config.signingSecret = await Input.prompt({
        message: "Signing secret",
      });
      const slackOwner = await Input.prompt({
        message: "Your Slack user ID (optional, e.g. U012ABC3DEF)",
        default: "",
      });
      if (slackOwner.length > 0) {
        config.ownerId = slackOwner;
      }
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
        default: "PUBLIC",
      });
      break;
    }

    case "discord": {
      config.botToken = await Input.prompt({
        message: "Bot token",
      });
      const discordOwner = await Input.prompt({
        message: "Your Discord user ID (optional, snowflake)",
        default: "",
      });
      if (discordOwner.length > 0) {
        config.ownerId = discordOwner;
      }
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
        default: "PUBLIC",
      });
      break;
    }

    case "whatsapp": {
      config.accessToken = await Input.prompt({
        message: "Meta Business API access token",
      });
      config.phoneNumberId = await Input.prompt({
        message: "Phone number ID",
      });
      config.verifyToken = await Input.prompt({
        message: "Webhook verify token",
      });
      const webhookPort = await Input.prompt({
        message: "Webhook port",
        default: "8443",
      });
      config.webhookPort = parseInt(webhookPort, 10) || 8443;
      const ownerPhone = await Input.prompt({
        message: "Owner phone number (optional, for owner detection)",
        default: "",
      });
      if (ownerPhone.length > 0) {
        config.ownerPhone = ownerPhone;
      }
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
        default: "PUBLIC",
      });
      break;
    }

    case "webchat": {
      const port = await Input.prompt({
        message: "WebChat port",
        default: "8765",
      });
      config.port = parseInt(port, 10) || 8765;
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
        default: "PUBLIC",
      });
      break;
    }

    case "email": {
      config.smtpApiUrl = await Input.prompt({
        message: "SMTP relay API URL (e.g. SendGrid, Mailgun endpoint)",
      });
      config.smtpApiKey = await Input.prompt({
        message: "SMTP relay API key",
      });
      config.imapHost = await Input.prompt({
        message: "IMAP server hostname",
      });
      const imapPort = await Input.prompt({
        message: "IMAP port",
        default: "993",
      });
      config.imapPort = parseInt(imapPort, 10) || 993;
      config.imapUser = await Input.prompt({
        message: "IMAP username (email address)",
      });
      config.imapPassword = await Input.prompt({
        message: "IMAP password",
      });
      config.fromAddress = await Input.prompt({
        message: "From address for outgoing mail",
      });
      const pollInterval = await Input.prompt({
        message: "Poll interval (ms)",
        default: "30000",
      });
      config.pollInterval = parseInt(pollInterval, 10) || 30000;
      const ownerEmail = await Input.prompt({
        message: "Owner email (optional, for owner detection)",
        default: "",
      });
      if (ownerEmail.length > 0) {
        config.ownerEmail = ownerEmail;
      }
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["CONFIDENTIAL", "PUBLIC", "INTERNAL", "RESTRICTED"],
        default: "CONFIDENTIAL",
      });
      break;
    }

    case "signal": {
      // Step 1: Find or install signal-cli
      console.log("\nChecking for signal-cli...");
      let signalCliPath = "signal-cli";
      let signalJavaHome: string | undefined;
      const cliCheck = await checkSignalCli();

      if (cliCheck.ok) {
        signalCliPath = cliCheck.value.path;
        console.log(`  Found: ${cliCheck.value.version} (${signalCliPath})`);
        signalJavaHome = cliCheck.value.javaHome;
      } else {
        // Not found — offer to download
        console.log(
          "  signal-cli not found on PATH or in ~/.triggerfish/bin/\n",
        );
        const installIt = await Confirm.prompt({
          message: "Download and install signal-cli?",
          default: true,
        });

        if (!installIt) {
          console.error("\n  Install signal-cli manually before continuing:");
          console.error("    https://github.com/AsamK/signal-cli/releases\n");
          Deno.exit(1);
        }

        console.log("\n  Fetching latest release info...");
        const releaseResult = await fetchLatestVersion();
        if (!releaseResult.ok) {
          console.error(`  Failed: ${releaseResult.error}`);
          Deno.exit(1);
        }

        const installResult = await downloadSignalCli(releaseResult.value);
        if (!installResult.ok) {
          console.error(`  Installation failed: ${installResult.error}`);
          Deno.exit(1);
        }

        signalCliPath = installResult.value.path;
        signalJavaHome = installResult.value.javaHome;
      }

      // Step 2: Get phone number
      config.account = await Input.prompt({
        message: "Your Signal phone number (E.164 format, e.g. +15551234567)",
      });

      // Step 3: Link or skip
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

      const tcpPort = 7583;
      const tcpHost = "localhost";

      if (setupMode === "link") {
        console.log("\nStarting device link...");
        console.log(
          "Open Signal on your phone: Settings > Linked Devices > Link New Device\n",
        );

        const linkResult = await startLinkProcess(
          "Triggerfish",
          signalCliPath,
          signalJavaHome,
        );

        if (!linkResult.ok) {
          console.error(`  Link failed: ${linkResult.error}`);
          console.error(
            `  You can link manually: ${signalCliPath} link -n Triggerfish`,
          );
          Deno.exit(1);
        }

        // Display QR code
        await renderQrCode(linkResult.value.uri);
        console.log("Scan this QR code with Signal on your phone.");
        console.log("Waiting for link to complete...\n");

        // Wait for the link process to finish
        const linkStatus = await linkResult.value.process.status;
        if (!linkStatus.success) {
          console.error("  Device linking failed. Check signal-cli output.");
          Deno.exit(1);
        }
        console.log("  Device linked successfully!\n");
      }

      // Step 4: Start daemon or detect existing
      const alreadyRunning = await isDaemonRunning(tcpHost, tcpPort);
      if (alreadyRunning) {
        console.log(
          `  signal-cli daemon already running on ${tcpHost}:${tcpPort}`,
        );
      } else {
        const startIt = await Confirm.prompt({
          message: `Start signal-cli daemon on tcp://${tcpHost}:${tcpPort}?`,
          default: true,
        });
        if (startIt) {
          console.log("  Starting signal-cli daemon...");
          const daemonResult = startDaemon(
            config.account as string,
            tcpHost,
            tcpPort,
            signalCliPath,
            signalJavaHome,
          );
          if (!daemonResult.ok) {
            console.error(`  Failed: ${daemonResult.error}`);
            console.error(
              `  Start manually: ${signalCliPath} -a ${config.account} daemon --tcp localhost:7583`,
            );
          } else {
            const ready = await waitForDaemon(tcpHost, tcpPort);
            if (ready) {
              console.log("  Daemon is running.");
            } else {
              const stderr = await daemonResult.value.stderrText();
              console.error(
                "  Daemon started but not reachable yet. It may still be initializing.",
              );
              if (stderr) {
                console.error(`  signal-cli stderr: ${stderr}`);
              }
              console.error(
                `  Check: ${signalCliPath} -a ${config.account} daemon --tcp localhost:7583`,
              );
            }
          }
        } else {
          console.log("\n  Start it manually before running Triggerfish:");
          console.log(
            `  ${signalCliPath} -a ${config.account} daemon --tcp ${tcpHost}:${tcpPort}\n`,
          );
        }
      }

      config.endpoint = `tcp://${tcpHost}:${tcpPort}`;

      // Step 5: Policy config
      const enablePairing = await Confirm.prompt({
        message:
          "Enable pairing mode? (new contacts must send a one-time code before chatting)",
        default: false,
      });
      if (enablePairing) {
        config.pairing = true;
        console.log(
          "\n  Pairing mode: new contacts must send a 6-digit code to start chatting.",
        );
        console.log(
          '  Generate codes at runtime: ask your agent "generate a pairing code for Signal"',
        );
        console.log(
          "  Codes expire after 5 minutes and can only be used once.\n",
        );
      }
      config.defaultGroupMode = await Select.prompt({
        message: "Default group chat mode",
        options: [
          { name: "Always respond", value: "always" },
          { name: "Only when mentioned", value: "mentioned-only" },
          { name: "Owner-only commands", value: "owner-only" },
        ],
        default: "always",
      });
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
        default: "PUBLIC",
      });
      break;
    }
  }

  return config;
}

/** Prompt for plugin-specific config fields and return the config object. */
async function promptPluginConfig(
  pluginType: PluginType,
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};

  switch (pluginType) {
    case "obsidian": {
      // Vault path with validation
      let vaultPath = "";
      while (true) {
        vaultPath = await Input.prompt({
          message: "Path to your Obsidian vault",
        });
        if (vaultPath.length === 0) {
          console.log("  Vault path is required.");
          continue;
        }
        // Expand ~ to home directory
        vaultPath = expandTilde(vaultPath);
        // Validate .obsidian/ marker
        try {
          await Deno.stat(join(vaultPath, ".obsidian"));
          break;
        } catch {
          console.log(
            `  Not a valid Obsidian vault (no .obsidian/ folder found at ${vaultPath})`,
          );
          console.log("  Please enter the root folder of your Obsidian vault.");
        }
      }
      config.enabled = true;
      config.vault_path = vaultPath;

      config.classification = await Select.prompt({
        message: "Vault classification level",
        options: ["INTERNAL", "PUBLIC", "CONFIDENTIAL", "RESTRICTED"],
        default: "INTERNAL",
      });

      const enableDaily = await Confirm.prompt({
        message: "Enable daily notes?",
        default: true,
      });
      if (enableDaily) {
        config.daily_notes = {
          folder: "daily",
          date_format: "YYYY-MM-DD",
        };
      }

      console.log("  ✓ Obsidian vault configured");
      break;
    }
  }

  return config;
}

/**
 * Set a nested value in an object using a dotted key path.
 * Creates intermediate objects as needed.
 */
function setNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
  value: unknown,
): void {
  const parts = keyPath.split(".");
  // deno-lint-ignore no-explicit-any
  let current: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Get a nested value from an object using a dotted key path.
 */
function getNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
): unknown {
  const parts = keyPath.split(".");
  // deno-lint-ignore no-explicit-any
  let current: any = obj;
  for (const part of parts) {
    if (
      current === undefined || current === null || typeof current !== "object"
    ) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Prompt the user to restart the daemon if it's running.
 * Shared by config set, add-channel, and add-plugin commands.
 */
async function promptDaemonRestart(): Promise<void> {
  const status = await getDaemonStatus();
  if (status.running) {
    const restart = await Confirm.prompt({
      message: "Restart daemon to apply?",
      default: true,
    });
    if (restart) {
      const stopResult = await stopDaemon();
      if (!stopResult.ok) {
        console.log(`✗ Failed to stop daemon: ${stopResult.message}`);
        return;
      }
      const startResult = await installAndStartDaemon(Deno.execPath());
      if (startResult.ok) {
        console.log("✓ Daemon restarted");
      } else {
        console.log(`✗ ${startResult.message}`);
      }
    }
  } else {
    console.log("Daemon is not running. Start it with: triggerfish start");
  }
}

/**
 * Set a config value in triggerfish.yaml by dotted key path.
 */
async function runConfigSet(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const key = flags["config_key"] as string | undefined;
  const rawValue = flags["config_value"] as string | undefined;

  if (!key || rawValue === undefined) {
    console.error("Usage: triggerfish config set <key> <value>");
    Deno.exit(1);
  }

  const configPath = resolveConfigPath();

  let rawYaml: string;
  try {
    rawYaml = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    console.error("Run 'triggerfish dive' to create initial config.");
    Deno.exit(1);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown>;

  // Coerce value: booleans and numbers
  let value: unknown = rawValue;
  if (rawValue === "true") value = true;
  else if (rawValue === "false") value = false;
  else if (/^\d+$/.test(rawValue)) value = parseInt(rawValue, 10);

  setNestedValue(parsed, key, value);

  await backupConfig(configPath);
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);

  // Mask secrets in output
  const display =
    key.includes("key") || key.includes("secret") || key.includes("token")
      ? `${String(rawValue).slice(0, 4)}...${String(rawValue).slice(-4)}`
      : String(value);

  console.log(`\n  ${key} = ${display}\n`);

  await promptDaemonRestart();
}

/**
 * Get a config value from triggerfish.yaml by dotted key path.
 */
function runConfigGet(
  flags: Readonly<Record<string, boolean | string>>,
): void {
  const key = flags["config_key"] as string | undefined;

  if (!key) {
    console.error("Usage: triggerfish config get <key>");
    Deno.exit(1);
  }

  const configPath = resolveConfigPath();

  let rawYaml: string;
  try {
    rawYaml = Deno.readTextFileSync(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    Deno.exit(1);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown>;
  const value = getNestedValue(parsed, key);

  if (value === undefined) {
    console.log(`\n  ${key} is not set\n`);
  } else {
    // Mask secrets in output
    const display =
      key.includes("key") || key.includes("secret") || key.includes("token")
        ? `${String(value).slice(0, 4)}...${String(value).slice(-4)}`
        : String(value);
    console.log(`\n  ${key} = ${display}\n`);
  }
}

/**
 * Validate triggerfish.yaml and report errors.
 */
function runConfigValidate(): void {
  const configPath = resolveConfigPath();

  let rawYaml: string;
  try {
    rawYaml = Deno.readTextFileSync(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    console.error("Run 'triggerfish dive' to create initial config.");
    Deno.exit(1);
  }

  // Check YAML parses
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  YAML parse error: ${message}\n`);
    Deno.exit(1);
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.error("\n  Config file did not parse to an object.\n");
    Deno.exit(1);
  }

  // Run structural validation
  const result = validateConfig(parsed as Record<string, unknown>);
  if (!result.ok) {
    console.error(`\n  Validation error: ${result.error}\n`);
    Deno.exit(1);
  }

  // Additional warnings (non-fatal)
  const config = parsed as Record<string, unknown>;
  const warnings: string[] = [];

  const models = config.models as Record<string, unknown> | undefined;
  if (models?.providers) {
    const providers = models.providers as Record<string, unknown>;
    if (Object.keys(providers).length === 0) {
      warnings.push("No LLM providers configured under models.providers");
    }
  }

  const channels = config.channels as Record<string, unknown> | undefined;
  if (!channels || Object.keys(channels).length === 0) {
    warnings.push("No channels configured");
  }

  console.log(`\n  Configuration valid: ${configPath}`);
  if (warnings.length > 0) {
    console.log("\n  Warnings:");
    for (const w of warnings) {
      console.log(`    - ${w}`);
    }
  }
  console.log();
}

/**
 * Store a secret in the OS keychain.
 */
async function runConfigSetSecret(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const key = flags["secret_key"] as string | undefined;
  const value = flags["secret_value"] as string | undefined;

  if (!key || value === undefined) {
    console.error("Usage: triggerfish config set-secret <key> <value>");
    Deno.exit(1);
  }

  const store = createKeychain();
  const result = await store.setSecret(key, value);
  if (result.ok) {
    console.log(`Secret "${key}" stored in keychain.`);
  } else {
    console.error(`Failed to store secret: ${result.error}`);
    Deno.exit(1);
  }
}

/**
 * Retrieve a secret from the OS keychain.
 */
async function runConfigGetSecret(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const key = flags["secret_key"] as string | undefined;

  if (!key) {
    console.error("Usage: triggerfish config get-secret <key>");
    Deno.exit(1);
  }

  const store = createKeychain();
  const result = await store.getSecret(key);
  if (result.ok) {
    console.log(result.value);
  } else {
    console.error(`Secret "${key}" not found in keychain.`);
    Deno.exit(1);
  }
}

/**
 * Add a channel to triggerfish.yaml interactively.
 */
async function runConfigAddChannel(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const configPath = resolveConfigPath();

  // Require interactive terminal
  if (!Deno.stdin.isTerminal()) {
    console.error("Error: add-channel requires an interactive terminal.");
    Deno.exit(1);
  }

  // Determine channel type
  let channelType: ChannelType;
  const flagType = flags.channel_type as string | undefined;

  if (flagType && CHANNEL_TYPES.includes(flagType as ChannelType)) {
    channelType = flagType as ChannelType;
  } else {
    if (flagType) {
      console.log(`Unknown channel type: ${flagType}\n`);
    }
    channelType = (await Select.prompt({
      message: "Channel type",
      options: [
        { name: "Telegram", value: "telegram" },
        { name: "Signal (via signal-cli)", value: "signal" },
        { name: "Slack", value: "slack" },
        { name: "Discord", value: "discord" },
        { name: "WhatsApp", value: "whatsapp" },
        { name: "WebChat (browser-based)", value: "webchat" },
        { name: "Email (IMAP + SMTP relay)", value: "email" },
      ],
    })) as ChannelType;
  }

  // Load existing config
  let rawYaml: string;
  try {
    rawYaml = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    console.error("Run 'triggerfish dive' to create initial config.");
    Deno.exit(1);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown>;
  const channels = (parsed.channels ?? {}) as Record<string, unknown>;

  // Check if channel already exists
  if (channels[channelType]) {
    const overwrite = await Confirm.prompt({
      message: `${channelType} is already configured. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log("Cancelled.");
      return;
    }
  }

  console.log(`\nConfiguring ${channelType}...\n`);

  // Prompt for channel-specific fields
  const channelConfig = await promptChannelConfig(channelType);

  // Merge into config
  channels[channelType] = channelConfig;
  parsed.channels = channels;

  // Write back (with backup)
  await backupConfig(configPath);
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);

  console.log(`\n✓ ${channelType} added to triggerfish.yaml`);

  await promptDaemonRestart();
}

/**
 * Remove a channel from triggerfish.yaml.
 *
 * Backs up the config before writing, confirms with the user,
 * and prompts for a daemon restart if the daemon is running.
 */
async function runConfigRemoveChannel(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const configPath = resolveConfigPath();

  // Determine channel type
  let channelType: string;
  const flagType = flags.channel_type as string | undefined;

  if (flagType && CHANNEL_TYPES.includes(flagType as ChannelType)) {
    channelType = flagType;
  } else {
    // Load config to show only configured channels
    let rawYaml: string;
    try {
      rawYaml = await Deno.readTextFile(configPath);
    } catch {
      console.error(`Config not found at ${configPath}`);
      console.error("Run 'triggerfish dive' to create initial config.");
      Deno.exit(1);
    }

    const parsed = parseYaml(rawYaml) as Record<string, unknown>;
    const channels = (parsed.channels ?? {}) as Record<string, unknown>;
    const configured = Object.keys(channels).filter((k) =>
      CHANNEL_TYPES.includes(k as ChannelType)
    );

    if (configured.length === 0) {
      console.log("No channels configured.");
      return;
    }

    if (!Deno.stdin.isTerminal()) {
      console.error(
        "Error: remove-channel requires a channel type argument in non-interactive mode.",
      );
      console.error(
        `Usage: triggerfish config remove-channel <${configured.join("|")}>`,
      );
      Deno.exit(1);
    }

    channelType = await Select.prompt({
      message: "Channel to remove",
      options: configured.map((c) => ({ name: c, value: c })),
    });
  }

  // Load config
  let rawYaml: string;
  try {
    rawYaml = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    Deno.exit(1);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown>;
  const channels = (parsed.channels ?? {}) as Record<string, unknown>;

  if (!channels[channelType]) {
    console.log(`Channel '${channelType}' is not configured.`);
    return;
  }

  // Confirm removal (interactive only)
  if (Deno.stdin.isTerminal()) {
    const confirm = await Confirm.prompt({
      message: `Remove ${channelType} channel configuration?`,
      default: false,
    });
    if (!confirm) {
      console.log("Cancelled.");
      return;
    }
  }

  // Remove and write back
  delete channels[channelType];
  parsed.channels = channels;

  await backupConfig(configPath);
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);

  console.log(`\n✓ ${channelType} removed from triggerfish.yaml`);

  await promptDaemonRestart();
}

/**
 * Add a plugin to triggerfish.yaml interactively.
 */
async function runConfigAddPlugin(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const configPath = resolveConfigPath();

  // Require interactive terminal
  if (!Deno.stdin.isTerminal()) {
    console.error("Error: add-plugin requires an interactive terminal.");
    Deno.exit(1);
  }

  // Determine plugin type
  let pluginType: PluginType;
  const flagType = flags.plugin_type as string | undefined;

  if (flagType && PLUGIN_TYPES.includes(flagType as PluginType)) {
    pluginType = flagType as PluginType;
  } else {
    if (flagType) {
      console.log(`Unknown plugin type: ${flagType}\n`);
    }
    pluginType = (await Select.prompt({
      message: "Plugin type",
      options: [
        { name: "Obsidian (local vault integration)", value: "obsidian" },
      ],
    })) as PluginType;
  }

  // Load existing config
  let rawYaml: string;
  try {
    rawYaml = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    console.error("Run 'triggerfish dive' to create initial config.");
    Deno.exit(1);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown>;
  const plugins = (parsed.plugins ?? {}) as Record<string, unknown>;

  // Check if plugin already exists
  if (plugins[pluginType]) {
    const overwrite = await Confirm.prompt({
      message: `${pluginType} is already configured. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log("Cancelled.");
      return;
    }
  }

  console.log(`\nConfiguring ${pluginType}...\n`);

  // Prompt for plugin-specific fields
  const pluginConfig = await promptPluginConfig(pluginType);

  // Merge into config
  plugins[pluginType] = pluginConfig;
  parsed.plugins = plugins;

  // Write back (with backup)
  await backupConfig(configPath);
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);

  console.log(`\n✓ ${pluginType} plugin added to triggerfish.yaml`);

  await promptDaemonRestart();
}

/**
 * Canonical set of known-secret config field paths and their keychain key names.
 *
 * Used by `migrate-secrets` to detect plaintext values in config fields
 * that should be stored in the keychain.
 */
const KNOWN_SECRET_FIELDS: ReadonlyArray<{
  readonly path: string;
  readonly keychainKey: (parsed: Record<string, unknown>) => string | undefined;
}> = [
  {
    path: "web.search.api_key",
    keychainKey: () => "web:search:apiKey",
  },
  {
    path: "channels.telegram.botToken",
    keychainKey: () => "telegram:botToken",
  },
  {
    path: "channels.discord.botToken",
    keychainKey: () => "discord:botToken",
  },
  {
    path: "channels.slack.botToken",
    keychainKey: () => "slack:botToken",
  },
  {
    path: "channels.slack.appToken",
    keychainKey: () => "slack:appToken",
  },
  {
    path: "channels.slack.signingSecret",
    keychainKey: () => "slack:signingSecret",
  },
  {
    path: "channels.whatsapp.accessToken",
    keychainKey: () => "whatsapp:accessToken",
  },
  {
    path: "channels.whatsapp.webhookVerifyToken",
    keychainKey: () => "whatsapp:webhookVerifyToken",
  },
  {
    path: "channels.email.smtpPassword",
    keychainKey: () => "email:smtpPassword",
  },
  {
    path: "channels.email.imapPassword",
    keychainKey: () => "email:imapPassword",
  },
];

/**
 * Migrate plaintext secrets in triggerfish.yaml to the OS keychain.
 *
 * Detects plaintext values in known secret fields, stores them in
 * the keychain, and rewrites the config with `secret:` references.
 * Creates a timestamped backup before modifying the file.
 */
async function runConfigMigrateSecrets(): Promise<void> {
  const configPath = resolveConfigPath();

  let raw: string;
  try {
    raw = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Cannot read config: ${configPath}`);
    Deno.exit(1);
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const p = parseYaml(raw);
    if (typeof p !== "object" || p === null) {
      console.error("Config file did not parse to an object");
      Deno.exit(1);
      return;
    }
    parsed = p as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to parse config: ${message}`);
    Deno.exit(1);
    return;
  }

  // Also detect provider apiKey fields dynamically
  const providers = (
    (parsed.models as Record<string, unknown> | undefined)
      ?.providers
  ) as Record<string, unknown> | undefined;

  const dynamicSecretFields: Array<{
    path: string;
    keychainKey: () => string;
  }> = [];

  if (providers) {
    for (const providerName of Object.keys(providers)) {
      dynamicSecretFields.push({
        path: `models.providers.${providerName}.apiKey`,
        keychainKey: () => `provider:${providerName}:apiKey`,
      });
    }
  }

  const allFields = [...KNOWN_SECRET_FIELDS, ...dynamicSecretFields];

  const store = createKeychain();
  const migrated: Array<{ path: string; keychainKey: string }> = [];
  const alreadyRefs: string[] = [];

  for (const field of allFields) {
    const value = getNestedValue(parsed, field.path);
    if (typeof value !== "string" || value.length === 0) continue;

    if (value.startsWith("secret:")) {
      alreadyRefs.push(field.path);
      continue;
    }

    const keychainKey = field.keychainKey(parsed);
    if (!keychainKey) continue;

    // Store in keychain
    const result = await store.setSecret(keychainKey, value);
    if (!result.ok) {
      console.error(`Failed to store secret for ${field.path}: ${result.error}`);
      Deno.exit(1);
      return;
    }

    // Update parsed config with reference
    setNestedValue(parsed, field.path, `secret:${keychainKey}`);
    migrated.push({ path: field.path, keychainKey });
  }

  if (migrated.length === 0) {
    if (alreadyRefs.length > 0) {
      console.log(`All ${alreadyRefs.length} secret field(s) already use secret: references. Nothing to migrate.`);
    } else {
      console.log("No plaintext secrets found in known fields. Nothing to migrate.");
    }
    return;
  }

  // Create backup before modifying
  await backupConfig(configPath);

  // Write updated config
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);

  console.log(`\nMigrated ${migrated.length} secret(s) to OS keychain:\n`);
  for (const { path, keychainKey } of migrated) {
    console.log(`  ${path}  →  secret:${keychainKey}`);
  }
  console.log(`\nBackup saved. Config updated: ${configPath}`);

  // Report any refs already in place
  if (alreadyRefs.length > 0) {
    console.log(`\n${alreadyRefs.length} field(s) already used secret: references (unchanged):`);
    for (const p of alreadyRefs) {
      console.log(`  ${p}`);
    }
  }

  // Show any other secret: refs in the config for awareness
  const allRefs = findSecretRefs(parsed);
  if (allRefs.length > 0) {
    console.log(`\n${allRefs.length} total secret: reference(s) now in config.`);
  }

  console.log();
}

/**
 * Config command dispatcher.
 */
async function runConfig(
  subcommand: string | undefined,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  switch (subcommand) {
    case "add-channel":
      await runConfigAddChannel(flags);
      break;
    case "remove-channel":
      await runConfigRemoveChannel(flags);
      break;
    case "add-plugin":
      await runConfigAddPlugin(flags);
      break;
    case "set":
      await runConfigSet(flags);
      break;
    case "get":
      runConfigGet(flags);
      break;
    case "validate":
      runConfigValidate();
      break;
    case "set-secret":
      await runConfigSetSecret(flags);
      break;
    case "get-secret":
      await runConfigGetSecret(flags);
      break;
    case "migrate-secrets":
      await runConfigMigrateSecrets();
      break;
    default:
      console.log(`
CONFIG USAGE:
  triggerfish config set <key> <value>    Set a configuration value
  triggerfish config get <key>            Get a configuration value
  triggerfish config validate             Validate configuration
  triggerfish config add-channel [type]      Add a channel interactively
  triggerfish config remove-channel [type]   Remove a channel
  triggerfish config add-plugin [name]       Add a plugin interactively
  triggerfish config set-secret <key> <value>  Store a secret in OS keychain
  triggerfish config get-secret <key>          Retrieve a secret from OS keychain
  triggerfish config migrate-secrets           Migrate plaintext secrets to keychain

KEYS use dotted paths into triggerfish.yaml:
  web.search.provider              Search provider (brave)
  web.search.api_key               Search API key
  models.primary.provider          Primary provider name
  models.primary.model             Primary model name
  models.providers.<name>.apiKey   Provider API key
  scheduler.trigger.enabled        Enable trigger wakeups
  plugins.obsidian.vault_path      Obsidian vault path
  plugins.obsidian.classification  Vault classification level

CHANNEL TYPES:
  telegram, slack, discord, whatsapp, webchat, email

PLUGIN TYPES:
  obsidian

EXAMPLES:
  triggerfish config set models.primary.model claude-sonnet
  triggerfish config set web.search.provider brave
  triggerfish config set web.search.api_key sk-abc123
  triggerfish config set scheduler.trigger.enabled true
  triggerfish config get models.primary.model
  triggerfish config add-channel telegram
  triggerfish config remove-channel signal
  triggerfish config add-plugin obsidian
  triggerfish config set-secret github-pat ghp_...
  triggerfish config get-secret github-pat
  triggerfish config migrate-secrets
`);
      break;
  }
}

/**
 * Show daemon status.
 */
async function runDaemonStatus(): Promise<void> {
  const status = await getDaemonStatus();

  if (status.running) {
    console.log("✓ Triggerfish is running");
    if (status.pid) console.log(`  PID: ${status.pid}`);
    if (status.uptime) console.log(`  Since: ${status.uptime}`);
    console.log(`  Manager: ${status.manager}`);
  } else {
    console.log("✗ Triggerfish is not running");
    console.log("\nRun 'triggerfish start' to launch the daemon.");
  }
}

/**
 * Tail daemon logs.
 */
async function runDaemonLogs(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const follow = flags.tail === true;
  const levelFilter = typeof flags.level === "string" ? flags.level : undefined;
  await tailLogs(follow, 50, levelFilter);
}

/**
 * Download and install the latest release binary.
 */
async function runUpdate(): Promise<void> {
  console.log("Updating Triggerfish...\n");

  const result = await updateTriggerfish();

  if (result.ok) {
    if (result.previousVersion === result.newVersion) {
      console.log("✓ Already up to date (" + result.newVersion + ")");
    } else {
      console.log("✓", result.message);
      if (result.wasRunning) {
        console.log("\nRun 'triggerfish status' to verify the daemon restarted.");
      } else {
        const startIt = await Confirm.prompt({
          message: "Daemon was not running. Start it now?",
          default: true,
        });
        if (startIt) {
          const startResult = await installAndStartDaemon(Deno.execPath());
          if (startResult.ok) {
            console.log("✓ Daemon started");
          } else {
            console.log(`✗ ${startResult.message}`);
          }
        }
      }
    }
  } else {
    console.log("✗", result.message);
    Deno.exit(1);
  }
}

/** Tool definitions for the agent (static built-in tools only; MCP tools injected via getExtraTools). */
function getToolDefinitions(): readonly ToolDefinition[] {
  return [
    ...getTodoToolDefinitions(),
    ...getMemoryToolDefinitions(),
    ...getSecretToolDefinitions(),
    ...getWebToolDefinitions(),
    ...getPlanToolDefinitions(),
    ...getBrowserToolDefinitions(),
    ...getTidepoolToolDefinitions(),
    ...getSessionToolDefinitions(),
    ...getImageToolDefinitions(),
    ...getExploreToolDefinitions(),
    ...getGoogleToolDefinitions(),
    ...getGitHubToolDefinitions(),
    ...getObsidianToolDefinitions(),
    ...getLlmTaskToolDefinitions(),
    ...getSummarizeToolDefinitions(),
    ...getHealthcheckToolDefinitions(),
    ...getTriggerToolDefinitions(),
    ...getClaudeToolDefinitions(),
    ...getSkillToolDefinitions(),
    {
      name: "read_file",
      description: "Read the contents of a file at an absolute path.",
      parameters: {
        path: {
          type: "string",
          description: "Absolute file path to read",
          required: true,
        },
      },
    },
    {
      name: "write_file",
      description: "Write content to a file at a workspace-relative path.",
      parameters: {
        path: {
          type: "string",
          description: "Relative path in the workspace",
          required: true,
        },
        content: {
          type: "string",
          description: "File content to write",
          required: true,
        },
      },
    },
    {
      name: "list_directory",
      description: "List files and directories at a given absolute path.",
      parameters: {
        path: {
          type: "string",
          description: "Absolute directory path to list",
          required: true,
        },
      },
    },
    {
      name: "run_command",
      description: "Run a shell command in the agent workspace directory.",
      parameters: {
        command: {
          type: "string",
          description: "Shell command to execute",
          required: true,
        },
      },
    },
    {
      name: "search_files",
      description:
        "Search for files matching a glob pattern, or search file contents with grep.",
      parameters: {
        path: {
          type: "string",
          description: "Directory to search in",
          required: true,
        },
        pattern: {
          type: "string",
          description:
            "Glob pattern for file names, or text/regex to search within files",
          required: true,
        },
        content_search: {
          type: "boolean",
          description: "If true, search file contents instead of file names",
          required: false,
        },
      },
    },
    {
      name: "edit_file",
      description:
        "Replace a unique string in a file. old_text must appear exactly once in the file.",
      parameters: {
        path: {
          type: "string",
          description: "Absolute file path to edit",
          required: true,
        },
        old_text: {
          type: "string",
          description: "Exact text to find (must be unique in file)",
          required: true,
        },
        new_text: {
          type: "string",
          description: "Replacement text",
          required: true,
        },
      },
    },
    {
      name: "subagent",
      description:
        "Spawn a sub-agent for an autonomous multi-step task. Returns the result when complete.",
      parameters: {
        task: {
          type: "string",
          description: "What the sub-agent should accomplish",
          required: true,
        },
        tools: {
          type: "string",
          description:
            "Comma-separated tool whitelist (default: read-only tools)",
          required: false,
        },
      },
    },
    {
      name: "agents_list",
      description: "List configured LLM providers/agents.",
      parameters: {},
    },
    {
      name: "cron_create",
      description:
        "Create a scheduled cron job. The task runs on the given cron schedule.",
      parameters: {
        expression: {
          type: "string",
          description:
            "5-field cron expression (e.g. '0 9 * * *' for 9am daily)",
          required: true,
        },
        task: {
          type: "string",
          description: "The task/prompt to execute on each trigger",
          required: true,
        },
        classification: {
          type: "string",
          description:
            "Classification ceiling: PUBLIC, INTERNAL, CONFIDENTIAL, or RESTRICTED",
          required: false,
        },
      },
    },
    {
      name: "cron_list",
      description:
        "List all registered cron jobs with their schedules and status.",
      parameters: {},
    },
    {
      name: "cron_delete",
      description: "Delete a cron job by its ID.",
      parameters: {
        job_id: {
          type: "string",
          description: "The UUID of the cron job to delete",
          required: true,
        },
      },
    },
    {
      name: "cron_history",
      description: "Show recent execution history for a cron job.",
      parameters: {
        job_id: {
          type: "string",
          description: "The UUID of the cron job",
          required: true,
        },
      },
    },
  ];
}

/** Options for creating a tool executor. */
interface ToolExecutorOptions {
  readonly execTools: ReturnType<typeof createExecTools>;
  readonly cronManager?: CronManager;
  readonly todoManager?: TodoManager;
  readonly searchProvider?: SearchProvider;
  readonly webFetcher?: WebFetcher;
  readonly memoryExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly planExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly browserExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly tidepoolExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly providerRegistry?: LlmProviderRegistry;
  readonly sessionExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly imageExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly exploreExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly googleExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly githubExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly obsidianExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly llmTaskExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly summarizeExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly healthcheckExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly mcpExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly claudeExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly subagentFactory?: (task: string, tools?: string) => Promise<string>;
  readonly secretExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly triggerExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly skillExecutor?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
}

/**
 * Create a tool executor backed by ExecTools, direct filesystem access,
 * and optional subsystem executors for scheduling, planning, browser, etc.
 *
 * Tools that operate on absolute paths (read_file, list_directory, search_files)
 * use Deno APIs directly. Tools that operate on the workspace (write_file,
 * run_command) use ExecTools for sandboxing. Cron tools delegate to CronManager.
 */
function createToolExecutor(opts: ToolExecutorOptions): ToolExecutor {
  const { execTools, cronManager, searchProvider, webFetcher } = opts;
  const todoExecutor = opts.todoManager
    ? createTodoToolExecutor(opts.todoManager)
    : null;
  const webExecutor = createWebToolExecutor(searchProvider, webFetcher);

  // Inner dispatch — routes tool calls to the appropriate handler.
  const dispatch = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> => {
    // Try todo tools first (returns null if not a todo tool)
    if (todoExecutor) {
      const todoResult = await todoExecutor(name, input);
      if (todoResult !== null) return todoResult;
    }

    // Try memory tools (returns null if not a memory tool)
    if (opts.memoryExecutor) {
      const memoryResult = await opts.memoryExecutor(name, input);
      if (memoryResult !== null) return memoryResult;
    }

    // Try plan tools (returns null if not a plan tool)
    if (opts.planExecutor) {
      const planResult = await opts.planExecutor(name, input);
      if (planResult !== null) return planResult;
    }

    // Try browser tools (returns null if not a browser tool)
    if (opts.browserExecutor) {
      const browserResult = await opts.browserExecutor(name, input);
      if (browserResult !== null) return browserResult;
    }

    // Try tidepool tools (returns null if not a tidepool tool)
    if (opts.tidepoolExecutor) {
      const tidepoolResult = await opts.tidepoolExecutor(name, input);
      if (tidepoolResult !== null) return tidepoolResult;
    }

    // Try session tools (returns null if not a session tool)
    if (opts.sessionExecutor) {
      const sessionResult = await opts.sessionExecutor(name, input);
      if (sessionResult !== null) return sessionResult;
    }

    // Try image tools (returns null if not an image tool)
    if (opts.imageExecutor) {
      const imageResult = await opts.imageExecutor(name, input);
      if (imageResult !== null) return imageResult;
    }

    // Try explore tools (returns null if not an explore tool)
    if (opts.exploreExecutor) {
      const exploreResult = await opts.exploreExecutor(name, input);
      if (exploreResult !== null) return exploreResult;
    }

    // Try Google Workspace tools (returns null if not a Google tool)
    if (opts.googleExecutor) {
      const googleResult = await opts.googleExecutor(name, input);
      if (googleResult !== null) return googleResult;
    }

    // Try GitHub tools (returns null if not a github tool)
    if (opts.githubExecutor) {
      const githubResult = await opts.githubExecutor(name, input);
      if (githubResult !== null) return githubResult;
    }

    // Try obsidian tools (returns null if not an obsidian tool)
    if (opts.obsidianExecutor) {
      const obsidianResult = await opts.obsidianExecutor(name, input);
      if (obsidianResult !== null) return obsidianResult;
    }

    // Try llm_task tool (returns null if not llm_task)
    if (opts.llmTaskExecutor) {
      const llmTaskResult = await opts.llmTaskExecutor(name, input);
      if (llmTaskResult !== null) return llmTaskResult;
    }

    // Try summarize tool (returns null if not summarize)
    if (opts.summarizeExecutor) {
      const summarizeResult = await opts.summarizeExecutor(name, input);
      if (summarizeResult !== null) return summarizeResult;
    }

    // Try healthcheck tool (returns null if not healthcheck)
    if (opts.healthcheckExecutor) {
      const healthcheckResult = await opts.healthcheckExecutor(name, input);
      if (healthcheckResult !== null) return healthcheckResult;
    }

    // Try Claude session tools (returns null if not a claude tool)
    if (opts.claudeExecutor) {
      const claudeResult = await opts.claudeExecutor(name, input);
      if (claudeResult !== null) return claudeResult;
    }

    // Try MCP server tools (returns null if not an MCP tool)
    if (opts.mcpExecutor) {
      const mcpResult = await opts.mcpExecutor(name, input);
      if (mcpResult !== null) return mcpResult;
    }

    // Try secret tools (returns null if not a secret tool)
    if (opts.secretExecutor) {
      const secretResult = await opts.secretExecutor(name, input);
      if (secretResult !== null) return secretResult;
    }

    // Try trigger context tools (returns null if not a trigger tool)
    if (opts.triggerExecutor) {
      const triggerResult = await opts.triggerExecutor(name, input);
      if (triggerResult !== null) return triggerResult;
    }

    // Try skill tools (returns null if not a skill tool)
    if (opts.skillExecutor) {
      const skillResult = await opts.skillExecutor(name, input);
      if (skillResult !== null) return skillResult;
    }

    // Try web tools (returns null if not a web tool)
    const webResult = await webExecutor(name, input);
    if (webResult !== null) return webResult;

    switch (name) {
      case "read_file": {
        const path = input.path;
        if (typeof path !== "string" || path.length === 0) {
          return "Error: read_file requires a 'path' argument (string).";
        }
        try {
          const content = await Deno.readTextFile(path);
          return content;
        } catch (err) {
          return `Error reading file: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      case "write_file": {
        const path = input.path;
        const content = input.content;
        if (typeof path !== "string" || path.length === 0) {
          return "Error: write_file requires a 'path' argument (string).";
        }
        if (typeof content !== "string") {
          return "Error: write_file requires a 'content' argument (string).";
        }
        const result = await execTools.write(path, content);
        return result.ok
          ? `Wrote ${result.value.bytesWritten} bytes to ${result.value.path}`
          : `Error: ${result.error}`;
      }

      case "list_directory": {
        const path = input.path;
        if (typeof path !== "string" || path.length === 0) {
          return "Error: list_directory requires a 'path' argument (string).";
        }
        try {
          const entries: string[] = [];
          for await (const entry of Deno.readDir(path)) {
            const suffix = entry.isDirectory ? "/" : "";
            entries.push(`${entry.name}${suffix}`);
          }
          return entries.length > 0 ? entries.join("\n") : "(empty directory)";
        } catch (err) {
          return `Error listing directory: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      case "run_command": {
        const command = input.command ?? input.cmd;
        if (typeof command !== "string" || command.length === 0) {
          return "Error: run_command requires a 'command' argument (string).";
        }
        const result = await execTools.run(command);
        if (!result.ok) return `Error: ${result.error}`;
        const out = result.value;
        const parts: string[] = [];
        if (out.stdout) parts.push(out.stdout);
        if (out.stderr) parts.push(`[stderr] ${out.stderr}`);
        parts.push(
          `[exit code: ${out.exitCode}, ${Math.round(out.duration)}ms]`,
        );
        return parts.join("\n");
      }

      case "search_files": {
        const searchPath = input.path;
        const pattern = input.pattern;
        if (typeof searchPath !== "string" || searchPath.length === 0) {
          return "Error: search_files requires a 'path' argument (string).";
        }
        if (typeof pattern !== "string" || pattern.length === 0) {
          return "Error: search_files requires a 'pattern' argument (string).";
        }
        const contentSearch = input.content_search === true;
        try {
          if (contentSearch) {
            // Use grep-style search
            const proc = new Deno.Command("grep", {
              args: ["-rl", pattern, searchPath],
              stdout: "piped",
              stderr: "piped",
            });
            const output = await proc.output();
            const stdout = new TextDecoder().decode(output.stdout).trim();
            return stdout.length > 0 ? stdout : "No matches found.";
          } else {
            // Use find with glob
            const proc = new Deno.Command("find", {
              args: [searchPath, "-name", pattern, "-type", "f"],
              stdout: "piped",
              stderr: "piped",
            });
            const output = await proc.output();
            const stdout = new TextDecoder().decode(output.stdout).trim();
            return stdout.length > 0
              ? stdout
              : "No files found matching pattern.";
          }
        } catch (err) {
          return `Error searching: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      case "edit_file": {
        const path = input.path;
        const oldText = input.old_text;
        const newText = input.new_text;
        if (typeof path !== "string" || path.length === 0) {
          return "Error: edit_file requires a 'path' argument (string).";
        }
        if (typeof oldText !== "string" || oldText.length === 0) {
          return "Error: edit_file requires a non-empty 'old_text' argument (string).";
        }
        if (typeof newText !== "string") {
          return "Error: edit_file requires a 'new_text' argument (string).";
        }
        try {
          const content = await Deno.readTextFile(path);
          const count = content.split(oldText).length - 1;
          if (count === 0) {
            return "Error: old_text not found in file.";
          }
          if (count > 1) {
            return `Error: old_text appears ${count} times (must be exactly 1). Provide a larger unique snippet.`;
          }
          const updated = content.replace(oldText, newText);
          await Deno.writeTextFile(path, updated);
          return `Edited ${path} (${updated.length} bytes written)`;
        } catch (err) {
          return `Error editing file: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      case "subagent": {
        if (!opts.subagentFactory) {
          return "Sub-agent spawning is not available in this context.";
        }
        const task = input.task;
        if (typeof task !== "string" || task.length === 0) {
          return "Error: subagent requires a non-empty 'task' argument (string).";
        }
        const toolsArg = typeof input.tools === "string"
          ? input.tools
          : undefined;
        try {
          return await opts.subagentFactory(task, toolsArg);
        } catch (err) {
          return `Error spawning sub-agent: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      case "agents_list": {
        if (!opts.providerRegistry) {
          return "No provider registry available.";
        }
        const defaultProvider = opts.providerRegistry.getDefault();
        return JSON.stringify({
          default: defaultProvider?.name ?? "none",
          note:
            "Use 'llm_task' with 'model' parameter to target a specific provider.",
        });
      }

      case "cron_create": {
        if (!cronManager) {
          return "Cron management is not available in this context.";
        }
        const expression = input.expression as string;
        const task = input.task as string;
        const classification = (input.classification as string) ?? "INTERNAL";
        const result = cronManager.create({
          expression,
          task,
          classificationCeiling: classification as ClassificationLevel,
        });
        if (!result.ok) return `Error creating cron job: ${result.error}`;
        const job = result.value;
        return `Created cron job:\n  ID: ${job.id}\n  Schedule: ${job.expression}\n  Task: ${job.task}\n  Classification: ${job.classificationCeiling}\n  Created: ${job.createdAt.toISOString()}`;
      }

      case "cron_list": {
        if (!cronManager) {
          return "Cron management is not available in this context.";
        }
        const jobs = cronManager.list();
        if (jobs.length === 0) return "No cron jobs registered.";
        return jobs.map((j) =>
          `${j.id}\n  Schedule: ${j.expression}\n  Task: ${j.task}\n  Enabled: ${j.enabled}\n  Classification: ${j.classificationCeiling}\n  Created: ${j.createdAt.toISOString()}`
        ).join("\n\n");
      }

      case "cron_delete": {
        if (!cronManager) {
          return "Cron management is not available in this context.";
        }
        const jobId = input.job_id as string;
        const result = cronManager.delete(jobId);
        return result.ok
          ? `Deleted cron job ${jobId}`
          : `Error: ${result.error}`;
      }

      case "cron_history": {
        if (!cronManager) {
          return "Cron management is not available in this context.";
        }
        const jobId = input.job_id as string;
        const hist = cronManager.history(jobId);
        if (hist.length === 0) return "No execution history for this job.";
        return hist.slice(-10).map((e) =>
          `${e.executedAt.toISOString()} — ${e.success ? "SUCCESS" : "FAILED"}${
            e.error ? ` (${e.error})` : ""
          } [${Math.round(e.durationMs)}ms]`
        ).join("\n");
      }

      default:
        return `Unknown tool: ${name}`;
    }
  };

  return dispatch;
}

/**
 * Run an interactive chat REPL.
 *
 * Connects to the daemon's gateway WebSocket at /chat for the shared
 * session. All terminal UI (raw mode, scroll regions, keypress reader,
 * input history, suggestions, ESC interrupt, Ctrl+O toggle) is preserved.
 * The daemon owns the session, orchestrator, and policy engine.
 */
async function runChat(): Promise<void> {
  const configPath = resolveConfigPath();

  // Load config (for banner display only)
  const configResult = loadConfig(configPath);
  if (!configResult.ok) {
    console.log(`Configuration error: ${configResult.error}`);
    console.log("Run 'triggerfish dive' to fix your configuration.\n");
    Deno.exit(1);
  }

  const config = configResult.value;
  const baseDir = resolveBaseDir();
  const dataDir = join(baseDir, "data");
  await Deno.mkdir(dataDir, { recursive: true });

  // Connect to the daemon's chat WebSocket
  const gatewayUrl = "ws://127.0.0.1:18789/chat";
  let ws: WebSocket;
  try {
    ws = new WebSocket(gatewayUrl);
  } catch {
    console.log("Cannot connect to daemon. Is it running?");
    console.log("Run 'triggerfish start' or 'triggerfish run' first.\n");
    Deno.exit(1);
    return;
  }

  // Wait for connection + connected event
  let providerName = "unknown";
  let _modelName = "";
  const connected = Promise.withResolvers<void>();

  ws.addEventListener("error", () => {
    console.log("Cannot connect to daemon. Is it running?");
    console.log("Run 'triggerfish start' or 'triggerfish run' first.\n");
    Deno.exit(1);
  });

  ws.addEventListener("open", () => {
    // Connection established, wait for "connected" event
  });

  // Determine if we're in TTY mode
  const isTty = Deno.stdin.isTerminal();

  // Set up display mode toggle (Ctrl+O)
  let displayMode: ToolDisplayMode = "compact";
  const getDisplayMode = (): ToolDisplayMode => displayMode;

  // Set up screen manager
  const screen = createScreenManager();

  // Create event handler — use screen-aware handler for TTY, legacy for pipes
  const eventHandler = isTty
    ? createScreenEventHandler(screen, getDisplayMode)
    : createEventHandler();

  // State tracking
  const state = { isProcessing: false };
  const messageQueue: string[] = [];

  // Password mode state — active when the daemon sends a secret_prompt event.
  // While active, keypress input collects characters for the secret value
  // instead of the normal line editor.
  interface PasswordModeState {
    readonly nonce: string;
    readonly name: string;
    readonly hint?: string;
    readonly chars: string[];
  }
  let passwordMode: PasswordModeState | null = null;

  /** Send the next queued message (if any). */
  function drainQueue(): void {
    if (messageQueue.length === 0) return;
    const next = messageQueue.shift()!;
    screen.writeOutput(`  ${taintColor(screen.getTaint())}\x1b[1m❯\x1b[0m ${next}`);
    screen.writeOutput(`  \x1b[2m(queued)\x1b[0m`);
    screen.writeOutput("");
    state.isProcessing = true;
    try {
      ws.send(JSON.stringify({ type: "message", content: next }));
    } catch {
      screen.writeOutput(formatError("Lost connection to daemon"));
      state.isProcessing = false;
      screen.redrawInput(editor);
    }
  }

  // Route incoming WebSocket events to the event handler
  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      const data = typeof event.data === "string"
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
      const evt = JSON.parse(data) as ChatEvent;

      if (evt.type === "connected") {
        providerName = evt.provider;
        _modelName = evt.model;
        if (evt.taint) {
          screen.setTaint(evt.taint);
        }
        connected.resolve();
        return;
      }

      if (evt.type === "taint_changed") {
        screen.setTaint(evt.level);
        if (isTty) screen.redrawInput(editor);
        return;
      }

      if (evt.type === "mcp_status") {
        if (isTty) {
          screen.setMcpStatus(evt.connected, evt.configured);
          screen.redrawInput(editor);
        }
        return;
      }

      if (evt.type === "secret_prompt") {
        if (isTty) {
          // Enter password mode — capture keystrokes for the secret value
          passwordMode = {
            nonce: evt.nonce,
            name: evt.name,
            hint: evt.hint,
            chars: [],
          };
          screen.stopSpinner();
          const hintStr = evt.hint ? ` (${evt.hint})` : "";
          screen.writeOutput(`  \x1b[33m\u{1f512} Enter value for '${evt.name}'${hintStr}\x1b[0m`);
          screen.setStatus("\u{1f512} Type secret, Enter to submit, Esc to cancel");
          screen.redrawInput(editor);
        }
        // Non-TTY path is handled in runSimpleWsRepl
        return;
      }

      if (evt.type === "error") {
        if (isTty) {
          screen.stopSpinner();
          screen.writeOutput(formatError(evt.message));
          screen.writeOutput("");
          screen.redrawInput(editor);
        } else {
          renderError(evt.message);
          renderPrompt();
        }
        state.isProcessing = false;
        drainQueue();
        return;
      }

      if (evt.type === "compact_start") {
        if (isTty) {
          screen.startSpinner("Summarizing history...");
        } else {
          console.log("  Summarizing history...");
        }
        return;
      }

      if (evt.type === "compact_complete") {
        const saved = evt.tokensBefore - evt.tokensAfter;
        const msg =
          `  Compacted: ${evt.messagesBefore} → ${evt.messagesAfter} messages (saved ~${saved} tokens)`;
        if (isTty) {
          screen.stopSpinner();
          screen.writeOutput(msg);
          screen.redrawInput(editor);
        } else {
          console.log(msg);
          renderPrompt();
        }
        return;
      }

      if (evt.type === "response_chunk") {
        eventHandler(evt as OrchestratorEvent);
        if (isTty) screen.redrawInput(editor);
        return;
      }

      if (evt.type === "response") {
        // The event handler will render the response text
        eventHandler(evt as OrchestratorEvent);
        state.isProcessing = false;
        if (isTty) {
          screen.writeOutput("");
          screen.redrawInput(editor);
        } else {
          renderPrompt();
        }
        drainQueue();
        return;
      }

      // Forward all other events (llm_start, llm_complete, tool_call, tool_result)
      eventHandler(evt as OrchestratorEvent);
      if (isTty) {
        screen.redrawInput(editor);
      }
    } catch {
      // Ignore parse errors
    }
  });

  // Handle WebSocket close
  ws.addEventListener("close", () => {
    if (isTty) {
      screen.writeOutput("  \x1b[31mDisconnected from daemon.\x1b[0m");
      screen.writeOutput("");
      screen.redrawInput(editor);
    } else {
      console.log("\n  Disconnected from daemon.\n");
    }
    state.isProcessing = false;
  });

  // Wait for the connected event before showing UI
  // Timeout after 5 seconds
  const timeout = setTimeout(() => {
    console.log("Timed out waiting for daemon. Is it running?");
    console.log("Run 'triggerfish start' or 'triggerfish run' first.\n");
    ws.close();
    Deno.exit(1);
  }, 5000);
  await connected.promise;
  clearTimeout(timeout);

  // Load input history
  const historyFilePath = join(dataDir, "input_history.json");
  let inputHistory = await loadInputHistory(historyFilePath);

  // Set up suggestion engine
  const suggestionEngine = createSuggestionEngine();

  // If not a TTY, fall back to the simple line-buffered REPL
  if (!isTty) {
    printBanner(providerName, config.models.primary.model, "");
    await runSimpleWsRepl(ws, providerName, config);
    return;
  }

  // ─── TTY mode: raw terminal with scroll regions ──────────────

  // Print banner via screen manager
  screen.init();
  screen.writeOutput(
    formatBanner(providerName, config.models.primary.model, ""),
  );

  // Create keypress reader and line editor
  const keypressReader = createKeypressReader();
  let editor: LineEditor = createLineEditor();
  let stashedInput = ""; // Stash current input when entering history navigation
  let pendingImages: ImageContentBlock[] = []; // Images pasted with Ctrl+V, sent with next message

  // Cleanup function — must run on exit
  function cleanup(): void {
    keypressReader.stop();
    screen.cleanup();
    saveInputHistory(historyFilePath, inputHistory).catch(() => {});
    try {
      ws.close();
    } catch { /* already closed */ }
  }

  // Handle SIGINT (Ctrl+C from outside raw mode, e.g. kill signal)
  try {
    Deno.addSignalListener("SIGINT", () => {
      if (state.isProcessing) {
        try {
          ws.send(JSON.stringify({ type: "cancel" }));
        } catch { /* ignore */ }
        screen.writeOutput(`  \x1b[33m⚠ Interrupted\x1b[0m`);
      } else {
        cleanup();
        Deno.exit(0);
      }
    });
  } catch {
    // Signal listeners may not be supported on all platforms
  }

  // Handle terminal resize — SIGWINCH on Unix, polling fallback on Windows
  const resizeHandler = () => {
    screen.handleResize();
    screen.redrawInput(editor);
  };
  try {
    Deno.addSignalListener("SIGWINCH", resizeHandler);
  } catch {
    // SIGWINCH not supported (Windows/PowerShell) — poll for size changes
    screen.startResizePolling(resizeHandler);
  }

  // Draw initial input prompt
  screen.redrawInput(editor);

  // Start reading keypresses
  keypressReader.start();

  let lastCtrlCTime = 0;

  for await (const keypress of keypressReader) {
    // ─── Interrupt keys (work in any mode) ──────────────────
    if (keypress.key === "esc" && state.isProcessing) {
      try {
        ws.send(JSON.stringify({ type: "cancel" }));
      } catch { /* ignore */ }
      screen.writeOutput(`  \x1b[33m⚠ Interrupted\x1b[0m`);
      continue;
    }

    if (keypress.key === "ctrl+c") {
      if (state.isProcessing) {
        const now = Date.now();
        if (now - lastCtrlCTime < 1000) {
          cleanup();
          return;
        }
        lastCtrlCTime = now;
        try {
          ws.send(JSON.stringify({ type: "cancel" }));
        } catch { /* ignore */ }
        screen.writeOutput(
          `  \x1b[33m⚠ Interrupted (Ctrl+C again to exit)\x1b[0m`,
        );
      } else {
        cleanup();
        return;
      }
      continue;
    }

    // ─── Password mode (secret_prompt active) ─────────────
    if (passwordMode !== null) {
      const pm: PasswordModeState = passwordMode; // capture for TypeScript narrowing
      if (keypress.key === "enter") {
        // Submit the secret value
        const value = pm.chars.join("");
        try {
          ws.send(JSON.stringify({
            type: "secret_prompt_response",
            nonce: pm.nonce,
            value,
          }));
        } catch { /* ignore */ }
        screen.writeOutput(`  \x1b[32m\u2713 Secret submitted\x1b[0m`);
        screen.clearStatus();
        passwordMode = null;
        screen.redrawInput(editor);
        continue;
      }
      if (keypress.key === "esc" || keypress.key === "ctrl+c") {
        // Cancel the secret prompt
        try {
          ws.send(JSON.stringify({
            type: "secret_prompt_response",
            nonce: pm.nonce,
            value: null,
          }));
        } catch { /* ignore */ }
        screen.writeOutput(`  \x1b[33m\u2717 Secret entry cancelled\x1b[0m`);
        screen.clearStatus();
        passwordMode = null;
        screen.redrawInput(editor);
        continue;
      }
      if (keypress.key === "backspace") {
        if (pm.chars.length > 0) {
          pm.chars.pop();
          const masked = "\u25cf".repeat(pm.chars.length);
          screen.setStatus(`\u{1f512} ${pm.name}: ${masked}`);
        }
        continue;
      }
      // Printable character → accumulate
      if (keypress.char !== null) {
        pm.chars.push(keypress.char);
        const masked = "\u25cf".repeat(pm.chars.length);
        screen.setStatus(`\u{1f512} ${pm.name}: ${masked}`);
        continue;
      }
      // Ignore all other keys in password mode
      continue;
    }

    // ─── Input handling (works in both idle and processing) ─
    switch (keypress.key) {
      case "shift+enter": {
        // Insert newline for multi-line input
        editor = editor.insert("\n");
        editor = editor.setSuggestion("");
        screen.redrawInput(editor);
        break;
      }

      case "enter": {
        const text = editor.text.trim();

        if (text.length === 0) {
          break;
        }

        // Echo the submitted text into the output region
        const displayText = text.includes("\n")
          ? text.split("\n").join(`\n  ${"\x1b[2m"}·\x1b[0m `)
          : text;
        screen.writeOutput(`  ${taintColor(screen.getTaint())}\x1b[1m❯\x1b[0m ${displayText}`);
        screen.writeOutput("");

        // Add to history and save
        inputHistory = inputHistory.push(text);
        inputHistory = inputHistory.resetNavigation();
        saveInputHistory(historyFilePath, inputHistory).catch(() => {});

        // Clear editor
        editor = editor.clear();
        screen.redrawInput(editor);
        stashedInput = "";

        // Handle slash commands locally (only in idle mode)
        if (!state.isProcessing) {
          if (text === "/quit" || text === "/exit" || text === "/q") {
            screen.writeOutput("  Goodbye.");
            cleanup();
            return;
          }

          if (text === "/clear") {
            ws.send(JSON.stringify({ type: "clear" }));
            screen.setTaint("PUBLIC");
            screen.cleanup();
            screen.init();
            screen.writeOutput(
              formatBanner(providerName, config.models.primary.model, ""),
            );
            screen.redrawInput(editor);
            break;
          }

          if (text === "/help") {
            screen.writeOutput(
              "  Commands:\n" +
                "    /quit, /exit, /q     — Exit chat\n" +
                "    /clear               — Clear screen\n" +
                "    /compact             — Summarize conversation history\n" +
                "    /verbose             — Toggle tool display detail\n" +
                "    /help                — Show this help\n" +
                "    Ctrl+V               — Paste image from clipboard\n" +
                "    Ctrl+O               — Toggle tool display mode\n" +
                "    ESC                  — Interrupt current operation\n" +
                "    Shift+Enter          — New line in message\n" +
                "    Up/Down              — Navigate input history\n" +
                "    Tab                  — Accept suggestion",
            );
            break;
          }

          if (text === "/verbose") {
            displayMode = displayMode === "compact" ? "expanded" : "compact";
            screen.writeOutput(`  Tool display: ${displayMode}`);
            break;
          }

          if (text === "/compact") {
            screen.writeOutput("  Compacting conversation history...");
            ws.send(JSON.stringify({ type: "compact" }));
            break;
          }

          // Build message content — multimodal if images are pending
          let messageContent: MessageContent = text;
          if (pendingImages.length > 0) {
            const blocks: ContentBlock[] = [
              ...pendingImages,
              { type: "text" as const, text },
            ];
            messageContent = blocks;
            pendingImages = [];
          }

          // Send message to daemon via WebSocket
          state.isProcessing = true;
          try {
            ws.send(
              JSON.stringify({ type: "message", content: messageContent }),
            );
          } catch {
            screen.writeOutput(formatError("Lost connection to daemon"));
            state.isProcessing = false;
            screen.writeOutput("");
            screen.redrawInput(editor);
          }
        } else {
          // Processing mode — queue the message
          messageQueue.push(text);
          screen.writeOutput(
            `  \x1b[2m(queued — will send after current response)\x1b[0m`,
          );
        }

        break;
      }

      case "backspace":
        editor = editor.backspace();
        updateSuggestion();
        screen.redrawInput(editor);
        break;

      case "delete":
        editor = editor.deleteChar();
        updateSuggestion();
        screen.redrawInput(editor);
        break;

      case "left":
        editor = editor.moveCursor("left");
        screen.redrawInput(editor);
        break;

      case "right":
        editor = editor.moveCursor("right");
        screen.redrawInput(editor);
        break;

      case "home":
      case "ctrl+a":
        editor = editor.moveCursor("home");
        screen.redrawInput(editor);
        break;

      case "end":
      case "ctrl+e":
        editor = editor.moveCursor("end");
        screen.redrawInput(editor);
        break;

      case "up": {
        // Stash current input when first entering history
        if (inputHistory.index === -1 && editor.text.length > 0) {
          stashedInput = editor.text;
        }
        inputHistory = inputHistory.up();
        const histText = inputHistory.current();
        if (histText !== null) {
          editor = editor.setText(histText);
          editor = editor.setSuggestion("");
          screen.redrawInput(editor);
        }
        break;
      }

      case "down": {
        inputHistory = inputHistory.down();
        const histText = inputHistory.current();
        if (histText !== null) {
          editor = editor.setText(histText);
        } else {
          // Back to fresh input — restore stashed text
          editor = editor.setText(stashedInput);
          stashedInput = "";
        }
        editor = editor.setSuggestion("");
        screen.redrawInput(editor);
        break;
      }

      case "tab":
        editor = editor.acceptSuggestion();
        screen.redrawInput(editor);
        break;

      case "ctrl+v": {
        // Paste image from clipboard
        const clipResult = await readClipboardImage();
        if (clipResult.ok) {
          const img = imageBlock(
            clipResult.value.data,
            clipResult.value.mimeType,
          );
          pendingImages.push(img);
          const sizeKb = (clipResult.value.data.length / 1024).toFixed(1);
          screen.setStatus(
            `Image pasted (${clipResult.value.mimeType}, ${sizeKb}KB) — will send with next message`,
          );
          setTimeout(() => screen.clearStatus(), 3000);
        } else {
          screen.setStatus(clipResult.error);
          setTimeout(() => screen.clearStatus(), 3000);
        }
        break;
      }

      case "ctrl+o":
        displayMode = displayMode === "compact" ? "expanded" : "compact";
        screen.setStatus(`Display: ${displayMode}`);
        setTimeout(() => screen.clearStatus(), 1500);
        break;

      case "ctrl+d":
        if (editor.text.length === 0) {
          cleanup();
          return;
        }
        break;

      case "ctrl+u":
        // Clear line
        editor = editor.clear();
        screen.redrawInput(editor);
        break;

      case "ctrl+w": {
        // Delete word backwards
        const text = editor.text;
        let cursor = editor.cursor;
        // Skip trailing spaces
        while (cursor > 0 && text[cursor - 1] === " ") cursor--;
        // Delete to previous space
        while (cursor > 0 && text[cursor - 1] !== " ") cursor--;
        editor = editor.setText(
          text.slice(0, cursor) + text.slice(editor.cursor),
        );
        screen.redrawInput(editor);
        break;
      }

      case "esc":
        // ESC in idle mode — ignore
        break;

      default:
        // Printable character
        if (keypress.char !== null) {
          editor = editor.insert(keypress.char);
          inputHistory = inputHistory.resetNavigation();
          stashedInput = "";
          updateSuggestion();
          screen.redrawInput(editor);
        }
        break;
    }
  }

  // EOF reached
  cleanup();

  /** Update the suggestion based on current editor text. */
  function updateSuggestion(): void {
    const suggestion = suggestionEngine.suggest(
      editor.text,
      inputHistory.entries as string[],
    );
    if (suggestion) {
      const remainder = suggestion.slice(editor.text.length);
      editor = editor.setSuggestion(remainder);
    } else {
      editor = editor.setSuggestion("");
    }
  }
}

/**
 * Simple line-buffered REPL for non-TTY environments (piped input).
 *
 * Connects to the daemon via WebSocket. Falls back to the original
 * stdin.read() approach for compatibility with piped input.
 */
async function runSimpleWsRepl(
  ws: WebSocket,
  providerName: string,
  config: TriggerFishConfig,
): Promise<void> {
  const decoder = new TextDecoder();
  const buf = new Uint8Array(8192);
  let partial = "";

  renderPrompt();

  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;

    partial += decoder.decode(buf.subarray(0, n));

    let newlineIdx: number;
    while ((newlineIdx = partial.indexOf("\n")) !== -1) {
      const line = partial.slice(0, newlineIdx).trimEnd();
      partial = partial.slice(newlineIdx + 1);

      if (line === "/quit" || line === "/exit" || line === "/q") {
        console.log("\n  Goodbye.\n");
        ws.close();
        return;
      }

      if (line === "/clear") {
        ws.send(JSON.stringify({ type: "clear" }));
        console.log("\x1b[2J\x1b[H");
        printBanner(providerName, config.models.primary.model, "");
        renderPrompt();
        continue;
      }

      if (line === "/compact") {
        console.log("  Compacting conversation history...");
        ws.send(JSON.stringify({ type: "compact" }));
        // compact_start/compact_complete handled by the main event handler
        renderPrompt();
        continue;
      }

      if (line.length === 0) {
        renderPrompt();
        continue;
      }

      // Send to daemon and wait for response
      console.log();
      const responsePromise = Promise.withResolvers<void>();

      const handler = async (event: MessageEvent) => {
        try {
          const data = typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
          const evt = JSON.parse(data) as ChatEvent;

          // Handle secret prompt in non-TTY mode: read a line from stdin
          if (evt.type === "secret_prompt") {
            const hintStr = evt.hint ? ` (${evt.hint})` : "";
            const enc = new TextEncoder();
            Deno.stderr.writeSync(enc.encode(`  Enter value for '${evt.name}'${hintStr}: `));
            const lineBuf = new Uint8Array(4096);
            const nRead = await Deno.stdin.read(lineBuf);
            const value = nRead !== null
              ? new TextDecoder().decode(lineBuf.subarray(0, nRead)).trimEnd()
              : null;
            try {
              ws.send(JSON.stringify({
                type: "secret_prompt_response",
                nonce: evt.nonce,
                value: value && value.length > 0 ? value : null,
              }));
            } catch { /* ignore */ }
            return;
          }

          if (evt.type === "response" || evt.type === "error") {
            if (evt.type === "error") {
              renderError(evt.message);
            }
            ws.removeEventListener("message", handler);
            responsePromise.resolve();
          }
        } catch {
          // ignore
        }
      };

      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ type: "message", content: line }));
      await responsePromise.promise;

      renderPrompt();
    }
  }
  ws.close();
}

/**
 * Manage cron jobs via CLI subcommands.
 */
async function runCron(
  subcommand: string | undefined,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const baseDir = resolveBaseDir();
  const dataDir = join(baseDir, "data");
  await Deno.mkdir(dataDir, { recursive: true });
  const storage = createSqliteStorage(join(dataDir, "triggerfish.db"));
  const cronManager = await createPersistentCronManager(storage);

  try {
    switch (subcommand) {
      case "add": {
        const expression = flags.expression as string | undefined;
        const task = flags.task as string | undefined;
        if (!expression || !task) {
          console.log(
            'Usage: triggerfish cron add "<schedule>" <task description>',
          );
          console.log(
            'Example: triggerfish cron add "0 9 * * *" morning briefing',
          );
          Deno.exit(1);
        }
        const rawClassification = typeof flags.classification === "string"
          ? flags.classification
          : "INTERNAL";
        const parsedLevel = parseClassification(rawClassification);
        if (!parsedLevel.ok) {
          console.log(`Invalid classification: ${rawClassification}`);
          console.log(
            "Valid levels: PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED",
          );
          Deno.exit(1);
        }
        const result = cronManager.create({
          expression,
          task,
          classificationCeiling: parsedLevel.value,
        });
        if (!result.ok) {
          console.log(`Error: ${result.error}`);
          Deno.exit(1);
        }
        const job = result.value;
        console.log(`Created cron job:`);
        console.log(`  ID:             ${job.id}`);
        console.log(`  Schedule:       ${job.expression}`);
        console.log(`  Task:           ${job.task}`);
        console.log(`  Classification: ${job.classificationCeiling}`);
        console.log(`  Created:        ${job.createdAt.toISOString()}`);
        break;
      }

      case "list": {
        const jobs = cronManager.list();
        if (jobs.length === 0) {
          console.log("No cron jobs registered.");
          console.log(
            '\nCreate one with: triggerfish cron add "0 9 * * *" your task here',
          );
          break;
        }
        console.log(`${jobs.length} cron job(s):\n`);
        for (const job of jobs) {
          const hist = cronManager.history(job.id);
          const lastRun = hist.length > 0
            ? hist[hist.length - 1].executedAt.toISOString()
            : "never";
          console.log(`  ${job.enabled ? "+" : "-"} ${job.id}`);
          console.log(`    Schedule: ${job.expression}`);
          console.log(`    Task:     ${job.task}`);
          console.log(`    Ceiling:  ${job.classificationCeiling}`);
          console.log(`    Last run: ${lastRun}`);
          console.log(`    Runs:     ${hist.length}`);
          console.log();
        }
        break;
      }

      case "delete": {
        const jobId = flags.job_id as string | undefined;
        if (!jobId) {
          console.log("Usage: triggerfish cron delete <job_id>");
          Deno.exit(1);
        }
        const result = cronManager.delete(jobId);
        if (!result.ok) {
          console.log(`Error: ${result.error}`);
          Deno.exit(1);
        }
        console.log(`Deleted cron job ${jobId}`);
        break;
      }

      case "history": {
        const jobId = flags.job_id as string | undefined;
        if (!jobId) {
          console.log("Usage: triggerfish cron history <job_id>");
          Deno.exit(1);
        }
        const hist = cronManager.history(jobId);
        if (hist.length === 0) {
          console.log("No execution history for this job.");
          break;
        }
        console.log(`Last ${Math.min(hist.length, 20)} execution(s):\n`);
        for (const e of hist.slice(-20)) {
          const status = e.success ? "OK" : "FAIL";
          const dur = Math.round(e.durationMs);
          const err = e.error ? ` — ${e.error}` : "";
          console.log(
            `  ${e.executedAt.toISOString()}  ${status}  ${dur}ms${err}`,
          );
        }
        break;
      }

      default:
        console.log("Usage: triggerfish cron <add|list|delete|history>");
        console.log("\nSubcommands:");
        console.log('  add "<schedule>" <task>   Create a new cron job');
        console.log("  list                      List all cron jobs");
        console.log("  delete <job_id>           Delete a cron job");
        console.log("  history <job_id>          Show execution history");
        break;
    }
  } finally {
    await storage.close();
  }
}

// ─── Google Workspace connect / disconnect ──────────────────────────────────

/**
 * Handle `triggerfish connect <service>`.
 */
async function runConnect(
  subcommand: string | undefined,
  _flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  switch (subcommand) {
    case "google":
      await runConnectGoogle();
      break;
    case "github":
      await runConnectGithub();
      break;
    default:
      console.log(`
CONNECT USAGE:
  triggerfish connect google    Authenticate with Google Workspace
  triggerfish connect github    Authenticate with GitHub
`);
      break;
  }
}

/** HTML page shown after successful OAuth callback. */
const OAUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Triggerfish</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
.card{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
h1{color:#22c55e;margin-bottom:0.5rem}p{color:#666}</style></head>
<body><div class="card"><h1>Connected</h1><p>Google account linked to Triggerfish.<br>You can close this window.</p></div></body></html>`;

/**
 * Create a temporary localhost server that captures the OAuth callback code.
 *
 * Returns the server, its port, and a promise that resolves with the auth code.
 */
function createOAuthCallbackServer(): {
  server: Deno.HttpServer;
  port: number;
  codePromise: Promise<string>;
} {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) => {
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        rejectCode(new Error(`Google returned error: ${error}`));
        return new Response(
          "Authorization failed. You can close this window.",
          {
            status: 400,
            headers: { "Content-Type": "text/plain" },
          },
        );
      }

      if (code) {
        resolveCode(code);
        return new Response(OAUTH_SUCCESS_HTML, {
          headers: { "Content-Type": "text/html" },
        });
      }

      return new Response("Waiting for OAuth callback...", {
        headers: { "Content-Type": "text/plain" },
      });
    },
  );

  const addr = server.addr as Deno.NetAddr;

  // 5-minute timeout
  const timeout = setTimeout(() => {
    rejectCode(new Error("OAuth callback timed out after 5 minutes"));
  }, 5 * 60 * 1000);

  // Clean up timeout when code is received
  codePromise.finally(() => clearTimeout(timeout));

  return { server, port: addr.port, codePromise };
}

/**
 * Run the Google OAuth2 flow: prompt for credentials, open browser, exchange code.
 *
 * Shared by both `triggerfish connect google` and the dive wizard.
 *
 * @param secretStore - Where to store tokens (defaults to OS keychain)
 */
export async function performGoogleOAuth(
  secretStore?: import("../secrets/keychain.ts").SecretStore,
): Promise<boolean> {
  const clientId = await Input.prompt({
    message: "Google OAuth Client ID",
  });
  if (!clientId.trim()) {
    console.log("Client ID is required.");
    return false;
  }

  const clientSecret = await Input.prompt({
    message: "Google OAuth Client Secret",
  });
  if (!clientSecret.trim()) {
    console.log("Client Secret is required.");
    return false;
  }

  const store = secretStore ?? createKeychain();
  const authManager = createGoogleAuthManager(store);

  // Start localhost callback server
  const { server, port, codePromise } = createOAuthCallbackServer();

  // Keep-alive interval to prevent the Deno event loop from exiting
  // while waiting for the browser OAuth redirect
  const keepAlive = setInterval(() => {}, 60_000);

  try {
    const config: GoogleAuthConfig = {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      redirectUri: `http://127.0.0.1:${port}`,
      scopes: GOOGLE_SCOPES,
    };

    const consentUrl = authManager.getConsentUrl(config);
    console.log("\nOpen this URL in your browser to authorize Triggerfish:\n");
    console.log(`  ${consentUrl}\n`);
    console.log("Waiting for authorization...\n");

    // Race the code promise against server.finished to keep the process alive.
    // Deno may exit if no refs keep the event loop running; server.finished
    // ensures the HTTP server ref keeps the process alive until we shut it down.
    const code = await Promise.race([
      codePromise,
      server.finished.then(() => {
        throw new Error("OAuth callback server stopped unexpectedly");
      }),
    ]);

    console.log("Authorization received. Exchanging code for tokens...");
    const result = await authManager.exchangeCode(code, config);

    if (result.ok) {
      console.log("\nGoogle account connected successfully.");
      console.log(
        "Your agent can now use Gmail, Calendar, Tasks, Drive, and Sheets.",
      );
      return true;
    } else {
      console.log(`\nFailed to connect: ${result.error.message}`);
      console.log(
        "Please verify your Client ID and Client Secret, then try again.",
      );
      return false;
    }
  } finally {
    clearInterval(keepAlive);
    await server.shutdown();
  }
}

/**
 * Interactive Google OAuth2 authentication flow.
 */
async function runConnectGoogle(): Promise<void> {
  console.log("Connect Google Workspace\n");
  console.log(
    "This will connect your Google account for Gmail, Calendar, Tasks, Drive, and Sheets.\n",
  );
  console.log("You'll need OAuth2 credentials from Google Cloud Console.\n");
  console.log("  Quick setup:");
  console.log("    1. Go to https://console.cloud.google.com ");
  console.log("    2. Create a project (or select an existing one)");
  console.log('    3. Navigate to "APIs & Services" → "Credentials"');
  console.log(
    '    4. Click "+ CREATE CREDENTIALS" and select "OAuth client ID"',
  );
  console.log("    5. If prompted, configure the OAuth consent screen first");
  console.log(
    "       IMPORTANT: Add yourself as a test user on the consent screen,",
  );
  console.log('       or you\'ll get "Access blocked" when authorizing.');
  console.log(
    "       Full walkthrough: https://trigger.fish/integrations/google-workspace.html#google-workspace",
  );
  console.log(
    '    6. On the Create OAuth client ID screen, select "Desktop app" from',
  );
  console.log("       the Application type dropdown");
  console.log('    7. Name it "Triggerfish" (or anything you like)');
  console.log(
    "    8. Click Create, then copy the Client ID and Client Secret\n",
  );
  console.log("  You'll also need to enable these APIs in your project:");
  console.log("    • Gmail API");
  console.log("    • Google Calendar API");
  console.log("    • Google Tasks API");
  console.log("    • Google Drive API");
  console.log("    • Google Sheets API");
  console.log(
    "  Enable them at: https://console.cloud.google.com/apis/library\n",
  );
  await performGoogleOAuth();
}

/**
 * Interactive GitHub PAT setup flow.
 */
async function runConnectGithub(): Promise<void> {
  console.log("Connect GitHub\n");
  console.log(
    "This will connect your GitHub account for repos, PRs, issues, and Actions.\n",
  );
  console.log("You need a Personal Access Token (PAT) from GitHub.\n");
  console.log("  Quick setup:");
  console.log("    1. Go to https://github.com/settings/tokens?type=beta");
  console.log('    2. Click "Generate new token"');
  console.log('    3. Name it "triggerfish"');
  console.log("    4. Under Repository access, select the repos you want");
  console.log("    5. Under Permissions, grant:");
  console.log("       - Contents: Read and Write");
  console.log("       - Issues: Read and Write");
  console.log("       - Pull requests: Read and Write");
  console.log("       - Actions: Read-only");
  console.log("    6. Click Generate token and copy it\n");

  const token = await Input.prompt({ message: "Paste your token" });
  if (!token.trim()) {
    console.log("No token provided. Aborted.");
    return;
  }

  const trimmed = token.trim();
  if (!trimmed.startsWith("ghp_") && !trimmed.startsWith("github_pat_")) {
    console.log(
      "Warning: token doesn't look like a GitHub PAT (expected ghp_... or github_pat_...)",
    );
    console.log("Continuing anyway...\n");
  }

  // Verify the token works
  console.log("Verifying token...");
  try {
    const resp = await fetch("https://api.github.com/user", {
      headers: {
        "Authorization": `Bearer ${trimmed}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      console.log(
        `\nToken verification failed (${resp.status}): ${
          (body as Record<string, string>).message ?? "Unknown error"
        }`,
      );
      console.log(
        "Check that your token is correct and has the required permissions.",
      );
      return;
    }
    const user = await resp.json();
    console.log(
      `\nAuthenticated as: ${(user as Record<string, string>).login}`,
    );
  } catch (err: unknown) {
    console.log(
      `\nCould not reach GitHub API: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    console.log("Check your network connection and try again.");
    return;
  }

  // Store in keychain
  const secretStore = createKeychain();
  const result = await secretStore.setSecret("github-pat", trimmed);
  if (!result.ok) {
    console.log(`\nFailed to store token: ${result.error}`);
    return;
  }

  console.log(
    "GitHub connected. Your agent can now use repos, PRs, issues, and Actions.",
  );
}

/**
 * Handle `triggerfish disconnect <service>`.
 */
async function runDisconnect(
  subcommand: string | undefined,
  _flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  switch (subcommand) {
    case "google": {
      const secretStore = createKeychain();
      const authManager = createGoogleAuthManager(secretStore);
      const hadTokens = await authManager.hasTokens();
      await authManager.clearTokens();
      if (hadTokens) {
        console.log(
          "Google account disconnected. Tokens removed from keychain.",
        );
      } else {
        console.log("No Google account was connected.");
      }
      break;
    }
    case "github": {
      const secretStore = createKeychain();
      const result = await secretStore.deleteSecret("github-pat");
      if (result.ok) {
        console.log("GitHub disconnected. Token removed from keychain.");
      } else {
        console.log("No GitHub account was connected.");
      }
      break;
    }
    default:
      console.log(`
DISCONNECT USAGE:
  triggerfish disconnect google    Remove Google authentication
  triggerfish disconnect github    Remove GitHub authentication
`);
      break;
  }
}

/**
 * Enable ANSI escape sequence processing on Windows.
 *
 * Windows PowerShell 5.1 and legacy conhost do not interpret ANSI escape
 * codes by default. This calls SetConsoleMode with
 * ENABLE_VIRTUAL_TERMINAL_PROCESSING to enable them. Silently ignored on
 * non-Windows platforms or if the call fails.
 */
function enableWindowsAnsi(): void {
  if (Deno.build.os !== "windows") return;

  try {
    const kernel32 = Deno.dlopen("kernel32.dll", {
      GetStdHandle: { parameters: ["i32"], result: "pointer" },
      GetConsoleMode: { parameters: ["pointer", "buffer"], result: "i32" },
      SetConsoleMode: { parameters: ["pointer", "u32"], result: "i32" },
    });

    const STD_OUTPUT_HANDLE = -11;
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;

    const handle = kernel32.symbols.GetStdHandle(STD_OUTPUT_HANDLE);
    const modeBuffer = new Uint32Array(1);
    kernel32.symbols.GetConsoleMode(handle, modeBuffer);
    kernel32.symbols.SetConsoleMode(
      handle,
      modeBuffer[0] | ENABLE_VIRTUAL_TERMINAL_PROCESSING,
    );
    kernel32.close();
  } catch {
    // VT processing not available — colors will degrade gracefully
  }
}

/**
 * Main CLI entry point.
 */
async function main(): Promise<void> {
  enableWindowsAnsi();

  // Clean up leftover .old binary from a previous Windows update
  await cleanupOldBinary();

  const args = Deno.args;

  // Check if config exists for default command detection
  const configPath = resolveConfigPath();
  let configExists = false;
  try {
    await Deno.stat(configPath);
    configExists = true;
  } catch {
    // Config doesn't exist
  }

  const parsed = parseCommand(args, { configExists });

  switch (parsed.command) {
    case "chat":
      await runChat();
      break;
    case "config":
      await runConfig(parsed.subcommand, parsed.flags);
      break;
    case "connect":
      await runConnect(parsed.subcommand, parsed.flags);
      break;
    case "cron":
      await runCron(parsed.subcommand, parsed.flags);
      break;
    case "disconnect":
      await runDisconnect(parsed.subcommand, parsed.flags);
      break;
    case "dive":
      await runDive(parsed.flags);
      break;
    case "patrol":
      await runPatrol();
      break;
    case "run":
      await runStart();
      break;
    case "start":
      await runDaemonStart();
      break;
    case "stop":
      await runDaemonStop();
      break;
    case "status":
      await runDaemonStatus();
      break;
    case "logs":
      await runDaemonLogs(parsed.flags);
      break;
    case "update":
      await runUpdate();
      break;
    case "version":
      showVersion();
      break;
    case "help":
    default:
      showHelp();
      break;
  }
}

// Execute main if this is the entry point
if (import.meta.main) {
  // Force-exit after completion to prevent Deno from hanging on Windows due to
  // stdin raw-mode handles left open by interactive prompts (Cliffy). Without
  // Deno.exit(0), the process lingers for minutes after "Daemon restarted" is
  // printed on Windows because the TTY handle is never fully released.
  main().then(() => Deno.exit(0)).catch((err) => {
    console.error("Fatal error:", err);
    Deno.exit(1);
  });
}
