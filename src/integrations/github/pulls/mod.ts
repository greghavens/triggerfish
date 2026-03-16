/**
 * GitHub pull request operations — client, tool handlers, and tool definitions.
 *
 * @module
 */

export {
  fetchPullFiles,
  fetchRepoPull,
  fetchRepoPulls,
  mergeRepoPullRequest,
  submitPullRequestReview,
  submitRepoPullRequest,
  updateGitHubRepositoryPull,
  updateRepoPull,
} from "./client_pulls.ts";

export {
  createGitHubPullRequest,
  executeCreatePull,
  executeGetPull,
  executeListPullFiles,
  executeListPulls,
  executeMergePull,
  executeReviewPull,
  executeUpdatePull,
  fetchGitHubPullRequest,
  listGitHubPullRequestFiles,
  listGitHubPullRequests,
  mergeGitHubPullRequest,
  reviewGitHubPullRequest,
  updateGitHubPullRequest,
} from "./tools_pulls.ts";

export {
  buildCreatePullDef,
  buildGetPullDef,
  buildListPullFilesDef,
  buildListPullsDef,
  buildMergePullDef,
  buildReviewPullDef,
  buildUpdatePullDef,
} from "./tools_defs_pulls.ts";
