/**
 * Domain types for the GitHub plugin.
 *
 * All types are readonly and carry a `classification` field derived
 * from repo visibility via `visibilityToClassification()`.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";

/** GitHub repository visibility. */
export type RepoVisibility = "public" | "private" | "internal";

/** A GitHub repository. */
export interface GitHubRepo {
  readonly id: number;
  readonly fullName: string;
  readonly description: string | null;
  readonly visibility: RepoVisibility;
  readonly defaultBranch: string;
  readonly htmlUrl: string;
  readonly classification: ClassificationLevel;
}

/** File content retrieved from the GitHub Content API. */
export interface GitHubFileContent {
  readonly path: string;
  readonly content: string;
  readonly sha: string;
  readonly size: number;
  readonly htmlUrl: string;
  readonly classification: ClassificationLevel;
}

/** A GitHub commit. */
export interface GitHubCommit {
  readonly sha: string;
  readonly message: string;
  readonly author: string;
  readonly date: string;
  readonly htmlUrl: string;
  readonly classification: ClassificationLevel;
}

/** Detailed GitHub repository info (from GET /repos/{o}/{r}). */
export interface GitHubRepoDetail {
  readonly id: number;
  readonly fullName: string;
  readonly description: string | null;
  readonly visibility: RepoVisibility;
  readonly defaultBranch: string;
  readonly htmlUrl: string;
  readonly cloneUrl: string;
  readonly sshUrl: string;
  readonly language: string | null;
  readonly stargazersCount: number;
  readonly forksCount: number;
  readonly topics: readonly string[];
  readonly classification: ClassificationLevel;
}

/** A GitHub branch. */
export interface GitHubBranch {
  readonly name: string;
  readonly protected: boolean;
  readonly classification: ClassificationLevel;
}

/** A GitHub pull request. */
export interface GitHubPull {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly author: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly classification: ClassificationLevel;
}

/** Detailed GitHub pull request (from GET /repos/{o}/{r}/pulls/{n}). */
export interface GitHubPullDetail {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly author: string;
  readonly body: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly mergeable: boolean | null;
  readonly classification: ClassificationLevel;
}

/** A file changed in a pull request. */
export interface GitHubPullFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly classification: ClassificationLevel;
}

/** A GitHub issue. */
export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly author: string;
  readonly body: string | null;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly labels: readonly string[];
  readonly classification: ClassificationLevel;
}

/** A comment on a GitHub issue or pull request. */
export interface GitHubComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly htmlUrl: string;
  readonly classification: ClassificationLevel;
}

/** A GitHub Actions workflow run. */
export interface GitHubWorkflowRun {
  readonly id: number;
  readonly repositoryId?: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headBranch: string;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly classification: ClassificationLevel;
}

/** A binary asset attached to a GitHub release. */
export interface GitHubReleaseAsset {
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly downloadCount: number;
  readonly downloadUrl: string;
  readonly classification: ClassificationLevel;
}

/** A GitHub release. */
export interface GitHubRelease {
  readonly id: number;
  readonly tagName: string;
  readonly name: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly htmlUrl: string;
  readonly assets: readonly GitHubReleaseAsset[];
  readonly classification: ClassificationLevel;
}

/** A GitHub code search result item. */
export interface GitHubCodeSearchItem {
  readonly path: string;
  readonly repo: string;
  readonly htmlUrl: string;
  readonly textMatches: readonly string[];
  readonly classification: ClassificationLevel;
}

/** A GitHub issue search result item. */
export interface GitHubIssueSearchItem {
  readonly number: number;
  readonly title: string;
  readonly repo: string;
  readonly state: string;
  readonly htmlUrl: string;
  readonly classification: ClassificationLevel;
}

/** Error from a GitHub API call. */
export interface GitHubError {
  readonly status: number;
  readonly message: string;
  readonly rateLimitRemaining?: number;
  readonly rateLimitReset?: number;
}

/** Per-repo classification override. */
export interface GitHubClassificationConfig {
  readonly overrides?: Readonly<Record<string, ClassificationLevel>>;
}
