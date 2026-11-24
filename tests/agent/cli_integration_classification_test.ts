/**
 * Tests for CLI integration recognition in run_command classification.
 *
 * When `run_command` invokes a CLI tool belonging to a configured integration
 * (e.g. `gh` → GitHub), the command should be classified using the integration's
 * classification level — not by treating API route segments as filesystem paths.
 */
import { assertEquals } from "@std/assert";
import { assembleSecurityContext } from "../../src/agent/dispatch/security_context.ts";
import { createPathClassifier } from "../../src/core/security/path_classification.ts";
import type {
  FilesystemSecurityConfig,
  WorkspacePaths,
} from "../../src/core/security/path_classification.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import type { DomainClassifier } from "../../src/core/types/domain.ts";
import { join } from "@std/path";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(
  defaultClassification: ClassificationLevel = "CONFIDENTIAL",
): FilesystemSecurityConfig {
  return {
    paths: new Map(),
    defaultClassification,
  };
}

function makeWorkspacePaths(basePath: string): WorkspacePaths {
  return {
    basePath,
    publicPath: join(basePath, "public"),
    internalPath: join(basePath, "internal"),
    confidentialPath: join(basePath, "confidential"),
    restrictedPath: join(basePath, "restricted"),
  };
}

/** Simulated repo classification cache for tests. */
function makeRepoCache(
  entries: ReadonlyMap<string, ClassificationLevel>,
): (repoFullName: string) => ClassificationLevel | null {
  return (repoFullName: string) => entries.get(repoFullName) ?? null;
}

/** Domain classifier that classifies GitHub domains as PUBLIC by default. */
function makeGitHubDomainClassifier(
  level: ClassificationLevel = "PUBLIC",
): DomainClassifier {
  const GITHUB_DOMAINS = [
    "api.github.com",
    "github.com",
    "raw.githubusercontent.com",
  ];
  return {
    classify(url: string) {
      for (const domain of GITHUB_DOMAINS) {
        if (url.includes(domain)) {
          return { classification: level, source: `test:${domain}` };
        }
      }
      return { classification: "PUBLIC", source: "test:default" };
    },
  };
}

function classifyRunCommand(
  command: string,
  opts?: {
    readonly integrationClassifications?: ReadonlyMap<
      string,
      ClassificationLevel
    >;
    readonly taint?: ClassificationLevel;
    readonly repoClassifications?: ReadonlyMap<string, ClassificationLevel>;
    readonly domainClassifier?: DomainClassifier;
  },
): ClassificationLevel | null {
  const workspace = "/tmp/test-workspace";
  const workspacePaths = makeWorkspacePaths(workspace);
  const taint = opts?.taint ?? "PUBLIC";
  const taintDir = join(workspace, taint.toLowerCase());
  const classifier = createPathClassifier(makeConfig(), workspacePaths, {
    resolveCwd: () => taintDir,
  });

  const call = { name: "run_command", args: { command } };
  const { ctx } = assembleSecurityContext(call, {
    pathClassifier: classifier,
    getWorkspacePath: () => taintDir,
    integrationClassifications: opts?.integrationClassifications,
    domainClassifier: opts?.domainClassifier,
    classifyGitHubRepo: opts?.repoClassifications
      ? makeRepoCache(opts.repoClassifications)
      : undefined,
  });
  return ctx.resourceClassification;
}

const GITHUB_PUBLIC = new Map<string, ClassificationLevel>([
  ["github_", "PUBLIC"],
]);

const GITHUB_INTERNAL = new Map<string, ClassificationLevel>([
  ["github_", "INTERNAL"],
]);

const GITHUB_CONFIDENTIAL = new Map<string, ClassificationLevel>([
  ["github_", "CONFIDENTIAL"],
]);

/** Simulated known repos — PUBLIC repo in cache. */
const KNOWN_REPOS = new Map<string, ClassificationLevel>([
  ["greghavens/triggerfish", "PUBLIC"],
  ["owner/name", "PUBLIC"],
]);

/** Cache with a private repo. */
const KNOWN_REPOS_WITH_PRIVATE = new Map<string, ClassificationLevel>([
  ["greghavens/triggerfish", "PUBLIC"],
  ["owner/name", "PUBLIC"],
  ["acme/secret", "CONFIDENTIAL"],
]);

