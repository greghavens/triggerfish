/**
 * GitHub tools tests.
 *
 * Tests all 4 consolidated tool definitions, parameter validation,
 * response formatting, null fallthrough, and graceful error handling.
 */
import { assertEquals } from "@std/assert";
import {
  createGitHubToolExecutor,
  getGitHubToolDefinitions,
  GITHUB_TOOLS_SYSTEM_PROMPT,
} from "../../../src/integrations/github/tools.ts";
import type { GitHubToolContext } from "../../../src/integrations/github/tools.ts";
import { mapRawPullDetailToGitHubPullDetail } from "../../../src/integrations/github/pulls/client_pulls_query.ts";
import type { GitHubClient } from "../../../src/integrations/github/client.ts";
import type { SessionId } from "../../../src/core/types/session.ts";
import type { Result } from "../../../src/core/types/classification.ts";

// ─── Tool Definitions ────────────────────────────────────────────────────────

Deno.test("getGitHubToolDefinitions: returns 4 consolidated tool definitions", () => {
  const defs = getGitHubToolDefinitions();
  assertEquals(defs.length, 4);
});

Deno.test("getGitHubToolDefinitions: all tools have github_ prefix", () => {
  const defs = getGitHubToolDefinitions();
  for (const def of defs) {
    assertEquals(
      def.name.startsWith("github_"),
      true,
      `${def.name} missing github_ prefix`,
    );
  }
});

Deno.test("getGitHubToolDefinitions: all tools have descriptions", () => {
  const defs = getGitHubToolDefinitions();
  for (const def of defs) {
    assertEquals(typeof def.description, "string");
    assertEquals(
      def.description.length > 0,
      true,
      `${def.name} has empty description`,
    );
  }
});

Deno.test("getGitHubToolDefinitions: all tools use domain-noun naming pattern", () => {
  const defs = getGitHubToolDefinitions();
  const domains = ["repos", "pulls", "issues", "actions"];
  for (const def of defs) {
    const afterPrefix = def.name.replace("github_", "");
    assertEquals(
      domains.includes(afterPrefix),
      true,
      `${def.name} does not match a known domain (got "${afterPrefix}")`,
    );
  }
});

Deno.test("getGitHubToolDefinitions: expected tool names present", () => {
  const defs = getGitHubToolDefinitions();
  const names = new Set(defs.map((d) => d.name));
  const expected = [
    "github_repos",
    "github_pulls",
    "github_issues",
    "github_actions",
  ];
  for (const name of expected) {
    assertEquals(names.has(name), true, `Missing tool: ${name}`);
  }
});

Deno.test("getGitHubToolDefinitions: all tools have required action parameter", () => {
  const defs = getGitHubToolDefinitions();
  for (const def of defs) {
    const actionParam = def.parameters.action;
    assertEquals(
      actionParam !== undefined,
      true,
      `${def.name} missing action parameter`,
    );
    assertEquals(actionParam.required, true, `${def.name} action not required`);
    assertEquals(actionParam.type, "string", `${def.name} action not string`);
  }
});

// ─── System Prompt ───────────────────────────────────────────────────────────

Deno.test("GITHUB_TOOLS_SYSTEM_PROMPT: is a non-empty string", () => {
  assertEquals(typeof GITHUB_TOOLS_SYSTEM_PROMPT, "string");
  assertEquals(GITHUB_TOOLS_SYSTEM_PROMPT.length > 0, true);
});

Deno.test("GITHUB_TOOLS_SYSTEM_PROMPT: mentions classification mapping", () => {
  assertEquals(GITHUB_TOOLS_SYSTEM_PROMPT.includes("PUBLIC"), true);
  assertEquals(GITHUB_TOOLS_SYSTEM_PROMPT.includes("CONFIDENTIAL"), true);
});

// ─── Fallthrough ─────────────────────────────────────────────────────────────

Deno.test("createGitHubToolExecutor: returns null for non-github tools", async () => {
  const executor = createGitHubToolExecutor(undefined);
  const result = await executor("web_search", { query: "test" });
  assertEquals(result, null);
});

Deno.test("createGitHubToolExecutor: returns null for unknown github_ tool", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_unknown_tool", { action: "list" });
  assertEquals(result, null);
});

// ─── Not Configured ──────────────────────────────────────────────────────────

Deno.test("createGitHubToolExecutor: returns error when not configured", async () => {
  const executor = createGitHubToolExecutor(undefined);
  const result = await executor("github_repos", { action: "list" });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("not configured"), true);
});

