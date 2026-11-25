/** Hold the real restore at the case publication boundary for a process-kill test. */
import { executeOperatorRunArchive } from "../../../src/gateway/operator_run_archive.ts";
import { resolveSentinelCasePath } from "../../../src/sentinel/cases.ts";

const [baseDir, request] = Deno.args;
const args = JSON.parse(request);
const destination = resolveSentinelCasePath(baseDir, args.id);
const rename = Deno.renameSync;
Deno.renameSync = (from, to) => {
  if (to === destination) {
    Deno.stdout.writeSync(new TextEncoder().encode("ready\n"));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  rename(from, to);
};
const result = await executeOperatorRunArchive(
  baseDir,
  { kind: "sentinel", id: args.id, revision: args.revision },
  args,
  () => Promise.resolve(true),
);
throw new Error(
  `Restore did not reach publication boundary: ${JSON.stringify(result)}`,
);
