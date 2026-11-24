/**
 * GitHub release discovery: fetch latest release metadata from the GitHub API.
 *
 * The updater dynamically discovers ALL platform-matching binaries in a
 * release — no hardcoded companion binary names. When new binaries are
 * added to future releases, old updaters pick them up automatically.
 * @module
 */

const GITHUB_REPO = "greghavens/triggerfish";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;

/** A single downloadable binary asset from a release. */
export interface ReleaseAsset {
  /** Asset filename as it appears in the release (e.g. "triggerfish-linux-x64"). */
  readonly name: string;
  /** Local filename to install as (e.g. "triggerfish", "triggerfish-tidepool"). */
  readonly localName: string;
  readonly downloadUrl: string;
  readonly checksumsUrl?: string;
}

/** Metadata about a GitHub release. */
export interface ReleaseMetadata {
  readonly tag: string;
  /** All platform-matching binary assets in this release. */
  readonly assets: readonly ReleaseAsset[];
}

/**
 * Resolve the platform-specific asset name for the current OS and architecture.
 */
export function resolveAssetName(): string {
  const os = Deno.build.os === "darwin" ? "macos" : Deno.build.os;
  const arch = Deno.build.arch === "aarch64" ? "arm64" : "x64";
  const ext = Deno.build.os === "windows" ? ".exe" : "";
  return `triggerfish-${os}-${arch}${ext}`;
}

/** Shape of the GitHub releases/latest JSON response. */
interface GitHubReleasePayload {
  readonly tag_name: string;
  readonly assets: readonly {
    readonly name: string;
    readonly browser_download_url: string;
  }[];
}

/** Build the platform suffix used to match release assets (e.g. "linux-x64"). */
function platformSuffix(): string {
  const os = Deno.build.os === "darwin" ? "macos" : Deno.build.os;
  const arch = Deno.build.arch === "aarch64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

/**
 * Strip the platform suffix and extension from an asset name to get the
 * local binary name.
 *
 * "triggerfish-linux-x64"          → "triggerfish"
 * "triggerfish-tidepool-linux-x64" → "triggerfish-tidepool"
 * "triggerfish-windows-x64.exe"    → "triggerfish.exe"
 */
function assetNameToLocalName(assetName: string): string {
  const suffix = platformSuffix();
  const ext = Deno.build.os === "windows" ? ".exe" : "";
  // Remove extension first, then platform suffix
  const withoutExt = ext && assetName.endsWith(ext)
    ? assetName.slice(0, -ext.length)
    : assetName;
  const withoutSuffix = withoutExt.endsWith(`-${suffix}`)
    ? withoutExt.slice(0, -(suffix.length + 1))
    : withoutExt;
  return `${withoutSuffix}${ext}`;
}

/** Find the checksums file that covers a given asset. */
function findChecksumsForAsset(
  assetName: string,
  allAssets: readonly { name: string; browser_download_url: string }[],
): string | undefined {
  // Prefer specific checksums file (SHA256SUMS-tauri.txt covers triggerfish-tidepool-*)
  // Fall back to SHA256SUMS.txt
  const checksumFiles = allAssets.filter((a) =>
    a.name.startsWith("SHA256SUMS") && a.name.endsWith(".txt")
  );
  // If there's only one, use it
  if (checksumFiles.length === 1) {
    return checksumFiles[0].browser_download_url;
  }
  // For the main binary, prefer SHA256SUMS.txt
  if (assetName.startsWith("triggerfish-") && !assetName.includes("tidepool")) {
    const main = checksumFiles.find((a) => a.name === "SHA256SUMS.txt");
    if (main) return main.browser_download_url;
  }
  // For companion binaries, prefer SHA256SUMS-<suffix>.txt, else SHA256SUMS.txt
  for (const cs of checksumFiles) {
    if (cs.name !== "SHA256SUMS.txt") return cs.browser_download_url;
  }
  return checksumFiles[0]?.browser_download_url;
}

/**
 * Extract all platform-matching binary assets from a release.
 *
 * Matches any asset named `triggerfish*-{platform}-{arch}[.exe]` — this
 * automatically picks up companion binaries (tidepool, future additions)
 * without hardcoding their names.
 */
function extractAllPlatformAssets(
  release: GitHubReleasePayload,
): readonly ReleaseAsset[] {
  const suffix = platformSuffix();
  const ext = Deno.build.os === "windows" ? ".exe" : "";
  const pattern = `-${suffix}${ext}`;

  return release.assets
    .filter((a) =>
      a.name.startsWith("triggerfish") &&
      a.name.endsWith(pattern) &&
      !a.name.includes("SHA256SUMS")
    )
    .map((a) => ({
      name: a.name,
      localName: assetNameToLocalName(a.name),
      downloadUrl: a.browser_download_url,
      checksumsUrl: findChecksumsForAsset(a.name, release.assets),
    }));
}

/** Convert a GitHub release payload into ReleaseMetadata or an error. */
function buildReleaseMetadata(
  release: GitHubReleasePayload,
): { metadata: ReleaseMetadata } | { error: string } {
  const assets = extractAllPlatformAssets(release);
  const mainAsset = assets.find((a) =>
    a.localName === "triggerfish" ||
    a.localName === "triggerfish.exe"
  );
  if (!mainAsset) {
    const expected = resolveAssetName();
    return {
      error:
        `No binary for this platform (${expected}) in release ${release.tag_name}`,
    };
  }
  return {
    metadata: {
      tag: release.tag_name,
      assets,
    },
  };
}

/** Fetch the latest release metadata from GitHub. */
export async function fetchLatestRelease(): Promise<
  { metadata: ReleaseMetadata } | { error: string }
> {
  try {
    const resp = await fetch(`${GITHUB_API}/releases/latest`, {
      headers: { "User-Agent": "triggerfish-updater" },
    });
    if (!resp.ok) {
      return { error: `Failed to check for updates: HTTP ${resp.status}` };
    }
    const release = await resp.json() as GitHubReleasePayload;
    return buildReleaseMetadata(release);
  } catch (e) {
    return { error: `Failed to check for updates: ${e}` };
  }
}
