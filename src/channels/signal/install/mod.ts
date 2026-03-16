/**
 * Signal binary installation utilities.
 *
 * Exports archive extraction, JRE download, signal-cli download,
 * Java resolution, and entity marshaling.
 *
 * @module
 */

export {
  downloadAndExtractArchive,
  fetchAndExtractArchive,
  listDirectoryEntries,
  locateFirstExistingPath,
} from "./setup_archive.ts";

export { downloadJre, fetchJre } from "./setup_jre.ts";

export {
  downloadSignalCli,
  fetchKnownGoodRelease,
  fetchSignalCli,
} from "./setup_signal_cli.ts";
export type { SignalCliInstall } from "./setup_signal_cli.ts";

export {
  checkJava,
  javaHomeBin,
  resolveJavaHome,
  tryJava,
  verifyJava,
} from "./setup_java.ts";

export {
  marshalSignalContactEntry,
  marshalSignalGroupEntry,
} from "./signal_marshal.ts";
