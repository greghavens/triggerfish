/**
 * GitHub client tests.
 *
 * Tests API request construction, auth headers, response parsing,
 * error handling, base64 decode, rate limit errors, and classification mapping.
 */
import { assertEquals } from "@std/assert";
import {
  createGitHubClient,
  visibilityToClassification,
} from "../../../src/integrations/github/client.ts";
import type { GitHubClient } from "../../../src/integrations/github/client.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock fetch that returns a JSON response. */
function mockFetch(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): typeof fetch {
  return (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json",
          ...(headers ?? {}),
        },
      }),
    );
  };
}

/** Create a mock fetch that captures the request for inspection. */
function capturingFetch(
  body: unknown,
  status = 200,
): { fetchFn: typeof fetch; captured: { url: string; init?: RequestInit }[] } {
  const captured: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchFn, captured };
}

/** Create a client with a mock fetch. */
function createMockClient(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): GitHubClient {
  return createGitHubClient({
    token: "ghp_test123",
    fetchFn: mockFetch(body, status, headers),
  });
}

// ─── Auth Header ─────────────────────────────────────────────────────────────

Deno.test("GitHubClient: sends Bearer auth header", async () => {
  const { fetchFn, captured } = capturingFetch([]);
  const client = createGitHubClient({ token: "ghp_mytoken", fetchFn });

  await client.listRepos();
  assertEquals(captured.length >= 1, true);
  const authHeader = (captured[0].init?.headers as Record<string, string>)
    ?.Authorization;
  assertEquals(authHeader, "Bearer ghp_mytoken");
});

Deno.test("GitHubClient: sends GitHub API version header", async () => {
  const { fetchFn, captured } = capturingFetch([]);
  const client = createGitHubClient({ token: "ghp_test", fetchFn });

  await client.listRepos();
  const apiVersion = (captured[0].init?.headers as Record<string, string>)
    ?.["X-GitHub-Api-Version"];
  assertEquals(apiVersion, "2022-11-28");
});

// ─── URL Construction ────────────────────────────────────────────────────────

Deno.test("GitHubClient: uses custom baseUrl", async () => {
  const { fetchFn, captured } = capturingFetch([]);
  const client = createGitHubClient({
    token: "ghp_test",
    baseUrl: "https://github.example.com/api/v3",
    fetchFn,
  });

  await client.listRepos();
  assertEquals(
    captured[0].url.startsWith("https://github.example.com/api/v3/"),
    true,
  );
});

Deno.test("GitHubClient: listRepos constructs correct URL", async () => {
  const { fetchFn, captured } = capturingFetch([]);
  const client = createGitHubClient({ token: "ghp_test", fetchFn });

  await client.listRepos({ page: 2, perPage: 10 });
  const url = captured[0].url;
  assertEquals(url.includes("page=2"), true);
  assertEquals(url.includes("per_page=10"), true);
  assertEquals(url.includes("sort=updated"), true);
});

// ─── Response Parsing ────────────────────────────────────────────────────────

Deno.test("GitHubClient: listRepos parses repos correctly", async () => {
  const rawRepos = [
    {
      id: 1,
      full_name: "octocat/Hello-World",
      description: "A test repo",
      visibility: "public",
      private: false,
      default_branch: "main",
      html_url: "https://github.com/octocat/Hello-World",
    },
    {
      id: 2,
      full_name: "octocat/Private-Repo",
      description: null,
      visibility: "private",
      private: true,
      default_branch: "master",
      html_url: "https://github.com/octocat/Private-Repo",
    },
  ];

  const client = createMockClient(rawRepos);
  const result = await client.listRepos();

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 2);
    assertEquals(result.value[0].fullName, "octocat/Hello-World");
    assertEquals(result.value[0].visibility, "public");
    assertEquals(result.value[0].classification, "PUBLIC");
    assertEquals(result.value[1].fullName, "octocat/Private-Repo");
    assertEquals(result.value[1].visibility, "private");
    assertEquals(result.value[1].classification, "CONFIDENTIAL");
  }
});

