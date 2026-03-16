/**
 * Agent tools — capabilities exposed to the LLM as callable tools.
 *
 * @module
 */

export {
  buildTodoToolDefinitions,
  createTodoManager,
  createTodoToolExecutor,
  extractTodosFromEvent,
  formatTodoListAnsi,
  formatTodoListHtml,
  getTodoToolDefinitions,
  TODO_SYSTEM_PROMPT,
} from "./todo.ts";

export type {
  TodoItem,
  TodoList,
  TodoManager,
  TodoManagerOptions,
  TodoPriority,
  TodoStatus,
} from "./todo.ts";

export {
  buildLlmTaskToolDefinitions,
  createLlmTaskToolExecutor,
  getLlmTaskToolDefinitions,
  LLM_TASK_SYSTEM_PROMPT,
} from "./llm-task.ts";

export {
  buildSummarizePrompt,
  buildSummarizeToolDefinitions,
  createSummarizeToolExecutor,
  getSummarizeToolDefinitions,
  SUMMARIZE_SYSTEM_PROMPT,
} from "./summarize.ts";

export {
  buildHealthcheckToolDefinitions,
  createHealthcheckToolExecutor,
  getHealthcheckToolDefinitions,
  HEALTHCHECK_SYSTEM_PROMPT,
} from "./healthcheck.ts";

export type { HealthcheckDeps } from "./healthcheck.ts";

export { readLogsForLlm } from "./log_reader.ts";
export type { LogReaderOptions, LogReadResult } from "./log_reader.ts";

export {
  buildLogReaderToolDefinitions,
  executeLogRead,
  getLogReaderToolDefinitions,
  LOG_READER_SYSTEM_PROMPT,
  retrieveLogContent,
} from "./log_reader_tool.ts";

export {
  buildReleaseNotesToolDefinitions,
  createReleaseNotesToolExecutor,
  getReleaseNotesToolDefinitions,
  RELEASE_NOTES_SYSTEM_PROMPT,
} from "./release_notes.ts";

export type {
  ReleaseNoteRange,
  ReleaseNotesFetcher,
  ReleaseNoteSummary,
} from "./release_notes.ts";

export type {
  CredentialPromptCallback,
  SecretPromptCallback,
} from "./secrets.ts";

export {
  buildSecretToolDefinitions,
  createSecretToolExecutor,
  getSecretToolDefinitions,
  SECRET_TOOLS_SYSTEM_PROMPT,
} from "./secrets.ts";
