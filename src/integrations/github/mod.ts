/**
 * GitHub plugin — REST API access with classification-gated taint propagation.
 *
 * Provides tools for repos, PRs, issues, Actions, and code search.
 * Repo visibility maps to classification levels (public→PUBLIC,
 * private→CONFIDENTIAL, internal→INTERNAL).
 *
 * @module
 */

export type {
  GitHubBranch,
  GitHubClassificationConfig,
  GitHubCodeSearchItem,
  GitHubComment,
  GitHubCommit,
  GitHubError,
  GitHubFileContent,
  GitHubIssue,
  GitHubIssueSearchItem,
  GitHubPull,
  GitHubPullDetail,
  GitHubPullFile,
  GitHubRepo,
  GitHubRepoDetail,
  GitHubWorkflowRun,
  RepoVisibility,
} from "./types.ts";

export type { GitHubClient, GitHubClientConfig } from "./client.ts";

export { createGitHubClient, visibilityToClassification } from "./client.ts";

export type { ResolveGitHubTokenOptions } from "./auth.ts";

export { resolveGitHubToken } from "./auth.ts";

export type { GitHubToolContext } from "./tools.ts";

export {
  createGitHubToolExecutor,
  getGitHubToolDefinitions,
  GITHUB_TOOLS_SYSTEM_PROMPT,
  loadGitHubToolDefinitions,
} from "./tools.ts";
