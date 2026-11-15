/**
 * GitHub tool executor for the agent.
 *
 * Creates a chain-compatible executor for the 4 consolidated `github_*`
 * tools. Each tool dispatches on the `action` parameter to the
 * domain-specific handler from repos/, pulls/, issues/, actions/.
 *
 * @module
 */

import { join } from "@std/path";
import type { Result } from "../../core/types/classification.ts";
import { isRealPathWithinJail } from "../../core/security/path_jail.ts";
import { createLogger } from "../../core/logger/mod.ts";
import type { GitHubToolContext } from "./tools_shared.ts";
import { parseRepoString } from "./tools_shared.ts";
import {
  cloneGitHubRepository,
  createGitHubBranch,
  deleteGitHubBranch,
  fetchGitHubRepository,
  listGitHubBranches,
  listGitHubCommits,
  listGitHubReleases,
  listGitHubRepositories,
  pullGitHubRepository,
  readGitHubRepositoryFile,
} from "./repos/mod.ts";
import {
  createGitHubPullRequest,
  fetchGitHubPullRequest,
  listGitHubPullRequestFiles,
  listGitHubPullRequests,
  mergeGitHubPullRequest,
  reviewGitHubPullRequest,
  updateGitHubPullRequest,
} from "./pulls/mod.ts";
import {
  addGitHubIssueComment,
  createGitHubIssue,
  fetchGitHubIssue,
  listGitHubIssueComments,
  listGitHubIssues,
  updateGitHubIssue,
} from "./issues/mod.ts";
import {
  cancelGitHubWorkflowRun,
  listGitHubWorkflowRuns,
  triggerGitHubWorkflow,
} from "./actions/mod.ts";
import { queryGitHubCode, queryGitHubIssues } from "./actions/mod.ts";

// ─── Re-exports ──────────────────────────────────────────────────────────────

export type { GitHubToolContext } from "./tools_shared.ts";
export {
  getGitHubToolDefinitions,
  GITHUB_TOOLS_SYSTEM_PROMPT,
  loadGitHubToolDefinitions,
} from "./tools_defs.ts";

// ─── Tool dispatch maps ─────────────────────────────────────────────────────

/** Map of action name to handler function. */
type ToolHandler = (
  client: GitHubToolContext["client"],
  input: Record<string, unknown>,
) => Promise<string>;

/** Repos domain: action → handler. */
const REPOS_ACTIONS: Readonly<Record<string, ToolHandler>> = {
  list: listGitHubRepositories,
  get: fetchGitHubRepository,
  read_file: readGitHubRepositoryFile,
  list_commits: listGitHubCommits,
  list_branches: listGitHubBranches,
  list_releases: listGitHubReleases,
  create_branch: createGitHubBranch,
  delete_branch: deleteGitHubBranch,
  clone: cloneGitHubRepository,
  pull: pullGitHubRepository,
};

/** Pulls domain: action → handler. */
const PULLS_ACTIONS: Readonly<Record<string, ToolHandler>> = {
  list: listGitHubPullRequests,
  get: fetchGitHubPullRequest,
  create: createGitHubPullRequest,
  update: updateGitHubPullRequest,
  list_files: listGitHubPullRequestFiles,
  review: reviewGitHubPullRequest,
  merge: mergeGitHubPullRequest,
};

/** Issues domain: action → handler. */
const ISSUES_ACTIONS: Readonly<Record<string, ToolHandler>> = {
  list: listGitHubIssues,
  get: fetchGitHubIssue,
  create: createGitHubIssue,
  update: updateGitHubIssue,
  list_comments: listGitHubIssueComments,
  add_comment: addGitHubIssueComment,
};

/** Actions/search domain: action → handler. */
const ACTIONS_ACTIONS: Readonly<Record<string, ToolHandler>> = {
  list_runs: listGitHubWorkflowRuns,
  cancel_run: cancelGitHubWorkflowRun,
  trigger_workflow: triggerGitHubWorkflow,
  search_code: queryGitHubCode,
  search_issues: queryGitHubIssues,
};

/** Tool name → action dispatch map. */
const TOOL_ACTION_MAPS: Readonly<
  Record<string, Readonly<Record<string, ToolHandler>>>
> = {
  github_repos: REPOS_ACTIONS,
  github_pulls: PULLS_ACTIONS,
  github_issues: ISSUES_ACTIONS,
  github_actions: ACTIONS_ACTIONS,
};

// ─── Path Resolution ─────────────────────────────────────────────────────────

const log = createLogger("github-tools");

/** Actions whose `path` input refers to a local filesystem location. */
const LOCAL_PATH_ACTIONS = new Set(["clone", "pull"]);

/** The requested local path: explicit input, or the repo name for clone. */
function requestedLocalPath(
  action: string,
  input: Record<string, unknown>,
): string | undefined {
  if (typeof input.path === "string" && input.path.length > 0) {
    return input.path;
  }
  if (action !== "clone") return undefined;
  const repo = typeof input.repo === "string"
    ? parseRepoString(input.repo)
    : null;
  return repo?.name;
}

/**
 * Resolve local path inputs for clone/pull to absolute paths jailed inside
 * the agent workspace. Fails closed: no workspace means no local git
 * operations, and a path that resolves (after symlinks) outside the
 * workspace is rejected.
 */
function resolveLocalPathInput(
  action: string,
  input: Record<string, unknown>,
  workspacePath: string | undefined,
): Result<Record<string, unknown>, string> {
  if (!LOCAL_PATH_ACTIONS.has(action)) return { ok: true, value: input };
  if (workspacePath === undefined || workspacePath.length === 0) {
    log.warn("GitHub local path denied: no workspace configured", {
      operation: `github_${action}`,
    });
    return {
      ok: false,
      error:
        `Error: github ${action} requires a configured agent workspace for local paths. Access denied.`,
    };
  }
  const requested = requestedLocalPath(action, input);
  if (requested === undefined) return { ok: true, value: input };
  const resolved = join(workspacePath, requested);
  if (!isRealPathWithinJail(resolved, workspacePath)) {
    log.warn("GitHub local path escapes workspace jail", {
      operation: `github_${action}`,
      requestedPath: requested,
      workspacePath,
    });
    return {
      ok: false,
      error:
        `Error: 'path' resolves outside the agent workspace. Access denied.`,
    };
  }
  return { ok: true, value: { ...input, path: resolved } };
}

// ─── Executor ────────────────────────────────────────────────────────────────

/**
 * Create a tool executor for GitHub tools.
 *
 * Returns null for unknown tool names (allowing chaining with other executors).
 * Returns a graceful error message if ctx is undefined (GitHub not configured).
 */
export function createGitHubToolExecutor(
  ctx: GitHubToolContext | undefined,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  // deno-lint-ignore require-await
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    const actionMap = TOOL_ACTION_MAPS[name];
    if (!actionMap) return null;

    if (!ctx) {
      return "GitHub is not configured. Set up a GitHub token to use GitHub tools.";
    }

    const action = input.action;
    if (typeof action !== "string" || action.length === 0) {
      return `Error: ${name} requires an 'action' parameter (string).`;
    }

    const handler = actionMap[action];
    if (!handler) {
      const valid = Object.keys(actionMap).join(", ");
      return `Error: unknown action "${action}" for ${name}. Valid actions: ${valid}`;
    }

    const resolvedInput = resolveLocalPathInput(
      action,
      input,
      ctx.workspacePath,
    );
    if (!resolvedInput.ok) return resolvedInput.error;

    return handler(ctx.client, resolvedInput.value);
  };
}
