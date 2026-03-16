/**
 * GitHub tool definitions and system prompt for the agent.
 *
 * Consolidated 4 domain-scoped tools (repos, pulls, issues, actions)
 * with `action` parameter dispatch. Individual definitions are in
 * tools_defs_repos_pulls.ts and tools_defs_issues_actions.ts.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";
import {
  buildGitHubPullsDef,
  buildGitHubReposDef,
} from "./tools_defs_repos_pulls.ts";
import {
  buildGitHubActionsDef,
  buildGitHubIssuesDef,
} from "./tools_defs_issues_actions.ts";

/** Get all 4 consolidated GitHub tool definitions. */
export function loadGitHubToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildGitHubReposDef(),
    buildGitHubPullsDef(),
    buildGitHubIssuesDef(),
    buildGitHubActionsDef(),
  ];
}

/** @deprecated Use loadGitHubToolDefinitions instead */
export const getGitHubToolDefinitions = loadGitHubToolDefinitions;

/** System prompt section explaining GitHub tools to the LLM. */
export const GITHUB_TOOLS_SYSTEM_PROMPT = `## GitHub Access

GitHub authentication is already configured. Do NOT use secret_save or secret_list for GitHub — call the github_* tools directly.
The \`repo\` parameter uses "owner/name" format (e.g. "octocat/Hello-World").
Repository visibility determines classification: public→PUBLIC, private→CONFIDENTIAL, internal→INTERNAL.
Accessing private repos escalates session taint. Never narrate intent — just call the tools directly.

Available tools:
- \`github_repos\`: action = list | get | read_file | list_commits | list_branches | create_branch | delete_branch | clone | pull
- \`github_pulls\`: action = list | get | create | update | list_files | review | merge
- \`github_issues\`: action = list | get | create | update | list_comments | add_comment
- \`github_actions\`: action = list_runs | cancel_run | trigger_workflow | search_code | search_issues

**Efficient querying:** Use \`sort: "updated"\` with \`direction: "desc"\` and \`per_page: 5\` to get the latest activity without fetching everything. Only increase per_page when the user asks for more.`;
