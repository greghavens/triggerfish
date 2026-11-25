/**
 * GitHub client types — configuration and interface definitions.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type {
  GitHubBranch,
  GitHubClassificationConfig,
  GitHubCodeSearchItem,
  GitHubComment,
  GitHubCommit,
  GitHubFileContent,
  GitHubIssue,
  GitHubIssueSearchItem,
  GitHubPull,
  GitHubPullDetail,
  GitHubPullFile,
  GitHubRelease,
  GitHubRepo,
  GitHubRepoDetail,
  GitHubRepositoryPage,
  GitHubWorkflowRun,
  GitHubWorkflowRunState,
} from "./types.ts";
import type { GitHubError } from "./types.ts";
import type { Result } from "../../core/types/classification.ts";

/** Configuration for creating a GitHub client. */
export interface GitHubClientConfig {
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly classificationConfig?: GitHubClassificationConfig;
}

/** GitHub API client interface. */
export interface GitHubClient {
  readonly listRepos: (
    opts?: { readonly page?: number; readonly perPage?: number },
  ) => Promise<Result<readonly GitHubRepo[], GitHubError>>;
  readonly getRepo: (
    owner: string,
    repo: string,
  ) => Promise<Result<GitHubRepoDetail, GitHubError>>;
  readonly readFile: (
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ) => Promise<Result<GitHubFileContent, GitHubError>>;
  readonly listCommits: (
    owner: string,
    repo: string,
    opts?: { readonly sha?: string; readonly perPage?: number },
  ) => Promise<Result<readonly GitHubCommit[], GitHubError>>;
  readonly listBranches: (
    owner: string,
    repo: string,
    opts?: { readonly perPage?: number },
  ) => Promise<Result<GitHubRepositoryPage<GitHubBranch>, GitHubError>>;
  readonly listReleases: (
    owner: string,
    repo: string,
    opts?: { readonly perPage?: number },
  ) => Promise<Result<GitHubRepositoryPage<GitHubRelease>, GitHubError>>;
  readonly createBranch: (
    owner: string,
    repo: string,
    branchName: string,
    sha: string,
  ) => Promise<
    Result<
      {
        readonly ref: string;
        readonly sha: string;
        readonly classification: ClassificationLevel;
      },
      GitHubError
    >
  >;
  readonly deleteBranch: (
    owner: string,
    repo: string,
    branchName: string,
  ) => Promise<
    Result<
      {
        readonly deleted: boolean;
        readonly classification: ClassificationLevel;
      },
      GitHubError
    >
  >;
  readonly listPulls: (
    owner: string,
    repo: string,
    opts?: {
      readonly state?: string;
      readonly perPage?: number;
      readonly sort?: string;
      readonly direction?: "asc" | "desc";
    },
  ) => Promise<Result<readonly GitHubPull[], GitHubError>>;
  readonly createPull: (
    owner: string,
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string,
  ) => Promise<Result<GitHubPull, GitHubError>>;
  readonly submitReview: (
    owner: string,
    repo: string,
    prNumber: number,
    event: string,
    body: string,
  ) => Promise<
    Result<
      {
        readonly id: number;
        readonly state: string;
        readonly classification: ClassificationLevel;
      },
      GitHubError
    >
  >;
  readonly mergePull: (
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { readonly method?: string; readonly commitTitle?: string },
  ) => Promise<
    Result<
      {
        readonly merged: boolean;
        readonly message: string;
        readonly classification: ClassificationLevel;
      },
      GitHubError
    >
  >;
  readonly getPull: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<Result<GitHubPullDetail, GitHubError>>;
  readonly updatePull: (
    owner: string,
    repo: string,
    prNumber: number,
    fields: {
      readonly title?: string;
      readonly body?: string;
      readonly base?: string;
      readonly state?: string;
    },
  ) => Promise<Result<GitHubPullDetail, GitHubError>>;
  readonly listPullFiles: (
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { readonly perPage?: number },
  ) => Promise<Result<readonly GitHubPullFile[], GitHubError>>;
  readonly listIssues: (
    owner: string,
    repo: string,
    opts?: {
      readonly state?: string;
      readonly labels?: string;
      readonly perPage?: number;
      readonly sort?: string;
      readonly direction?: "asc" | "desc";
    },
  ) => Promise<Result<readonly GitHubIssue[], GitHubError>>;
  readonly createIssue: (
    owner: string,
    repo: string,
    title: string,
    body?: string,
    labels?: readonly string[],
  ) => Promise<Result<GitHubIssue, GitHubError>>;
  readonly createComment: (
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ) => Promise<
    Result<
      {
        readonly id: number;
        readonly htmlUrl: string;
        readonly classification: ClassificationLevel;
      },
      GitHubError
    >
  >;
  readonly getIssue: (
    owner: string,
    repo: string,
    issueNumber: number,
  ) => Promise<Result<GitHubIssue, GitHubError>>;
  readonly updateIssue: (
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
  ) => Promise<Result<GitHubIssue, GitHubError>>;
  readonly listComments: (
    owner: string,
    repo: string,
    issueNumber: number,
    opts?: { readonly perPage?: number; readonly direction?: "asc" | "desc" },
  ) => Promise<Result<readonly GitHubComment[], GitHubError>>;
  readonly listWorkflowRuns: (
    owner: string,
    repo: string,
    opts?: {
      readonly workflow?: string;
      readonly branch?: string;
      readonly perPage?: number;
    },
  ) => Promise<Result<readonly GitHubWorkflowRun[], GitHubError>>;
  readonly getWorkflowRun: (
    owner: string,
    repo: string,
    runId: number,
    attempt?: number,
  ) => Promise<Result<GitHubWorkflowRunState, GitHubError>>;
  readonly cancelRun: (
    owner: string,
    repo: string,
    runId: number,
  ) => Promise<
    Result<
      {
        readonly cancelled: boolean;
        readonly classification: ClassificationLevel;
      },
      GitHubError
    >
  >;
  readonly triggerWorkflow: (
    owner: string,
    repo: string,
    workflow: string,
    ref: string,
    inputs?: Readonly<Record<string, string>>,
  ) => Promise<
    Result<
      {
        readonly triggered: boolean;
        readonly classification: ClassificationLevel;
      },
      GitHubError
    >
  >;
  readonly searchCode: (
    query: string,
    opts?: { readonly perPage?: number },
  ) => Promise<Result<readonly GitHubCodeSearchItem[], GitHubError>>;
  readonly searchIssues: (
    query: string,
    opts?: {
      readonly perPage?: number;
      readonly sort?: string;
      readonly order?: "asc" | "desc";
    },
  ) => Promise<Result<readonly GitHubIssueSearchItem[], GitHubError>>;
  readonly cloneRepo: (
    owner: string,
    repo: string,
    destPath: string,
    opts?: { readonly branch?: string; readonly depth?: number },
  ) => Promise<
    Result<
      {
        readonly clonedTo: string;
        readonly classification: ClassificationLevel;
      },
      GitHubError
    >
  >;
  readonly pullRepo: (
    owner: string,
    repo: string,
    localPath: string,
    opts?: { readonly branch?: string },
  ) => Promise<
    Result<
      {
        readonly pulled: boolean;
        readonly classification: ClassificationLevel;
      },
      GitHubError
    >
  >;
}
