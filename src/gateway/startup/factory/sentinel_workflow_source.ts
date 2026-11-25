/** Bind the Sentinel workflow reader to the configured case scope and credentials. */
import type { TriggerFishConfig } from "../../../core/config_types.ts";
import type { SecretStore } from "../../../core/secrets/keychain/keychain.ts";
import { resolveGitHubToken } from "../../../integrations/github/auth.ts";
import { createSentinelEgressChecker } from "../../../sentinel/egress.ts";
import { sentinelContainmentPath } from "../../../sentinel/paths.ts";
import { createSentinelLiveWorkflowReader } from "../../sentinel_live_workflow.ts";

export function configuredSentinelWorkflowReader(
  config: Pick<TriggerFishConfig, "github" | "sentinel">,
  baseDir: string,
  secretStore: () => SecretStore,
) {
  const scopes = config.sentinel?.github_workflow_reads;
  const githubBase = config.github?.base_url;
  if (
    !scopes?.length || (githubBase && githubBase !== "https://api.github.com" &&
      githubBase !== "https://api.github.com/")
  ) return;
  return createSentinelLiveWorkflowReader({
    scopes,
    resolveToken: async () => {
      const result = await resolveGitHubToken({ secretStore: secretStore() });
      return result.ok ? result.value : undefined;
    },
    ssrfChecker: createSentinelEgressChecker(sentinelContainmentPath(baseDir)),
  });
}