// ─── Action Validation ──────────────────────────────────────────────────────

Deno.test("executor: returns error when action is missing", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", {});
  assertEquals(result!.includes("action"), true);
});

Deno.test("executor: returns error for unknown action", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", { action: "nonexistent" });
  assertEquals(result!.includes("unknown action"), true);
  assertEquals(result!.includes("nonexistent"), true);
});

// ─── Parameter Validation ────────────────────────────────────────────────────

Deno.test("executor: github_repos read_file requires repo param", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", {
    action: "read_file",
    path: "README.md",
  });
  assertEquals(result!.includes("Error"), true);
});

Deno.test("executor: github_repos read_file requires path param", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", {
    action: "read_file",
    repo: "o/r",
  });
  assertEquals(result!.includes("Error"), true);
});

Deno.test("executor: rejects invalid repo format (no slash)", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", {
    action: "read_file",
    repo: "invalid",
    path: "f",
  });
  assertEquals(result!.includes("owner/name"), true);
});

Deno.test("executor: github_pulls create requires title", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_pulls", {
    action: "create",
    repo: "o/r",
    head: "feature",
    base: "main",
  });
  assertEquals(result!.includes("Error"), true);
  assertEquals(result!.includes("title"), true);
});

Deno.test("executor: github_actions search_code requires query", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_actions", {
    action: "search_code",
  });
  assertEquals(result!.includes("Error"), true);
  assertEquals(result!.includes("query"), true);
});

Deno.test("executor: github_issues add_comment requires number", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_issues", {
    action: "add_comment",
    repo: "o/r",
    body: "hi",
  });
  assertEquals(result!.includes("Error"), true);
  assertEquals(result!.includes("number"), true);
});

Deno.test("executor: github_issues get requires number", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_issues", {
    action: "get",
    repo: "o/r",
  });
  assertEquals(result!.includes("Error"), true);
  assertEquals(result!.includes("number"), true);
});

Deno.test("executor: github_pulls get requires pr_number", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_pulls", {
    action: "get",
    repo: "o/r",
  });
  assertEquals(result!.includes("Error"), true);
  assertEquals(result!.includes("pr_number"), true);
});

Deno.test("executor: pull status identity is emitted only for the exact base repository", async () => {
  let fullName = "o/r";
  const executor = createGitHubToolExecutor(createMockContext({
    getPull: () =>
      Promise.resolve({
        ok: true,
        value: mapRawPullDetailToGitHubPullDetail({
          number: 5,
          title: "Fixture pull",
          state: "open",
          head: { ref: "feature" },
          base: { ref: "main", repo: { id: 25, full_name: fullName } },
          html_url: "https://github.com/o/r/pull/5",
          created_at: "2025-01-01T00:00:00.000Z",
          additions: 1,
          deletions: 0,
          changed_files: 1,
        }, "INTERNAL"),
      }),
  }));
  const args = { action: "get", repo: "o/r", pr_number: 5 };
  assertEquals(
    JSON.parse((await executor("github_pulls", args))!).repositoryId,
    25,
  );
  fullName = "o/replacement";
  assertEquals(
    JSON.parse((await executor("github_pulls", args))!).repositoryId,
    undefined,
  );
});

Deno.test("executor: github_repos create_branch requires branch and sha", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result1 = await executor("github_repos", {
    action: "create_branch",
    repo: "o/r",
    sha: "abc",
  });
  assertEquals(result1!.includes("Error"), true);
  assertEquals(result1!.includes("branch"), true);
  const result2 = await executor("github_repos", {
    action: "create_branch",
    repo: "o/r",
    branch: "feat",
  });
  assertEquals(result2!.includes("Error"), true);
  assertEquals(result2!.includes("sha"), true);
});

Deno.test("executor: github_repos delete_branch requires branch", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", {
    action: "delete_branch",
    repo: "o/r",
  });
  assertEquals(result!.includes("Error"), true);
  assertEquals(result!.includes("branch"), true);
});

Deno.test("executor: github_actions cancel_run requires run_id", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_actions", {
    action: "cancel_run",
    repo: "o/r",
  });
  assertEquals(result!.includes("Error"), true);
  assertEquals(result!.includes("run_id"), true);
});

// ─── Response Formatting ─────────────────────────────────────────────────────

