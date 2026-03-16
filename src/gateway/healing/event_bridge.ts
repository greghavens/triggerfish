/**
 * Healing event bridge — forwards rich workflow events to the lead agent.
 *
 * Subscribes to the workflow run registry and batches events to avoid
 * flooding the lead session with individual step events.
 * @module
 */

import type { RichWorkflowEvent } from "../../workflow/healing/types.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("healing-event-bridge");

/** Options for creating a healing event bridge. */
export interface EventBridgeOptions {
  /** Callback to deliver events to the lead agent. */
  readonly deliverToLead: (
    events: readonly RichWorkflowEvent[],
  ) => Promise<void>;
  /** Batching window in milliseconds (default: 500). */
  readonly batchWindowMs?: number;
}

/** Handle for managing the event bridge lifecycle. */
export interface HealingEventBridge {
  /** Enqueue a rich workflow event for delivery. */
  enqueueEvent(event: RichWorkflowEvent): void;
  /** Flush any pending events and tear down the bridge. */
  teardown(): Promise<void>;
}

/** Create an event bridge that batches and forwards events to a lead. */
export function createHealingEventBridge(
  options: EventBridgeOptions,
): HealingEventBridge {
  const batchWindowMs = options.batchWindowMs ?? 500;
  let pending: RichWorkflowEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tornDown = false;

  async function flushPendingEvents(): Promise<void> {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];

    try {
      await options.deliverToLead(batch);
    } catch (err) {
      log.error("Event bridge delivery to lead failed", {
        operation: "flushPendingEvents",
        eventCount: batch.length,
        err,
      });
    }
  }

  function scheduleFlush(): void {
    if (timer !== null || tornDown) return;
    timer = setTimeout(async () => {
      timer = null;
      await flushPendingEvents();
    }, batchWindowMs);
  }

  return {
    enqueueEvent(event: RichWorkflowEvent): void {
      if (tornDown) {
        log.debug("Dropping event after teardown", {
          operation: "enqueueEvent",
          eventType: event.type,
        });
        return;
      }
      pending.push(event);

      const isTerminal = event.type === "WORKFLOW_COMPLETED" ||
        event.type === "WORKFLOW_FAULTED";
      if (isTerminal) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        flushPendingEvents().catch((err) => {
          log.error("Terminal event flush failed", {
            operation: "enqueueEvent",
            err,
          });
        });
        return;
      }

      scheduleFlush();
    },

    async teardown(): Promise<void> {
      tornDown = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await flushPendingEvents();
      log.info("Healing event bridge torn down", {
        operation: "teardown",
      });
    },
  };
}
