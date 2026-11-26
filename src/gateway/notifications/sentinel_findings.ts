import type {
  ManagedSentinelFindingScope,
  ManagedSentinelFindingSource,
  ManagedSentinelIncidentScope,
} from "../../core/managed_notification_channels.ts";
import type { HookRunner } from "../../core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../core/types/session.ts";
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
} from "../../sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../sentinel/cases.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
  readSentinelWorkerFindingTraceReceipt,
} from "../../sentinel/worker_finding_store.ts";
import { readSentinelFindingReceiptScope } from "../sentinel_worker_findings.ts";
import type { OperatorNotificationChannels } from "./operator_channels.ts";

function readCase(path: string, caseId: string) {
  const state = readSentinelAssessment(path);
  return state && (state.active || state.completion) && !state.paused &&
      state.plan.runId
    ? { caseId, runId: state.plan.runId, afterRevision: state.revision }
    : undefined;
}

export function readSentinelFindingNotificationScope(
  baseDir: string,
  caseId: string,
):
  | (ManagedSentinelIncidentScope & { readonly afterSequence: number })
  | undefined {
  const path = resolveSentinelCasePath(baseDir, caseId);
  const selected = readCase(path, caseId);
  if (!selected) return;
  const journal = hasSentinelWorkerFindingJournal(path)
    ? openSentinelWorkerFindingStore(path)
    : undefined;
  try {
    return { ...selected, afterSequence: journal?.notificationSequence() ?? 0 };
  } finally {
    journal?.close();
  }
}

function findEvents(
  path: string,
  selected: ManagedSentinelIncidentScope,
  afterSequence: number,
  limit: number,
): ManagedSentinelFindingSource[] {
  if (!hasSentinelWorkerFindingJournal(path)) return [];
  const scope = readSentinelFindingReceiptScope(path, selected.afterRevision);
  if (scope?.runId !== selected.runId) return [];
  const store = openSentinelWorkerFindingStore(path);
  try {
    return store.notificationEvents(
      selected.caseId,
      selected.runId,
      selected.afterRevision,
      afterSequence,
      limit,
    ).map(({ finding, amendment, sequence, previousStatus }) => ({
      kind: amendment
        ? "sentinel_finding_status_changed"
        : "sentinel_finding_created",
      caseId: selected.caseId,
      runId: selected.runId,
      revision: selected.afterRevision,
      findingId: finding.id,
      receiptId: amendment?.id ?? finding.id,
      sequence,
      assignmentId: amendment?.taskId ?? finding.taskId,
      reportVersion: amendment?.version ?? 1,
      ...(amendment && { previousStatus, status: amendment.disposition }),
    }));
  } finally {
    store.close();
  }
}

export function isCurrentSentinelFindingNotification(
  baseDir: string,
  source: ManagedSentinelFindingSource,
): boolean {
  const path = resolveSentinelCasePath(baseDir, source.caseId);
  const selected = readCase(path, source.caseId);
  if (
    !selected || selected.runId !== source.runId ||
    selected.afterRevision !== source.revision ||
    !hasSentinelWorkerFindingJournal(path)
  ) return false;
  const scope = readSentinelFindingReceiptScope(path, source.revision);
  if (scope?.runId !== source.runId) return false;
  const store = openSentinelWorkerFindingStore(path);
  try {
    const event = store.notificationEvents(
      source.caseId,
      source.runId,
      source.revision,
      source.sequence - 1,
      1,
    )[0];
    if (!event || event.sequence !== source.sequence) return false;
    const evidence = event.amendment ?? event.finding;
    const nodes = readSentinelAssessmentRevision(path, source.revision)
      ?.result.sharedGraph.snapshot?.nodes;
    const original = readSentinelFindingReceiptScope(
      path,
      event.finding.evidenceRevision,
    );
    if (
      !nodes || original?.runId !== source.runId ||
      ![
        event.finding.targetId,
        event.finding.graphFindingId,
        event.finding.evidenceId,
      ].every((id) => nodes.some((node) => node.id === id)) ||
      !original.allowsRecord(event.finding) ||
      !original.allows(event.finding.evidenceId) ||
      !readSentinelWorkerFindingTraceReceipt(path, {
        ...evidence,
        taskId: evidence.taskId,
      }, source.receiptId)
    ) return false;
    return event.finding.id === source.findingId &&
      evidence.id === source.receiptId &&
      evidence.taskId === source.assignmentId &&
      (event.amendment
        ? source.kind === "sentinel_finding_status_changed" &&
          event.amendment.version === source.reportVersion &&
          event.amendment.disposition === source.status &&
          event.previousStatus === source.previousStatus
        : source.kind === "sentinel_finding_created" &&
          source.reportVersion === 1) &&
      scope.allowsRecord(event.finding) &&
      scope.allows(event.finding.graphFindingId, "review_finding") &&
      scope.allows(event.finding.evidenceId) &&
      (!event.amendment || event.amendment.targetId === event.finding.targetId);
  } finally {
    store.close();
  }
}