Deno.test("executor: github_repos list returns JSON with _classification", async () => {
  const ctx = createMockContext({
    listRepos: () =>
      Promise.resolve({
        ok: true as const,
        value: [{
          id: 1,
          fullName: "o/r",
          description: "test",
          visibility: "public" as const,
          defaultBranch: "main",
          htmlUrl: "https://github.com/o/r",
          classification: "PUBLIC" as const,
        }],
      }),
  });
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", { action: "list" });

  const parsed = JSON.parse(result!);
  assertEquals(parsed.repos.length, 1);
  assertEquals(parsed.repos[0]._classification, "PUBLIC");
});

Deno.test("executor: github_actions search_code returns JSON with results", async () => {
  const ctx = createMockContext({
    searchCode: () =>
      Promise.resolve({
        ok: true as const,
        value: [{
          path: "src/main.ts",
          repo: "o/r",
          htmlUrl: "https://github.com/o/r/blob/main/src/main.ts",
          textMatches: ["import { foo }"],
          classification: "CONFIDENTIAL" as const,
        }],
      }),
  });
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_actions", {
    action: "search_code",
    query: "import foo",
  });

  const parsed = JSON.parse(result!);
  assertEquals(parsed.results.length, 1);
  assertEquals(parsed.results[0]._classification, "CONFIDENTIAL");
});

Deno.test("executor: github_issues create returns created issue JSON", async () => {
  const ctx = createMockContext({
    createIssue: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          number: 5,
          title: "New issue",
          state: "open",
          author: "bot",
          body: "body text",
          htmlUrl: "https://github.com/o/r/issues/5",
          createdAt: "2024-01-01T00:00:00Z",
          labels: ["bug"],
          classification: "PUBLIC" as const,
        },
      }),
  });
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_issues", {
    action: "create",
    repo: "o/r",
    title: "New issue",
  });

  const parsed = JSON.parse(result!);
  assertEquals(parsed.number, 5);
  assertEquals(parsed._classification, "PUBLIC");
});

Deno.test("executor: github_repos get returns repo detail JSON", async () => {
  const ctx = createMockContext({
    getRepo: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          id: 1,
          fullName: "o/r",
          description: "test",
          visibility: "public" as const,
          defaultBranch: "main",
          htmlUrl: "https://github.com/o/r",
          cloneUrl: "https://github.com/o/r.git",
          sshUrl: "git@github.com:o/r.git",
          language: "TypeScript",
          stargazersCount: 42,
          forksCount: 5,
          topics: ["deno"],
          classification: "PUBLIC" as const,
        },
      }),
  });
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", {
    action: "get",
    repo: "o/r",
  });

  const parsed = JSON.parse(result!);
  assertEquals(parsed.language, "TypeScript");
  assertEquals(parsed.stars, 42);
  assertEquals(parsed._classification, "PUBLIC");
});

Deno.test("executor: github_issues list_comments returns comments JSON", async () => {
  const ctx = createMockContext({
    listComments: () =>
      Promise.resolve({
        ok: true as const,
        value: [{
          id: 1,
          author: "alice",
          body: "LGTM",
          createdAt: "2024-01-01T00:00:00Z",
          htmlUrl: "https://github.com/o/r/issues/1#issuecomment-1",
          classification: "PUBLIC" as const,
        }],
      }),
  });
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_issues", {
    action: "list_comments",
    repo: "o/r",
    number: 1,
  });

  const parsed = JSON.parse(result!);
  assertEquals(parsed.comments.length, 1);
  assertEquals(parsed.comments[0].author, "alice");
});

// ─── Error Formatting ────────────────────────────────────────────────────────

Deno.test("executor: formats API error correctly", async () => {
  const ctx = createMockContext({
    listRepos: () =>
      Promise.resolve({
        ok: false as const,
        error: { status: 401, message: "Bad credentials" },
      }),
  });
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", { action: "list" });
  assertEquals(result!.includes("401"), true);
  assertEquals(result!.includes("Bad credentials"), true);
});

Deno.test("executor: formats rate limit error", async () => {
  const ctx = createMockContext({
    listRepos: () =>
      Promise.resolve({
        ok: false as const,
        error: {
          status: 403,
          message: "rate limit",
          rateLimitRemaining: 0,
          rateLimitReset: 1700000000,
        },
      }),
  });
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", { action: "list" });
  assertEquals(result!.includes("rate limit exceeded"), true);
});

// ─── Clone/Pull Workspace Jail (INTEGRATIONS-CLI-1) ─────────────────────────

