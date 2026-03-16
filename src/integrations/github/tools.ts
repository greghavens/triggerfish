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
import type { GitHubToolContext } from "./tools_shared.ts";
import {
  cloneGitHubRepository,
  createGitHubBranch,
  deleteGitHubBranch,
  fetchGitHubRepository,
  listGitHubBranches,
  listGitHubCommits,
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

/** Actions whose `path` input refers to a local filesystem location. */
const LOCAL_PATH_ACTIONS = new Set(["clone", "pull"]);

/** Resolve local path inputs to absolute workspace paths for clone/pull actions. */
function resolveLocalPathInput(
  action: string,
  input: Record<string, unknown>,
  workspacePath: string,
): Record<string, unknown> {
  if (!LOCAL_PATH_ACTIONS.has(action)) return input;
  const path = input.path;
  if (typeof path !== "string" || path.length === 0) return input;
  return { ...input, path: join(workspacePath, path) };
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

    const resolvedInput = ctx.workspacePath
      ? resolveLocalPathInput(action, input, ctx.workspacePath)
      : input;

    return handler(ctx.client, resolvedInput);
  };
}
