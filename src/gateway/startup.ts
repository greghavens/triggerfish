/**
 * Gateway startup — brings up the full Triggerfish runtime.
 *
 * Loads config, wires all subsystems (orchestrator, scheduler, channels,
 * MCP servers, Tidepool, gateway WebSocket server), and keeps the process
 * alive until SIGTERM/SIGINT.
 * @module
 */

import { join } from "@std/path";
import { isDockerEnvironment } from "../core/env.ts";
import { createGatewayServer } from "./server.ts";
import {
  createSessionToolExecutor,
  SESSION_TOOLS_SYSTEM_PROMPT,
} from "./tools.ts";
import type { RegisteredChannel } from "./tools.ts";
import { createEnhancedSessionManager } from "./sessions.ts";
import { createSessionManager } from "../core/session/manager.ts";
import { buildSendEvent, createChatSession } from "./chat.ts";
import { createA2UIHost } from "../tidepool/host.ts";
import {
  createTidepoolToolExecutor,
  createTidePoolTools,
  TIDEPOOL_SYSTEM_PROMPT,
} from "../tidepool/mod.ts";
import {
  buildToolClassifications,
} from "../agent/orchestrator.ts";
import type { ToolDefinition } from "../agent/orchestrator.ts";
import { createProviderRegistry } from "../agent/llm.ts";
import {
  loadProvidersFromConfig,
  resolveVisionProvider,
} from "../agent/providers/config.ts";
import type { ModelsConfig } from "../agent/providers/config.ts";
import { createPolicyEngine } from "../core/policy/engine.ts";
import { createDefaultRules, createHookRunner } from "../core/policy/hooks.ts";
import { createSession, updateTaint } from "../core/types/session.ts";
import type { ChannelId, UserId } from "../core/types/session.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import { createWorkspace } from "../exec/workspace.ts";
import { createExecTools } from "../exec/tools.ts";
import {
  CLAUDE_SESSION_SYSTEM_PROMPT,
  createClaudeSessionManager,
  createClaudeToolExecutor,
} from "../exec/claude.ts";
import { createPathClassifier } from "../core/security/path_classification.ts";
import { createToolFloorRegistry } from "../core/security/tool_floors.ts";
import { createSchedulerService } from "../scheduler/service.ts";
import { createTriggerStore } from "../scheduler/trigger_store.ts";
import { createPersistentCronManager } from "../scheduler/cron.ts";
import { createSqliteStorage } from "../core/storage/sqlite.ts";
import {
  createHealthcheckToolExecutor,
  createLlmTaskToolExecutor,
  createSummarizeToolExecutor,
  createTodoManager,
  LLM_TASK_SYSTEM_PROMPT,
  SUMMARIZE_SYSTEM_PROMPT,
  TODO_SYSTEM_PROMPT,
} from "../tools/mod.ts";
import {
  createFts5SearchProvider,
  createMemoryStore,
  createMemoryToolExecutor,
  MEMORY_SYSTEM_PROMPT,
} from "../memory/mod.ts";
import { WEB_TOOLS_SYSTEM_PROMPT } from "../web/mod.ts";
import {
  createDomainPolicy as createBrowserDomainPolicy,
  createAutoLaunchBrowserExecutor,
  createBrowserManager,
} from "../browser/mod.ts";
import {
  createDailyNoteManager,
  createLinkResolver,
  createNoteStore,
  createObsidianToolExecutor,
  createVaultContext,
} from "../obsidian/mod.ts";
import {
  createImageToolExecutor,
  IMAGE_TOOLS_SYSTEM_PROMPT,
} from "../image/mod.ts";
import {
  createExploreToolExecutor,
  EXPLORE_SYSTEM_PROMPT,
} from "../explore/mod.ts";
import {
  createCalendarService,
  createDriveService,
  createGmailService,
  createGoogleApiClient,
  createGoogleAuthManager,
  createSheetsService,
  createTasksService,
} from "../google/mod.ts";
import {
  createGitHubClient,
  createGitHubToolExecutor,
  resolveGitHubToken,
} from "../github/mod.ts";
import { createKeychain } from "../secrets/keychain.ts";
import {
  createSecretToolExecutor,
  SECRET_TOOLS_SYSTEM_PROMPT,
} from "../secrets/tools.ts";
import type { SecretPromptCallback } from "../secrets/tools.ts";
import {
  buildMcpSystemPrompt,
  buildMcpToolClassifications,
  createMcpExecutor,
  createMcpGateway,
  createMcpServerManager,
  getMcpToolDefinitions,
} from "../mcp/mod.ts";
import type { McpServerConfig } from "../mcp/mod.ts";
import { createTelegramChannel } from "../channels/telegram/adapter.ts";
import { createSignalChannel } from "../channels/signal/adapter.ts";
import { createWhatsAppChannel } from "../channels/whatsapp/adapter.ts";
import { createPairingService } from "../channels/pairing.ts";
import {
  checkSignalCli,
  isDaemonHealthy,
  isDaemonRunning,
  isDaemonRunningUnix,
  startDaemon,
  startDaemonUnix,
  waitForDaemon,
  waitForDaemonUnix,
} from "../channels/signal/setup.ts";
import type { DaemonHandle } from "../channels/signal/setup.ts";
import { createNotificationService } from "./notifications.ts";
import {
  createTriggerToolExecutor,
  TRIGGER_TOOLS_SYSTEM_PROMPT,
} from "./trigger_tools.ts";
import { parseClassification } from "../core/types/classification.ts";
import { createSkillLoader } from "../skills/loader.ts";
import type { Skill } from "../skills/loader.ts";
import {
  createFileWriter,
  createLogger,
  initLogger,
  parseUserLogLevel,
  shutdownLogger,
  USER_LEVEL_MAP,
} from "../core/logger/mod.ts";
import { logDir as resolveLogDir } from "../cli/daemon.ts";
import { loadConfigWithSecrets } from "../core/config.ts";
import { resolveBaseDir, resolveConfigPath } from "../cli/paths.ts";
import { buildSkillsSystemPrompt, buildTriggersSystemPrompt } from "../skills/prompts.ts";
import {
  buildGoogleExecutor,
  buildSchedulerConfig,
  buildSubagentFactory,
  buildWebTools,
  createOrchestratorFactory,
} from "./factory.ts";
import { createToolExecutor, getToolDefinitions } from "./agent_tools.ts";
import { createPlanManager, createPlanToolExecutor } from "../agent/plan.ts";
import {
  PLAN_SYSTEM_PROMPT,
} from "../agent/plan_tools.ts";

