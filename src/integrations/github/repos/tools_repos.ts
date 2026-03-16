/**
 * GitHub repos tool handlers — list, get, read file, commits, branches, create/delete branch.
 *
 * Each handler validates inputs, calls the GitHubClient, and
 * formats the response as a JSON string for the agent.
 *
 * @module
 */

import type { GitHubClient } from "../client.ts";
import {
  assertValidBranchName,
  assertValidRepoInput,
  formatGitHubError,
} from "../tools_shared.ts";

// ─── List Repos ──────────────────────────────────────────────────────────────

/** Handle the github_list_repos tool invocation. */
export async function listGitHubRepositories(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const page = typeof input.page === "number" ? input.page : undefined;
  const perPage = typeof input.per_page === "number"
    ? input.per_page
    : undefined;
  const result = await client.listRepos({ page, perPage });
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    repos: result.value.map((r) => ({
      name: r.fullName,
      visibility: r.visibility,
      description: r.description,
      default_branch: r.defaultBranch,
      url: r.htmlUrl,
      _classification: r.classification,
    })),
  });
}

/** @deprecated Use listGitHubRepositories instead */
export const executeListRepos = listGitHubRepositories;

// ─── Get Repo ───────────────────────────────────────────────────────────────

/** Handle the github_get_repo tool invocation. */
export async function fetchGitHubRepository(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_get_repo");
  if (typeof repoResult === "string") return repoResult;

  const result = await client.getRepo(repoResult.owner, repoResult.name);
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    name: result.value.fullName,
    description: result.value.description,
    visibility: result.value.visibility,
    default_branch: result.value.defaultBranch,
    language: result.value.language,
    stars: result.value.stargazersCount,
    forks: result.value.forksCount,
    topics: result.value.topics,
    clone_url: result.value.cloneUrl,
    ssh_url: result.value.sshUrl,
    url: result.value.htmlUrl,
    _classification: result.value.classification,
  });
}

/** @deprecated Use fetchGitHubRepository instead */
export const executeGetRepo = fetchGitHubRepository;

// ─── Read File ───────────────────────────────────────────────────────────────

/** Handle the github_read_file tool invocation. */
export async function readGitHubRepositoryFile(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_read_file");
  if (typeof repoResult === "string") return repoResult;

  const path = input.path;
  if (typeof path !== "string" || path.length === 0) {
    return "Error: github_read_file requires a 'path' argument.";
  }

  const ref = typeof input.ref === "string" ? input.ref : undefined;
  const result = await client.readFile(
    repoResult.owner,
    repoResult.name,
    path,
    ref,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    path: result.value.path,
    content: result.value.content,
    sha: result.value.sha,
    size: result.value.size,
    url: result.value.htmlUrl,
    _classification: result.value.classification,
  });
}

/** @deprecated Use readGitHubRepositoryFile instead */
export const executeReadFile = readGitHubRepositoryFile;

// ─── List Commits ────────────────────────────────────────────────────────────

/** Handle the github_list_commits tool invocation. */
export async function listGitHubCommits(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_list_commits");
  if (typeof repoResult === "string") return repoResult;

  const sha = typeof input.sha === "string" ? input.sha : undefined;
  const perPage = typeof input.per_page === "number"
    ? input.per_page
    : undefined;
  const result = await client.listCommits(repoResult.owner, repoResult.name, {
    sha,
    perPage,
  });
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    commits: result.value.map((c) => ({
      sha: c.sha.slice(0, 8),
      message: c.message.split("\n")[0],
      author: c.author,
      date: c.date,
      url: c.htmlUrl,
      _classification: c.classification,
    })),
  });
}

/** @deprecated Use listGitHubCommits instead */
export const executeListCommits = listGitHubCommits;

// ─── List Branches ──────────────────────────────────────────────────────────

/** Handle the github_list_branches tool invocation. */
export async function listGitHubBranches(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_list_branches");
  if (typeof repoResult === "string") return repoResult;

  const perPage = typeof input.per_page === "number"
    ? input.per_page
    : undefined;
  const result = await client.listBranches(repoResult.owner, repoResult.name, {
    perPage,
  });
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    branches: result.value.map((b) => ({
      name: b.name,
      protected: b.protected,
      _classification: b.classification,
    })),
  });
}

/** @deprecated Use listGitHubBranches instead */
export const executeListBranches = listGitHubBranches;

// ─── Create Branch ──────────────────────────────────────────────────────────

/** Handle the github_create_branch tool invocation. */
export async function createGitHubBranch(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_create_branch");
  if (typeof repoResult === "string") return repoResult;

  const branchResult = assertValidBranchName(
    input.branch,
    "github_create_branch",
  );
  if (typeof branchResult === "string") return branchResult;
  const sha = input.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    return "Error: github_create_branch requires a 'sha' argument.";
  }

  const result = await client.createBranch(
    repoResult.owner,
    repoResult.name,
    branchResult.branch,
    sha,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    ref: result.value.ref,
    sha: result.value.sha,
    _classification: result.value.classification,
  });
}

/** @deprecated Use createGitHubBranch instead */
export const executeCreateBranch = createGitHubBranch;

// ─── Delete Branch ──────────────────────────────────────────────────────────

/** Handle the github_delete_branch tool invocation. */
export async function deleteGitHubBranch(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_delete_branch");
  if (typeof repoResult === "string") return repoResult;

  const branchResult = assertValidBranchName(
    input.branch,
    "github_delete_branch",
  );
  if (typeof branchResult === "string") return branchResult;

  const result = await client.deleteBranch(
    repoResult.owner,
    repoResult.name,
    branchResult.branch,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    deleted: result.value.deleted,
    _classification: result.value.classification,
  });
}

/** @deprecated Use deleteGitHubBranch instead */
export const executeDeleteBranch = deleteGitHubBranch;

// ─── Pull Repo ──────────────────────────────────────────────────────────────

/** Handle the github_pull tool invocation. */
export async function pullGitHubRepository(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_pull");
  if (typeof repoResult === "string") return repoResult;

  const path = input.path;
  if (typeof path !== "string" || path.length === 0) {
    return "Error: github_pull requires a 'path' argument.";
  }

  const branch = typeof input.branch === "string" ? input.branch : undefined;
  const result = await client.pullRepo(
    repoResult.owner,
    repoResult.name,
    path,
    { branch },
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    pulled: result.value.pulled,
    _classification: result.value.classification,
  });
}

/** @deprecated Use pullGitHubRepository instead */
export const executePullRepo = pullGitHubRepository;

// ─── Clone Repo ─────────────────────────────────────────────────────────────

/** Handle the github_clone_repo tool invocation. */
export async function cloneGitHubRepository(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_clone_repo");
  if (typeof repoResult === "string") return repoResult;

  const destPath = typeof input.path === "string" && input.path.length > 0
    ? input.path
    : repoResult.name;
  const branch = typeof input.branch === "string" ? input.branch : undefined;
  const depth = typeof input.depth === "number" ? input.depth : undefined;

  const result = await client.cloneRepo(
    repoResult.owner,
    repoResult.name,
    destPath,
    { branch, depth },
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    cloned_to: result.value.clonedTo,
    _classification: result.value.classification,
  });
}

/** @deprecated Use cloneGitHubRepository instead */
export const executeCloneRepo = cloneGitHubRepository;