// ─── gh CLI recognition ─────────────────────────────────────────────────────

Deno.test("run_command: gh api repos/owner/name classifies at GitHub integration level", () => {
  const result = classifyRunCommand("gh api repos/owner/name/releases", {
    integrationClassifications: GITHUB_PUBLIC,
  });
  assertEquals(
    result,
    "PUBLIC",
    "gh command should use GitHub integration classification, not filesystem default",
  );
});

Deno.test("run_command: gh api with INTERNAL GitHub config + PUBLIC repo in cache classifies as PUBLIC", () => {
  const result = classifyRunCommand("gh api repos/owner/name/releases", {
    integrationClassifications: GITHUB_INTERNAL,
    repoClassifications: KNOWN_REPOS,
  });
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

Deno.test("run_command: gh release list classifies at GitHub integration level", () => {
  const result = classifyRunCommand("gh release list", {
    integrationClassifications: GITHUB_PUBLIC,
  });
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: gh pr view 123 classifies at GitHub integration level", () => {
  const result = classifyRunCommand("gh pr view 123", {
    integrationClassifications: GITHUB_PUBLIC,
  });
  assertEquals(result, "PUBLIC");
});

// ─── Pipes use integration classification ───────────────────────────────────

Deno.test("run_command: gh api ... | jq classifies at GitHub integration level", () => {
  const result = classifyRunCommand(
    "gh api repos/greghavens/triggerfish/releases --paginate | jq '.[].assets'",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(
    result,
    "PUBLIC",
    "gh piped to jq should use GitHub integration classification",
  );
});

Deno.test("run_command: gh ... | jq | sort | awk still PUBLIC", () => {
  const result = classifyRunCommand(
    "gh api repos/owner/name/releases | jq '.[]' | sort_by(.tag) | awk '{print}'",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: gh ... | tee /etc/shadow escalates to CONFIDENTIAL", () => {
  const result = classifyRunCommand(
    "gh api repos/owner/name | tee /etc/shadow",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Pipe to tee with dangerous path must still escalate",
  );
});

// ─── Compound commands still escalate ───────────────────────────────────────

Deno.test("run_command: gh ... && cat /etc/passwd escalates to CONFIDENTIAL", () => {
  const result = classifyRunCommand(
    "gh api repos/owner/name && cat /etc/passwd",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Compound command with dangerous path must escalate despite gh prefix",
  );
});

Deno.test("run_command: gh ... ; rm -rf / escalates to CONFIDENTIAL", () => {
  const result = classifyRunCommand(
    "gh api repos/owner/name; rm -rf /",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Semicolon-chained command with / must escalate",
  );
});

// ─── GitHub URL recognition (any executable) ─────────────────────────────────

Deno.test("run_command: curl api.github.com/repos classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    'curl -s "https://api.github.com/repos/greghavens/triggerfish/releases?per_page=100"',
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: curl api.github.com/repos piped to jq classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "curl -s \"https://api.github.com/repos/greghavens/triggerfish/releases?per_page=100\" | jq '.[].assets'",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: curl api.github.com/repos piped to jq and head classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "curl -s \"https://api.github.com/repos/owner/name/releases\" | jq '.' | head -200",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: wget api.github.com/repos classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "wget -qO- https://api.github.com/repos/owner/name/tags",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: curl api.github.com without /repos classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "curl https://api.github.com/users/greghavens",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: curl github.com URL classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "curl -L https://github.com/greghavens/triggerfish/archive/refs/tags/v0.7.5.tar.gz",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: curl raw.githubusercontent.com classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "curl https://raw.githubusercontent.com/greghavens/triggerfish/main/README.md",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

// ─── Env var prefixed commands ────────────────────────────────────────────────

Deno.test("run_command: GH_TOKEN='' gh api classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    'GH_TOKEN="" gh api /repos/greghavens/triggerfish/releases --paginate',
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: GITHUB_TOKEN=xxx curl api.github.com classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    'GITHUB_TOKEN=abc123 curl -s "https://api.github.com/repos/owner/name/releases"',
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: multiple env vars before gh classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    'GH_TOKEN="" NO_COLOR=1 gh api /repos/owner/name/releases',
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

// ─── Default GitHub classification (no integration configured) ────────────────

Deno.test("run_command: curl api.github.com without integrationClassifications defaults to PUBLIC", () => {
  const result = classifyRunCommand(
    'curl -s "https://api.github.com/repos/owner/name/releases"',
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: gh api without integrationClassifications defaults to PUBLIC", () => {
  const result = classifyRunCommand(
    "gh api /repos/owner/name/releases",
  );
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: GH_TOKEN gh api without integrationClassifications defaults to PUBLIC", () => {
  const result = classifyRunCommand(
    'GH_TOKEN="" gh api /repos/owner/name/releases',
  );
  assertEquals(result, "PUBLIC");
});

// ─── Compound commands with GitHub + dangerous paths still escalate ───────────

Deno.test("run_command: curl api.github.com && cat /etc/passwd escalates to CONFIDENTIAL", () => {
  const result = classifyRunCommand(
    "curl https://api.github.com/repos/owner/name && cat /etc/passwd",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "CONFIDENTIAL");
});

Deno.test("run_command: gh api | tee /etc/shadow escalates", () => {
  const result = classifyRunCommand(
    "gh api repos/owner/name | tee /etc/shadow",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "CONFIDENTIAL");
});

// ─── Non-GitHub URLs should NOT match ─────────────────────────────────────────

Deno.test("run_command: curl to non-github API uses filesystem classification", () => {
  const result = classifyRunCommand(
    "curl https://api.example.com/repos/owner/name",
    { integrationClassifications: GITHUB_PUBLIC },
  );
  // /repos/owner/name resolved against CWD → inside publicPath → PUBLIC
  // (not CONFIDENTIAL because it resolves inside workspace)
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: cat /etc/passwd still classifies as CONFIDENTIAL", () => {
  const result = classifyRunCommand("cat /etc/passwd", {
    integrationClassifications: GITHUB_PUBLIC,
  });
  assertEquals(result, "CONFIDENTIAL");
});

// ─── Non-gh commands with bare path tokens ────────────────────────────────────

Deno.test("run_command: non-gh command with slash token uses filesystem classification", () => {
  const result = classifyRunCommand("curl repos/owner/name", {
    integrationClassifications: GITHUB_PUBLIC,
  });
  // repos/owner/name resolved against CWD (/tmp/test-workspace/public/)
  // → /tmp/test-workspace/public/repos/owner/name → inside publicPath → PUBLIC
  assertEquals(result, "PUBLIC");
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

Deno.test("run_command: /usr/bin/gh recognized as gh", () => {
  const result = classifyRunCommand("/usr/bin/gh api repos/owner/name", {
    integrationClassifications: GITHUB_PUBLIC,
  });
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: command gh recognized as gh", () => {
  const result = classifyRunCommand("command gh api repos/owner/name", {
    integrationClassifications: GITHUB_PUBLIC,
  });
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: env gh recognized as gh", () => {
  const result = classifyRunCommand("env gh api repos/owner/name", {
    integrationClassifications: GITHUB_PUBLIC,
  });
  assertEquals(result, "PUBLIC");
});

Deno.test("run_command: gh with --jq flag and complex expression classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    `gh api /repos/greghavens/triggerfish/releases --paginate --jq '.[] | {tag_name, assets: [.assets[] | {name, download_count}]}'`,
    { integrationClassifications: GITHUB_PUBLIC },
  );
  assertEquals(result, "PUBLIC");
});

// ─── CRITICAL: integration classification must NOT leak into CLI commands ─────
// These tests reproduce the production bug where github.classification=CONFIDENTIAL
// in triggerfish.yaml caused ALL gh/curl/wget GitHub commands to be classified as
// CONFIDENTIAL instead of PUBLIC, triggering false bumpers blocks.

Deno.test("run_command: gh api with CONFIDENTIAL config + PUBLIC repo in cache classifies as PUBLIC", () => {
  const result = classifyRunCommand("gh api repos/owner/name/releases", {
    integrationClassifications: GITHUB_CONFIDENTIAL,
    repoClassifications: KNOWN_REPOS,
  });
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

Deno.test("run_command: curl api.github.com with CONFIDENTIAL config + PUBLIC repo in cache classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    'curl -s "https://api.github.com/repos/greghavens/triggerfish/releases?per_page=100"',
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
    },
  );
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

Deno.test("run_command: wget api.github.com with CONFIDENTIAL GitHub config + PUBLIC repo classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "wget -qO- https://api.github.com/repos/owner/name/tags",
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
    },
  );
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

Deno.test("run_command: GH_TOKEN='' gh api with CONFIDENTIAL config + PUBLIC repo classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    'GH_TOKEN="" gh api /repos/greghavens/triggerfish/releases --paginate',
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
    },
  );
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

Deno.test("run_command: curl api.github.com piped to jq with CONFIDENTIAL config + PUBLIC repo classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "curl -s \"https://api.github.com/repos/greghavens/triggerfish/releases?per_page=100\" | jq '.[].assets'",
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
    },
  );
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

Deno.test("run_command: gh api piped to jq with CONFIDENTIAL config + PUBLIC repo classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "gh api repos/greghavens/triggerfish/releases --paginate | jq '.[].assets'",
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
    },
  );
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

Deno.test("run_command: curl github.com archive URL with CONFIDENTIAL config + PUBLIC repo classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "curl -L https://github.com/greghavens/triggerfish/archive/refs/tags/v0.7.5.tar.gz",
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
    },
  );
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

Deno.test("run_command: curl raw.githubusercontent.com with CONFIDENTIAL config + PUBLIC repo classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    "curl https://raw.githubusercontent.com/greghavens/triggerfish/main/README.md",
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
    },
  );
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

Deno.test("run_command: curl with -H auth header to api.github.com with CONFIDENTIAL config + PUBLIC repo classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    'curl -s -H "Authorization: token ghp_xxxx" "https://api.github.com/repos/owner/name/releases"',
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
    },
  );
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

Deno.test("run_command: GITHUB_TOKEN=xxx curl api.github.com with CONFIDENTIAL config + PUBLIC repo classifies as PUBLIC", () => {
  const result = classifyRunCommand(
    'GITHUB_TOKEN=abc123 curl -s "https://api.github.com/repos/owner/name/releases"',
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
    },
  );
  assertEquals(
    result,
    "PUBLIC",
    "Repo classification must override integration default",
  );
});