export function matchesSentinelFindingSubscription(
  scope: ManagedSentinelFindingScope | undefined,
  source: ManagedSentinelFindingSource,
): boolean {
  return scope?.caseId === source.caseId && scope.runId === source.runId &&
    scope.afterRevision <= source.revision &&
    scope.afterSequence !== undefined &&
    scope.afterSequence < source.sequence && scope.events.includes(source.kind);
}

export function sentinelFindingNotificationBody(
  source: ManagedSentinelFindingSource,
) {
  const { sequence: _sequence, kind, ...receipt } = source;
  return JSON.stringify({ type: `triggerfish.${kind}`, ...receipt });
}

/** Publish retained finding events without exposing finding text or raw evidence. */
export function createSentinelFindingDelivery(
  baseDir: string,
  channels: OperatorNotificationChannels,
  hooks: HookRunner,
) {
  const session = {
    ...createSession({
      userId: "owner" as UserId,
      channelId: "sentinel-finding-notification" as ChannelId,
    }),
    taint: "INTERNAL" as const,
  };
  const scanned = new Map<string, { cursor: string; sequence: number }>();
  return async (caseId: string, coordinatorCurrent: () => boolean) => {
    const subscriptions = (await channels.store.channels()).filter((channel) =>
      channel.enabled && channel.classification === "INTERNAL" &&
      channel.sentinelFindings?.caseId === caseId
    );
    if (!coordinatorCurrent() || !subscriptions.length) return;
    const path = resolveSentinelCasePath(baseDir, caseId);
    const selected = readCase(path, caseId);
    if (!selected) return;
    for (const channel of subscriptions) {
      const subscription = channel.sentinelFindings!;
      if (
        subscription.runId !== selected.runId ||
        subscription.afterSequence === undefined
      ) continue;
      const cursor = JSON.stringify([
        channel.id,
        channel.version,
        selected.runId,
        selected.afterRevision,
      ]);
      const previous = scanned.get(channel.id);
      const after = previous?.cursor === cursor
        ? previous.sequence
        : subscription.afterSequence;
      const events = findEvents(path, selected, after, 32);
      const due = (await channels.store.dueFindingRetries(channel)).filter(
        (source) =>
          matchesSentinelFindingSubscription(subscription, source) &&
          isCurrentSentinelFindingNotification(baseDir, source),
      ).slice(0, 5);
      const candidateSources = new Map(
        [...due, ...events].map((source) => [source.receiptId, source]),
      );
      for (const source of candidateSources.values()) {
        if (!coordinatorCurrent()) return;
        const isCurrent = () =>
          coordinatorCurrent() &&
          isCurrentSentinelFindingNotification(baseDir, source);
        if (
          matchesSentinelFindingSubscription(subscription, source) &&
          isCurrent()
        ) {
          const body = sentinelFindingNotificationBody(source);
          const metadata = {
            destination: channel.destinationOrigin,
            notification_channel_id: channel.id,
            target_classification: channel.classification,
            case_id: source.caseId,
            run_id: source.runId,
            evidence_revision: source.revision,
            finding_id: source.findingId,
            source_receipt_id: source.receiptId,
          };
          await channels.store.send(
            channel,
            source.receiptId,
            (stillCurrent) =>
              channels.sendWebhook(channel, body, async () => {
                if (!isCurrent()) return false;
                const decision = await hooks.evaluateHook("PRE_OUTPUT", {
                  session,
                  input: { ...metadata, content: body },
                  auditInput: metadata,
                });
                return decision.allowed && await stillCurrent() && isCurrent();
              }),
            { source },
          );
        }
      }
      const last = events.at(-1);
      if (last) scanned.set(channel.id, { cursor, sequence: last.sequence });
    }
  };
}
