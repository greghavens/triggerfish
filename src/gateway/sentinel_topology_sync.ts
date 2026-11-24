/** Refresh opt-in cross-case topology overlays from published inventories. */
import { dirname, join } from "@std/path";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import { sentinelSharedTopologyPath } from "../sentinel/paths.ts";
import { publishSentinelInput } from "../sentinel/published_input.ts";
import { collectSharedSentinelTopology } from "../sentinel/shared_inventory.ts";

import { withSentinelSourceSnapshotLock } from "../sentinel/source_snapshot_lock.ts";

function settingPath(snapshotPath: string): string {
  return join(dirname(snapshotPath), "sentinel-shared-topology-auto.json");
}

async function readOptional(path: string) {
  try {
    return await readSentinelChatSnapshot(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export async function sentinelTopologyAutoEnabled(snapshotPath: string) {
  return await readOptional(settingPath(snapshotPath)) === true;
}

const caseOperations = new Map<string, Promise<void>>();

function runCaseOperation(path: string, operation: () => Promise<void>) {
  const previous = caseOperations.get(path);
  const pending = (previous ? previous.catch(() => {}) : Promise.resolve())
    .then(operation).finally(() => {
      if (caseOperations.get(path) === pending) caseOperations.delete(path);
    });
  caseOperations.set(path, pending);
  return pending;
}

async function reconcileTopology(
  baseDir: string,
  caseId: string,
  path: string,
  signal?: AbortSignal,
) {
  await withSentinelSourceSnapshotLock(baseDir, true, async () => {
    signal?.throwIfAborted();
    if (signal && !await sentinelTopologyAutoEnabled(path)) return;
    const topology = await collectSharedSentinelTopology(
      baseDir,
      caseId,
      path,
      signal,
      true,
    );
    const overlay = sentinelSharedTopologyPath(path);
    const previous = await readOptional(overlay);
    if (JSON.stringify(previous) === JSON.stringify(topology)) return;
    signal?.throwIfAborted();
    if (signal && !await sentinelTopologyAutoEnabled(path)) return;
    signal?.throwIfAborted();
    await publishSentinelInput(overlay, topology);
  });
}

export function syncSentinelTopology(
  baseDir: string,
  caseId: string,
  path: string,
  signal?: AbortSignal,
) {
  return runCaseOperation(
    path,
    () => reconcileTopology(baseDir, caseId, path, signal),
  );
}

export function setSentinelTopologyAuto(
  baseDir: string,
  caseId: string,
  path: string,
  enabled: boolean,
) {
  return runCaseOperation(path, async () => {
    if (enabled) await reconcileTopology(baseDir, caseId, path);
    await publishSentinelInput(settingPath(path), enabled);
  });
}

export function startSentinelTopologySync(
  baseDir: string,
  onError: () => void,
) {
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  function refresh() {
    if (controller.signal.aborted) return Promise.resolve();
    running ??= (async () => {
      for (const id of ["main", ...listSentinelCaseIds(baseDir)]) {
        if (controller.signal.aborted) return;
        try {
          const path = resolveSentinelCasePath(baseDir, id);
          if (await sentinelTopologyAutoEnabled(path)) {
            await syncSentinelTopology(baseDir, id, path, controller.signal);
          }
        } catch {
          if (!controller.signal.aborted) onError();
        }
      }
    })().catch(() => {
      if (!controller.signal.aborted) onError();
    }).finally(() => {
      running = undefined;
    });
    return running;
  }

  const timer = setInterval(() => {
    void refresh();
  }, 60_000);
  Deno.unrefTimer(timer);
  queueMicrotask(() => {
    void refresh();
  });
  return {
    refresh,
    stop() {
      controller.abort();
      clearInterval(timer);
    },
  };
}
