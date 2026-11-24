import { humanize, type SentinelAdaptive } from "./types.js";

/** Encode imported content so a Markdown renderer treats it as text. */
export function comparisonText(value: string): string {
  return value.replace(
    /[^\p{L}\p{N} ]/gu,
    (character) => {
      const code = character.codePointAt(0)!;
      if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) {
        return `&#91;U+${code.toString(16).toUpperCase().padStart(4, "0")}&#93;`;
      }
      return `&#${code};`;
    },
  );
}

type WorkerHistory = NonNullable<SentinelAdaptive["history"]>;

export function workerEventLabel(
  event: WorkerHistory[number],
  text = (value: string) => value,
): string {
  return [
    event.kind ? text(humanize(event.kind)) : event.taskId,
    event.nodeId,
    text(humanize(event.event)),
    event.attempt > 0 ? `${text("Attempt")} ${event.attempt}` : null,
  ].filter(Boolean).join(" · ");
}

export function workerTimelinesMarkdown(
  timelines: readonly { revision: number; events: WorkerHistory | null }[],
  text = (value: string) => value,
): string {
  const lines = [`## ${text("Worker timelines")}`, ""];
  for (const { revision, events } of timelines) {
    lines.push(`### ${text("Revision")} ${revision}`, "");
    if (!events) lines.push(text("No linked adaptive plan."));
    else if (!events.length) lines.push(text("No recorded task transitions."));
    for (const event of events ?? []) {
      lines.push(`- ${comparisonText(event.at)} · ${comparisonText(workerEventLabel(event, text))}`);
      if (event.note) lines.push(`  - ${comparisonText(event.note)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