Deno.test("GitHubClient: readFile decodes base64 content", async () => {
  const encoded = btoa("console.log('hello');");
  const fetchFn = (
    url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const urlStr = String(url);
    if (urlStr.includes("/contents/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            path: "src/main.ts",
            content: encoded,
            sha: "abc123",
            size: 21,
            html_url: "https://github.com/o/r/blob/main/src/main.ts",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    // Repo metadata request
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 1,
          full_name: "o/r",
          visibility: "public",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/o/r",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  const client = createGitHubClient({ token: "ghp_test", fetchFn });
  const result = await client.readFile("o", "r", "src/main.ts");

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.content, "console.log('hello');");
    assertEquals(result.value.path, "src/main.ts");
    assertEquals(result.value.classification, "PUBLIC");
  }
});

// ─── Error Handling ──────────────────────────────────────────────────────────

Deno.test("GitHubClient: returns error for 404", async () => {
  const client = createMockClient({ message: "Not Found" }, 404);
  const result = await client.listRepos();

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.status, 404);
    assertEquals(result.error.message, "Not Found");
  }
});

Deno.test("GitHubClient: returns error for rate limit", async () => {
  const client = createGitHubClient({
    token: "ghp_test",
    fetchFn: mockFetch(
      { message: "API rate limit exceeded" },
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" },
    ),
  });

  const result = await client.listRepos();
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.status, 403);
    assertEquals(result.error.rateLimitRemaining, 0);
    assertEquals(result.error.rateLimitReset, 1700000000);
  }
});

Deno.test("GitHubClient: returns error for network failure", async () => {
  const client = createGitHubClient({
    token: "ghp_test",
    fetchFn: () => Promise.reject(new Error("Network unreachable")),
  });

  const result = await client.listRepos();
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.status, 0);
    assertEquals(result.error.message.includes("Network unreachable"), true);
  }
});

Deno.test("GitHubClient: readFile rejects files over 1 MB", async () => {
  const fetchFn = (url: string | URL | Request): Promise<Response> => {
    const urlStr = String(url);
    if (urlStr.includes("/contents/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            path: "big-file.bin",
            content: "",
            sha: "abc",
            size: 2_000_000,
            html_url: "https://github.com/o/r/blob/main/big-file.bin",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 1,
          full_name: "o/r",
          visibility: "public",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/o/r",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  const client = createGitHubClient({ token: "ghp_test", fetchFn });
  const result = await client.readFile("o", "r", "big-file.bin");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.status, 413);
    assertEquals(result.error.message.includes("too large"), true);
  }
});

// ─── Classification Mapping ──────────────────────────────────────────────────

Deno.test("visibilityToClassification: public → PUBLIC", () => {
  assertEquals(visibilityToClassification("public", "o/r"), "PUBLIC");
});

Deno.test("visibilityToClassification: private → CONFIDENTIAL", () => {
  assertEquals(visibilityToClassification("private", "o/r"), "CONFIDENTIAL");
});

Deno.test("visibilityToClassification: internal → INTERNAL", () => {
  assertEquals(visibilityToClassification("internal", "o/r"), "INTERNAL");
});

Deno.test("visibilityToClassification: per-repo override", () => {
  const config = { overrides: { "acme/secret": "RESTRICTED" as const } };
  assertEquals(
    visibilityToClassification("public", "acme/secret", config),
    "RESTRICTED",
  );
});

Deno.test("visibilityToClassification: override does not affect other repos", () => {
  const config = { overrides: { "acme/secret": "RESTRICTED" as const } };
  assertEquals(
    visibilityToClassification("public", "acme/other", config),
    "PUBLIC",
  );
});

// ─── Pull Requests ───────────────────────────────────────────────────────────

Deno.test("GitHubClient: listPulls parses PRs", async () => {
  const rawPulls = [
    {
      number: 42,
      title: "Fix bug",
      state: "open",
      user: { login: "alice" },
      head: { ref: "fix-bug" },
      base: { ref: "main" },
      html_url: "https://github.com/o/r/pull/42",
      created_at: "2024-01-01T00:00:00Z",
    },
  ];

  // Two fetches: one for pulls, one for repo metadata
  const fetchFn = (url: string | URL | Request): Promise<Response> => {
    const urlStr = String(url);
    if (urlStr.includes("/pulls")) {
      return Promise.resolve(
        new Response(JSON.stringify(rawPulls), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 1,
          full_name: "o/r",
          visibility: "public",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/o/r",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  const client = createGitHubClient({ token: "ghp_test", fetchFn });
  const result = await client.listPulls("o", "r");

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0].number, 42);
    assertEquals(result.value[0].author, "alice");
    assertEquals(result.value[0].classification, "PUBLIC");
  }
});

// ─── Search ──────────────────────────────────────────────────────────────────

Deno.test("GitHubClient: searchCode parses results", async () => {
  const rawSearch = {
    items: [
      {
        path: "src/main.ts",
        html_url: "https://github.com/o/r/blob/main/src/main.ts",
        repository: {
          full_name: "o/r",
          visibility: "private",
          private: true,
        },
        text_matches: [{ fragment: "import { foo }" }],
      },
    ],
  };

  const client = createMockClient(rawSearch);
  const result = await client.searchCode("import foo");

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0].repo, "o/r");
    assertEquals(result.value[0].classification, "CONFIDENTIAL");
  }
});

