/**
 * GitHub REST API client factory.
 *
 * Creates a GitHubClient backed by the GitHub REST API.
 * Types are in client_types.ts; HTTP infra in client_http.ts.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { GitHubClassificationConfig, RepoVisibility } from "./types.ts";
import type { ApiRequestFn, ClassifyRepoFn } from "./client_http.ts";
import { sendGitHubApiRequest } from "./client_http.ts";
import type { GitHubApiContext } from "./client_http.ts";
import {
  cloneRepoToPath,
  createRepoBranch,
  deleteRepoBranch,
  fetchRepo,
  fetchRepoBranches,
  fetchRepoCommits,
  fetchRepoFile,
  fetchUserRepos,
  pullRepoAtPath,
} from "./repos/mod.ts";
import {
  fetchPullFiles,
  fetchRepoPull,
  fetchRepoPulls,
  mergeRepoPullRequest,
  submitPullRequestReview,
  submitRepoPullRequest,
  updateGitHubRepositoryPull,
} from "./pulls/mod.ts";
import {
  fetchIssueComments,
  fetchRepoIssue,
  fetchRepoIssues,
  submitIssueComment,
  submitRepoIssue,
  updateGitHubRepoIssue,
} from "./issues/mod.ts";
import {
  cancelRepoWorkflowRun,
  dispatchRepoWorkflow,
  fetchRepoWorkflowRuns,
  searchGitHubCode,
  searchGitHubIssues,
} from "./actions/mod.ts";

// Re-export types so existing `from "./client.ts"` imports work
export type { GitHubClient, GitHubClientConfig } from "./client_types.ts";

import type { GitHubClient, GitHubClientConfig } from "./client_types.ts";

/**
 * Map repo visibility to classification level.
 *
 * Pure function. Checks per-repo overrides first, then falls back to
 * the default visibility mapping:
 * - public -> PUBLIC
 * - internal -> INTERNAL
 * - private -> CONFIDENTIAL
 */
export function visibilityToClassification(
  visibility: RepoVisibility,
  repoFullName: string,
  config?: GitHubClassificationConfig,
): ClassificationLevel {
  if (config?.overrides?.[repoFullName]) {
    return config.overrides[repoFullName];
  }
  switch (visibility) {
    case "public":
      return "PUBLIC";
    case "internal":
      return "INTERNAL";
    case "private":
      return "CONFIDENTIAL";
  }
}

/** Map a raw visibility string to a typed RepoVisibility. */
function classifyRepoVisibility(
  visibility: string | undefined,
  fullName: string,
  classConfig?: GitHubClassificationConfig,
): ClassificationLevel {
  const vis = (visibility === "internal" || visibility === "private")
    ? visibility
    : "public" as RepoVisibility;
  return visibilityToClassification(vis, fullName, classConfig);
}

/**
 * Create a GitHub REST API client.
 *
 * @param config - Token, optional base URL, optional fetch function for tests
 * @returns A GitHubClient with all API methods
 */
export function createGitHubClient(config: GitHubClientConfig): GitHubClient {
  const ctx: GitHubApiContext = {
    baseUrl: config.baseUrl ?? "https://api.github.com",
    token: config.token,
    doFetch: config.fetchFn ?? fetch,
  };
  const classConfig = config.classificationConfig;
  const classifyRepo: ClassifyRepoFn = (visibility, fullName) =>
    classifyRepoVisibility(visibility, fullName, classConfig);
  const apiRequest: ApiRequestFn = (path, options) =>
    sendGitHubApiRequest(ctx, path, options);

  return buildClientMethods(apiRequest, classifyRepo, ctx);
}

