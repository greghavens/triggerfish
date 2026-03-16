/**
 * GitHub issues tool handlers — list, get, create, update, comment, list_comments.
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

// ─── List Issues ─────────────────────────────────────────────────────────────

/** Handle the github_list_issues tool invocation. */
export async function listGitHubIssues(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_list_issues");
  if (typeof repoResult === "string") return repoResult;

  const state = typeof input.state === "string" ? input.state : undefined;
  const labels = typeof input.labels === "string" ? input.labels : undefined;
  const perPage = typeof input.per_page === "number"
    ? input.per_page
    : undefined;
  const sort = typeof input.sort === "string" ? input.sort : undefined;
  const direction = input.direction === "asc" || input.direction === "desc"
    ? input.direction
    : undefined;
  const result = await client.listIssues(repoResult.owner, repoResult.name, {
    state,
    labels,
    perPage,
    sort,
    direction,
  });
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    issues: result.value.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      author: i.author,
      labels: i.labels,
      url: i.htmlUrl,
      _classification: i.classification,
    })),
  });
}

/** @deprecated Use listGitHubIssues instead */
export const executeListIssues = listGitHubIssues;

// ─── Get Issue ──────────────────────────────────────────────────────────────

/** Handle the github_get_issue tool invocation. */
export async function fetchGitHubIssue(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_get_issue");
  if (typeof repoResult === "string") return repoResult;

  const number = assertPositiveIntValue(
    input.number,
    "number",
    "github_get_issue",
  );
  if (typeof number === "string") return number;

  const result = await client.getIssue(
    repoResult.owner,
    repoResult.name,
    number,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    number: result.value.number,
    title: result.value.title,
    state: result.value.state,
    author: result.value.author,
    body: result.value.body,
    labels: result.value.labels,
    created_at: result.value.createdAt,
    url: result.value.htmlUrl,
    _classification: result.value.classification,
  });
}

/** @deprecated Use fetchGitHubIssue instead */
export const executeGetIssue = fetchGitHubIssue;

// ─── Create Issue ────────────────────────────────────────────────────────────

/** Handle the github_create_issue tool invocation. */
export async function createGitHubIssue(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_create_issue");
  if (typeof repoResult === "string") return repoResult;

  const title = input.title;
  if (typeof title !== "string" || title.length === 0) {
    return "Error: github_create_issue requires a 'title' argument.";
  }
  const body = typeof input.body === "string" ? input.body : undefined;
  const labels = typeof input.labels === "string"
    ? input.labels.split(",").map((l) => l.trim())
    : undefined;

  const result = await client.createIssue(
    repoResult.owner,
    repoResult.name,
    title,
    body,
    labels,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    number: result.value.number,
    title: result.value.title,
    url: result.value.htmlUrl,
    _classification: result.value.classification,
  });
}

/** @deprecated Use createGitHubIssue instead */
export const executeCreateIssue = createGitHubIssue;

// ─── Update Issue ───────────────────────────────────────────────────────────

/** Build the update fields from the input. */
function buildIssueUpdateFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof input.title === "string") fields.title = input.title;
  if (typeof input.body === "string") fields.body = input.body;
  if (typeof input.state === "string") fields.state = input.state;
  if (typeof input.labels === "string") {
    fields.labels = (input.labels as string).split(",").map((l) => l.trim());
  }
  if (typeof input.assignees === "string") {
    fields.assignees = (input.assignees as string).split(",").map((a) =>
      a.trim()
    );
  }
  return fields;
}

/** Handle the github_update_issue tool invocation. */
export async function updateGitHubIssue(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_update_issue");
  if (typeof repoResult === "string") return repoResult;

  const number = assertPositiveIntValue(
    input.number,
    "number",
    "github_update_issue",
  );
  if (typeof number === "string") return number;

  const fields = buildIssueUpdateFields(input);
  const result = await client.updateIssue(
    repoResult.owner,
    repoResult.name,
    number,
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

/** @deprecated Use updateGitHubIssue instead */
export const executeUpdateIssue = updateGitHubIssue;

// ─── List Comments ──────────────────────────────────────────────────────────

/** Handle the github_list_comments tool invocation. */
export async function listGitHubIssueComments(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_list_comments");
  if (typeof repoResult === "string") return repoResult;

  const number = assertPositiveIntValue(
    input.number,
    "number",
    "github_list_comments",
  );
  if (typeof number === "string") return number;
  const perPage = typeof input.per_page === "number"
    ? input.per_page
    : undefined;
  const direction = input.direction === "desc" ? "desc" as const : undefined;

  const result = await client.listComments(
    repoResult.owner,
    repoResult.name,
    number,
    { perPage, direction },
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    comments: result.value.map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      created_at: c.createdAt,
      url: c.htmlUrl,
      _classification: c.classification,
    })),
  });
}

/** @deprecated Use listGitHubIssueComments instead */
export const executeListComments = listGitHubIssueComments;

// ─── Comment on Issue ────────────────────────────────────────────────────────

/** Handle the github_add_comment tool invocation. */
export async function addGitHubIssueComment(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_add_comment");
  if (typeof repoResult === "string") return repoResult;

  const number = assertPositiveIntValue(
    input.number,
    "number",
    "github_add_comment",
  );
  if (typeof number === "string") return number;
  const body = input.body;
  if (typeof body !== "string" || body.length === 0) {
    return "Error: github_add_comment requires a 'body' argument.";
  }

  const result = await client.createComment(
    repoResult.owner,
    repoResult.name,
    number,
    body,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    id: result.value.id,
    url: result.value.htmlUrl,
    _classification: result.value.classification,
  });
}

/** @deprecated Use addGitHubIssueComment instead */
export const executeAddComment = addGitHubIssueComment;
