/**
 * Inline tool definitions for filesystem/workspace operations.
 *
 * These are defined inline (not imported from src/tools/) because
 * they are wired directly in the gateway executor, not through a
 * dedicated tool module.
 *
 * Split into two groups:
 * - exec_file: sandboxed filesystem ops (read, write, list, search, edit)
 * - exec_command: run_command (stays in parent process)
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";

function buildReadFileDef(): ToolDefinition {
  return {
    name: "read_file",
    description:
      "Read the contents of a file. Paths are resolved relative to your workspace.",
    parameters: {
      path: {
        type: "string",
        description:
          "File path to read (relative to workspace or absolute within workspace)",
        required: true,
      },
    },
  };
}

function buildWriteFileDef(): ToolDefinition {
  return {
    name: "write_file",
    description: "Write content to a file at a workspace-relative path.",
    parameters: {
      path: {
        type: "string",
        description: "Relative path in the workspace",
        required: true,
      },
      content: {
        type: "string",
        description: "File content to write",
        required: true,
      },
    },
  };
}

function buildListDirectoryDef(): ToolDefinition {
  return {
    name: "list_directory",
    description:
      "List files and directories. Paths are resolved relative to your workspace.",
    parameters: {
      path: {
        type: "string",
        description:
          "Directory path to list (relative to workspace or absolute within workspace)",
        required: true,
      },
    },
  };
}

function buildRunCommandDef(): ToolDefinition {
  return {
    name: "run_command",
    description: "Run a shell command in the agent workspace directory.",
    parameters: {
      command: {
        type: "string",
        description: "Shell command to execute",
        required: true,
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the command (relative to workspace or absolute within workspace). Defaults to workspace root.",
      },
    },
  };
}

function buildSearchFilesDef(): ToolDefinition {
  return {
    name: "search_files",
    description:
      "Search for files matching a glob pattern, or search file contents with grep. Paths outside your workspace are not accessible.",
    parameters: {
      path: {
        type: "string",
        description: "Directory to search in",
        required: true,
      },
      pattern: {
        type: "string",
        description:
          "Glob pattern for file names, or text/regex to search within files",
        required: true,
      },
      content_search: {
        type: "boolean",
        description: "If true, search file contents instead of file names",
        required: false,
      },
      output_mode: {
        type: "string",
        description:
          "Content result format. Supply an exact file, or set recursive for authorized directory results.",
        enum: ["files_with_matches", "content", "count"],
      },
      recursive: {
        type: "boolean",
        description:
          "Search authorized files beneath a canonical workspace directory.",
      },
      limit: {
        type: "number",
        description: "Maximum results per recursive page (1–100, default 100).",
      },
      offset: {
        type: "number",
        description: "Resume a recursive page at the returned nextOffset.",
      },
      file_glob: {
        type: "string",
        description: "Limit content search to matching file names.",
      },
      ignore_case: {
        type: "boolean",
        description: "Match content without regard to case.",
      },
      multiline: {
        type: "boolean",
        description:
          "Match across physical lines with RE2, for files up to 512 KiB.",
      },
      line_numbers: {
        type: "boolean",
        description:
          "Include line numbers in content output. Defaults to true.",
      },
      before: {
        type: "number",
        description: "Lines before each content match (0–20).",
      },
      after: {
        type: "number",
        description: "Lines after each content match (0–20).",
      },
      context: {
        type: "number",
        description: "Include up to 20 surrounding lines in content output.",
      },
    },
  };
}

function buildGlobFilesDef(): ToolDefinition {
  return {
    name: "glob_files",
    description:
      "Find authorized workspace files by a relative path pattern. Supports *, ?, and ** as a complete path segment. Returns workspace-relative paths newest first. Hidden segments require an explicit dot.",
    parameters: {
      path: {
        type: "string",
        description: "Workspace directory to search. Use '.' for the root.",
        required: true,
      },
      pattern: {
        type: "string",
        description: "Path pattern relative to the searched directory.",
        required: true,
      },
      limit: {
        type: "number",
        description: "Maximum matches, from 1 to 100. Defaults to 50.",
      },
    },
  };
}

function buildEditFileDef(): ToolDefinition {
  return {
    name: "edit_file",
    description:
      "Apply one unique replacement or a sequence of replacements to one file. The file is written only after every replacement can be applied.",
    parameters: {
      path: {
        type: "string",
        description:
          "File path to edit (relative to workspace or absolute within workspace)",
        required: true,
      },
      old_text: {
        type: "string",
        description:
          "Exact text for a single replacement. Do not combine with edits.",
        required: false,
      },
      new_text: {
        type: "string",
        description: "Replacement text for a single edit.",
        required: false,
      },
      edits: {
        type: "array",
        description:
          "Ordered replacements, each with old_text and new_text. Do not combine with the single-edit fields.",
        required: false,
        items: {
          type: "object",
          properties: {
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
        },
      },
    },
  };
}

/** Sandboxed filesystem tools: read_file, write_file, list_directory, search_files, edit_file. */
export function buildExecFileDefinitions(): readonly ToolDefinition[] {
  return [
    buildReadFileDef(),
    buildWriteFileDef(),
    buildListDirectoryDef(),
    buildSearchFilesDef(),
    buildGlobFilesDef(),
    buildEditFileDef(),
  ];
}

/** Command execution tools: run_command (stays in parent process). */
export function buildExecCommandDefinitions(): readonly ToolDefinition[] {
  return [buildRunCommandDef()];
}

/**
 * All exec tools combined (backward compat).
 *
 * Equivalent to `[...buildExecFileDefinitions(), ...buildExecCommandDefinitions()]`.
 */
export function buildExecInlineDefinitions(): readonly ToolDefinition[] {
  return [...buildExecFileDefinitions(), ...buildExecCommandDefinitions()];
}

/** @deprecated Use buildExecFileDefinitions instead */
export const getExecFileDefinitions = buildExecFileDefinitions;

/** @deprecated Use buildExecCommandDefinitions instead */
export const getExecCommandDefinitions = buildExecCommandDefinitions;

/** @deprecated Use buildExecInlineDefinitions instead */
export const getExecInlineDefinitions = buildExecInlineDefinitions;
