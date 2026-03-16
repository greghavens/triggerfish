/**
 * Skills platform module.
 *
 * Provides skill discovery, security scanning, marketplace integration,
 * and agent self-authoring capabilities.
 *
 * @module
 */

export { createSkillLoader } from "./loader.ts";
export type {
  Skill,
  SkillLoader,
  SkillLoaderOptions,
  SkillSource,
} from "./loader.ts";

export { createSkillScanner } from "./scanner.ts";
export type { ScanResult, SkillScanner } from "./scanner.ts";

export { compareSemver, createReefRegistry } from "./registry.ts";
export type {
  ReefCatalog,
  ReefCatalogEntry,
  ReefRegistry,
  ReefRegistryOptions,
  ReefSearchOptions,
  ReefSkillListing,
  ReefSkillMetadata,
} from "./registry.ts";

export { createSkillAuthor } from "./author.ts";
export type {
  AuthoredSkill,
  SkillApprovalStatus,
  SkillAuthor,
  SkillAuthorOptions,
} from "./author.ts";

export {
  buildSkillToolDefinitions,
  createSkillToolExecutor,
  getSkillToolDefinitions,
} from "./tools.ts";
export type { SkillToolContext, SkillType } from "./tools.ts";

export { createSkillContextTracker } from "./context.ts";
export type { SkillContextTracker } from "./context.ts";

export {
  checkSkillClassificationCeiling,
  checkSkillNetworkDomain,
  enforceSkillClassificationCeiling,
  enforceSkillNetworkDomain,
  filterToolsForActiveSkill,
} from "./enforcer.ts";

export {
  computeSkillHash,
  loadSkillHashRecord,
  recordSkillHash,
  verifySkillIntegrity,
} from "./integrity.ts";
export type { SkillHashRecord } from "./integrity.ts";

export {
  buildSkillsSystemPrompt,
  buildTriggersSystemPrompt,
} from "./prompts.ts";
