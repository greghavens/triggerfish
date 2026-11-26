/** Bind the fixed visibility read to the operator's existing GitHub credential. */
import { createHash } from "node:crypto";
import type { TriggerFishConfig } from "../../../core/config_types.ts";
import type { SecretStore } from "../../../core/secrets/keychain/keychain.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import { resolveGitHubToken } from "../../../integrations/github/auth.ts";
import { createSentinelEgressChecker } from "../../../sentinel/egress.ts";
import { sentinelContainmentPath } from "../../../sentinel/paths.ts";
import { createSentinelRepositoryVisibilityReader } from "../../sentinel_repository_visibility.ts";

const identityKey = "sentinel-github-visibility-credential-identity";

export function resolveSentinelRepositoryCredential(store: () => SecretStore) {
  let pending: Promise<unknown> = Promise.resolve();
  return (expectedRef?: string) => {
    const checked = pending.then(async () => {
      const secretStore = store();
      const credential = await resolveGitHubToken({ secretStore });
      if (!credential.ok || !credential.value) return;
      const token = credential.value;
      const digest = createHash("sha256").update(token).digest("hex");
      const stored = await secretStore.getSecret(identityKey);
      if (stored.ok) {
        const saved = JSON.parse(stored.value);
        if (
          saved.digest === digest &&
          typeof saved.ref === "string" &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(saved.ref)
        ) {
          return !expectedRef || expectedRef === saved.ref
            ? { token, ref: saved.ref as string }
            : undefined;
        }
      }
      if (expectedRef) return;
      const ref = crypto.randomUUID();
      const written = await secretStore.setSecret(
        identityKey,
        JSON.stringify({ ref, digest }),
      );
      if (written.ok) return { token, ref };
    });
    pending = checked.catch(() => undefined);
    return checked;
  };
}

export function configuredSentinelRepositoryVisibilityReader(
  config: Pick<TriggerFishConfig, "github" | "sentinel">,
  baseDir: string,
  secretStore: () => SecretStore,
) {
  const scopes = config.sentinel?.github_repository_visibility_reads;
  const githubBase = config.github?.base_url;
  if (
    !scopes?.length ||
    (githubBase && githubBase !== "https://api.github.com" &&
      githubBase !== "https://api.github.com/")
  ) return;
  return createSentinelRepositoryVisibilityReader({
    scopes,
    classificationOverrides: config.github?.classification_overrides as
      | Readonly<Record<string, ClassificationLevel>>
      | undefined,
    resolveCredential: resolveSentinelRepositoryCredential(secretStore),
    ssrfChecker: createSentinelEgressChecker(sentinelContainmentPath(baseDir)),
  });
}