Deno.test("executor: clone rejects path traversal outside the workspace", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "gh_jail_" });
  try {
    const ctx = createMockContext(undefined, workspace);
    const executor = createGitHubToolExecutor(ctx);
    const result = await executor("github_repos", {
      action: "clone",
      repo: "o/r",
      path: "../../../etc/cron.d",
    });
    assertEquals(result!.includes("Error"), true);
    assertEquals(result!.includes("outside the agent workspace"), true);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("executor: pull rejects path traversal outside the workspace", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "gh_jail_" });
  try {
    const ctx = createMockContext(undefined, workspace);
    const executor = createGitHubToolExecutor(ctx);
    const result = await executor("github_repos", {
      action: "pull",
      repo: "o/r",
      path: "../escape",
    });
    assertEquals(result!.includes("Error"), true);
    assertEquals(result!.includes("outside the agent workspace"), true);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("executor: clone fails closed when no workspace is configured", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", {
    action: "clone",
    repo: "o/r",
    path: "/tmp/anywhere",
  });
  assertEquals(result!.includes("Error"), true);
  assertEquals(result!.includes("requires a configured agent workspace"), true);
});

Deno.test("executor: pull fails closed when no workspace is configured", async () => {
  const ctx = createMockContext();
  const executor = createGitHubToolExecutor(ctx);
  const result = await executor("github_repos", {
    action: "pull",
    repo: "o/r",
    path: "repo",
  });
  assertEquals(result!.includes("Error"), true);
  assertEquals(result!.includes("requires a configured agent workspace"), true);
});

