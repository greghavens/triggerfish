/**
 * Self-update system: download, verify, and replace the Triggerfish binary.
 * @module
 */

export type { UpdateResult } from "./updater.ts";
export { updateTriggerfish, upgradeTriggerfish } from "./updater.ts";

export type { ChangelogRange, ReleaseNote } from "./changelog.ts";
export {
  compareVersionTags,
  fetchAllReleases,
  fetchChangelogRange,
  normalizeVersionTag,
  parseSemver,
} from "./changelog.ts";

export {
  formatChangelogConcatenated,
  formatChangelogMarkdown,
  formatChangelogPlainText,
} from "./changelog_format.ts";
