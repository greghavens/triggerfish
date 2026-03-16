/**
 * GitHub pull request tool handlers — list, get, create, update, review, merge, list_files.
 *
 * Each handler validates inputs, calls the GitHubClient, and
 * formats the response as a JSON string for the agent.
 *
 * @module
 */

import type { GitHubClient } from "../client.ts";
import {
  assertPositiveIntValue,
  assertValidRepoInput,
  formatGitHubError,
} from "../tools_shared.ts";

// ─── List Pulls ──────────────────────────────────────────────────────────────

/** Handle the github_list_pulls tool invocation. */
export async function listGitHubPullRequests(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_list_pulls");
  if (typeof repoResult === "string") return repoResult;

  const state = typeof input.state === "string" ? input.state : undefined;
  const perPage = typeof input.per_page === "number"
    ? input.per_page
    : undefined;
  const sort = typeof input.sort === "string" ? input.sort : undefined;
  const direction = input.direction === "asc" || input.direction === "desc"
    ? input.direction
    : undefined;
  const result = await client.listPulls(repoResult.owner, repoResult.name, {
    state,
    perPage,
    sort,
    direction,
  });
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    pulls: result.value.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      author: p.author,
      head: p.headRef,
      base: p.baseRef,
      url: p.htmlUrl,
      _classification: p.classification,
    })),
  });
}

/** @deprecated Use listGitHubPullRequests instead */
export const executeListPulls = listGitHubPullRequests;

// ─── Get Pull ───────────────────────────────────────────────────────────────

/** Handle the github_get_pull tool invocation. */
export async function fetchGitHubPullRequest(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_get_pull");
  if (typeof repoResult === "string") return repoResult;

  const prNumber = assertPositiveIntValue(
    input.pr_number,
    "pr_number",
    "github_get_pull",
  );
  if (typeof prNumber === "string") return prNumber;

  const result = await client.getPull(
    repoResult.owner,
    repoResult.name,
    prNumber,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    number: result.value.number,
    title: result.value.title,
    state: result.value.state,
    author: result.value.author,
    body: result.value.body,
    head: result.value.headRef,
    base: result.value.baseRef,
    additions: result.value.additions,
    deletions: result.value.deletions,
    changed_files: result.value.changedFiles,
    mergeable: result.value.mergeable,
    created_at: result.value.createdAt,
    url: result.value.htmlUrl,
    _classification: result.value.classification,
  });
}

/** @deprecated Use fetchGitHubPullRequest instead */
export const executeGetPull = fetchGitHubPullRequest;

// ─── Create Pull ─────────────────────────────────────────────────────────────

/** Validate the required string fields for pull creation. */
function validatePullCreateFields(input: Record<string, unknown>): {
  readonly title: string;
  readonly head: string;
  readonly base: string;
} | string {
  const title = input.title;
  if (typeof title !== "string" || title.length === 0) {
    return "Error: github_create_pull requires a 'title' argument.";
  }
  const head = input.head;
  if (typeof head !== "string" || head.length === 0) {
    return "Error: github_create_pull requires a 'head' argument.";
  }
  const base = input.base;
  if (typeof base !== "string" || base.length === 0) {
    return "Error: github_create_pull requires a 'base' argument.";
  }
  return { title, head, base };
}

/** Handle the github_create_pull tool invocation. */
export async function createGitHubPullRequest(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_create_pull");
  if (typeof repoResult === "string") return repoResult;

  const fields = validatePullCreateFields(input);
  if (typeof fields === "string") return fields;

  const body = typeof input.body === "string" ? input.body : undefined;
  const result = await client.createPull(
    repoResult.owner,
    repoResult.name,
    fields.title,
    fields.head,
    fields.base,
    body,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    number: result.value.number,
    title: result.value.title,
    url: result.value.htmlUrl,
    _classification: result.value.classification,
  });
}

/** @deprecated Use createGitHubPullRequest instead */
export const executeCreatePull = createGitHubPullRequest;

