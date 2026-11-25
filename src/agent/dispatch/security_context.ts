import { parseCustomToolApply } from "../../core/custom_tool_intent.ts";
/**
 * Security context assembly and policy error rendering.
 *
 * Builds enriched hook input for PRE_TOOL_CALL with resource classification,
 * identity context, and tool floor data. Renders user-facing error messages
 * for policy violations.
 *
 * @module
 */

import { parseMcpLifecycleIntent } from "../../core/mcp_lifecycle_intent.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import {
  FILESYSTEM_READ_TOOLS,
  FILESYSTEM_WRITE_TOOLS,
  URL_READ_TOOLS,
  URL_WRITE_TOOLS,
} from "../../core/security/constants.ts";
import { chatGoalMutation } from "../../core/chat_goal_intent.ts";
import type { PathClassifier } from "../../core/security/path_classification.ts";
import type { ToolFloorRegistry } from "../../core/security/tool_floors.ts";
import type { DomainClassifier } from "../../core/types/domain.ts";
import type { ParsedToolCall } from "../orchestrator/orchestrator_types.ts";
import { classifyShellCommandResource } from "./command_classification.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Subset of OrchestratorConfig consumed by assembleSecurityContext.
 *
 * Every field is optional — callers provide only the classifiers and
 * identity getters relevant to their context. Full OrchestratorConfig
 * satisfies this structurally, so existing call sites are unaffected.
 */
export interface SecurityContextConfig {
  readonly pathClassifier?: PathClassifier;
  readonly domainClassifier?: DomainClassifier;
  readonly toolFloorRegistry?: ToolFloorRegistry;
  readonly isOwnerSession?: () => boolean;
  readonly isTriggerSession?: () => boolean;
  readonly getNonOwnerCeiling?: () => ClassificationLevel | null;
  readonly getWorkspacePath?: () => string | null;
  /** Integration prefix → classification map for CLI tool recognition. */
  readonly integrationClassifications?: ReadonlyMap<
    string,
    ClassificationLevel
  >;
  /** Synchronous repo classification lookup (cache populated by github_* tools). */
  readonly classifyGitHubRepo?: (
    repoFullName: string,
  ) => ClassificationLevel | null;
}

/** Computed security context returned alongside the hook input. */
export interface SecurityContext {
  readonly toolName: string;
  readonly toolFloor: ClassificationLevel | null;
  readonly resourceClassification: ClassificationLevel | null;
  readonly operationType: "read" | "write" | null;
  readonly isOwner: boolean;
  /** True when the active session is a trigger session. */
  readonly isTrigger: boolean;
  readonly nonOwnerCeiling: ClassificationLevel | null;
  readonly resourceParam: string | null;
  /** True for URL-based tools that make outbound network requests. */
  readonly isOutboundRequest: boolean;
}

/** Resource classification result shape. */
type ResourceClassResult = {
  classification: ClassificationLevel | null;
  operation: "read" | "write" | null;
  param: string | null;
};

/** No-classification sentinel result. */
const NO_RESOURCE_CLASSIFICATION: ResourceClassResult = {
  classification: null,
  operation: null,
  param: null,
};

// ─── Resource classification ─────────────────────────────────────────────────

/** Extract the path parameter from tool call arguments. */
function extractPathParam(call: ParsedToolCall): string | null {
  return (call.args.path ?? call.args.directory ?? call.args.search_path) as
    | string
    | null ?? null;
}

/** Classify a resource using a classifier and known tool sets. */
function classifyResourceByToolSets(
  toolName: string,
  param: string,
  classifier: { classify(p: string): { classification: ClassificationLevel } },
  readSet: ReadonlySet<string>,
  writeSet: ReadonlySet<string>,
): ResourceClassResult {
  if (readSet.has(toolName)) {
    return {
      classification: classifier.classify(param).classification,
      operation: "read",
      param,
    };
  }
  if (writeSet.has(toolName)) {
    return {
      classification: classifier.classify(param).classification,
      operation: "write",
      param,
    };
  }
  return NO_RESOURCE_CLASSIFICATION;
}