Deno.test("executor: clone resolves relative path inside the workspace", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "gh_jail_" });
  try {
    let capturedDest: string | undefined;
    const ctx = createMockContext({
      cloneRepo: (...args: unknown[]) => {
        capturedDest = args[2] as string;
        return Promise.resolve({
          ok: true as const,
          value: { clonedTo: args[2], classification: "PUBLIC" as const },
        });
      },
    }, workspace);
    const executor = createGitHubToolExecutor(ctx);
    const result = await executor("github_repos", {
      action: "clone",
      repo: "o/r",
      path: "projects/r",
    });
    assertEquals(result!.includes("Error"), false);
    assertEquals(capturedDest, `${workspace}/projects/r`);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("executor: clone default destination is jailed (repo name '..')", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "gh_jail_" });
  try {
    const ctx = createMockContext(undefined, workspace);
    const executor = createGitHubToolExecutor(ctx);
    const result = await executor("github_repos", {
      action: "clone",
      repo: "owner/..",
    });
    assertEquals(result!.includes("Error"), true);
    assertEquals(result!.includes("outside the agent workspace"), true);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

// ─── Branch Validation on Clone/Pull (INTEGRATIONS-CLI-2) ───────────────────

Deno.test("executor: clone rejects option-shaped branch name", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "gh_jail_" });
  try {
    const ctx = createMockContext(undefined, workspace);
    const executor = createGitHubToolExecutor(ctx);
    const result = await executor("github_repos", {
      action: "clone",
      repo: "o/r",
      path: "r",
      branch: "--upload-pack=touch /tmp/pwned",
    });
    assertEquals(result!.includes("not a valid branch name"), true);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("executor: pull rejects option-shaped branch name", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "gh_jail_" });
  try {
    const ctx = createMockContext(undefined, workspace);
    const executor = createGitHubToolExecutor(ctx);
    const result = await executor("github_repos", {
      action: "pull",
      repo: "o/r",
      path: "r",
      branch: "--config=core.hooksPath=/tmp",
    });
    assertEquals(result!.includes("not a valid branch name"), true);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("executor: clone accepts a valid branch name", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "gh_jail_" });
  try {
    let capturedBranch: string | undefined;
    const ctx = createMockContext({
      cloneRepo: (...args: unknown[]) => {
        capturedBranch = (args[3] as { branch?: string } | undefined)?.branch;
        return Promise.resolve({
          ok: true as const,
          value: { clonedTo: args[2], classification: "PUBLIC" as const },
        });
      },
    }, workspace);
    const executor = createGitHubToolExecutor(ctx);
    const result = await executor("github_repos", {
      action: "clone",
      repo: "o/r",
      path: "r",
      branch: "feature/my-branch_1",
    });
    assertEquals(result!.includes("Error"), false);
    assertEquals(capturedBranch, "feature/my-branch_1");
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock GitHubToolContext with optional client method overrides. */
function createMockContext(
  overrides?: Partial<
    Record<
      keyof GitHubClient,
      (...args: unknown[]) => Promise<Result<unknown, unknown>>
    >
  >,
  workspacePath?: string,
): GitHubToolContext {
  const defaultMethod = () =>
    Promise.resolve({
      ok: true as const,
      value: [],
    });

  const client: GitHubClient = {
    listRepos: overrides?.listRepos as GitHubClient["listRepos"] ??
      defaultMethod as unknown as GitHubClient["listRepos"],
    getRepo: overrides?.getRepo as GitHubClient["getRepo"] ??
      defaultMethod as unknown as GitHubClient["getRepo"],
    readFile: overrides?.readFile as GitHubClient["readFile"] ??
      defaultMethod as unknown as GitHubClient["readFile"],
    listCommits: overrides?.listCommits as GitHubClient["listCommits"] ??
      defaultMethod as unknown as GitHubClient["listCommits"],
    listReleases: overrides?.listReleases as GitHubClient["listReleases"] ??
      defaultMethod as unknown as GitHubClient["listReleases"],
    listBranches: overrides?.listBranches as GitHubClient["listBranches"] ??
      defaultMethod as unknown as GitHubClient["listBranches"],
    createBranch: overrides?.createBranch as GitHubClient["createBranch"] ??
      defaultMethod as unknown as GitHubClient["createBranch"],
    deleteBranch: overrides?.deleteBranch as GitHubClient["deleteBranch"] ??
      defaultMethod as unknown as GitHubClient["deleteBranch"],
    listPulls: overrides?.listPulls as GitHubClient["listPulls"] ??
      defaultMethod as unknown as GitHubClient["listPulls"],
    getPull: overrides?.getPull as GitHubClient["getPull"] ??
      defaultMethod as unknown as GitHubClient["getPull"],
    createPull: overrides?.createPull as GitHubClient["createPull"] ??
      defaultMethod as unknown as GitHubClient["createPull"],
    updatePull: overrides?.updatePull as GitHubClient["updatePull"] ??
      defaultMethod as unknown as GitHubClient["updatePull"],
    listPullFiles: overrides?.listPullFiles as GitHubClient["listPullFiles"] ??
      defaultMethod as unknown as GitHubClient["listPullFiles"],
    submitReview: overrides?.submitReview as GitHubClient["submitReview"] ??
      defaultMethod as unknown as GitHubClient["submitReview"],
    mergePull: overrides?.mergePull as GitHubClient["mergePull"] ??
      defaultMethod as unknown as GitHubClient["mergePull"],
    listIssues: overrides?.listIssues as GitHubClient["listIssues"] ??
      defaultMethod as unknown as GitHubClient["listIssues"],
    getIssue: overrides?.getIssue as GitHubClient["getIssue"] ??
      defaultMethod as unknown as GitHubClient["getIssue"],
    createIssue: overrides?.createIssue as GitHubClient["createIssue"] ??
      defaultMethod as unknown as GitHubClient["createIssue"],
    updateIssue: overrides?.updateIssue as GitHubClient["updateIssue"] ??
      defaultMethod as unknown as GitHubClient["updateIssue"],
    listComments: overrides?.listComments as GitHubClient["listComments"] ??
      defaultMethod as unknown as GitHubClient["listComments"],
    createComment: overrides?.createComment as GitHubClient["createComment"] ??
      defaultMethod as unknown as GitHubClient["createComment"],
    listWorkflowRuns:
      overrides?.listWorkflowRuns as GitHubClient["listWorkflowRuns"] ??
        defaultMethod as unknown as GitHubClient["listWorkflowRuns"],
    cancelRun: overrides?.cancelRun as GitHubClient["cancelRun"] ??
      defaultMethod as unknown as GitHubClient["cancelRun"],
    triggerWorkflow:
      overrides?.triggerWorkflow as GitHubClient["triggerWorkflow"] ??
        defaultMethod as unknown as GitHubClient["triggerWorkflow"],
    searchCode: overrides?.searchCode as GitHubClient["searchCode"] ??
      defaultMethod as unknown as GitHubClient["searchCode"],
    searchIssues: overrides?.searchIssues as GitHubClient["searchIssues"] ??
      defaultMethod as unknown as GitHubClient["searchIssues"],
    cloneRepo: overrides?.cloneRepo as GitHubClient["cloneRepo"] ??
      defaultMethod as unknown as GitHubClient["cloneRepo"],
    pullRepo: overrides?.pullRepo as GitHubClient["pullRepo"] ??
      defaultMethod as unknown as GitHubClient["pullRepo"],
  };

  return {
    client,
    sessionTaint: "PUBLIC",
    sourceSessionId: "test-session" as SessionId,
    workspacePath,
  };
}