// ─── Update Pull ────────────────────────────────────────────────────────────

/** Handle the github_update_pull tool invocation. */
export async function updateGitHubPullRequest(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_update_pull");
  if (typeof repoResult === "string") return repoResult;

  const prNumber = assertPositiveIntValue(
    input.pr_number,
    "pr_number",
    "github_update_pull",
  );
  if (typeof prNumber === "string") return prNumber;

  const fields: Record<string, unknown> = {};
  if (typeof input.title === "string") fields.title = input.title;
  if (typeof input.body === "string") fields.body = input.body;
  if (typeof input.base === "string") fields.base = input.base;
  if (typeof input.state === "string") fields.state = input.state;

  const result = await client.updatePull(
    repoResult.owner,
    repoResult.name,
    prNumber,
    fields,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    number: result.value.number,
    title: result.value.title,
    state: result.value.state,
    url: result.value.htmlUrl,
    _classification: result.value.classification,
  });
}

/** @deprecated Use updateGitHubPullRequest instead */
export const executeUpdatePull = updateGitHubPullRequest;

// ─── List Pull Files ────────────────────────────────────────────────────────

/** Handle the github_list_pull_files tool invocation. */
export async function listGitHubPullRequestFiles(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_list_pull_files");
  if (typeof repoResult === "string") return repoResult;

  const prNumber = assertPositiveIntValue(
    input.pr_number,
    "pr_number",
    "github_list_pull_files",
  );
  if (typeof prNumber === "string") return prNumber;
  const perPage = typeof input.per_page === "number"
    ? input.per_page
    : undefined;

  const result = await client.listPullFiles(
    repoResult.owner,
    repoResult.name,
    prNumber,
    { perPage },
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    files: result.value.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      _classification: f.classification,
    })),
  });
}

/** @deprecated Use listGitHubPullRequestFiles instead */
export const executeListPullFiles = listGitHubPullRequestFiles;

// ─── Submit Review ───────────────────────────────────────────────────────────

/** Handle the github_review_pull tool invocation. */
export async function reviewGitHubPullRequest(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_review_pull");
  if (typeof repoResult === "string") return repoResult;

  const prNumber = assertPositiveIntValue(
    input.pr_number,
    "pr_number",
    "github_review_pull",
  );
  if (typeof prNumber === "string") return prNumber;
  const event = input.event;
  if (typeof event !== "string" || event.length === 0) {
    return "Error: github_review_pull requires an 'event' argument (APPROVE, REQUEST_CHANGES, or COMMENT).";
  }
  const body = input.body;
  if (typeof body !== "string" || body.length === 0) {
    return "Error: github_review_pull requires a 'body' argument.";
  }

  const result = await client.submitReview(
    repoResult.owner,
    repoResult.name,
    prNumber,
    event,
    body,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    id: result.value.id,
    state: result.value.state,
    _classification: result.value.classification,
  });
}

/** @deprecated Use reviewGitHubPullRequest instead */
export const executeReviewPull = reviewGitHubPullRequest;

// ─── Merge Pull ──────────────────────────────────────────────────────────────

/** Handle the github_merge_pull tool invocation. */
export async function mergeGitHubPullRequest(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_merge_pull");
  if (typeof repoResult === "string") return repoResult;

  const prNumber = assertPositiveIntValue(
    input.pr_number,
    "pr_number",
    "github_merge_pull",
  );
  if (typeof prNumber === "string") return prNumber;
  const method = typeof input.method === "string" ? input.method : undefined;
  const commitTitle = typeof input.commit_title === "string"
    ? input.commit_title
    : undefined;

  const result = await client.mergePull(
    repoResult.owner,
    repoResult.name,
    prNumber,
    { method, commitTitle },
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    merged: result.value.merged,
    message: result.value.message,
    _classification: result.value.classification,
  });
}

/** @deprecated Use mergeGitHubPullRequest instead */
export const executeMergePull = mergeGitHubPullRequest;
