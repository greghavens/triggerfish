/**
 * GitHub client — pull request mutation operations (create, update, review, merge).
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../../core/types/classification.ts";
import type { GitHubError, GitHubPull, GitHubPullDetail } from "../types.ts";
import type {
  ApiRequestFn,
  ClassifyRepoFn,
  RawPull,
  RawPullDetail,
} from "../client_http.ts";
import { buildRepoPath, fetchRepoClassification } from "../client_http.ts";
import {
  mapRawPullDetailToGitHubPullDetail,
  mapRawPullToGitHubPull,
} from "./client_pulls_query.ts";

/** Update a pull request on a GitHub repo. */
export async function updateGitHubRepositoryPull(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  prNumber: number,
  fields: {
    readonly title?: string;
    readonly body?: string;
    readonly base?: string;
    readonly state?: string;
  },
): Promise<Result<GitHubPullDetail, GitHubError>> {
  const result = await apiRequest<RawPullDetail>(
    `${buildRepoPath(owner, repo)}/pulls/${prNumber}`,
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
    value: mapRawPullDetailToGitHubPullDetail(
      result.value.data,
      classification,
    ),
  };
}

/** @deprecated Use updateGitHubRepositoryPull instead */
export const updateRepoPull = updateGitHubRepositoryPull;

/** Create a pull request on a GitHub repo. */
export async function submitRepoPullRequest(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body?: string,
): Promise<Result<GitHubPull, GitHubError>> {
  const result = await apiRequest<RawPull>(
    `${buildRepoPath(owner, repo)}/pulls`,
    { method: "POST", body: { title, head, base, body: body ?? "" } },
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
    value: mapRawPullToGitHubPull(result.value.data, classification),
  };
}

/** Submit a review on a GitHub pull request. */
export async function submitPullRequestReview(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  prNumber: number,
  event: string,
  body: string,
): Promise<
  Result<
    {
      readonly id: number;
      readonly state: string;
      readonly classification: ClassificationLevel;
    },
    GitHubError
  >
> {
  const result = await apiRequest<{ id: number; state: string }>(
    `${buildRepoPath(owner, repo)}/pulls/${prNumber}/reviews`,
    { method: "POST", body: { event, body } },
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
      state: result.value.data.state,
      classification,
    },
  };
}

/** Build the merge request body. */
function buildMergeRequestBody(
  opts?: { readonly method?: string; readonly commitTitle?: string },
): Record<string, unknown> {
  return {
    merge_method: opts?.method ?? "merge",
    ...(opts?.commitTitle ? { commit_title: opts.commitTitle } : {}),
  };
}

/** Merge a pull request on a GitHub repo. */
export async function mergeRepoPullRequest(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  prNumber: number,
  opts?: { readonly method?: string; readonly commitTitle?: string },
): Promise<
  Result<
    {
      readonly merged: boolean;
      readonly message: string;
      readonly classification: ClassificationLevel;
    },
    GitHubError
  >
> {
  const result = await apiRequest<{ merged: boolean; message: string }>(
    `${buildRepoPath(owner, repo)}/pulls/${prNumber}/merge`,
    { method: "PUT", body: buildMergeRequestBody(opts) },
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
      merged: result.value.data.merged,
      message: result.value.data.message,
      classification,
    },
  };
}
