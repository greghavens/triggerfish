/**
 * GitHub tool definitions — issues and actions/search domains.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

/** Build the github_issues tool definition. */
export function buildGitHubIssuesDef(): ToolDefinition {
  return {
    name: "github_issues",
    description:
      "Issue operations. Actions: list, get, create, update, list_comments, add_comment.\n" +
      "- list: list issues. Params: repo (required), state?, labels?, per_page?, sort?, direction?\n" +
      "- get: get single issue. Params: repo (required), number (required)\n" +
      "- create: create issue. Params: repo (required), title (required), body?, labels?\n" +
      "- update: update issue. Params: repo (required), number (required), title?, body?, state?, labels?, assignees?\n" +
      "- list_comments: list comments. Params: repo (required), number (required), per_page?, direction?\n" +
      "- add_comment: add comment. Params: repo (required), number (required), body (required)",
    parameters: {
      action: {
        type: "string",
        description:
          "The operation: list, get, create, update, list_comments, add_comment",
        required: true,
      },
      repo: {
        type: "string",
        description: 'Repository in "owner/name" format',
        required: false,
      },
      number: {
        type: "number",
        description: "Issue or PR number",
        required: false,
      },
      title: {
        type: "string",
        description: "Issue title (create, update)",
        required: false,
      },
      body: {
        type: "string",
        description: "Issue body or comment text",
        required: false,
      },
      state: {
        type: "string",
        description:
          'Filter state: "open", "closed", "all" (list) or new state (update)',
        required: false,
      },
      labels: {
        type: "string",
        description: "Comma-separated labels (list, create, update)",
        required: false,
      },
      assignees: {
        type: "string",
        description: "Comma-separated assignees (update)",
        required: false,
      },
      sort: {
        type: "string",
        description: 'Sort by: "created", "updated", "comments" (list)',
        required: false,
      },
      direction: {
        type: "string",
        description: 'Sort direction: "asc", "desc"',
        required: false,
      },
      per_page: {
        type: "number",
        description: "Results per page",
        required: false,
      },
    },
  };
}

/** Build the github_actions tool definition. */
export function buildGitHubActionsDef(): ToolDefinition {
  return {
    name: "github_actions",
    description:
      "CI/CD and search operations. Actions: list_runs, get_run, cancel_run, trigger_workflow, search_code, search_issues.\n" +
      "- list_runs: list workflow runs. Params: repo (required), workflow?, branch?, per_page?\n" +
      "- get_run: read exact workflow run state. Params: repo (required), run_id (required), attempt?\n" +
      "- cancel_run: cancel workflow run. Params: repo (required), run_id (required)\n" +
      "- trigger_workflow: trigger workflow. Params: repo (required), workflow (required), ref (required), inputs?\n" +
      "- search_code: search code. Params: query (required), per_page?\n" +
      "- search_issues: search issues/PRs. Params: query (required), per_page?, sort?, order?",
    parameters: {
      action: {
        type: "string",
        description:
          "The operation: list_runs, get_run, cancel_run, trigger_workflow, search_code, search_issues",
        required: true,
      },
      repo: {
        type: "string",
        description: 'Repository in "owner/name" format',
        required: false,
      },
      workflow: {
        type: "string",
        description: "Workflow filename or ID (list_runs, trigger_workflow)",
        required: false,
      },
      branch: {
        type: "string",
        description: "Branch filter (list_runs)",
        required: false,
      },
      ref: {
        type: "string",
        description: "Git ref for workflow dispatch (trigger_workflow)",
        required: false,
      },
      run_id: {
        type: "number",
        description: "Workflow run ID (get_run, cancel_run)",
        required: false,
      },
      attempt: {
        type: "number",
        description: "Workflow run attempt number (get_run)",
        required: false,
      },
      inputs: {
        type: "object",
        description: "Workflow dispatch inputs (trigger_workflow)",
        required: false,
      },
      query: {
        type: "string",
        description: "Search query (search_code, search_issues)",
        required: false,
      },
      sort: {
        type: "string",
        description:
          'Sort by: "comments", "reactions", "created", "updated" (search_issues)',
        required: false,
      },
      order: {
        type: "string",
        description: 'Sort order: "asc", "desc" (search_issues)',
        required: false,
      },
      per_page: {
        type: "number",
        description: "Results per page",
        required: false,
      },
    },
  };
}
