/**
 * Agent loop — main LLM iteration cycle and turn entry point.
 *
 * @module
 */

export type { AgentLoopOptions } from "./agent_loop.ts";
export { orchestrateAgentLoop, runAgentLoop } from "./agent_loop.ts";

export { orchestrateAgentTurn, runAgentTurn } from "./agent_turn.ts";

export {
  callLlmAndRecordUsage,
  consumeProviderStream,
} from "./llm_streaming.ts";

export { dispatchIterationOutcome } from "./loop_iteration.ts";

export type {
  AgentLoopContext,
  IterationOutcome,
  LlmCallOutcome,
  LlmIterationResult,
  NudgeState,
} from "./loop_types.ts";

export {
  buildLlmMessages,
  CANCELLED_RESULT,
  computeSoftLimit,
  injectSoftLimitWarning,
  logFirstIterationDetails,
  resolveActiveToolList,
  traceLog,
} from "./loop_types.ts";