// Compound commands with CONFIDENTIAL config + dangerous paths must STILL escalate
Deno.test("run_command: gh api + cat /etc/passwd with CONFIDENTIAL config escalates to CONFIDENTIAL", () => {
  const result = classifyRunCommand(
    "gh api repos/owner/name && cat /etc/passwd",
    { integrationClassifications: GITHUB_CONFIDENTIAL },
  );
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Dangerous paths must still escalate even with CONFIDENTIAL integration config",
  );
});

Deno.test("run_command: curl api.github.com | tee /etc/shadow with CONFIDENTIAL config escalates", () => {
  const result = classifyRunCommand(
    "curl https://api.github.com/repos/owner/name | tee /etc/shadow",
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
    },
  );
  assertEquals(result, "CONFIDENTIAL");
});

// ─── Private repo classification ─────────────────────────────────────────────
// When a PRIVATE repo is in the cache, its CONFIDENTIAL classification must be used.

Deno.test("run_command: gh api with private repo in cache classifies as CONFIDENTIAL", () => {
  const result = classifyRunCommand("gh api repos/acme/secret/releases", {
    integrationClassifications: GITHUB_PUBLIC,
    repoClassifications: KNOWN_REPOS_WITH_PRIVATE,
  });
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Private repo classification must be CONFIDENTIAL regardless of integration default",
  );
});

