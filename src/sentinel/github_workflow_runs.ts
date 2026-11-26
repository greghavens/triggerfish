/** Read minimized evidence from one operator-configured GitHub Actions workflow. */
import { isApprovedHistoryBranchName } from "../core/execution_traces.ts";
import {
  safeFetchWithRedirects,
  type SsrfChecker,
} from "../core/security/safe_fetch.ts";

export interface SentinelGitHubWorkflowTarget {
  readonly owner: string;
  readonly repo: string;
  readonly workflowId: number;
}

export interface SentinelGitHubWorkflowRun {
  readonly id: number;
  readonly repositoryId?: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
}

export interface SentinelGitHubWorkflowOptions {
  readonly token: string;
  readonly signal?: AbortSignal;
  readonly ssrfChecker?: SsrfChecker;
  /** Test transport seam. Production always uses the checked fetcher. */
  readonly request?: typeof safeFetchWithRedirects;
}

const pageSize = 10;
const maxBodyBytes = 512 * 1024;
const deadlineMs = 5_000;

const statuses = new Set([
  "requested",
  "waiting",
  "queued",
  "pending",
  "in_progress",
  "completed",
]);

const conclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isSentinelGitHubWorkflowTarget(
  value: unknown,
): value is SentinelGitHubWorkflowTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const { owner, repo, workflowId } = value as Record<string, unknown>;
  return isSentinelGitHubRepositoryTarget(owner, repo) &&
    positiveId(workflowId);
}

export function isSentinelGitHubRepositoryTarget(
  owner: unknown,
  repo: unknown,
) {
  return typeof owner === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) &&
    typeof repo === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(repo) &&
    repo !== "." && repo !== "..";
}

export function sentinelGitHubWorkflowMetadataUrl(
  target: SentinelGitHubWorkflowTarget,
): string {
  if (!isSentinelGitHubWorkflowTarget(target)) {
    throw new Error("Invalid configured GitHub Actions target.");
  }
  return `https://api.github.com/repos/${target.owner}/${target.repo}/actions/workflows/${target.workflowId}`;
}

export function sentinelGitHubWorkflowRunsUrl(
  target: SentinelGitHubWorkflowTarget,
): string {
  return `${
    sentinelGitHubWorkflowMetadataUrl(target)
  }/runs?per_page=${pageSize}&page=1`;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid GitHub Actions data.");
  }
  return value as Record<string, unknown>;
}

function time(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) throw new Error("Invalid GitHub Actions timestamp.");
  const canonical = new Date(value).toISOString();
  if (
    canonical !==
      value.replace(
        /(?:\.(\d{1,3}))?Z$/,
        (_, fraction = "") => `.${fraction.padEnd(3, "0")}Z`,
      )
  ) throw new Error("Invalid GitHub Actions timestamp.");
  return canonical;
}

function normalize(
  raw: unknown,
  target: SentinelGitHubWorkflowTarget,
): readonly SentinelGitHubWorkflowRun[] {
  const rows = record(raw).workflow_runs;
  if (!Array.isArray(rows) || rows.length > pageSize) {
    throw new Error("Invalid GitHub Actions run page.");
  }
  const scope = `${target.owner}/${target.repo}`.toLowerCase();
  const ids = new Set<number>();
  let repositoryId: number | undefined;
  return rows.map((raw) => {
    const run = record(raw);
    const { id, status, conclusion } = run;
    const repository = record(run.repository);
    const fullName = repository.full_name;
    const runRepositoryId = repository.id;
    if (
      !positiveId(id) || ids.has(id) || run.workflow_id !== target.workflowId ||
      typeof fullName !== "string" || fullName.toLowerCase() !== scope ||
      (runRepositoryId !== undefined &&
        (!positiveId(runRepositoryId) ||
          repositoryId !== undefined && repositoryId !== runRepositoryId)) ||
      typeof status !== "string" || !statuses.has(status) ||
      (conclusion !== null &&
        (typeof conclusion !== "string" || !conclusions.has(conclusion)))
    ) throw new Error("Invalid GitHub Actions run.");
    if (positiveId(runRepositoryId)) repositoryId = runRepositoryId;
    ids.add(id);
    const createdAt = time(run.created_at);
    const updatedAt = time(run.updated_at);
    const startedAt = run.run_started_at == null
      ? undefined
      : time(run.run_started_at);
    if (updatedAt < createdAt || (startedAt && startedAt < createdAt)) {
      throw new Error("Invalid GitHub Actions timestamp order.");
    }
    return {
      id,
      ...(positiveId(runRepositoryId) && { repositoryId: runRepositoryId }),
      status,
      conclusion,
      createdAt,
      updatedAt,
      ...(startedAt && { startedAt }),
    };
  });
}

