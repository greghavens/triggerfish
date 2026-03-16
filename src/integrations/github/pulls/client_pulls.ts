/**
 * GitHub client — pull request operations.
 *
 * Facade re-exporting from client_pulls_query.ts and client_pulls_mutate.ts.
 *
 * @module
 */

export {
  fetchPullFiles,
  fetchRepoPull,
  fetchRepoPulls,
} from "./client_pulls_query.ts";

export {
  mergeRepoPullRequest,
  submitPullRequestReview,
  submitRepoPullRequest,
  updateGitHubRepositoryPull,
  updateRepoPull,
} from "./client_pulls_mutate.ts";
