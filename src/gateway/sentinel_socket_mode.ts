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

  return {
    reset,
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

      function casePath(id: string) {
        try {
          return id === "main" ? mainSnapshotPath : options.resolveCase?.(id);
        } catch {
          return undefined;
        }
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
          await worker.execute(task, sendCurrent, signal);
        } finally {
          if (workers.delete(worker)) worker.clear();
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
        await agent.execute(content, sendCurrent, signal);
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
