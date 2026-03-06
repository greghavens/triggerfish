/**
 * Filesystem sandbox — OS-level enforcement via Deno subprocess permissions.
 *
 * Spawns a long-lived Deno subprocess with `--allow-read=<workspace>`
 * and `--allow-write=<workspace>`. All filesystem tool operations
 * (read, write, list, search, edit) are routed through this subprocess
 * via NDJSON over stdin/stdout.
 *
 * @module
 */

export { createFilesystemSandbox, probeDenoRuntime } from "./client.ts";
export type { FilesystemSandbox, FilesystemSandboxOptions } from "./client.ts";
export type { SandboxOp, SandboxRequest, SandboxResponse } from "./protocol.ts";
