/**
 * Configuration bootstrap phase for gateway startup.
 *
 * Loads config from disk, initializes logging, verifies required
 * directories exist, and parses filesystem/tool-floor security config.
 *
 * @module
 */

import { join } from "@std/path";
import { isDockerEnvironment } from "../../core/env.ts";
import { parseClassification } from "../../core/types/classification.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import { createToolFloorRegistry } from "../../core/security/tool_floors.ts";
import {
  createFileWriter,
  createLogger,
  initLogger,
  parseUserLogLevel,
  USER_LEVEL_MAP,
} from "../../core/logger/mod.ts";
import { logDir as resolveLogDir } from "../../cli/daemon/daemon.ts";
import { loadConfigWithSecrets } from "../../core/config.ts";
import type { TriggerFishConfig } from "../../core/config.ts";
import { resolveBaseDir, resolveConfigPath } from "../../cli/config/paths.ts";
import {
  createKeychain,
  resolveDockerKeyPath,
  verifyKeyFilePermissions,
  verifyMountPoint,
} from "../../core/secrets/mod.ts";

/** Result of the bootstrap phase: config loaded and logger ready. */
export interface BootstrapResult {
  readonly baseDir: string;
  readonly config: TriggerFishConfig;
  readonly log: ReturnType<typeof createLogger>;
}

const bootstrapLog = createLogger("startup");

/** Print Docker-specific help when config is missing. */
export function printDockerConfigHelp(configPath: string): void {
  bootstrapLog.error("No configuration found (Docker)", {
    operation: "bootstrap",
    configPath,
  });
  console.error(`No configuration found at ${configPath}\n`);
  console.error("Option 1: Mount your config file:");
  console.error(
    "  docker run -v ./triggerfish.yaml:/data/triggerfish.yaml triggerfish/triggerfish\n",
  );
  console.error("Option 2: Run the setup wizard interactively:");
  console.error(
    "  docker run -it -v triggerfish-data:/data triggerfish/triggerfish dive\n",
  );
}

/** Check config exists, printing environment-appropriate help if missing. */
export async function verifyConfigExists(configPath: string): Promise<void> {
  try {
    await Deno.stat(configPath);
  } catch {
    if (isDockerEnvironment()) {
      printDockerConfigHelp(configPath);
    } else {
      bootstrapLog.warn("Configuration not found", {
        operation: "bootstrap",
        configPath,
      });
      console.log("Configuration not found.");
      console.log("Run 'triggerfish dive' to set up your agent.\n");
    }
    Deno.exit(1);
  }
}

/** Create default directories on first run. */
export async function ensureBaseDirs(baseDir: string): Promise<void> {
  for (const sub of ["logs", "data", "skills"]) {
    await Deno.mkdir(join(baseDir, sub), { recursive: true });
  }
  if (isDockerEnvironment()) {
    await Deno.mkdir(join(baseDir, "workspace"), { recursive: true });
  }
}

/** Initialize structured logger, skipping file writer on Windows services. */
export async function initializeStartupLogger(): Promise<
  ReturnType<typeof createFileWriter> extends Promise<infer T> ? T | undefined
    : never
> {
  const isWindowsService = Deno.build.os === "windows" &&
    !Deno.stdout.isTerminal();
  try {
    const fileWriter = isWindowsService
      ? undefined
      : await createFileWriter({ logDir: resolveLogDir() });
    initLogger({ level: "INFO", fileWriter, console: true });
    return fileWriter;
  } catch (err: unknown) {
    if (isLogFileBusyError(err)) {
      // console.error is intentional — the logger itself failed to initialize
      console.error(
        "Triggerfish is already running. Stop the existing instance first, " +
          "or use 'triggerfish status' to check.",
      );
      Deno.exit(1);
    }
    throw err;
  }
}

/** Detect EBUSY / lock errors on the log file (Windows exclusive lock). */
function isLogFileBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const withCode = err as Error & { code?: string };
  return withCode.code === "EBUSY" || err.message.includes("os error 32");
}

/** Load config from disk with secret resolution, exit on failure. */
export async function loadAndValidateConfig(
  configPath: string,
  log: ReturnType<typeof createLogger>,
): Promise<TriggerFishConfig> {
  const keychainForConfig = createKeychain();
  const configResult = await loadConfigWithSecrets(
    configPath,
    keychainForConfig,
  );
  if (!configResult.ok) {
    log.error("Failed to load configuration:", configResult.error);
    Deno.exit(1);
  }
  return configResult.value;
}

/** Re-initialize logger with YAML-configured level. */
export function reinitializeLoggerFromConfig(
  config: TriggerFishConfig,
  fileWriter: Awaited<ReturnType<typeof initializeStartupLogger>>,
): ReturnType<typeof createLogger> {
  const debugCompat = Deno.env.get("TRIGGERFISH_DEBUG") === "1"
    ? "debug"
    : undefined;
  const userLevel = parseUserLogLevel(
    config.logging?.level ?? debugCompat ?? "normal",
  );
  initLogger({
    level: USER_LEVEL_MAP[userLevel],
    fileWriter,
    console: true,
  });
  const log = createLogger("main");
  log.info(`Configuration loaded (log_level=${userLevel})`);
  return log;
}

