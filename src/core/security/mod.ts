/**
 * Security module — tool floors, path classification, and shared constants.
 *
 * @module
 */

export {
  CLASSIFICATION_DIRS,
  DEFAULT_PATH_CLASSIFICATION,
  FILESYSTEM_READ_TOOLS,
  FILESYSTEM_WRITE_TOOLS,
  HARDCODED_TOOL_FLOORS,
  PROTECTED_BASENAMES,
  PROTECTED_DIR_PATTERNS,
  WORKSPACE_SUBDIRS,
} from "./constants.ts";

export {
  createPathClassifier,
  expandTilde,
  resolveHome,
} from "./path_classification.ts";
export type {
  FilesystemSecurityConfig,
  PathClassificationResult,
  PathClassifier,
  WorkspacePaths,
} from "./path_classification.ts";

export { createToolFloorRegistry } from "./tool_floors.ts";
export type { ToolFloorRegistry } from "./tool_floors.ts";

export { isWithinJail, resolveWithinJail } from "./path_jail.ts";

export {
  classifyCommandPaths,
  extractCommandPaths,
} from "./command_path_extraction.ts";
export type { CommandClassificationResult } from "./command_path_extraction.ts";

export {
  extractBearerToken,
  isOriginAllowed,
  rejectWebSocketUpgrade,
} from "./websocket_auth.ts";

export { sanitizePathForPrompt } from "./path_sanitization.ts";

export {
  checkIpListForSsrf,
  enforceIpListForSsrf,
  isPrivateIp,
  resolveAndCheck,
} from "./ssrf.ts";
export { safeFetch } from "./safe_fetch.ts";
export type { SsrfChecker } from "./safe_fetch.ts";