/**
 * Start the gateway server with scheduler and persistent cron storage.
 */
export async function runStart(): Promise<void> {
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

  // --- WhatsApp channel wiring ---
  const whatsappConfig = config.channels?.whatsapp as {
    accessToken?: string;
    phoneNumberId?: string;
    verifyToken?: string;
    webhookPort?: number;
    ownerPhone?: string;
    classification?: string;
    user_classifications?: Record<string, string>;
    respond_to_unclassified?: boolean;
  } | undefined;

  if (
    whatsappConfig?.accessToken &&
    whatsappConfig?.phoneNumberId &&
    whatsappConfig?.verifyToken
  ) {
    try {
      const whatsappClassification =
        (whatsappConfig.classification ?? "PUBLIC") as ClassificationLevel;
      const whatsappOwnerPhone = whatsappConfig.ownerPhone;

      const whatsappAdapter = createWhatsAppChannel({
        accessToken: whatsappConfig.accessToken,
        phoneNumberId: whatsappConfig.phoneNumberId,
        verifyToken: whatsappConfig.verifyToken,
        webhookPort: whatsappConfig.webhookPort,
        ownerPhone: whatsappOwnerPhone,
        classification: whatsappClassification,
      });

      await chatSession.registerChannel("whatsapp", {
        adapter: whatsappAdapter,
        channelName: "WhatsApp",
        classification: whatsappClassification,
        userClassifications: whatsappConfig.user_classifications,
        respondToUnclassified: whatsappConfig.respond_to_unclassified,
      });

      whatsappAdapter.onMessage((msg) => {
        if (msg.isOwner !== false) {
          const sendEvent = buildSendEvent(whatsappAdapter, "WhatsApp", msg);
          chatSession.processMessage(msg.content, sendEvent)
            .catch((err) =>
              log.error("WhatsApp message processing error:", err)
            );
        } else {
          chatSession.handleChannelMessage(msg, "whatsapp")
            .catch((err) =>
              log.error("WhatsApp message processing error:", err)
            );
        }
      });

      if (whatsappOwnerPhone) {
        notificationService.registerChannel({
          name: "whatsapp",
          send: (notifMsg) =>
            whatsappAdapter.send({
              content: notifMsg,
              sessionId: `whatsapp-${whatsappOwnerPhone}`,
            }),
        });
      }

      await whatsappAdapter.connect();

      // Register WhatsApp adapter for agent tool access (message, channels_list)
      channelAdapters.set("whatsapp", {
        adapter: whatsappAdapter,
        classification: whatsappClassification,
        name: "WhatsApp",
      });

      log.info("WhatsApp channel connected");
    } catch (err) {
      log.error(
        `WhatsApp channel failed to connect: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