Deno.test("run_command: curl api.github.com with private repo in cache classifies as CONFIDENTIAL", () => {
  const result = classifyRunCommand(
    'curl -s "https://api.github.com/repos/acme/secret/releases"',
    {
      integrationClassifications: GITHUB_PUBLIC,
      repoClassifications: KNOWN_REPOS_WITH_PRIVATE,
    },
  );
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Private repo classification must be CONFIDENTIAL regardless of integration default",
  );
});

Deno.test("run_command: gh api with public repo in mixed cache classifies as PUBLIC", () => {
  const result = classifyRunCommand("gh api repos/owner/name/releases", {
    integrationClassifications: GITHUB_CONFIDENTIAL,
    repoClassifications: KNOWN_REPOS_WITH_PRIVATE,
  });
  assertEquals(
    result,
    "PUBLIC",
    "Public repo in cache must be PUBLIC even with CONFIDENTIAL integration default",
  );
});

// ─── Unknown repo (not in cache) falls back to integration default ───────────

Deno.test("run_command: gh api with unknown repo falls back to integration default", () => {
  const result = classifyRunCommand("gh api repos/unknown/repo/releases", {
    integrationClassifications: GITHUB_CONFIDENTIAL,
    repoClassifications: KNOWN_REPOS,
  });
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Unknown repo must fall back to integration default classification",
  );
});

