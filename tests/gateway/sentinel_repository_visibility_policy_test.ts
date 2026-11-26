import { assert, assertEquals, assertRejects } from "@std/assert";
import { createMemorySecretStore } from "../../src/core/secrets/keychain/keychain.ts";
import { createSentinelRepositoryVisibilityReader } from "../../src/gateway/sentinel_repository_visibility.ts";
import { resolveSentinelRepositoryCredential } from "../../src/gateway/startup/factory/sentinel_repository_visibility_source.ts";
import {
  projectRepositoryVisibility,
  type SentinelRepositoryVisibilityReceipt,
} from "../../src/sentinel/github_repository_visibility.ts";
import { readSentinelGitHubRepositoryVisibility } from "../../src/sentinel/github_workflow_runs.ts";

Deno.test("Repository visibility transport accepts only the configured identity and fixed metadata path", async () => {
  const target = { owner: "fixture", repo: "approved", repositoryId: 42 };
  let id = 42;
  const read = () =>
    readSentinelGitHubRepositoryVisibility(target, {
      token: "fixture_credential",
      request: (url, options, _checker, redirectPolicy) => {
        assertEquals(url, "https://api.github.com/repos/fixture/approved");
        assertEquals(options?.method, "GET");
        assertEquals(redirectPolicy?.maxRedirects, 0);
        assertEquals(
          redirectPolicy?.isUrlAllowed?.("https://example.invalid"),
          false,
        );
        return Promise.resolve({
          ok: true,
          value: Response.json({
            id,
            full_name: "Fixture/Approved",
            visibility: "public",
            description: "Unrelated metadata",
          }),
        });
      },
    });
  assertEquals(await read(), "public");
  id = 43;
  await assertRejects(read);
});

Deno.test("Repository visibility retains only an opaque credential reference and respects classification on replay", async () => {
  const secrets = createMemorySecretStore();
  const token = "ghp_fixture_never_persist_in_the_case";
  assert((await secrets.setSecret("github-pat", token)).ok);
  let calls = 0;
  let saved: SentinelRepositoryVisibilityReceipt | undefined;
  const scopes = [{
    case: "main",
    asset: "app",
    owner: "fixture",
    repo: "approved",
    repository_id: 42,
  }];
  const readerOptions = {
    scopes,
    ssrfChecker: () =>
      Promise.resolve({ ok: true as const, value: "192.0.2.1" }),
    resolveCredential: resolveSentinelRepositoryCredential(() => secrets),
    readVisibility: () => {
      calls++;
      return Promise.resolve("private" as const);
    },
  };
  const request = {
    caseId: "main",
    assetId: "app",
    evidenceRevision: 1,
    signal: new AbortController().signal,
    isCurrent: () => true,
    authorize: () => Promise.resolve(true),
    loadSaved: () => saved,
    saveResult(value: SentinelRepositoryVisibilityReceipt) {
      return saved = value;
    },
  };
  assertEquals(
    await createSentinelRepositoryVisibilityReader(readerOptions)(request),
    undefined,
  );
  assertEquals(saved, undefined);
  const classificationOverrides = { "fixture/approved": "INTERNAL" } as const;
  const granted = createSentinelRepositoryVisibilityReader({
    ...readerOptions,
    classificationOverrides,
  });
  const result = await granted(request);
  assert(result);
  assertEquals(result.visibility, "private");
  assert(!JSON.stringify(result).includes(token));
  const projection = projectRepositoryVisibility(result, "assignment", "app");
  assert(!Object.hasOwn(projection, "credentialRef"));
  assertEquals(calls, 2);

  const restartOptions = {
    ...readerOptions,
    resolveCredential: resolveSentinelRepositoryCredential(() => secrets),
  };
  const replay = {
    ...request,
    resumeOnly: true,
    saveResult: () => {
      throw new Error("A saved read must never be replaced");
    },
  };
  assertEquals(
    await createSentinelRepositoryVisibilityReader(restartOptions)(replay),
    undefined,
  );
  const restarted = createSentinelRepositoryVisibilityReader({
    ...restartOptions,
    classificationOverrides,
  });
  assertEquals(await restarted(replay), result);
  assertEquals(
    await createSentinelRepositoryVisibilityReader({
      ...restartOptions,
      scopes: [{ ...scopes[0], repository_id: 43 }],
      classificationOverrides,
    })(replay),
    undefined,
  );
  assert((await secrets.setSecret("github-pat", "ghp_fixture_replaced")).ok);
  assertEquals(await restarted(replay), undefined);
  assert((await secrets.deleteSecret("github-pat")).ok);
  assertEquals(await restarted(replay), undefined);
  assertEquals(calls, 2);
});
