#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Parse CHANGELOG.md (Keep a Changelog format) and emit CHANGELOG.json.
 *
 * Run with:
 *   deno task changelog:gen
 *
 * Output format:
 * {
 *   "versions": [
 *     {
 *       "version": "0.3.3",
 *       "date": "2026-01-20",
 *       "sections": {
 *         "Added": ["..."],
 *         "Fixed": ["..."]
 *       }
 *     }
 *   ]
 * }
 *
 * The "Unreleased" section is included with an empty date.
 *
 * @module
 */

interface VersionEntry {
  version: string;
  date: string;
  sections: Record<string, string[]>;
}

interface ChangelogJson {
  versions: VersionEntry[];
}

const scriptDir = new URL(".", import.meta.url).pathname;
const changelogPath = `${scriptDir}../CHANGELOG.md`;
const outputPath = `${scriptDir}../CHANGELOG.json`;

const text = await Deno.readTextFile(changelogPath);
const lines = text.split("\n");

const versions: VersionEntry[] = [];
let current: VersionEntry | null = null;
let currentSection: string | null = null;

for (const line of lines) {
  // Match version headers: ## [x.y.z] - YYYY-MM-DD  or  ## [Unreleased]
  const versionMatch = line.match(
    /^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?/,
  );
  if (versionMatch) {
    if (current) versions.push(current);
    current = {
      version: versionMatch[1],
      date: versionMatch[2] ?? "",
      sections: {},
    };
    currentSection = null;
    continue;
  }

  // Match section headers: ### Added, ### Fixed, etc.
  const sectionMatch = line.match(/^### (.+)/);
  if (sectionMatch && current) {
    currentSection = sectionMatch[1].trim();
    current.sections[currentSection] = [];
    continue;
  }

  // Match list items starting with - or *
  const itemMatch = line.match(/^[-*] (.+)/);
  if (itemMatch && current && currentSection) {
    current.sections[currentSection].push(itemMatch[1].trim());
  }
}

if (current) versions.push(current);

const changelog: ChangelogJson = { versions };
const json = JSON.stringify(changelog, null, 2);
await Deno.writeTextFile(outputPath, json + "\n");
console.log(
  `Generated CHANGELOG.json with ${versions.length} version(s).`,
);
