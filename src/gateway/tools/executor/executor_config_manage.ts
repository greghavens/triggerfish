/**
 * Configuration management executor — dispatcher.
 *
 * Routes config_manage tool calls to individual action handlers
 * in executor_config_actions.ts.
 *
 * @module
 */

import {
  executeConfigAddChannel,
  executeConfigGet,
  executeConfigListChannels,
  executeConfigRemoveChannel,
  executeConfigSet,
  executeConfigSetModels,
  executeConfigSetSearch,
  executeConfigShow,
} from "./executor_config_actions.ts";
import {
  executeConfigSetDomainClassification,
  executeConfigSetFilesystemPath,
  executeConfigSetIntegration,
  executeConfigSetLogging,
  executeConfigSetToolFloor,
} from "./executor_config_security.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("config-manage");

/** Protect user-only execution grants and reject prototype traversal in tool inputs. */
function enforceConfigToolInput(input: Record<string, unknown>): string | null {
  for (
    const field of [
      "key",
      "channel_type",
      "integration",
      "tool_prefix",
      "domain_pattern",
      "path",
    ]
  ) {
    const value = input[field];
    if (typeof value !== "string") continue;
    if (
      value.split(".").some((part) =>
        ["__proto__", "prototype", "constructor"].includes(part)
      )
    ) {
      log.warn("Config tool input blocked: prototype traversal", {
        operation: "enforceConfigToolInput",
        field,
      });
      return "Error: Config paths cannot traverse object prototypes.";
    }
  }
  if (
    (input.action === "set" && typeof input.key === "string" &&
      input.key.split(".")[0] === "plugins") ||
    (input.action === "set_integration" && input.integration === "plugins")
  ) {
    log.warn(
      "Config tool write blocked: plugin execution grants require direct user configuration",
      { operation: "enforceConfigToolInput" },
    );
    return "Error: Plugin execution grants must be configured directly by the user in triggerfish.yaml.";
  }
  return null;
}

/** Context required by the config_manage executor. */
export interface ConfigManageContext {
  readonly configPath: string;
}

/**
 * Create a SubsystemExecutor for config_manage.
 *
 * Returns null for non-matching tool names so the dispatch chain
 * continues to the next executor.
 */
export function createConfigManageExecutor(
  ctx: ConfigManageContext,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (name !== "config_manage") return null;

    const action = input.action as string | undefined;
    if (!action) {
      return "Error: config_manage requires an 'action' parameter.";
    }
    const blocked = enforceConfigToolInput(input);
    if (blocked) return blocked;

    switch (action) {
      case "get": {
        const key = input.key as string | undefined;
        if (!key) {
          return "Error: config_manage(get) requires a 'key' parameter.";
        }
        return executeConfigGet(ctx.configPath, key);
      }
      case "set": {
        const key = input.key as string | undefined;
        const value = input.value as string | undefined;
        if (!key) {
          return "Error: config_manage(set) requires a 'key' parameter.";
        }
        if (value === undefined) {
          return "Error: config_manage(set) requires a 'value' parameter.";
        }
        return await executeConfigSet(ctx.configPath, key, value);
      }
      case "show":
        return executeConfigShow(ctx.configPath);
      case "add_channel": {
        const channelType = input.channel_type as string | undefined;
        const channelConfig = input.channel_config as string | undefined;
        if (!channelType) {
          return "Error: config_manage(add_channel) requires a 'channel_type' parameter.";
        }
        if (!channelConfig) {
          return "Error: config_manage(add_channel) requires a 'channel_config' parameter (JSON).";
        }
        return await executeConfigAddChannel(
          ctx.configPath,
          channelType,
          channelConfig,
        );
      }
      case "remove_channel": {
        const channelType = input.channel_type as string | undefined;
        if (!channelType) {
          return "Error: config_manage(remove_channel) requires a 'channel_type' parameter.";
        }
        return await executeConfigRemoveChannel(ctx.configPath, channelType);
      }
      case "list_channels":
        return executeConfigListChannels(ctx.configPath);
      case "set_search": {
        const provider = input.provider as string | undefined;
        if (!provider) {
          return "Error: config_manage(set_search) requires a 'provider' parameter.";
        }
        return await executeConfigSetSearch(
          ctx.configPath,
          provider,
          input.api_key_secret as string | undefined,
        );
      }
      case "set_models": {
        const provider = input.provider as string | undefined;
        const model = input.model as string | undefined;
        if (!provider || !model) {
          return "Error: config_manage(set_models) requires 'provider' and 'model' parameters.";
        }
        return await executeConfigSetModels(ctx.configPath, provider, model);
      }
      case "set_integration": {
        const integration = input.integration as string | undefined;
        if (!integration) {
          return "Error: config_manage(set_integration) requires an 'integration' parameter.";
        }
        return await executeConfigSetIntegration(
          ctx.configPath,
          integration,
          input,
        );
      }
      case "set_domain_classification": {
        const domainPattern = input.domain_pattern as string | undefined;
        const classification = input.classification as string | undefined;
        if (!domainPattern || !classification) {
          return "Error: config_manage(set_domain_classification) requires 'domain_pattern' and 'classification'.";
        }
        return await executeConfigSetDomainClassification(
          ctx.configPath,
          domainPattern,
          classification,
        );
      }
      case "set_tool_floor": {
        const toolPrefix = input.tool_prefix as string | undefined;
        const classification = input.classification as string | undefined;
        if (!toolPrefix || !classification) {
          return "Error: config_manage(set_tool_floor) requires 'tool_prefix' and 'classification'.";
        }
        return await executeConfigSetToolFloor(
          ctx.configPath,
          toolPrefix,
          classification,
        );
      }
      case "set_filesystem_path": {
        const path = input.path as string | undefined;
        const classification = input.classification as string | undefined;
        if (!path || !classification) {
          return "Error: config_manage(set_filesystem_path) requires 'path' and 'classification'.";
        }
        return await executeConfigSetFilesystemPath(
          ctx.configPath,
          path,
          classification,
        );
      }
      case "set_logging": {
        const level = input.level as string | undefined;
        if (!level) {
          return "Error: config_manage(set_logging) requires a 'level' parameter.";
        }
        return await executeConfigSetLogging(ctx.configPath, level);
      }
      default:
        return `Error: Unknown action "${action}". Valid actions: get, set, show, add_channel, remove_channel, list_channels, set_search, set_models, set_integration, set_domain_classification, set_tool_floor, set_filesystem_path, set_logging.`;
    }
  };
}
