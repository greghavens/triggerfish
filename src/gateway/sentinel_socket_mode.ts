import { registerSentinelInteractiveTurn } from "./sentinel_interactive_turns.ts";
import { readSentinelAssessment } from "../sentinel/assessment_store.ts";
import { observeSentinelAssessmentInterruption } from "../sentinel/assessment_interruptions.ts";
/** Select the agent and conversation context for an authenticated chat socket. */
import {
  extractText,
  hasImages,
  type MessageContent,
} from "../core/image/content.ts";
import {
  type SentinelReportLanguage,
  sentinelReportText,
} from "../sentinel/report_language.ts";
import type { ChatEventSender } from "../core/types/chat_event.ts";
import {
  handleSentinelChatTurn,
  readSentinelChatSnapshot,
} from "../sentinel/chat_mode.ts";

interface SentinelWorker {
  execute(
    content: MessageContent,
    send: ChatEventSender,
    signal?: AbortSignal,
  ): Promise<void>;
  clear(): void;
}

interface SentinelModeOptions {
  readonly createAgent?: (
    worker?: boolean,
    caseSnapshotPath?: string,
  ) => SentinelWorker;
  readonly resolveCase?: (caseId: string) => string | undefined;
  readonly clearContext?: () => Promise<void>;
  readonly webContainmentConfigured?: boolean;
  readonly readOutputLanguage?: (
    path: string,
  ) => SentinelReportLanguage | undefined;
}

async function executeCaseChat(
  path: string | undefined,
  agent: SentinelWorker,
  message: MessageContent,
  send: ChatEventSender,
  signal: AbortSignal,
  main = false,
) {
  const initial = path && readSentinelAssessment(path);
  if (!path || !initial || !initial.plan.runId) {
    return await agent.execute(message, send, signal);
  }
  const scoped = new AbortController();
  const combined = AbortSignal.any([signal, scoped.signal]);
  const cancel = (reason: string) => {
    if (combined.aborted) return;
    scoped.abort(reason);
    send({ type: "cancelled" });
  };
  const startedActive = initial.active && !initial.paused;
  const unsubscribe = startedActive &&
    observeSentinelAssessmentInterruption(path, (event) => {
      if (
        event.runId === initial.plan.runId && event.revision >= initial.revision
      ) cancel(event.action);
    });
  const unregister = main && registerSentinelInteractiveTurn(
    path,
    initial.plan.runId,
    initial.revision,
    combined,
    () => cancel("owner stopped the Sentinel interactive turn"),
  );
  try {
    await agent.execute(message, (event) => {
      if (!combined.aborted) send(event);
    }, combined);
  } finally {
    if (unsubscribe) unsubscribe();
    if (unregister) unregister();
  }
}

