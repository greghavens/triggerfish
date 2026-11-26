/** In-process notification after a durable assessment interruption commits. */
import { resolve } from "@std/path";

export interface SentinelAssessmentInterruption {
  readonly runId: string;
  readonly revision: number;
  readonly action: "paused" | "stopped";
}

type Listener = (event: SentinelAssessmentInterruption) => void;
const listeners = new Map<string, Set<Listener>>();

export function observeSentinelAssessmentInterruption(
  snapshotPath: string,
  listener: Listener,
) {
  const path = resolve(snapshotPath);
  const selected = listeners.get(path) ?? new Set<Listener>();
  selected.add(listener);
  listeners.set(path, selected);
  return () => {
    selected.delete(listener);
    if (selected.size === 0) listeners.delete(path);
  };
}

export function notifySentinelAssessmentInterruption(
  snapshotPath: string,
  event: SentinelAssessmentInterruption,
) {
  for (const listener of listeners.get(resolve(snapshotPath)) ?? []) {
    try {
      listener(event);
    } catch {
      // An observer cannot change the committed lifecycle decision.
    }
  }
}
