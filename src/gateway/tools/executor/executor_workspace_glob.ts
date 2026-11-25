import {
  type ClassificationLevel,
  maxClassification,
} from "../../../core/types/classification.ts";
import type { ToolExecutionContext } from "../../../core/types/tool.ts";
import type { FilesystemSandbox } from "../../../exec/sandbox/mod.ts";
import type { WorkspaceFileMatch } from "../../../exec/sandbox/workspace_glob.ts";
import { checkConfigManaged } from "./executor_filesystem.ts";

/** Return metadata only for matches authorized by the current root dispatch. */
export async function globWorkspaceFiles(
  input: Record<string, unknown>,
  sandbox: FilesystemSandbox | undefined,
  classify: ToolExecutionContext["classifyWorkspaceRead"],
): Promise<string> {
  const { path, pattern, limit = 50 } = input;
  if (!sandbox || !classify) {
    return "Error: Workspace glob authorization is unavailable.";
  }
  if (
    typeof path !== "string" || !path || path.includes("\0") ||
    typeof pattern !== "string" || !pattern ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 100
  ) {
    return "Error: Supply a workspace path, relative pattern, and optional limit from 1 to 100.";
  }
  const response = await sandbox.request({
    id: "",
    op: "glob",
    args: { path, pattern },
  });
  if (!response.ok || !response.result) {
    return response.error ?? "Error: Workspace glob failed.";
  }
  const matches = JSON.parse(response.result) as readonly WorkspaceFileMatch[];
  let classification: ClassificationLevel = "PUBLIC";
  const files: WorkspaceFileMatch[] = [];
  let truncated = false;
  for (const match of matches) {
    if (checkConfigManaged(match.path)) continue;
    const level = classify(match.path);
    if (!level) continue;
    if (files.length === limit) {
      truncated = true;
      break;
    }
    classification = maxClassification(classification, level);
    files.push(match);
  }
  return JSON.stringify({ files, truncated, _classification: classification });
}