/** Wire all client methods to their domain-specific implementations. */
function buildClientMethods(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  ctx: GitHubApiContext,
): GitHubClient {
  return {
    listRepos: (opts) => fetchUserRepos(apiRequest, classifyRepo, opts),
    getRepo: (owner, repo) => fetchRepo(apiRequest, classifyRepo, owner, repo),
    readFile: (owner, repo, path, ref) =>
      fetchRepoFile(apiRequest, classifyRepo, owner, repo, path, ref),
    listCommits: (owner, repo, opts) =>
      fetchRepoCommits(apiRequest, classifyRepo, owner, repo, opts),
    listBranches: (owner, repo, opts) =>
      fetchRepoBranches(apiRequest, classifyRepo, owner, repo, opts),
    createBranch: (owner, repo, branchName, sha) =>
      createRepoBranch(apiRequest, classifyRepo, owner, repo, branchName, sha),
    deleteBranch: (owner, repo, branchName) =>
      deleteRepoBranch(apiRequest, classifyRepo, owner, repo, branchName),
    listPulls: (owner, repo, opts) =>
      fetchRepoPulls(apiRequest, classifyRepo, owner, repo, opts),
    createPull: (owner, repo, title, head, base, body) =>
      submitRepoPullRequest(
        apiRequest,
        classifyRepo,
        owner,
        repo,
        title,
        head,
        base,
        body,
      ),
    submitReview: (owner, repo, prNumber, event, body) =>
      submitPullRequestReview(
        apiRequest,
        classifyRepo,
        owner,
        repo,
        prNumber,
        event,
        body,
      ),
    mergePull: (owner, repo, prNumber, opts) =>
      mergeRepoPullRequest(
        apiRequest,
        classifyRepo,
        owner,
        repo,
        prNumber,
        opts,
      ),
    getPull: (owner, repo, prNumber) =>
      fetchRepoPull(apiRequest, classifyRepo, owner, repo, prNumber),
    updatePull: (owner, repo, prNumber, fields) =>
      updateGitHubRepositoryPull(
        apiRequest,
        classifyRepo,
        owner,
        repo,
        prNumber,
        fields,
      ),
    listPullFiles: (owner, repo, prNumber, opts) =>
      fetchPullFiles(apiRequest, classifyRepo, owner, repo, prNumber, opts),
    listIssues: (owner, repo, opts) =>
      fetchRepoIssues(apiRequest, classifyRepo, owner, repo, opts),
    createIssue: (owner, repo, title, body, labels) =>
      submitRepoIssue(
        apiRequest,
        classifyRepo,
        owner,
        repo,
        title,
        body,
        labels,
      ),
    createComment: (owner, repo, issueNumber, body) =>
      submitIssueComment(
        apiRequest,
        classifyRepo,
        owner,
        repo,
        issueNumber,
        body,
      ),
    getIssue: (owner, repo, issueNumber) =>
      fetchRepoIssue(apiRequest, classifyRepo, owner, repo, issueNumber),
    updateIssue: (owner, repo, issueNumber, fields) =>
      updateGitHubRepoIssue(
        apiRequest,
        classifyRepo,
        owner,
        repo,
        issueNumber,
        fields,
      ),
    listComments: (owner, repo, issueNumber, opts) =>
      fetchIssueComments(
        apiRequest,
        classifyRepo,
        owner,
        repo,
        issueNumber,
        opts,
      ),
    listWorkflowRuns: (owner, repo, opts) =>
      fetchRepoWorkflowRuns(apiRequest, classifyRepo, owner, repo, opts),
    cancelRun: (owner, repo, runId) =>
      cancelRepoWorkflowRun(apiRequest, classifyRepo, owner, repo, runId),
    triggerWorkflow: (owner, repo, workflow, ref, inputs) =>
      dispatchRepoWorkflow(
        apiRequest,
        classifyRepo,
        owner,
        repo,
        workflow,
        ref,
        inputs,
      ),
    searchCode: (query, opts) =>
      searchGitHubCode(apiRequest, classifyRepo, query, opts),
    searchIssues: (query, opts) =>
      searchGitHubIssues(apiRequest, classifyRepo, ctx.baseUrl, query, opts),
    cloneRepo: (owner, repo, destPath, opts) =>
      cloneRepoToPath(
        apiRequest,
        classifyRepo,
        ctx.token,
        ctx.baseUrl,
        owner,
        repo,
        destPath,
        opts,
      ),
    pullRepo: (owner, repo, localPath, opts) =>
      pullRepoAtPath(
        apiRequest,
        classifyRepo,
        ctx.token,
        ctx.baseUrl,
        owner,
        repo,
        localPath,
        opts,
      ),
  };
}
