/**
 * GitHub client — git clone and pull operations.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../../core/types/classification.ts";
import type { GitHubError } from "../types.ts";
import type { ApiRequestFn, ClassifyRepoFn } from "../client_http.ts";
import { fetchRepoClassification } from "../client_http.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("github-clone");

/** Build the authenticated clone URL with embedded token. */
function buildAuthenticatedCloneUrl(
  token: string,
  baseUrl: string,
  owner: string,
  repo: string,
): string {
  const host = baseUrl.includes("github.com")
    ? "github.com"
    : new URL(baseUrl).host;
  return `https://x-access-token:${token}@${host}/${owner}/${repo}.git`;
}

/** Build git clone command arguments. */
function buildCloneArgs(
  cloneUrl: string,
  destPath: string,
  opts?: { readonly branch?: string; readonly depth?: number },
): string[] {
  const args = ["clone"];
  if (opts?.depth) args.push("--depth", String(opts.depth));
  if (opts?.branch) args.push("--branch", opts.branch);
  args.push(cloneUrl, destPath);
  return args;
}

/** Strip tokens from git stderr output. */
function sanitizeGitStderr(stderr: string): string {
  return stderr.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}

/** Run git clone and return stderr on failure. */
async function runGitClone(args: readonly string[]): Promise<string | null> {
  const cmd = new Deno.Command("git", {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (output.success) return null;
  return sanitizeGitStderr(new TextDecoder().decode(output.stderr));
}

/** Clone a GitHub repo to a local path using git CLI. */
export async function cloneRepoToPath(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  token: string,
  baseUrl: string,
  owner: string,
  repo: string,
  destPath: string,
  opts?: { readonly branch?: string; readonly depth?: number },
): Promise<
  Result<
    { readonly clonedTo: string; readonly classification: ClassificationLevel },
    GitHubError
  >
> {
  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );

  const cloneUrl = buildAuthenticatedCloneUrl(token, baseUrl, owner, repo);
  const args = buildCloneArgs(cloneUrl, destPath, opts);
  const repoSlug = `${owner}/${repo}`;

  log.info("Cloning repository", {
    operation: "cloneRepoToPath",
    repo: repoSlug,
    destPath,
    branch: opts?.branch ?? "default",
  });

  const err = await runGitClone(args);
  if (!err) {
    return { ok: true, value: { clonedTo: destPath, classification } };
  }

  return retryCloneWithoutBranch(
    cloneUrl,
    destPath,
    opts,
    err,
    repoSlug,
    classification,
  );
}

/** Retry clone without --branch when the specified branch doesn't exist. */
async function retryCloneWithoutBranch(
  cloneUrl: string,
  destPath: string,
  opts: { readonly branch?: string; readonly depth?: number } | undefined,
  err: string,
  repoSlug: string,
  classification: ClassificationLevel,
): Promise<
  Result<
    { readonly clonedTo: string; readonly classification: ClassificationLevel },
    GitHubError
  >
> {
  if (opts?.branch && err.includes("not found in upstream")) {
    log.info("Branch not found, retrying with default branch", {
      operation: "cloneRepoToPath",
      repo: repoSlug,
      failedBranch: opts.branch,
    });
    const retryArgs = buildCloneArgs(cloneUrl, destPath, { depth: opts.depth });
    const retryErr = await runGitClone(retryArgs);
    if (!retryErr) {
      return { ok: true, value: { clonedTo: destPath, classification } };
    }
    log.warn("Clone failed on retry", {
      operation: "cloneRepoToPath",
      repo: repoSlug,
      err: retryErr,
    });
    return {
      ok: false,
      error: { status: 500, message: `Clone failed: ${retryErr.trim()}` },
    };
  }

  log.warn("Clone failed", {
    operation: "cloneRepoToPath",
    repo: repoSlug,
    err,
  });
  return {
    ok: false,
    error: { status: 500, message: `Clone failed: ${err.trim()}` },
  };
}

/** Build git pull command arguments. */
function buildPullArgs(
  localPath: string,
  authUrl: string,
  opts?: { readonly branch?: string },
): string[] {
  const args = ["-C", localPath, "pull", authUrl];
  if (opts?.branch) args.push(opts.branch);
  return args;
}

/** Run git pull and return stderr on failure. */
async function runGitPull(args: readonly string[]): Promise<string | null> {
  const cmd = new Deno.Command("git", {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (output.success) return null;
  return sanitizeGitStderr(new TextDecoder().decode(output.stderr));
}

/** Pull latest changes in an already-cloned repo using authenticated remote. */
export async function pullRepoAtPath(
  apiRequest: ApiRequestFn,
  classifyRepo: ClassifyRepoFn,
  token: string,
  baseUrl: string,
  owner: string,
  repo: string,
  localPath: string,
  opts?: { readonly branch?: string },
): Promise<
  Result<
    { readonly pulled: boolean; readonly classification: ClassificationLevel },
    GitHubError
  >
> {
  const classification = await fetchRepoClassification(
    apiRequest,
    classifyRepo,
    owner,
    repo,
  );

  const repoSlug = `${owner}/${repo}`;
  const authUrl = buildAuthenticatedCloneUrl(token, baseUrl, owner, repo);
  const args = buildPullArgs(localPath, authUrl, opts);

  log.info("Pulling repository", {
    operation: "pullRepoAtPath",
    repo: repoSlug,
    localPath,
    branch: opts?.branch ?? "current",
  });

  const err = await runGitPull(args);
  if (!err) {
    return { ok: true, value: { pulled: true, classification } };
  }

  log.warn("Pull failed", {
    operation: "pullRepoAtPath",
    repo: repoSlug,
    err,
  });
  return {
    ok: false,
    error: { status: 500, message: `Pull failed: ${err.trim()}` },
  };
}
