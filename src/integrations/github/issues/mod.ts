/**
 * GitHub issue operations — client, tool handlers, and tool definitions.
 *
 * @module
 */

export {
  fetchIssueComments,
  fetchRepoIssue,
  fetchRepoIssues,
  submitIssueComment,
  submitRepoIssue,
  updateGitHubRepoIssue,
  updateRepoIssue,
} from "./client_issues.ts";

export {
  addGitHubIssueComment,
  createGitHubIssue,
  executeAddComment,
  executeCreateIssue,
  executeGetIssue,
  executeListComments,
  executeListIssues,
  executeUpdateIssue,
  fetchGitHubIssue,
  listGitHubIssueComments,
  listGitHubIssues,
  updateGitHubIssue,
} from "./tools_issues.ts";

export {
  buildAddCommentDef,
  buildCreateIssueDef,
  buildGetIssueDef,
  buildListCommentsDef,
  buildListIssuesDef,
  buildUpdateIssueDef,
} from "./tools_defs_issues.ts";
