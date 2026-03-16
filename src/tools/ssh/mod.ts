/**
 * SSH tools — execute commands and manage interactive sessions on remote hosts.
 *
 * All credentials MUST come from the secret store via {{secret:name}} references.
 * The LLM must never read keys or passwords from the filesystem.
 *
 * @module
 */

export {
  buildSshToolDefinitions,
  getSshToolDefinitions,
  SSH_SYSTEM_PROMPT,
} from "./ssh_defs.ts";
export { createSshToolExecutor } from "./ssh_executor.ts";
export {
  cleanupTempFile,
  materializeAskpassScript,
  materializeKeyToTempFile,
  SshSessionManager,
} from "./ssh_session.ts";
export type { SshSession, SshSessionId } from "./ssh_session.ts";
