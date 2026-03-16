/**
 * GitHub client — repository query operations (list, get, branches, commits, files).
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../../core/types/classification.ts";
import type {
  GitHubBranch,
  GitHubCommit,
  GitHubFileContent,
  GitHubRepo,
  GitHubRepoDetail,
  RepoVisibility,
} from "../types.ts";
import type { GitHubError } from "../types.ts";
import type {
  ApiRequestFn,
  ClassifyRepoFn,
  RawBranch,
  RawCommit,
  RawContent,
  RawRepo,
} from "../client_http.ts";
import {
  buildRepoPath,
  extractRepoVisibility,
  fetchRepoClassification,
} from "../client_http.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("github-repos");

/** Maximum file size (1 MB) for github_repos_read_file. */
const MAX_FILE_SIZE = 1_048_576;

/** Map a raw repo object to a GitHubRepo domain type. */
function mapRawRepoToGitHubRepo(
  r: RawRepo,
  classifyRepo: ClassifyRepoFn,
): GitHubRepo {
  const visibility = extractRepoVisibility(r);
  return {
    id: r.id,
    fullName: r.full_name,
    description: r.description ?? null,
    visibility: visibility as RepoVisibility,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    classification: classifyRepo(visibility, r.full_name),
  };
}

/** Raw repo detail shape from GitHub API (extends RawRepo with extra fields). */
interface RawRepoDetail extends RawRepo {
  readonly clone_url: string;
  readonly ssh_url: string;
  readonly language?: string | null;
  readonly stargazers_count: number;
  readonly forks_count: number;
  readonly topics?: readonly string[];
}

/** Fetch a single repo from the GitHub API. */
export async function fetchRepo(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
): Promise<Result<GitHubRepoDetail, GitHubError>> {
  const result = await apiRequest<RawRepoDetail>(buildRepoPath(owner, repo));
  if (!result.ok) return result;

  const raw = result.value.data;
  const visibility = extractRepoVisibility(raw);
  return {
    ok: true,
    value: {
      id: raw.id,
      fullName: raw.full_name,
      description: raw.description ?? null,
      visibility: visibility as RepoVisibility,
      defaultBranch: raw.default_branch,
      htmlUrl: raw.html_url,
      cloneUrl: raw.clone_url,
      sshUrl: raw.ssh_url,
      language: raw.language ?? null,
      stargazersCount: raw.stargazers_count,
      forksCount: raw.forks_count,
      topics: raw.topics ?? [],
      classification: classifyRepo(visibility, raw.full_name),
    },
  };
}

/** Fetch branches from a GitHub repo. */
export async function fetchRepoBranches(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  opts?: { readonly perPage?: number },
): Promise<Result<readonly GitHubBranch[], GitHubError>> {
  const params = new URLSearchParams();
  params.set("per_page", String(opts?.perPage ?? 30));

  const result = await apiRequest<readonly RawBranch[]>(
    `${buildRepoPath(owner, repo)}/branches?${params.toString()}`,
  );
  if (!result.ok) return result;

  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );
  const branches: readonly GitHubBranch[] = result.value.data.map((b) => ({
    name: b.name,
    protected: b.protected,
    classification,
  }));
  return { ok: true, value: branches };
}

/** Create a branch on a GitHub repo via git refs API. */
export async function createRepoBranch(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  branchName: string,
  sha: string,
): Promise<
  Result<
    {
      readonly ref: string;
      readonly sha: string;
      readonly classification: ClassificationLevel;
    },
    GitHubError
  >
> {
  const result = await apiRequest<{
    ref: string;
    object: { sha: string };
  }>(
    `${buildRepoPath(owner, repo)}/git/refs`,
    { method: "POST", body: { ref: `refs/heads/${branchName}`, sha } },
  );
  if (!result.ok) return result;

  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );
  return {
    ok: true,
    value: {
      ref: result.value.data.ref,
      sha: result.value.data.object.sha,
      classification,
    },
  };
}

/** Delete a branch on a GitHub repo via git refs API. */
export async function deleteRepoBranch(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  branchName: string,
): Promise<
  Result<
    {
      readonly deleted: boolean;
      readonly classification: ClassificationLevel;
    },
    GitHubError
  >
> {
  const result = await apiRequest<undefined>(
    `${buildRepoPath(owner, repo)}/git/refs/heads/${
      encodeURIComponent(branchName)
    }`,
    { method: "DELETE" },
  );
  if (!result.ok) return result;

  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );
  return { ok: true, value: { deleted: true, classification } };
}

/** Fetch user repos from the GitHub API. */
export async function fetchUserRepos(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  opts?: { readonly page?: number; readonly perPage?: number },
): Promise<Result<readonly GitHubRepo[], GitHubError>> {
  const params = new URLSearchParams();
  if (opts?.page) params.set("page", String(opts.page));
  params.set("per_page", String(opts?.perPage ?? 30));
  params.set("sort", "updated");

  const result = await apiRequest<readonly RawRepo[]>(
    `/user/repos?${params.toString()}`,
  );
  if (!result.ok) return result;

  const repos = result.value.data.map((r) =>
    mapRawRepoToGitHubRepo(r, classifyRepo)
  );
  return { ok: true, value: repos };
}

/** Decode base64-encoded file content from GitHub. */
function decodeGitHubFileContent(raw: string): string {
  try {
    return atob(raw.replace(/\n/g, ""));
  } catch (err) {
    log.warn("GitHub file content base64 decode failed, returning raw", {
      operation: "decodeGitHubFileContent",
      err,
    });
    return raw;
  }
}

/** Fetch a single file from a GitHub repo. */
export async function fetchRepoFile(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<Result<GitHubFileContent, GitHubError>> {
  const params = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const result = await apiRequest<RawContent>(
    `${buildRepoPath(owner, repo)}/contents/${path}${params}`,
  );
  if (!result.ok) return result;

  const raw = result.value.data;
  if (raw.size > MAX_FILE_SIZE) {
    return {
      ok: false,
      error: {
        status: 413,
        message: `File too large: ${raw.size} bytes (max ${MAX_FILE_SIZE})`,
      },
    };
  }

  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );
  return {
    ok: true,
    value: {
      path: raw.path,
      content: decodeGitHubFileContent(raw.content),
      sha: raw.sha,
      size: raw.size,
      htmlUrl: raw.html_url,
      classification,
    },
  };
}

/** Map a raw commit to a GitHubCommit domain type. */
function mapRawCommitToGitHubCommit(
  c: RawCommit,
  classification: ClassificationLevel,
): GitHubCommit {
  return {
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author?.name ?? c.author?.login ?? "unknown",
    date: c.commit.author?.date ?? "",
    htmlUrl: c.html_url,
    classification,
  };
}

/** Fetch commits from a GitHub repo. */
export async function fetchRepoCommits(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  opts?: { readonly sha?: string; readonly perPage?: number },
): Promise<Result<readonly GitHubCommit[], GitHubError>> {
  const params = new URLSearchParams();
  if (opts?.sha) params.set("sha", opts.sha);
  params.set("per_page", String(opts?.perPage ?? 20));

  const result = await apiRequest<readonly RawCommit[]>(
    `${buildRepoPath(owner, repo)}/commits?${params.toString()}`,
  );
  if (!result.ok) return result;

  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );
  const commits = result.value.data.map((c) =>
    mapRawCommitToGitHubCommit(c, classification)
  );
  return { ok: true, value: commits };
}
