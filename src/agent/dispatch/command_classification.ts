/**
 * Shell command classification for run_command security context.
 *
 * Classifies shell commands by recognizing integration CLIs (gh → GitHub),
 * GitHub domain patterns (api.github.com, github.com), and filesystem paths.
 * Used by the security context assembly to determine resource classification
 * for run_command tool calls.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import { maxClassification } from "../../core/types/classification.ts";
import {
  classifyCommandPaths,
  extractCommandPaths,
  splitOnShellOperators,
} from "../../core/security/command_path_extraction.ts";
import { DEFAULT_PATH_CLASSIFICATION } from "../../core/security/mod.ts";
import type { ParsedToolCall } from "../orchestrator/orchestrator_types.ts";
import { createLogger } from "../../core/logger/mod.ts";
import type { SecurityContextConfig } from "./security_context.ts";

const log = createLogger("command-classification");

/** No-classification sentinel result. */
const NO_RESOURCE_CLASSIFICATION = {
  classification: null as ClassificationLevel | null,
  operation: null as "read" | "write" | null,
  param: null as string | null,
};

/**
 * Map of CLI executable names to integration tool prefixes.
 *
 * When `run_command` invokes a CLI tool that belongs to a configured
 * integration (e.g. `gh` → GitHub), the command should be classified
 * using the integration's classification — not by treating API route
 * segments as filesystem paths. `gh api repos/owner/name/releases`
 * is a GitHub API call, not a filesystem access to `repos/owner/name/`.
 */
const CLI_TO_INTEGRATION_PREFIX: ReadonlyMap<string, string> = new Map([
  ["gh", "github_"],
]);

/** Pattern matching `VAR=value` env variable assignments before executables. */
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Executables that read arbitrary filesystem or network resources. When one of
 * these appears in a segment and no concrete resource path is recognized (the
 * target is hidden behind a variable or substitution), the segment must fail
 * closed to the filesystem default rather than silently resolving to PUBLIC.
 */
const DATA_READING_EXECUTABLES: ReadonlySet<string> = new Set([
  "cat",
  "dd",
  "xxd",
  "od",
  "hexdump",
  "base64",
  "head",
  "tail",
  "less",
  "more",
  "strings",
  "curl",
  "wget",
  "scp",
  "sftp",
  "nc",
]);

/**
 * Detect command-substitution or variable-only argument syntax that hides the
 * real resource target from path extraction. Presence of `$( … )`, backticks,
 * or a `$VAR`-only argument means the modeled extraction cannot see the
 * resource, so the segment classification must fail closed.
 */