/** Classify a filesystem path tool call. */
function classifyFilesystemResource(
  call: ParsedToolCall,
  config: SecurityContextConfig,
): ResourceClassResult {
  const pathParam = extractPathParam(call);
  if (!config.pathClassifier || !pathParam) return NO_RESOURCE_CLASSIFICATION;
  return classifyResourceByToolSets(
    call.name,
    pathParam,
    config.pathClassifier,
    FILESYSTEM_READ_TOOLS,
    FILESYSTEM_WRITE_TOOLS,
  );
}

/** Classify a URL-based tool call. */
function classifyUrlResource(
  call: ParsedToolCall,
  config: SecurityContextConfig,
): ResourceClassResult & { isOutbound: boolean } {
  const urlParam = (call.args.url) as string | undefined ?? null;
  if (!config.domainClassifier || !urlParam) {
    return { ...NO_RESOURCE_CLASSIFICATION, isOutbound: false };
  }
  const result = classifyResourceByToolSets(
    call.name,
    urlParam,
    config.domainClassifier,
    URL_READ_TOOLS,
    URL_WRITE_TOOLS,
  );
  return { ...result, isOutbound: result.classification !== null };
}

// ─── Identity context ────────────────────────────────────────────────────────

/** Build identity context fields for the hook input. */
function assembleIdentityContext(config: SecurityContextConfig): {
  isOwner: boolean;
  isTrigger: boolean;
  nonOwnerCeiling: ClassificationLevel | null;
} {
  return {
    isOwner: config.isOwnerSession?.() ?? false,
    isTrigger: config.isTriggerSession?.() ?? false,
    nonOwnerCeiling: config.getNonOwnerCeiling?.() ?? null,
  };
}

/** Extended resource classification result including outbound request flag. */
type ExtendedResourceClassResult = ResourceClassResult & {
  isOutbound: boolean;
};

/** Resolve resource classification from filesystem, shell command, or URL tools. */
function resolveResourceClassification(
  call: ParsedToolCall,
  config: SecurityContextConfig,
): ExtendedResourceClassResult {
  const fsResult = classifyFilesystemResource(call, config);
  if (fsResult.classification !== null) {
    return { ...fsResult, isOutbound: false };
  }
  const shellResult = classifyShellCommandResource(call, config);
  if (shellResult.classification !== null) {
    return { ...shellResult, isOutbound: false };
  }
  return classifyUrlResource(call, config);
}

/** Populate hook input with resource and identity fields. */
function populateHookInputFields(
  hookInput: Record<string, unknown>,
  resource: ExtendedResourceClassResult,
  identity: {
    isOwner: boolean;
    isTrigger: boolean;
    nonOwnerCeiling: ClassificationLevel | null;
  },
): void {
  if (resource.classification !== null) {
    hookInput.resource_classification = resource.classification;
    hookInput.operation_type = resource.operation;
  }
  if (resource.isOutbound) {
    hookInput.is_outbound_request = true;
  }
  hookInput.is_owner = identity.isOwner;
  hookInput.is_trigger = identity.isTrigger;
  if (identity.nonOwnerCeiling !== null) {
    hookInput.non_owner_ceiling = identity.nonOwnerCeiling;
  }
}

/** Build enriched hook input for PRE_TOOL_CALL with security context. */
export function assembleSecurityContext(
  call: ParsedToolCall,
  config: SecurityContextConfig,
): { input: Record<string, unknown>; ctx: SecurityContext } {
  const lifecycle = parseMcpLifecycleIntent(call.name, call.args);
  const goalMutation = chatGoalMutation(call.name, call.args);
  const hookInput: Record<string, unknown> = {
    tool_call: call,
    tool_name: call.name,
    ...(lifecycle && { mcp_lifecycle_action: lifecycle.action }),
    ...(parseCustomToolApply(call.name, call.args) &&
      { custom_tool_apply: true }),
    ...(goalMutation && { chat_goal_mutation: goalMutation }),
  };
  const toolName = call.name;
  const toolFloor = config.toolFloorRegistry?.getFloor(toolName) ?? null;
  if (toolFloor !== null) hookInput.tool_floor = toolFloor;

  const resource = resolveResourceClassification(call, config);
  const identity = assembleIdentityContext(config);
  populateHookInputFields(hookInput, resource, identity);

  return {
    input: hookInput,
    ctx: {
      toolName,
      toolFloor,
      resourceClassification: resource.classification,
      operationType: resource.operation,
      resourceParam: resource.param,
      isOutboundRequest: resource.isOutbound,
      ...identity,
    },
  };
}