async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub Actions response was empty.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let decoded = "";
  let bytes = 0;
  let done = false;
  try {
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > maxBodyBytes) {
      throw new Error("GitHub Actions response exceeded its size limit.");
    }
    while (!done) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) {
        bytes += chunk.value.byteLength;
        if (bytes > maxBodyBytes) {
          throw new Error("GitHub Actions response exceeded its size limit.");
        }
        decoded += decoder.decode(chunk.value, { stream: true });
      }
    }
    signal.throwIfAborted();
    return JSON.parse(decoded + decoder.decode());
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function readSentinelGitHubWorkflowRuns(
  target: SentinelGitHubWorkflowTarget,
  options: SentinelGitHubWorkflowOptions,
): Promise<readonly SentinelGitHubWorkflowRun[]> {
  return readSentinelGitHubJson(
    sentinelGitHubWorkflowRunsUrl(target),
    options,
    (body) => normalize(body, target),
  );
}

/** Verify permission on the exact workflow without repeating the runs request. */
export function verifySentinelGitHubWorkflowAccess(
  target: SentinelGitHubWorkflowTarget,
  options: SentinelGitHubWorkflowOptions,
): Promise<boolean> {
  return readSentinelGitHubJson(
    sentinelGitHubWorkflowMetadataUrl(target),
    options,
    (body) => record(body).id === target.workflowId,
  );
}

export function sentinelGitHubRepositoryUrl(owner: string, repo: string) {
  if (!isSentinelGitHubRepositoryTarget(owner, repo)) {
    throw new Error("Invalid configured GitHub repository.");
  }
  return `https://api.github.com/repos/${owner}/${repo}`;
}

export function readSentinelGitHubRepositoryVisibility(
  target: { owner: string; repo: string; repositoryId: number },
  options: SentinelGitHubWorkflowOptions,
) {
  return readSentinelGitHubJson(
    sentinelGitHubRepositoryUrl(target.owner, target.repo),
    options,
    (body) => {
      const { id, full_name, visibility } = record(body);
      if (
        !positiveId(target.repositoryId) || id !== target.repositoryId ||
        typeof full_name !== "string" ||
        full_name.toLowerCase() !==
          `${target.owner}/${target.repo}`.toLowerCase() ||
        (visibility !== "public" && visibility !== "internal" &&
          visibility !== "private")
      ) {
        throw new Error(
          "GitHub repository identity or visibility is unavailable.",
        );
      }
      return visibility;
    },
  );
}

export function sentinelGitHubBranchUrl(
  owner: string,
  repo: string,
  branch: string,
) {
  if (!isApprovedHistoryBranchName(branch)) {
    throw new Error("Invalid configured GitHub branch.");
  }
  return `${sentinelGitHubRepositoryUrl(owner, repo)}/branches/${
    encodeURIComponent(branch)
  }`;
}

export function sentinelGitHubBranchRefUrl(
  owner: string,
  repo: string,
  branch: string,
) {
  if (!isApprovedHistoryBranchName(branch)) {
    throw new Error("Invalid configured GitHub branch.");
  }
  return `${sentinelGitHubRepositoryUrl(owner, repo)}/git/ref/heads/${
    encodeURIComponent(branch)
  }`;
}

/** Prove access to the exact ref without retaining its object or protection data. */
export function verifySentinelGitHubBranchContents(
  target: { owner: string; repo: string; branch: string },
  options: SentinelGitHubWorkflowOptions,
) {
  return readSentinelGitHubJson(
    sentinelGitHubBranchRefUrl(target.owner, target.repo, target.branch),
    options,
    (body) => record(body).ref === `refs/heads/${target.branch}`,
  );
}

/** Read only the positive, exact branch protection signal. */
export function readSentinelGitHubBranchProtection(
  target: { owner: string; repo: string; branch: string },
  options: SentinelGitHubWorkflowOptions,
) {
  return readSentinelGitHubJson(
    sentinelGitHubBranchUrl(target.owner, target.repo, target.branch),
    options,
    (body) => {
      const { name, protected: enabled } = record(body);
      if (name !== target.branch || typeof enabled !== "boolean") {
        throw new Error("GitHub branch protection is unavailable.");
      }
      return enabled;
    },
  );
}

async function readSentinelGitHubJson<T>(
  url: string,
  options: SentinelGitHubWorkflowOptions,
  project: (body: unknown) => T,
): Promise<T> {
  if (
    typeof options.token !== "string" || !/^[!-~]{1,512}$/.test(options.token)
  ) {
    throw new Error("The GitHub Actions read credential is unavailable.");
  }
  const signal = AbortSignal.any(
    options.signal
      ? [options.signal, AbortSignal.timeout(deadlineMs)]
      : [AbortSignal.timeout(deadlineMs)],
  );
  const fetchPage = options.request ?? safeFetchWithRedirects;
  const failed = new Error(
    "GitHub evidence could not be read within policy.",
  );
  if (signal.aborted) throw failed;
  let onAbort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => reject(failed);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const read = async () => {
      const result = await fetchPage(
        url,
        {
          method: "GET",
          signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${options.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
        options.ssrfChecker,
        { maxRedirects: 0, isUrlAllowed: (candidate) => candidate === url },
      );
      if (!result.ok) throw failed;
      if (result.value.status !== 200 || signal.aborted) {
        await result.value.body?.cancel();
        throw failed;
      }
      return project(await readBody(result.value, signal));
    };
    return await Promise.race([read(), deadline]);
  } catch {
    throw failed;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
