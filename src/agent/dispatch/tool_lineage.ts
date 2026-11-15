/**
 * Tool call lineage recording and source type classification.
 *
 * Records data provenance (lineage) and persists tool call conversation
 * records after successful execution. Maps tool name prefixes to
 * semantic source types for the lineage store.
 *
 * @module
 */

import type { SessionState } from "../../core/types/session.ts";
import type {
  OrchestratorConfig,
  ParsedToolCall,
} from "../orchestrator/orchestrator_types.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("tool-lineage");

/** Determine the lineage source_type from a tool name. */
export function determineSourceType(toolName: string): string {
  if (toolName.startsWith("web_")) return "web_request";
  if (toolName.startsWith("browser_")) return "browser_session";
  if (toolName.startsWith("memory_")) return "memory_access";
  if (
    toolName.startsWith("google_") || toolName.startsWith("gmail_") ||
    toolName.startsWith("calendar_") || toolName.startsWith("drive_") ||
    toolName.startsWith("sheets_") || toolName.startsWith("tasks_")
  ) {
    return "google_api";
  }
  if (toolName.startsWith("github_")) return "github_api";
  if (toolName.startsWith("obsidian_")) return "obsidian_vault";
  if (
    toolName.startsWith("file_") || toolName === "read_file" ||
    toolName === "write_file" || toolName === "edit_file" ||
    toolName === "list_directory" || toolName === "search_files"
  ) {
    return "filesystem";
  }
  if (toolName.startsWith("mcp_")) return "mcp_server";
  if (toolName.startsWith("skill_") || toolName === "read_skill") {
    return "skill_execution";
  }
  if (toolName.startsWith("cron_") || toolName.startsWith("trigger_")) {
    return "scheduler";
  }
  return "tool_response";
}

/** Record lineage and persist a tool_call conversation record. */
export async function recordToolCallLineageAndPersist(
  call: ParsedToolCall,
  resultText: string,
  blocked: boolean,
  config: OrchestratorConfig,
  session: SessionState,
  sessionKey: string,
): Promise<void> {
  if (blocked || call.name === "read_more") return;

  let lineageId: string | undefined;
  if (config.lineageStore) {
    const sessionTaint = config.getSessionTaint?.() ?? session.taint;
    log.debug("Recording lineage for tool call", {
      operation: "recordToolCallLineageAndPersist",
      tool: call.name,
      sourceType: determineSourceType(call.name),
      classification: sessionTaint,
      sessionId: session.id,
    });
    const record = await config.lineageStore.create({
      content: resultText,
      origin: {
        source_type: determineSourceType(call.name),
        source_name: call.name,
        accessed_at: new Date().toISOString(),
        accessed_by: session.userId as string,
        access_method: call.name,
      },
      classification: {
        level: sessionTaint,
        reason: `Tool call: ${call.name}`,
      },
      sessionId: session.id,
    });
    lineageId = record.lineage_id;
    log.debug("Lineage record created", {
      operation: "recordToolCallLineageAndPersist",
      tool: call.name,
      lineageId,
    });
  }

  if (config.messageStore) {
    const sessionTaint = config.getSessionTaint?.() ?? session.taint;
    // `resultText` is the already-capped text the model saw, so storing it is
    // bounded and is exactly what a training trace needs as the tool message.
    await config.messageStore.append({
      session_id: sessionKey,
      role: "tool_call",
      content: resultText,
      classification: sessionTaint,
      tool_name: call.name,
      tool_args: call.args,
      lineage_id: lineageId,
      ...(call.id !== undefined ? { tool_call_id: call.id } : {}),
    });
  }
}
