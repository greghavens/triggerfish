/**
 * GitHub search tool handlers — code search, issue search.
 *
 * Each handler validates inputs, calls the GitHubClient, and
 * formats the response as a JSON string for the agent.
 *
 * @module
 */

import type { GitHubClient } from "../client.ts";
import { formatGitHubError } from "../tools_shared.ts";

// ─── Search Code ─────────────────────────────────────────────────────────────

/** Handle the github_search_code tool invocation. */
export async function queryGitHubCode(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const query = input.query;
  if (typeof query !== "string" || query.length === 0) {
    return "Error: github_search_code requires a 'query' argument.";
  }
  const perPage = typeof input.per_page === "number"
    ? input.per_page
    : undefined;
  const result = await client.searchCode(query, { perPage });
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    results: result.value.map((item) => ({
      path: item.path,
      repo: item.repo,
      url: item.htmlUrl,
      matches: item.textMatches,
      _classification: item.classification,
    })),
  });
}

/** @deprecated Use queryGitHubCode instead */
export const executeSearchCode = queryGitHubCode;

// ─── Search Issues ───────────────────────────────────────────────────────────

/** Handle the github_search_issues tool invocation. */
export async function queryGitHubIssues(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const query = input.query;
  if (typeof query !== "string" || query.length === 0) {
    return "Error: github_search_issues requires a 'query' argument.";
  }
  const perPage = typeof input.per_page === "number"
    ? input.per_page
    : undefined;
  const sort = typeof input.sort === "string" ? input.sort : undefined;
  const order = input.order === "asc" || input.order === "desc"
    ? input.order
    : undefined;
  const result = await client.searchIssues(query, { perPage, sort, order });
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    results: result.value.map((item) => ({
      number: item.number,
      title: item.title,
      repo: item.repo,
      state: item.state,
      url: item.htmlUrl,
      _classification: item.classification,
    })),
  });
}

/** @deprecated Use queryGitHubIssues instead */
export const executeSearchIssues = queryGitHubIssues;
