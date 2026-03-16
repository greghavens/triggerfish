/**
 * GitHub client — issue and comment operations.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../../core/types/classification.ts";
import type { GitHubComment, GitHubError, GitHubIssue } from "../types.ts";
import type {
  ApiRequestFn,
  ClassifyRepoFn,
  RawComment,
  RawIssue,
} from "../client_http.ts";
import { buildRepoPath, fetchRepoClassification } from "../client_http.ts";

/** Extract label names from raw issue label data. */
function extractIssueLabels(
  labels?: readonly (string | { readonly name?: string })[],
): readonly string[] {
  return (labels ?? []).map((l) => typeof l === "string" ? l : l.name ?? "");
}

/** Map a raw issue to a GitHubIssue domain type. */
function mapRawIssueToGitHubIssue(
  i: RawIssue,
  classification: ClassificationLevel,
): GitHubIssue {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    author: i.user?.login ?? "unknown",
    body: i.body ?? null,
    htmlUrl: i.html_url,
    createdAt: i.created_at,
    labels: extractIssueLabels(i.labels),
    classification,
  };
}

/** Fetch a single issue from a GitHub repo. */
export async function fetchRepoIssue(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Result<GitHubIssue, GitHubError>> {
  const result = await apiRequest<RawIssue>(
    `${buildRepoPath(owner, repo)}/issues/${issueNumber}`,
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
    value: mapRawIssueToGitHubIssue(result.value.data, classification),
  };
}

/** Update an issue on a GitHub repo. */
export async function updateGitHubRepoIssue(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  issueNumber: number,
  fields: {
    readonly title?: string;
    readonly body?: string;
    readonly state?: string;
    readonly labels?: readonly string[];
    readonly assignees?: readonly string[];
  },
): Promise<Result<GitHubIssue, GitHubError>> {
  const result = await apiRequest<RawIssue>(
    `${buildRepoPath(owner, repo)}/issues/${issueNumber}`,
    { method: "PATCH", body: fields },
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
    value: mapRawIssueToGitHubIssue(result.value.data, classification),
  };
}

/** @deprecated Use updateGitHubRepoIssue instead */
export const updateRepoIssue = updateGitHubRepoIssue;

/** Map a raw comment to a GitHubComment domain type. */
function mapRawCommentToGitHubComment(
  c: RawComment,
  classification: ClassificationLevel,
): GitHubComment {
  return {
    id: c.id,
    author: c.user?.login ?? "unknown",
    body: c.body,
    createdAt: c.created_at,
    htmlUrl: c.html_url,
    classification,
  };
}

/** Fetch comments on an issue or pull request. */
export async function fetchIssueComments(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  issueNumber: number,
  opts?: { readonly perPage?: number; readonly direction?: "asc" | "desc" },
): Promise<Result<readonly GitHubComment[], GitHubError>> {
  const params = new URLSearchParams();
  params.set("per_page", String(opts?.perPage ?? 30));
  if (opts?.direction) params.set("direction", opts.direction);

  const result = await apiRequest<readonly RawComment[]>(
    `${
      buildRepoPath(owner, repo)
    }/issues/${issueNumber}/comments?${params.toString()}`,
  );
  if (!result.ok) return result;

  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );
  const comments = result.value.data.map((c) =>
    mapRawCommentToGitHubComment(c, classification)
  );
  return { ok: true, value: comments };
}

/** Fetch issues from a GitHub repo. */
export async function fetchRepoIssues(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  opts?: {
    readonly state?: string;
    readonly labels?: string;
    readonly perPage?: number;
    readonly sort?: string;
    readonly direction?: "asc" | "desc";
  },
): Promise<Result<readonly GitHubIssue[], GitHubError>> {
  const params = new URLSearchParams();
  params.set("state", opts?.state ?? "open");
  if (opts?.labels) params.set("labels", opts.labels);
  params.set("per_page", String(opts?.perPage ?? 20));
  if (opts?.sort) params.set("sort", opts.sort);
  if (opts?.direction) params.set("direction", opts.direction);

  const result = await apiRequest<readonly RawIssue[]>(
    `${buildRepoPath(owner, repo)}/issues?${params.toString()}`,
  );
  if (!result.ok) return result;

  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );
  const issues = result.value.data.map((i) =>
    mapRawIssueToGitHubIssue(i, classification)
  );
  return { ok: true, value: issues };
}

/** Create an issue on a GitHub repo. */
export async function submitRepoIssue(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  title: string,
  body?: string,
  labels?: readonly string[],
): Promise<Result<GitHubIssue, GitHubError>> {
  const result = await apiRequest<RawIssue>(
    `${buildRepoPath(owner, repo)}/issues`,
    {
      method: "POST",
      body: { title, body: body ?? "", labels: labels ?? [] },
    },
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
    value: mapRawIssueToGitHubIssue(result.value.data, classification),
  };
}

/** Create a comment on a GitHub issue or pull request. */
export async function submitIssueComment(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<
  Result<
    {
      readonly id: number;
      readonly htmlUrl: string;
      readonly classification: ClassificationLevel;
    },
    GitHubError
  >
> {
  const result = await apiRequest<{ id: number; html_url: string }>(
    `${buildRepoPath(owner, repo)}/issues/${issueNumber}/comments`,
    { method: "POST", body: { body } },
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
      id: result.value.data.id,
      htmlUrl: result.value.data.html_url,
      classification,
    },
  };
}
