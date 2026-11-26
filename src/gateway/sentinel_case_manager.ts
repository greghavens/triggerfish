/** Discover named Sentinel assessment coordinators without sharing model workers. */

import { MAX_SENTINEL_ASSESSMENT_CONCURRENCY } from "../core/config_types.ts";
import {
  readSentinelAssessmentAdmission,
  readSentinelCaseStatus,
} from "../sentinel/assessment_store.ts";
import { reconcileSentinelDeadlineGoal } from "./sentinel_goal_completion.ts";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";

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
  readonly concurrency?: number;
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
  isAdmitted(caseId: string, admissionAt: number): boolean;
  coordinatorState(caseId: string): SentinelCoordinatorState | undefined;
} {
  const interval = options.intervalMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 300_000) {
    throw new Error("Sentinel case polling interval must be 100–300000ms");
  }
  const ordered = options.concurrency !== undefined;
  const concurrency = options.concurrency ??
    MAX_SENTINEL_ASSESSMENT_CONCURRENCY;
  if (
    !Number.isSafeInteger(concurrency) || concurrency < 1 ||
    concurrency > MAX_SENTINEL_ASSESSMENT_CONCURRENCY
  ) {
    throw new Error(
      "Sentinel assessment concurrency must be an integer from 1 to 12",
    );
  }
  const now = options.now ?? (() => performance.now());
  const coordinators = new Map<
    string,
    { handle: SentinelCaseHandle; started: number; admission?: number }
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
    const paths = new Map<string, { path: string; admission?: number }>();
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
        if (options.isActiveCase?.(path) !== false) {
          if (ordered) {
            const status = readSentinelCaseStatus(path)?.status;
            // Deadline settlement uses committed records only and occupies no planner slot.
            if (status === "settling_timeout") {
              reconcileSentinelDeadlineGoal(path);
            }
            if (status !== "running") continue;
          }
          const admission = ordered
            ? readSentinelAssessmentAdmission(path)
            : undefined;
          if (!ordered || admission !== undefined) {
            paths.set(id, { path, admission });
          }
        }
      } catch (error) {
        // Preserve an existing case if its database is temporarily unavailable.
        const known = coordinators.get(id);
        if (known) paths.set(id, { path, admission: known.admission });
        report(error);
      }
    }
    for (const [id, { handle, admission }] of coordinators) {
      const candidate = paths.get(id);
      if (!candidate || (ordered && candidate.admission !== admission)) {
        stopCase(id, handle);
      }
    }
    for (const id of waiting) {
      if (!paths.has(id)) waiting.delete(id);
    }
    for (const id of paths.keys()) {
      if (!coordinators.has(id)) waiting.add(id);
    }

    const time = now();
    if (!ordered && waiting.size && coordinators.size === concurrency) {
      for (const [id, { handle, started }] of coordinators) {
        if (time - started < COORDINATOR_SLICE_MS) break;
        if (handle.canYield?.() === false) continue;
        stopCase(id, handle);
        waiting.add(id);
        break;
      }
    }

    const ready = [...waiting];
    if (ordered) {
      ready.sort((left, right) =>
        paths.get(left)!.admission! - paths.get(right)!.admission! ||
        left.localeCompare(right)
      );
    }
    for (const id of ready) {
      if (coordinators.size >= concurrency) break;
      waiting.delete(id);
      const { path, admission } = paths.get(id)!;
      try {
        coordinators.set(id, {
          handle: startCase(path, id),
          started: time,
          admission,
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
    isAdmitted(caseId, admissionAt) {
      return coordinators.get(caseId)?.admission === admissionAt;
    },
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
