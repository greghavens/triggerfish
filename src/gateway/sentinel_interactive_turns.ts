/** Live owner controls for Sentinel main-agent turns, independent of the background run. */
import { resolve } from "@std/path";

interface InteractiveTurn {
  readonly id: string;
  readonly runId: string;
  readonly startedRevision: number;
  readonly signal: AbortSignal;
  readonly cancel: () => void;
}

const liveTurns = new Map<string, Map<string, InteractiveTurn>>();

export function registerSentinelInteractiveTurn(
  path: string,
  runId: string,
  startedRevision: number,
  signal: AbortSignal,
  cancel: () => void,
) {
  const key = resolve(path);
  const turns = liveTurns.get(key) ?? new Map<string, InteractiveTurn>();
  const id = crypto.randomUUID();
  turns.set(id, { id, runId, startedRevision, signal, cancel });
  liveTurns.set(key, turns);
  return () => {
    turns.delete(id);
    if (!turns.size) liveTurns.delete(key);
  };
}

export function listSentinelInteractiveTurns(
  path: string,
  runId: string,
  revision: number,
) {
  return [...(liveTurns.get(resolve(path))?.values() ?? [])]
    .filter((turn) =>
      turn.runId === runId && turn.startedRevision === revision &&
      !turn.signal.aborted
    )
    .slice(0, 20).map(({ id, startedRevision }) => ({ id, startedRevision }));
}

export function readSentinelInteractiveTurn(
  path: string,
  runId: string,
  revision: number,
  id: string,
) {
  const turn = liveTurns.get(resolve(path))?.get(id);
  if (
    turn?.runId !== runId || turn.startedRevision !== revision ||
    turn.signal.aborted
  ) return;
  return { id: turn.id, startedRevision: turn.startedRevision };
}

export function stopSentinelInteractiveTurn(
  path: string,
  runId: string,
  revision: number,
  id: string,
) {
  const turn = liveTurns.get(resolve(path))?.get(id);
  if (
    turn?.runId !== runId || turn.startedRevision !== revision ||
    turn.signal.aborted
  ) return false;
  turn.cancel();
  return true;
}
