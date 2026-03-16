/**
 * Eclipse Temurin JRE download and installation from Adoptium.
 * @module
 */

import type { Result } from "../../../core/types/classification.ts";
import {
  javaHomeBin,
  resolveJavaHome,
  resolveSignalCliBinDir,
  tryJava,
} from "../setup/setup_resolver.ts";
import {
  fetchAndExtractArchive,
  listDirectoryEntries,
} from "./setup_archive.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("signal.install");

/** Adoptium API response shape for asset metadata (subset). */
interface AdoptiumAsset {
  readonly binary: {
    readonly package: {
      readonly link: string;
      readonly checksum: string;
      readonly size: number;
      readonly name: string;
    };
  };
  readonly version: {
    readonly openjdk_version: string;
    readonly semver: string;
  };
  readonly release_name: string;
}

/** Map Deno.build.os to Adoptium API parameter. */
const ADOPTIUM_OS_MAP: Record<string, string> = {
  linux: "linux",
  darwin: "mac",
  windows: "windows",
};

/** Map Deno.build.arch to Adoptium API parameter. */
const ADOPTIUM_ARCH_MAP: Record<string, string> = {
  x86_64: "x64",
  aarch64: "aarch64",
};

/** Fetch JRE 25 asset metadata from the Adoptium API. */
async function fetchAdoptiumAssets(
  adoptOs: string,
  adoptArch: string,
): Promise<Result<AdoptiumAsset[], string>> {
  try {
    const metaUrl =
      `https://api.adoptium.net/v3/assets/latest/25/hotspot?image_type=jre&os=${adoptOs}&architecture=${adoptArch}`;
    const metaResp = await fetch(metaUrl);
    if (!metaResp.ok) {
      return {
        ok: false,
        error: `Adoptium API returned ${metaResp.status}: ${await metaResp
          .text()}`,
      };
    }
    return { ok: true, value: await metaResp.json() as AdoptiumAsset[] };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to fetch JRE metadata: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Select the correct archive asset for the current platform. */
function selectArchiveAsset(
  assets: AdoptiumAsset[],
  isWindows: boolean,
): AdoptiumAsset | undefined {
  const ext = isWindows ? ".zip" : ".tar.gz";
  return assets.find((a) => a.binary.package.name.endsWith(ext));
}

/** Verify the installed JRE runs correctly. */
async function verifyInstalledJre(): Promise<Result<string, string>> {
  const javaHome = resolveJavaHome();
  if (!javaHome) {
    const javaDir = `${resolveSignalCliBinDir()}/java`;
    const entries = await listDirectoryEntries(javaDir);
    return {
      ok: false,
      error: `JRE extracted but JAVA_HOME not found. Contents: [${
        entries.join(", ")
      }]`,
    };
  }

  const javaBin = javaHomeBin(javaHome);
  const verify = await tryJava(javaBin);
  if (!verify.ok) {
    return {
      ok: false,
      error:
        `Installed JRE at ${javaBin} does not run correctly: ${verify.error}`,
    };
  }

  log.info("JRE verified", {
    operation: "verifyInstalledJre",
    version: verify.value,
    javaHome,
  });
  console.log(`  Installed: ${verify.value}`);
  return { ok: true, value: javaHome };
}

/**
 * Download and install Eclipse Temurin JRE 25 to ~/.triggerfish/bin/java/.
 *
 * Uses the Adoptium API to fetch the latest JRE 25 GA release.
 *
 * @returns JAVA_HOME path for the installed JRE.
 */
export async function fetchJre(): Promise<Result<string, string>> {
  const javaDir = `${resolveSignalCliBinDir()}/java`;
  await Deno.mkdir(javaDir, { recursive: true });

  const adoptOs = ADOPTIUM_OS_MAP[Deno.build.os];
  const adoptArch = ADOPTIUM_ARCH_MAP[Deno.build.arch];

  if (!adoptOs || !adoptArch) {
    return {
      ok: false,
      error: `Unsupported platform: ${Deno.build.os}/${Deno.build.arch}`,
    };
  }

  log.info("Fetching JRE 25 release info", {
    operation: "fetchJre",
    adoptOs,
    adoptArch,
  });

  const assetsResult = await fetchAdoptiumAssets(adoptOs, adoptArch);
  if (!assetsResult.ok) return assetsResult;

  const assets = assetsResult.value;
  if (assets.length === 0) {
    return {
      ok: false,
      error: `No JRE 25 release found for ${adoptOs}/${adoptArch}`,
    };
  }

  const isWindows = Deno.build.os === "windows";
  const asset = selectArchiveAsset(assets, isWindows);
  if (!asset) {
    const ext = isWindows ? ".zip" : ".tar.gz";
    return { ok: false, error: `No ${ext} JRE asset found` };
  }

  const sizeMB = (asset.binary.package.size / 1024 / 1024).toFixed(1);
  log.info("Downloading JRE 25", {
    operation: "fetchJre",
    releaseName: asset.release_name,
    sizeMB,
  });

  const extractResult = await fetchAndExtractArchive(
    asset.binary.package.link,
    javaDir,
    isWindows,
  );
  if (!extractResult.ok) {
    return { ok: false, error: `JRE ${extractResult.error}` };
  }

  return verifyInstalledJre();
}

/** @deprecated Use fetchJre instead */
export const downloadJre = fetchJre;
