/**
 * Release notes tool — fetch and display Triggerfish release notes.
 *
 * Enables the agent to answer questions about what changed between
 * versions. The fetch function is injected at wiring time to avoid
 * a Layer 1 → CLI dependency.
 *
 * @module
 */

import type { ToolDefinition } from "../core/types/tool.ts";

/** A single release note entry. */
export interface ReleaseNoteSummary {
  readonly tag: string;
  readonly name: string;
  readonly body: string;
  readonly publishedAt: string;
}

/** A range of release notes between two versions. */
export interface ReleaseNoteRange {
  readonly from: string;
  readonly to: string;
  readonly releases: readonly ReleaseNoteSummary[];
}

/** Result type for the release notes fetcher. */
export type ReleaseNotesResult =
  | { readonly ok: true; readonly value: ReleaseNoteRange }
  | { readonly ok: false; readonly error: string };

/** Function signature for fetching release notes (injected at wiring). */
export type ReleaseNotesFetcher = (
  from: string,
  to: string,
) => Promise<ReleaseNotesResult>;

/** Tool definitions for the release_notes tool. */
export function buildReleaseNotesToolDefinitions(): readonly ToolDefinition[] {
  return [
    {
      name: "release_notes",
      description: "Fetch Triggerfish release notes between two versions. " +
        "Returns formatted release notes for summarization or display.",
      parameters: {
        from_version: {
          type: "string",
          description: "Start version (exclusive), e.g. 'v0.2.16' or '0.2.16'",
          required: true,
        },
        to_version: {
          type: "string",
          description:
            "End version (inclusive), e.g. 'v0.3.3' or '0.3.3'. Defaults to current version.",
          required: false,
        },
      },
    },
  ];
}

/** System prompt section for the release notes tool. */
export const RELEASE_NOTES_SYSTEM_PROMPT = `## Release Notes Tool

The release_notes tool fetches Triggerfish release notes between two versions.
Use it when the user asks about what changed, what's new, or wants a changelog
between versions. Provide from_version (exclusive) and optionally to_version
(inclusive, defaults to current). The tool returns markdown-formatted release
notes that you can summarize or analyze.`;

/** Format a release note range as markdown for the LLM. */
function formatReleaseNotesMarkdown(range: ReleaseNoteRange): string {
  if (range.releases.length === 0) {
    return `No releases found between ${range.from} and ${range.to}.`;
  }

  const sections: string[] = [];
  for (const release of [...range.releases].reverse()) {
    const date = release.publishedAt
      ? ` (${release.publishedAt.split("T")[0]})`
      : "";
    const title = release.name !== release.tag
      ? `${release.tag}: ${release.name}`
      : release.tag;
    sections.push(
      `### ${title}${date}\n\n${release.body.trim() || "_No release notes._"}`,
    );
  }
  return sections.join("\n\n---\n\n");
}

/**
 * Create a tool executor for the release_notes tool.
 *
 * Returns null for unrecognized tool names (chain pattern).
 *
 * @param fetcher - Injected function that fetches release notes from GitHub.
 * @param currentVersion - Current Triggerfish version string.
 */
export function createReleaseNotesToolExecutor(
  fetcher: ReleaseNotesFetcher,
  currentVersion: string,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (name !== "release_notes") return null;

    const fromVersion = input.from_version;
    if (typeof fromVersion !== "string" || fromVersion.length === 0) {
      return "Error: release_notes requires a non-empty 'from_version' argument.";
    }

    const toVersion = typeof input.to_version === "string" &&
        input.to_version.length > 0
      ? input.to_version
      : currentVersion;

    if (toVersion === "dev") {
      return "Error: Running a development build — cannot determine current version. Please specify to_version explicitly.";
    }

    const result = await fetcher(fromVersion, toVersion);
    if (!result.ok) {
      return `Error fetching release notes: ${result.error}`;
    }

    return formatReleaseNotesMarkdown(result.value);
  };
}

/** @deprecated Use buildReleaseNotesToolDefinitions instead */
export const getReleaseNotesToolDefinitions = buildReleaseNotesToolDefinitions;
