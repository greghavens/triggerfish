/**
 * Java JRE resolution — find and validate Java 25+ installations.
 *
 * Checks the managed JRE directory (~/.triggerfish/bin/java/) and
 * system PATH for a suitable Java installation. Used by the signal-cli
 * setup flow to ensure the JVM dependency is satisfied.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { Result } from "../../../core/types/classification.ts";
import { resolveSignalCliBinDir } from "../setup/setup_resolver.ts";

const log = createLogger("signal");

/** Validate that the Java version is 21 or newer. */
function validateJavaVersion(versionText: string): Result<string, string> {
  const firstLine = versionText.split("\n")[0];
  const match = versionText.match(/(\d+)\.\d+/);
  if (!match) return { ok: true, value: firstLine };
  const major = parseInt(match[1], 10);
  if (major >= 25) return { ok: true, value: firstLine };
  return {
    ok: false,
    error: `Java ${major} found, but signal-cli requires Java 25+`,
  };
}

/** Race a spawned process against a 15-second timeout to prevent hanging. */
async function raceJavaProcessWithTimeout(
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

/** Try running a java binary and verify it's 21+. */
export async function tryJava(path: string): Promise<Result<string, string>> {
  try {
    const cmd = new Deno.Command(path, {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const output = await raceJavaProcessWithTimeout(child);
    if (output === null) return { ok: false, error: "timed out" };
    if (!output.success) {
      return { ok: false, error: "java returned non-zero exit code" };
    }
    const versionText = new TextDecoder().decode(output.stdout).trim();
    return validateJavaVersion(versionText);
  } catch (_err: unknown) {
    log.debug("Java binary not found", { path });
    return { ok: false, error: "not found" };
  }
}

/** Probe a JDK candidate directory for a java binary, returning JAVA_HOME or null. */
function probeJdkCandidate(candidate: string): string | null {
  if (Deno.build.os === "darwin") {
    const macHome = `${candidate}/Contents/Home`;
    try {
      Deno.statSync(`${macHome}/bin/java`);
      return macHome;
    } catch (_err: unknown) {
      log.debug("File access failed", { path: `${macHome}/bin/java` });
    }
  }
  const javaBinName = Deno.build.os === "windows" ? "java.exe" : "java";
  try {
    Deno.statSync(`${candidate}/bin/${javaBinName}`);
    return candidate;
  } catch (_err: unknown) {
    log.debug("File access failed", {
      path: `${candidate}/bin/${javaBinName}`,
    });
  }
  return null;
}

/** Return the JAVA_HOME for a managed JRE, or null if none installed. */
export function resolveJavaHome(): string | null {
  const javaDir = `${resolveSignalCliBinDir()}/java`;
  try {
    for (const entry of Deno.readDirSync(javaDir)) {
      if (!entry.isDirectory || !entry.name.startsWith("jdk-")) continue;
      const result = probeJdkCandidate(`${javaDir}/${entry.name}`);
      if (result !== null) return result;
    }
  } catch (_err: unknown) {
    log.debug("File access failed", { path: javaDir });
  }
  return null;
}

/** Return the path to the java binary for a given JAVA_HOME. */
export function javaHomeBin(javaHome: string): string {
  return Deno.build.os === "windows"
    ? `${javaHome}/bin/java.exe`
    : `${javaHome}/bin/java`;
}

/**
 * Check if Java 25+ is available — checks managed JRE first, then PATH.
 *
 * @returns Java version string and JAVA_HOME path (if managed), or error.
 */
export async function verifyJava(): Promise<
  Result<{ version: string; javaHome?: string }, string>
> {
  const managedHome = resolveJavaHome();
  if (managedHome) {
    const javaBin = javaHomeBin(managedHome);
    const result = await tryJava(javaBin);
    if (result.ok) {
      return {
        ok: true,
        value: { version: result.value, javaHome: managedHome },
      };
    }
  }

  const pathResult = await tryJava("java");
  if (pathResult.ok) {
    return { ok: true, value: { version: pathResult.value } };
  }

  return {
    ok: false,
    error: "Java 25+ not found (checked ~/.triggerfish/bin/java/ and PATH)",
  };
}

/** @deprecated Use verifyJava instead */
export const checkJava = verifyJava;