function hasUnmodeledSubstitution(segment: string): boolean {
  if (segment.includes("$(") || segment.includes("`")) return true;
  return /(^|\s)["']?\$\{?[A-Za-z_]/.test(segment);
}

/** Non-stateful test for the presence of an http(s) URL in a segment. */
function segmentHasUrl(segment: string): boolean {
  return /https?:\/\/[^\s"']+/.test(segment);
}

/**
 * True when a data-reading executable has a non-flag operand that path
 * extraction could not classify, meaning it reads a resource we cannot model
 * (e.g. `cat secret`). Excludes flag-only invocations (`head -200`, reading
 * stdin) and URL targets (handled by the domain step), so neither fails closed.
 */
function hasOpaqueDataReadingOperand(
  segment: string,
  executable: string | null,
): boolean {
  if (executable === null || !DATA_READING_EXECUTABLES.has(executable)) {
    return false;
  }
  if (segmentHasUrl(segment)) return false;
  return segmentHasNonFlagOperand(segment);
}

/** True when a segment has at least one bareword operand after the executable. */
function segmentHasNonFlagOperand(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  let seenExecutable = false;
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (!seenExecutable) {
      if (token === "command" || token === "env") continue;
      if (ENV_ASSIGNMENT_PATTERN.test(token)) continue;
      seenExecutable = true;
      continue;
    }
    if (!token.startsWith("-")) return true;
  }
  return false;
}

/**
 * Extract the base executable name from the first token of a command segment.
 *
 * Handles: `gh`, `/usr/bin/gh`, `command gh`, `env gh`,
 * and skips env var assignments: `GH_TOKEN="" gh`, `NO_COLOR=1 gh`.
 */
function extractSegmentExecutable(segment: string): string | null {
  const trimmed = segment.trimStart();
  const tokens = trimmed.split(/\s+/);
  for (const token of tokens) {
    if (token === "command" || token === "env") continue;
    // Skip environment variable assignments: GH_TOKEN="", NO_COLOR=1, etc.
    if (ENV_ASSIGNMENT_PATTERN.test(token)) continue;
    // Strip path prefix: /usr/bin/gh → gh
    const basename = token.includes("/") ? token.split("/").pop()! : token;
    return basename;
  }
  return null;
}

/** URL pattern to extract URLs from command segments. */
const URL_PATTERN = /https?:\/\/[^\s"']+/g;

/**
 * Extract owner/repo from a command segment referencing a GitHub resource.
 *
 * Recognizes patterns:
 * - `/repos/owner/repo/...` (API paths)
 * - `repos/owner/repo/...` (bare API paths in gh CLI)
 * - `--repo owner/repo` (gh CLI flag)
 * - `github.com/owner/repo` (URLs)
 * - `raw.githubusercontent.com/owner/repo` (raw URLs)
 */
const REPO_PATTERNS: readonly RegExp[] = [
  /\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/,
  /\brepos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/,
  /--repo\s+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/,
  /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/,
  /raw\.githubusercontent\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/,
];

/** Extract the repo full name (owner/repo) from a command segment. */
function extractRepoFromSegment(segment: string): string | null {
  for (const pattern of REPO_PATTERNS) {
    const match = segment.match(pattern);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

/**
 * Resolve repo-level classification for a GitHub resource in a command.
 *
 * Extracts owner/repo from the segment and looks it up in the
 * repo classification cache (populated by prior github_* tool calls).
 * Returns null if no repo is found or the repo isn't cached.
 */
function resolveRepoClassification(
  segment: string,
  config: SecurityContextConfig,
): ClassificationLevel | null {
  const repoFullName = extractRepoFromSegment(segment);
  if (!repoFullName || !config.classifyGitHubRepo) return null;
  const repoLevel = config.classifyGitHubRepo(repoFullName);
  if (repoLevel !== null) {
    log.debug("resolveRepoClassification resolved repo resource", {
      operation: "resolveRepoClassification",
      repo: repoFullName,
      classification: repoLevel,
    });
  }
  return repoLevel;
}

/**
 * Classify URLs in a command segment via the domain classifier.
 *
 * Extracts all URLs from the segment and classifies each through the
 * domain classifier — the same classifier used by web_fetch and browser
 * tools. Returns the highest classification across all URLs, or null
 * if no URLs are found or no domain classifier is configured.
 */
function classifySegmentUrls(
  segment: string,
  config: SecurityContextConfig,
): ClassificationLevel | null {
  if (!config.domainClassifier) return null;
  const urls = segment.match(URL_PATTERN);
  if (!urls || urls.length === 0) return null;

  let highest: ClassificationLevel | null = null;
  for (const url of urls) {
    const result = config.domainClassifier.classify(url);
    log.debug("classifySegmentUrls classified URL resource", {
      operation: "classifySegmentUrls",
      url: url.slice(0, 120),
      classification: result.classification,
      source: result.source,
    });
    if (highest === null) {
      highest = result.classification;
    } else {
      highest = maxClassification(highest, result.classification);
    }
  }
  return highest;
}

/**
 * Recognize a CLI executable as belonging to a known integration.
 *
 * When the executable is a known integration CLI (e.g. `gh` → GitHub),
 * returns the integration prefix. The caller uses this to look up the
 * integration's classification as a fallback after resource-level checks.
 */
function resolveExecutableIntegrationPrefix(
  executable: string | null,
): string | null {
  if (!executable) return null;
  return CLI_TO_INTEGRATION_PREFIX.get(executable) ?? null;
}

/**
 * Classify a single command segment by identifying its target resource.
 *
 * Every command targets a resource. The resource's classification gates
 * execution. Classification priority (resource-first):
 *
 * 1. **Resource-level**: repo classification from cache (most specific)
 * 2. **Domain-level**: URLs classified via domain classifier (same as web_fetch)
 * 3. **Integration fallback**: CLI executable maps to integration prefix
 * 4. **Filesystem**: extract paths and classify against path classifier
 */
function classifyCommandSegment(
  segment: string,
  config: SecurityContextConfig,
  workspacePath: string,
): ClassificationLevel {
  const executable = extractSegmentExecutable(segment);
  const integrationPrefix = resolveExecutableIntegrationPrefix(executable);

  // 1. Resource-level: repo classification from cache (most specific).
  const repoLevel = resolveRepoClassification(segment, config);
  if (repoLevel !== null) {
    log.debug("classifyCommandSegment resolved resource via repo cache", {
      operation: "classifyCommandSegment",
      segment: segment.slice(0, 120),
      classification: repoLevel,
    });
    return repoLevel;
  }

  // 2. Domain-level: classify URLs via domain classifier.
  const domainLevel = classifySegmentUrls(segment, config);
  if (domainLevel !== null) {
    log.debug(
      "classifyCommandSegment resolved resource via domain classifier",
      {
        operation: "classifyCommandSegment",
        segment: segment.slice(0, 120),
        classification: domainLevel,
      },
    );
    return domainLevel;
  }

  // 3. Integration fallback: known CLI executable with no URL/repo to classify.
  if (integrationPrefix !== null) {
    const level = config.integrationClassifications?.get(integrationPrefix) ??
      "PUBLIC";
    log.debug(
      "classifyCommandSegment resolved via integration prefix fallback",
      {
        operation: "classifyCommandSegment",
        segment: segment.slice(0, 120),
        executable,
        prefix: integrationPrefix,
        classification: level,
      },
    );
    return level;
  }

  // 4. Filesystem: extract paths and classify against path classifier.
  const paths = extractCommandPaths(segment);
  const pathLevel = paths.length === 0 ? "PUBLIC" : classifyCommandPaths({
    paths,
    classifier: config.pathClassifier!,
    workspaceCwd: workspacePath,
  }).classification;
  const level = applyOpaqueResourceFloor({
    segment,
    executable,
    pathCount: paths.length,
    pathLevel,
  });
  log.debug("classifyCommandSegment resolved resource via filesystem paths", {
    operation: "classifyCommandSegment",
    segment: segment.slice(0, 120),
    pathCount: paths.length,
    classification: level,
  });
  return level;
}

/**
 * Raise a segment's classification to the filesystem default when its real
 * resource target is opaque to path extraction.
 *
 * Fail-closed cases:
 * - Command substitution / variable-only args (`cat $(printf … | base64 -d)`,
 *   `cat "$f"`): the modeled extraction cannot see the resource at all.
 * - A data-reading executable (`cat`, `dd`, `curl`, …) that extracted NO
 *   concrete path — its target is hidden, so default-deny.
 *
 * When a concrete path WAS extracted, its classification is trusted (a PUBLIC
 * workspace file stays PUBLIC). `maxClassification` ensures an exact-mapped
 * RESTRICTED resource is never downgraded by this floor.
 */
function applyOpaqueResourceFloor(opts: {
  readonly segment: string;
  readonly executable: string | null;
  readonly pathCount: number;
  readonly pathLevel: ClassificationLevel;
}): ClassificationLevel {
  const { segment, executable, pathCount, pathLevel } = opts;
  const dataReadingHidden = pathCount === 0 &&
    hasOpaqueDataReadingOperand(segment, executable);
  if (!hasUnmodeledSubstitution(segment) && !dataReadingHidden) {
    return pathLevel;
  }
  const floored = maxClassification(pathLevel, DEFAULT_PATH_CLASSIFICATION);
  if (floored !== pathLevel) {
    log.warn("classifyCommandSegment opaque resource forced to fs default", {
      operation: "classifyCommandSegment",
      segment: segment.slice(0, 120),
      executable,
      from: pathLevel,
      to: floored,
    });
  }
  return floored;
}

/** Resource classification result shape. */
type ResourceClassResult = {
  classification: ClassificationLevel | null;
  operation: "read" | "write" | null;
  param: string | null;
};

/**
 * Classify a `run_command` tool call by splitting on shell operators
 * and classifying each segment independently.
 *
 * Integration CLI segments (e.g. `gh api repos/owner/name`) use the
 * integration's configured classification. GitHub domain URLs (e.g.
 * `curl api.github.com/repos/...`) are recognized regardless of executable.
 * Other segments extract filesystem paths and classify against the path
 * classifier. `maxClassification` across all segments ensures dangerous
 * paths in ANY segment still escalate.
 */
export function classifyShellCommandResource(
  call: ParsedToolCall,
  config: SecurityContextConfig,
): ResourceClassResult {
  if (call.name !== "run_command") return NO_RESOURCE_CLASSIFICATION;
  const command = call.args.command as string | undefined;
  if (!command || !config.pathClassifier) return NO_RESOURCE_CLASSIFICATION;
  const workspacePath = config.getWorkspacePath?.() ?? null;
  if (!workspacePath) return NO_RESOURCE_CLASSIFICATION;

  const segments = splitOnShellOperators(command);
  let highest: ClassificationLevel = "PUBLIC";
  for (const segment of segments) {
    const level = classifyCommandSegment(segment, config, workspacePath);
    const escalated = maxClassification(highest, level);
    if (escalated !== highest) {
      log.debug(
        "classifyShellCommandResource segment escalated classification",
        {
          operation: "classifyShellCommandResource",
          segment: segment.slice(0, 80),
          from: highest,
          to: escalated,
        },
      );
    }
    highest = escalated;
  }

  // If no segments produced any paths and no integration was recognized,
  // fall back to classifying the workspace path itself.
  if (segments.length === 0) {
    const result = classifyCommandPaths({
      paths: [workspacePath],
      classifier: config.pathClassifier,
      workspaceCwd: workspacePath,
    });
    log.debug(
      "classifyShellCommandResource fallback workspace classification",
      {
        operation: "classifyShellCommandResource",
        classification: result.classification,
      },
    );
    highest = result.classification;
  }

  log.debug("classifyShellCommandResource result", {
    operation: "classifyShellCommandResource",
    command: command.slice(0, 120),
    classification: highest,
    segmentCount: segments.length,
  });
  return {
    classification: highest,
    operation: "write",
    param: command,
  };
}
