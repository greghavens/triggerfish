import { assert, assertEquals, assertRejects } from "@std/assert";
import { safeFetchWithRedirects } from "../../src/core/security/safe_fetch.ts";
import {
  isSentinelGitHubWorkflowTarget,
  readSentinelGitHubWorkflowRuns,
  sentinelGitHubWorkflowRunsUrl,
} from "../../src/sentinel/github_workflow_runs.ts";

const target = { owner: "Fixture-org", repo: "repository", workflowId: 42 };
const token = "fixture-token";
const url =
  "https://api.github.com/repos/Fixture-org/repository/actions/workflows/42/runs?per_page=10&page=1";
const run = {
  id: 31,
  workflow_id: 42,
  repository: { full_name: "fixture-org/Repository" },
  status: "completed",
  conclusion: "success",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:05Z",
  run_started_at: "2026-01-01T00:00:01Z",
  name: "private-title",
  actor: { login: "private-actor" },
  html_url: "https://example.test/private",
};

Deno.test("GitHub workflow reader uses one fixed pinned GET and minimizes run details", async () => {
  assertEquals(sentinelGitHubWorkflowRunsUrl(target), url);
  let calls = 0;
  const result = await readSentinelGitHubWorkflowRuns(target, {
    token,
    request: (destination, options, _, policy) => {
      calls++;
      assertEquals(destination, url);
      assertEquals(options?.method, "GET");
      assertEquals(options?.body, undefined);
      assertEquals(
        new Headers(options?.headers).get("authorization"),
        `Bearer ${token}`,
      );
      assertEquals(policy?.maxRedirects, 0);
      assertEquals(policy?.isUrlAllowed?.(url), true);
      assertEquals(
        policy?.isUrlAllowed?.(url.replace("api.github.com", "example.test")),
        false,
      );
      assertEquals(
        policy?.isUrlAllowed?.(url.replace("page=1", "page=2")),
        false,
      );
      return Promise.resolve({
        ok: true,
        value: Response.json({ workflow_runs: [run] }, {
          headers: { Link: '<https://example.test/>; rel="next"' },
        }),
      });
    },
  });
  assertEquals(calls, 1);
  assertEquals(result, [{
    id: 31,
    status: "completed",
    conclusion: "success",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
  }]);
});

Deno.test("GitHub workflow reader validates exact returned workflow and repository and bounded pages", async () => {
  for (
    const workflow_runs of [
      [{ ...run, workflow_id: 43 }],
      [{ ...run, repository: { full_name: "another/repository" } }],
      [{ ...run, id: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...run, created_at: "2026-02-31T00:00:00Z" }],
      [{ ...run, status: "private-invalid-status" }],
      [run, run],
      Array.from({ length: 11 }, (_, i) => ({ ...run, id: i + 1 })),
    ]
  ) {
    await assertRejects(
      () =>
        readSentinelGitHubWorkflowRuns(target, {
          token,
          request: () =>
            Promise.resolve({
              ok: true,
              value: Response.json({ workflow_runs }),
            }),
        }),
      Error,
      "could not be read within policy",
    );
  }
  for (
    const invalid of [
      { ...target, owner: ".." },
      { ...target, repo: ".." },
      { ...target, repo: "escape/path" },
      { ...target, repo: "escape%2Fpath" },
      { ...target, workflowId: 0 },
      { ...target, workflowId: "workflow.yaml" },
    ]
  ) assertEquals(isSentinelGitHubWorkflowTarget(invalid), false);
});

Deno.test("GitHub workflow reader suppresses non-success and oversized response details", async () => {
  for (
    const makeResponse of [
      () => new Response("private-error-body", { status: 403 }),
      () => new Response("{}", { headers: { "Content-Length": "524289" } }),
      () => new Response("a".repeat(524289)),
    ]
  ) {
    const error = await assertRejects(
      () =>
        readSentinelGitHubWorkflowRuns(target, {
          token,
          request: () => Promise.resolve({ ok: true, value: makeResponse() }),
        }),
      Error,
      "could not be read within policy",
    );
    assert(!error.message.includes(token));
    assert(!error.message.includes("private-error-body"));
  }
});

Deno.test("GitHub workflow reader does not follow even a same-origin redirect", async () => {
  const originalFetch = globalThis.fetch;
  const fetched: unknown[] = [];
  globalThis.fetch = (input) => {
    fetched.push(input);
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { Location: "https://api.github.com/another-resource" },
      }),
    );
  };
  try {
    await assertRejects(
      () =>
        readSentinelGitHubWorkflowRuns(target, {
          token,
          ssrfChecker: (hostname) => {
            assertEquals(hostname, "api.github.com");
            return Promise.resolve({ ok: true, value: "140.82.112.5" });
          },
          request: safeFetchWithRedirects,
        }),
      Error,
      "could not be read within policy",
    );
    assertEquals(fetched, [url]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("GitHub workflow reader returns on cancellation without disclosing the reason", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const response = readSentinelGitHubWorkflowRuns(target, {
    token,
    signal: controller.signal,
    request: (_destination, options) => {
      requestSignal = options?.signal ?? undefined;
      return new Promise(() => {});
    },
  });
  controller.abort("private-cancellation");
  const error = await assertRejects(
    () => response,
    Error,
    "could not be read within policy",
  );
  assert(!error.message.includes("private-cancellation"));
  assertEquals(requestSignal?.aborted, true);
});
