/**
 * Tool dispatch — format conversion, access control, security, and response handling.
 *
 * @module
 */

export {
  orchestrateToolCallBatch,
  processToolCallBatch,
} from "./tool_dispatch.ts";

export {
  determineSourceType,
  recordToolCallLineageAndPersist,
} from "./tool_lineage.ts";

export {
  assessBumpersForToolCall,
  checkBumpersForToolCall,
  checkIntegrationWriteDown,
  dispatchApprovedToolCall,
  dispatchSecurityEnforcedToolCall,
  enforceIntegrationWriteDownPolicy,
  escalateNonOwnerResourceTaint,
  evaluatePreToolCallHook,
  executeAfterPolicyApproval,
  executePlanModeToolCall,
  executeSecurityEnforcedToolCall,
  invokePlanModeToolCall,
  preEscalateOwnerTriggerTaint,
} from "./security_pipeline.ts";

export {
  convertToolsToNativeFormat,
  parseNativeToolCalls,
} from "./tool_format.ts";

export {
  enforceNonOwnerToolCeiling,
  enforceTriggerToolCeiling,
  escalateResponseClassification,
  escalateToolPrefixTaint,
  wrapToolExecutorWithEnforcement,
} from "./access_control.ts";

export type { SecurityContext } from "./security_context.ts";
export { assembleSecurityContext } from "./security_context.ts";

export { renderPolicyBlockExplanation } from "./policy_block_explanation.ts";

export {
  buildRecoveryNudge,
  classifyResponseQuality,
  detectDenseNarration,
  detectRepetition,
  detectTrailingContinuationIntent,
  FALLBACK_RESPONSE,
} from "./response_quality.ts";

export {
  deliverFinalResponse,
  evaluatePreOutputHook,
  handleFinalResponse,
} from "./response_handling.ts";

export {
  buildReadMoreToolDefinition,
  capToolResponse,
  DEFAULT_RESPONSE_BUDGET,
  getReadMoreToolDefinition,
  MAX_CACHE_ENTRIES,
  readMoreFromCache,
  ResponseCache,
  TOOL_RESPONSE_BUDGETS,
  truncateAtLineBoundary,
} from "./response_cap.ts";
export type { CachedToolResponse } from "./response_cap.ts";
