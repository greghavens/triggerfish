/**
 * CLI changelog command — display release notes between versions.
 *
 * Loads CHANGELOG.json from a local cache (written during `triggerfish update`)
 * with a GitHub release-asset fallback. No LLM calls — pure JSON read and
 * string formatting.
 *
 * @module
 */

import { join } from "@std/path";
import { resolveBaseDir } from "../config/paths.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single versioned entry parsed from CHANGELOG.json. */
interface VersionEntry {
  readonly version: string;
  readonly date: string;
  readonly sections: Readonly<Record<string, readonly string[]>>;
}

/** Root structure of CHANGELOG.json. */
interface ChangelogJson {
  readonly versions: readonly VersionEntry[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GITHUB_REPO = "greghavens/triggerfish";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;

/** Number of recent versions to show when no range is specified. */
const DEFAULT_DISPLAY_COUNT = 5;

// ─── Data loading ─────────────────────────────────────────────────────────────

/**
 * Resolve the path of the locally cached CHANGELOG.json.
 */
function resolveChangelogCachePath(): string {
  return join(resolveBaseDir(), "changelog.json");
}

/**
 * Write CHANGELOG.json to the local cache directory.
 *
 * Non-fatal on failure — caching is best-effort.
 *
 * @param data - Parsed changelog to persist.
 */
export async function cacheChangelogJson(data: ChangelogJson): Promise<void> {
  try {
    const cachePath = resolveChangelogCachePath();
    await Deno.mkdir(resolveBaseDir(), { recursive: true });
    await Deno.writeTextFile(
      cachePath,
      JSON.stringify(data, null, 2) + "\n",
    );
  } catch {
    // Best-effort: failure to cache does not block the update
  }
}

/**
 * Fetch CHANGELOG.json from the latest GitHub release assets and cache it locally.
 *
 * Uses the same GitHub API pattern as the binary updater. Falls back
 * gracefully if the network is unavailable or the asset is not present.
 *
 * @returns The parsed changelog, or null if unavailable.
 */
async function fetchChangelogFromGitHub(): Promise<ChangelogJson | null> {
  try {
    const resp = await fetch(`${GITHUB_API}/releases/latest`, {
      headers: { "User-Agent": "triggerfish-changelog" },
    });
    if (!resp.ok) return null;

    const release = await resp.json() as {
      assets: readonly { name: string; browser_download_url: string }[];
    };

    const asset = release.assets.find((a) => a.name === "CHANGELOG.json");
    if (!asset) return null;

    const assetResp = await fetch(asset.browser_download_url);
    if (!assetResp.ok) return null;

    const changelog = await assetResp.json() as ChangelogJson;
    await cacheChangelogJson(changelog);
    return changelog;
  } catch {
    return null;
  }
}

/**
 * Load CHANGELOG.json: local cache first, GitHub API fallback.
 *
 * @returns Parsed changelog, or null if neither source is available.
 */
async function loadChangelogJson(): Promise<ChangelogJson | null> {
  const cachePath = resolveChangelogCachePath();
  try {
    const text = await Deno.readTextFile(cachePath);
    return JSON.parse(text) as ChangelogJson;
  } catch {
    // No local cache — fall through to network fetch
  }
  return fetchChangelogFromGitHub();
}

// ─── Version comparison ───────────────────────────────────────────────────────

/**
 * Compare two semver strings. Returns positive if a > b, negative if a < b, 0 if equal.
 *
 * "Unreleased" is treated as the highest possible version.
 * Leading "v" is stripped before comparison.
 *
 * @param a - First version string.
 * @param b - Second version string.
 */
function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "Unreleased") return 1;
  if (b === "Unreleased") return -1;

  const aParts = a.replace(/^v/, "").split(".").map(Number);
  const bParts = b.replace(/^v/, "").split(".").map(Number);
  const len = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render a single changelog version entry to stdout.
 *
 * @param entry - The version entry to display.
 */
function renderVersionEntry(entry: VersionEntry): void {
  const dateStr = entry.date ? ` — ${entry.date}` : "";
  console.log(`\nv${entry.version}${dateStr}`);

  for (const [section, items] of Object.entries(entry.sections)) {
    if (items.length === 0) continue;
    console.log(`  ${section}`);
    for (const item of items) {
      console.log(`    • ${item}`);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Display changelog entries newer than `fromExclusive` up to `toInclusive`.
 *
 * Both bounds are optional:
 * - If `fromExclusive` is omitted, shows the most recent {@link DEFAULT_DISPLAY_COUNT} versions.
 * - If `toInclusive` is omitted, shows up to and including the newest available version.
 *
 * Used both by `runChangelog` (CLI) and the post-update hook in `main.ts`.
 * If the changelog cannot be loaded, logs a message and returns without error.
 *
 * @param fromExclusive - Lower bound version (exclusive). Versions strictly newer than this are shown.
 * @param toInclusive - Upper bound version (inclusive). Defaults to the newest available.
 */
export async function showChangelogDelta(
  fromExclusive: string | undefined,
  toInclusive: string | undefined,
): Promise<void> {
  const changelog = await loadChangelogJson();

  if (!changelog) {
    console.log("Changelog not available (no local cache and network unreachable).");
    if (fromExclusive && toInclusive) {
      console.log(
        `Run 'triggerfish changelog ${fromExclusive} ${toInclusive}' when connectivity is restored.`,
      );
    }
    return;
  }

  // Sort versions newest-first
  const sorted = [...changelog.versions].sort((a, b) =>
    compareVersions(b.version, a.version)
  );

  if (sorted.length === 0) {
    console.log("No changelog entries found.");
    return;
  }

  const effectiveTo = toInclusive ?? sorted[0].version;

  // Filter: versions strictly newer than fromExclusive, up to and including effectiveTo
  const inRange = sorted.filter((entry) => {
    const afterFrom = !fromExclusive ||
      compareVersions(entry.version, fromExclusive) > 0;
    const upToTo = compareVersions(entry.version, effectiveTo) <= 0;
    return afterFrom && upToTo;
  });

  // If no range specified, cap at DEFAULT_DISPLAY_COUNT recent versions
  const toDisplay = fromExclusive
    ? inRange
    : inRange.slice(0, DEFAULT_DISPLAY_COUNT);

  if (toDisplay.length === 0) {
    if (fromExclusive && toInclusive) {
      console.log(
        `No changelog entries found between ${fromExclusive} and ${toInclusive}.`,
      );
    } else {
      console.log("No changelog entries found.");
    }
    return;
  }

  const rangeLabel = fromExclusive
    ? `${fromExclusive} → ${effectiveTo}`
    : `latest ${toDisplay.length}`;
  const releaseWord = toDisplay.length === 1 ? "release" : "releases";
  console.log(
    `Triggerfish changelog: ${rangeLabel}  (${toDisplay.length} ${releaseWord})`,
  );

  for (const entry of toDisplay) {
    renderVersionEntry(entry);
  }
  console.log();
}

/**
 * Entry point for the `triggerfish changelog` CLI command.
 *
 * @param flags - Parsed CLI flags. Reads `from_version` and `to_version`.
 */
export async function runChangelog(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const from = typeof flags["from_version"] === "string"
    ? flags["from_version"]
    : undefined;
  const to = typeof flags["to_version"] === "string"
    ? flags["to_version"]
    : undefined;

  await showChangelogDelta(from, to);
}
