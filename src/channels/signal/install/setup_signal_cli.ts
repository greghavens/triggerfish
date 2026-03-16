/**
 * Signal-cli download and installation from GitHub releases.
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { Result } from "../../../core/types/classification.ts";
import type { GitHubRelease } from "../setup/setup_resolver.ts";
import {
  resolveSignalCliBinDir,
  SIGNAL_CLI_KNOWN_GOOD_VERSION,
  trySignalCli,
  verifyJava,
} from "../setup/setup_resolver.ts";
import {
  fetchAndExtractArchive,
  listDirectoryEntries,
  locateFirstExistingPath,
} from "./setup_archive.ts";
import { fetchJre } from "./setup_jre.ts";

const log = createLogger("signal");

/** Result of downloading signal-cli: binary path and optional JAVA_HOME. */
export interface SignalCliInstall {
  /** Path to the signal-cli binary. */
  readonly path: string;
  /** JAVA_HOME for managed JRE, if the JVM build was installed. */
  readonly javaHome?: string;
}

/**
 * Fetch the known-good pinned signal-cli version from GitHub releases.
 *
 * @returns Release metadata for the pinned SIGNAL_CLI_KNOWN_GOOD_VERSION.
 */
export async function fetchKnownGoodRelease(): Promise<
  Result<GitHubRelease, string>
> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/AsamK/signal-cli/releases/tags/v${SIGNAL_CLI_KNOWN_GOOD_VERSION}`,
      {
        headers: { "Accept": "application/vnd.github+json" },
      },
    );
    if (!resp.ok) {
      return {
        ok: false,
        error: `GitHub API returned ${resp.status}: ${await resp.text()}`,
      };
    }
    const release = await resp.json() as GitHubRelease;
    return { ok: true, value: release };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to fetch releases: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Select the appropriate release asset for the current platform. */
function selectReleaseAsset(
  release: GitHubRelease,
  version: string,
): { asset: GitHubRelease["assets"][number]; isNative: boolean } | undefined {
  if (Deno.build.os === "linux") {
    const nativeName = `signal-cli-${version}-Linux-native.tar.gz`;
    const native = release.assets.find((a) => a.name === nativeName);
    if (native) return { asset: native, isNative: true };
  }

  const jvmName = `signal-cli-${version}.tar.gz`;
  const jvm = release.assets.find((a) => a.name === jvmName);
  if (jvm) return { asset: jvm, isNative: false };

  return undefined;
}

/** Ensure Java 25+ is available, downloading a portable JRE if needed. */
async function ensureJavaAvailable(): Promise<Result<string, string>> {
  const javaCheck = await verifyJava();
  if (javaCheck.ok) {
    return { ok: true, value: javaCheck.value.javaHome ?? "" };
  }

  log.info("Java 25+ not found, downloading portable JRE", {
    operation: "ensureJavaAvailable",
  });

  const jreResult = await fetchJre();
  if (!jreResult.ok) {
    return {
      ok: false,
      error:
        `JVM build requires Java 25+ and auto-install failed: ${jreResult.error}`,
    };
  }
  return jreResult;
}

/** Remove a previous installation directory if it exists. */
async function removePreviousInstall(installDir: string): Promise<void> {
  try {
    await Deno.remove(installDir, { recursive: true });
  } catch (_err: unknown) {
    log.debug("Previous signal-cli install directory removal skipped", {
      path: installDir,
    });
  }
}

/** Build candidate binary paths for the installed signal-cli. */
function buildBinaryCandidates(
  binDir: string,
  version: string,
  installDir: string,
): string[] {
  const ext = Deno.build.os === "windows" ? ".bat" : "";
  return [
    `${binDir}/signal-cli${ext}`,
    `${binDir}/signal-cli-${version}/bin/signal-cli${ext}`,
    `${installDir}/bin/signal-cli${ext}`,
  ];
}

/** Mark a binary as executable on non-Windows platforms. */
async function ensureExecutable(binaryPath: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  try {
    await Deno.chmod(binaryPath, 0o755);
  } catch (_err: unknown) {
    log.debug("Signal-cli binary chmod failed", { path: binaryPath });
  }
}

/** Verify an installed signal-cli binary runs correctly. */
async function verifySignalCliBinary(
  binaryPath: string,
  javaHome: string | undefined,
): Promise<Result<void, string>> {
  const verifyEnv = javaHome ? { JAVA_HOME: javaHome } : undefined;
  const verify = await trySignalCli(binaryPath, verifyEnv);
  if (!verify.ok) {
    return {
      ok: false,
      error: `Installed binary at ${binaryPath} does not run correctly`,
    };
  }
  log.info("Signal-cli binary verified", {
    operation: "verifySignalCliBinary",
    version: verify.value.version,
    binaryPath,
  });
  console.log(`  Installed: ${verify.value.version}`);
  return { ok: true, value: undefined };
}

/**
 * Download and install signal-cli to Triggerfish's managed bin directory.
 *
 * On Linux: tries native build first (no Java needed), falls back to JVM build.
 * On macOS/other: uses JVM build (requires Java 25+, auto-downloads portable JRE if missing).
 *
 * @param release - GitHub release metadata.
 * @returns Path to the installed signal-cli binary and optional JAVA_HOME.
 */
export async function fetchSignalCli(
  release: GitHubRelease,
): Promise<Result<SignalCliInstall, string>> {
  const version = release.tag_name.replace(/^v/, "");
  const binDir = resolveSignalCliBinDir();
  const installDir = `${binDir}/signal-cli-${version}`;

  await Deno.mkdir(binDir, { recursive: true });

  const selected = selectReleaseAsset(release, version);
  if (!selected) {
    return {
      ok: false,
      error:
        `No suitable signal-cli asset found for ${Deno.build.os} in release ${release.tag_name}`,
    };
  }

  let javaHome: string | undefined;
  if (!selected.isNative) {
    const javaResult = await ensureJavaAvailable();
    if (!javaResult.ok) return javaResult;
    javaHome = javaResult.value || undefined;
  }

  const sizeMB = (selected.asset.size / 1024 / 1024).toFixed(1);
  const buildType = selected.isNative ? "native" : "JVM";
  log.info("Downloading signal-cli", {
    operation: "fetchSignalCli",
    version,
    buildType,
    sizeMB,
  });
  console.log(
    `  Downloading signal-cli ${version} (${buildType}, ${sizeMB} MB)...`,
  );

  await removePreviousInstall(installDir);

  const extractResult = await fetchAndExtractArchive(
    selected.asset.browser_download_url,
    binDir,
    false,
  );
  if (!extractResult.ok) return extractResult;

  const candidates = buildBinaryCandidates(binDir, version, installDir);
  const binaryPath = await locateFirstExistingPath(candidates);
  if (!binaryPath) {
    const entries = await listDirectoryEntries(binDir);
    return {
      ok: false,
      error: `Binary not found after extraction. binDir contents: [${
        entries.join(", ")
      }]`,
    };
  }

  await ensureExecutable(binaryPath);

  const verifyResult = await verifySignalCliBinary(binaryPath, javaHome);
  if (!verifyResult.ok) return verifyResult;

  return { ok: true, value: { path: binaryPath, javaHome } };
}

/** @deprecated Use fetchSignalCli instead */
export const downloadSignalCli = fetchSignalCli;
