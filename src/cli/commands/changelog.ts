/**
 * CLI changelog command — display release notes between versions.
 *
 * Usage:
 *   triggerfish changelog                   — current version to latest
 *   triggerfish changelog v0.2.16 v0.3.3   — between two versions
 *   triggerfish changelog v0.2.16           — from version to current
 *   triggerfish changelog --latest 5        — last N releases
 *
 * @module
 */

import { VERSION } from "../version.ts";
import {
  fetchAllReleases,
  fetchChangelogRange,
  normalizeVersionTag,
} from "../daemon/updater/changelog.ts";
import { formatChangelogPlainText } from "../daemon/updater/changelog_format.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("cli.changelog");

/** Print usage information for the changelog command. */
function printChangelogUsage(): void {
  console.log(`
USAGE:
  triggerfish changelog                       Show notes from current to latest
  triggerfish changelog <from> <to>           Show notes between two versions
  triggerfish changelog <from>                Show notes from version to current
  triggerfish changelog --latest <N>          Show last N releases (default: 5)

EXAMPLES:
  triggerfish changelog v0.2.16 v0.3.3
  triggerfish changelog 0.2.16
  triggerfish changelog --latest 10
`);
}

/** Display the last N releases. */
async function showLatestReleases(count: number): Promise<void> {
  const result = await fetchAllReleases();
  if (!result.ok) {
    log.warn("Changelog fetch failed", {
      operation: "showLatestReleases",
      error: result.error,
    });
    console.log(`✗ ${result.error}`);
    Deno.exit(1);
  }

  const releases = result.value.slice(-count).reverse();
  if (releases.length === 0) {
    console.log("No releases found.");
    return;
  }

  const range = {
    from: releases[releases.length - 1].tag,
    to: releases[0].tag,
    releases: [...releases].reverse(),
  };
  console.log(formatChangelogPlainText(range));
}

/** Display release notes between two versions. */
async function showChangelogRange(
  from: string,
  to: string,
): Promise<void> {
  console.log(`Fetching release notes from ${from} to ${to}...\n`);
  const result = await fetchChangelogRange(from, to);
  if (!result.ok) {
    log.warn("Changelog range fetch failed", {
      operation: "showChangelogRange",
      from,
      to,
      error: result.error,
    });
    console.log(`✗ ${result.error}`);
    Deno.exit(1);
  }
  console.log(formatChangelogPlainText(result.value));
}

/**
 * Handle the `triggerfish changelog` command.
 *
 * @param subcommand - First positional arg (version or undefined).
 * @param flags - Parsed CLI flags.
 */
export async function displayChangelog(
  subcommand: string | undefined,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  // --latest N mode
  if (flags.latest !== undefined) {
    const count = typeof flags.latest === "string"
      ? parseInt(flags.latest, 10)
      : 5;
    if (isNaN(count) || count < 1) {
      log.warn("Changelog --latest flag invalid", {
        operation: "displayChangelog",
        latest: flags.latest,
      });
      console.log("✗ --latest requires a positive number.");
      Deno.exit(1);
    }
    await showLatestReleases(count);
    return;
  }

  // --help flag
  if (flags.help === true) {
    printChangelogUsage();
    return;
  }

  // No arguments: current version to latest
  if (subcommand === undefined) {
    if (VERSION === "dev") {
      console.log("Running a development build — no version to compare.");
      console.log("Use: triggerfish changelog --latest 5");
      return;
    }
    const _from = normalizeVersionTag(VERSION);
    await showLatestReleases(10);
    return;
  }

  // Two versions provided via flags (second positional parsed as from/to)
  const from = subcommand;
  const to = typeof flags.changelog_to === "string"
    ? flags.changelog_to
    : VERSION !== "dev"
    ? VERSION
    : "latest";

  if (to === "latest") {
    const allResult = await fetchAllReleases();
    if (!allResult.ok) {
      log.warn("Changelog fetch failed for latest lookup", {
        operation: "displayChangelog",
        from,
        error: allResult.error,
      });
      console.log(`✗ ${allResult.error}`);
      Deno.exit(1);
    }
    if (allResult.value.length === 0) {
      console.log("No releases found.");
      return;
    }
    const latestTag = allResult.value[allResult.value.length - 1].tag;
    await showChangelogRange(from, latestTag);
  } else {
    await showChangelogRange(from, to);
  }
}

/** @deprecated Use displayChangelog instead */
export const runChangelog = displayChangelog;
