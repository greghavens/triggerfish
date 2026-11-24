/** Publish a validated, private Sentinel snapshot to the chat gateway. */
import { dirname } from "@std/path";
import { publishSentinelInput } from "../../sentinel/published_input.ts";
import { sentinelAlertsPath } from "../../sentinel/paths.ts";
import {
  MAX_SNAPSHOT_BYTES,
  readSentinelChatSnapshot,
} from "../../sentinel/chat_mode.ts";
import { loadSentinelGraph } from "../../sentinel/graph.ts";
import {
  isSeverityIncrease,
  sentinelAlertKey,
} from "../../sentinel/telemetry.ts";
import { parseSentinelTelemetryAlert } from "../../sentinel/case_report.ts";

const LIVE_ALERT_LIMIT = 512;

export async function publishSentinelSnapshot(input: string, path: string) {
  const snapshot = loadSentinelGraph(
    await readSentinelChatSnapshot(input),
  ).snapshot();
  await publishSentinelInput(
    path,
    snapshot,
  );
  return { nodes: snapshot.nodes.length, edges: snapshot.edges.length };
}

export async function publishSentinelAlerts(
  records: readonly unknown[],
  path: string,
) {
  const alerts = records.map((record, index) =>
    parseSentinelTelemetryAlert(record, index + 1)
  );
  const output = sentinelAlertsPath(path);
  await withAlertPublishLock(
    output,
    () => publishSentinelInput(output, alerts),
  );
  return { alerts: alerts.length };
}

async function withAlertPublishLock(
  output: string,
  publish: () => Promise<void>,
): Promise<void> {
  await Deno.mkdir(dirname(output), { mode: 0o700, recursive: true });
  const lock = await Deno.open(`${output}.lock`, {
    create: true,
    write: true,
    mode: 0o600,
  });
  try {
    await lock.lock(true);
    await publish();
  } finally {
    lock.close();
  }
}

/** Publish a private, bounded rolling alert batch from live detectors. */
export async function createLiveSentinelAlertPublisher(path: string) {
  const output = sentinelAlertsPath(path);
  const alerts = new Map<
    string,
    ReturnType<typeof parseSentinelTelemetryAlert>
  >();
  const encoder = new TextEncoder();
  const pending = new Map<
    string,
    ReturnType<typeof parseSentinelTelemetryAlert>
  >();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;
  let closing = false;
  let retryDelay = 1_000;
  let failure: unknown;
  let unpublishedDrops = 0;

  type Alert = ReturnType<typeof parseSentinelTelemetryAlert>;
  function retain(target: Map<string, Alert>, key: string, alert: Alert) {
    const prior = target.get(key);
    if (
      prior && (alert.type !== "security_sensor_alert" ||
        !isSeverityIncrease(prior.severity, alert.severity))
    ) {
      if (prior.triggeringAction || !alert.triggeringAction) return false;
      target.set(key, { ...prior, triggeringAction: alert.triggeringAction });
      return true;
    }
    target.set(
      key,
      prior?.triggeringAction && !alert.triggeringAction
        ? { ...alert, triggeringAction: prior.triggeringAction }
        : alert,
    );
    if (target.size > LIVE_ALERT_LIMIT) {
      target.delete(target.keys().next().value!);
    }
    return true;
  }

  function retainUnpublished(
    target: Map<string, Alert>,
    key: string,
    alert: Alert,
  ) {
    if (target.size === LIVE_ALERT_LIMIT && !target.has(key)) {
      unpublishedDrops++;
    }
    retain(target, key, alert);
  }

  async function readPublished(): Promise<Map<string, Alert>> {
    const snapshot = new Map<string, Alert>();
    try {
      const existing = await readSentinelChatSnapshot(output);
      if (!Array.isArray(existing)) {
        throw new Error("Invalid published Sentinel alerts");
      }
      for (const [index, raw] of existing.entries()) {
        const alert = parseSentinelTelemetryAlert(raw, index + 1);
        retain(snapshot, sentinelAlertKey(alert), alert);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return snapshot;
  }

  for (const [key, alert] of await readPublished()) retain(alerts, key, alert);

  async function mergePublished(batch: Map<string, Alert>) {
    await withAlertPublishLock(output, async () => {
      const merged = await readPublished();
      for (const [key, alert] of batch) retain(merged, key, alert);
      const saved = new Map<string, Alert>();
      let remaining = MAX_SNAPSHOT_BYTES - 1;
      for (const [key, alert] of [...merged.entries()].reverse()) {
        const bytes = encoder.encode(JSON.stringify(alert)).length + 1;
        if (bytes > remaining) break;
        saved.set(key, alert);
        remaining -= bytes;
      }
      const ordered = [...saved.entries()].reverse();
      await publishSentinelInput(output, ordered.map(([, alert]) => alert));
      for (const [key, alert] of ordered) retain(alerts, key, alert);
      const dropped = [...batch.keys()].filter((key) =>
        merged.has(key) && !saved.has(key)
      ).length;
      if (dropped) {
        console.error(
          JSON.stringify({ type: "alert_publish_size_limit", dropped }),
        );
      }
    });
  }

  function schedule() {
    if (closing || timer !== undefined || writing || !pending.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, retryDelay);
  }

  function flush(): Promise<void> | undefined {
    if (writing || !pending.size) return writing;
    if (unpublishedDrops) {
      console.error(JSON.stringify({
        type: "alert_publish_overflow",
        dropped: unpublishedDrops,
      }));
      unpublishedDrops = 0;
    }
    const batch = new Map(pending);
    pending.clear();
    writing = mergePublished(batch)
      .then(() => {
        failure = undefined;
        retryDelay = 1_000;
      }, (error: unknown) => {
        if (failure === undefined) {
          console.error(JSON.stringify({ type: "alert_publish_error" }));
        }
        failure = error;
        retryDelay = Math.min(30_000, retryDelay * 2);
        for (const [key, alert] of pending) {
          retainUnpublished(batch, key, alert);
        }
        pending.clear();
        for (const [key, alert] of batch) pending.set(key, alert);
      })
      .finally(() => {
        writing = undefined;
        schedule();
      });
    return writing;
  }

  async function flushFullBatch(): Promise<void> {
    await writing;
    if (failure !== undefined || pending.size < LIVE_ALERT_LIMIT) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    await flush();
  }

  return {
    append(alert: ReturnType<typeof parseSentinelTelemetryAlert>) {
      if (closing) throw new Error("Sentinel alert publisher is closing");
      const key = sentinelAlertKey(alert);
      if (!retain(alerts, key, alert)) return false;
      retainUnpublished(pending, key, alert);
      schedule();
      return true;
    },
    flushWhenFull(): Promise<void> | undefined {
      if (pending.size === LIVE_ALERT_LIMIT && failure === undefined) {
        return flushFullBatch();
      }
    },
    async finish() {
      closing = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await writing;
      await flush();
      if (failure !== undefined) throw failure;
    },
  };
}