Deno.test("run_command: curl api.github.com with unknown repo classifies via domain classifier", () => {
  const result = classifyRunCommand(
    'curl -s "https://api.github.com/repos/unknown/repo/releases"',
    {
      integrationClassifications: GITHUB_CONFIDENTIAL,
      repoClassifications: KNOWN_REPOS,
      domainClassifier: makeGitHubDomainClassifier("CONFIDENTIAL"),
    },
  );
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Unknown repo URL must be classified by domain classifier",
  );
});

Deno.test("run_command: gh api with unknown repo + PUBLIC integration defaults to PUBLIC", () => {
  const result = classifyRunCommand("gh api repos/unknown/repo/releases", {
    integrationClassifications: GITHUB_PUBLIC,
    repoClassifications: KNOWN_REPOS,
  });
  assertEquals(
    result,
    "PUBLIC",
    "Unknown repo with PUBLIC integration default should be PUBLIC",
  );
});

// ─── P1.3: fail-closed classification of obfuscated resource reads ────────────
// A PUBLIC session must not exfiltrate hidden filesystem resources by routing
// the path through a substitution, a variable, or an attached input redirect.
// Each of these must classify at least CONFIDENTIAL (the filesystem default)
// so taint escalates and write-down/read-ceiling hooks fire.

Deno.test("run_command: cat $(printf | base64 -d) classifies >= CONFIDENTIAL", () => {
  const result = classifyRunCommand(
    "cat $(printf 'L2V0Yy9zaGFkb3c=' | base64 -d)",
  );
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Substitution-hidden read target must fail closed to the filesystem default",
  );
});

Deno.test('run_command: f=/etc/shadow; cat "$f" classifies >= CONFIDENTIAL', () => {
  const result = classifyRunCommand('f=/etc/shadow; cat "$f"');
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Variable-hidden read target must fail closed to the filesystem default",
  );
});

Deno.test("run_command: xxd</etc/shadow classifies >= CONFIDENTIAL", () => {
  const result = classifyRunCommand("xxd</etc/shadow");
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Attached input redirect must be split and classified",
  );
});

Deno.test("run_command: cat $(echo /etc/shadow) classifies >= CONFIDENTIAL", () => {
  const result = classifyRunCommand("cat $(echo /etc/shadow)");
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Substitution span must be recursed and its path extracted",
  );
});

Deno.test("run_command: cat secret (opaque bareword operand) fails closed", () => {
  // `secret` has no path separators, so extraction sees no concrete path; cat
  // is a data-reading executable with a non-flag operand → fail closed.
  const result = classifyRunCommand("cat secret");
  assertEquals(
    result,
    "CONFIDENTIAL",
    "Data-reading executable with an opaque operand must fail closed",
  );
});

Deno.test("run_command: head -200 piped (flag-only, reads stdin) stays PUBLIC", () => {
  // No file operand — head reads stdin here, not a hidden file.
  const result = classifyRunCommand("echo hi | head -200");
  assertEquals(
    result,
    "PUBLIC",
    "Flag-only data-reading invocation reading stdin must not over-escalate",
  );
});

Deno.test("run_command: RESTRICTED exact-mapped path not downgraded by floor", () => {
  // SPINE.md is a hardcoded protected basename → RESTRICTED. The CONFIDENTIAL
  // floor must not downgrade it even though the command also has a substitution.
  const result = classifyRunCommand(
    "cat $(echo x) /tmp/test-workspace/SPINE.md",
  );
  assertEquals(
    result,
    "RESTRICTED",
    "The fail-closed floor must never downgrade a higher exact-mapped level",
  );
});

Deno.test("run_command: benign substitution-free public read stays PUBLIC", () => {
  const result = classifyRunCommand("cat ./public/notes.txt");
  assertEquals(
    result,
    "PUBLIC",
    "A concrete in-workspace path must keep its real (PUBLIC) classification",
  );
});
