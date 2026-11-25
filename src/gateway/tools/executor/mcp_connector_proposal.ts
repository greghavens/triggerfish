/** Read one operator-staged MCP proposal from the protected config directory. */

import { dirname, join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { redactCredentialText } from "../../../core/logger/mod.ts";
import {
  type ClassificationLevel,
  parseClassification,
} from "../../../core/types/classification.ts";
import { isRealPathWithinJail } from "../../../core/security/path_jail.ts";
import { enforceCommandAllowlist } from "../../../mcp/manager_connection.ts";

const maxProposalBytes = 32_768;
const connectorPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const secretReference =
  /^(secret|keychain):[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

export interface McpConnectorProposal {
  readonly source: string;
  readonly transport: "stdio" | "sse";
  readonly classification: ClassificationLevel;
  readonly credentialNames: readonly string[];
  readonly entry: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validArguments(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 32 &&
    value.every((part) =>
      typeof part === "string" && part.length <= 1_024 &&
      !part.includes("\0") &&
      redactCredentialText(part) === part
    );
}

function validCredentialRefs(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length <= 32 &&
    Object.entries(value).every(([key, binding]) =>
      /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) &&
      typeof binding === "string" && secretReference.test(binding)
    );
}

function allowedUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function boundedInteger(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= min && value <= max;
}

function parseProposal(source: string): McpConnectorProposal | undefined {
  const raw: unknown = parseYaml(source);
  if (
    !isRecord(raw) ||
    Object.keys(raw).some((key) =>
      ![
        "command",
        "args",
        "url",
        "classification",
        "env",
        "tool_call_timeout_ms",
        "max_retries",
      ].includes(key)
    ) || typeof raw.classification !== "string"
  ) return;
  const classification = parseClassification(raw.classification);
  if (!classification.ok) return;
  const stdio = raw.command !== undefined;
  if (
    stdio
      ? typeof raw.command !== "string" || raw.command.length > 1_024 ||
        raw.command.includes("\0") || raw.url !== undefined ||
        !enforceCommandAllowlist(raw.command).ok ||
        (raw.args !== undefined && !validArguments(raw.args)) ||
        (raw.env !== undefined && !validCredentialRefs(raw.env))
      : !allowedUrl(raw.url) || raw.args !== undefined || raw.env !== undefined
  ) return;
  if (
    raw.tool_call_timeout_ms !== undefined &&
      !boundedInteger(raw.tool_call_timeout_ms, 1_000, 60_000) ||
    raw.max_retries !== undefined && !boundedInteger(raw.max_retries, 1, 10)
  ) return;
  return {
    source,
    transport: stdio ? "stdio" : "sse",
    classification: classification.value,
    credentialNames: isRecord(raw.env)
      ? Object.values(raw.env).map((ref) =>
        String(ref).split(":").slice(1).join(":")
      )
      : [],
    entry: { ...raw, enabled: false },
  };
}

export function readMcpConnectorProposal(
  configPath: string,
  serverId: string,
): McpConnectorProposal | undefined {
  if (!connectorPattern.test(serverId)) return;
  const root = join(dirname(configPath), "mcp-proposals");
  const path = join(root, `${serverId}.yaml`);
  try {
    const dir = Deno.lstatSync(root);
    const file = Deno.lstatSync(path);
    if (
      !dir.isDirectory || !file.isFile || (file.nlink ?? 1) !== 1 ||
      ((dir.mode ?? 0) & 0o022) !== 0 || ((file.mode ?? 0) & 0o022) !== 0 ||
      file.size > maxProposalBytes || !isRealPathWithinJail(path, root)
    ) return;
    const source = Deno.readTextFileSync(path);
    if (new TextEncoder().encode(source).length > maxProposalBytes) return;
    return parseProposal(source);
  } catch {
    // YAML and filesystem errors can contain proposal content or local paths.
    return undefined;
  }
}
