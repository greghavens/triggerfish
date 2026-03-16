/**
 * Security scanner for plugin content.
 *
 * Scans all TypeScript files in a plugin directory for prompt injection,
 * malicious code, and obfuscation patterns. Reuses the weighted heuristic
 * scoring system from the skill scanner (`src/tools/skills/scanner.ts`).
 *
 * Additionally checks for plugin-specific dangerous patterns:
 * - Direct Deno API usage in sandboxed plugins
 * - Environment variable exfiltration
 * - Dynamic import of external URLs
 * - eval() / Function() usage
 *
 * @module
 */

import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("plugin-scanner");

/** Result of a plugin security scan. */
export interface PluginScanResult {
  /** Whether the plugin passed the scan. */
  readonly ok: boolean;
  /** Warning messages for flagged patterns. */
  readonly warnings: readonly string[];
  /** Files that were scanned. */
  readonly scannedFiles: readonly string[];
}

/** Weighted pattern for heuristic scanning. */
interface ScanPattern {
  readonly pattern: RegExp;
  readonly message: string;
  /** 1 = weak signal, 2 = moderate, 3 = critical (instant fail). */
  readonly weight: number;
}

/** Prompt injection patterns (shared with skill scanner). */
const INJECTION_PATTERNS: readonly ScanPattern[] = [
  {
    pattern: /ignore\s+(all\s+)?previous\s+instructions/i,
    message: "Prompt injection: attempts to override previous instructions",
    weight: 3,
  },
  {
    pattern: /system\s+prompt\s+override/i,
    message: "Prompt injection: attempts system prompt override",
    weight: 3,
  },
  {
    pattern: /disregard\s+(all\s+)?(prior|previous|above)/i,
    message: "Prompt injection: attempts to disregard prior context",
    weight: 3,
  },
  {
    pattern: /you\s+are\s+now\s+(a|an)\s/i,
    message: "Prompt injection: attempts to redefine agent identity",
    weight: 3,
  },
  {
    pattern:
      /reveal\s+(all\s+)?(your\s+)?(secrets|credentials|keys|passwords)/i,
    message: "Prompt injection: attempts to extract secrets",
    weight: 3,
  },
  {
    pattern: /forget\s+(all\s+)?(your\s+)?(rules|instructions|constraints)/i,
    message: "Prompt injection: attempts to clear constraints",
    weight: 3,
  },
  {
    pattern: /bypass\s+(security|policy|classification|restrictions)/i,
    message: "Prompt injection: attempts to bypass security controls",
    weight: 3,
  },
  {
    pattern: /sudo\s+mode|admin\s+mode|god\s+mode/i,
    message: "Prompt injection: attempts privilege escalation",
    weight: 3,
  },
];