/** Parse filesystem path classification config into a Map. */
export function buildFilesystemPathMap(
  fsConfig: Record<string, unknown> | undefined,
): {
  fsPathMap: Map<string, ClassificationLevel>;
  fsDefault: ClassificationLevel;
} {
  const fsPathMap = new Map<string, ClassificationLevel>();
  const paths = (fsConfig as { paths?: Record<string, string> })?.paths;
  if (paths) {
    for (const [pattern, level] of Object.entries(paths)) {
      const parsed = parseClassification(level);
      if (parsed.ok) fsPathMap.set(pattern, parsed.value);
    }
  }
  let fsDefault: ClassificationLevel = "CONFIDENTIAL";
  const defaultLevel = (fsConfig as { default?: string })?.default;
  if (defaultLevel) {
    const parsed = parseClassification(defaultLevel);
    if (parsed.ok) fsDefault = parsed.value;
  }
  return { fsPathMap, fsDefault };
}

/** Build tool floor registry from enterprise config overrides. */
export function buildToolFloorRegistryFromConfig(
  toolsConfig: Record<string, unknown> | undefined,
) {
  const overrides = new Map<string, ClassificationLevel>();
  const floors = (toolsConfig as { floors?: Record<string, string> })?.floors;
  if (floors) {
    for (const [tool, level] of Object.entries(floors)) {
      const parsed = parseClassification(level);
      if (parsed.ok) overrides.set(tool, parsed.value);
    }
  }
  return createToolFloorRegistry(overrides.size > 0 ? overrides : undefined);
}

/** Verify key file permissions, exiting in strict mode on violation. */
async function validateKeyFilePermissions(
  opts: { readonly strict: boolean },
): Promise<void> {
  const keyPath = resolveDockerKeyPath();
  const permResult = await verifyKeyFilePermissions(keyPath);
  if (permResult.ok && !permResult.value.valid) {
    bootstrapLog.warn("Docker security: insecure key file permissions", {
      operation: "validateKeyFilePermissions",
      message: permResult.value.message,
    });
    if (opts.strict) {
      bootstrapLog.error(
        "Docker security: exiting due to insecure permissions (strict mode)",
        { operation: "validateKeyFilePermissions", keyPath },
      );
      Deno.exit(78);
    }
  } else if (!permResult.ok) {
    if (permResult.error.kind === "not_found") {
      bootstrapLog.info("Docker security: key file not yet present", {
        operation: "validateKeyFilePermissions",
        detail: permResult.error.message,
      });
    } else {
      bootstrapLog.warn("Docker security: key file stat failed", {
        operation: "validateKeyFilePermissions",
        err: permResult.error.message,
      });
    }
  }
}

/** Verify data dir is a separate mount point, exiting in strict mode on violation. */
async function validateDataMountPoint(
  opts: { readonly strict: boolean },
): Promise<void> {
  const dataDir = Deno.env.get("TRIGGERFISH_DATA_DIR") ?? "/data";
  const mountResult = await verifyMountPoint(dataDir);
  if (mountResult.ok && !mountResult.value.isMounted) {
    bootstrapLog.warn(
      `Docker security: ${dataDir} is not a separate mount point`,
      {
        operation: "validateDataMountPoint",
        dataDir,
        message: mountResult.value.message,
      },
    );
    if (opts.strict) {
      bootstrapLog.error(
        `Docker security: exiting due to missing volume mount at ${dataDir} (strict mode)`,
        { operation: "validateDataMountPoint", dataDir },
      );
      Deno.exit(78);
    }
  } else if (!mountResult.ok) {
    bootstrapLog.warn("Docker security: mount check could not complete", {
      operation: "validateDataMountPoint",
      dataDir,
      err: mountResult.error,
    });
  }
}

/**
 * Validate Docker security configuration at startup.
 *
 * Checks key file permissions and mount point configuration.
 * In strict mode (`TRIGGERFISH_STRICT_PERMISSIONS=true`), exits with
 * code 78 (EX_CONFIG) on any violation. In normal mode, logs warnings.
 */
export async function enforceDockerSecurityConfig(): Promise<void> {
  const strict = Deno.env.get("TRIGGERFISH_STRICT_PERMISSIONS") === "true";
  await validateKeyFilePermissions({ strict });
  await validateDataMountPoint({ strict });
}

/** @deprecated Use enforceDockerSecurityConfig instead */
export const validateDockerSecurityConfig = enforceDockerSecurityConfig;

/** Load config, initialize logging, and return bootstrap context. */
export async function bootstrapConfigAndLogging(): Promise<BootstrapResult> {
  const baseDir = resolveBaseDir();
  const configPath = resolveConfigPath(baseDir);
  await verifyConfigExists(configPath);
  await ensureBaseDirs(baseDir);

  if (isDockerEnvironment()) {
    await enforceDockerSecurityConfig();
  }

  const fileWriter = await initializeStartupLogger();
  bootstrapLog.info("Gateway starting", { operation: "bootstrap" });
  const log = createLogger("main");
  const config = await loadAndValidateConfig(configPath, log);
  const finalLog = reinitializeLoggerFromConfig(config, fileWriter);
  return { baseDir, config, log: finalLog };
}
