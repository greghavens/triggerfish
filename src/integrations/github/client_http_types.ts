/**
 * Raw GitHub REST API response types (snake_case matching GitHub).
 *
 * Separated from client_http.ts to keep each file under 300 lines.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../core/types/classification.ts";
import type { GitHubError, RepoVisibility } from "./types.ts";

// ─── Shared function signatures ──────────────────────────────────────────────

/** Authenticated API request function signature. */
export type ApiRequestFn = <T>(
  path: string,
  options?: {
    readonly method?: string;
    readonly body?: unknown;
  },
) => Promise<Result<{ data: T; repoVisibility?: RepoVisibility }, GitHubError>>;

/** Classification function signature. */
export type ClassifyRepoFn = (
  visibility: string | undefined,
  fullName: string,
) => ClassificationLevel;

// ─── Raw API types (snake_case matching GitHub REST API) ─────────────────────

export interface RawRepo {
  readonly id: number;
  readonly full_name: string;
  readonly description?: string | null;
  readonly visibility?: string;
  readonly private: boolean;
  readonly default_branch: string;
  readonly html_url: string;
}

export interface RawContent {
  readonly path: string;
  readonly content: string;
  readonly sha: string;
  readonly size: number;
  readonly html_url: string;
}

export interface RawCommit {
  readonly sha: string;
  readonly commit: {
    readonly message: string;
    readonly author?: { readonly name?: string; readonly date?: string };
  };
  readonly author?: { readonly login?: string };
  readonly html_url: string;
}

export interface RawBranch {
  readonly name: string;
  readonly protected: boolean;
}

export interface RawPull {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly user?: { readonly login?: string };
  readonly head: { readonly ref: string };
  readonly base: { readonly ref: string };
  readonly html_url: string;
  readonly created_at: string;
}

export interface RawPullDetail {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly user?: { readonly login?: string };
  readonly body?: string | null;
  readonly head: { readonly ref: string };
  readonly base: { readonly ref: string };
  readonly html_url: string;
  readonly created_at: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly mergeable?: boolean | null;
}

export interface RawPullFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface RawComment {
  readonly id: number;
  readonly user?: { readonly login?: string };
  readonly body: string;
  readonly created_at: string;
  readonly html_url: string;
}

export interface RawIssue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly user?: { readonly login?: string };
  readonly body?: string | null;
  readonly html_url: string;
  readonly created_at: string;
  readonly labels?: readonly (string | { readonly name?: string })[];
}

export interface RawWorkflowRun {
  readonly id: number;
  readonly repository?: { readonly id?: unknown };
  readonly name?: string;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly head_branch: string;
  readonly html_url: string;
  readonly created_at: string;
}

export interface RawReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly content_type: string;
  readonly size: number;
  readonly download_count: number;
  readonly browser_download_url: string;
}

export interface RawRelease {
  readonly id: number;
  readonly tag_name: string;
  readonly name?: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly created_at: string;
  readonly published_at?: string | null;
  readonly html_url: string;
  readonly assets: readonly RawReleaseAsset[];
}

export interface RawCodeSearchItem {
  readonly path: string;
  readonly html_url: string;
  readonly repository: {
    readonly full_name: string;
    readonly visibility?: string;
    readonly private: boolean;
  };
  readonly text_matches?: readonly { readonly fragment?: string }[];
}

export interface RawIssueSearchItem {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly html_url: string;
  readonly repository_url?: string;
  readonly repository?: {
    readonly full_name: string;
    readonly visibility?: string;
    readonly private: boolean;
  };
}