export function createSentinelSocketMode(
  mainSnapshotPath?: string,
  options: SentinelModeOptions = {},
) {
  let enabled = false;
  let caseId = "main";
  let agent: SentinelWorker | undefined;
  let generation = 0;
  const workers = new Set<SentinelWorker>();

  function clearAgents() {
    generation++;
    agent?.clear();
    agent = undefined;
    for (const worker of workers) worker.clear();
    workers.clear();
  }

  function reset() {
    enabled = false;
    caseId = "main";
    clearAgents();
  }

  function casePath(id: string) {
    try {
      return id === "main" ? mainSnapshotPath : options.resolveCase?.(id);
    } catch {
      return undefined;
    }
  }

  return {
    reset,
    sideQuestionSubject() {
      return enabled ? { caseId, path: casePath(caseId) } : undefined;
    },
    get active() {
      return enabled;
    },
    async handle(
      content: MessageContent,
      send: ChatEventSender,
      signal: AbortSignal,
    ): Promise<boolean> {
      const turnGeneration = generation;
      const sendCurrent: ChatEventSender = (event) => {
        if (!signal.aborted && generation === turnGeneration) send(event);
      };
      const text = extractText(content).trim();
      if (/^\/sentinel-recheck(?:\s|$)/.test(text)) return false;
      const modeCommand = /^\/sentinel(?:\s|$)/.test(text);
      const workerCommand = /^\/sentinel-agent(?:\s|$)/.test(text);
      if (!enabled && !modeCommand && !workerCommand) return false;
      if (!mainSnapshotPath) {
        send({
          type: "response",
          text: "Sentinel requires authenticated operator chat.",
        });
        return true;
      }
      const snapshotPath = casePath(caseId);
      const language =
        options.readOutputLanguage?.(snapshotPath ?? mainSnapshotPath) ?? "en";
      const t = sentinelReportText(language);
      if (hasImages(content)) {
        send({ type: "response", text: t("Sentinel accepts text requests.") });
        return true;
      }

      const caseCommand = /^\/sentinel\s+case(?:\s+(\S+))?$/.exec(text);
      if (caseCommand) {
        const selected = caseCommand[1];
        const selectedPath = selected && enabled && selected !== caseId
          ? casePath(selected)
          : undefined;
        let response: string;
        if (!enabled) {
          response = t(
            "Turn on Sentinel mode before choosing an assessment case.",
          );
        } else if (!selected || selected === caseId) {
          response = t("Sentinel case: {caseId}.", { caseId });
        } else if (!selectedPath) {
          response = t("That Sentinel case is unavailable.");
        } else {
          await options.clearContext?.();
          if (signal.aborted || generation !== turnGeneration) return true;
          clearAgents();
          caseId = selected;
          response = sentinelReportText(
            options.readOutputLanguage?.(selectedPath) ?? "en",
          )("Sentinel case: {caseId}.", { caseId });
        }
        send({ type: "response", text: response, taint: "INTERNAL" });
        return true;
      }

      if (
        !snapshotPath && !/^\/sentinel(?:\s+(?:on|off|status))?$/.test(text)
      ) {
        send({
          type: "response",
          text: t("The selected Sentinel case is unavailable."),
          taint: "INTERNAL",
        });
        return true;
      }

      if (workerCommand) {
        const task = text.slice("/sentinel-agent".length).trim();
        if (!task || !options.createAgent) {
          send({
            type: "response",
            text: t(
              "Use /sentinel-agent followed by a defensive investigation question with Sentinel model access enabled.",
            ),
          });
          return true;
        }
        const worker = options.createAgent(true, snapshotPath);
        workers.add(worker);
        try {
          await executeCaseChat(
            snapshotPath,
            worker,
            task,
            sendCurrent,
            signal,
          );
        } finally {
          if (workers.delete(worker)) worker.clear();
        }
        return true;
      }

      if (
        enabled && snapshotPath &&
        /^assessment workers(?:\s|$)/.test(text)
      ) {
        const { runSentinelWorkerControlChat } = await import(
          "./sentinel_worker_control.ts"
        );
        try {
          if (signal.aborted) return true;
          sendCurrent({
            type: "response",
            text: runSentinelWorkerControlChat(snapshotPath, text),
            taint: "INTERNAL",
          });
        } catch (error) {
          sendCurrent({
            type: "error",
            message: error instanceof Error
              ? error.message
              : "Worker control failed.",
          });
        }
        return true;
      }

      if (
        enabled && snapshotPath &&
        /^assessment goals(?:\s|$)/.test(text)
      ) {
        const { handleSentinelFormalGoalChat } = await import(
          "./sentinel_formal_goal_chat.ts"
        );
        try {
          if (signal.aborted) return true;
          const response = await handleSentinelFormalGoalChat(
            snapshotPath,
            text,
            options.createAgent
              ? () => options.createAgent!(false, snapshotPath)
              : undefined,
            signal,
            options.webContainmentConfigured,
          );
          sendCurrent({ type: "response", text: response, taint: "INTERNAL" });
        } catch (error) {
          sendCurrent({
            type: "error",
            message: error instanceof Error
              ? error.message
              : "Goal request failed.",
          });
        }
        return true;
      }

      if (
        enabled &&
        /^assessment(?: (?:start(?: .+)?|goal .+|pause|resume|stop|status|refresh|history|observations))?$/
          .test(text)
      ) {
        const { handleSentinelAssessmentChat } = await import(
          "./sentinel_assessment_chat.ts"
        );
        if (!signal.aborted && generation === turnGeneration) {
          send({
            type: "response",
            text: handleSentinelAssessmentChat(
              text,
              snapshotPath ?? mainSnapshotPath,
              options.webContainmentConfigured,
              language,
            ),
            taint: "INTERNAL",
          });
        }
        return true;
      }

      const structuredQuery =
        /^(?:help|report|coverage)$|^(?:impact|trace|path|provenance)(?:\s|$)/
          .test(text);
      if (enabled && !modeCommand && !structuredQuery && options.createAgent) {
        agent ??= options.createAgent(false, snapshotPath);
        await executeCaseChat(
          snapshotPath,
          agent,
          content,
          sendCurrent,
          signal,
          true,
        );
        return true;
      }

      const result = await handleSentinelChatTurn(
        text,
        enabled,
        () => readSentinelChatSnapshot(snapshotPath ?? mainSnapshotPath),
        async (revision) => {
          const { readSentinelProvenance } = await import(
            "./sentinel_adaptive_runtime.ts"
          );
          return readSentinelProvenance(
            snapshotPath ?? mainSnapshotPath,
            revision,
          );
        },
        language,
      );
      if (!result) return false;
      if (signal.aborted || generation !== turnGeneration) return true;
      if (result.enabled !== enabled) {
        await options.clearContext?.();
        if (signal.aborted || generation !== turnGeneration) return true;
        reset();
        enabled = result.enabled;
        send({ type: "sentinel_mode", active: enabled });
      }
      send({ type: "response", text: result.response, taint: "INTERNAL" });
      return true;
    },
  };
}
