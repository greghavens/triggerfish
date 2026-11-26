/** One operator-approved graph investigation for a newly linked case. */
export interface SentinelLinkedSeedTask {
  readonly kind: "trace" | "impact";
  readonly nodeId: string;
}

export function parseSentinelLinkedSeedTask(
  value: unknown,
): SentinelLinkedSeedTask | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { kind, nodeId, ...unexpected } = value as Record<string, unknown>;
  if (
    Object.keys(unexpected).length ||
    (kind !== "trace" && kind !== "impact") ||
    typeof nodeId !== "string" || !nodeId.trim() || nodeId.length > 100 ||
    nodeId.includes("\\0")
  ) return;
  return { kind, nodeId };
}