// ─── Workflow Runs ───────────────────────────────────────────────────────────

Deno.test("GitHubClient: listWorkflowRuns parses runs", async () => {
  const rawRuns = {
    workflow_runs: [
      {
        id: 100,
        name: "CI",
        status: "completed",
        conclusion: "success",
        head_branch: "main",
        html_url: "https://github.com/o/r/actions/runs/100",
        created_at: "2024-01-01T00:00:00Z",
      },
    ],
  };

  const fetchFn = (url: string | URL | Request): Promise<Response> => {
    const urlStr = String(url);
    if (urlStr.includes("/actions/")) {
      return Promise.resolve(
        new Response(JSON.stringify(rawRuns), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 1,
          full_name: "o/r",
          visibility: "public",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/o/r",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  const client = createGitHubClient({ token: "ghp_test", fetchFn });
  const result = await client.listWorkflowRuns("o", "r");

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0].name, "CI");
    assertEquals(result.value[0].conclusion, "success");
  }
});

// ─── List Releases ──────────────────────────────────────────────────────────

Deno.test("GitHubClient: listReleases returns mapped releases with assets", async () => {
  const rawRelease = {
    id: 1,
    tag_name: "v1.0.0",
    name: "Version 1.0",
    draft: false,
    prerelease: false,
    created_at: "2026-01-01T00:00:00Z",
    published_at: "2026-01-01T12:00:00Z",
    html_url: "https://github.com/o/r/releases/tag/v1.0.0",
    assets: [
      {
        id: 10,
        name: "app-linux-x64.tar.gz",
        content_type: "application/gzip",
        size: 50_000_000,
        download_count: 1234,
        browser_download_url:
          "https://github.com/o/r/releases/download/v1.0.0/app-linux-x64.tar.gz",
      },
      {
        id: 11,
        name: "app-darwin-arm64.tar.gz",
        content_type: "application/gzip",
        size: 48_000_000,
        download_count: 567,
        browser_download_url:
          "https://github.com/o/r/releases/download/v1.0.0/app-darwin-arm64.tar.gz",
      },
    ],
  };

  // Mock fetch returns releases on first call, repo detail on second (for classification)
  let callCount = 0;
  const fetchFn = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    callCount++;
    const body = callCount === 1 ? [rawRelease] : {
      id: 1,
      full_name: "o/r",
      description: null,
      visibility: "public",
      private: false,
      default_branch: "main",
      html_url: "https://github.com/o/r",
      clone_url: "https://github.com/o/r.git",
      ssh_url: "git@github.com:o/r.git",
      stargazers_count: 0,
      forks_count: 0,
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  const client = createGitHubClient({ token: "ghp_test", fetchFn });
  const result = await client.listReleases("o", "r");

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0].tagName, "v1.0.0");
    assertEquals(result.value[0].name, "Version 1.0");
    assertEquals(result.value[0].classification, "PUBLIC");
    assertEquals(result.value[0].assets.length, 2);
    assertEquals(result.value[0].assets[0].name, "app-linux-x64.tar.gz");
    assertEquals(result.value[0].assets[0].downloadCount, 1234);
    assertEquals(result.value[0].assets[1].name, "app-darwin-arm64.tar.gz");
    assertEquals(result.value[0].assets[1].downloadCount, 567);
  }
});

// ─── SSRF-checked default fetch ──────────────────────────────────────────────

Deno.test("client: default fetch blocks a base URL that fails the outbound URL check", async () => {
  const client = createGitHubClient({
    token: "ghp_test",
    baseUrl: "ftp://ghe.internal/api/v3",
  });

  const result = await client.getRepo("octocat", "hello");

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("Outbound fetch blocked"), true);
  }
});
