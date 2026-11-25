/**
 * GitHub client — workflow and search operations.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../../core/types/classification.ts";
import type {
  GitHubCodeSearchItem,
  GitHubError,
  GitHubIssueSearchItem,
  GitHubWorkflowRun,
} from "../types.ts";
import type {
  ApiRequestFn,
  ClassifyRepoFn,
  RawCodeSearchItem,
  RawIssueSearchItem,
  RawWorkflowRun,
} from "../client_http.ts";
import { buildRepoPath, fetchRepoClassification } from "../client_http.ts";

// ─── Workflow runs ───────────────────────────────────────────────────────────

/** Build the workflow runs API path. */
function buildWorkflowRunsPath(
  owner: string,
  repo: string,
  workflow?: string,
): string {
  const base = buildRepoPath(owner, repo);
  if (workflow) {
    return `${base}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
  }
  return `${base}/actions/runs`;
}

/** Map a raw workflow run to a GitHubWorkflowRun domain type. */
function mapRawWorkflowRunToGitHubRun(
  r: RawWorkflowRun,
  classification: ClassificationLevel,
): GitHubWorkflowRun {
  const repositoryId = r.repository?.id;
  return {
    id: r.id,
    ...(typeof repositoryId === "number" &&
      Number.isSafeInteger(repositoryId) &&
      repositoryId > 0 && { repositoryId }),
    name: r.name ?? "",
    status: r.status,
    conclusion: r.conclusion ?? null,
    headBranch: r.head_branch,
    htmlUrl: r.html_url,
    createdAt: r.created_at,
    classification,
  };
}

/** Fetch workflow runs from a GitHub repo. */
export async function fetchRepoWorkflowRuns(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  opts?: {
    readonly workflow?: string;
    readonly branch?: string;
    readonly perPage?: number;
  },
): Promise<Result<readonly GitHubWorkflowRun[], GitHubError>> {
  const path = buildWorkflowRunsPath(owner, repo, opts?.workflow);
  const params = new URLSearchParams();
  if (opts?.branch) params.set("branch", opts.branch);
  params.set("per_page", String(opts?.perPage ?? 10));

  const result = await apiRequest<
    { workflow_runs: readonly RawWorkflowRun[] }
  >(`${path}?${params.toString()}`);
  if (!result.ok) return result;

  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );
  const runs = result.value.data.workflow_runs.map((r) =>
    mapRawWorkflowRunToGitHubRun(r, classification)
  );
  return { ok: true, value: runs };
}

/** Cancel a workflow run on a GitHub repo. */
export async function cancelRepoWorkflowRun(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  runId: number,
): Promise<
  Result<
    {
      readonly cancelled: boolean;
      readonly classification: ClassificationLevel;
    },
    GitHubError
  >
> {
  const path = `${buildRepoPath(owner, repo)}/actions/runs/${runId}/cancel`;
  const result = await apiRequest<undefined>(path, { method: "POST" });
  if (!result.ok) return result;

  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );
  return { ok: true, value: { cancelled: true, classification } };
}

/** Trigger a workflow dispatch on a GitHub repo. */
export async function dispatchRepoWorkflow(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  owner: string,
  repo: string,
  workflow: string,
  ref: string,
  inputs?: Readonly<Record<string, string>>,
): Promise<
  Result<
    {
      readonly triggered: boolean;
      readonly classification: ClassificationLevel;
    },
    GitHubError
  >
> {
  const path = `${buildRepoPath(owner, repo)}/actions/workflows/${
    encodeURIComponent(workflow)
  }/dispatches`;
  const result = await apiRequest<undefined>(
    path,
    { method: "POST", body: { ref, inputs: inputs ?? {} } },
  );
  if (!result.ok) return result;

  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );
  return { ok: true, value: { triggered: true, classification } };
}

// ─── Code search ─────────────────────────────────────────────────────────────

/** Map a raw code search item to a GitHubCodeSearchItem. */
function mapRawCodeSearchItemToResult(
  item: RawCodeSearchItem,
  classifyRepo: ClassifyRepoFn,
): GitHubCodeSearchItem {
  return {
    path: item.path,
    repo: item.repository.full_name,
    htmlUrl: item.html_url,
    textMatches: (item.text_matches ?? []).map((m) => m.fragment ?? ""),
    classification: classifyRepo(
      item.repository.visibility ??
        (item.repository.private ? "private" : "public"),
      item.repository.full_name,
    ),
  };
}

/** Search code across GitHub repositories. */
export async function searchGitHubCode(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  query: string,
  opts?: { readonly perPage?: number },
): Promise<Result<readonly GitHubCodeSearchItem[], GitHubError>> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("per_page", String(opts?.perPage ?? 10));

  const result = await apiRequest<
    { items: readonly RawCodeSearchItem[] }
  >(`/search/code?${params.toString()}`);
  if (!result.ok) return result;

  const items = result.value.data.items.map((item) =>
    mapRawCodeSearchItemToResult(item, classifyRepo)
  );
  return { ok: true, value: items };
}

// ─── Issue search ────────────────────────────────────────────────────────────

/** Derive classification from a raw issue search item. */
function classifyIssueSearchItem(
  item: RawIssueSearchItem,
  classifyRepo: ClassifyRepoFn,
  repoFullName: string,
): ClassificationLevel {
  if (item.repository) {
    return classifyRepo(
      item.repository.visibility ??
        (item.repository.private ? "private" : "public"),
      item.repository.full_name,
    );
  }
  // No repository metadata — default to CONFIDENTIAL (default-deny).
  return repoFullName ? classifyRepo("private", repoFullName) : "CONFIDENTIAL";
}

/** Map a raw issue search item to a GitHubIssueSearchItem. */
function mapRawIssueSearchItemToResult(
  item: RawIssueSearchItem,
  classifyRepo: ClassifyRepoFn,
  baseUrl: string,
): GitHubIssueSearchItem {
  const repoFullName = item.repository_url?.replace(
    `${baseUrl}/repos/`,
    "",
  ) ?? "";
  return {
    number: item.number,
    title: item.title,
    repo: repoFullName,
    state: item.state,
    htmlUrl: item.html_url,
    classification: classifyIssueSearchItem(item, classifyRepo, repoFullName),
  };
}

/** Search issues across GitHub repositories. */
export async function searchGitHubIssues(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  baseUrl: string,
  query: string,
  opts?: {
    readonly perPage?: number;
    readonly sort?: string;
    readonly order?: "asc" | "desc";
  },
): Promise<Result<readonly GitHubIssueSearchItem[], GitHubError>> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("per_page", String(opts?.perPage ?? 10));
  if (opts?.sort) params.set("sort", opts.sort);
  if (opts?.order) params.set("order", opts.order);

  const result = await apiRequest<
    { items: readonly RawIssueSearchItem[] }
  >(`/search/issues?${params.toString()}`);
  if (!result.ok) return result;

  const items = result.value.data.items.map((item) =>
    mapRawIssueSearchItemToResult(item, classifyRepo, baseUrl)
  );
  return { ok: true, value: items };
}
