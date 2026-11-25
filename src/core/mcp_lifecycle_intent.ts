/** Redacted, exact review metadata for a configured MCP lifecycle action. */

export interface McpLifecycleReview {
  readonly action: "add" | "replace" | "enable" | "disable" | "remove";
  readonly connectorId: string;
}

export function parseMcpLifecycleReview(
  action: unknown,
  connectorId: unknown,
): McpLifecycleReview | undefined {
  if (
    (action !== "add" && action !== "enable" && action !== "disable" &&
      action !== "replace" &&
      action !== "remove") ||
    typeof connectorId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(connectorId)
  ) return;
  return { action, connectorId };
}

export function parseMcpLifecycleIntent(
  tool: string,
  args: Record<string, unknown>,
): (McpLifecycleReview & { readonly revision: string }) | undefined {
  const revision = args.lifecycle_revision;
  if (
    tool !== "mcp_manage" ||
    Object.keys(args).some((key) =>
      key !== "action" && key !== "server_id" && key !== "lifecycle_revision"
    ) ||
    typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)
  ) return;
  const review = parseMcpLifecycleReview(args.action, args.server_id);
  return review && { ...review, revision };
}
