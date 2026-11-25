/**
 * Shared message types for the filesystem sandbox.
 *
 * Used by both the sandboxed Worker and the parent-side client.
 * Messages are exchanged via Worker postMessage/onmessage.
 *
 * @module
 */

/** Operation types the sandbox worker supports. */
export type SandboxOp = "read" | "write" | "list" | "search" | "edit" | "glob";

/** Request sent from parent to sandbox worker over stdin. */
export interface SandboxRequest {
  readonly id: string;
  readonly op: SandboxOp;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Response sent from sandbox worker to parent over stdout. */
export interface SandboxResponse {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: string;
  readonly error?: string;
}
