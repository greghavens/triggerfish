import { assert, assertEquals } from "@std/assert";
import type { ExecutionTraceApprovedPayload } from "../../src/core/execution_traces.ts";
import { createMemorySecretStore } from "../../src/core/secrets/keychain/keychain.ts";
import { buildExecutionTracePayloadAuthorizer } from "../../src/gateway/startup/factory/agent_recovery.ts";

Deno.test("Historical GitHub Actions access checks only the current exact repository and workflow metadata", async () => {
  const repository = "fixture-owner/fixture-repo";
  const config = {
    agent_recovery: {
      github_repositories: [repository],
      github_repository_status: false,
      github_pull_status: false,
      github_release_status: false,
      github_branch_protection: false,
    },
  };
  const keychain = createMemorySecretStore();
  let visibility = "public";
  let reportedRepository = repository;
  let repositoryId = 86;
  let workflowAuthorized = true;
  const paths: string[] = [];
  const usedCredential: boolean[] = [];
  const fetchMetadata: typeof fetch = (url, options) => {
    const target = new URL(url.toString());
    assertEquals(target.origin, "https://api.github.com");
    assertEquals(options?.method ?? "GET", "GET");
    paths.push(target.pathname + target.search);
    usedCredential.push(
      new Headers(options?.headers).get("authorization") ===
        "Bearer fixture-rotated",
    );
    if (target.pathname.endsWith("/fixture-repo")) {
      return Promise.resolve(
        Response.json({
          id: repositoryId,
          full_name: reportedRepository,
          visibility,
        }),
      );
    }
    return Promise.resolve(
      new Response("", { status: workflowAuthorized ? 200 : 403 }),
    );
  };
  const authorize = buildExecutionTracePayloadAuthorizer(
    config,
    keychain,
    fetchMetadata,
  );
  assert(authorize);
  const payload: ExecutionTraceApprovedPayload = {
    kind: "github_actions_status",
    repo: repository,
    repositoryId,
    workflow: "120",
    perPage: 2,
    runs: [{ id: 42, status: "completed", conclusion: "success" }],
  };
  assertEquals(await authorize(payload, "INTERNAL"), false);
  assertEquals(paths, []);
  assert((await keychain.setSecret("github-pat", "fixture-rotated")).ok);
  assertEquals(
    await authorize({ ...payload, repo: "other/repo" }, "INTERNAL"),
    false,
  );
  assertEquals(
    await authorize({ ...payload, workflow: "../other" }, "INTERNAL"),
    false,
  );
  assertEquals(paths, []);
  assertEquals(await authorize(payload, "INTERNAL"), true);
  assertEquals(paths.splice(0), [
    "/repos/fixture-owner/fixture-repo",
    "/repos/fixture-owner/fixture-repo/actions/workflows/120",
  ]);
  assertEquals(usedCredential, [true, true]);
  reportedRepository = "other/repo";
  assertEquals(await authorize(payload, "INTERNAL"), false);
  assertEquals(paths.splice(0), ["/repos/fixture-owner/fixture-repo"]);
  reportedRepository = repository;
  repositoryId = 87;
  assertEquals(await authorize(payload, "INTERNAL"), false);
  assertEquals(paths.splice(0), ["/repos/fixture-owner/fixture-repo"]);
  repositoryId = payload.repositoryId;
  visibility = "private";
  assertEquals(await authorize(payload, "INTERNAL"), false);
  assertEquals(paths.splice(0), ["/repos/fixture-owner/fixture-repo"]);
  visibility = "public";
  workflowAuthorized = false;
  assertEquals(await authorize(payload, "INTERNAL"), false);
  assertEquals(paths.splice(0), [
    "/repos/fixture-owner/fixture-repo",
    "/repos/fixture-owner/fixture-repo/actions/workflows/120",
  ]);
  const metadata = {
    kind: "github_repository_status" as const,
    repo: repository,
    repositoryId,
    visibility: "private" as const,
  };
  assertEquals(await authorize(metadata, "INTERNAL"), false);
  assertEquals(paths, []);
  config.agent_recovery.github_repository_status = true;
  assertEquals(await authorize(metadata, "INTERNAL"), true);
  assertEquals(paths.splice(0), ["/repos/fixture-owner/fixture-repo"]);
  assertEquals(
    await authorize({ ...metadata, repositoryId: 999 }, "INTERNAL"),
    false,
  );
  assertEquals(paths.splice(0), ["/repos/fixture-owner/fixture-repo"]);
  const pull = {
    kind: "github_pull_status" as const,
    repo: repository,
    repositoryId,
    number: 12,
    state: "open" as const,
    mergeable: null,
  };
  assertEquals(await authorize(pull, "INTERNAL"), false);
  assertEquals(paths, []);
  config.agent_recovery.github_pull_status = true;
  assertEquals(await authorize(pull, "INTERNAL"), false);
  const pullProbe = [
    "/repos/fixture-owner/fixture-repo",
    "/repos/fixture-owner/fixture-repo/pulls?per_page=1",
  ];
  assertEquals(paths.splice(0), pullProbe);
  workflowAuthorized = true;
  assertEquals(await authorize(pull, "INTERNAL"), true);
  assertEquals(paths.splice(0), pullProbe);
  assertEquals(
    await authorize({ ...pull, repositoryId: 999 }, "INTERNAL"),
    false,
  );
  assertEquals(paths.splice(0), ["/repos/fixture-owner/fixture-repo"]);
  const release = {
    kind: "github_release_status" as const,
    repo: repository,
    repositoryId,
    releases: [{
      id: 21,
      prerelease: false,
      published_at: "2025-01-01T00:00:00Z",
    }],
  };
  assertEquals(await authorize(release, "INTERNAL"), false);
  assertEquals(paths, []);
  config.agent_recovery.github_release_status = true;
  assertEquals(await authorize(release, "INTERNAL"), true);
  assertEquals(paths.splice(0), [
    "/repos/fixture-owner/fixture-repo",
    "/repositories/86/branches?per_page=1",
  ]);
  const branch = {
    kind: "github_branch_protection" as const,
    repo: repository,
    repositoryId,
    protectedCount: 1,
    unprotectedCount: 2,
  };
  assertEquals(await authorize(branch, "INTERNAL"), false);
  assertEquals(paths, []);
  config.agent_recovery.github_branch_protection = true;
  const branchProbe = [
    "/repos/fixture-owner/fixture-repo",
    "/repositories/86/commits?per_page=1",
  ];
  assertEquals(await authorize(branch, "INTERNAL"), true);
  assertEquals(paths.splice(0), branchProbe);
  workflowAuthorized = false;
  assertEquals(await authorize(branch, "INTERNAL"), false);
  assertEquals(paths.splice(0), branchProbe);
  config.agent_recovery.github_repositories = ["replacement/repo"];
  assertEquals(await authorize(payload, "INTERNAL"), false);
  assertEquals(paths, []);
});
