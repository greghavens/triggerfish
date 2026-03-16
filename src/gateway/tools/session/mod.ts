/**
 * Session management, channel messaging, and Signal tool handlers.
 *
 * @module
 */

export {
  buildSessionToolDefinitions,
  buildSignalToolDefinitions,
  createSessionToolExecutor,
  getSessionToolDefinitions,
  getSignalToolDefinitions,
  SESSION_TOOLS_SYSTEM_PROMPT,
} from "./session_tools.ts";
export type { RegisteredChannel, SessionToolContext } from "./session_tools.ts";

export {
  dispatchSessionTool,
  SESSION_MANAGEMENT_TOOLS,
} from "./session_executors.ts";
export { CHANNEL_TOOLS, dispatchChannelTool } from "./channel_executors.ts";
export { dispatchSignalTool, SIGNAL_TOOLS } from "./signal_executors.ts";
