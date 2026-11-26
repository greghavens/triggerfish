import { monitorProviderRegistry } from "../../../agent/providers/monitoring.ts";
import { createApprovalAdvisor } from "../../../core/policy/approval_advice.ts";
import { withReviewedToolRules } from "../../../core/policy/reviewed_tool_rules.ts";
import { enableLiveProviderRoutes } from "../../../agent/providers/live_routes.ts";
/**
 * Orchestrator factory infrastructure — shared setup utilities.
 *
 * Initializes provider registry, policy engine, web tools, and
 * skill discovery for the orchestrator factory.
 *
 * @module
 */

import { join } from "@std/path";
import { createToolApprovalService } from "../../../core/tool_approval_service.ts";
import type { TriggerFishConfig } from "../../../core/config.ts";
import { createProviderRegistry } from "../../../agent/llm.ts";
import {
  loadProvidersFromConfig,
  resolveVisionProvider,
} from "../../../agent/providers/config.ts";
import type { ModelsConfig } from "../../../agent/providers/config.ts";
import { mapToolPrefixClassifications } from "../../../agent/orchestrator/orchestrator_types.ts";
import { getCachedRepoClassification } from "../../../integrations/github/client_http.ts";
import { createPolicyEngine } from "../../../core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
  createToolApprovalRules,
} from "../../../core/policy/hooks/hooks.ts";
import { createKeychain } from "../../../core/secrets/keychain/keychain.ts";
import { buildSkillsSystemPrompt } from "../../../tools/skills/prompts.ts";
import { buildWebTools } from "./web_tools.ts";
import type { FactoryInfra } from "../tools/scheduler_tool_assembly.ts";
import { buildSchedulerSkillLoader } from "../tools/scheduler_tool_assembly.ts";
import { createLogger } from "../../../core/logger/logger.ts";

const log = createLogger("orchestrator-factory");

/** Symlink SPINE.md into a workspace directory. */
export async function symlinkSpineToWorkspace(
  spinePath: string,
  workspacePath: string,
): Promise<void> {
  try {
    const workspaceSpine = join(workspacePath, "SPINE.md");
    try {
      await Deno.remove(workspaceSpine);
    } catch (err: unknown) {
      log.debug("Workspace SPINE.md symlink not present for removal", {
        operation: "symlinkSpineToWorkspace",
        workspacePath,
        err,
      });
    }
    await Deno.symlink(spinePath, workspaceSpine);
  } catch (err: unknown) {
    log.debug("SPINE.md symlink to workspace skipped", {
      operation: "symlinkSpineToWorkspace",
      spinePath,
      workspacePath,
      err,
    });
  }
}

/** Lazily discover skills and build a system prompt from them. */
export async function discoverSkillsOnce(
  loader: ReturnType<typeof buildSchedulerSkillLoader>,
  state: { discovered: boolean; prompt: string },
): Promise<void> {
  if (state.discovered) return;
  state.discovered = true;
  try {
    const skills = await loader.discover();
    state.prompt = buildSkillsSystemPrompt(skills);
  } catch (err: unknown) {
    log.warn("Skill discovery failed during orchestrator creation", {
      operation: "discoverSkillsOnce",
      err,
    });
  }
}

/** Initialize shared factory infrastructure from config. */
export function initializeFactoryInfra(
  config: TriggerFishConfig,
  baseDir: string,
): FactoryInfra & {
  readonly hookRunner: ReturnType<typeof createHookRunner>;
  readonly spinePath: string;
} {
  const { registry: providers, retryPolicy } = monitorProviderRegistry(
    createProviderRegistry(),
    baseDir,
  );
  const models = config.models as ModelsConfig;
  loadProvidersFromConfig(models, providers, retryPolicy);
  const registry = enableLiveProviderRoutes(
    providers,
    baseDir,
    models.live_route_allowlists,
  );

  const engine = createPolicyEngine();
  for (
    const rule of [
      ...createDefaultRules(),
      ...createToolApprovalRules(config.tool_approval),
    ]
  ) {
    engine.addRule(rule);
  }

  const { searchProvider, webFetcher, domainClassifier } = buildWebTools(
    config,
    baseDir,
  );

  return {
    registry,
    hookRunner: {
      ...withReviewedToolRules(createHookRunner(engine), baseDir),
      reviewApprovalAdvice: createApprovalAdvisor(
        baseDir,
        registry,
        models.live_route_allowlists,
      ),
      toolApprovalInbox: createToolApprovalService(
        join(baseDir, "tool-approvals.db"),
      ),
    },
    spinePath: join(baseDir, "SPINE.md"),
    searchProvider,
    webFetcher,
    domainClassifier,
    keychain: createKeychain(),
    ...(() => {
      const { all, integrations } = mapToolPrefixClassifications(config);
      return {
        toolClassifications: all,
        integrationClassifications: integrations,
      };
    })(),
    classifyGitHubRepo: getCachedRepoClassification,
    visionProvider: resolveVisionProvider(config.models as ModelsConfig),
    skillLoader: buildSchedulerSkillLoader(
      baseDir,
      import.meta.dirname ?? ".",
    ),
  };
}
