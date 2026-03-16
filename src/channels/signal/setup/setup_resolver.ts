/**
 * Signal binary resolution — find signal-cli on disk.
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { Result } from "../../../core/types/classification.ts";
import { resolveBaseDir } from "../../../cli/config/paths.ts";

import { resolveJavaHome as resolveJavaHomeImpl } from "../install/setup_java.ts";

// ─── Re-exports from install/setup_java.ts ──────────────────────
export {
  checkJava,
  javaHomeBin,
  resolveJavaHome,
  tryJava,
  verifyJava,
} from "../install/setup_java.ts";

const log = createLogger("signal");

/**
 * Minimum known-good signal-cli version. Warn (but don't block) if the
 * installed version is older. Update this constant when a newer release
 * has been validated.
 */
export const SIGNAL_CLI_KNOWN_GOOD_VERSION = "0.14.0";

/** Result of the guided Signal setup flow. */
export interface SignalSetupResult {
  readonly account: string;
  readonly endpoint: string;
}

/** GitHub release API response shape (subset). */
export interface GitHubRelease {
  readonly tag_name: string;
  readonly assets: readonly {
    readonly name: string;
    readonly browser_download_url: string;
    readonly size: number;
  }[];
}

// ─── Binary resolution ───────────────────────────────────────────

/** Return the directory where Triggerfish stores managed binaries. */
export function resolveSignalCliBinDir(): string {
  return `${resolveBaseDir()}/bin`;
}

/**
 * Log a warning if the installed signal-cli version is older than the known-good version.
 *
 * @param versionOutput - Output from `signal-cli --version` (e.g. "signal-cli 0.13.24").
 */
export function warnIfOldVersion(versionOutput: string): void {
  const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
  if (!match) return;
  const installed = match[1].split(".").map(Number);
  const known = SIGNAL_CLI_KNOWN_GOOD_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const inst = installed[i] ?? 0;
    const know = known[i] ?? 0;
    if (inst < know) {
      log.warn("Signal CLI version older than known-good", {
        operation: "resolveSignalCli",
        installed: match[1],
        knownGood: SIGNAL_CLI_KNOWN_GOOD_VERSION,
      });
      console.warn(
        `\u26a0 signal-cli ${
          match[1]
        } is older than known-good ${SIGNAL_CLI_KNOWN_GOOD_VERSION}. Consider upgrading.`,
      );
      return;
    }
    if (inst > know) return;
  }
}

/** Race a spawned process against a 15-second timeout to prevent hanging. */
async function raceProcessWithTimeout(
  child: Deno.ChildProcess,
): Promise<Deno.CommandOutput | null> {
  const result = await Promise.race([
    child.output(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
  ]);
  if (result === null) {
    try {
      child.kill();
    } catch (_err: unknown) {
      log.debug("Process cleanup: already terminated");
    }
  }
  return result;
}

/** Spawn a signal-cli process with optional env overrides. */
function spawnSignalCliVersion(
  path: string,
  env?: Record<string, string>,
): Deno.ChildProcess {
  const cmd = new Deno.Command(path, {
    args: ["--version"],
    stdout: "piped",
    stderr: "piped",
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });
  return cmd.spawn();
}

/** Try running a signal-cli binary and return version + path if it works. */
export async function trySignalCli(
  path: string,
  env?: Record<string, string>,
): Promise<Result<{ version: string; path: string }, string>> {
  try {
    const child = spawnSignalCliVersion(path, env);
    const result = await raceProcessWithTimeout(child);
    if (result === null) return { ok: false, error: "timed out" };
    if (result.success) {
      const version = new TextDecoder().decode(result.stdout).trim();
      return { ok: true, value: { version, path } };
    }
    return { ok: false, error: "non-zero exit" };
  } catch (_err: unknown) {
    log.debug("Signal-cli binary not found", { path });
    return { ok: false, error: "not found" };
  }
}

/** Try a JVM build candidate with managed JRE first, then system Java. */
async function tryJvmCandidate(
  candidate: string,
  jvmEnv: Record<string, string> | undefined,
  managedJavaHome: string | null,
): Promise<
  Result<{ version: string; path: string; javaHome?: string }, string>
> {
  if (jvmEnv) {
    const result = await trySignalCli(candidate, jvmEnv);
    if (result.ok) {
      return {
        ok: true,
        value: { ...result.value, javaHome: managedJavaHome! },
      };
    }
  }
  return trySignalCli(candidate);
}

/** Scan nested JVM build directories for a working signal-cli binary. */
async function scanJvmBuildDirs(
  binDir: string,
  ext: string,
  managedJavaHome: string | null,
): Promise<
  Result<{ version: string; path: string; javaHome?: string }, string>
> {
  const jvmEnv = managedJavaHome ? { JAVA_HOME: managedJavaHome } : undefined;
  try {
    for await (const entry of Deno.readDir(binDir)) {
      if (!entry.isDirectory || !entry.name.startsWith("signal-cli-")) continue;
      const candidate = `${binDir}/${entry.name}/bin/signal-cli${ext}`;
      const result = await tryJvmCandidate(candidate, jvmEnv, managedJavaHome);
      if (result.ok) return result;
    }
  } catch (_err: unknown) {
    log.debug("File access failed", { path: binDir });
  }
  return { ok: false, error: "signal-cli not found in JVM dirs" };
}

/**
 * Find signal-cli binary — check PATH first, then Triggerfish's managed bin dir.
 *
 * Returns the version string, resolved binary path, and optional JAVA_HOME
 * (set when the managed JRE is needed for a JVM build).
 */
export async function verifySignalCli(): Promise<
  Result<{ version: string; path: string; javaHome?: string }, string>
> {
  const ext = Deno.build.os === "windows" ? ".bat" : "";

  const pathResult = await trySignalCli(`signal-cli${ext}`);
  if (pathResult.ok) {
    warnIfOldVersion(pathResult.value.version);
    return pathResult;
  }

  const binDir = resolveSignalCliBinDir();
  const flatResult = await trySignalCli(`${binDir}/signal-cli${ext}`);
  if (flatResult.ok) return flatResult;

  const jvmResult = await scanJvmBuildDirs(binDir, ext, resolveJavaHomeImpl());
  if (jvmResult.ok) return jvmResult;

  return { ok: false, error: "signal-cli not found" };
}

/** @deprecated Use verifySignalCli instead */
export const checkSignalCli = verifySignalCli;
