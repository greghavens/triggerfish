import { resolve } from "@std/path";

const active = new Map<string, Set<AbortController>>();

export function startNamedConversationTurn(baseDir: string, id: string) {
  const key = resolve(baseDir, id);
  const controller = new AbortController();
  const turns = active.get(key) ?? new Set<AbortController>();
  turns.add(controller);
  active.set(key, turns);
  return {
    signal: controller.signal,
    finish() {
      turns.delete(controller);
      if (turns.size === 0) active.delete(key);
    },
  };
}

export function stopNamedConversationTurns(baseDir: string, id: string) {
  for (const turn of active.get(resolve(baseDir, id)) ?? []) turn.abort();
}
