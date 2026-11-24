/** Discover named Sentinel assessment coordinators without sharing model workers. */

import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";

const MAX_CONCURRENT_CASES = 12;
const COORDINATOR_SLICE_MS = 120_000;

interface SentinelCaseHandle {
  canYield?(): boolean;
  stop(): void;
}

export type SentinelCoordinatorState = "scheduled" | "waiting";
export type SentinelCoordinatorLookup = (
  caseId: string,
) => SentinelCoordinatorState | undefined;

interface SentinelCaseManagerOptions {
  readonly intervalMs?: number;
  readonly now?: () => number;
  /** Return false to release a coordinator slot for a paused or stopped assessment. */
  readonly isActiveCase?: (path: string) => boolean;
  readonly onError?: (error: unknown) => void;
}

/** Start and stop bounded per-case workers as named directories become available. */
export function startSentinelCaseManager(
  baseDir: string,
  startCase: (path: string, caseId: string) => SentinelCaseHandle,
  options: SentinelCaseManagerOptions = {},
): SentinelCaseHandle & {
  refresh(): void;
  coordinatorState(caseId: string): SentinelCoordinatorState | undefined;
} {
  const interval = options.intervalMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 300_000) {
    throw new Error("Sentinel case polling interval must be 100–300000ms");
  }
  const now = options.now ?? (() => performance.now());
  const coordinators = new Map<
    string,
    { handle: SentinelCaseHandle; started: number }
  >();
  const waiting = new Set<string>();
  let stopped = false;

  function report(error: unknown) {
    try {
      options.onError?.(error);
    } catch {
      // An observer failure must not stop case discovery.
    }
  }

  function stopCase(id: string, handle: SentinelCaseHandle) {
    coordinators.delete(id);
    try {
      handle.stop();
    } catch (error) {
      report(error);
    }
  }

  function refresh() {
    if (stopped) return;
    let candidates: string[];
    try {
      candidates = listSentinelCaseIds(baseDir);
    } catch (error) {
      report(error);
      return;
    }
    const paths = new Map<string, string>();
    for (const id of candidates) {
      let path: string;
      try {
        path = resolveSentinelCasePath(baseDir, id);
      } catch (error) {
        // Release the slot if a case path stopped being operator-controlled.
        report(error);
        continue;
      }
      try {
        if (options.isActiveCase?.(path) !== false) paths.set(id, path);
      } catch (error) {
        // Preserve an existing case if its database is temporarily unavailable.
        if (coordinators.has(id)) paths.set(id, path);
        report(error);
      }
    }
    for (const [id, { handle }] of coordinators) {
      if (!paths.has(id)) stopCase(id, handle);
    }
    for (const id of waiting) {
      if (!paths.has(id)) waiting.delete(id);
    }
    for (const id of paths.keys()) {
      if (!coordinators.has(id)) waiting.add(id);
    }

    const time = now();
    if (waiting.size && coordinators.size === MAX_CONCURRENT_CASES) {
      for (const [id, { handle, started }] of coordinators) {
        if (time - started < COORDINATOR_SLICE_MS) break;
        if (handle.canYield?.() === false) continue;
        stopCase(id, handle);
        waiting.add(id);
        break;
      }
    }

    for (const id of [...waiting]) {
      if (coordinators.size >= MAX_CONCURRENT_CASES) break;
      waiting.delete(id);
      try {
        coordinators.set(id, {
          handle: startCase(paths.get(id)!, id),
          started: time,
        });
      } catch (error) {
        waiting.add(id);
        report(error);
      }
    }
  }

  refresh();
  const timer = setInterval(refresh, interval);
  Deno.unrefTimer(timer);

  return {
    refresh,
    coordinatorState(caseId) {
      if (coordinators.has(caseId)) return "scheduled";
      if (waiting.has(caseId)) return "waiting";
      return undefined;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const [id, { handle }] of coordinators) stopCase(id, handle);
      waiting.clear();
    },
  };
}