/** Code-level dangerous patterns specific to plugins. */
const CODE_PATTERNS: readonly ScanPattern[] = [
  {
    pattern: /\beval\s*\(/,
    message: "Dangerous: eval() call detected",
    weight: 3,
  },
  {
    pattern: /new\s+Function\s*\(/,
    message: "Dangerous: dynamic Function() constructor detected",
    weight: 3,
  },
  {
    pattern: /Deno\.env\.(get|toObject|set|delete|has)\s*\(/,
    message:
      "Suspicious: direct Deno.env access (potential credential exfiltration)",
    weight: 2,
  },
  {
    pattern: /import\s*\(\s*["'`]https?:\/\//,
    message: "Suspicious: dynamic import from external URL",
    weight: 2,
  },
  {
    pattern: /Deno\.(run|command|exec)\s*\(/i,
    message: "Dangerous: subprocess execution attempt",
    weight: 3,
  },
  {
    pattern:
      /Deno\.(readFile|readTextFile|writeFile|writeTextFile|remove|rename|mkdir)\s*\(/,
    message: "Suspicious: direct filesystem access (should use plugin SDK)",
    weight: 2,
  },
  {
    pattern: /Deno\.(listen|connect|listenTls|connectTls)\s*\(/,
    message: "Dangerous: raw network listener/connection attempt",
    weight: 3,
  },
  {
    pattern: /atob\s*\(/i,
    message: "Obfuscation: base64 decode call (atob) detected",
    weight: 3,
  },
  {
    pattern: /[\u200B-\u200D\uFEFF\u2060]/,
    message: "Obfuscation: zero-width/invisible Unicode characters detected",
    weight: 3,
  },
  {
    pattern: /base64\s+-d|echo\s+\S+\s*\|\s*(?:bash|sh)/i,
    message: "Obfuscation: shell command encoding pattern detected",
    weight: 3,
  },
  {
    pattern: /rot(?:ate)?[\s-]?13/i,
    message: "Obfuscation: ROT13 encoding reference detected",
    weight: 2,
  },
  {
    pattern: /[A-Za-z0-9+/]{40,}={0,2}/,
    message: "Suspicious: long base64-encoded string detected",
    weight: 2,
  },
];

/** All patterns combined. */
const ALL_PATTERNS: readonly ScanPattern[] = [
  ...INJECTION_PATTERNS,
  ...CODE_PATTERNS,
];

/** Score threshold for heuristic failure. */
const HEURISTIC_SCORE_THRESHOLD = 4;

/** Weight at or above which a single pattern triggers instant failure. */
const CRITICAL_WEIGHT_THRESHOLD = 3;

/** Scan a single file's content against all patterns. */
function scanContent(
  content: string,
  filePath: string,
): {
  readonly warnings: string[];
  readonly score: number;
  readonly hasCritical: boolean;
} {
  const warnings: string[] = [];
  let score = 0;
  let hasCritical = false;

  for (const { pattern, message, weight } of ALL_PATTERNS) {
    if (pattern.test(content)) {
      warnings.push(`${filePath}: ${message}`);
      score += weight;
      if (weight >= CRITICAL_WEIGHT_THRESHOLD) {
        hasCritical = true;
      }
    }
  }

  return { warnings, score, hasCritical };
}

/** Collect all .ts files in a directory (non-recursive for now). */
async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".ts")) {
        files.push(`${dir}/${entry.name}`);
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
  return files.sort();
}

/**
 * Scan all TypeScript files in a plugin directory for security issues.
 *
 * Uses weighted heuristic scoring: fails if any critical (weight >= 3)
 * pattern matches or if cumulative score reaches the threshold (>= 4).
 *
 * Checks for:
 * - Prompt injection patterns (in string literals and comments)
 * - Dangerous code patterns (eval, subprocess, raw filesystem)
 * - Obfuscation techniques (base64, invisible characters, ROT13)
 */
export async function scanPluginDirectory(
  pluginDir: string,
): Promise<PluginScanResult> {
  const files = await collectTypeScriptFiles(pluginDir);
  if (files.length === 0) {
    return { ok: true, warnings: [], scannedFiles: [] };
  }

  const allWarnings: string[] = [];
  let totalScore = 0;
  let hasCritical = false;

  for (const filePath of files) {
    try {
      const content = await Deno.readTextFile(filePath);
      const result = scanContent(content, filePath);
      allWarnings.push(...result.warnings);
      totalScore += result.score;
      if (result.hasCritical) hasCritical = true;
    } catch (err) {
      log.warn("Plugin scanner: file read failed", {
        operation: "scanPluginDirectory",
        filePath,
        err,
      });
    }
  }

  const ok = !hasCritical && totalScore < HEURISTIC_SCORE_THRESHOLD;

  if (!ok) {
    log.warn("Plugin failed security scan", {
      operation: "scanPluginDirectory",
      pluginDir,
      totalScore,
      hasCritical,
      warningCount: allWarnings.length,
    });
  }

  return { ok, warnings: allWarnings, scannedFiles: files };
}

/**
 * Create a plugin scanner function suitable for use with PluginToolsOptions.
 *
 * Returns a function matching the `scanPlugin` signature expected by
 * the plugin management tools.
 */
export function createPluginScanner(): (
  pluginDir: string,
) => Promise<PluginScanResult> {
  return scanPluginDirectory;
}
